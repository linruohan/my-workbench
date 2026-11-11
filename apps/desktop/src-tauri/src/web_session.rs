use std::sync::Mutex;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use url::Url;

const LABEL: &str = "web-session";
const AUTH_MARKER: &str = "dsh web authentication required";
const AUTH_TITLE: &str = "wb-dsh-auth";
const EDIT_TITLE: &str = "wb-web-edit";
const FS_ON_TITLE: &str = "wb-web-fs-on";
const FS_OFF_TITLE: &str = "wb-web-fs-off";

/// The child webview is a native window over the pane, so the shell buttons
/// would sit underneath it. Draw the same controls inside the page, and flag
/// the title when the user wants to change the link. A reload cannot create
/// dsh's missing SameSite=Strict cookie, so the auth page only asks for the
/// launch URL.
const PAGE_CHROME_SCRIPT: &str = r#"
(() => {
  const authMarker = "dsh web authentication required";
  const authTitle = "wb-dsh-auth";
  const editTitle = "wb-web-edit";
  const authNote = "需要用 dsh web 启动时打印的完整地址登录。";
  const fsOnTitle = "wb-web-fs-on";
  const fsOffTitle = "wb-web-fs-off";
  const buttonStyle = "width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.18);border-radius:8px;background:rgba(22,22,24,.88);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:pointer;padding:0;";
  const icon = (paths) => '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + "</svg>";
  const enterPaths = '<path d="M8 3H3v5"/><path d="M16 3h5v5"/><path d="M8 21H3v-5"/><path d="M16 21h5v-5"/>';
  const exitPaths = '<path d="M8 3v5H3"/><path d="M16 3v5h5"/><path d="M8 21v-5H3"/><path d="M16 21v-5h5"/>';
  let fullOn = false;
  let fullButton = null;
  const paintFull = () => {
    if (!fullButton) return;
    fullButton.innerHTML = icon(fullOn ? exitPaths : enterPaths);
    fullButton.title = fullOn ? "退出全屏" : "全屏";
    fullButton.setAttribute("aria-label", fullButton.title);
    fullButton.setAttribute("aria-pressed", fullOn ? "true" : "false");
  };
  window.__wbSetFullscreen = (on) => {
    fullOn = !!on;
    paintFull();
  };
  const signalFull = (on) => {
    const prev = document.title;
    document.title = on ? fsOnTitle : fsOffTitle;
    setTimeout(() => {
      if (document.title !== fsOnTitle && document.title !== fsOffTitle) return;
      document.title = prev === authTitle || prev === editTitle || prev === fsOnTitle || prev === fsOffTitle ? "" : prev;
    }, 30);
  };
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !fullOn) return;
    event.preventDefault();
    window.__wbSetFullscreen(false);
    signalFull(false);
  }, true);

  const installTools = () => {
    if (document.getElementById("wb-web-tools")) return;
    const root = document.body || document.documentElement;
    if (!root) return;
    const bar = document.createElement("div");
    bar.id = "wb-web-tools";
    bar.style.cssText = "position:fixed;top:8px;right:8px;z-index:2147483647;display:flex;gap:4px;";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.title = "刷新";
    refresh.setAttribute("aria-label", "刷新网页");
    refresh.style.cssText = buttonStyle;
    refresh.innerHTML = icon('<path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/>');
    refresh.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      location.reload();
    });
    const edit = document.createElement("button");
    edit.type = "button";
    edit.title = "修改链接";
    edit.setAttribute("aria-label", "修改链接");
    edit.style.cssText = buttonStyle;
    edit.innerHTML = icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>');
    edit.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const prev = document.title;
      document.title = editTitle;
      setTimeout(() => {
        if (document.title !== editTitle) return;
        document.title = prev === editTitle || prev === authTitle ? "" : prev;
      }, 30);
    });
    const full = document.createElement("button");
    full.type = "button";
    full.style.cssText = buttonStyle;
    fullButton = full;
    paintFull();
    full.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.__wbSetFullscreen(!fullOn);
      signalFull(fullOn);
    });
    bar.append(refresh, edit, full);
    root.appendChild(bar);
  };

  const showAuth = () => {
    const text = (document.body && document.body.innerText) || "";
    if (!text.includes(authMarker)) return;
    document.title = authTitle;
    if (document.body) document.body.textContent = authNote;
  };

  const boot = () => {
    showAuth();
    installTools();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  const root = document.documentElement;
  if (root && window.MutationObserver) {
    new MutationObserver(() => {
      if (!document.getElementById("wb-web-tools")) installTools();
    }).observe(root, { childList: true, subtree: true });
  }
})();
"#;

