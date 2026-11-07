use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::sync::Mutex;

const MAX_BYTES: u64 = 1_200 * 1024 * 1024;
const MAX_WAV_BYTES: usize = 4 * 1024 * 1024;
/** Keep the warmed recognizer around like dsh (5 minutes). */
const WORKER_IDLE_MS: u64 = 300_000;
const WORKER_START_TIMEOUT: Duration = Duration::from_secs(120);

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
}

fn model_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .data_dir()
        .map_err(|_| "无法定位配置目录".to_string())?;
    Ok(root.join("my-workbench").join("models").join("sensevoice"))
}

fn worker_script(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource) = app.path().resource_dir() {
        let bundled = resource.join("speech").join("transcribe.mjs");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("speech")
        .join("transcribe.mjs");
    if dev.is_file() {
        return Ok(dev);
    }
    Err("找不到语音转写脚本".into())
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

fn dsh_sensevoice_root() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let root = PathBuf::from(home)
        .join(".dsh")
        .join("speech-to-text")
        .join("sensevoice")
        .join("models");
    if root.is_dir() {
        Some(root)
    } else {
        None
    }
}

fn try_link_or_copy(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "无法创建语音模型目录".to_string())?;
    }
    if to.exists() {
        return Ok(());
    }
    match std::fs::hard_link(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(from, to).map_err(|_| "无法复制已有语音模型".to_string())?;
            Ok(())
        }
    }
}

fn adopt_dsh_cache(dir: &Path, files: &[SpeechFileSpec]) -> bool {
    let Some(dsh) = dsh_sensevoice_root() else {
        return false;
    };
    for spec in files {
        let Ok(rel) = normalize_rel(&spec.rel_path) else {
            return false;
        };
        let src = dsh.join(Path::new(&rel));
        let dest = dir.join(Path::new(&rel));
        if !src.is_file() {
            return false;
        }
        let Ok(meta) = std::fs::metadata(&src) else {
            return false;
        };
        if meta.len() < spec.min_bytes {
            return false;
        }
        if try_link_or_copy(&src, &dest).is_err() {
            return false;
        }
    }
    files.iter().all(|spec| {
        normalize_rel(&spec.rel_path)
            .ok()
            .map(|rel| file_ready(&dir.join(Path::new(&rel)), spec.min_bytes, ""))
            .unwrap_or(false)
    })
}

async fn download_one(
    client: &reqwest::Client,
    dir: &Path,
    spec: &SpeechFileSpec,
) -> Result<(), String> {
    let rel = normalize_rel(&spec.rel_path)?;
    if spec.min_bytes == 0 || spec.min_bytes > MAX_BYTES {
        return Err("模型文件大小无效".into());
    }
    let dest = dir.join(Path::new(&rel));
    if file_ready(&dest, spec.min_bytes, "") {
        return Ok(());
    }
    let urls = [spec.url.trim(), spec.mirror_url.trim()];
    let mut last_error = "下载失败".to_string();
    for url in urls {
        if url.is_empty() {
            continue;
        }
        match download_url(client, dir, &rel, url, spec).await {
            Ok(()) => return Ok(()),
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
) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "模型地址无效".to_string())?;
    if parsed.scheme() != "https" {
        return Err("模型地址无效".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if !allowed_host(host) {
        return Err("模型地址无效".into());
    }
    let response = client
        .get(parsed)
        .header(reqwest::header::USER_AGENT, "my-workbench")
        .send()
        .await
        .map_err(|err| explain(&err))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载失败：服务器返回 {}", status.as_u16()));
    }
    let bytes = response.bytes().await.map_err(|err| explain(&err))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("下载文件过大".into());
    }
    if (bytes.len() as u64) < spec.min_bytes || bytes.first() == Some(&b'<') {
        return Err("下载内容不是模型文件".into());
    }
    if !spec.sha256.is_empty() && hex_sha256(&bytes) != spec.sha256.to_ascii_lowercase() {
        return Err("模型校验失败".into());
    }
    let dest = dir.join(Path::new(rel));
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "无法创建语音模型目录".to_string())?;
    }
    let partial = dir.join(format!("{}.part", rel.replace('/', "__")));
    std::fs::write(&partial, &bytes).map_err(|_| "无法写入配置目录".to_string())?;
    if dest.exists() {
        let _ = std::fs::remove_file(&dest);
    }
    std::fs::rename(&partial, &dest).map_err(|_| "无法写入配置目录".to_string())?;
    Ok(())
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

