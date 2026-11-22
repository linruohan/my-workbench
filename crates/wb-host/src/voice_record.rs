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

static VOICE_LEVEL: AtomicU32 = AtomicU32::new(0);

/// Recent input level in `0.0..=1.0`, for the settings meter. Zero when idle.
pub fn voice_level() -> f32 {
    f32::from_bits(VOICE_LEVEL.load(Ordering::Relaxed))
}

/// Drop the meter back to silence, e.g. when a PTT press starts.
pub fn voice_level_reset() {
    VOICE_LEVEL.store(0f32.to_bits(), Ordering::Relaxed);
}

/// Open the configured device for a few hundred milliseconds and report the
/// peak level, used by the settings page to show the meter is alive.
/// Open the configured device for `duration` and report the loudest level
/// seen. Used by the settings page so a user has time to actually speak.
///
/// A silent room is *not* an error: the returned level is simply low. Only a
/// device that cannot be opened fails here.
pub fn voice_probe_level(device: Option<&str>, duration: std::time::Duration) -> Result<f32> {
    voice_record_start_with(device)?;
    let deadline = std::time::Instant::now() + duration;
    let mut peak = 0f32;
    let mut blocks = 0u32;
    while std::time::Instant::now() < deadline {
        // `voice_level` holds the peak of the most recent audio block, so the
        // loudest moment must be accumulated rather than read once at the end.
        let level = voice_level();
        if level > 0.0 {
            blocks += 1;
        }
        peak = peak.max(level);
        thread::sleep(Duration::from_millis(25));
    }
    voice_record_stop_silent();
    if blocks == 0 {
        bail!("没有收到任何音频数据（设备可能被其它程序占用或权限不足）");
    }
    Ok(peak)
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

/// Input devices the audio host reports, default device first.
pub fn voice_input_devices() -> Vec<String> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|device| device.name().ok());
    let mut names: Vec<String> = host
        .input_devices()
        .map(|devices| devices.filter_map(|device| device.name().ok()).collect())
        .unwrap_or_default();
    if let Some(default_name) = default_name {
        names.retain(|name| name != &default_name);
        names.insert(0, default_name);
    }
    names
}

/// Start (or restart) capturing from the default input device.
pub fn voice_record_start() -> Result<()> {
    voice_record_start_with(None)
}

/// Start capturing from `device`, or the default input device when `None`.
pub fn voice_record_start_with(device: Option<&str>) -> Result<()> {
    voice_record_stop_silent();
    let stop = Arc::new(AtomicBool::new(false));
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let rate = Arc::new(AtomicU32::new(16_000));
    let stop_t = stop.clone();
    let samples_t = samples.clone();
    let rate_t = rate.clone();
    let device = device.map(str::to_string);

    thread::Builder::new()
        .name("wb-voice-rec".into())
        .spawn(move || {
            if let Err(e) = run_capture(stop_t, samples_t, rate_t, device) {
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
    device_name: Option<String>,
) -> Result<()> {
    let host = cpal::default_host();
    let device = match device_name.as_deref() {
        Some(wanted) => host
            .input_devices()
            .ok()
            .and_then(|devices| {
                devices
                    .into_iter()
                    .find(|device| device.name().is_ok_and(|name| name == wanted))
            })
            .or_else(|| host.default_input_device()),
        None => host.default_input_device(),
    }
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
    // Peak of this block drives the settings meter.
    let mut peak = 0f32;
    let mut guard = samples.lock().unwrap();
    if channels <= 1 {
        for &sample in data {
            peak = peak.max(sample.abs());
        }
        guard.extend_from_slice(data);
    } else {
        for frame in data.chunks(channels) {
            let sum: f32 = frame.iter().copied().sum();
            let mono = sum / frame.len() as f32;
            peak = peak.max(mono.abs());
            guard.push(mono);
        }
    }
    if peak > 0.0 {
        VOICE_LEVEL.store(peak.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }
}

fn voice_record_stop_silent() {
    let prev = active().lock().unwrap().take();
    if let Some(rec) = prev {
        rec.stop.store(true, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(40));
    }
    VOICE_LEVEL.store(0f32.to_bits(), Ordering::Relaxed);
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
