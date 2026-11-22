//! Qwen3-ASR (encoder + CTC head) inference through `ort`.
//!
//! The pipeline mirrors the reference implementation:
//! 1. Whisper-style log-mel front end (`n_fft` 400, hop 160, 128 mel bins).
//! 2. Fused encoder: `input_features [128, 3000]` + `feature_length [1]`
//!    → `enc_output [390, 2048]`, then trimmed to the valid frame count.
//! 3. CTC head: `enc_output [1, T, 2048]` → `logits [1, T, 72468]`.
//! 4. Greedy collapse (drop repeats, blanks and `<unk>`) and byte-level detokenize.

use anyhow::{Context, Result, bail};
use base64::Engine as _;
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;
use rustfft::FftPlanner;
use rustfft::num_complex::Complex;
use std::f64::consts::PI;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::SpeechStatus;

const SAMPLE_RATE: usize = 16_000;
const N_FFT: usize = 400;
const HOP: usize = 160;
const MEL_BINS: usize = 128;
const MEL_FRAMES: usize = 3000; // 30 s bucket the encoder was exported for
/// Audio longer than this is split into pieces before inference.
const SEGMENT_SAMPLES: usize = MEL_FRAMES * HOP;
/// Keep a little headroom: the mel front end needs a full analysis window.
const SEGMENT_MARGIN: usize = 1_600; // 0.1 s
/// Frames of mel per `frontend` chunk, used to derive the valid frame count.
const CHUNK_MEL_FRAMES: usize = 100;
const CHUNK_OUT_FRAMES: usize = 13;
const BLANK_ID: usize = 72_466;
const UNK_ID: usize = 72_467;
/// 72466 tokens + blank + `<unk>`.
const VOCAB: usize = UNK_ID + 1;
/// Frame length used by `split_for_inference`: 20 ms.
const VAD_WINDOW: usize = 320;
/// A window quieter than this fraction of the loudest one counts as silence.
const VAD_RELATIVE_FLOOR: f32 = 0.02;

struct Engine {
    encoder: Session,
    ctc: Session,
    tokens: Vec<Option<Vec<u8>>>,
}

fn engine_slot() -> &'static Mutex<Option<(PathBuf, Engine)>> {
    static SLOT: OnceLock<Mutex<Option<(PathBuf, Engine)>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Load (or reuse) the engine for `dir` and hand it to `f` under the lock.
fn with_engine<T>(dir: &Path, f: impl FnOnce(&mut Engine) -> Result<T>) -> Result<T> {
    let mut slot = engine_slot()
        .lock()
        .map_err(|_| anyhow::anyhow!("语音引擎锁损坏"))?;
    if slot.as_ref().is_none_or(|(loaded, _)| loaded != dir) {
        *slot = Some((dir.to_path_buf(), load_engine(dir)?));
    }
    let engine = &mut slot.as_mut().expect("engine was just ensured").1;
    f(engine)
}

/// Preload the encoder, CTC head and vocabulary.
pub(super) fn warm(dir: &Path) -> Result<()> {
    with_engine(dir, |_| Ok(()))
}

/// Release the loaded engine (e.g. after its files were deleted or replaced).
pub(super) fn unload() {
    if let Ok(mut slot) = engine_slot().lock() {
        *slot = None;
    }
}

pub(super) fn transcribe(status: &SpeechStatus, wav: &Path) -> Result<String> {
    if !status.ready {
        bail!(
            "QwenCTC 模型未就绪（缺少 {}）。请在设置 → 语音输入中下载。",
            if status.missing.is_empty() {
                "模型文件".to_string()
            } else {
                status.missing.join("、")
            }
        );
    }
    let dir = PathBuf::from(&status.model_dir);
    let samples = read_wav_16k(wav)?;
    if samples.is_empty() {
        bail!("录音为空");
    }

    // The encoder only accepts a 30 s bucket, so longer audio is cut at
    // pauses beforehand. Segments run back to back on the same engine.
    let segments = split_for_inference(&samples);
    let text = with_engine(&dir, |engine| {
        let mut pieces = Vec::with_capacity(segments.len());
        for (start, end) in segments {
            let piece = transcribe_segment(engine, &samples[start..end])?;
            let piece = piece.trim();
            if piece.is_empty() {
                continue;
            }
            pieces.push(piece.to_string());
        }
        Ok(pieces.join("，"))
    })?;
    let text = text.trim().to_string();
    if text.is_empty() {
        bail!("未识别到语音内容");
    }
    Ok(text)
}

