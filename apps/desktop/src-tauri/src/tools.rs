use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};
use tauri::Emitter;

tokio::task_local! {
    static ASYNC_LOG: Sender<String>;
}

thread_local! {
    static INSTALL_LOG: RefCell<Option<Sender<String>>> = const { RefCell::new(None) };
}

struct LogGuard;

impl LogGuard {
    fn enter(tx: Sender<String>) -> Self {
        INSTALL_LOG.with(|slot| *slot.borrow_mut() = Some(tx));
        Self
    }
}

impl Drop for LogGuard {
    fn drop(&mut self) {
        INSTALL_LOG.with(|slot| *slot.borrow_mut() = None);
    }
}

fn log_sender() -> Option<Sender<String>> {
    let local = INSTALL_LOG.with(|slot| slot.borrow().clone());
    if local.is_some() {
        return local;
    }
    ASYNC_LOG.try_with(|tx| tx.clone()).ok()
}

fn install_log(text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(tx) = log_sender() {
        let _ = tx.send(text.to_string());
    }
}

fn push_install_log(log: &Option<Sender<String>>, bytes: &[u8]) {
    let Some(tx) = log else { return };
    if bytes.is_empty() {
        return;
    }
    let _ = tx.send(String::from_utf8_lossy(bytes).into_owned());
}

async fn logged_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let log = log_sender();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = log.map(LogGuard::enter);
        work()
    })
    .await
    .map_err(|err| format!("安装失败：{err}"))?
}

#[derive(Clone, Serialize)]
struct InstallLogEvent {
    id: String,
    text: String,
}

const MAX_ARCHIVE: usize = 450 * 1024 * 1024;
const MAX_EXTRACT: u64 = 1200 * 1024 * 1024;
const RUN_LIMIT: usize = 64 * 1024;

struct ToolDef {
    id: &'static str,
    kind: Kind,
}

#[derive(Clone, Copy)]
enum Kind {
    Binary {
        names: &'static [&'static str],
        version_args: &'static [&'static str],
        managed: &'static [&'static str],
        /// A server-style command may not print a version. Existence is enough.
        best_effort: bool,
        /// When set, every name must be found before the tool is ready.
        require_all: bool,
    },
    Python {
        module: &'static str,
    },
    /// Installed files or runtimes that the agent does not launch as a CLI.
    Marker {
        which: Marker,
    },
}

#[derive(Clone, Copy)]
enum Marker {
    Ocr,
    WebView,
    Cairo,
}

const fn binary(
    id: &'static str,
    names: &'static [&'static str],
    version_args: &'static [&'static str],
    managed: &'static [&'static str],
    require_all: bool,
) -> ToolDef {
    ToolDef {
        id,
        kind: Kind::Binary {
            names,
            version_args,
            managed,
            best_effort: version_args.is_empty(),
            require_all,
        },
    }
}

const fn marker(id: &'static str, which: Marker) -> ToolDef {
    ToolDef {
        id,
        kind: Kind::Marker { which },
    }
}

const TOOLS: &[ToolDef] = &[
    binary(
        "uv",
        &["uv", "uvx"],
        &["--version"],
        &["uv/uv.exe", "uv/uvx.exe"],
        true,
    ),
    binary(
        "node",
        &["node", "npm", "npx"],
        &["--version"],
        &[
            "node/node.exe",
            "node/npm.cmd",
            "node/npx.cmd",
            "node/bin/node",
            "node/bin/npm",
            "node/bin/npx",
        ],
        true,
    ),
    binary("git", &["git"], &["--version"], &[], false),
    binary(
        "ripgrep",
        &["rg"],
        &["--version"],
        &["ripgrep/rg.exe", "ripgrep/rg"],
        false,
    ),
    binary("chromium", &["chromium"], &["--version"], &[], false),
    binary(
        "playwright",
        &["playwright"],
        &["--version"],
        &[
            "playwright/node_modules/.bin/playwright.cmd",
            "playwright/node_modules/.bin/playwright",
        ],
        false,
    ),
    binary(
        "browser-mcp",
        &["playwright-mcp"],
        &[],
        &[
            "browser-mcp/node_modules/.bin/playwright-mcp.cmd",
            "browser-mcp/node_modules/.bin/playwright-mcp",
        ],
        false,
    ),
    binary(
        "poppler",
        &["pdftotext", "pdfinfo", "pdftoppm"],
        &["-v"],
        &[],
        true,
    ),
    marker("cairo", Marker::Cairo),
    binary(
        "mermaid",
        &["mmdc"],
        &["--version"],
        &[
            "mermaid/node_modules/.bin/mmdc.cmd",
            "mermaid/node_modules/.bin/mmdc",
        ],
        false,
    ),
    binary(
        "fontwasm",
        &["web-font-codecs-cli"],
        &[],
        &[
            "fontwasm/node_modules/.bin/web-font-codecs-cli.cmd",
            "fontwasm/node_modules/.bin/web-font-codecs-cli",
        ],
        false,
    ),
    marker("ocr", Marker::Ocr),
    binary(
        "inkscape",
        &["inkscape"],
        &["--version"],
        &["inkscape/bin/inkscape.com", "inkscape/bin/inkscape.exe"],
        false,
    ),
    binary(
        "ffmpeg",
        &["ffmpeg"],
        &["-version"],
        &[
            "ffmpeg/bin/ffmpeg.exe",
            "ffmpeg/ffmpeg.exe",
            "ffmpeg/bin/ffmpeg",
            "ffmpeg/ffmpeg",
        ],
        false,
    ),
    binary("openssh", &["ssh", "scp"], &["-V"], &[], true),
    binary("sshfs", &["sshfs"], &["-V"], &[], false),
    binary(
        "go",
        &["go"],
        &["version"],
        &["go/bin/go.exe", "go/bin/go"],
        false,
    ),
    binary("java", &["java", "mvn"], &["-version"], &[], true),
    binary("rust", &["rustc", "cargo"], &["--version"], &[], true),
    binary("ruby", &["ruby"], &["-v"], &[], false),
    binary("php", &["php"], &["-v"], &[], false),
    binary("dotnet", &["dotnet"], &["--version"], &[], false),
    marker("webview2", Marker::WebView),
    binary(
        "redis",
        &["redis-server", "redis-cli"],
        &["--version"],
        &[],
        true,
    ),
    binary("nsis", &["makensis"], &["/VERSION"], &[], false),
    binary("innosetup", &["iscc"], &["/?"], &[], false),
    binary(
        "readelf",
        &["readelf", "llvm-readelf"],
        &["--version"],
        &[],
        false,
    ),
    ToolDef {
        id: "matplotlib",
        kind: Kind::Python {
            module: "matplotlib",
        },
    },
    ToolDef {
        id: "plotly",
        kind: Kind::Python { module: "plotly" },
    },
    ToolDef {
        id: "altair",
        kind: Kind::Python { module: "altair" },
    },
    ToolDef {
        id: "bokeh",
        kind: Kind::Python { module: "bokeh" },
    },
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeHit {
    id: String,
    status: String,
    source: String,
    path: String,
    version: String,
    invoke: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHit {
    ok: bool,
    code: i32,
    stdout: String,
    stderr: String,
    truncated: bool,
}

struct Resolved {
    path: PathBuf,
    version: String,
    source: &'static str,
    env: Vec<(String, String)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckHit {
    path: String,
    version: String,
}

#[tauri::command]
pub async fn tools_probe(
    app: tauri::AppHandle,
    paths: Option<HashMap<String, String>>,
) -> Result<Vec<ProbeHit>, String> {
    let tools = tools_root(&app)?;
    let paths = paths.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || probe_all(&tools, &paths))
        .await
        .map_err(|err| format!("检测失败：{err}"))?
}

#[tauri::command]
pub fn tools_pick_path(id: String) -> Option<String> {
    let tool = TOOLS.iter().find(|item| item.id == id.trim())?;
    let title = format!("选择 {}", tool.id);
    let picked = match tool.kind {
        Kind::Marker { which: Marker::Ocr } => {
            rfd::FileDialog::new().set_title(title).pick_folder()
        }
        _ => rfd::FileDialog::new().set_title(title).pick_file(),
    };
    picked.map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn tools_check(
    app: tauri::AppHandle,
    id: String,
    path: String,
) -> Result<CheckHit, String> {
    let tools = tools_root(&app)?;
    let id = id.trim().to_string();
    let path = path.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let tool = TOOLS.iter().find(|item| item.id == id).ok_or("未知工具")?;
        let resolved = check_user_path(tool, &path, &tools)?;
        Ok(CheckHit {
            path: resolved.path.display().to_string(),
            version: resolved.version,
        })
    })
    .await
    .map_err(|err| format!("检测失败：{err}"))?
}

#[tauri::command]
pub async fn tools_install(
    app: tauri::AppHandle,
    id: String,
    proxy: Option<String>,
) -> Result<(), String> {
    let tools = tools_root(&app)?;
    let proxy = proxy
        .as_deref()
        .map(str::trim)
        .filter(|item| !item.is_empty());
    let (tx, rx) = std::sync::mpsc::channel();
    let emit_id = id.trim().to_string();
    let app_emit = app.clone();
    std::thread::spawn(move || {
        while let Ok(text) = rx.recv() {
            let _ = app_emit.emit(
                "host-tool-install-log",
                InstallLogEvent {
                    id: emit_id.clone(),
                    text,
                },
            );
        }
    });
    ASYNC_LOG
        .scope(tx, async {
            install_log(&format!("开始安装 {}\n", id.trim()));
            match id.trim() {
                "uv" => install_uv(&tools, proxy).await,
                "node" => install_node(&tools, proxy).await,
                "git" => install_scoop(None, &["git"], proxy).await,
                "ripgrep" => install_ripgrep(&tools, proxy).await,
                "chromium" => install_scoop(Some("extras"), &["chromium"], proxy).await,
                "playwright" => install_playwright(&tools, proxy).await,
                "browser-mcp" => install_npm(&tools, "browser-mcp", "@playwright/mcp", proxy).await,
                "poppler" => install_scoop(None, &["poppler"], proxy).await,
                "cairo" => install_cairo(&tools, proxy).await,
                "mermaid" => install_mermaid(&tools, proxy).await,
                "fontwasm" => install_npm(&tools, "fontwasm", "web-font-codecs-cli", proxy).await,
                "ocr" => install_ocr(&tools, proxy).await,
                "inkscape" => install_scoop(Some("extras"), &["inkscape"], proxy).await,
                "ffmpeg" => install_ffmpeg(&tools, proxy).await,
                "openssh" => install_scoop(None, &["openssh"], proxy).await,
                "sshfs" => install_scoop(Some("nonportable"), &["sshfs-np"], proxy).await,
                "go" => install_go(&tools, proxy).await,
                "java" => install_java(proxy).await,
                "rust" => install_rust(proxy).await,
                "ruby" => install_scoop(None, &["ruby"], proxy).await,
                "php" => install_scoop(None, &["php"], proxy).await,
                "dotnet" => install_scoop(None, &["dotnet-sdk"], proxy).await,
                "webview2" => install_webview2(proxy).await,
                "redis" => install_scoop(None, &["redis"], proxy).await,
                "nsis" => install_scoop(Some("extras"), &["nsis"], proxy).await,
                "innosetup" => install_scoop(Some("extras"), &["inno-setup"], proxy).await,
                "readelf" => install_scoop(None, &["llvm"], proxy).await,
                "matplotlib" | "plotly" | "altair" | "bokeh" => {
                    install_python_pkg(&tools, id.trim(), proxy).await
                }
                _ => Err("未知工具".into()),
            }
        })
        .await
}

#[tauri::command]
pub async fn tools_run(
    app: tauri::AppHandle,
    id: String,
    args: Vec<String>,
    cwd: Option<String>,
    bin: Option<String>,
    path: Option<String>,
) -> Result<RunHit, String> {
    if args.len() > 64
        || args
            .iter()
            .any(|arg| arg.contains('\0') || arg.len() > 32_000)
    {
        return Err("参数无效".into());
    }
    let tools = tools_root(&app)?;
    let id_owned = id.trim().to_string();
    let cwd_owned = cwd.unwrap_or_default();
    let bin_owned = bin.unwrap_or_default();
    let path_owned = path.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        run_tool(
            &tools,
            &id_owned,
            &args,
            &cwd_owned,
            &bin_owned,
            &path_owned,
        )
    })
    .await
    .map_err(|err| format!("运行失败：{err}"))?
}

