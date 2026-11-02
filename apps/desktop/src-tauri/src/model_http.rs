use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;

const MAX_BODY: usize = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelHttpResponse {
    pub status: u16,
    pub content_type: String,
    pub body: String,
}

/// Provider calls leave the webview so the page origin cannot block them.
#[tauri::command]
pub async fn model_http(
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    proxy: Option<String>,
) -> Result<ModelHttpResponse, String> {
    let method = method.trim().to_ascii_uppercase();
    if method != "GET" && method != "POST" {
        return Err("只允许 GET 或 POST".into());
    }
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "地址无效".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("只允许 http(s) 请求".into()),
    }
    let timeout = timeout_ms.unwrap_or(60_000).clamp(1_000, 180_000);
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(3));
    if let Some(proxy_url) = proxy.as_deref().map(str::trim).filter(|item| !item.is_empty()) {
        let proxy = reqwest::Proxy::all(proxy_url).map_err(|_| "代理地址无效".to_string())?;
        builder = builder.proxy(proxy);
    }
    let client = builder.build().map_err(|err| explain(&err))?;
    let mut request = client.request(
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "请求方法无效".to_string())?,
        parsed,
    );
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if lower == "host" || lower == "content-length" || lower == "connection" {
            continue;
        }
        request = request.header(name, value);
    }
    if let Some(payload) = body {
        request = request.body(payload);
    }
    let response = request.send().await.map_err(|err| explain(&err))?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = response.bytes().await.map_err(|err| explain(&err))?;
    if bytes.len() > MAX_BODY {
        return Err("响应过大".into());
    }
    Ok(ModelHttpResponse {
        status,
        content_type,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

fn explain(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        return "测试超时".into();
    }
    if err.is_connect() {
        return "无法连接到服务器".into();
    }
    let text = err.to_string();
    let text = if text.chars().count() > 180 {
        text.chars().take(180).collect()
    } else {
        text
    };
    format!("网络错误：{text}")
}
