use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

const MAX_BYTES: u64 = 3_200 * 1024 * 1024;
const MAX_WAV_BYTES: usize = 4 * 1024 * 1024;
/** Keep the warmed recognizer around like dsh (5 minutes). */
const WORKER_IDLE_MS: u64 = 300_000;
const WORKER_START_TIMEOUT: Duration = Duration::from_secs(120);
const DOWNLOAD_CANCELLED: &str = "已终止下载";

static DOWNLOAD_SESSION: AtomicU64 = AtomicU64::new(0);
static DOWNLOAD_CANCEL_SESSION: AtomicU64 = AtomicU64::new(0);
static DOWNLOAD_ACTIVE: AtomicBool = AtomicBool::new(false);
static DOWNLOAD_SESSION_LOCAL: AtomicU64 = AtomicU64::new(0);
static DOWNLOAD_PENDING_CANCEL: AtomicBool = AtomicBool::new(false);

fn begin_download_session() -> u64 {
    let session = DOWNLOAD_SESSION.fetch_add(1, Ordering::SeqCst) + 1;
    DOWNLOAD_SESSION_LOCAL.store(session, Ordering::SeqCst);
    DOWNLOAD_ACTIVE.store(true, Ordering::SeqCst);
    if DOWNLOAD_PENDING_CANCEL.swap(false, Ordering::SeqCst) {
        DOWNLOAD_CANCEL_SESSION.store(session, Ordering::SeqCst);
    }
    session
}

fn end_download_session() {
    DOWNLOAD_ACTIVE.store(false, Ordering::SeqCst);
}

fn download_cancelled() -> bool {
    let session = DOWNLOAD_SESSION_LOCAL.load(Ordering::Relaxed);
    session > 0 && DOWNLOAD_CANCEL_SESSION.load(Ordering::Relaxed) >= session
}