fn tools_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let data = app
        .path()
        .data_dir()
        .map_err(|err| format!("无法定位数据目录：{err}"))?;
    let tools = data.join("my-workbench").join("tools");
    fs::create_dir_all(&tools).map_err(|err| format!("无法创建工具目录：{err}"))?;
    Ok(tools)
}

fn probe_all(tools: &Path, paths: &HashMap<String, String>) -> Result<Vec<ProbeHit>, String> {
    let mut hits = Vec::with_capacity(TOOLS.len());
    std::thread::scope(|scope| {
        let mut joins = Vec::new();
        for tool in TOOLS {
            let custom = paths.get(tool.id).map(String::as_str);
            joins.push(scope.spawn(move || probe_tool(tool, tools, custom)));
        }
        for join in joins {
            hits.push(join.join().unwrap_or_else(|_| missing("unknown")));
        }
    });
    Ok(hits)
}

fn probe_tool(tool: &ToolDef, tools: &Path, custom: Option<&str>) -> ProbeHit {
    if let Some(raw) = custom.map(str::trim).filter(|item| !item.is_empty()) {
        if let Ok(item) = check_user_path(tool, raw, tools) {
            return hit_from(tool, item);
        }
    }
    let resolved = match tool.kind {
        Kind::Binary {
            names,
            version_args,
            managed,
            best_effort,
            require_all,
        } => probe_binary(
            names,
            version_args,
            managed,
            best_effort,
            require_all,
            None,
            tools,
        ),
        Kind::Python { module } => probe_python(module, tools),
        Kind::Marker { which } => probe_marker(which, tools),
    };
    match resolved {
        Some(item) => hit_from(tool, item),
        None => missing(tool.id),
    }
}

fn hit_from(tool: &ToolDef, item: Resolved) -> ProbeHit {
    ProbeHit {
        id: tool.id.to_string(),
        status: "ready".into(),
        source: item.source.into(),
        path: item.path.display().to_string(),
        version: item.version,
        invoke: vec![item.path.display().to_string()],
    }
}

fn check_user_path(tool: &ToolDef, raw: &str, tools: &Path) -> Result<Resolved, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.contains('\0') || raw.len() > 1024 {
        return Err("请填写路径".into());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("请填写绝对路径".into());
    }
    match tool.kind {
        Kind::Binary {
            names,
            version_args,
            best_effort,
            ..
        } => {
            if !path.is_file() {
                return Err("找不到这个文件".into());
            }
            if !names.iter().any(|name| file_matches_name(&path, name)) {
                return Err(format!(
                    "这个文件不是 {} 的程序（{}）",
                    tool.id,
                    names.join("、")
                ));
            }
            let timeout = if path
                .file_name()
                .and_then(|item| item.to_str())
                .is_some_and(|name| name.to_ascii_lowercase().contains("inkscape"))
            {
                Duration::from_secs(25)
            } else {
                Duration::from_secs(12)
            };
            let version = confirm_binary(&path, version_args, best_effort, timeout)
                .ok_or("运行检测没有成功")?;
            Ok(Resolved {
                path,
                version,
                source: "manual",
                env: Vec::new(),
            })
        }
        Kind::Python { module } => {
            if !path.is_file() {
                return Err("找不到这个文件".into());
            }
            if !is_python_exe(&path) {
                return Err("请选择 Python 解释器".into());
            }
            let packages = tools.join("py-packages");
            if let Some(version) = import_version(&path, module, None) {
                return Ok(Resolved {
                    path,
                    version,
                    source: "manual",
                    env: Vec::new(),
                });
            }
            if packages.is_dir() {
                if let Some(version) = import_version(&path, module, Some(&packages)) {
                    return Ok(Resolved {
                        path,
                        version,
                        source: "manual",
                        env: vec![("PYTHONPATH".into(), python_path(&packages))],
                    });
                }
            }
            Err(format!("这个 Python 里没有 {module}"))
        }
        Kind::Marker { which } => check_marker_path(which, &path),
    }
}

fn is_python_exe(path: &Path) -> bool {
    file_matches_name(path, "python")
        || file_matches_name(path, "python3")
        || file_matches_name(path, "py")
}

fn check_marker_path(which: Marker, path: &Path) -> Result<Resolved, String> {
    match which {
        Marker::Cairo => {
            if path.is_file()
                && (file_matches_name(path, "cairo.dll")
                    || file_matches_name(path, "libcairo-2.dll"))
            {
                return Ok(Resolved {
                    path: path.to_path_buf(),
                    version: "已检测到".into(),
                    source: "manual",
                    env: Vec::new(),
                });
            }
            Err("请选择 cairo.dll 或 libcairo-2.dll".into())
        }
        Marker::WebView => {
            if path.is_file() && file_matches_name(path, "msedgewebview2") {
                let version = path
                    .parent()
                    .and_then(|dir| dir.file_name())
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "已检测到".into());
                return Ok(Resolved {
                    path: path.to_path_buf(),
                    version,
                    source: "manual",
                    env: Vec::new(),
                });
            }
            Err("请选择 msedgewebview2.exe".into())
        }
        Marker::Ocr => {
            if ocr_models_ready(path) {
                return Ok(Resolved {
                    path: path.to_path_buf(),
                    version: "PP-OCRv6 small".into(),
                    source: "manual",
                    env: Vec::new(),
                });
            }
            Err("这个目录里没有完整的 PP-OCRv6 small 模型".into())
        }
    }
}