struct Session {
    /// Last URL the shell asked to open. Redirects may change the webview URL.
    requested: String,
    /// URL actually opened, with a spent launch token removed.
    opened: String,
    /// Last fullscreen flag painted into the page button.
    fullscreen: bool,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
/// Default font-family for pages that do not set their own. Empty = browser default.
static WEB_DEFAULT_FONT: Mutex<String> = Mutex::new(String::new());

fn sanitize_font_family(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 80 {
        return String::new();
    }
    if trimmed.chars().any(|c| {
        matches!(
            c,
            '"' | '\'' | ';' | '{' | '}' | '<' | '>' | '\\' | '\n' | '\r' | '\0'
        )
    }) {
        return String::new();
    }
    trimmed.to_string()
}

fn web_default_font() -> String {
    WEB_DEFAULT_FONT
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .clone()
}

fn eval_default_font(webview: &tauri::Webview, font: &str) {
    let font_js = serde_json::to_string(font).unwrap_or_else(|_| "\"\"".into());
    let script = format!(
        r#"(function(){{
  var font = {font_js};
  var id = "wb-default-font";
  var s = document.getElementById(id);
  if (!font) {{
    if (s) s.remove();
    return;
  }}
  if (!s) {{
    s = document.createElement("style");
    s.id = id;
    (document.documentElement || document.head || document.body).appendChild(s);
  }}
  s.textContent = "html{{font-family:" + JSON.stringify(font) + ",sans-serif;}}";
}})()"#
    );
    let _ = webview.eval(script);
}

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
        // dsh omits Domain, so the cookie is host-only. IP addresses like
        // 127.0.0.1 cannot use a Domain attribute.
        let mut host_only = cookie_for_host(header, host)?;
        host_only.unset_domain();
        if webview.set_cookie(host_only).is_ok() {
            continue;
        }
        let named = cookie_for_host(header, host)?;
        webview
            .set_cookie(named)
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

fn eval_fullscreen(webview: &tauri::Webview, on: bool) {
    let flag = if on { "true" } else { "false" };
    let _ = webview.eval(format!(
        "window.__wbSetFullscreen&&window.__wbSetFullscreen({flag})"
    ));
}

/// Keep the in-page button matched to the shell. Skips the eval when unchanged.
fn sync_fullscreen(webview: &tauri::Webview, on: bool) {
    let mut guard = session_lock();
    let Some(session) = guard.as_mut() else {
        return;
    };
    if session.fullscreen == on {
        return;
    }
    session.fullscreen = on;
    drop(guard);
    eval_fullscreen(webview, on);
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
    fullscreen: Option<bool>,
) -> Result<String, String> {
    let fullscreen = fullscreen.unwrap_or(false);
    #[cfg(not(desktop))]
    {
        let _ = (app, url, x, y, width, height, fullscreen);
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
                sync_fullscreen(&webview, fullscreen);
                eval_default_font(&webview, &web_default_font());
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
                    fullscreen,
                });
                if fullscreen {
                    eval_fullscreen(&webview, true);
                }
            } else if guard.as_mut().is_some_and(|session| {
                if session.fullscreen == fullscreen {
                    return false;
                }
                session.fullscreen = fullscreen;
                true
            }) {
                eval_fullscreen(&webview, fullscreen);
            }
            eval_default_font(&webview, &web_default_font());
            return Ok(guard
                .as_ref()
                .map(|session| session.opened.clone())
                .unwrap_or(opened));
        }
        let window = app.get_window("main").ok_or("找不到主窗口")?;
        let notify = app.clone();
        let builder = tauri::webview::WebviewBuilder::new(LABEL, WebviewUrl::External(login.url))
            .focused(false)
            .initialization_script(PAGE_CHROME_SCRIPT)
            .on_page_load(|webview, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    eval_default_font(&webview, &web_default_font());
                }
            })
            .on_document_title_changed(move |_webview, title| {
                if title == AUTH_TITLE {
                    let _ = notify.emit("web-session-auth", ());
                } else if title == EDIT_TITLE {
                    let _ = notify.emit("web-session-edit", ());
                } else if title == FS_ON_TITLE {
                    let _ = notify.emit("web-session-fullscreen", true);
                } else if title == FS_OFF_TITLE {
                    let _ = notify.emit("web-session-fullscreen", false);
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
            fullscreen,
        });
        if fullscreen {
            eval_fullscreen(&child, true);
        }
        eval_default_font(&child, &web_default_font());
        Ok(opened)
    }
}