fn transcribe_segment(engine: &mut Engine, samples: &[f32]) -> Result<String> {
    let logits = infer(engine, samples)?;
    let token_ids = collapse(&logits);
    Ok(detokenize(&engine.tokens, &token_ids))
}

/// Byte ranges of `samples` that each fit the encoder's 30 s bucket.
///
/// Audio within the limit is returned whole. Longer audio is cut as close to
/// the bucket boundary as possible, preferring a nearby quiet window so a
/// word is less likely to be sliced in half.
fn split_for_inference(samples: &[f32]) -> Vec<(usize, usize)> {
    let limit = SEGMENT_SAMPLES - SEGMENT_MARGIN;
    if samples.len() <= limit {
        return vec![(0, samples.len())];
    }

    // Energy per 20 ms window, used to look for pauses near each cut.
    let windows = samples.len().div_ceil(VAD_WINDOW);
    let mut energy = Vec::with_capacity(windows);
    let mut peak = 0f32;
    for window in 0..windows {
        let start = window * VAD_WINDOW;
        let end = (start + VAD_WINDOW).min(samples.len());
        let slice = &samples[start..end];
        if slice.is_empty() {
            energy.push(0.0);
            continue;
        }
        let mean =
            slice.iter().map(|s| (*s as f64) * (*s as f64)).sum::<f64>() / slice.len() as f64;
        let level = mean.sqrt() as f32;
        peak = peak.max(level);
        energy.push(level);
    }
    let floor = peak * VAD_RELATIVE_FLOOR;

    let mut segments = Vec::new();
    let mut cursor = 0usize;
    while samples.len().saturating_sub(cursor) > limit {
        let hard_cut = cursor + limit;
        // Search the last quarter of the segment for the quietest window.
        let search_from = cursor + limit * 3 / 4;
        let from_window = search_from / VAD_WINDOW;
        let to_window = (hard_cut / VAD_WINDOW).min(energy.len().saturating_sub(1));
        let mut best = None::<(f32, usize)>;
        for window in from_window..=to_window {
            let level = energy.get(window).copied().unwrap_or(0.0);
            if level <= floor && best.is_none_or(|(best_level, _)| level < best_level) {
                best = Some((level, window));
            }
        }
        // Prefer the middle of the pause, not its first silent window.
        let cut = match best {
            Some((_, window)) => {
                let mut end_window = window;
                while end_window < to_window
                    && energy
                        .get(end_window + 1)
                        .is_some_and(|level| *level <= floor)
                {
                    end_window += 1;
                }
                ((window + end_window).div_ceil(2) + 1) * VAD_WINDOW
            }
            // No pause found: cut at the hard limit.
            None => hard_cut,
        }
        .min(hard_cut)
        .min(samples.len());
        if cut <= cursor {
            break;
        }
        segments.push((cursor, cut));
        cursor = cut;
    }
    if cursor < samples.len() {
        segments.push((cursor, samples.len()));
    }
    segments
}

fn load_engine(dir: &Path) -> Result<Engine> {
    ort::init().commit().ok();
    let session = |name: &str| -> Result<Session> {
        let path = dir.join(name);
        if !path.is_file() {
            bail!("缺少模型文件：{}", path.display());
        }
        Session::builder()
            .context("创建 ONNX 会话构建器失败")?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .context("设置图优化级别失败")?
            .commit_from_file(&path)
            .with_context(|| format!("加载 {name} 失败"))
    };
    let encoder = session("Qwen3-ASR-Encoder.q4.onnx")?;
    let ctc = session("Qwen3-ASR-CTC.q4f16.onnx")?;
    let tokens = load_tokens(&dir.join("tokens.txt"))?;
    Ok(Engine {
        encoder,
        ctc,
        tokens,
    })
}