fn custom_matches(tool: &ToolDef, raw: &str, bin: &str) -> bool {
    let file = Path::new(raw.trim());
    match tool.kind {
        Kind::Marker { .. } => bin.is_empty(),
        Kind::Python { .. } => (bin.is_empty() || bin == "python") && is_python_exe(file),
        Kind::Binary { names, .. } => {
            if bin.is_empty() {
                names.iter().any(|name| file_matches_name(file, name))
            } else {
                names.contains(&bin) && file_matches_name(file, bin)
            }
        }
    }
}

fn missing(id: &str) -> ProbeHit {
    ProbeHit {
        id: id.into(),
        status: "missing".into(),
        source: "none".into(),
        path: String::new(),
        version: String::new(),
        invoke: Vec::new(),
    }
}

fn probe_binary(
    names: &[&str],
    version_args: &[&str],
    managed: &[&str],
    best_effort: bool,
    require_all: bool,
    only: Option<&str>,
    tools: &Path,
) -> Option<Resolved> {
    let wanted: Vec<&str> = match only {
        Some(name) if names.contains(&name) => vec![name],
        Some(_) => return None,
        None if require_all => names.to_vec(),
        None => names.iter().copied().take(1).collect(),
    };
    if !require_all && only.is_none() {
        let found = names
            .iter()
            .find_map(|name| locate_name(name, version_args, managed, best_effort, tools))?;
        if tool_needs_browser(names) && !playwright_browser_ready() {
            return None;
        }
        return Some(found);
    }
    let mut found = Vec::new();
    for name in wanted {
        found.push(locate_name(
            name,
            version_args,
            managed,
            best_effort,
            tools,
        )?);
    }
    if tool_needs_browser(names) && !playwright_browser_ready() {
        return None;
    }
    found.into_iter().next()
}

fn tool_needs_browser(names: &[&str]) -> bool {
    names == ["playwright"]
}

fn locate_name(
    name: &str,
    version_args: &[&str],
    managed: &[&str],
    best_effort: bool,
    tools: &Path,
) -> Option<Resolved> {
    let timeout = if name.eq_ignore_ascii_case("inkscape") {
        Duration::from_secs(25)
    } else {
        Duration::from_secs(12)
    };
    for path in find_on_path(&[name], Some(tools))
        .into_iter()
        .chain(known_bins(&[name]))
    {
        if !path.is_file() {
            continue;
        }
        if let Some(version) = confirm_binary(&path, version_args, best_effort, timeout) {
            return Some(Resolved {
                path,
                version,
                source: "env",
                env: Vec::new(),
            });
        }
    }
    for rel in managed_for(name, managed) {
        let path = tools.join(rel);
        if !path.is_file() {
            continue;
        }
        if let Some(version) = confirm_binary(&path, version_args, best_effort, timeout) {
            return Some(Resolved {
                path,
                version,
                source: "managed",
                env: Vec::new(),
            });
        }
    }
    None
}

fn managed_for<'a>(name: &str, managed: &'a [&'a str]) -> Vec<&'a str> {
    managed
        .iter()
        .copied()
        .filter(|rel| file_matches_name(Path::new(rel), name))
        .collect()
}

fn file_matches_name(path: &Path, name: &str) -> bool {
    let Some(file) = path.file_name().and_then(|item| item.to_str()) else {
        return false;
    };
    let file = file.to_ascii_lowercase();
    let name = name.to_ascii_lowercase();
    file == name
        || file.strip_suffix(".exe").is_some_and(|stem| stem == name)
        || file.strip_suffix(".cmd").is_some_and(|stem| stem == name)
        || file.strip_suffix(".bat").is_some_and(|stem| stem == name)
}

fn confirm_binary(
    path: &Path,
    version_args: &[&str],
    best_effort: bool,
    timeout: Duration,
) -> Option<String> {
    if version_args.is_empty() {
        return Some("已检测到".into());
    }
    let args = version_args
        .iter()
        .map(|item| (*item).to_string())
        .collect::<Vec<_>>();
    match run_capture(path, &args, &[], None, timeout, 8_000) {
        Ok(output) => {
            let line = first_line(&output.stdout, &output.stderr);
            if output.code == 0 || !line.is_empty() {
                return Some(if line.is_empty() {
                    "已检测到".into()
                } else {
                    line
                });
            }
            best_effort.then(|| "已检测到".into())
        }
        Err(_) => best_effort.then(|| "已检测到".into()),
    }
}

fn probe_python(module: &str, tools: &Path) -> Option<Resolved> {
    let packages = tools.join("py-packages");
    let packages = packages.is_dir().then_some(packages);
    if let Some(python) = find_system_python(tools) {
        if let Some(version) = import_version(&python, module, None) {
            return Some(Resolved {
                path: python,
                version,
                source: "env",
                env: Vec::new(),
            });
        }
        if let Some(dir) = packages.as_ref() {
            if let Some(version) = import_version(&python, module, Some(dir)) {
                return Some(managed_python(python, version, dir));
            }
        }
    }
    if let Some(python) = managed_python_exe(tools) {
        if let Some(version) = import_version(&python, module, packages.as_deref()) {
            return Some(match &packages {
                Some(dir) => managed_python(python, version, dir),
                None => Resolved {
                    path: python,
                    version,
                    source: "managed",
                    env: Vec::new(),
                },
            });
        }
    }
    None
}

fn managed_python(python: PathBuf, version: String, packages: &Path) -> Resolved {
    Resolved {
        path: python,
        version,
        source: "managed",
        env: vec![("PYTHONPATH".into(), python_path(packages))],
    }
}

fn import_version(python: &Path, module: &str, packages: Option<&Path>) -> Option<String> {
    if !matches!(module, "matplotlib" | "plotly" | "altair" | "bokeh") {
        return None;
    }
    let code = format!("import {module} as mod\nprint(getattr(mod, '__version__', 'ok'))\n");
    let env = packages
        .map(|dir| vec![("PYTHONPATH".into(), python_path(dir))])
        .unwrap_or_default();
    let output = run_capture(
        python,
        &["-c".into(), code],
        &env,
        None,
        Duration::from_secs(30),
        4_000,
    )
    .ok()?;
    if output.code != 0 {
        return None;
    }
    let line = first_line(&output.stdout, "");
    if line.is_empty() { None } else { Some(line) }
}

fn python_path(packages: &Path) -> String {
    match std::env::var("PYTHONPATH") {
        Ok(current) if !current.trim().is_empty() => {
            format!("{}{}{}", packages.display(), path_sep(), current)
        }
        _ => packages.display().to_string(),
    }
}

fn path_sep() -> char {
    if cfg!(windows) { ';' } else { ':' }
}

fn find_system_python(tools: &Path) -> Option<PathBuf> {
    find_on_path(python_names(), Some(tools))
}

fn managed_python_exe(tools: &Path) -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        "python.exe"
    } else {
        "python"
    };
    let path = tools.join("python").join(exe);
    path.is_file().then_some(path)
}

fn python_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["py", "python"]
    } else {
        &["python3", "python"]
    }
}

fn find_on_path(names: &[&str], skip_under: Option<&Path>) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in names {
            for candidate in candidate_names(name) {
                let path = dir.join(&candidate);
                if !path.is_file() || is_store_alias(&path) {
                    continue;
                }
                if skip_under.is_some_and(|root| under_root(&path, root)) {
                    continue;
                }
                return Some(path);
            }
        }
    }
    None
}

fn candidate_names(name: &str) -> Vec<String> {
    if name.eq_ignore_ascii_case("inkscape") {
        return vec![
            "inkscape.com".into(),
            "inkscape.exe".into(),
            "inkscape".into(),
        ];
    }
    let mut out = vec![name.to_string()];
    #[cfg(windows)]
    {
        let lower = name.to_ascii_lowercase();
        for ext in ["exe", "cmd", "bat"] {
            if !lower.ends_with(&format!(".{ext}")) {
                out.push(format!("{name}.{ext}"));
            }
        }
    }
    out
}

fn is_store_alias(path: &Path) -> bool {
    path.to_string_lossy()
        .to_ascii_lowercase()
        .contains("windowsapps")
}

fn under_root(path: &Path, root: &Path) -> bool {
    let Ok(path) = fs::canonicalize(path) else {
        return false;
    };
    let Ok(root) = fs::canonicalize(root) else {
        return false;
    };
    path.starts_with(root)
}

