use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelHttpRequest {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub proxy: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelHttpResponse {
    pub status: u16,
    pub body: String,
}

pub async fn model_http(req: ModelHttpRequest) -> Result<ModelHttpResponse> {
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(120));
    if let Some(proxy) = req.proxy.as_deref().filter(|s| !s.is_empty()) {
        builder = builder.proxy(reqwest::Proxy::all(proxy).context("无效代理地址")?);
    }
    let client = builder.build()?;
    let method = match req.method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => reqwest::Method::POST,
    };
    let mut request = client.request(method, &req.url);
    for (k, v) in &req.headers {
        request = request.header(k, v);
    }
    if let Some(body) = &req.body {
        request = request.body(body.clone());
    }
    let resp = request.send().await.context("模型请求失败")?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    Ok(ModelHttpResponse { status, body })
}

pub async fn chat_completions(
    base_url: &str,
    api_key: Option<&str>,
    body: &Value,
    proxy: Option<&str>,
) -> Result<Value> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let mut headers = vec![("Content-Type".into(), "application/json".into())];
    if let Some(key) = api_key.filter(|s| !s.is_empty()) {
        headers.push(("Authorization".into(), format!("Bearer {key}")));
    }
    let resp = model_http(ModelHttpRequest {
        url,
        method: "POST".into(),
        headers,
        body: Some(body.to_string()),
        proxy: proxy.map(|s| s.to_string()),
    })
    .await?;
    if resp.status >= 400 {
        anyhow::bail!("HTTP {}: {}", resp.status, resp.body);
    }
    Ok(serde_json::from_str(&resp.body).unwrap_or(Value::String(resp.body)))
}
