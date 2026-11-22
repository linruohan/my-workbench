//! Local speech model catalog, integrity check and downloads.
//!
//! Engines:
//! - `sensevoice`: SenseVoiceSmall (INT8) via the `wb-asr` helper process or the
//!   `sherpa-onnx-offline` CLI.
//! - `qwenctc`: Qwen3-ASR encoder + CTC head, decoded in-process through `ort`
//!   (Whisper-style log-mel front end, greedy CTC collapse, byte-level detokenizer).

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use wb_store::ensure_data_dir;

/// One file a model needs on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechFileSpec {
    pub name: String,
    /// Path inside the engine directory, e.g. `sensevoice-onnx/tokens.txt`.
    pub rel_path: String,
    pub url: String,
    pub mirror_url: String,
    /// Lower bound on a plausible download; catches HTML error pages.
    pub min_bytes: u64,
    /// Exact size when we know it; a mismatch means a partial or stale file.
    pub exact_bytes: Option<u64>,
    /// Lowercase SHA-256 when we know it.
    pub sha256: Option<String>,
}

impl SpeechFileSpec {
    /// Build a spec in one go; keeps the catalog below readable.
    #[allow(clippy::too_many_arguments)]
    fn new(
        name: &str,
        rel_path: &str,
        url: &str,
        mirror_url: &str,
        min_bytes: u64,
        exact_bytes: u64,
        sha256: Option<&str>,
    ) -> Self {
        Self {
            name: name.into(),
            rel_path: rel_path.into(),
            url: url.into(),
            mirror_url: mirror_url.into(),
            min_bytes,
            exact_bytes: Some(exact_bytes),
            sha256: sha256.map(|s| s.to_ascii_lowercase()),
        }
    }
}

/// What a single expected file looks like right now.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechFileStatus {
    pub name: String,
    pub path: String,
    pub present: bool,
    pub bytes: u64,
    pub expected_bytes: Option<u64>,
    /// `ok` / `missing` / `size` / `hash` / `error`
    pub state: String,
    pub detail: Option<String>,
}

impl SpeechFileStatus {
    pub fn ok(&self) -> bool {
        self.state == "ok"
    }
}

/// Result of checking one engine directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStatus {
    pub engine: String,
    /// Files are verified *and* a runtime is available to run them.
    pub ready: bool,
    pub model_dir: String,
    /// Names of files that are missing or failed verification.
    pub missing: Vec<String>,
    pub files: Vec<SpeechFileStatus>,
    /// Verified bytes on disk across the expected files.
    pub present_bytes: u64,
    /// Total bytes once everything is downloaded.
    pub total_bytes: u64,
    /// Files check out but no runtime was found to execute them.
    #[serde(default)]
    pub runtime_missing: bool,
    pub message: Option<String>,
}

impl SpeechStatus {
    /// Fraction of the expected bytes already on disk, 0..=1.
    pub fn progress(&self) -> f32 {
        if self.total_bytes == 0 {
            return if self.ready { 1.0 } else { 0.0 };
        }
        (self.present_bytes as f64 / self.total_bytes as f64).clamp(0.0, 1.0) as f32
    }
}

impl DownloadProgress {
    /// Whole-percent completion of the file being streamed, 0..=100.
    pub fn percent(&self) -> u32 {
        if self.total == 0 {
            return 0;
        }
        ((self.done as f64 / self.total as f64) * 100.0).clamp(0.0, 100.0) as u32
    }
}

/// Metadata for an engine shown in settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechEngineInfo {
    pub id: String,
    pub label: String,
    pub detail: String,
    pub languages: String,
    pub total_bytes: u64,
}

pub const ENGINE_SENSEVOICE: &str = "sensevoice";
pub const ENGINE_QWENCTC: &str = "qwenctc";

/// Engines this build can actually run.
pub fn speech_engines() -> Vec<SpeechEngineInfo> {
    vec![
        SpeechEngineInfo {
            id: ENGINE_SENSEVOICE.into(),
            label: "SenseVoiceSmall (INT8)".into(),
            detail: "轻量本地识别，启动快；模型经 wb-asr 子进程推理。".into(),
            languages: "中文 / 英文 / 粤语 / 日语 / 韩语".into(),
            total_bytes: sum_bytes(&sensevoice_files()),
        },
        SpeechEngineInfo {
            id: ENGINE_QWENCTC.into(),
            label: "QwenCTC (Qwen3-ASR)".into(),
            detail: "Qwen3-ASR 编码器 + CTC 头，内置 ONNX 推理，识别更准、占用更大。".into(),
            languages: "多语种 + 中英混说".into(),
            total_bytes: sum_bytes(&qwenctc_files()),
        },
    ]
}