fn run_tool(
    tools: &Path,
    id: &str,
    args: &[String],
    cwd: &str,
    bin: &str,
    user_path: &str,
) -> Result<RunHit, String> {
    let tool = TOOLS.iter().find(|item| item.id == id).ok_or("未知工具")?;
    let custom = user_path.trim();
    if let Kind::Marker { which } = tool.kind {
        let pref = if !custom.is_empty() && custom_matches(tool, custom, bin) {
            Some(check_user_path(tool, custom, tools)?)
        } else {
            None
        };
        return marker_hit(which, pref, tools);
    }
    if matches!(tool.kind, Kind::Python { .. }) && args.is_empty() {
        return Err("请传入 Python 参数，例如 [\"-c\", \"代码\"]".into());
    }
    let forced = if !custom.is_empty() && custom_matches(tool, custom, bin) {
        Some(check_user_path(tool, custom, tools)?)
    } else {
        None
    };
    let resolved = if let Some(item) = forced {
        item
    } else {
        match tool.kind {
            Kind::Binary {
                names,
                version_args,
                managed,
                best_effort,
                require_all,
            } => {
                let only = if bin.is_empty() { None } else { Some(bin) };
                if let Some(name) = only {
                    if !names.contains(&name) {
                        return Err(format!("{id} 没有程序 {name}"));
                    }
                }
                probe_binary(
                    names,
                    version_args,
                    managed,
                    best_effort,
                    require_all,
                    only,
                    tools,
                )
            }
            Kind::Python { module } => probe_python(module, tools),
            Kind::Marker { .. } => None,
        }
        .ok_or_else(|| format!("{id} 还不可用"))?
    };
    let workdir = if cwd.trim().is_empty() {
        None
    } else {
        let dir = PathBuf::from(cwd.trim());
        if !dir.is_absolute() || !dir.is_dir() {
            return Err("工作目录必须是已存在的绝对路径".into());
        }
        Some(dir)
    };
    let mut env = resolved.env;
    if matches!(tool.kind, Kind::Python { .. }) {
        env.push(("PYTHONIOENCODING".into(), "utf-8".into()));
        env.push(("PYTHONUTF8".into(), "1".into()));
    }
    let output = run_capture(
        &resolved.path,
        args,
        &env,
        workdir.as_deref(),
        Duration::from_secs(180),
        RUN_LIMIT,
    )?;
    Ok(RunHit {
        ok: output.code == 0,
        code: output.code,
        stdout: output.stdout,
        stderr: output.stderr,
        truncated: output.truncated,
    })
}

struct Captured {
    code: i32,
    stdout: String,
    stderr: String,
    truncated: bool,
}

fn run_capture(
    exe: &Path,
    args: &[String],
    env: &[(String, String)],
    cwd: Option<&Path>,
    timeout: Duration,
    limit: usize,
) -> Result<Captured, String> {
    let mut cmd = command(exe, args);
    for (key, value) in env {
        cmd.env(key, value);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    install_log(&format!("> {} {}\n", exe.display(), args.join(" ")));
    let log = log_sender();
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("无法启动 {}：{err}", exe.display()))?;
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let out_log = log.clone();
    let err_log = log;
    let out_thread = std::thread::spawn(move || match stdout_pipe {
        Some(pipe) => read_limited(pipe, limit, out_log),
        None => (String::new(), false),
    });
    let err_thread = std::thread::spawn(move || match stderr_pipe {
        Some(pipe) => read_limited(pipe, limit, err_log),
        None => (String::new(), false),
    });
    let code = wait_timeout(&mut child, timeout)?;
    let (stdout, out_trunc) = out_thread.join().unwrap_or_default();
    let (stderr, err_trunc) = err_thread.join().unwrap_or_default();
    Ok(Captured {
        code,
        stdout,
        stderr,
        truncated: out_trunc || err_trunc,
    })
}

fn read_limited<R: Read>(mut pipe: R, limit: usize, log: Option<Sender<String>>) -> (String, bool) {
    let mut buf = [0u8; 8192];
    let mut raw = Vec::new();
    let mut truncated = false;
    loop {
        let size = match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(size) => size,
            Err(_) => break,
        };
        if raw.len() >= limit {
            truncated = true;
            continue;
        }
        let room = limit - raw.len();
        let kept = if size > room {
            truncated = true;
            room
        } else {
            size
        };
        raw.extend_from_slice(&buf[..kept]);
        push_install_log(&log, &buf[..kept]);
    }
    (String::from_utf8_lossy(&raw).into_owned(), truncated)
}

fn wait_timeout(child: &mut Child, timeout: Duration) -> Result<i32, String> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.code().unwrap_or(1)),
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("执行超时".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(err) => return Err(format!("等待进程失败：{err}")),
        }
    }
}

fn command(exe: &Path, args: &[String]) -> Command {
    let text = exe.to_string_lossy().to_ascii_lowercase();
    let mut cmd = if cfg!(windows) && (text.ends_with(".cmd") || text.ends_with(".bat")) {
        let mut parts = Vec::with_capacity(args.len() + 1);
        parts.push(quote_win(&exe.to_string_lossy()));
        for arg in args {
            parts.push(quote_win(arg));
        }
        let mut cmd = Command::new("cmd");
        cmd.arg("/D").arg("/S").arg("/C").arg(parts.join(" "));
        cmd
    } else {
        let mut cmd = Command::new(exe);
        cmd.args(args);
        cmd
    };
    hide(&mut cmd);
    cmd
}

fn quote_win(arg: &str) -> String {
    let mut out = String::from("\"");
    for ch in arg.chars() {
        if ch == '"' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

fn hide(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

fn first_line(stdout: &str, stderr: &str) -> String {
    for text in [stdout, stderr] {
        for line in text.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                return trimmed.chars().take(200).collect();
            }
        }
    }
    String::new()
}

fn run_checked(
    exe: &Path,
    args: &[String],
    proxy: Option<&str>,
    cwd: Option<&Path>,
    timeout: Duration,
    label: &str,
) -> Result<(), String> {
    let mut env = Vec::new();
    if let Some(proxy) = proxy {
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
            env.push((key.into(), proxy.into()));
        }
        env.push(("npm_config_proxy".into(), proxy.into()));
        env.push(("npm_config_https_proxy".into(), proxy.into()));
    }
    let output = run_capture(exe, args, &env, cwd, timeout, 32_000)?;
    if output.code == 0 {
        return Ok(());
    }
    let detail = first_line(&output.stderr, &output.stdout);
    if detail.is_empty() {
        Err(format!("{label}（退出码 {}）", output.code))
    } else {
        Err(format!("{label}：{detail}"))
    }
}

async fn install_go(tools: &Path, proxy: Option<&str>) -> Result<(), String> {
    let (url, sha) = go_archive(proxy).await?;
    let bytes = download(&url, proxy, MAX_ARCHIVE).await?;
    if let Some(sha) = sha {
        verify_sha256(&bytes, &sha)?;
    }
    let dest = tools.join("go");
    extract_blocking(dest, bytes).await
}

async fn install_ripgrep(tools: &Path, proxy: Option<&str>) -> Result<(), String> {
    let bytes = ripgrep_bytes(proxy).await?;
    extract_blocking(tools.join("ripgrep"), bytes).await
}

fn known_bins(names: &[&str]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    for name in names {
        if let Some(home) = &home {
            for candidate in candidate_names(name) {
                out.push(home.join("scoop/shims").join(&candidate));
                out.push(home.join(".cargo/bin").join(&candidate));
            }
        }
        out.extend(special_bins(name));
    }
    out
}

fn special_bins(name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let program = std::env::var_os("ProgramFiles").map(PathBuf::from);
    let program_x86 = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from);
    match name {
        "inkscape" => {
            if let Some(program) = program {
                let root = program.join("Inkscape/bin");
                out.push(root.join("inkscape.com"));
                out.push(root.join("inkscape.exe"));
            }
        }
        "git" => {
            if let Some(program) = program {
                out.push(program.join("Git/cmd/git.exe"));
            }
        }
        "ssh" | "scp" => {
            out.push(PathBuf::from(r"C:\Windows\System32\OpenSSH").join(format!("{name}.exe")));
        }
        "sshfs" => {
            if let Some(program) = program {
                out.push(program.join("SSHFS-Win/bin/sshfs.exe"));
            }
        }
        "dotnet" => {
            if let Some(program) = program {
                out.push(program.join("dotnet/dotnet.exe"));
            }
        }
        "readelf" | "llvm-readelf" => {
            if let Some(program) = program.clone() {
                out.push(program.join("LLVM/bin").join(format!("{name}.exe")));
            }
            if let Some(program_x86) = program_x86.clone() {
                out.push(program_x86.join("LLVM/bin").join(format!("{name}.exe")));
            }
        }
        "cairo.dll" | "libcairo-2.dll" => {
            if let Some(home) = std::env::var_os("USERPROFILE") {
                let home = PathBuf::from(home);
                out.push(home.join("scoop/apps/cairo/current").join(name));
                out.push(home.join("scoop/apps/cairo/current/bin").join(name));
            }
        }
        _ => {}
    }
    out
}

fn scoop_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    &LOCK
}

