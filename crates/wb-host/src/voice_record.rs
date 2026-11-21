//! Push-to-talk microphone capture → 16 kHz mono WAV.

use anyhow::{Context, Result, bail};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use wb_store::ensure_data_dir;

struct ActiveRec {
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    rate: Arc<AtomicU32>,
    started: Instant,
}

fn active() -> &'static Mutex<Option<ActiveRec>> {
    static ACTIVE: OnceLock<Mutex<Option<ActiveRec>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

pub fn voice_wav_path() -> Result<PathBuf> {
    let dir = ensure_data_dir()?.join("voice");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("ptt-last.wav"))
}

/// Start (or restart) capturing from the default input device.
pub fn voice_record_start() -> Result<()> {
    voice_record_stop_silent();
    let stop = Arc::new(AtomicBool::new(false));
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let rate = Arc::new(AtomicU32::new(16_000));
    let stop_t = stop.clone();
    let samples_t = samples.clone();
    let rate_t = rate.clone();

    thread::Builder::new()
        .name("wb-voice-rec".into())
        .spawn(move || {
            if let Err(e) = run_capture(stop_t, samples_t, rate_t) {
                log::warn!("voice capture ended: {e}");
            }
        })
        .context("启动录音线程失败")?;

    // Give the audio thread a moment to open the device.
    thread::sleep(Duration::from_millis(30));
    *active().lock().unwrap() = Some(ActiveRec {
        stop,
        samples,
        rate,
        started: Instant::now(),
    });
    Ok(())
}

fn run_capture(
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    rate: Arc<AtomicU32>,
) -> Result<()> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| anyhow::anyhow!("没有可用的麦克风设备"))?;
    let supported = device
        .default_input_config()
        .context("读取麦克风配置失败")?;
    rate.store(supported.sample_rate().0, Ordering::SeqCst);
    let channels = supported.channels().max(1) as usize;
    let config: cpal::StreamConfig = supported.clone().into();
    let err_fn = |e| log::warn!("cpal input error: {e}");

    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            {
                let samples = samples.clone();
                move |data: &[f32], _| push_mono(data, channels, &samples)
            },
            err_fn,
            None,
        )?,
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            {
                let samples = samples.clone();
                move |data: &[i16], _| {
                    let f: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                    push_mono(&f, channels, &samples);
                }
            },
            err_fn,
            None,
        )?,
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config,
            {
                let samples = samples.clone();
                move |data: &[u16], _| {
                    let f: Vec<f32> = data.iter().map(|&s| (s as f32 / 32768.0) - 1.0).collect();
                    push_mono(&f, channels, &samples);
                }
            },
            err_fn,
            None,
        )?,
        other => bail!("不支持的采样格式：{other}"),
    };
    stream.play()?;
    while !stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(15));
    }
    drop(stream);
    Ok(())
}

fn push_mono(data: &[f32], channels: usize, samples: &Mutex<Vec<f32>>) {
    let mut guard = samples.lock().unwrap();
    if channels <= 1 {
        guard.extend_from_slice(data);
        return;
    }
    for frame in data.chunks(channels) {
        let sum: f32 = frame.iter().copied().sum();
        guard.push(sum / frame.len() as f32);
    }
}

fn voice_record_stop_silent() {
    let prev = active().lock().unwrap().take();
    if let Some(rec) = prev {
        rec.stop.store(true, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(40));
    }
}

/// Stop capture and write `data/voice/ptt-last.wav` (16 kHz mono PCM).
pub fn voice_record_stop_to_wav() -> Result<PathBuf> {
    let rec = active()
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| anyhow::anyhow!("当前没有进行中的录音"))?;
    rec.stop.store(true, Ordering::SeqCst);
    // Wait until we have some audio or a short timeout.
    let deadline = Instant::now() + Duration::from_millis(200);
    while Instant::now() < deadline {
        let n = rec.samples.lock().unwrap().len();
        if n > 0 || rec.started.elapsed() > Duration::from_millis(80) {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    thread::sleep(Duration::from_millis(50));
    let rate = rec.rate.load(Ordering::SeqCst).max(1);
    let mono = rec.samples.lock().unwrap().clone();
    if mono.is_empty() {
        bail!("录音为空（请检查麦克风权限与默认输入设备）");
    }
    let path = voice_wav_path()?;
    write_wav_16k(&path, &mono, rate)?;
    Ok(path)
}

fn write_wav_16k(path: &Path, mono: &[f32], src_rate: u32) -> Result<()> {
    const TARGET: u32 = 16_000;
    let resampled = if src_rate == TARGET {
        mono.to_vec()
    } else {
        resample_linear(mono, src_rate, TARGET)
    };
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).context("创建 wav 失败")?;
    for &s in &resampled {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        writer.write_sample(v)?;
    }
    writer.finalize()?;
    Ok(())
}

fn resample_linear(input: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    if input.is_empty() {
        return Vec::new();
    }
    let ratio = src_rate as f64 / dst_rate as f64;
    let out_len = ((input.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let i0 = pos.floor() as usize;
        let i1 = (i0 + 1).min(input.len() - 1);
        let t = (pos - i0 as f64) as f32;
        out.push(input[i0] * (1.0 - t) + input[i1] * t);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_changes_length() {
        let src: Vec<f32> = (0..48_000).map(|i| (i as f32 / 48000.0).sin()).collect();
        let out = resample_linear(&src, 48_000, 16_000);
        assert!((out.len() as i32 - 16_000).abs() < 4);
    }
}
