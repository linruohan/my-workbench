use std::sync::Mutex;

use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use url::Url;

const LABEL: &str = "web-session";
const AUTH_MARKER: &str = "dsh web authentication required";
const AUTH_TITLE: &str = "wb-dsh-auth";

/// dsh answers an unauthenticated document with plain text. Replace that text
/// and flag the title so the shell can ask for the launch URL. A reload cannot
/// create the missing SameSite=Strict cookie.
const AUTH_NOTICE_SCRIPT: &str = r#"
(() => {
  const marker = "dsh web authentication required";
  const title = "wb-dsh-auth";
  const note = "需要用 dsh web 启动时打印的完整地址登录。";
  const run = () => {
    const text = (document.body && document.body.innerText) || "";
    if (!text.includes(marker)) return;
    document.title = title;
    if (document.body) document.body.textContent = note;
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
"#;

struct Session {
    /// Last URL the shell asked to open. Redirects may change the webview URL.
    requested: String,
    /// URL actually opened, with a spent launch token removed.
    opened: String,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn session_lock() -> std::sync::MutexGuard<'static, Option<Session>> {
    SESSION.lock().unwrap_or_else(|err| err.into_inner())
}

fn parse_http_url(raw: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw.trim()).map_err(|err| format!("网址无效：{err}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("只能打开 http(s) 网页".into());
    }
    Ok(parsed)
}

fn has_launch_token(url: &Url) -> bool {
    url.query_pairs().any(|(key, _)| key == "token")
}

/// Follow dsh's `Location: ./` without keeping the launch token in the address.
fn navigation_target(current: &Url, location: Option<&str>) -> Url {
    if let Some(location) = location {
        if let Ok(joined) = current.join(location) {
            return joined;
        }
    }
    let mut clean = current.clone();
    clean.set_query(None);
    clean
}

fn cookie_for_host(header: &str, host: &str) -> Result<cookie::Cookie<'static>, String> {
    let mut parsed = cookie::Cookie::parse(header)
        .map_err(|err| format!("登录 Cookie 无效：{err}"))?
        .into_owned();
    if parsed.domain().is_none() && !host.is_empty() {
        parsed.set_domain(host.to_owned());
    }
    if parsed.path().is_none() {
        parsed.set_path("/");
    }
    Ok(parsed)
}

struct LaunchLogin {
    url: Url,
    cookies: Vec<String>,
}

/// Exchange `?token=` outside the webview. dsh sets a SameSite=Strict cookie
/// and redirects; an embedded navigation does not keep that cookie, so the
/// shell stores it before opening the clean URL.
async fn exchange_launch_token(url: &Url) -> Result<LaunchLogin, String> {
    if !has_launch_token(url) {
        return Ok(LaunchLogin {
            url: url.clone(),
            cookies: Vec::new(),
        });
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|err| err.to_string())?;
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|err| format!("无法完成网页登录：{err}"))?;
    let cookies: Vec<String> = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_string))
        .collect();
    if !cookies.is_empty() {
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok());
        return Ok(LaunchLogin {
            url: navigation_target(url, location),
            cookies,
        });
    }
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        let body = response.text().await.unwrap_or_default();
        if body.contains(AUTH_MARKER) {
            return Err("登录地址已失效，请重新运行 dsh web，再粘贴新打印的地址。".into());
        }
    }
    Ok(LaunchLogin {
        url: url.clone(),
        cookies: Vec::new(),
    })
}

fn plant(webview: &tauri::Webview, cookies: &[String], host: &str) -> Result<(), String> {
    for header in cookies {
        let baked = cookie_for_host(header, host)?;
        webview
            .set_cookie(baked)
            .map_err(|err| format!("无法保存登录状态：{err}"))?;
    }
    Ok(())
}

fn place(webview: &tauri::Webview, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|err| err.to_string())?;
    webview
        .set_size(LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|err| err.to_string())?;
    webview.show().map_err(|err| err.to_string())
}

/// Show the embedded page over the right-hand pane. Reuses one child webview.
#[tauri::command]
pub async fn web_session_show(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    #[cfg(not(desktop))]
    {
        let _ = (app, url, x, y, width, height);
        return Err("网页会话只在桌面端内嵌".into());
    }
    #[cfg(desktop)]
    {
        let parsed = parse_http_url(&url)?;
        let requested = parsed.as_str().to_string();
        let reused = session_lock()
            .as_ref()
            .filter(|session| session.requested == requested)
            .map(|session| session.opened.clone());
        if let Some(opened) = reused {
            if let Some(webview) = app.get_webview(LABEL) {
                place(&webview, x, y, width, height)?;
            }
            return Ok(opened);
        }
        let login = exchange_launch_token(&parsed).await?;
        let opened = login.url.as_str().to_string();
        let host = parsed.host_str().unwrap_or("").to_string();
        let mut guard = session_lock();
        if let Some(main) = app.get_webview("main") {
            plant(&main, &login.cookies, &host)?;
        }
        if let Some(webview) = app.get_webview(LABEL) {
            plant(&webview, &login.cookies, &host)?;
            place(&webview, x, y, width, height)?;
            let same = guard
                .as_ref()
                .is_some_and(|session| session.requested == requested);
            if !same {
                webview.navigate(login.url).map_err(|err| err.to_string())?;
                *guard = Some(Session {
                    requested,
                    opened: opened.clone(),
                });
            }
            return Ok(guard
                .as_ref()
                .map(|session| session.opened.clone())
                .unwrap_or(opened));
        }
        let window = app.get_window("main").ok_or("找不到主窗口")?;
        let notify = app.clone();
        let builder = tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::External(login.url))
            .focused(false)
            .initialization_script(AUTH_NOTICE_SCRIPT)
            .on_document_title_changed(move |_webview, title| {
                if title == AUTH_TITLE {
                    let _ = notify.emit("web-session-auth", ());
                }
            });
        // add_child waits on the UI thread. This command is async so it is not
        // already on that thread (a sync command deadlocks WebView2 on Windows).
        let child = window
            .add_child(
                builder,
                LogicalPosition::new(x, y),
                LogicalSize::new(width.max(1.0), height.max(1.0)),
            )
            .map_err(|err| err.to_string())?;
        plant(&child, &login.cookies, &host)?;
        *guard = Some(Session {
            requested,
            opened: opened.clone(),
        });
        Ok(opened)
    }
}

#[tauri::command]
pub async fn web_session_reload(app: AppHandle) -> Result<(), String> {
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    webview.reload().map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn web_session_hide(app: AppHandle) -> Result<(), String> {
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    webview.hide().map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn web_session_close(app: AppHandle) -> Result<(), String> {
    *session_lock() = None;
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    webview.close().map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::{cookie_for_host, navigation_target};
    use url::Url;

    #[test]
    fn launch_redirect_drops_the_token() {
        let current = Url::parse("http://127.0.0.1:3080/?token=secret").unwrap();
        let next = navigation_target(&current, Some("./"));
        assert_eq!(next.as_str(), "http://127.0.0.1:3080/");
        assert!(next.query().is_none());
    }

    #[test]
    fn planted_cookie_keeps_strict_and_host() {
        let header = "dsh-auth-abc=v1.body.sig; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict";
        let cookie = cookie_for_host(header, "127.0.0.1").unwrap();
        assert_eq!(cookie.name(), "dsh-auth-abc");
        assert_eq!(cookie.domain(), Some("127.0.0.1"));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.same_site(), Some(cookie::SameSite::Strict));
    }
}