async fn install_scoop(
    bucket: Option<&'static str>,
    packages: &'static [&'static str],
    proxy: Option<&str>,
) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("这个工具在 Windows 上用 Scoop 安装。其他系统请先自行安装。".into());
    }
    let scoop = find_scoop().ok_or("没有找到 Scoop。先安装 Scoop，再点安装。")?;
    let proxy = proxy.map(str::to_string);
    logged_blocking(move || {
        let _guard = scoop_lock().lock().unwrap_or_else(|err| err.into_inner());
        if let Some(bucket) = bucket {
            scoop_ok(
                &scoop,
                &["bucket".into(), "add".into(), bucket.into()],
                proxy.as_deref(),
                &format!("添加 Scoop {bucket} 失败"),
            )?;
        }
        for package in packages {
            scoop_ok(
                &scoop,
                &["install".into(), (*package).into()],
                proxy.as_deref(),
                &format!("安装 {package} 失败"),
            )?;
        }
        Ok(())
    })
    .await
}

async fn install_java(proxy: Option<&str>) -> Result<(), String> {
    install_scoop(Some("java"), &["temurin-jdk"], proxy).await?;
    install_scoop(None, &["maven"], proxy).await
}

fn find_scoop() -> Option<PathBuf> {
    if let Some(path) = find_on_path(&["scoop"], None) {
        return Some(path);
    }
    let home = std::env::var_os("USERPROFILE")?;
    for name in ["scoop.cmd", "scoop.ps1", "scoop.exe"] {
        let path = PathBuf::from(&home).join("scoop/shims").join(name);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn run_scoop(scoop: &Path, args: &[String], env: &[(String, String)]) -> Result<Captured, String> {
    let lower = scoop.to_string_lossy().to_ascii_lowercase();
    if lower.ends_with(".ps1") {
        let mut full = vec![
            "-NoProfile".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            scoop.display().to_string(),
        ];
        full.extend(args.iter().cloned());
        return run_capture(
            Path::new("powershell.exe"),
            &full,
            env,
            None,
            Duration::from_secs(600),
            32_000,
        );
    }
    run_capture(scoop, args, env, None, Duration::from_secs(600), 32_000)
}

fn scoop_ok(scoop: &Path, args: &[String], proxy: Option<&str>, label: &str) -> Result<(), String> {
    let output = {
        let mut env = Vec::new();
        if let Some(proxy) = proxy {
            for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
                env.push((key.into(), proxy.into()));
            }
        }
        run_scoop(scoop, args, &env)?
    };
    let text = format!("{}\n{}", output.stdout, output.stderr).to_ascii_lowercase();
    if output.code == 0 || text.contains("already installed") || text.contains("already exists") {
        return Ok(());
    }
    let detail = first_line(&output.stderr, &output.stdout);
    if detail.is_empty() {
        Err(format!("{label}（退出码 {}）", output.code))
    } else {
        Err(format!("{label}：{detail}"))
    }
}

fn node_install_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

async fn ensure_node(tools: &Path, proxy: Option<&str>) -> Result<(), String> {
    if find_on_path(&["npm"], Some(tools)).is_some() {
        return Ok(());
    }
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let root = tools.join("node");
    if find_named(&root, node_name, 4).is_some() && find_named(&root, "npm-cli.js", 8).is_some() {
        return Ok(());
    }
    fetch_node(tools, proxy).await
}

async fn install_node(tools: &Path, proxy: Option<&str>) -> Result<(), String> {
    let _guard = node_install_lock().lock().await;
    ensure_node(tools, proxy).await
}

async fn install_npm(
    tools: &Path,
    prefix: &'static str,
    package: &'static str,
    proxy: Option<&str>,
) -> Result<(), String> {
    let _guard = node_install_lock().lock().await;
    ensure_node(tools, proxy).await?;
    let tools = tools.to_path_buf();
    let proxy = proxy.map(str::to_string);
    logged_blocking(move || npm_install_pkg(&tools, prefix, package, proxy.as_deref())).await
}

async fn install_playwright(tools: &Path, proxy: Option<&str>) -> Result<(), String> {
    let _guard = node_install_lock().lock().await;
    ensure_node(tools, proxy).await?;
    let tools_buf = tools.to_path_buf();
    let proxy_owned = proxy.map(str::to_string);
    logged_blocking({
        let tools_buf = tools_buf.clone();
        let proxy_owned = proxy_owned.clone();
        move || {
            npm_install_pkg(
                &tools_buf,
                "playwright",
                "playwright",
                proxy_owned.as_deref(),
            )
        }
    })
    .await?;
    let cli = locate_name(
        "playwright",
        &["--version"],
        &[
            "playwright/node_modules/.bin/playwright.cmd",
            "playwright/node_modules/.bin/playwright",
        ],
        true,
        tools,
    )
    .ok_or("没有找到 Playwright")?;
    logged_blocking(move || {
        run_checked(
            &cli.path,
            &["install".into(), "chromium".into()],
            proxy_owned.as_deref(),
            None,
            Duration::from_secs(600),
            "安装 Playwright 浏览器失败",
        )
    })
    .await
}

async fn install_uv(tools: &Path, proxy: Option<&str>) -> Result<(), String> {
    let bytes = uv_bytes(proxy).await?;
    extract_blocking(tools.join("uv"), bytes).await
}

async fn install_rust(proxy: Option<&str>) -> Result<(), String> {
    if !cfg!(windows) {
        return Err(
            "请用 rustup 安装 Rust：curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
                .into(),
        );
    }
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64-pc-windows-msvc",
        "aarch64" => "aarch64-pc-windows-msvc",
        _ => return Err("当前架构没有可用的 rustup".into()),
    };
    let url = format!("https://static.rust-lang.org/rustup/dist/{arch}/rustup-init.exe");
    let bytes = download(&url, proxy, 30 * 1024 * 1024).await?;
    let dir = std::env::temp_dir().join("my-workbench-rustup");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let exe = dir.join("rustup-init.exe");
    fs::write(&exe, &bytes).map_err(|err| format!("无法写入 rustup：{err}"))?;
    let proxy = proxy.map(str::to_string);
    logged_blocking(move || {
        run_checked(
            &exe,
            &[
                "-y".into(),
                "--default-toolchain".into(),
                "stable".into(),
                "--profile".into(),
                "minimal".into(),
            ],
            proxy.as_deref(),
            None,
            Duration::from_secs(600),
            "安装 Rust 失败",
        )
    })
    .await
}

async fn install_webview2(proxy: Option<&str>) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("WebView2 只在 Windows 上安装。".into());
    }
    if probe_webview().is_some() {
        return Ok(());
    }
    let bytes = download(
        "https://go.microsoft.com/fwlink/p/?LinkId=2124708",
        proxy,
        10 * 1024 * 1024,
    )
    .await?;
    let dir = std::env::temp_dir().join("my-workbench-webview2");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let exe = dir.join("WebView2Bootstrapper.exe");
    fs::write(&exe, &bytes).map_err(|err| format!("无法写入 WebView2 安装程序：{err}"))?;
    logged_blocking(move || {
        run_checked(
            &exe,
            &["/silent".into(), "/install".into()],
            None,
            None,
            Duration::from_secs(600),
            "安装 WebView2 失败",
        )
    })
    .await
}

async fn install_cairo(tools: &Path, proxy: Option<&str>) -> Result<(), String> {
    if probe_cairo(tools).is_some() {
        return Ok(());
    }
    match install_scoop(None, &["cairo"], proxy).await {
        Ok(()) => Ok(()),
        Err(err) if err.contains("Couldn't find") || err.contains("无法找到") => {
            install_scoop(Some("extras"), &["cairo"], proxy).await
        }
        Err(err) => Err(err),
    }
}

async fn install_ocr(tools: &Path, proxy: Option<&str>) -> Result<(), String> {
    let dir = tools
        .parent()
        .ok_or("无法定位模型目录")?
        .join("models")
        .join("paddleocr");
    fs::create_dir_all(&dir).map_err(|err| format!("无法创建模型目录：{err}"))?;
    const FILES: &[(&str, &str, &str)] = &[
        (
            "PP-OCRv6_det_small.onnx",
            "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx",
            "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
        ),
        (
            "PP-OCRv6_rec_small.onnx",
            "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx",
            "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
        ),
        (
            "ppocrv6_dict.txt",
            "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt",
            "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d",
        ),
    ];
    for (name, url, sha) in FILES {
        let path = dir.join(name);
        if path.is_file() {
            if let Ok(bytes) = fs::read(&path) {
                if verify_sha256(&bytes, sha).is_ok() {
                    continue;
                }
            }
        }
        let bytes = download(url, proxy, 80 * 1024 * 1024).await?;
        verify_sha256(&bytes, sha)?;
        fs::write(&path, bytes).map_err(|err| format!("无法写入 {name}：{err}"))?;
    }
    Ok(())
}

