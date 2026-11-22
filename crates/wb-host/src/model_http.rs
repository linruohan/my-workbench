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

/// 把供应商 Base URL 收成模型列表地址。
///
/// 配置里的 Base URL 有时带当前接口路径（`/chat/completions`、`/responses`、`/messages`）。
/// 列表请求去掉这段，再访问同一主机上的 `/models`。
pub fn provider_models_url(base_url: &str) -> Result<String> {
    let mut root = base_url.trim().trim_end_matches('/').to_string();
    if root.is_empty() {
        anyhow::bail!("Base URL 为空");
    }
    for suffix in ["/chat/completions", "/responses", "/messages", "/models"] {
        if let Some(stripped) = root.strip_suffix(suffix) {
            root = stripped.trim_end_matches('/').to_string();
            break;
        }
    }
    if root.is_empty() {
        anyhow::bail!("Base URL 为空");
    }
    Ok(format!("{root}/models"))
}

/// `GET {baseURL}/models`，兼容 OpenAI `data[].id` 与 Ollama `models[].name`。
///
/// `anthropic` 为真时用该供应商自己的 `x-api-key`，否则用它自己的 Bearer 密钥。
pub async fn list_provider_models(
    base_url: &str,
    api_key: Option<&str>,
    proxy: Option<&str>,
    anthropic: bool,
) -> Result<Vec<String>> {
    let url = provider_models_url(base_url)?;
    let mut headers = vec![("Accept".into(), "application/json".into())];
    if let Some(key) = api_key.map(str::trim).filter(|key| !key.is_empty()) {
        if anthropic {
            headers.push(("x-api-key".into(), key.to_string()));
            headers.push(("anthropic-version".into(), "2023-06-01".into()));
        } else {
            headers.push(("Authorization".into(), format!("Bearer {key}")));
        }
    }
    let resp = model_http(ModelHttpRequest {
        url,
        method: "GET".into(),
        headers,
        body: None,
        proxy: proxy.map(str::to_string),
    })
    .await?;
    if resp.status >= 400 {
        anyhow::bail!("HTTP {}: {}", resp.status, trim_error(&resp.body));
    }
    parse_model_ids(&resp.body)
}

fn trim_error(body: &str) -> String {
    let text = body.trim();
    let count = text.chars().count();
    if count <= 180 {
        return text.to_string();
    }
    let mut short = text.chars().take(180).collect::<String>();
    short.push('…');
    short
}

pub(crate) fn parse_model_ids(body: &str) -> Result<Vec<String>> {
    let value: Value = serde_json::from_str(body).context("模型列表不是 JSON")?;
    let mut ids = Vec::new();
    collect_model_ids(&value, &mut ids);
    if ids.is_empty() {
        anyhow::bail!("响应里没有模型 id");
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn collect_model_ids(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(id) => push_id(id, out),
        Value::Array(items) => {
            for item in items {
                push_model_item(item, out);
            }
        }
        Value::Object(map) => {
            for key in ["data", "models", "model"] {
                if let Some(child) = map.get(key) {
                    collect_model_ids(child, out);
                }
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn push_model_item(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(id) => push_id(id, out),
        Value::Object(map) => {
            for key in ["id", "name", "model"] {
                if let Some(id) = map.get(key).and_then(Value::as_str) {
                    push_id(id, out);
                    return;
                }
            }
        }
        _ => {}
    }
}

fn push_id(id: &str, out: &mut Vec<String>) {
    let id = id.trim();
    if !id.is_empty() {
        out.push(id.to_string());
    }
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

#[cfg(test)]
mod tests {
    use super::{parse_model_ids, provider_models_url};

    #[test]
    fn openai_list_uses_data_ids() {
        let ids = parse_model_ids(r#"{"data":[{"id":"gpt-4o"},{"id":"gpt-4o-mini"}]}"#).unwrap();
        assert_eq!(ids, vec!["gpt-4o".to_string(), "gpt-4o-mini".to_string()]);
    }

    #[test]
    fn ollama_list_uses_model_names() {
        let ids =
            parse_model_ids(r#"{"models":[{"name":"qwen2.5"},{"name":"llama3.2"}]}"#).unwrap();
        assert_eq!(ids, vec!["llama3.2".to_string(), "qwen2.5".to_string()]);
    }

    #[test]
    fn models_url_strips_the_current_api_path() {
        assert_eq!(
            provider_models_url("https://api.example.com/v1").unwrap(),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            provider_models_url("https://api.example.com/v1/chat/completions").unwrap(),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            provider_models_url("https://api.example.com/v1/responses/").unwrap(),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            provider_models_url("https://api.anthropic.com/v1/messages").unwrap(),
            "https://api.anthropic.com/v1/models"
        );
    }
}
