use std::sync::Mutex;

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use url::Url;

const LABEL: &str = "web-session";

/// One automatic reload when dsh (and similar tools) answer a cross-site
/// navigation with "authentication required". The cookie is SameSite=Strict, so
/// the first load from this app does not send it; a reload started by the page
/// does.
const AUTH_RELOAD_SCRIPT: &str = r#"
(() => {
  const marker = "dsh web authentication required";
  const key = "wb-dsh-auth-reload";
  const run = () => {
    const text = (document.body && document.body.innerText) || "";
    if (!text.includes(marker)) {
      try { sessionStorage.removeItem(key); } catch (e) {}
      return;
    }
    let seen = "";
    try { seen = sessionStorage.getItem(key) || ""; } catch (e) { return; }
    if (seen === location.href) return;
    try { sessionStorage.setItem(key, location.href); } catch (e) { return; }
    location.reload();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
"#;

struct Session {
    /// Last URL the user asked to open. Redirects may change the webview URL.
    requested: String,
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
) -> Result<(), String> {
    #[cfg(not(desktop))]
    {
        let _ = (app, url, x, y, width, height);
        return Err("网页会话只在桌面端内嵌".into());
    }
    #[cfg(desktop)]
    {
        let parsed = parse_http_url(&url)?;
        let requested = parsed.as_str().to_string();
        let mut guard = session_lock();
        if let Some(webview) = app.get_webview(LABEL) {
            place(&webview, x, y, width, height)?;
            let same = guard
                .as_ref()
                .is_some_and(|session| session.requested == requested);
            if !same {
                webview.navigate(parsed).map_err(|err| err.to_string())?;
                *guard = Some(Session { requested });
            }
            return Ok(());
        }
        let window = app.get_window("main").ok_or("找不到主窗口")?;
        let builder = tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::External(parsed))
            .focused(false)
            .initialization_script(AUTH_RELOAD_SCRIPT);
        // add_child waits on the UI thread. This command is async so it is not
        // already on that thread (a sync command deadlocks WebView2 on Windows).
        window
            .add_child(
                builder,
                LogicalPosition::new(x, y),
                LogicalSize::new(width.max(1.0), height.max(1.0)),
            )
            .map_err(|err| err.to_string())?;
        *guard = Some(Session { requested });
        Ok(())
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