fn probe_marker(which: Marker, tools: &Path) -> Option<Resolved> {
    match which {
        Marker::Ocr => probe_ocr(tools),
        Marker::WebView => probe_webview(),
        Marker::Cairo => probe_cairo(tools),
    }
}

fn marker_hit(which: Marker, pref: Option<Resolved>, tools: &Path) -> Result<RunHit, String> {
    let resolved = match pref {
        Some(item) => item,
        None => probe_marker(which, tools).ok_or("还不可用")?,
    };
    let message = match which {
        Marker::Ocr => "PP-OCRv6 small 已就绪。把图片发给对话即可，应用会在本地识别。",
        Marker::WebView => "WebView2 运行时已就绪。",
        Marker::Cairo => "Cairo 是图形库，没有独立命令。",
    };
    Ok(RunHit {
        ok: true,
        code: 0,
        stdout: format!("{message}\n{}", resolved.path.display()),
        stderr: String::new(),
        truncated: false,
    })
}

fn ocr_models_ready(dir: &Path) -> bool {
    for name in [
        "PP-OCRv6_det_small.onnx",
        "PP-OCRv6_rec_small.onnx",
        "ppocrv6_dict.txt",
    ] {
        let path = dir.join(name);
        let Ok(meta) = fs::metadata(&path) else {
            return false;
        };
        if !meta.is_file() || meta.len() < 1_000 {
            return false;
        }
    }
    true
}

fn probe_ocr(tools: &Path) -> Option<Resolved> {
    let dir = tools.parent()?.join("models").join("paddleocr");
    if !ocr_models_ready(&dir) {
        return None;
    }
    Some(Resolved {
        path: dir,
        version: "PP-OCRv6 small".into(),
        source: "managed",
        env: Vec::new(),
    })
}

fn probe_webview() -> Option<Resolved> {
    let roots = [
        std::env::var_os("ProgramFiles(x86)").map(PathBuf::from),
        std::env::var_os("ProgramFiles").map(PathBuf::from),
    ];
    for root in roots.into_iter().flatten() {
        let app = root.join("Microsoft/EdgeWebView/Application");
        let Ok(entries) = fs::read_dir(&app) else {
            continue;
        };
        for entry in entries.flatten() {
            let exe = entry.path().join("msedgewebview2.exe");
            if exe.is_file() {
                let version = entry.file_name().to_string_lossy().to_string();
                return Some(Resolved {
                    path: exe,
                    version,
                    source: "env",
                    env: Vec::new(),
                });
            }
        }
    }
    None
}

fn probe_cairo(tools: &Path) -> Option<Resolved> {
    for name in ["cairo.dll", "libcairo-2.dll"] {
        if let Some(path) = find_on_path(&[name], Some(tools))
            .or_else(|| known_bins(&[name]).into_iter().find(|path| path.is_file()))
        {
            return Some(Resolved {
                path,
                version: "已检测到".into(),
                source: "env",
                env: Vec::new(),
            });
        }
        let managed = tools.join("cairo").join(name);
        if managed.is_file() {
            return Some(Resolved {
                path: managed,
                version: "已检测到".into(),
                source: "managed",
                env: Vec::new(),
            });
        }
    }
    None
}

fn playwright_browser_ready() -> bool {
    let mut roots = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("ms-playwright"));
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home = PathBuf::from(home);
        roots.push(home.join("AppData/Local/ms-playwright"));
        roots.push(home.join(".cache/ms-playwright"));
        roots.push(home.join("Library/Caches/ms-playwright"));
    }
    for root in roots {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if !name.starts_with("chromium") {
                continue;
            }
            if dir_has_browser(&entry.path(), 0) {
                return true;
            }
        }
    }
    false
}

fn dir_has_browser(dir: &Path, depth: u8) -> bool {
    if depth > 4 {
        return false;
    }
    const NAMES: &[&str] = &["chrome.exe", "chrome", "chromium", "headless_shell.exe"];
    if let Some(name) = dir.file_name().and_then(|item| item.to_str()) {
        if NAMES.iter().any(|item| name.eq_ignore_ascii_case(item)) && dir.is_file() {
            return true;
        }
    }
    if !dir.is_dir() {
        return false;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        if dir_has_browser(&entry.path(), depth + 1) {
            return true;
        }
    }
    false
}

async fn install_ffmpeg(tools: &Path, proxy: Option<&str>) -> Result<(), String> {
    if !cfg!(windows) {
        return Err(
            "自动安装 FFmpeg 目前在 Windows 下载精简包。其他系统请先自行安装 ffmpeg。".into(),
        );
    }
    let bytes = download(
        "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
        proxy,
        MAX_ARCHIVE,
    )
    .await?;
    extract_blocking(tools.join("ffmpeg"), bytes).await
}

async fn install_mermaid(tools: &Path, proxy: Option<&str>) -> Result<(), String> {
    install_npm(tools, "mermaid", "@mermaid-js/mermaid-cli", proxy).await
}

fn python_install_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

async fn install_python_pkg(tools: &Path, id: &str, proxy: Option<&str>) -> Result<(), String> {
    let _guard = python_install_lock().lock().await;
    let package = match id {
        "matplotlib" => "matplotlib",
        "plotly" => "plotly",
        "altair" => "altair",
        "bokeh" => "bokeh",
        _ => return Err("未知的 Python 库".into()),
    };
    let python = if let Some(path) = find_system_python(tools) {
        path
    } else {
        fetch_embed_python(tools, proxy).await?
    };
    let get_pip = if pip_ready(&python) {
        None
    } else {
        Some(
            download(
                "https://bootstrap.pypa.io/get-pip.py",
                proxy,
                3 * 1024 * 1024,
            )
            .await?,
        )
    };
    let tools = tools.to_path_buf();
    let package = package.to_string();
    let proxy = proxy.map(str::to_string);
    logged_blocking(move || {
        if let Some(bytes) = get_pip {
            let path = tools.join("get-pip.py");
            fs::write(&path, bytes).map_err(|err| format!("无法写入 get-pip.py：{err}"))?;
            run_get_pip(&python, &path, proxy.as_deref())?;
            let _ = fs::remove_file(path);
        }
        pip_install(&python, &tools, &package, proxy.as_deref())
    })
    .await
}

fn pip_ready(python: &Path) -> bool {
    run_capture(
        python,
        &["-m".into(), "pip".into(), "--version".into()],
        &[],
        None,
        Duration::from_secs(25),
        4_000,
    )
    .map(|item| item.code == 0)
    .unwrap_or(false)
}

fn run_get_pip(python: &Path, script: &Path, proxy: Option<&str>) -> Result<(), String> {
    run_checked(
        python,
        &[
            script.display().to_string(),
            "--no-warn-script-location".into(),
        ],
        proxy,
        None,
        Duration::from_secs(180),
        "安装 pip 失败",
    )
}

fn pip_install(
    python: &Path,
    tools: &Path,
    package: &str,
    proxy: Option<&str>,
) -> Result<(), String> {
    let target = tools.join("py-packages");
    fs::create_dir_all(&target).map_err(|err| format!("无法创建库目录：{err}"))?;
    run_checked(
        python,
        &[
            "-m".into(),
            "pip".into(),
            "install".into(),
            "--disable-pip-version-check".into(),
            "--no-warn-script-location".into(),
            "--upgrade".into(),
            "--target".into(),
            target.display().to_string(),
            package.into(),
        ],
        proxy,
        Some(tools),
        Duration::from_secs(600),
        "安装 Python 库失败",
    )
}

fn npm_install_pkg(
    tools: &Path,
    prefix_rel: &str,
    package: &str,
    proxy: Option<&str>,
) -> Result<(), String> {
    let prefix = tools.join(prefix_rel);
    let cache = tools.join("npm-cache");
    fs::create_dir_all(&cache).map_err(|err| format!("无法创建 npm 缓存：{err}"))?;
    let label = format!("安装 {package} 失败");
    let mut args = vec![
        "install".into(),
        "--prefix".into(),
        prefix.display().to_string(),
        "--cache".into(),
        cache.display().to_string(),
        "--no-fund".into(),
        "--no-audit".into(),
        package.into(),
    ];
    if let Some(npm) = find_on_path(&["npm"], Some(tools)) {
        return run_checked(
            &npm,
            &args,
            proxy,
            Some(tools),
            Duration::from_secs(600),
            &label,
        );
    }
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let node = find_named(&tools.join("node"), node_name, 4).ok_or("没有找到 Node.js")?;
    let npm_cli = find_named(&tools.join("node"), "npm-cli.js", 8).ok_or("没有找到 npm")?;
    let mut full = vec![npm_cli.display().to_string()];
    full.append(&mut args);
    run_checked(
        &node,
        &full,
        proxy,
        Some(tools),
        Duration::from_secs(600),
        &label,
    )
}