/// Update the default font used by the embedded webpage session.
#[tauri::command]
pub async fn web_session_set_default_font(app: AppHandle, font: String) -> Result<(), String> {
    let cleaned = sanitize_font_family(&font);
    {
        let mut guard = WEB_DEFAULT_FONT
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        *guard = cleaned.clone();
    }
    #[cfg(desktop)]
    if let Some(webview) = app.get_webview(LABEL) {
        eval_default_font(&webview, &cleaned);
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
    }
    Ok(())
}

#[tauri::command]
pub async fn web_session_reload(app: AppHandle) -> Result<(), String> {
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    webview.reload().map_err(|err| err.to_string())
}

/// 收起内嵌网页时把它挪到可视区外，而不是切换窗口显隐。
///
/// Windows + WebView2 在 `hide()` → `show()` 之后会丢失/错乱鼠标命中区域，
/// 导致整个主窗口的点击被吞掉（模型选择、按钮都点不动），所以这里只改位置，
/// 不碰可见性；恢复时 `place()` 会重新摆回原位并保持可见。
const HIDDEN_X: f64 = -32000.0;
const HIDDEN_Y: f64 = -32000.0;

#[tauri::command]
pub async fn web_session_hide(app: AppHandle) -> Result<(), String> {
    let Some(webview) = app.get_webview(LABEL) else {
        return Ok(());
    };
    webview
        .set_position(LogicalPosition::new(HIDDEN_X, HIDDEN_Y))
        .map_err(|err| err.to_string())
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
    use super::{
        cookie_for_host, exchange_launch_token, navigation_target, sanitize_font_family,
    };
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use url::Url;

    fn serve_once(response: &'static [u8]) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0_u8; 4096];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(response);
        });
        port
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn exchange_keeps_the_strict_cookie_and_drops_the_token() {
        let port = serve_once(
            b"HTTP/1.1 303 See Other\r\nLocation: ./\r\nSet-Cookie: dsh-auth-test=v1.body.sig; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let url = Url::parse(&format!("http://127.0.0.1:{port}/?token=launch")).unwrap();
        let login = match block_on(exchange_launch_token(&url)) {
            Ok(login) => login,
            Err(err) => panic!("launch exchange failed: {err}"),
        };
        assert_eq!(login.url.as_str(), format!("http://127.0.0.1:{port}/"));
        assert!(login.url.query().is_none());
        assert_eq!(login.cookies.len(), 1);
        assert!(login.cookies[0].contains("SameSite=Strict"));
        assert!(login.cookies[0].contains("HttpOnly"));
    }

    #[test]
    fn exchange_rejects_a_spent_launch_token() {
        let port = serve_once(
            b"HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 68\r\nConnection: close\r\n\r\ndsh web authentication required; reopen the URL printed by dsh web.\n",
        );
        let url = Url::parse(&format!("http://127.0.0.1:{port}/?token=stale")).unwrap();
        let err = match block_on(exchange_launch_token(&url)) {
            Err(err) => err,
            Ok(_) => panic!("spent launch token should be rejected"),
        };
        assert!(err.contains("登录地址已失效"));
    }

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

    #[test]
    fn font_family_rejects_css_injection() {
        assert_eq!(sanitize_font_family("Microsoft YaHei"), "Microsoft YaHei");
        assert_eq!(sanitize_font_family("  Segoe UI  "), "Segoe UI");
        assert_eq!(sanitize_font_family(""), "");
        assert_eq!(sanitize_font_family("Evil\";}body{"), "");
        assert_eq!(sanitize_font_family("a'.b"), "");
    }
}