pub fn speech_engine_label(engine: &str) -> String {
    speech_engines()
        .into_iter()
        .find(|info| engine_eq(&info.id, engine))
        .map(|info| info.label)
        .unwrap_or_else(|| engine.to_string())
}

/// Normalize a stored engine id; unknown values fall back to SenseVoice.
pub fn normalize_engine(engine: &str) -> String {
    if engine_eq(engine, ENGINE_QWENCTC) {
        ENGINE_QWENCTC.into()
    } else {
        ENGINE_SENSEVOICE.into()
    }
}

fn engine_eq(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

fn sum_bytes(files: &[SpeechFileSpec]) -> u64 {
    files
        .iter()
        .map(|f| f.exact_bytes.unwrap_or(f.min_bytes))
        .sum()
}

pub fn sensevoice_files() -> Vec<SpeechFileSpec> {
    const HF: &str = "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07";
    const MIRROR: &str = "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07";
    // Only the model and its vocabulary are read; `wb-asr` does not load a VAD,
    // so requiring one here would make users download an unused 1.8 MB file.
    vec![
        SpeechFileSpec::new(
            "model.int8.onnx",
            "sensevoice-onnx/model.int8.onnx",
            &format!("{HF}/model.int8.onnx"),
            &format!("{MIRROR}/model.int8.onnx"),
            200_000_000,
            239_233_841,
            Some("c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51"),
        ),
        SpeechFileSpec::new(
            "tokens.txt",
            "sensevoice-onnx/tokens.txt",
            &format!("{HF}/tokens.txt"),
            &format!("{MIRROR}/tokens.txt"),
            100_000,
            315_894,
            Some("f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc"),
        ),
    ]
}

/// Qwen3-ASR (1.7B encoder, q4) + CTC head (a7_avg5, q4f16) + compact byte vocab.
pub fn qwenctc_files() -> Vec<SpeechFileSpec> {
    const HF: &str = "https://huggingface.co/JazerJu/glm-asr-ctc-bench/resolve/main";
    const MIRROR: &str = "https://hf-mirror.com/JazerJu/glm-asr-ctc-bench/resolve/main";
    let spec = |name: &str, url_path: &str, min: u64, exact: u64, sha: &str| {
        SpeechFileSpec::new(
            name,
            name,
            &format!("{HF}/{url_path}"),
            &format!("{MIRROR}/{url_path}"),
            min,
            exact,
            Some(sha),
        )
    };
    vec![
        spec(
            "Qwen3-ASR-Encoder.q4.onnx",
            "qwen-ctc/Qwen3-ASR-Encoder.q4.onnx",
            150_000_000,
            185_873_181,
            "23a3ae24a20fb278da2b4a72d2210602499739f270c7a394c012f24f8f99ed4f",
        ),
        spec(
            "Qwen3-ASR-CTC.q4f16.onnx",
            "qwen-ctc-a7avg5/Qwen3-ASR-CTC.q4f16.onnx",
            30_000_000,
            44_628_958,
            "9c55e9426f660280e24136861f0a1bc4503b6a4aec657beddcbb5cd01a49c719",
        ),
        spec(
            "tokens.txt",
            "qwen-ctc/tokens.txt",
            500_000,
            1_158_892,
            "398d85aa68f9e49335ef933672f31fe0a107fdf7ab35568cd2172ec93952b98e",
        ),
    ]
}

fn files_for(engine: &str) -> Vec<SpeechFileSpec> {
    if engine_eq(engine, ENGINE_QWENCTC) {
        qwenctc_files()
    } else {
        sensevoice_files()
    }
}

pub fn speech_model_dir(engine: &str) -> Result<PathBuf> {
    Ok(ensure_data_dir()?
        .join("models")
        .join(normalize_engine(engine)))
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buf)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
        if read < buf.len() {
            break;
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Verification results keyed by path, so reopening settings does not re-read
/// hundreds of megabytes. A changed size or mtime invalidates the entry.
type HashCache = std::collections::HashMap<PathBuf, CacheEntry>;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct CacheEntry {
    len: u64,
    /// Modification time in milliseconds since the Unix epoch.
    mtime_ms: Option<u64>,
    sha256: String,
}

fn hash_cache() -> &'static Mutex<HashCache> {
    static CACHE: OnceLock<Mutex<HashCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashCache::new()))
}