async fn fetch_node(tools: &Path, proxy: Option<&str>) -> Result<(), String> {
    let url = node_archive(proxy).await?;
    let bytes = download(&url, proxy, MAX_ARCHIVE).await?;
    extract_blocking(tools.join("node"), bytes).await
}

async fn fetch_embed_python(tools: &Path, proxy: Option<&str>) -> Result<PathBuf, String> {
    if !cfg!(windows) {
        return Err("没有检测到 Python。请先安装 Python，再安装图表库。".into());
    }
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        _ => return Err("当前架构没有可用的 Python 安装包".into()),
    };
    let index = download("https://www.python.org/ftp/python/", proxy, 4 * 1024 * 1024).await?;
    let mut versions = Vec::new();
    push_versions(&String::from_utf8_lossy(&index), &mut versions);
    versions.sort_by(|left, right| right.cmp(left));
    versions.dedup();
    if versions.is_empty() {
        return Err("无法取得 Python 版本列表".into());
    }
    let mut last = "没有可用的 Python 安装包".to_string();
    for ver in versions.into_iter().take(6) {
        let ver = format!("{}.{}.{}", ver.0, ver.1, ver.2);
        let url = format!("https://www.python.org/ftp/python/{ver}/python-{ver}-embed-{arch}.zip");
        match download(&url, proxy, 80 * 1024 * 1024).await {
            Ok(bytes) => {
                let dest = tools.join("python");
                extract_blocking(dest.clone(), bytes).await?;
                let dest_site = dest.clone();
                logged_blocking(move || enable_site(&dest_site)).await?;
                let exe = dest.join("python.exe");
                if !exe.is_file() {
                    return Err("Python 安装包里没有 python.exe".into());
                }
                return Ok(exe);
            }
            Err(err) => last = err,
        }
    }
    Err(last)
}

fn enable_site(python_dir: &Path) -> Result<(), String> {
    let mut pth = None;
    for entry in fs::read_dir(python_dir).map_err(|err| format!("无法读取 Python 目录：{err}"))?
    {
        let entry = entry.map_err(|err| err.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with("._pth") {
            pth = Some(entry.path());
            break;
        }
    }
    let Some(path) = pth else {
        return Ok(());
    };
    let raw = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let mut lines: Vec<String> = raw
        .lines()
        .map(|line| {
            if line.trim().trim_start_matches('#').trim() == "import site"
                && line.trim().starts_with('#')
            {
                "import site".to_string()
            } else {
                line.to_string()
            }
        })
        .collect();
    if !lines.iter().any(|line| line.trim() == "import site") {
        lines.push("import site".into());
    }
    if !lines.iter().any(|line| line.contains("site-packages")) {
        lines.insert(0, "Lib\\site-packages".into());
    }
    fs::create_dir_all(python_dir.join("Lib").join("site-packages"))
        .map_err(|err| err.to_string())?;
    fs::write(path, lines.join("\n")).map_err(|err| err.to_string())?;
    Ok(())
}

fn push_versions(html: &str, out: &mut Vec<(u32, u32, u32)>) {
    for token in html.split("href=\"") {
        let Some(end) = token.find('"') else { continue };
        let href = token[..end].trim_end_matches('/');
        if let Some(ver) = parse_triple(href) {
            if ver.0 == 3 {
                out.push(ver);
            }
        }
    }
}

fn parse_triple(text: &str) -> Option<(u32, u32, u32)> {
    let mut parts = text.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

async fn go_archive(proxy: Option<&str>) -> Result<(String, Option<String>), String> {
    let (os, arch) = go_target().ok_or("当前系统没有可用的 Go 安装包")?;
    let body = download("https://go.dev/dl/?mode=json", proxy, 2 * 1024 * 1024).await?;
    let releases: Vec<GoRel> = serde_json::from_slice(&body).map_err(|_| "无法解析 Go 版本列表")?;
    let file = releases
        .into_iter()
        .filter(|item| item.stable)
        .flat_map(|item| item.files)
        .find(|item| item.kind == "archive" && item.os == os && item.arch == arch)
        .ok_or("没有匹配当前系统的 Go 安装包")?;
    let sha = if file.sha256.len() == 64 {
        Some(file.sha256)
    } else {
        None
    };
    Ok((format!("https://go.dev/dl/{}", file.filename), sha))
}

fn go_target() -> Option<(&'static str, &'static str)> {
    let os = match std::env::consts::OS {
        "windows" => "windows",
        "linux" => "linux",
        "macos" => "darwin",
        _ => return None,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "x86" => "386",
        _ => return None,
    };
    Some((os, arch))
}

#[derive(Deserialize)]
struct GoRel {
    stable: bool,
    files: Vec<GoFile>,
}

#[derive(Deserialize)]
struct GoFile {
    filename: String,
    os: String,
    arch: String,
    kind: String,
    #[serde(default)]
    sha256: String,
}

async fn uv_bytes(proxy: Option<&str>) -> Result<Vec<u8>, String> {
    let api = "https://api.github.com/repos/astral-sh/uv/releases/latest";
    let marker = uv_marker();
    if let Some(marker) = marker {
        if let Ok(body) = download(api, proxy, 2 * 1024 * 1024).await {
            if let Ok(release) = serde_json::from_slice::<GhRelease>(&body) {
                if let Some(asset) = release
                    .assets
                    .iter()
                    .find(|asset| asset.name.contains(marker) && asset.name.ends_with(".zip"))
                {
                    return download(&asset.browser_download_url, proxy, MAX_ARCHIVE).await;
                }
            }
        }
    }
    let name = uv_fallback_name().ok_or("当前系统没有可用的 uv 安装包")?;
    download(
        &format!("https://github.com/astral-sh/uv/releases/download/0.13.7/{name}"),
        proxy,
        MAX_ARCHIVE,
    )
    .await
}

fn uv_marker() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        ("windows", "aarch64") => Some("aarch64-pc-windows-msvc"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-musl"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-musl"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        _ => None,
    }
}

fn uv_fallback_name() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("uv-x86_64-pc-windows-msvc.zip"),
        ("windows", "aarch64") => Some("uv-aarch64-pc-windows-msvc.zip"),
        ("linux", "x86_64") => Some("uv-x86_64-unknown-linux-musl.tar.gz"),
        ("linux", "aarch64") => Some("uv-aarch64-unknown-linux-musl.tar.gz"),
        ("macos", "x86_64") => Some("uv-x86_64-apple-darwin.tar.gz"),
        ("macos", "aarch64") => Some("uv-aarch64-apple-darwin.tar.gz"),
        _ => None,
    }
}

async fn ripgrep_bytes(proxy: Option<&str>) -> Result<Vec<u8>, String> {
    let api = "https://api.github.com/repos/BurntSushi/ripgrep/releases/latest";
    if let Ok(body) = download(api, proxy, 2 * 1024 * 1024).await {
        if let Ok(release) = serde_json::from_slice::<GhRelease>(&body) {
            if let Some(asset) = rg_asset(&release.assets) {
                return download(&asset.browser_download_url, proxy, MAX_ARCHIVE).await;
            }
        }
    }
    let url = rg_fallback_url().ok_or("当前系统没有可用的 ripgrep 安装包")?;
    download(&url, proxy, MAX_ARCHIVE).await
}

#[derive(Deserialize)]
struct GhRelease {
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

fn rg_asset(assets: &[GhAsset]) -> Option<&GhAsset> {
    let needle = rg_marker()?;
    assets
        .iter()
        .find(|asset| asset.name.contains(needle) && !asset.name.ends_with(".sha256"))
}

fn rg_marker() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc.zip"),
        ("windows", "aarch64") => Some("aarch64-pc-windows-msvc.zip"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-musl.tar.gz"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-musl.tar.gz"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin.tar.gz"),
        ("macos", "aarch64") => Some("aarch64-apple-darwin.tar.gz"),
        _ => None,
    }
}

fn rg_fallback_url() -> Option<String> {
    let name = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "ripgrep-14.1.1-x86_64-pc-windows-msvc.zip",
        ("windows", "aarch64") => "ripgrep-14.1.1-aarch64-pc-windows-msvc.zip",
        ("linux", "x86_64") => "ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz",
        ("linux", "aarch64") => "ripgrep-14.1.1-aarch64-unknown-linux-musl.tar.gz",
        ("macos", "x86_64") => "ripgrep-14.1.1-x86_64-apple-darwin.tar.gz",
        ("macos", "aarch64") => "ripgrep-14.1.1-aarch64-apple-darwin.tar.gz",
        _ => return None,
    };
    Some(format!(
        "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/{name}"
    ))
}

