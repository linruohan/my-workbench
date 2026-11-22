//! Minimal MCP clients: stdio (Content-Length / newline JSON) and HTTP (JSON-RPC POST).

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Connect to an HTTP MCP endpoint (Streamable HTTP / JSON-RPC POST), initialize, then list or call.
pub fn mcp_http_call(
    url: &str,
    tool: Option<&str>,
    arguments: &Value,
    timeout: Duration,
) -> Result<String> {
    let url = url.trim();
    if url.is_empty() {
        bail!("MCP url 为空");
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .context("创建 HTTP 客户端失败")?;

    let mut session = String::new();
    let init = http_rpc(
        &client,
        url,
        &mut session,
        1,
        "initialize",
        json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "my-workbench", "version": "0.1.15" }
        }),
    )?;
    if let Some(err) = init.get("error") {
        bail!("MCP initialize 失败：{err}");
    }
    let _ = http_notify(
        &client,
        url,
        &session,
        "notifications/initialized",
        json!({}),
    );

    let (id, method, params) = if let Some(name) = tool.filter(|s| !s.is_empty()) {
        (
            2,
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
    } else {
        (2, "tools/list", json!({}))
    };
    let reply = http_rpc(&client, url, &mut session, id, method, params)?;
    if let Some(err) = reply.get("error") {
        bail!("MCP {method} 失败：{err}");
    }
    let body = reply.get("result").cloned().unwrap_or(reply);
    let text = serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string());
    Ok(truncate(&text, 12_000))
}

fn http_rpc(
    client: &reqwest::blocking::Client,
    url: &str,
    session: &mut String,
    id: i64,
    method: &str,
    params: Value,
) -> Result<Value> {
    let mut req = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }));
    if !session.is_empty() {
        req = req.header("Mcp-Session-Id", session.as_str());
    }
    let resp = req.send().context("MCP HTTP 请求失败")?;
    if let Some(sid) = resp.headers().get("mcp-session-id") {
        if let Ok(s) = sid.to_str() {
            if !s.is_empty() {
                *session = s.to_string();
            }
        }
    }
    let status = resp.status();
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let text = resp.text().context("读取 MCP HTTP 响应失败")?;
    if !status.is_success() {
        bail!("MCP HTTP {status}: {}", truncate(&text, 500));
    }
    parse_http_rpc_body(&text, &ctype, id)
}

fn http_notify(
    client: &reqwest::blocking::Client,
    url: &str,
    session: &str,
    method: &str,
    params: Value,
) -> Result<()> {
    let mut req = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }));
    if !session.is_empty() {
        req = req.header("Mcp-Session-Id", session);
    }
    let _ = req.send();
    Ok(())
}

fn parse_http_rpc_body(text: &str, content_type: &str, id: i64) -> Result<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        bail!("MCP HTTP 响应为空");
    }
    if content_type.contains("text/event-stream")
        || trimmed.starts_with("event:")
        || trimmed.contains("\ndata:")
    {
        let mut last: Option<Value> = None;
        for line in trimmed.lines() {
            let line = line.trim();
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                if v.get("id").and_then(|x| x.as_i64()) == Some(id) {
                    return Ok(v);
                }
                last = Some(v);
            }
        }
        if let Some(v) = last {
            return Ok(v);
        }
        bail!("MCP SSE 响应中未找到 id={id}");
    }
    let v: Value = serde_json::from_str(trimmed).context("解析 MCP JSON 失败")?;
    Ok(v)
}