fn ensure_not_cancelled() -> Result<(), String> {
    if download_cancelled() {
        Err(DOWNLOAD_CANCELLED.into())
    } else {
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechFileSpec {
    #[allow(dead_code)]
    pub name: String,
    pub rel_path: String,
    pub url: String,
    pub mirror_url: String,
    pub min_bytes: u64,
    pub sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechEnsureResult {
    pub dir: String,
    pub ready: bool,
    pub error: Option<String>,
    pub phase: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeechDownloadProgress {
    engine: String,
    name: String,
    phase: String,
    current: u64,
    total: u64,
    percent: u8,
    index: usize,
    count: usize,
    message: String,
}

fn emit_download_progress(app: &tauri::AppHandle, progress: SpeechDownloadProgress) {
    let _ = app.emit("speech-download-progress", progress);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStatus {
    pub dir: String,
    pub ready: bool,
    pub phase: String,
    pub model: String,
    pub tokens: String,
    pub vad: String,
    pub message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechTranscribeRequest {
    pub audio_base64: String,
    pub language: Option<String>,
    pub engine: Option<String>,
}

#[derive(Clone)]
struct EngineConfig {
    engine: String,
}

impl EngineConfig {
    fn fingerprint(&self) -> String {
        self.engine.clone()
    }
}

fn parse_engine_config(engine: Option<&str>) -> Result<EngineConfig, String> {
    let engine = engine
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .unwrap_or("sensevoice");
    if engine != "sensevoice" && engine != "funasr" && engine != "qwenctc" {
        return Err("不支持的语音引擎".into());
    }
    Ok(EngineConfig {
        engine: engine.to_string(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechTranscript {
    pub text: String,
    pub audio_seconds: f64,
    pub inference_seconds: f64,
}

fn allowed_host(host: &str) -> bool {
    host == "huggingface.co"
        || host == "hf-mirror.com"
        || host.ends_with(".huggingface.co")
        || host.ends_with(".hf-mirror.com")
        || host == "cdn-lfs.huggingface.co"
        || host.ends_with(".cdn-lfs.huggingface.co")
        || host == "github.com"
        || host == "objects.githubusercontent.com"
        || host == "release-assets.githubusercontent.com"
        || host.ends_with(".githubusercontent.com")
        || host == "ghfast.top"
        || host.ends_with(".ghfast.top")
        || host == "modelscope.cn"
        || host == "www.modelscope.cn"
        || host.ends_with(".modelscope.cn")
}

fn models_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .data_dir()
        .map_err(|_| "无法定位配置目录".to_string())?;
    Ok(root.join("my-workbench").join("models"))
}

fn engine_model_dir(app: &tauri::AppHandle, engine: &str) -> Result<PathBuf, String> {
    let sub = match engine {
        "funasr" => "funasr",
        "qwenctc" => "qwenctc",
        _ => "sensevoice",
    };
    Ok(models_root(app)?.join(sub))
}

fn model_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    engine_model_dir(app, "sensevoice")
}

fn speech_runtime_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource) = app.path().resource_dir() {
        let bundled = resource.join("speech").join("runtimes");
        if bundled.is_dir() {
            return Ok(bundled);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("speech")
        .join("runtimes");
    if dev.is_dir() {
        return Ok(dev);
    }
    Err("找不到语音推理运行时".into())
}

fn resource_speech_file(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    if let Ok(resource) = app.path().resource_dir() {
        let bundled = resource.join("speech").join(name);
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("speech")
        .join(name);
    if dev.is_file() {
        return Ok(dev);
    }
    Err(format!("找不到语音转写脚本：{name}"))
}

fn sensevoice_worker_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    resource_speech_file(app, "transcribe.mjs")
}

fn funasr_worker_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    resource_speech_file(app, "funasr_worker.py")
}

fn qwenctc_worker_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    resource_speech_file(app, "qwenctc_worker.py")
}

fn resolve_funasr_file(model_dir: &Path, candidates: &[&str]) -> Option<PathBuf> {
    for name in candidates {
        let direct = model_dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        let nested = model_dir.join("model").join(name);
        if nested.is_file() {
            return Some(nested);
        }
    }
    None
}

fn funasr_paths_ready(model_dir: &Path, runtime_root: &Path) -> Result<(), String> {
    if !model_dir.is_dir() {
        return Err(format!("FunASR 模型目录不存在：{}", model_dir.display()));
    }
    let checks: &[(&str, &[&str])] = &[
        (
            "encoder",
            &[
                "Fun-ASR-Nano-Encoder-Adaptor.fp16.onnx",
                "Fun-ASR-Nano-Encoder-Adaptor.int8.onnx",
                "Fun-ASR-Nano-Encoder-Adaptor.onnx",
            ],
        ),
        (
            "ctc",
            &[
                "Fun-ASR-Nano-CTC.fp16.onnx",
                "Fun-ASR-Nano-CTC.int8.onnx",
                "Fun-ASR-Nano-CTC.onnx",
            ],
        ),
        (
            "decoder",
            &[
                "Fun-ASR-Nano-Decoder.q5_k.gguf",
                "Fun-ASR-Nano-Decoder.q8_0.gguf",
                "Fun-ASR-Nano-Decoder.gguf",
            ],
        ),
        ("tokens", &["tokens.txt"]),
    ];
    for (key, candidates) in checks {
        if resolve_funasr_file(model_dir, candidates).is_none() {
            return Err(format!(
                "FunASR 模型缺少 {key}：在 {} 未找到 {}（请先准备/下载）",
                model_dir.display(),
                candidates[0]
            ));
        }
    }
    let inference = runtime_root.join("fun_asr_gguf").join("inference");
    if !inference.is_dir() {
        return Err(format!("找不到 FunASR 推理代码：{}", inference.display()));
    }
    let llama_bin = model_dir.join("bin");
    let llama_dll = llama_bin.join("llama.dll");
    if !llama_dll.is_file() {
        return Err(format!(
            "找不到 llama 运行库：{}（请点击「开始准备」下载，或将 llama.dll 等放入该目录）",
            llama_bin.display()
        ));
    }
    Ok(())
}

fn resolve_qwenctc_file(model_dir: &Path, candidates: &[&str]) -> Option<PathBuf> {
    for name in candidates {
        let direct = model_dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
    }
    None
}

fn qwenctc_paths_ready(model_dir: &Path, runtime_root: &Path) -> Result<(), String> {
    if !model_dir.is_dir() {
        return Err(format!("QwenCTC 模型目录不存在：{}", model_dir.display()));
    }
    let checks: &[(&str, &[&str])] = &[
        (
            "encoder",
            &["Qwen3-ASR-Encoder.q4.onnx", "Qwen3-ASR-Encoder.onnx"],
        ),
        (
            "ctc",
            &[
                "Qwen3-ASR-CTC.fp16.onnx",
                "Qwen3-ASR-CTC.q4f16.onnx",
                "Qwen3-ASR-CTC.hqqf16.onnx",
                "Qwen3-ASR-CTC.v1.fp16.onnx",
                "Qwen3-ASR-CTC.onnx",
            ],
        ),
        ("tokens", &["tokens.txt"]),
    ];
    for (key, candidates) in checks {
        if resolve_qwenctc_file(model_dir, candidates).is_none() {
            return Err(format!(
                "QwenCTC 模型缺少 {key}：在 {} 未找到 {}（请先准备/下载）",
                model_dir.display(),
                candidates[0]
            ));
        }
    }
    if !model_dir.join("preprocessor_config.json").is_file() {
        return Err(format!(
            "QwenCTC 缺少 preprocessor_config.json：{}",
            model_dir.display()
        ));
    }
    let qwen_pkg = runtime_root.join("qwen_ctc");
    if !qwen_pkg.is_dir() {
        return Err(format!("找不到 QwenCTC 推理代码：{}", qwen_pkg.display()));
    }
    Ok(())
}

fn normalize_rel(rel: &str) -> Result<String, String> {
    let rel = rel.trim().replace('\\', "/");
    if rel.is_empty()
        || rel.len() > 160
        || rel.starts_with('/')
        || rel.contains("..")
        || !rel
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' || ch == '/')
    {
        return Err("模型路径无效".into());
    }
    Ok(rel)
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn file_ready(path: &Path, min_bytes: u64, sha256: &str) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < min_bytes {
        return false;
    }
    if sha256.is_empty() {
        return true;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    hex_sha256(&bytes) == sha256.to_ascii_lowercase()
}

fn explain(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        return "下载超时".into();
    }
    if err.is_connect() {
        return "无法连接到模型服务器".into();
    }
    "网络错误".into()
}

struct DownloadJob<'a> {
    app: &'a tauri::AppHandle,
    engine: &'a str,
    name: &'a str,
    index: usize,
    count: usize,
}

fn progress_percent(current: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    if current == 0 {
        return 0;
    }
    // Use floating math so early progress (e.g. 3MB/796MB) is not truncated to 0%.
    let pct = ((current.min(total) as f64) * 100.0 / (total as f64)).floor() as u8;
    pct.clamp(1, 100)
}

fn emit_job_progress(
    job: &DownloadJob<'_>,
    phase: &str,
    current: u64,
    total: u64,
    message: impl Into<String>,
) {
    emit_download_progress(
        job.app,
        SpeechDownloadProgress {
            engine: job.engine.to_string(),
            name: job.name.to_string(),
            phase: phase.to_string(),
            current,
            total,
            percent: progress_percent(current, total),
            index: job.index,
            count: job.count,
            message: message.into(),
        },
    );
}

async fn download_one(
    client: &reqwest::Client,
    dir: &Path,
    spec: &SpeechFileSpec,
    job: &DownloadJob<'_>,
) -> Result<(), String> {
    let rel = normalize_rel(&spec.rel_path)?;
    if spec.min_bytes == 0 || spec.min_bytes > MAX_BYTES {
        return Err("模型文件大小无效".into());
    }
    let dest = dir.join(Path::new(&rel));
    if file_ready(&dest, spec.min_bytes, "") {
        emit_job_progress(job, "ready", 1, 1, format!("已存在：{}", job.name));
        return Ok(());
    }
    let urls = [spec.url.trim(), spec.mirror_url.trim()];
    let mut last_error = "下载失败".to_string();
    for url in urls {
        if url.is_empty() {
            continue;
        }
        ensure_not_cancelled()?;
        match download_url(client, dir, &rel, url, spec, job).await {
            Ok(()) => return Ok(()),
            Err(message) if message == DOWNLOAD_CANCELLED => return Err(message),
            Err(message) => last_error = message,
        }
    }
    Err(last_error)
}

async fn download_url(
    client: &reqwest::Client,
    dir: &Path,
    rel: &str,
    url: &str,
    spec: &SpeechFileSpec,
    job: &DownloadJob<'_>,
) -> Result<(), String> {
    ensure_not_cancelled()?;
    let parsed = reqwest::Url::parse(url).map_err(|_| "模型地址无效".to_string())?;
    if parsed.scheme() != "https" {
        return Err("模型地址无效".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if !allowed_host(host) {
        return Err("模型地址无效".into());
    }
    emit_job_progress(
        job,
        "downloading",
        0,
        spec.min_bytes.max(1),
        format!("正在下载 {}…", job.name),
    );
    let mut response = client
        .get(parsed)
        .header(reqwest::header::USER_AGENT, "my-workbench")
        .send()
        .await
        .map_err(|err| explain(&err))?;
    ensure_not_cancelled()?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载失败：服务器返回 {}", status.as_u16()));
    }
    let total = response
        .content_length()
        .unwrap_or(spec.min_bytes)
        .max(1);
    let dest = dir.join(Path::new(rel));
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "无法创建语音模型目录".to_string())?;
    }
    let partial = dir.join(format!("{}.part", rel.replace('/', "__")));
    let mut file =
        std::fs::File::create(&partial).map_err(|_| "无法写入配置目录".to_string())?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut first_byte: Option<u8> = None;
    let mut last_emit = Instant::now();
    loop {
        if download_cancelled() {
            drop(file);
            let _ = std::fs::remove_file(&partial);
            return Err(DOWNLOAD_CANCELLED.into());
        }
        let chunk = response.chunk().await.map_err(|err| explain(&err))?;
        let Some(chunk) = chunk else {
            break;
        };
        if chunk.is_empty() {
            continue;
        }
        if first_byte.is_none() {
            first_byte = chunk.first().copied();
        }
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MAX_BYTES {
            let _ = std::fs::remove_file(&partial);
            return Err("下载文件过大".into());
        }
        std::io::Write::write_all(&mut file, &chunk)
            .map_err(|_| "无法写入配置目录".to_string())?;
        if !spec.sha256.is_empty() {
            hasher.update(&chunk);
        }
        if last_emit.elapsed() >= Duration::from_millis(200) || downloaded >= total {
            emit_job_progress(
                job,
                "downloading",
                downloaded,
                total,
                format!(
                    "正在下载 {}（{}/{}）…",
                    job.name,
                    format_bytes(downloaded),
                    format_bytes(total)
                ),
            );
            last_emit = Instant::now();
        }
    }
    drop(file);
    if download_cancelled() {
        let _ = std::fs::remove_file(&partial);
        return Err(DOWNLOAD_CANCELLED.into());
    }
    if downloaded < spec.min_bytes || first_byte == Some(b'<') {
        let _ = std::fs::remove_file(&partial);
        return Err("下载内容不是模型文件".into());
    }
    if !spec.sha256.is_empty() {
        let digest = hex_sha256(hasher.finalize().as_slice());
        if digest != spec.sha256.to_ascii_lowercase() {
            let _ = std::fs::remove_file(&partial);
            return Err("模型校验失败".into());
        }
    }
    if dest.exists() {
        let _ = std::fs::remove_file(&dest);
    }
    std::fs::rename(&partial, &dest).map_err(|_| "无法写入配置目录".to_string())?;
    emit_job_progress(
        job,
        "ready",
        downloaded,
        downloaded.max(1),
        format!("已下载：{}", job.name),
    );
    Ok(())
}

fn format_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    let value = bytes as f64;
    if value >= GB {
        format!("{:.1} GB", value / GB)
    } else if value >= MB {
        format!("{:.0} MB", value / MB)
    } else if value >= KB {
        format!("{:.0} KB", value / KB)
    } else {
        format!("{bytes} B")
    }
}

fn resolved_paths(dir: &Path) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let model = dir.join("sensevoice-onnx").join("model.int8.onnx");
    let tokens = dir.join("sensevoice-onnx").join("tokens.txt");
    let vad = dir.join("silero").join("silero_vad.onnx");
    for path in [&model, &tokens, &vad] {
        if !path.is_file() {
            return Err("本地语音资源未准备".into());
        }
    }
    Ok((model, tokens, vad))
}

fn find_node() -> Result<PathBuf, String> {
    which("node")
        .or_else(|| which("node.exe"))
        .ok_or_else(|| {
            "未找到 Node.js。本地 SenseVoice 转写需要本机安装 Node，并可用 sherpa-onnx-node。"
                .into()
        })
}

fn find_python() -> Result<PathBuf, String> {
    which("python")
        .or_else(|| which("python3"))
        .or_else(|| which("python.exe"))
        .or_else(|| which("python3.exe"))
        .ok_or_else(|| {
            "未找到 Python。FunASR / QwenCTC 需要本机 Python，并已安装 onnxruntime 等依赖。"
                .into()
        })
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn sherpa_module_paths() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(npm_root) = Command::new("npm").args(["root", "-g"]).output() {
        if npm_root.status.success() {
            let root = String::from_utf8_lossy(&npm_root.stdout).trim().to_string();
            if !root.is_empty() {
                out.push(root.clone());
                out.push(
                    Path::new(&root)
                        .join("@deepseek-ai")
                        .join("dsh")
                        .join("node_modules")
                        .display()
                        .to_string(),
                );
            }
        }
    }
    let fallback =
        PathBuf::from(r"C:\software\nodejs\npm_global\node_modules\@deepseek-ai\dsh\node_modules");
    if fallback.is_dir() {
        out.push(fallback.display().to_string());
    }
    out
}

fn build_download_client(proxy: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(1800))
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let host = attempt.url().host_str().unwrap_or("");
            if allowed_host(host) && attempt.previous().len() < 8 {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }));
    if let Some(proxy_url) = proxy.map(str::trim).filter(|item| !item.is_empty()) {
        let proxy = reqwest::Proxy::all(proxy_url).map_err(|_| "代理地址无效".to_string())?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|_| "无法发起下载".to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechArchiveSpec {
    pub name: String,
    pub rel_dir: String,
    pub url: String,
    pub mirror_url: String,
    pub min_bytes: u64,
    pub markers: Vec<String>,
}

fn markers_ready(dir: &Path, markers: &[String]) -> bool {
    markers.iter().all(|name| {
        let direct = dir.join(name);
        if direct.is_file() {
            return true;
        }
        // Also accept one nested folder (zip root).
        std::fs::read_dir(dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.path().is_dir() && entry.path().join(name).is_file())
    })
}

fn flatten_extracted(dir: &Path, markers: &[String]) -> Result<(), String> {
    if markers.iter().all(|name| dir.join(name).is_file()) {
        return Ok(());
    }
    let nested = std::fs::read_dir(dir)
        .map_err(|_| "无法读取模型目录".to_string())?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|path| {
            path.is_dir() && markers.iter().any(|name| path.join(name).is_file())
        });
    let Some(nested) = nested else {
        return Ok(());
    };
    for entry in std::fs::read_dir(&nested).map_err(|_| "无法读取解压目录".to_string())? {
        let entry = entry.map_err(|_| "无法读取解压目录".to_string())?;
        let dest = dir.join(entry.file_name());
        if dest.exists() {
            continue;
        }
        std::fs::rename(entry.path(), &dest)
            .or_else(|_| {
                if entry.path().is_dir() {
                    copy_dir_all(&entry.path(), &dest)
                } else {
                    std::fs::copy(entry.path(), &dest).map(|_| ())
                }
            })
            .map_err(|_| "无法整理模型文件".to_string())?;
    }
    let _ = std::fs::remove_dir_all(&nested);
    Ok(())
}