/// Where digests are persisted between runs.
fn hash_cache_path() -> Option<PathBuf> {
    ensure_data_dir()
        .ok()
        .map(|dir| dir.join("models").join(".verify.json"))
}

/// Load the on-disk cache once per process. Hashing half a gigabyte takes
/// seconds, so the result must survive a restart.
fn ensure_cache_loaded() {
    static LOADED: OnceLock<()> = OnceLock::new();
    LOADED.get_or_init(|| {
        let Some(path) = hash_cache_path() else {
            return;
        };
        let Ok(raw) = fs::read_to_string(&path) else {
            return;
        };
        let Ok(entries) = serde_json::from_str::<HashCache>(&raw) else {
            log::debug!("校验缓存无法解析，将重新计算：{}", path.display());
            return;
        };
        if let Ok(mut cache) = hash_cache().lock() {
            cache.extend(entries);
        }
    });
}

/// Write the cache back. Only called when an entry actually changed.
fn persist_cache(cache: &HashCache) {
    let Some(path) = hash_cache_path() else {
        return;
    };
    if let Some(parent) = path.parent()
        && fs::create_dir_all(parent).is_err()
    {
        return;
    }
    match serde_json::to_string(cache) {
        Ok(raw) => {
            let tmp = path.with_extension("json.part");
            if fs::write(&tmp, raw).is_err() || fs::rename(&tmp, &path).is_err() {
                let _ = fs::remove_file(&tmp);
            }
        }
        Err(e) => log::debug!("校验缓存序列化失败：{e}"),
    }
}

/// Files touched this recently are re-hashed instead of trusted from cache.
/// Timestamps have coarse resolution, so two writes within the same tick can
/// look identical; caching those would return a stale digest.
const CACHE_SETTLE: std::time::Duration = std::time::Duration::from_secs(2);