/// Connect to a stdio MCP server, initialize, then list tools or call one.
pub fn mcp_stdio_call(
    command: &str,
    args: &[String],
    tool: Option<&str>,
    arguments: &Value,
    timeout: Duration,
) -> Result<String> {
    let command = command.trim();
    if command.is_empty() {
        bail!("MCP 服务器没有 command（HTTP 请走 mcp_http_call / 配置 url）");
    }
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("启动 MCP 失败：{command}"))?;
    let mut stdin = child.stdin.take().context("MCP stdin")?;
    let stdout = child.stdout.take().context("MCP stdout")?;
    let incoming = Arc::new(Mutex::new(Vec::<u8>::new()));
    let capture = incoming.clone();
    thread::spawn(move || {
        let mut stdout = stdout;
        let mut tmp = [0u8; 4096];
        loop {
            match stdout.read(&mut tmp) {
                Ok(0) | Err(_) => break,
                Ok(n) => capture.lock().unwrap().extend_from_slice(&tmp[..n]),
            }
        }
    });
    let deadline = Instant::now() + timeout;

    write_msg(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "my-workbench", "version": "0.1.15" }
            }
        }),
    )?;
    let init = read_until_id(&incoming, 1, deadline)?;
    if let Some(err) = init.get("error") {
        let _ = child.kill();
        bail!("MCP initialize 失败：{err}");
    }
    write_msg(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }),
    )?;

    let (id, method, params) = if let Some(name) = tool.filter(|s| !s.is_empty()) {
        (
            2,
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
    } else {
        (2, "tools/list", json!({}))
    };
    write_msg(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }),
    )?;
    let reply = match read_until_id(&incoming, id, deadline) {
        Ok(v) => v,
        Err(e) => {
            let _ = child.kill();
            return Err(e);
        }
    };
    let _ = child.kill();
    if let Some(err) = reply.get("error") {
        bail!("MCP {method} 失败：{err}");
    }
    let body = reply.get("result").cloned().unwrap_or(reply);
    let text = serde_json::to_string_pretty(&body).unwrap_or_else(|_| body.to_string());
    Ok(truncate(&text, 12_000))
}

fn write_msg(stdin: &mut impl Write, msg: &Value) -> Result<()> {
    let body = serde_json::to_vec(msg)?;
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len())?;
    stdin.write_all(&body)?;
    stdin.flush()?;
    Ok(())
}

fn read_until_id(incoming: &Mutex<Vec<u8>>, id: i64, deadline: Instant) -> Result<Value> {
    let mut buf = Vec::new();
    loop {
        if Instant::now() >= deadline {
            bail!("MCP 响应超时");
        }
        {
            let mut src = incoming.lock().unwrap();
            if !src.is_empty() {
                buf.append(&mut src);
            }
        }
        if let Some(msg) = pull_message(&mut buf)? {
            if msg.get("id").and_then(|v| v.as_i64()) == Some(id) {
                return Ok(msg);
            }
            continue;
        }
        thread::sleep(Duration::from_millis(30));
    }
}

pub(crate) fn pull_message(buf: &mut Vec<u8>) -> Result<Option<Value>> {
    if buf.is_empty() {
        return Ok(None);
    }
    if buf[0] == b'{' {
        if let Some(end) = buf.iter().position(|b| *b == b'\n') {
            let line = buf.drain(..=end).collect::<Vec<_>>();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim();
            if line.is_empty() {
                return Ok(None);
            }
            return Ok(Some(serde_json::from_str(line)?));
        }
        return Ok(None);
    }
    let header_end = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .or_else(|| buf.windows(2).position(|w| w == b"\n\n"));
    let Some(header_end) = header_end else {
        return Ok(None);
    };
    let sep_len = if buf.get(header_end..header_end + 4) == Some(b"\r\n\r\n") {
        4
    } else {
        2
    };
    let header = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let len = header
        .lines()
        .find_map(|line| {
            let (k, v) = line.split_once(':')?;
            if k.trim().eq_ignore_ascii_case("content-length") {
                v.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .ok_or_else(|| anyhow::anyhow!("MCP 帧缺少 Content-Length"))?;
    let start = header_end + sep_len;
    if buf.len() < start + len {
        return Ok(None);
    }
    let body = buf[start..start + len].to_vec();
    buf.drain(..start + len);
    Ok(Some(serde_json::from_slice(&body)?))
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…[truncated]", &s[..max])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pulls_content_length_frame() {
        let body = br#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#;
        let mut buf = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        buf.extend_from_slice(body);
        let msg = pull_message(&mut buf).unwrap().unwrap();
        assert_eq!(msg["id"], 1);
        assert!(buf.is_empty());
    }

    #[test]
    fn pulls_newline_json() {
        let mut buf = b"{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}\n".to_vec();
        let msg = pull_message(&mut buf).unwrap().unwrap();
        assert_eq!(msg["id"], 2);
    }

    #[test]
    fn parses_json_and_sse_bodies() {
        let v = parse_http_rpc_body(
            r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#,
            "application/json",
            1,
        )
        .unwrap();
        assert_eq!(v["result"]["ok"], true);
        let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"n\":1}}\n\n";
        let v2 = parse_http_rpc_body(sse, "text/event-stream", 2).unwrap();
        assert_eq!(v2["result"]["n"], 1);
    }
}