fn copy_dir_all(from: &Path, to: &Path) -> Result<(), std::io::Error> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir_all(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

async fn download_archive(
    client: &reqwest::Client,
    dir: &Path,
    spec: &SpeechArchiveSpec,
    job: &DownloadJob<'_>,
) -> Result<(), String> {
    let target = if spec.rel_dir.trim().is_empty() {
        dir.to_path_buf()
    } else {
        dir.join(spec.rel_dir.trim())
    };
    std::fs::create_dir_all(&target).map_err(|_| "无法创建语音模型目录".to_string())?;
    if markers_ready(&target, &spec.markers) {
        let _ = flatten_extracted(&target, &spec.markers);
        if markers_ready(&target, &spec.markers) {
            emit_job_progress(job, "ready", 1, 1, format!("已存在：{}", job.name));
            return Ok(());
        }
    }
    if spec.min_bytes == 0 || spec.min_bytes > MAX_BYTES {
        return Err("模型压缩包大小无效".into());
    }
    let urls = [spec.url.trim(), spec.mirror_url.trim()];
    let mut last_error = "下载失败".to_string();
    for url in urls {
        if url.is_empty() {
            continue;
        }
        ensure_not_cancelled()?;
        match download_and_unzip(client, &target, url, spec, job).await {
            Ok(()) => return Ok(()),
            Err(message) if message == DOWNLOAD_CANCELLED => return Err(message),
            Err(message) => last_error = message,
        }
    }
    Err(last_error)
}

async fn download_and_unzip(
    client: &reqwest::Client,
    target: &Path,
    url: &str,
    spec: &SpeechArchiveSpec,
    job: &DownloadJob<'_>,
) -> Result<(), String> {
    ensure_not_cancelled()?;
    let parsed = reqwest::Url::parse(url).map_err(|_| "模型地址无效".to_string())?;
    if parsed.scheme() != "https" {
        return Err("模型地址无效".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if !allowed_host(host) {
        return Err("模型地址无效".into());
    }
    emit_job_progress(
        job,
        "downloading",
        0,
        spec.min_bytes.max(1),
        format!("正在下载 {}…", job.name),
    );
    let mut response = client
        .get(parsed)
        .header(reqwest::header::USER_AGENT, "my-workbench")
        .send()
        .await
        .map_err(|err| explain(&err))?;
    ensure_not_cancelled()?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载失败：服务器返回 {}", status.as_u16()));
    }
    let total = response
        .content_length()
        .unwrap_or(spec.min_bytes)
        .max(1);
    let zip_path = target.join(format!("{}.part.zip", spec.name.replace(['/', '\\'], "_")));
    let mut file =
        std::fs::File::create(&zip_path).map_err(|_| "无法写入配置目录".to_string())?;
    let mut downloaded: u64 = 0;
    let mut first_byte: Option<u8> = None;
    let mut last_emit = Instant::now();
    loop {
        if download_cancelled() {
            drop(file);
            let _ = std::fs::remove_file(&zip_path);
            return Err(DOWNLOAD_CANCELLED.into());
        }
        let chunk = response.chunk().await.map_err(|err| explain(&err))?;
        let Some(chunk) = chunk else {
            break;
        };
        if chunk.is_empty() {
            continue;
        }
        if first_byte.is_none() {
            first_byte = chunk.first().copied();
        }
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MAX_BYTES {
            let _ = std::fs::remove_file(&zip_path);
            return Err("下载文件过大".into());
        }
        std::io::Write::write_all(&mut file, &chunk)
            .map_err(|_| "无法写入配置目录".to_string())?;
        if last_emit.elapsed() >= Duration::from_millis(200) || downloaded >= total {
            emit_job_progress(
                job,
                "downloading",
                downloaded,
                total,
                format!(
                    "正在下载 {}（{}/{}）…",
                    job.name,
                    format_bytes(downloaded),
                    format_bytes(total)
                ),
            );
            last_emit = Instant::now();
        }
    }
    drop(file);
    if download_cancelled() {
        let _ = std::fs::remove_file(&zip_path);
        return Err(DOWNLOAD_CANCELLED.into());
    }
    if downloaded < spec.min_bytes || first_byte == Some(b'<') {
        let _ = std::fs::remove_file(&zip_path);
        return Err("下载内容不是模型压缩包".into());
    }
    emit_job_progress(
        job,
        "extracting",
        downloaded,
        downloaded.max(1),
        format!("正在解压 {}…", job.name),
    );
    {
        let file = std::fs::File::open(&zip_path).map_err(|_| "无法读取压缩包".to_string())?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|_| "模型压缩包无效".to_string())?;
        for i in 0..archive.len() {
            if i % 8 == 0 {
                ensure_not_cancelled()?;
            }
            let mut file = archive
                .by_index(i)
                .map_err(|_| "模型压缩包无效".to_string())?;
            let name = file
                .enclosed_name()
                .ok_or_else(|| "模型压缩包路径无效".to_string())?
                .to_path_buf();
            let out = target.join(&name);
            if file.is_dir() {
                std::fs::create_dir_all(&out).map_err(|_| "无法创建语音模型目录".to_string())?;
                continue;
            }
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|_| "无法创建语音模型目录".to_string())?;
            }
            let mut outfile =
                std::fs::File::create(&out).map_err(|_| "无法写入配置目录".to_string())?;
            std::io::copy(&mut file, &mut outfile).map_err(|_| "无法写入配置目录".to_string())?;
        }
    }
    let _ = std::fs::remove_file(&zip_path);
    ensure_not_cancelled()?;
    flatten_extracted(target, &spec.markers)?;
    if !markers_ready(target, &spec.markers) {
        return Err("解压后仍缺少模型文件".into());
    }
    emit_job_progress(
        job,
        "ready",
        downloaded,
        downloaded.max(1),
        format!("已就绪：{}", job.name),
    );
    Ok(())
}