fn infer(engine: &mut Engine, samples: &[f32]) -> Result<Vec<f32>> {
    let mel = log_mel(samples);
    if mel.is_empty() {
        bail!("音频过短");
    }
    let mel_len = mel.len() / MEL_BINS;

    let mut padded = vec![0f32; MEL_BINS * MEL_FRAMES];
    for bin in 0..MEL_BINS {
        for frame in 0..mel_len {
            padded[bin * MEL_FRAMES + frame] = mel[bin * mel_len + frame];
        }
    }

    let enc = {
        let features = Tensor::from_array(([MEL_BINS, MEL_FRAMES], padded))
            .context("构造 input_features 失败")?;
        let length = Tensor::from_array(([1usize], vec![mel_len as i64]))
            .context("构造 feature_length 失败")?;
        let outputs = engine
            .encoder
            .run(ort::inputs!["input_features" => features, "feature_length" => length])
            .context("编码器推理失败")?;
        let (shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .context("读取 enc_output 失败")?;
        let dim = *shape.last().context("enc_output 形状异常")? as usize;
        let total = shape.iter().map(|d| *d as usize).product::<usize>();
        (total / dim.max(1), dim, data.to_vec())
    };
    let (rows, dim, enc) = enc;
    let valid = valid_frames(mel_len).min(rows);
    if valid == 0 {
        bail!("音频过短，未能编码");
    }
    let enc = &enc[..valid * dim];

    let (shape, logits) = {
        let tensor = Tensor::from_array(([1usize, valid, dim], enc.to_vec()))
            .context("构造 enc_output 失败")?;
        let outputs = engine
            .ctc
            .run(ort::inputs!["enc_output" => tensor])
            .context("CTC 头推理失败")?;
        let (shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .context("读取 logits 失败")?;
        (
            shape.iter().map(|d| *d as usize).collect::<Vec<_>>(),
            data.to_vec(),
        )
    };
    if shape.len() != 3 {
        bail!("CTC 输出形状异常：{shape:?}");
    }
    Ok(logits)
}

/// Greedy CTC: per-frame argmax, collapse repeats, drop blank and `<unk>`.
fn collapse(logits: &[f32]) -> Vec<usize> {
    if logits.is_empty() {
        return Vec::new();
    }
    if logits.len() % VOCAB != 0 {
        // Unknown vocabulary layout; nothing to decode.
        return Vec::new();
    }
    let frames = logits.len() / VOCAB;
    let mut out = Vec::with_capacity(frames);
    let mut prev = usize::MAX;
    for frame in 0..frames {
        let row = &logits[frame * VOCAB..(frame + 1) * VOCAB];
        let mut best = 0usize;
        let mut best_score = f32::NEG_INFINITY;
        for (id, &score) in row.iter().enumerate() {
            if score > best_score {
                best_score = score;
                best = id;
            }
        }
        if best == prev {
            continue;
        }
        prev = best;
        if best == BLANK_ID || best == UNK_ID {
            continue;
        }
        out.push(best);
    }
    out
}

fn detokenize(tokens: &[Option<Vec<u8>>], ids: &[usize]) -> String {
    let mut bytes = Vec::new();
    for id in ids {
        if let Some(piece) = tokens.get(*id).and_then(|t| t.as_ref()) {
            bytes.extend_from_slice(piece);
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// `tokens.txt` holds `<base64 raw bytes>\t<id>` per line.
fn load_tokens(path: &Path) -> Result<Vec<Option<Vec<u8>>>> {
    let raw =
        std::fs::read_to_string(path).with_context(|| format!("读取 {} 失败", path.display()))?;
    let mut tokens: Vec<Option<Vec<u8>>> = Vec::new();
    for line in raw.lines() {
        if line.is_empty() {
            continue;
        }
        let (b64, id) = match line.rsplit_once('\t') {
            Some((b64, id)) => (b64, id.trim().parse::<usize>().ok()),
            None => (line, Some(tokens.len())),
        };
        let Some(id) = id else { continue };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .unwrap_or_default();
        if tokens.len() <= id {
            tokens.resize_with(id + 1, || None);
        }
        tokens[id] = Some(bytes);
    }
    if tokens.is_empty() {
        bail!("词表为空：{}", path.display());
    }
    Ok(tokens)
}

/// Encoder output frames for a given mel length: 13 fps, not 50 fps.
fn valid_frames(mel_len: usize) -> usize {
    let full = mel_len / CHUNK_MEL_FRAMES;
    let leave = mel_len % CHUNK_MEL_FRAMES;
    full * CHUNK_OUT_FRAMES + if leave == 0 { 0 } else { (leave - 1) / 8 + 1 }
}

fn hz_to_mel(hz: f64) -> f64 {
    const MIN_LOG_HZ: f64 = 1000.0;
    const MIN_LOG_MEL: f64 = 15.0;
    if hz < MIN_LOG_HZ {
        3.0 * hz / 200.0
    } else {
        MIN_LOG_MEL + (hz / MIN_LOG_HZ).ln() * (27.0 / 6.4f64.ln())
    }
}

fn mel_to_hz(mel: f64) -> f64 {
    const MIN_LOG_HZ: f64 = 1000.0;
    const MIN_LOG_MEL: f64 = 15.0;
    if mel < MIN_LOG_MEL {
        200.0 * mel / 3.0
    } else {
        MIN_LOG_HZ * ((6.4f64.ln() / 27.0) * (mel - MIN_LOG_MEL)).exp()
    }
}

/// Slaney-normalized, Slaney-scaled triangular bank: `[MEL_BINS][N_FFT/2 + 1]`.
fn mel_filter_bank() -> Vec<f32> {
    static BANK: OnceLock<Vec<f32>> = OnceLock::new();
    BANK.get_or_init(|| {
        let bins = N_FFT / 2 + 1;
        let mel_min = hz_to_mel(0.0);
        let mel_max = hz_to_mel(8000.0);
        let mut filter_hz = Vec::with_capacity(MEL_BINS + 2);
        for i in 0..MEL_BINS + 2 {
            let t = mel_min + (mel_max - mel_min) * i as f64 / (MEL_BINS + 1) as f64;
            filter_hz.push(mel_to_hz(t));
        }
        let fft_hz: Vec<f64> = (0..bins)
            .map(|i| (SAMPLE_RATE as f64 / 2.0) * i as f64 / (bins - 1) as f64)
            .collect();

        let mut bank = vec![0f32; MEL_BINS * bins];
        for m in 0..MEL_BINS {
            let left = filter_hz[m];
            let center = filter_hz[m + 1];
            let right = filter_hz[m + 2];
            let enorm = 2.0 / (right - left);
            for (b, &hz) in fft_hz.iter().enumerate() {
                let down = (hz - left) / (center - left);
                let up = (right - hz) / (right - center);
                let weight = down.min(up).max(0.0);
                bank[m * bins + b] = (weight * enorm) as f32;
            }
        }
        bank
    })
    .clone()
}

/// Periodic Hann window of `N_FFT` samples (same as `np.hanning(N_FFT + 1)[:-1]`).
fn hann_window() -> &'static [f64] {
    static WINDOW: OnceLock<Vec<f64>> = OnceLock::new();
    WINDOW.get_or_init(|| {
        (0..N_FFT)
            .map(|n| 0.5 - 0.5 * (2.0 * PI * n as f64 / N_FFT as f64).cos())
            .collect()
    })
}

fn reflect_pad(samples: &[f32], pad: usize) -> Vec<f64> {
    let len = samples.len();
    let mut out = vec![0f64; len + pad * 2];
    for (i, slot) in out.iter_mut().enumerate().take(pad) {
        // Mirror without repeating the edge sample, like `np.pad(mode="reflect")`.
        let src = (pad - i).min(len.saturating_sub(1));
        *slot = samples[src] as f64;
    }
    for (i, &s) in samples.iter().enumerate() {
        out[pad + i] = s as f64;
    }
    for i in 0..pad {
        let src = len.saturating_sub(2 + i);
        out[pad + len + i] = samples[src] as f64;
    }
    out
}

/// Whisper log-mel spectrogram, returned as `[MEL_BINS][frames]` (bin-major).
fn log_mel(samples: &[f32]) -> Vec<f32> {
    if samples.len() < N_FFT {
        return Vec::new();
    }
    let pad = N_FFT / 2;
    let padded = reflect_pad(samples, pad);
    let frames = 1 + (padded.len() - N_FFT) / HOP;
    // The reference drops the trailing frame to keep `len / hop` frames.
    let frames = frames.saturating_sub(1);
    if frames == 0 {
        return Vec::new();
    }

    let window = hann_window();
    let bank = mel_filter_bank();
    let bins = N_FFT / 2 + 1;
    let mut planner = FftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(N_FFT);

    let mut out = vec![0f32; MEL_BINS * frames];
    let mut buffer = vec![Complex::new(0f64, 0f64); N_FFT];
    let mut power = vec![0f64; bins];

    for frame in 0..frames {
        let start = frame * HOP;
        for (i, slot) in buffer.iter_mut().enumerate() {
            *slot = Complex::new(padded[start + i] * window[i], 0.0);
        }
        fft.process(&mut buffer);
        for (i, slot) in power.iter_mut().enumerate() {
            let c = buffer[i];
            *slot = c.re * c.re + c.im * c.im;
        }
        for m in 0..MEL_BINS {
            let row = &bank[m * bins..(m + 1) * bins];
            let mut acc = 0f64;
            for (w, p) in row.iter().zip(power.iter()) {
                acc += *w as f64 * *p;
            }
            out[m * frames + frame] = (acc.max(1e-10)).log10() as f32;
        }
    }

    // Clamp every frame to 8 orders of magnitude below the global peak, then
    // map to the normalized range the encoder was trained on.
    let mut peak = f32::NEG_INFINITY;
    for v in &out {
        peak = peak.max(*v);
    }
    let floor = peak - 8.0;
    for v in out.iter_mut() {
        *v = ((*v).max(floor) + 4.0) / 4.0;
    }
    out
}

/// Read a WAV file as 16 kHz mono `f32` samples.
fn read_wav_16k(path: &Path) -> Result<Vec<f32>> {
    let mut reader = hound::WavReader::open(path)
        .with_context(|| format!("读取 WAV 失败：{}", path.display()))?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<std::result::Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = match spec.bits_per_sample {
                8 => 1.0 / 128.0,
                16 => 1.0 / 32768.0,
                24 => 1.0 / 8_388_608.0,
                _ => 1.0 / 2_147_483_648.0,
            };
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 * scale))
                .collect::<std::result::Result<_, _>>()?
        }
    };
    let mono: Vec<f32> = if channels == 1 {
        raw
    } else {
        raw.chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
            .collect()
    };
    Ok(if spec.sample_rate as usize == SAMPLE_RATE {
        mono
    } else {
        resample_linear(&mono, spec.sample_rate as usize, SAMPLE_RATE)
    })
}