async fn node_archive(proxy: Option<&str>) -> Result<String, String> {
    let file_key = node_file_key().ok_or("当前系统没有可用的 Node.js 安装包")?;
    let body = download("https://nodejs.org/dist/index.json", proxy, 4 * 1024 * 1024).await?;
    let releases: Vec<NodeRel> =
        serde_json::from_slice(&body).map_err(|_| "无法解析 Node.js 版本列表")?;
    let release = releases
        .into_iter()
        .find(|item| {
            item.lts != serde_json::Value::Bool(false)
                && item.files.iter().any(|file| file == file_key)
        })
        .ok_or("没有匹配当前系统的 Node.js 安装包")?;
    let filename = node_filename(&release.version, file_key).ok_or("无法确定 Node.js 文件名")?;
    Ok(format!(
        "https://nodejs.org/dist/{}/{filename}",
        release.version
    ))
}

fn node_file_key() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("win-x64-zip"),
        ("windows", "aarch64") => Some("win-arm64-zip"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("macos", "x86_64") => Some("osx-x64-tar"),
        ("macos", "aarch64") => Some("osx-arm64-tar"),
        _ => None,
    }
}

fn node_filename(version: &str, key: &str) -> Option<String> {
    let suffix = match key {
        "win-x64-zip" => "win-x64.zip",
        "win-arm64-zip" => "win-arm64.zip",
        "linux-x64" => "linux-x64.tar.gz",
        "linux-arm64" => "linux-arm64.tar.gz",
        "osx-x64-tar" => "darwin-x64.tar.gz",
        "osx-arm64-tar" => "darwin-arm64.tar.gz",
        _ => return None,
    };
    Some(format!("node-{version}-{suffix}"))
}

#[derive(Deserialize)]
struct NodeRel {
    version: String,
    lts: serde_json::Value,
    files: Vec<String>,
}

async fn download(url: &str, proxy: Option<&str>, max_bytes: usize) -> Result<Vec<u8>, String> {
    install_log(&format!("下载 {url}\n"));
    let parsed = reqwest::Url::parse(url).map_err(|_| "下载地址无效".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("只允许 http(s) 下载".into()),
    }
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(8))
        .user_agent("my-workbench");
    if let Some(proxy_url) = proxy {
        let proxy = reqwest::Proxy::all(proxy_url).map_err(|_| "代理地址无效".to_string())?;
        builder = builder.proxy(proxy);
    }
    let client = builder.build().map_err(|err| err.to_string())?;
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|err| format!("下载失败：{err}"))?;
    if !response.status().is_success() {
        return Err(format!("下载失败：HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("下载失败：{err}"))?;
    if bytes.len() > max_bytes {
        return Err("安装包过大".into());
    }
    Ok(bytes.to_vec())
}

fn verify_sha256(bytes: &[u8], hex_hash: &str) -> Result<(), String> {
    let expected = decode_hex(hex_hash).ok_or("安装包校验值无效")?;
    let got = Sha256::digest(bytes);
    if got.as_slice() == expected.as_slice() {
        Ok(())
    } else {
        Err("Go 安装包校验失败".into())
    }
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index < bytes.len() {
        let hi = hex_val(bytes[index])?;
        let lo = hex_val(bytes[index + 1])?;
        out.push((hi << 4) | lo);
        index += 2;
    }
    Some(out)
}

fn hex_val(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

async fn extract_blocking(dest: PathBuf, bytes: Vec<u8>) -> Result<(), String> {
    install_log("正在解压…\n");
    logged_blocking(move || extract_archive(&dest, &bytes)).await
}

fn extract_archive(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    replace_tree(dest, |dir| {
        if bytes.starts_with(b"PK") {
            extract_zip(dir, bytes)
        } else if bytes.len() > 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
            extract_tar_gz(dir, bytes)
        } else {
            Err("无法识别安装包格式".into())
        }
    })
}

fn replace_tree(dest: &Path, fill: impl FnOnce(&Path) -> Result<(), String>) -> Result<(), String> {
    let tmp = dest.with_extension("incoming");
    remove_path(&tmp)?;
    fs::create_dir_all(&tmp).map_err(|err| format!("无法创建临时目录：{err}"))?;
    if let Err(err) = fill(&tmp) {
        let _ = remove_path(&tmp);
        return Err(err);
    }
    remove_path(dest)?;
    fs::rename(&tmp, dest).map_err(|err| format!("无法完成安装：{err}"))?;
    Ok(())
}

fn remove_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|err| format!("无法清理目录：{err}"))
    } else {
        fs::remove_file(path).map_err(|err| format!("无法清理文件：{err}"))
    }
}

fn extract_zip(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|err| err.to_string())?;
    let mut names = Vec::new();
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|err| err.to_string())?;
        names.push(file.name().to_string());
    }
    let root = shared_root(&names);
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|err| err.to_string())?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().to_string();
        let Some(rel) = rel_under(&name, root.as_deref()) else {
            continue;
        };
        let Some(path) = safe_join(dest, rel) else {
            return Err("安装包路径无效".into());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let mut out = File::create(&path).map_err(|err| err.to_string())?;
        total += copy_limited(&mut file, &mut out, MAX_EXTRACT.saturating_sub(total))?;
        maybe_exec(&path);
    }
    Ok(())
}

fn extract_tar_gz(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    let root = shared_root(&tar_names(bytes)?);
    let decoder = flate2::read::GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    let mut total = 0u64;
    for entry in archive.entries().map_err(|err| err.to_string())? {
        let mut entry = entry.map_err(|err| err.to_string())?;
        let kind = entry.header().entry_type();
        if kind.is_dir() || kind.is_symlink() || kind.is_hard_link() {
            continue;
        }
        let name = entry
            .path()
            .map_err(|err| err.to_string())?
            .to_string_lossy()
            .into_owned();
        let Some(rel) = rel_under(&name, root.as_deref()) else {
            continue;
        };
        let Some(path) = safe_join(dest, rel) else {
            return Err("安装包路径无效".into());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let mut out = File::create(&path).map_err(|err| err.to_string())?;
        total += copy_limited(&mut entry, &mut out, MAX_EXTRACT.saturating_sub(total))?;
        maybe_exec(&path);
    }
    Ok(())
}

fn tar_names(bytes: &[u8]) -> Result<Vec<String>, String> {
    let decoder = flate2::read::GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    let mut names = Vec::new();
    for entry in archive.entries().map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let kind = entry.header().entry_type();
        if kind.is_dir() || kind.is_symlink() || kind.is_hard_link() {
            continue;
        }
        names.push(
            entry
                .path()
                .map_err(|err| err.to_string())?
                .to_string_lossy()
                .into_owned(),
        );
    }
    Ok(names)
}

fn shared_root(names: &[String]) -> Option<String> {
    let mut root: Option<String> = None;
    for name in names {
        let trimmed = name.trim_start_matches(['/', '\\']);
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.split(['/', '\\']).filter(|part| !part.is_empty());
        let first = parts.next()?.to_string();
        let has_more = parts.next().is_some();
        let is_dir = name.ends_with('/') || name.ends_with('\\');
        if !has_more && !is_dir {
            return None;
        }
        match &root {
            None => root = Some(first),
            Some(existing) if existing != &first => return None,
            _ => {}
        }
    }
    root
}

fn rel_under<'a>(name: &'a str, root: Option<&str>) -> Option<&'a str> {
    let trimmed = name.trim_start_matches(['/', '\\']);
    if trimmed.is_empty() {
        return None;
    }
    let Some(root) = root else {
        return Some(trimmed);
    };
    if trimmed == root {
        return None;
    }
    let rest = trimmed.strip_prefix(root)?;
    let rest = rest.strip_prefix('/').or_else(|| rest.strip_prefix('\\'))?;
    if rest.is_empty() { None } else { Some(rest) }
}

fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return None;
    }
    if rel_path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return None;
    }
    Some(root.join(rel_path))
}

fn copy_limited(reader: &mut impl Read, writer: &mut impl Write, max: u64) -> Result<u64, String> {
    if max == 0 {
        return Err("解压体积过大".into());
    }
    let mut buf = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let size = reader.read(&mut buf).map_err(|err| err.to_string())?;
        if size == 0 {
            break;
        }
        total += size as u64;
        if total > max {
            return Err("解压体积过大".into());
        }
        writer
            .write_all(&buf[..size])
            .map_err(|err| err.to_string())?;
    }
    Ok(total)
}

fn maybe_exec(path: &Path) {
    #[cfg(unix)]
    {
        let Some(name) = path.file_name().and_then(|item| item.to_str()) else {
            return;
        };
        if matches!(
            name,
            "go" | "rg" | "ffmpeg" | "ffprobe" | "node" | "python" | "python3" | "mmdc" | "npm"
        ) {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o755));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn find_named(root: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    if depth == 0 || !root.is_dir() {
        return None;
    }
    let entries = fs::read_dir(root).ok()?;
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.file_name().and_then(|item| item.to_str()) == Some(name) {
            return Some(path);
        }
        if path.is_dir() {
            dirs.push(path);
        }
    }
    for dir in dirs {
        if let Some(found) = find_named(&dir, name, depth - 1) {
            return Some(found);
        }
    }
    None
}