fn copy_qwenctc_assets(app: &tauri::AppHandle, dir: &Path) -> Result<(), String> {
    let asset_root = {
        if let Ok(resource) = app.path().resource_dir() {
            let bundled = resource.join("speech").join("assets").join("qwenctc");
            if bundled.is_dir() {
                Some(bundled)
            } else {
                None
            }
        } else {
            None
        }
    }
    .or_else(|| {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("speech")
            .join("assets")
            .join("qwenctc");
        dev.is_dir().then_some(dev)
    });
    let Some(assets) = asset_root else {
        return Ok(());
    };
    for name in ["tokens.txt", "preprocessor_config.json", "config.json"] {
        let src = assets.join(name);
        let dest = dir.join(name);
        if src.is_file() && !dest.is_file() {
            std::fs::copy(&src, &dest).map_err(|_| "无法写入配置目录".to_string())?;
        }
    }
    Ok(())
}

/// Inspect or download speech assets into AppData/my-workbench/models/<engine>.
#[tauri::command]
pub async fn speech_ensure_models(
    app: tauri::AppHandle,
    engine: Option<String>,
    files: Option<Vec<SpeechFileSpec>>,
    archives: Option<Vec<SpeechArchiveSpec>>,
    proxy: Option<String>,
) -> Result<SpeechEnsureResult, String> {
    let config = parse_engine_config(engine.as_deref())?;
    let dir = engine_model_dir(&app, &config.engine)?;
    std::fs::create_dir_all(&dir).map_err(|_| "无法创建语音模型目录".to_string())?;

    if config.engine == "qwenctc" {
        copy_qwenctc_assets(&app, &dir)?;
    }

    let files = files.unwrap_or_default();
    let archives = archives.unwrap_or_default();
    if files.is_empty() && archives.is_empty() {
        let runtime = speech_runtime_root(&app).unwrap_or_default();
        let ready = match config.engine.as_str() {
            "funasr" => funasr_paths_ready(&dir, &runtime).is_ok(),
            "qwenctc" => qwenctc_paths_ready(&dir, &runtime).is_ok(),
            _ => resolved_paths(&dir).is_ok(),
        };
        return Ok(SpeechEnsureResult {
            dir: dir.display().to_string(),
            ready,
            error: if ready {
                None
            } else {
                Some("本地模型未就绪，请开始准备以下载".into())
            },
            phase: if ready {
                "ready".into()
            } else {
                "unprepared".into()
            },
        });
    }
    if files.len() > 16 || archives.len() > 4 {
        return Err("模型清单无效".into());
    }

    begin_download_session();
    let result = (async {
        let files_ready = files.iter().all(|spec| {
            normalize_rel(&spec.rel_path)
                .ok()
                .map(|rel| file_ready(&dir.join(Path::new(&rel)), spec.min_bytes, ""))
                .unwrap_or(false)
        });
        let archives_ready = archives.iter().all(|spec| {
            let target = if spec.rel_dir.trim().is_empty() {
                dir.clone()
            } else {
                dir.join(spec.rel_dir.trim())
            };
            markers_ready(&target, &spec.markers)
        });
        if files_ready && archives_ready {
            let runtime = speech_runtime_root(&app).unwrap_or_default();
            let ready = match config.engine.as_str() {
                "funasr" => funasr_paths_ready(&dir, &runtime).is_ok(),
                "qwenctc" => qwenctc_paths_ready(&dir, &runtime).is_ok(),
                _ => true,
            };
            return Ok(SpeechEnsureResult {
                dir: dir.display().to_string(),
                ready,
                error: if ready {
                    None
                } else {
                    Some("本地模型未就绪".into())
                },
                phase: if ready {
                    "ready".into()
                } else {
                    "unprepared".into()
                },
            });
        }
        if let Err(message) = ensure_not_cancelled() {
            emit_cancelled_progress(&app, &config.engine, files.len() + archives.len());
            return Ok(download_failed_result(&dir, message));
        }
        speech_ensure_models_download(
            &app,
            &config,
            &dir,
            files,
            archives,
            proxy.as_deref(),
        )
        .await
    })
    .await;
    end_download_session();
    result
}