fn resample_linear(input: &[f32], src: usize, dst: usize) -> Vec<f32> {
    if input.is_empty() || src == 0 || dst == 0 {
        return Vec::new();
    }
    let ratio = src as f64 / dst as f64;
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

    /// Same synthetic signal as the numpy reference below.
    fn test_signal() -> Vec<f32> {
        (0..16_000)
            .map(|i| {
                let t = i as f64 / 16_000.0;
                if i < 8_000 {
                    (0.5 * (2.0 * PI * 440.0 * t).sin()) as f32
                } else {
                    0.1
                }
            })
            .collect()
    }

    #[test]
    fn mel_matches_transformers_reference() {
        let mel = log_mel(&test_signal());
        assert_eq!(mel.len(), MEL_BINS * 100);
        // Values from `transformers.WhisperFeatureExtractor` on the same signal.
        let expected_first = [
            0.90752f32, 1.005084, 0.986405, 0.95195, 1.042523, 0.929623, 1.05076, 1.006051,
        ];
        for (bin, want) in expected_first.iter().enumerate() {
            let got = mel[bin * 100];
            assert!(
                (got - want).abs() < 5e-4,
                "mel bin {bin} frame 0：{got} 应为 {want}"
            );
        }
        let expected_mid = [0.936421f32, 1.033985, 0.954717, 0.920262];
        for (bin, want) in expected_mid.iter().enumerate() {
            let got = mel[bin * 100 + 50];
            assert!(
                (got - want).abs() < 5e-4,
                "mel bin {bin} frame 50：{got} 应为 {want}"
            );
        }
    }

    #[test]
    fn valid_frames_follows_13fps_buckets() {
        assert_eq!(valid_frames(180), 23);
        assert_eq!(valid_frames(100), 13);
        assert_eq!(valid_frames(3000), 390);
        assert_eq!(valid_frames(0), 0);
    }

    /// Everything the splitter returns must fit in one encoder bucket.
    #[test]
    fn split_keeps_segments_within_the_bucket() {
        let limit = SEGMENT_SAMPLES - SEGMENT_MARGIN;
        for seconds in [1usize, 29, 30, 31, 60, 95, 200] {
            let samples = vec![0.2f32; SAMPLE_RATE * seconds];
            let segments = split_for_inference(&samples);
            assert!(!segments.is_empty(), "{seconds}s produced no segments");
            let mut expected_start = 0;
            for (start, end) in &segments {
                assert_eq!(*start, expected_start, "segments must be contiguous");
                assert!(end > start, "empty segment at {seconds}s");
                assert!(
                    end - start <= limit,
                    "segment {} samples exceeds {limit} at {seconds}s",
                    end - start
                );
                expected_start = *end;
            }
            assert_eq!(
                expected_start,
                samples.len(),
                "segments must cover the whole recording at {seconds}s"
            );
        }
    }

    /// Short audio must be a single segment so no text is split needlessly.
    #[test]
    fn short_audio_is_one_segment() {
        let samples = vec![0.1f32; SAMPLE_RATE * 5];
        assert_eq!(split_for_inference(&samples), vec![(0, samples.len())]);
    }

    /// Cuts should land in silence rather than through speech.
    #[test]
    fn split_prefers_a_pause() {
        // 45 s of tone with a clear quiet stretch around 22-24 s.
        let mut samples = vec![0.3f32; SAMPLE_RATE * 45];
        let quiet_start = SAMPLE_RATE * 22;
        let quiet_end = SAMPLE_RATE * 24;
        samples[quiet_start..quiet_end].fill(0.0);

        let segments = split_for_inference(&samples);
        assert_eq!(segments.len(), 2);
        let cut = segments[0].1;
        assert!(
            cut >= quiet_start && cut <= quiet_end,
            "cut at {cut} should fall inside the pause {quiet_start}..{quiet_end}"
        );
    }

    #[test]
    fn collapse_drops_repeats_blank_and_unk() {
        let mut logits = vec![0f32; VOCAB * 6];
        // frame 0 → 5, frame 1 → 5 (repeat), frame 2 → blank,
        // frame 3 → 7, frame 4 → unk, frame 5 → 9
        for (frame, id) in [
            (0usize, 5usize),
            (1, 5),
            (2, BLANK_ID),
            (3, 7),
            (4, UNK_ID),
            (5, 9),
        ] {
            logits[frame * VOCAB + id] = 1.0;
        }
        assert_eq!(collapse(&logits), vec![5, 7, 9]);
    }
}
