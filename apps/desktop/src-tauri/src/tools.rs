use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const MAX_ARCHIVE: usize = 450 * 1024 * 1024;
const MAX_EXTRACT: u64 = 1200 * 1024 * 1024;
const RUN_LIMIT: usize = 64 * 1024;

struct ToolDef {
    id: &'static str,
    kind: Kind,
}

enum Kind {
    Binary {
        names: &'static [&'static str],
        version_args: &'static [&'static str],
        managed: &'static [&'static str],
        /// A server-style command may not print a version. Existence is enough.
        best_effort: bool,
    },
    Python {
        module: &'static str,
    },
}

const TOOLS: &[ToolDef] = &[
    ToolDef {
        id: "go",
        kind: Kind::Binary {
            names: &["go"],
            version_args: &["version"],
            managed: &["go/bin/go.exe", "go/bin/go"],
            best_effort: false,
        },
    },
    ToolDef {
        id: "ripgrep",
        kind: Kind::Binary {
            names: &["rg"],
            version_args: &["--version"],
            managed: &["ripgrep/rg.exe", "ripgrep/rg"],
            best_effort: false,
        },
    },
    ToolDef {
        id: "ffmpeg",
        kind: Kind::Binary {
            names: &["ffmpeg"],
            version_args: &["-version"],
            managed: &[
                "ffmpeg/bin/ffmpeg.exe",
                "ffmpeg/ffmpeg.exe",
                "ffmpeg/bin/ffmpeg",
                "ffmpeg/ffmpeg",
            ],
            best_effort: false,
        },
    },
    ToolDef {
        id: "inkscape",
        kind: Kind::Binary {
            names: &["inkscape"],
            version_args: &["--version"],
            managed: &["inkscape/bin/inkscape.com", "inkscape/bin/inkscape.exe"],
            best_effort: false,
        },
    },
    ToolDef {
        id: "mermaid",
        kind: Kind::Binary {
            names: &["mmdc"],
            version_args: &["--version"],
            managed: &[
                "mermaid/node_modules/.bin/mmdc.cmd",
                "mermaid/node_modules/.bin/mmdc",
            ],
            best_effort: false,
        },
    },
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

#[tauri::command]
pub async fn tools_probe(app: tauri::AppHandle) -> Result<Vec<ProbeHit>, String> {
    let tools = tools_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || probe_all(&tools))
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
    match id.trim() {
        "go" => install_go(&tools, proxy).await,
        "ripgrep" => install_ripgrep(&tools, proxy).await,
        "ffmpeg" => install_ffmpeg(&tools, proxy).await,
        "mermaid" => install_mermaid(&tools, proxy).await,
        "matplotlib" | "plotly" | "altair" | "bokeh" => {
            install_python_pkg(&tools, id.trim(), proxy).await
        }
        "inkscape" => install_inkscape(proxy).await,
        _ => Err("未知工具".into()),
    }
}