fn download_failed_result(dir: &Path, message: String) -> SpeechEnsureResult {
    let cancelled = message == DOWNLOAD_CANCELLED;
    SpeechEnsureResult {
        dir: dir.display().to_string(),
        ready: false,
        error: Some(message),
        phase: if cancelled {
            "cancelled".into()
        } else {
            "failed".into()
        },
    }
}

async fn speech_ensure_models_download(
    app: &tauri::AppHandle,
    config: &EngineConfig,
    dir: &Path,
    files: Vec<SpeechFileSpec>,
    archives: Vec<SpeechArchiveSpec>,
    proxy: Option<&str>,
) -> Result<SpeechEnsureResult, String> {
    let client = build_download_client(proxy)?;
    let total_jobs = archives.len() + files.len();
    let mut job_index = 0usize;
    for spec in &archives {
        if let Err(message) = ensure_not_cancelled() {
            emit_cancelled_progress(app, &config.engine, total_jobs);
            return Ok(download_failed_result(dir, message));
        }
        job_index += 1;
        let job = DownloadJob {
            app,
            engine: &config.engine,
            name: &spec.name,
            index: job_index,
            count: total_jobs,
        };
        if let Err(message) = download_archive(&client, dir, spec, &job).await {
            if message == DOWNLOAD_CANCELLED {
                emit_cancelled_progress(app, &config.engine, total_jobs);
            }
            return Ok(download_failed_result(dir, message));
        }
    }
    for spec in &files {
        if let Err(message) = ensure_not_cancelled() {
            emit_cancelled_progress(app, &config.engine, total_jobs);
            return Ok(download_failed_result(dir, message));
        }
        job_index += 1;
        let job = DownloadJob {
            app,
            engine: &config.engine,
            name: &spec.name,
            index: job_index,
            count: total_jobs,
        };
        if spec.url.trim().is_empty() && spec.mirror_url.trim().is_empty() {
            let Ok(rel) = normalize_rel(&spec.rel_path) else {
                return Ok(download_failed_result(
                    dir,
                    format!("缺少模型文件：{}", spec.name),
                ));
            };
            if !file_ready(&dir.join(Path::new(&rel)), spec.min_bytes, "") {
                return Ok(download_failed_result(
                    dir,
                    format!(
                        "缺少模型文件：{}（请放到 {}，或检查下载地址）",
                        spec.name,
                        dir.display()
                    ),
                ));
            }
            emit_job_progress(&job, "ready", 1, 1, format!("已存在：{}", spec.name));
            continue;
        }
        if let Err(message) = download_one(&client, dir, spec, &job).await {
            if message == DOWNLOAD_CANCELLED {
                emit_cancelled_progress(app, &config.engine, total_jobs);
            }
            return Ok(download_failed_result(dir, message));
        }
    }
    if config.engine == "qwenctc" {
        copy_qwenctc_assets(app, dir)?;
    }
    let runtime = speech_runtime_root(app).unwrap_or_default();
    let ready_result = match config.engine.as_str() {
        "funasr" => funasr_paths_ready(dir, &runtime),
        "qwenctc" => qwenctc_paths_ready(dir, &runtime),
        _ => Ok(()),
    };
    match ready_result {
        Ok(()) => {
            emit_download_progress(
                app,
                SpeechDownloadProgress {
                    engine: config.engine.clone(),
                    name: String::new(),
                    phase: "done".into(),
                    current: 1,
                    total: 1,
                    percent: 100,
                    index: total_jobs.max(1),
                    count: total_jobs.max(1),
                    message: "模型已准备完成".into(),
                },
            );
            Ok(SpeechEnsureResult {
                dir: dir.display().to_string(),
                ready: true,
                error: None,
                phase: "ready".into(),
            })
        }
        Err(message) => Ok(download_failed_result(dir, message)),
    }
}