/// Inspect or download SenseVoice assets into the app config directory.
#[tauri::command]
pub async fn speech_ensure_models(
    app: tauri::AppHandle,
    files: Vec<SpeechFileSpec>,
    proxy: Option<String>,
) -> Result<SpeechEnsureResult, String> {
    if files.is_empty() || files.len() > 8 {
        return Err("模型清单无效".into());
    }
    let dir = model_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|_| "无法创建语音模型目录".to_string())?;

    let already = files.iter().all(|spec| {
        normalize_rel(&spec.rel_path)
            .ok()
            .map(|rel| file_ready(&dir.join(Path::new(&rel)), spec.min_bytes, ""))
            .unwrap_or(false)
    });
    if already {
        return Ok(SpeechEnsureResult {
            dir: dir.display().to_string(),
            ready: true,
            error: None,
            phase: "ready".into(),
        });
    }

    if adopt_dsh_cache(&dir, &files) {
        return Ok(SpeechEnsureResult {
            dir: dir.display().to_string(),
            ready: true,
            error: None,
            phase: "ready".into(),
        });
    }

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
    if let Some(proxy_url) = proxy
        .as_deref()
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        let proxy = reqwest::Proxy::all(proxy_url).map_err(|_| "代理地址无效".to_string())?;
        builder = builder.proxy(proxy);
    }
    let client = builder.build().map_err(|_| "无法发起下载".to_string())?;
    for spec in &files {
        if let Err(message) = download_one(&client, &dir, spec).await {
            return Ok(SpeechEnsureResult {
                dir: dir.display().to_string(),
                ready: false,
                error: Some(message),
                phase: "failed".into(),
            });
        }
    }
    Ok(SpeechEnsureResult {
        dir: dir.display().to_string(),
        ready: true,
        error: None,
        phase: "ready".into(),
    })
}

/// Read current readiness without downloading.
#[tauri::command]
pub fn speech_status(app: tauri::AppHandle) -> Result<SpeechStatus, String> {
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
        Err(_) => {
            if dsh_sensevoice_root().is_some() {
                Ok(SpeechStatus {
                    dir: dir.display().to_string(),
                    ready: false,
                    phase: "standby".into(),
                    model: String::new(),
                    tokens: String::new(),
                    vad: String::new(),
                    message: "检测到 DSH 本地缓存，打开语音输入后可一键导入。".into(),
                })
            } else {
                Ok(SpeechStatus {
                    dir: dir.display().to_string(),
                    ready: false,
                    phase: "unprepared".into(),
                    model: String::new(),
                    tokens: String::new(),
                    vad: String::new(),
                    message: "首次使用需下载 SenseVoice 模型。".into(),
                })
            }
        }
    }
}

struct SpeechWorker {
    child: Child,
    port: u16,
    token: String,
    last_used: Instant,
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

fn spawn_worker(app: &tauri::AppHandle) -> Result<SpeechWorker, String> {
    let dir = model_dir(app)?;
    let (model, tokens, vad) = resolved_paths(&dir)?;
    let script = worker_script(app)?;
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
    let mut child = Command::new(&node)
        .arg(&script)
        .arg(config.to_string())
        .env("WB_SPEECH_TOKEN", &token)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("转写进程启动失败：{err}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "转写进程输出不可用".to_string())?;
    let stderr = child.stderr.take();
    if let Some(stderr) = stderr {
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
            let _ = sink;
        });
    }

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

    let port = match ready.join() {
        Ok(Ok(port)) => port,
        Ok(Err(message)) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(message);
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("转写进程启动失败".into());
        }
    };

    if !worker_alive(&mut child) {
        return Err("转写进程在就绪后退出".into());
    }

    Ok(SpeechWorker {
        child,
        port,
        token,
        last_used: Instant::now(),
    })
}

async fn ensure_worker(app: &tauri::AppHandle) -> Result<(u16, String), String> {
    let mut guard = worker_slot().lock().await;
    if let Some(worker) = guard.as_mut() {
        let idle = worker.last_used.elapsed() >= Duration::from_millis(WORKER_IDLE_MS);
        if idle || !worker_alive(&mut worker.child) {
            stop_worker(&mut guard);
        }
    }
    if guard.is_none() {
        let app_handle = app.clone();
        let worker = tokio::task::spawn_blocking(move || spawn_worker(&app_handle))
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

/// Preload the persistent SenseVoice worker so the first dictation skips cold start.
#[tauri::command]
pub async fn speech_warm(app: tauri::AppHandle) -> Result<bool, String> {
    let dir = model_dir(&app)?;
    resolved_paths(&dir)?;
    let _ = ensure_worker(&app).await?;
    Ok(true)
}

/// Transcribe one canonical 16 kHz mono PCM16 WAV via the warm SenseVoice worker.
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
    let bytes = decode_base64(&request.audio_base64)?;
    if bytes.len() < 46 || bytes.len() > MAX_WAV_BYTES {
        return Err("录音数据无效".into());
    }

    // Serialize inference on one native recognizer (same as dsh).
    let mut guard = worker_slot().lock().await;
    if let Some(worker) = guard.as_mut() {
        let idle = worker.last_used.elapsed() >= Duration::from_millis(WORKER_IDLE_MS);
        if idle || !worker_alive(&mut worker.child) {
            stop_worker(&mut guard);
        }
    }
    if guard.is_none() {
        let app_handle = app.clone();
        let worker = tokio::task::spawn_blocking(move || spawn_worker(&app_handle))
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