#[tauri::command]
pub async fn tools_run(
    app: tauri::AppHandle,
    id: String,
    args: Vec<String>,
    cwd: Option<String>,
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
    tauri::async_runtime::spawn_blocking(move || run_tool(&tools, &id_owned, &args, &cwd_owned))
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

fn probe_all(tools: &Path) -> Result<Vec<ProbeHit>, String> {
    let mut hits = Vec::with_capacity(TOOLS.len());
    std::thread::scope(|scope| {
        let mut joins = Vec::new();
        for tool in TOOLS {
            joins.push(scope.spawn(|| probe_tool(tool, tools)));
        }
        for join in joins {
            hits.push(join.join().unwrap_or_else(|_| missing("unknown")));
        }
    });
    Ok(hits)
}

fn probe_tool(tool: &ToolDef, tools: &Path) -> ProbeHit {
    let resolved = match tool.kind {
        Kind::Binary {
            names,
            version_args,
            managed,
            best_effort,
        } => probe_binary(names, version_args, managed, best_effort, tools),
        Kind::Python { module } => probe_python(module, tools),
    };
    match resolved {
        Some(item) => ProbeHit {
            id: tool.id.to_string(),
            status: "ready".into(),
            source: item.source.into(),
            path: item.path.display().to_string(),
            version: item.version,
            invoke: vec![item.path.display().to_string()],
        },
        None => missing(tool.id),
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
    tools: &Path,
) -> Option<Resolved> {
    let timeout = if names.contains(&"inkscape") {
        Duration::from_secs(25)
    } else {
        Duration::from_secs(12)
    };
    for path in find_on_path(names, Some(tools))
        .into_iter()
        .chain(known_bins(names))
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
    for rel in managed {
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

fn run_tool(tools: &Path, id: &str, args: &[String], cwd: &str) -> Result<RunHit, String> {
    let tool = TOOLS.iter().find(|item| item.id == id).ok_or("未知工具")?;
    if matches!(tool.kind, Kind::Python { .. }) && args.is_empty() {
        return Err("请传入 Python 参数，例如 [\"-c\", \"代码\"]".into());
    }
    let resolved = match tool.kind {
        Kind::Binary {
            names,
            version_args,
            managed,
            best_effort,
        } => probe_binary(names, version_args, managed, best_effort, tools),
        Kind::Python { module } => probe_python(module, tools),
    }
    .ok_or_else(|| format!("{id} 还不可用"))?;
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
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("无法启动 {}：{err}", exe.display()))?;
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let out_thread = std::thread::spawn(move || match stdout_pipe {
        Some(pipe) => read_limited(pipe, limit),
        None => (String::new(), false),
    });
    let err_thread = std::thread::spawn(move || match stderr_pipe {
        Some(pipe) => read_limited(pipe, limit),
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

fn read_limited<R: Read>(mut pipe: R, limit: usize) -> (String, bool) {
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
        if size > room {
            raw.extend_from_slice(&buf[..room]);
            truncated = true;
        } else {
            raw.extend_from_slice(&buf[..size]);
        }
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
    if !names.contains(&"inkscape") {
        return Vec::new();
    }
    let mut out = Vec::new();
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME"));
    if let Ok(home) = home {
        let home = PathBuf::from(home);
        out.push(home.join("scoop/shims/inkscape.com"));
        out.push(home.join("scoop/shims/inkscape.exe"));
        out.push(home.join("scoop/apps/inkscape/current/bin/inkscape.com"));
        out.push(home.join("scoop/apps/inkscape/current/bin/inkscape.exe"));
    }
    if let Ok(program) = std::env::var("ProgramFiles") {
        let root = PathBuf::from(program).join("Inkscape/bin");
        out.push(root.join("inkscape.com"));
        out.push(root.join("inkscape.exe"));
    }
    out
}

async fn install_inkscape(proxy: Option<&str>) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("请用系统的包管理器安装 Inkscape，例如 brew install inkscape。".into());
    }
    let scoop = find_scoop().ok_or("没有找到 Scoop。先安装 Scoop，再点安装 Inkscape。")?;
    let proxy = proxy.map(str::to_string);
    tauri::async_runtime::spawn_blocking(move || {
        scoop_ok(
            &scoop,
            &["bucket".into(), "add".into(), "extras".into()],
            proxy.as_deref(),
            "添加 Scoop extras 失败",
        )?;
        scoop_ok(
            &scoop,
            &["install".into(), "inkscape".into()],
            proxy.as_deref(),
            "安装 Inkscape 失败",
        )
    })
    .await
    .map_err(|err| format!("安装失败：{err}"))?
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
    if find_on_path(&["npm"], Some(tools)).is_none() {
        let node_root = tools.join("node");
        let node_name = if cfg!(windows) { "node.exe" } else { "node" };
        if find_named(&node_root, node_name, 4).is_none() {
            fetch_node(tools, proxy).await?;
        }
    }
    let tools = tools.to_path_buf();
    let proxy = proxy.map(str::to_string);
    tauri::async_runtime::spawn_blocking(move || npm_install_mermaid(&tools, proxy.as_deref()))
        .await
        .map_err(|err| format!("安装失败：{err}"))?
}

async fn install_python_pkg(tools: &Path, id: &str, proxy: Option<&str>) -> Result<(), String> {
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
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(bytes) = get_pip {
            let path = tools.join("get-pip.py");
            fs::write(&path, bytes).map_err(|err| format!("无法写入 get-pip.py：{err}"))?;
            run_get_pip(&python, &path, proxy.as_deref())?;
            let _ = fs::remove_file(path);
        }
        pip_install(&python, &tools, &package, proxy.as_deref())
    })
    .await
    .map_err(|err| format!("安装失败：{err}"))?
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

fn npm_install_mermaid(tools: &Path, proxy: Option<&str>) -> Result<(), String> {
    let prefix = tools.join("mermaid");
    let cache = tools.join("npm-cache");
    fs::create_dir_all(&cache).map_err(|err| format!("无法创建 npm 缓存：{err}"))?;
    let mut args = vec![
        "install".into(),
        "--prefix".into(),
        prefix.display().to_string(),
        "--cache".into(),
        cache.display().to_string(),
        "--no-fund".into(),
        "--no-audit".into(),
        "@mermaid-js/mermaid-cli".into(),
    ];
    if let Some(npm) = find_on_path(&["npm"], Some(tools)) {
        return run_checked(
            &npm,
            &args,
            proxy,
            Some(tools),
            Duration::from_secs(600),
            "安装 Mermaid 失败",
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
        "安装 Mermaid 失败",
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
                tauri::async_runtime::spawn_blocking(move || enable_site(&dest_site))
                    .await
                    .map_err(|err| format!("安装失败：{err}"))??;
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
    let expected = decode_hex(hex_hash).ok_or("Go 安装包校验值无效")?;
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
    tauri::async_runtime::spawn_blocking(move || extract_archive(&dest, &bytes))
        .await
        .map_err(|err| format!("安装失败：{err}"))?
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