fn emit_cancelled_progress(app: &tauri::AppHandle, engine: &str, total_jobs: usize) {
    emit_download_progress(
        app,
        SpeechDownloadProgress {
            engine: engine.to_string(),
            name: String::new(),
            phase: "cancelled".into(),
            current: 0,
            total: 1,
            percent: 0,
            index: 0,
            count: total_jobs.max(1),
            message: DOWNLOAD_CANCELLED.into(),
        },
    );
}

/// Stop an in-flight speech model download.
#[tauri::command]
pub fn speech_cancel_download() -> bool {
    if DOWNLOAD_ACTIVE.load(Ordering::SeqCst) {
        let session = DOWNLOAD_SESSION_LOCAL.load(Ordering::SeqCst);
        DOWNLOAD_CANCEL_SESSION.store(session, Ordering::SeqCst);
        return true;
    }
    DOWNLOAD_PENDING_CANCEL.store(true, Ordering::SeqCst);
    true
}

/// Read current readiness without downloading.
#[tauri::command]
pub fn speech_status(
    app: tauri::AppHandle,
    engine: Option<String>,
) -> Result<SpeechStatus, String> {
    let config = parse_engine_config(engine.as_deref())?;
    let runtime = speech_runtime_root(&app).unwrap_or_default();
    if config.engine == "funasr" {
        let dir = engine_model_dir(&app, "funasr")?;
        return match funasr_paths_ready(&dir, &runtime) {
            Ok(()) => Ok(SpeechStatus {
                dir: dir.display().to_string(),
                ready: true,
                phase: "ready".into(),
                model: dir.display().to_string(),
                tokens: String::new(),
                vad: String::new(),
                message: "Fun-ASR-Nano-GGUF 本地资源已就绪，可热备识别进程。".into(),
            }),
            Err(message) => Ok(SpeechStatus {
                dir: dir.display().to_string(),
                ready: false,
                phase: "unprepared".into(),
                model: String::new(),
                tokens: String::new(),
                vad: String::new(),
                message,
            }),
        };
    }
    if config.engine == "qwenctc" {
        let dir = engine_model_dir(&app, "qwenctc")?;
        return match qwenctc_paths_ready(&dir, &runtime) {
            Ok(()) => Ok(SpeechStatus {
                dir: dir.display().to_string(),
                ready: true,
                phase: "ready".into(),
                model: dir.display().to_string(),
                tokens: String::new(),
                vad: String::new(),
                message: "QwenCTC 本地资源已就绪，可热备识别进程。".into(),
            }),
            Err(message) => Ok(SpeechStatus {
                dir: dir.display().to_string(),
                ready: false,
                phase: "unprepared".into(),
                model: String::new(),
                tokens: String::new(),
                vad: String::new(),
                message,
            }),
        };
    }

    let dir = model_dir(&app)?;
    match resolved_paths(&dir) {
        Ok((model, tokens, vad)) => Ok(SpeechStatus {
            dir: dir.display().to_string(),
            ready: true,
            phase: "ready".into(),
            model: model.display().to_string(),
            tokens: tokens.display().to_string(),
            vad: vad.display().to_string(),
            message: "本地资源已准备，识别引擎可热备。".into(),
        }),
        Err(_) => Ok(SpeechStatus {
            dir: dir.display().to_string(),
            ready: false,
            phase: "unprepared".into(),
            model: String::new(),
            tokens: String::new(),
            vad: String::new(),
            message: "首次使用需下载 SenseVoice 模型到本机模型目录。".into(),
        }),
    }
}

