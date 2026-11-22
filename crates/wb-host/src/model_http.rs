use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

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

/// One OpenAI-style streaming delta from `/chat/completions`.
#[derive(Debug, Clone, Default)]
pub struct ChatStreamDelta {
    pub content: String,
    /// `(index, id?, name?, arguments_fragment)`
    pub tool_call_parts: Vec<(usize, Option<String>, Option<String>, String)>,
}

/// Stream chat completions (SSE). Calls `on_delta` for each content/tool fragment.
/// When `cancel` is set, the read loop exits with an error as soon as it flips true.
pub async fn chat_completions_stream(
    base_url: &str,
    api_key: Option<&str>,
    body: &Value,
    proxy: Option<&str>,
    mut on_delta: impl FnMut(ChatStreamDelta) + Send,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<Value> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let mut stream_body = body.clone();
    if let Some(obj) = stream_body.as_object_mut() {
        obj.insert("stream".into(), Value::Bool(true));
    }

    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(180));
    if let Some(proxy) = proxy.filter(|s| !s.is_empty()) {
        builder = builder.proxy(reqwest::Proxy::all(proxy).context("无效代理地址")?);
    }
    let client = builder.build()?;
    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream");
    if let Some(key) = api_key.filter(|s| !s.is_empty()) {
        request = request.header("Authorization", format!("Bearer {key}"));
    }
    if cancel.is_some_and(|c| c.load(std::sync::atomic::Ordering::Relaxed)) {
        anyhow::bail!("已取消");
    }
    let resp = request
        .body(stream_body.to_string())
        .send()
        .await
        .context("模型流式请求失败")?;
    let status = resp.status().as_u16();
    if status >= 400 {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("HTTP {status}: {body}");
    }

    use futures_util::StreamExt;
    let mut bytes = resp.bytes_stream();
    let mut buf = String::new();
    let mut content = String::new();
    // index -> (id, name, arguments)
    let mut tools: std::collections::BTreeMap<usize, (String, String, String)> =
        std::collections::BTreeMap::new();

    while let Some(chunk) = bytes.next().await {
        if cancel.is_some_and(|c| c.load(std::sync::atomic::Ordering::Relaxed)) {
            anyhow::bail!("已取消");
        }
        let chunk = chunk.context("读取流失败")?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let mut line = buf[..pos].to_string();
            buf.drain(..=pos);
            if line.ends_with('\r') {
                line.pop();
            }
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                continue;
            }
            let Ok(json) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            let Some(delta) = json.pointer("/choices/0/delta") else {
                continue;
            };
            let mut out = ChatStreamDelta::default();
            if let Some(piece) = delta.get("content").and_then(|v| v.as_str()) {
                if !piece.is_empty() {
                    content.push_str(piece);
                    out.content = piece.to_string();
                }
            }
            if let Some(arr) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                for item in arr {
                    let idx = item.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    let entry = tools
                        .entry(idx)
                        .or_insert_with(|| (String::new(), String::new(), String::new()));
                    if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                        entry.0 = id.to_string();
                    }
                    if let Some(name) = item.pointer("/function/name").and_then(|v| v.as_str()) {
                        entry.1.push_str(name);
                    }
                    let args = item
                        .pointer("/function/arguments")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if !args.is_empty() {
                        entry.2.push_str(args);
                    }
                    out.tool_call_parts.push((
                        idx,
                        (!entry.0.is_empty()).then(|| entry.0.clone()),
                        (!entry.1.is_empty()).then(|| entry.1.clone()),
                        args.to_string(),
                    ));
                }
            }
            if !out.content.is_empty() || !out.tool_call_parts.is_empty() {
                on_delta(out);
            }
        }
    }

    let tool_calls: Vec<Value> = tools
        .into_iter()
        .map(|(i, (id, name, arguments))| {
            json!({
                "id": if id.is_empty() { format!("call_{i}") } else { id },
                "type": "function",
                "function": { "name": name, "arguments": arguments }
            })
        })
        .collect();
    Ok(json!({
        "choices": [{
            "message": {
                "role": "assistant",
                "content": if content.is_empty() { Value::Null } else { Value::String(content) },
                "tool_calls": if tool_calls.is_empty() { Value::Null } else { Value::Array(tool_calls) }
            }
        }]
    }))
}
