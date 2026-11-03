use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

const MAX_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrFileSpec {
    pub name: String,
    pub url: String,
    pub min_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrEnsureResult {
    pub dir: String,
    pub ready: bool,
    pub error: Option<String>,
}

fn allowed_host(host: &str) -> bool {
    host == "modelscope.cn" || host == "www.modelscope.cn" || host.ends_with(".modelscope.cn")
}

fn safe_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    let ok = !name.is_empty()
        && name.len() <= 80
        && !name.starts_with('.')
        && (name.ends_with(".onnx") || name.ends_with(".txt"))
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-');
    if ok {
        Ok(name)
    } else {
        Err("模型文件名无效".into())
    }
}

fn model_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .data_dir()
        .map_err(|_| "无法定位配置目录".to_string())?;
    Ok(root.join("my-workbench").join("models").join("paddleocr"))
}

fn file_ready(path: &Path, min_bytes: u64) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() < min_bytes {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut byte = [0u8; 1];
    std::io::Read::read(&mut file, &mut byte).ok() == Some(1) && byte[0] != b'<'
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

async fn download_one(
    client: &reqwest::Client,
    dir: &Path,
    spec: &OcrFileSpec,
) -> Result<(), String> {
    let name = safe_name(&spec.name)?;
    if spec.min_bytes == 0 || spec.min_bytes > MAX_BYTES {
        return Err("模型文件大小无效".into());
    }
    let dest = dir.join(name);
    if file_ready(&dest, spec.min_bytes) {
        return Ok(());
    }
    let parsed = reqwest::Url::parse(spec.url.trim()).map_err(|_| "模型地址无效".to_string())?;
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
    if status.is_redirection() {
        return Err("模型地址无效".into());
    }
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
    let partial = dir.join(format!("{name}.part"));
    std::fs::write(&partial, &bytes).map_err(|_| "无法写入配置目录".to_string())?;
    if dest.exists() {
        let _ = std::fs::remove_file(&dest);
    }
    std::fs::rename(&partial, &dest).map_err(|_| "无法写入配置目录".to_string())?;
    Ok(())
}

/// Download missing PaddleOCR weights into the app config directory.
#[tauri::command]
pub async fn ocr_ensure_models(
    app: tauri::AppHandle,
    files: Vec<OcrFileSpec>,
    proxy: Option<String>,
) -> Result<OcrEnsureResult, String> {
    if files.is_empty() || files.len() > 8 {
        return Err("模型清单无效".into());
    }
    let dir = model_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|_| "无法创建识图模型目录".to_string())?;
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let host = attempt.url().host_str().unwrap_or("");
            if allowed_host(host) && attempt.previous().len() < 5 {
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
            return Ok(OcrEnsureResult {
                dir: dir.display().to_string(),
                ready: false,
                error: Some(message),
            });
        }
    }
    Ok(OcrEnsureResult {
        dir: dir.display().to_string(),
        ready: true,
        error: None,
    })
}

/// Read one model file already stored in the config directory.
#[tauri::command]
pub fn ocr_read_model(app: tauri::AppHandle, name: String) -> Result<tauri::ipc::Response, String> {
    let name = safe_name(&name)?;
    let path = model_dir(&app)?.join(name);
    let mut file = std::fs::File::open(&path).map_err(|_| "识图模型文件不存在".to_string())?;
    let meta = file
        .metadata()
        .map_err(|_| "识图模型文件不存在".to_string())?;
    if meta.len() > MAX_BYTES {
        return Err("识图模型文件过大".into());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|_| "识图模型文件无法读取".to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}