struct SpeechWorker {
    child: Child,
    port: u16,
    token: String,
    last_used: Instant,
    fingerprint: String,
}

fn worker_slot() -> &'static Mutex<Option<SpeechWorker>> {
    static SLOT: OnceLock<Mutex<Option<SpeechWorker>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn speech_token() -> String {
    let mut hasher = Sha256::new();
    hasher.update(uuid_like().as_bytes());
    hasher.update(format!("{:?}", Instant::now()).as_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hex_sha256(hasher.finalize().as_slice())
}

fn stop_worker(worker: &mut Option<SpeechWorker>) {
    if let Some(mut current) = worker.take() {
        let _ = current.child.kill();
        let _ = current.child.wait();
    }
}

fn worker_alive(child: &mut Child) -> bool {
    match child.try_wait() {
        Ok(None) => true,
        _ => false,
    }
}

fn collect_stderr(stderr: std::process::ChildStderr) -> std::sync::mpsc::Receiver<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut sink = String::new();
        let mut reader = BufReader::new(stderr);
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if sink.len() < 8 * 1024 {
                        sink.push_str(&String::from_utf8_lossy(&buf[..n]));
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send(sink);
    });
    rx
}

fn summarize_worker_stderr(stderr: &str) -> Option<String> {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        return None;
    }
    let line = trimmed
        .lines()
        .rev()
        .map(str::trim)
        .find(|item| !item.is_empty())
        .unwrap_or(trimmed);
    let compact = if line.chars().count() > 180 {
        format!("{}…", line.chars().take(180).collect::<String>())
    } else {
        line.to_string()
    };
    Some(compact)
}

fn with_worker_stderr(message: String, stderr_rx: Option<std::sync::mpsc::Receiver<String>>) -> String {
    let Some(rx) = stderr_rx else {
        return message;
    };
    let stderr = rx.recv_timeout(Duration::from_millis(400)).unwrap_or_default();
    match summarize_worker_stderr(&stderr) {
        Some(detail) if !message.contains(&detail) => format!("{message}：{detail}"),
        _ => message,
    }
}

fn wait_for_port(stdout: impl Read + Send + 'static) -> Result<u16, String> {
    let ready = std::thread::spawn(move || -> Result<u16, String> {
        let started = Instant::now();
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            if started.elapsed() > WORKER_START_TIMEOUT {
                return Err("语音模型加载超时".into());
            }
            line.clear();
            let read = reader
                .read_line(&mut line)
                .map_err(|_| "读取转写进程就绪信号失败".to_string())?;
            if read == 0 {
                return Err("转写进程在就绪前退出".into());
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let parsed: serde_json::Value = serde_json::from_str(trimmed)
                .map_err(|_| format!("转写进程就绪信号无效：{trimmed}"))?;
            let port = parsed
                .get("port")
                .and_then(|v| v.as_u64())
                .filter(|v| *v > 0 && *v <= u16::MAX as u64)
                .ok_or_else(|| "转写进程未返回端口".to_string())?;
            return Ok(port as u16);
        }
    });
    ready
        .join()
        .map_err(|_| "转写进程启动失败".to_string())?
}

fn finish_spawn(mut child: Child, token: String, fingerprint: String) -> Result<SpeechWorker, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "转写进程输出不可用".to_string())?;
    let stderr_rx = child.stderr.take().map(collect_stderr);

    let port = match wait_for_port(stdout) {
        Ok(port) => port,
        Err(message) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(with_worker_stderr(message, stderr_rx));
        }
    };

    if !worker_alive(&mut child) {
        return Err(with_worker_stderr(
            "转写进程在就绪后退出".into(),
            stderr_rx,
        ));
    }

    // Keep draining stderr in the background so the pipe never fills.
    if let Some(rx) = stderr_rx {
        std::thread::spawn(move || {
            let _ = rx.recv();
        });
    }

    Ok(SpeechWorker {
        child,
        port,
        token,
        last_used: Instant::now(),
        fingerprint,
    })
}

fn spawn_sensevoice_worker(app: &tauri::AppHandle, fingerprint: String) -> Result<SpeechWorker, String> {
    let dir = model_dir(app)?;
    let (model, tokens, vad) = resolved_paths(&dir)?;
    let script = sensevoice_worker_script(app)?;
    let node = find_node()?;
    let token = speech_token();
    let config = serde_json::json!({
        "model": model,
        "tokens": tokens,
        "vad": vad,
        "threads": 2,
        "maxAudioBytes": MAX_WAV_BYTES,
        "modulePaths": sherpa_module_paths(),
    });
    let child = Command::new(&node)
        .arg(&script)
        .arg(config.to_string())
        .env("WB_SPEECH_TOKEN", &token)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("转写进程启动失败：{err}"))?;
    finish_spawn(child, token, fingerprint)
}

fn spawn_funasr_worker(app: &tauri::AppHandle, config: &EngineConfig) -> Result<SpeechWorker, String> {
    let model = engine_model_dir(app, "funasr")?;
    let runtime = speech_runtime_root(app)?;
    funasr_paths_ready(&model, &runtime)?;
    let script = funasr_worker_script(app)?;
    let python = find_python()?;
    let token = speech_token();
    let fingerprint = config.fingerprint();
    let worker_config = serde_json::json!({
        "modelDir": model,
        "enginesRoot": runtime,
        "maxAudioBytes": MAX_WAV_BYTES,
    });
    let child = Command::new(&python)
        .arg(&script)
        .arg(worker_config.to_string())
        .env("WB_SPEECH_TOKEN", &token)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("FunASR 转写进程启动失败：{err}"))?;
    finish_spawn(child, token, fingerprint)
}

