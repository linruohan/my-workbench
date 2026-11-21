use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResult {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: String,
    pub truncated: bool,
}

const MAX_BODY: usize = 100_000;

/// HTTP GET with size cap for agent `web_fetch`.
pub async fn web_fetch(url: &str, proxy: Option<&str>) -> Result<WebFetchResult> {
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30));
    if let Some(proxy) = proxy.filter(|s| !s.is_empty()) {
        builder = builder.proxy(reqwest::Proxy::all(proxy).context("无效代理")?);
    }
    let client = builder.build()?;
    let resp = client
        .get(url)
        .header("User-Agent", "my-workbench-agent/0.1")
        .send()
        .await
        .context("web_fetch 请求失败")?;
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let bytes = resp.bytes().await.unwrap_or_default();
    let truncated = bytes.len() > MAX_BODY;
    let slice = if truncated {
        &bytes[..MAX_BODY]
    } else {
        &bytes
    };
    let body = String::from_utf8_lossy(slice).to_string();
    Ok(WebFetchResult {
        status,
        content_type,
        body,
        truncated,
    })
}
