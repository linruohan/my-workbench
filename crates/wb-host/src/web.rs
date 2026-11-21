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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
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

/// Lightweight DuckDuckGo HTML search (no API key).
pub async fn web_search(
    query: &str,
    proxy: Option<&str>,
    limit: usize,
) -> Result<Vec<WebSearchHit>> {
    let q = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("q", query)
        .finish();
    let url = format!("https://html.duckduckgo.com/html/?{q}");
    let fetched = web_fetch(&url, proxy).await?;
    if fetched.status >= 400 {
        anyhow::bail!("web_search HTTP {}", fetched.status);
    }
    Ok(parse_ddg_html(&fetched.body, limit.clamp(1, 10)))
}

fn parse_ddg_html(html: &str, limit: usize) -> Vec<WebSearchHit> {
    let mut hits = Vec::new();
    let mut rest = html;
    while hits.len() < limit {
        let Some(anchor_at) = rest.find("result__a") else {
            break;
        };
        let slice = &rest[anchor_at..];
        let Some(href_at) = slice.find("href=\"") else {
            rest = &rest[anchor_at + 9..];
            continue;
        };
        let after_href = &slice[href_at + 6..];
        let Some(href_end) = after_href.find('"') else {
            break;
        };
        let mut href = after_href[..href_end].to_string();
        if let Some(uddg) = extract_uddg(&href) {
            href = uddg;
        }
        let Some(gt) = after_href[href_end..].find('>') else {
            rest = &rest[anchor_at + 9..];
            continue;
        };
        let title_start = href_end + gt + 1;
        let title_src = &after_href[title_start..];
        let Some(title_end) = title_src.find("</a>") else {
            rest = &rest[anchor_at + 9..];
            continue;
        };
        let title = strip_tags(&title_src[..title_end]).trim().to_string();
        let after_a = &title_src[title_end..];
        let snippet = after_a
            .find("result__snippet")
            .and_then(|i| {
                let s = &after_a[i..];
                let start = s.find('>')? + 1;
                let end = s.find("</")?;
                Some(strip_tags(&s[start..end]).trim().to_string())
            })
            .unwrap_or_default();
        if !title.is_empty() && !href.is_empty() {
            hits.push(WebSearchHit {
                title,
                url: href,
                snippet,
            });
        }
        rest = &rest[anchor_at + 9..];
    }
    hits
}

fn extract_uddg(href: &str) -> Option<String> {
    let idx = href.find("uddg=")?;
    let encoded = &href[idx + 5..];
    let end = encoded.find('&').unwrap_or(encoded.len());
    let raw = &encoded[..end];
    let pair = format!("uddg={raw}");
    url::form_urlencoded::parse(pair.as_bytes())
        .find(|(k, _)| k == "uddg")
        .map(|(_, v)| v.into_owned())
        .filter(|s| s.starts_with("http"))
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ddg_extracts_results() {
        let html = r#"
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example Title</a>
        <a class="result__snippet">Hello snippet</a>
        "#;
        let hits = parse_ddg_html(html, 5);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Example Title");
        assert!(hits[0].url.contains("example.com"));
    }
}