fn spawn_qwenctc_worker(app: &tauri::AppHandle, config: &EngineConfig) -> Result<SpeechWorker, String> {
    let model = engine_model_dir(app, "qwenctc")?;
    let runtime = speech_runtime_root(app)?;
    qwenctc_paths_ready(&model, &runtime)?;
    let script = qwenctc_worker_script(app)?;
    let python = find_python()?;
    let token = speech_token();
    let fingerprint = config.fingerprint();
    let worker_config = serde_json::json!({
        "modelDir": model,
        "codeRoot": runtime,
        "maxAudioBytes": MAX_WAV_BYTES,
    });
    let child = Command::new(&python)
        .arg(&script)
        .arg(worker_config.to_string())
        .env("WB_SPEECH_TOKEN", &token)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("KMP_DUPLICATE_LIB_OK", "TRUE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("QwenCTC 转写进程启动失败：{err}"))?;
    finish_spawn(child, token, fingerprint)
}

fn spawn_worker(app: &tauri::AppHandle, config: &EngineConfig) -> Result<SpeechWorker, String> {
    match config.engine.as_str() {
        "funasr" => spawn_funasr_worker(app, config),
        "qwenctc" => spawn_qwenctc_worker(app, config),
        _ => spawn_sensevoice_worker(app, config.fingerprint()),
    }
}

async fn ensure_worker(
    app: &tauri::AppHandle,
    config: &EngineConfig,
) -> Result<(u16, String), String> {
    let fingerprint = config.fingerprint();
    let mut guard = worker_slot().lock().await;
    if let Some(worker) = guard.as_mut() {
        let idle = worker.last_used.elapsed() >= Duration::from_millis(WORKER_IDLE_MS);
        let stale = worker.fingerprint != fingerprint;
        if idle || stale || !worker_alive(&mut worker.child) {
            stop_worker(&mut guard);
        }
    }
    if guard.is_none() {
        let app_handle = app.clone();
        let config = config.clone();
        let worker = tokio::task::spawn_blocking(move || spawn_worker(&app_handle, &config))
            .await
            .map_err(|_| "转写进程启动失败".to_string())??;
        *guard = Some(worker);
    }
    let worker = guard.as_mut().ok_or_else(|| "转写进程不可用".to_string())?;
    worker.last_used = Instant::now();
    Ok((worker.port, worker.token.clone()))
}

async fn post_transcribe(
    port: u16,
    token: &str,
    audio: &[u8],
    language: &str,
) -> Result<SpeechTranscript, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "无法连接转写进程".to_string())?;
    let url = format!("http://127.0.0.1:{port}/transcribe?language={language}");
    let response = client
        .post(url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .body(audio.to_vec())
        .send()
        .await
        .map_err(|err| format!("转写请求失败：{err}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|_| "转写结果无效".to_string())?;
    if !status.is_success() {
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        let message = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or(body.trim());
        return Err(if message.is_empty() {
            "语音转写失败".into()
        } else {
            message.to_string()
        });
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "转写结果无效".to_string())?;
    Ok(SpeechTranscript {
        text: parsed
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        audio_seconds: parsed
            .get("audioSeconds")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        inference_seconds: parsed
            .get("inferenceSeconds")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
    })
}

/// Preload the persistent speech worker so the first dictation skips cold start.
#[tauri::command]
pub async fn speech_warm(
    app: tauri::AppHandle,
    engine: Option<String>,
) -> Result<bool, String> {
    let config = parse_engine_config(engine.as_deref())?;
    let runtime = speech_runtime_root(&app)?;
    match config.engine.as_str() {
        "funasr" => {
            let dir = engine_model_dir(&app, "funasr")?;
            funasr_paths_ready(&dir, &runtime)?;
        }
        "qwenctc" => {
            let dir = engine_model_dir(&app, "qwenctc")?;
            qwenctc_paths_ready(&dir, &runtime)?;
        }
        _ => {
            let dir = model_dir(&app)?;
            resolved_paths(&dir)?;
        }
    }
    let _ = ensure_worker(&app, &config).await?;
    Ok(true)
}

/// Transcribe one canonical 16 kHz mono PCM16 WAV via the warm speech worker.
#[tauri::command]
pub async fn speech_transcribe(
    app: tauri::AppHandle,
    request: SpeechTranscribeRequest,
) -> Result<SpeechTranscript, String> {
    let language = request
        .language
        .as_deref()
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .unwrap_or("auto")
        .to_string();
    if !matches!(
        language.as_str(),
        "auto" | "zh" | "en" | "yue" | "ja" | "ko"
    ) {
        return Err("不支持的识别语言".into());
    }
    let config = parse_engine_config(request.engine.as_deref())?;
    let bytes = decode_base64(&request.audio_base64)?;
    if bytes.len() < 46 || bytes.len() > MAX_WAV_BYTES {
        return Err("录音数据无效".into());
    }

    // Serialize inference on one native recognizer (same as dsh).
    let fingerprint = config.fingerprint();
    let mut guard = worker_slot().lock().await;
    if let Some(worker) = guard.as_mut() {
        let idle = worker.last_used.elapsed() >= Duration::from_millis(WORKER_IDLE_MS);
        let stale = worker.fingerprint != fingerprint;
        if idle || stale || !worker_alive(&mut worker.child) {
            stop_worker(&mut guard);
        }
    }
    if guard.is_none() {
        let app_handle = app.clone();
        let config = config.clone();
        let worker = tokio::task::spawn_blocking(move || spawn_worker(&app_handle, &config))
            .await
            .map_err(|_| "转写进程启动失败".to_string())??;
        *guard = Some(worker);
    }
    let (port, token) = {
        let worker = guard.as_mut().ok_or_else(|| "转写进程不可用".to_string())?;
        worker.last_used = Instant::now();
        (worker.port, worker.token.clone())
    };

    match post_transcribe(port, &token, &bytes, &language).await {
        Ok(result) => {
            if let Some(worker) = guard.as_mut() {
                worker.last_used = Instant::now();
            }
            Ok(result)
        }
        Err(message) => {
            // Drop a broken worker so the next call cold-starts cleanly.
            if message.contains("转写请求失败") || message.contains("连接") {
                stop_worker(&mut guard);
            }
            Err(message)
        }
    }
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let trimmed = input.trim();
    base64::engine::general_purpose::STANDARD
        .decode(trimmed)
        .map_err(|_| "录音编码无效".to_string())
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}