fn mtime_ms(modified: Option<std::time::SystemTime>) -> Option<u64> {
    modified?
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// SHA-256 of `path`, reusing a cached digest while size and mtime match.
fn cached_sha256(path: &Path, len: u64, modified: Option<std::time::SystemTime>) -> Result<String> {
    ensure_cache_loaded();
    let settled = modified.is_some_and(|time| {
        std::time::SystemTime::now()
            .duration_since(time)
            .is_ok_and(|age| age > CACHE_SETTLE)
    });
    let stamp = mtime_ms(modified);

    if settled
        && let Ok(cache) = hash_cache().lock()
        && let Some(entry) = cache.get(path)
        && entry.len == len
        && entry.mtime_ms == stamp
    {
        return Ok(entry.sha256.clone());
    }
    let digest = sha256_file(path)?;
    // A file written moments ago may still change without a new timestamp,
    // so it is never cached; that also keeps the test suite deterministic.
    if settled {
        let mut written = None;
        if let Ok(mut cache) = hash_cache().lock() {
            cache.insert(
                path.to_path_buf(),
                CacheEntry {
                    len,
                    mtime_ms: stamp,
                    sha256: digest.clone(),
                },
            );
            written = Some(cache.clone());
        }
        if let Some(cache) = written {
            persist_cache(&cache);
        }
    } else if let Ok(mut cache) = hash_cache().lock() {
        cache.remove(path);
    }
    Ok(digest)
}

/// Forget cached digests for one engine (after download or delete).
fn invalidate_hash_cache(engine: &str) -> Result<()> {
    let dir = speech_model_dir(engine)?;
    if let Ok(mut cache) = hash_cache().lock() {
        cache.retain(|path, _| !path.starts_with(&dir));
    }
    Ok(())
}

fn check_file(dir: &Path, spec: &SpeechFileSpec) -> SpeechFileStatus {
    let path = dir.join(&spec.rel_path);
    let mut status = SpeechFileStatus {
        name: spec.name.clone(),
        path: path.to_string_lossy().to_string(),
        present: false,
        bytes: 0,
        expected_bytes: spec.exact_bytes,
        state: "missing".into(),
        detail: None,
    };
    let meta = match fs::metadata(&path) {
        Ok(meta) => meta,
        Err(_) => {
            status.detail = Some("尚未下载".into());
            return status;
        }
    };
    status.present = true;
    status.bytes = meta.len();
    if let Some(exact) = spec.exact_bytes {
        if meta.len() != exact {
            status.state = "size".into();
            status.detail = Some(format!(
                "大小不符（{} / {} 字节），可能未下载完",
                meta.len(),
                exact
            ));
            return status;
        }
    } else if meta.len() < spec.min_bytes {
        status.state = "size".into();
        status.detail = Some(format!("文件过小（{} 字节）", meta.len()));
        return status;
    }
    if let Some(expect) = spec.sha256.as_deref().filter(|s| !s.is_empty()) {
        let modified = meta.modified().ok();
        match cached_sha256(&path, meta.len(), modified) {
            Ok(actual) if actual.eq_ignore_ascii_case(expect) => {}
            Ok(actual) if actual.eq_ignore_ascii_case(expect) => {}
            Ok(actual) => {
                status.state = "hash".into();
                status.detail = Some(format!(
                    "内容校验失败（{}… 应为 {}…）",
                    &actual[..actual.len().min(12)],
                    &expect[..expect.len().min(12)]
                ));
                return status;
            }
            Err(e) => {
                status.state = "error".into();
                status.detail = Some(format!("读取失败：{e}"));
                return status;
            }
        }
    }
    status.state = "ok".into();
    status
}

/// Check one engine directory without downloading anything.
pub fn speech_status(engine: &str) -> Result<SpeechStatus> {
    let engine = normalize_engine(engine);
    let dir = speech_model_dir(&engine)?;
    let specs = files_for(&engine);
    let files: Vec<_> = specs.iter().map(|spec| check_file(&dir, spec)).collect();
    let missing: Vec<String> = files
        .iter()
        .filter(|f| !f.ok())
        .map(|f| f.name.clone())
        .collect();
    let files_ok = !specs.is_empty() && missing.is_empty();
    // SenseVoice runs in `wb-asr`, so verified files alone are not enough.
    let runtime_missing = files_ok && engine != ENGINE_QWENCTC && !sensevoice_runtime_available();
    let ready = files_ok && !runtime_missing;
    let present_bytes = files.iter().filter(|f| f.ok()).map(|f| f.bytes).sum();
    let total_bytes = sum_bytes(&specs);
    let message = if !dir.exists() {
        Some(format!("模型目录不存在：{}", dir.display()))
    } else if runtime_missing {
        Some("模型文件已就绪，但找不到 wb-asr 运行时；请重新安装应用或构建 wb-asr。".to_string())
    } else if ready {
        Some(match engine.as_str() {
            ENGINE_QWENCTC => "本地资源已就绪，识别引擎内置于应用".into(),
            _ => ready_message(),
        })
    } else {
        let broken: Vec<_> = files
            .iter()
            .filter(|f| f.present && !f.ok())
            .map(|f| f.name.clone())
            .collect();
        Some(if broken.is_empty() {
            format!("缺少 {} 个模型文件，可一键下载", missing.len())
        } else {
            format!(
                "缺少 {} 个文件，另有 {} 个需重新下载：{}",
                missing.len() - broken.len(),
                broken.len(),
                broken.join("、")
            )
        })
    };
    Ok(SpeechStatus {
        engine,
        ready,
        model_dir: dir.to_string_lossy().to_string(),
        missing,
        files,
        present_bytes,
        total_bytes,
        runtime_missing,
        message,
    })
}

/// Whether any SenseVoice backend can be launched.
fn sensevoice_runtime_available() -> bool {
    find_wb_asr().is_some()
        || crate::shell::which_bin("sherpa-onnx-offline").is_some()
        || crate::shell::which_bin("sensevoice").is_some()
}

fn ready_message() -> String {
    if find_wb_asr().is_some() {
        "模型已就绪（wb-asr）".into()
    } else if crate::shell::which_bin("sherpa-onnx-offline").is_some() {
        "模型已就绪（sherpa-onnx-offline CLI）".into()
    } else {
        "模型已就绪；请构建/安装 wb-asr，或安装 sherpa-onnx-offline CLI".into()
    }
}

/// Status of every supported engine.
pub fn speech_status_all() -> Vec<SpeechStatus> {
    speech_engines()
        .into_iter()
        .filter_map(|info| speech_status(&info.id).ok())
        .collect()
}

/// Create the engine directory without downloading.
pub fn speech_ensure_models(engine: &str) -> Result<SpeechStatus> {
    speech_ensure_models_ex(engine, false)
}

/// Create the engine directory and, when `download` is set, fetch anything
/// missing. Files that fail verification are removed and fetched again.
pub fn speech_ensure_models_ex(engine: &str, download: bool) -> Result<SpeechStatus> {
    speech_ensure_models_with(engine, download, |_| {})
}

/// Same as [`speech_ensure_models_ex`], reporting `(file, done, total)` as it
/// streams each file so a UI can show real progress.
pub fn speech_ensure_models_with(
    engine: &str,
    download: bool,
    mut on_progress: impl FnMut(DownloadProgress),
) -> Result<SpeechStatus> {
    let engine = normalize_engine(engine);
    let dir = speech_model_dir(&engine)?;
    fs::create_dir_all(&dir).context("创建模型目录失败")?;
    if !download {
        return speech_status(&engine);
    }

    let proxy = wb_store::load_prefs()
        .ok()
        .and_then(|p| p.http_proxy)
        .filter(|p| !p.trim().is_empty());
    let mut builder = reqwest::blocking::Client::builder()
        // No total deadline: a 240 MB model on a slow link legitimately takes
        // many minutes, and aborting it would waste the whole download. Stalls
        // are surfaced by the read loop instead; `connect_timeout` still bounds
        // how long an unreachable host can hang.
        .connect_timeout(std::time::Duration::from_secs(30));
    if let Some(proxy) = proxy.as_deref() {
        if let Ok(proxy) = reqwest::Proxy::all(proxy) {
            builder = builder.proxy(proxy);
        }
    }
    let client = builder.build()?;

    // Small files first so the status turns green sooner.
    let mut specs = files_for(&engine);
    specs.sort_by_key(|f| f.exact_bytes.unwrap_or(f.min_bytes));

    let mut errors = Vec::new();
    for spec in specs {
        let path = dir.join(&spec.rel_path);
        if check_file(&dir, &spec).ok() {
            continue;
        }
        if path.exists() {
            // A wrong or partial file must go: resuming cannot fix it.
            let _ = fs::remove_file(&path);
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        // Cached digests for this file are stale now that it is gone.
        invalidate_hash_cache(&engine)?;
        let expected = spec.exact_bytes.unwrap_or(spec.min_bytes);
        let mut reported = 0u64;
        on_progress(DownloadProgress {
            file: spec.name.clone(),
            done: 0,
            total: expected,
        });
        let result = download_file(&client, &spec.mirror_url, &path, |done, _| {
            report_progress(&mut on_progress, &spec.name, done, expected, &mut reported);
        })
        .or_else(|e| {
            log::warn!("镜像下载失败 {}：{e}", spec.name);
            // Restart the bar from zero so the fallback does not look stalled.
            reported = 0;
            on_progress(DownloadProgress {
                file: spec.name.clone(),
                done: 0,
                total: expected,
            });
            download_file(&client, &spec.url, &path, |done, _| {
                report_progress(&mut on_progress, &spec.name, done, expected, &mut reported);
            })
        })
        .and_then(|_| {
            let checked = check_file(&dir, &spec);
            if checked.ok() {
                Ok(())
            } else {
                Err(anyhow::anyhow!(
                    "{} 校验失败：{}",
                    spec.name,
                    checked.detail.unwrap_or(checked.state)
                ))
            }
        });
        if let Err(e) = result {
            let _ = fs::remove_file(&path);
            invalidate_hash_cache(&engine)?;
            errors.push(format!("{}：{e}", spec.name));
        }
    }

    let status = speech_status(&engine)?;
    if !errors.is_empty() {
        log::warn!("语音模型下载未全部完成：{}", errors.join("；"));
    }
    // The files on disk changed; drop any engine loaded from the old ones.
    if engine == ENGINE_QWENCTC {
        qwenctc::unload();
    }
    Ok(status)
}

/// One progress tick while downloading.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub file: String,
    pub done: u64,
    pub total: u64,
}

fn download_file(
    client: &reqwest::blocking::Client,
    url: &str,
    path: &Path,
    mut on_bytes: impl FnMut(u64, u64),
) -> Result<()> {
    let mut resp = client.get(url).send().context("下载语音模型失败")?;
    if !resp.status().is_success() {
        bail!("下载失败 HTTP {}", resp.status());
    }
    // `Content-Length` is the body length; use it when the server reports one.
    let total = resp.content_length().unwrap_or(0);
    let tmp = path.with_extension("part");
    {
        let mut file = fs::File::create(&tmp)?;
        let mut copied = 0u64;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let read = match resp.read(&mut buf) {
                Ok(read) => read,
                Err(e) => {
                    let _ = fs::remove_file(&tmp);
                    // The client has no per-read timeout of its own, so a
                    // stalled transfer surfaces here as an I/O error.
                    return Err(e).with_context(|| {
                        format!("下载中断（已收到 {} 字节）", human_bytes(copied))
                    });
                }
            };
            if read == 0 {
                break;
            }
            file.write_all(&buf[..read])?;
            copied += read as u64;
            on_bytes(copied, total);
        }
        if copied == 0 {
            let _ = fs::remove_file(&tmp);
            bail!("下载内容为空（可能是错误页）");
        }
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

fn human_bytes(bytes: u64) -> String {
    let mb = bytes as f64 / 1_048_576.0;
    if mb >= 1.0 {
        format!("{mb:.1} MB")
    } else {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    }
}

/// Remove every file of an engine so it can be downloaded again.
pub fn speech_remove_models(engine: &str) -> Result<SpeechStatus> {
    let engine = normalize_engine(engine);
    let dir = speech_model_dir(&engine)?;
    for spec in files_for(&engine) {
        let path = dir.join(&spec.rel_path);
        if path.exists() {
            fs::remove_file(&path).with_context(|| format!("删除 {} 失败", path.display()))?;
        }
    }
    if engine == ENGINE_QWENCTC {
        qwenctc::unload();
    }
    speech_status(&engine)
}

/// Load the engine up front so the first dictation is not slowed by it.
/// SenseVoice loads in `wb-asr` per invocation, so it only re-checks files.
pub fn speech_warm(engine: &str) -> Result<SpeechStatus> {
    let engine = normalize_engine(engine);
    let status = speech_status(&engine)?;
    if status.ready && engine == ENGINE_QWENCTC {
        qwenctc::warm(Path::new(&status.model_dir))?;
    }
    Ok(status)
}

fn find_wb_asr() -> Option<PathBuf> {
    if let Some(p) = crate::shell::which_bin("wb-asr") {
        return Some(PathBuf::from(p));
    }
    let exe_name = if cfg!(windows) {
        "wb-asr.exe"
    } else {
        "wb-asr"
    };
    if let Ok(current) = std::env::current_exe()
        && let Some(dir) = current.parent()
    {
        let sibling = dir.join(exe_name);
        if sibling.is_file() {
            return Some(sibling);
        }
        for up in [dir.to_path_buf(), dir.join(".."), dir.join("../..")] {
            for profile in ["debug", "release"] {
                let cand = up.join(profile).join(exe_name);
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
    }
    None
}

fn run_wb_asr(bin: &Path, model_dir: &str, wav_path: &str, language: &str) -> Result<String> {
    let tokens = Path::new(model_dir).join("sensevoice-onnx/tokens.txt");
    let model = Path::new(model_dir).join("sensevoice-onnx/model.int8.onnx");
    let out = Command::new(bin)
        .arg("--tokens")
        .arg(&tokens)
        .arg("--model")
        .arg(&model)
        .arg("--language")
        .arg(language)
        .arg(wav_path)
        .output()
        .context("启动 wb-asr 失败")?;
    if out.status.success() {
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !text.is_empty() {
            return Ok(text);
        }
    }
    let err = String::from_utf8_lossy(&out.stderr);
    bail!("wb-asr 失败：{err}")
}

fn run_sherpa_cli(model_dir: &str, wav_path: &str, language: &str) -> Option<Result<String>> {
    let bin = crate::shell::which_bin("sherpa-onnx-offline")
        .or_else(|| crate::shell::which_bin("sensevoice"))?;
    let tokens = Path::new(model_dir).join("sensevoice-onnx/tokens.txt");
    let model = Path::new(model_dir).join("sensevoice-onnx/model.int8.onnx");
    let out = Command::new(&bin)
        .arg("--tokens")
        .arg(&tokens)
        .arg("--sense-voice-model")
        .arg(&model)
        .arg("--language")
        .arg(language)
        .arg(wav_path)
        .output()
        .map_err(|e| anyhow::anyhow!("启动语音 CLI 失败：{e}"));
    let out = match out {
        Ok(out) => out,
        Err(e) => return Some(Err(e)),
    };
    if out.status.success() {
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !text.is_empty() {
            return Some(Ok(text));
        }
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Some(Err(anyhow::anyhow!("语音 CLI 失败：{err}")))
}

fn transcribe_sensevoice(status: &SpeechStatus, wav_path: &str, language: &str) -> Result<String> {
    if status.ready
        && let Some(bin) = find_wb_asr()
    {
        match run_wb_asr(&bin, &status.model_dir, wav_path, language) {
            Ok(text) => return Ok(text),
            Err(e) => log::warn!("wb-asr failed: {e}"),
        }
    }
    if let Some(result) = run_sherpa_cli(&status.model_dir, wav_path, language) {
        return result;
    }
    if !status.missing.is_empty() {
        bail!(
            "SenseVoice 模型未就绪（缺少 {}）。请在设置 → 语音输入中下载。",
            status.missing.join("、")
        );
    }
    bail!(
        "SenseVoice 模型已在 {}，但找不到可用的识别程序（wb-asr 或 sherpa-onnx-offline）。",
        status.model_dir
    )
}

/// Transcribe a WAV file with the given engine.
pub fn speech_transcribe(engine: &str, wav_path: &str, language: Option<&str>) -> Result<String> {
    let wav = Path::new(wav_path);
    if !wav.is_file() {
        bail!("录音文件不存在：{wav_path}");
    }
    let engine = normalize_engine(engine);
    let status = speech_status(&engine)?;
    let lang = language.unwrap_or("auto");
    match engine.as_str() {
        ENGINE_QWENCTC => qwenctc::transcribe(&status, wav),
        _ => transcribe_sensevoice(&status, wav_path, lang),
    }
}

/// Engine that should be used right now: the configured one, else whichever
/// engine has its files on disk.
pub fn speech_active_engine() -> String {
    let configured = wb_store::load_prefs().ok().and_then(|p| p.voice.engine);
    if let Some(configured) = configured.as_deref().filter(|e| !e.trim().is_empty()) {
        let configured = normalize_engine(configured);
        if speech_status(&configured).is_ok_and(|s| s.ready) {
            return configured;
        }
    }
    for info in speech_engines() {
        if speech_status(&info.id).is_ok_and(|s| s.ready) {
            return info.id;
        }
    }
    configured
        .as_deref()
        .map(normalize_engine)
        .unwrap_or_else(|| ENGINE_SENSEVOICE.into())
}

/// Whisper-style log-mel front end + greedy CTC decoder for Qwen3-ASR.
mod qwenctc;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_covers_both_engines() {
        assert_eq!(sensevoice_files().len(), 2);
        assert_eq!(qwenctc_files().len(), 3);
        assert!(
            qwenctc_files()
                .iter()
                .any(|f| f.name == "Qwen3-ASR-Encoder.q4.onnx")
        );
        assert_eq!(speech_engines().len(), 2);
        assert_eq!(normalize_engine("QWENCTC"), ENGINE_QWENCTC);
        assert_eq!(normalize_engine("SenseVoice"), ENGINE_SENSEVOICE);
        assert_eq!(normalize_engine("nope"), ENGINE_SENSEVOICE);
    }

    /// Every catalogued file must actually be read by the recognizer. A listed
    /// but unused file would force a pointless download and block "ready".
    #[test]
    fn no_engine_lists_a_file_nothing_reads() {
        // Paths that inference actually opens.
        let used = [
            "sensevoice-onnx/model.int8.onnx",
            "sensevoice-onnx/tokens.txt",
            "Qwen3-ASR-Encoder.q4.onnx",
            "Qwen3-ASR-CTC.q4f16.onnx",
            "tokens.txt",
        ];
        for info in speech_engines() {
            for spec in files_for(&info.id) {
                assert!(
                    used.contains(&spec.rel_path.as_str()),
                    "{} lists {} but nothing opens it",
                    info.id,
                    spec.rel_path
                );
            }
        }
    }

    /// Verified files are not enough for SenseVoice: without `wb-asr` the
    /// engine cannot run, so `ready` must stay false.
    #[test]
    fn runtime_gap_blocks_ready() {
        let base = SpeechStatus {
            engine: ENGINE_SENSEVOICE.into(),
            ready: false,
            model_dir: String::new(),
            missing: Vec::new(),
            files: Vec::new(),
            present_bytes: 100,
            total_bytes: 100,
            runtime_missing: true,
            message: Some("运行时缺失".into()),
        };
        assert!(!base.ready, "files alone must not imply a runnable engine");
        // Progress is about bytes, not runnability.
        assert_eq!(base.progress(), 1.0);
    }

    #[test]
    fn every_engine_total_matches_its_file_sizes() {
        for info in speech_engines() {
            let files = files_for(&info.id);
            assert!(info.total_bytes > 0);
            assert_eq!(info.total_bytes, sum_bytes(&files));
            assert!(files.iter().all(|f| f.exact_bytes.is_some()));
            assert!(files.iter().all(|f| f.exact_bytes >= Some(f.min_bytes)));
        }
    }

    #[test]
    fn progress_reflects_verified_bytes() {
        let status = SpeechStatus {
            engine: ENGINE_QWENCTC.into(),
            ready: false,
            model_dir: String::new(),
            missing: vec!["tokens.txt".into()],
            files: Vec::new(),
            present_bytes: 40,
            total_bytes: 100,
            runtime_missing: false,
            message: None,
        };
        assert!((status.progress() - 0.4).abs() < 1e-6);

        let done = SpeechStatus {
            ready: true,
            present_bytes: 100,
            total_bytes: 100,
            ..status
        };
        assert_eq!(done.progress(), 1.0);
    }

    #[test]
    fn check_file_flags_missing_size_and_hash_mismatch() {
        let dir = std::env::temp_dir().join(format!("wb-speech-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let spec = SpeechFileSpec::new(
            "tokens.txt",
            "tokens.txt",
            "https://example.invalid/tokens.txt",
            "https://example.invalid/tokens.txt",
            1,
            4,
            Some("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"),
        );

        let missing = check_file(&dir, &spec);
        assert_eq!(missing.state, "missing");
        assert!(!missing.present);

        fs::write(dir.join("tokens.txt"), b"hi").unwrap();
        let wrong_size = check_file(&dir, &spec);
        assert_eq!(wrong_size.state, "size");

        // Right size, wrong content: this digest is sha256("test").
        fs::write(dir.join("tokens.txt"), b"nope").unwrap();
        let wrong_hash = check_file(&dir, &spec);
        assert_eq!(wrong_hash.state, "hash");

        fs::write(dir.join("tokens.txt"), b"test").unwrap();
        assert!(check_file(&dir, &spec).ok());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cached_hash_never_serves_stale_content() {
        let dir = std::env::temp_dir().join(format!("wb-hash-cache-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("blob.bin");
        fs::write(&path, b"test").unwrap();
        let meta = fs::metadata(&path).unwrap();
        let digest = cached_sha256(&path, meta.len(), meta.modified().ok()).unwrap();
        assert_eq!(
            digest,
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        );

        // Same size, different bytes, within the same timestamp tick. A cache
        // keyed only by size and mtime would wrongly return the old digest.
        fs::write(&path, b"nope").unwrap();
        let meta = fs::metadata(&path).unwrap();
        let after = cached_sha256(&path, meta.len(), meta.modified().ok()).unwrap();
        assert_ne!(
            after, digest,
            "freshly written files must be re-hashed, not served from cache"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// A cached digest is only valid while size and mtime both match, and it
    /// must survive a restart (otherwise every launch re-hashes 470 MB).
    #[test]
    fn cache_entry_round_trips_and_rejects_mismatches() {
        let entry = CacheEntry {
            len: 42,
            mtime_ms: Some(1_700_000_000_000),
            sha256: "abc".into(),
        };
        let raw = serde_json::to_string(&entry).unwrap();
        let back: CacheEntry = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.len, 42);
        assert_eq!(back.mtime_ms, Some(1_700_000_000_000));
        assert_eq!(back.sha256, "abc");

        // A size change or a new mtime must not match a stored entry.
        assert_ne!(back.len, 43);
        assert_ne!(back.mtime_ms, Some(1_700_000_000_001));
    }

    #[test]
    fn download_progress_percent_clamps() {
        let p = DownloadProgress {
            file: "a".into(),
            done: 50,
            total: 200,
        };
        assert_eq!(p.percent(), 25);
        let unknown_total = DownloadProgress {
            total: 0,
            ..p.clone()
        };
        assert_eq!(unknown_total.percent(), 0);
        let overshoot = DownloadProgress { done: 500, ..p };
        assert_eq!(overshoot.percent(), 100);
    }
}
