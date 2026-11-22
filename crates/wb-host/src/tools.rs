//! Local tool catalog for the settings page.
//!
//! The first visit scans the machine, then tries to fetch tools that are still
//! missing. Later visits read `tools/catalog.json`. Fetches run two at a time,
//! and tools that share Scoop, Node, or Python wait for that lane to free.

use crate::shell::which_bin;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex, OnceLock};
use std::thread;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolCategory {
    Runtime,
    Browser,
    Docs,
    Remote,
    Language,
    Package,
    Chart,
}

impl ToolCategory {
    pub fn label(self) -> &'static str {
        match self {
            Self::Runtime => "基础运行时",
            Self::Browser => "浏览器",
            Self::Docs => "文档与图片",
            Self::Remote => "远程开发",
            Self::Language => "语言工具",
            Self::Package => "打包工具",
            Self::Chart => "图表",
        }
    }

    pub fn all() -> [Self; 7] {
        [
            Self::Runtime,
            Self::Browser,
            Self::Docs,
            Self::Remote,
            Self::Language,
            Self::Package,
            Self::Chart,
        ]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolAvailability {
    Installed,
    Missing,
    Failed,
}

#[derive(Debug, Clone)]
pub struct ToolRow {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub category: ToolCategory,
    pub availability: ToolAvailability,
    pub enabled: bool,
    pub location: Option<String>,
    pub version: Option<String>,
    pub message: Option<String>,
    pub busy: bool,
    pub fetchable: bool,
    pub lane_label: &'static str,
    pub install_guide: String,
}

#[derive(Debug, Clone)]
pub struct ToolCatalog {
    pub tools_dir: String,
    pub scanned_at: Option<String>,
    pub bootstrapped: bool,
    pub rows: Vec<ToolRow>,
}

impl ToolCatalog {
    pub fn available_count(&self) -> usize {
        self.rows
            .iter()
            .filter(|row| row.availability == ToolAvailability::Installed)
            .count()
    }

    pub fn row(&self, id: &str) -> Option<&ToolRow> {
        self.rows.iter().find(|row| row.id == id)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Lane {
    Free,
    Scoop,
    Node,
    Python,
}

#[derive(Clone, Copy)]
enum Fetch {
    None,
    Scoop(&'static [&'static str]),
    Npm(&'static str),
    Pip(&'static str),
    Playwright,
    Ocr,
    FontWasm,
    Rustup,
}

#[derive(Clone, Copy)]
struct Spec {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    category: ToolCategory,
    lane: Lane,
    fetch: Fetch,
}

impl Spec {
    fn fetchable(self) -> bool {
        !matches!(self.fetch, Fetch::None)
    }

    fn lane_label(self) -> &'static str {
        match self.fetch {
            Fetch::None => "只检查本机，不自动安装",
            Fetch::Scoop(_) => "Scoop",
            Fetch::Npm(_) | Fetch::Playwright | Fetch::FontWasm => "Node",
            Fetch::Pip(_) => "Python（uv 或 pip）",
            Fetch::Ocr => "下载模型",
            Fetch::Rustup => "rustup",
        }
    }

    fn install_guide(self) -> String {
        match self.fetch {
            Fetch::None => match self.id {
                "uv" => "本机需要能直接运行 uv。可用安装脚本装到用户目录，或在已有 Scoop 时执行 scoop install uv。装好后同一环境里应有 uv 和 uvx。".into(),
                "node" => "本机需要能直接运行 node。从 nodejs.org 安装，或执行 scoop install nodejs。装好后同一目录里应有 node、npm 和 npx。".into(),
                "openssh" => "在 Windows「设置 → 应用 → 可选功能」里安装 OpenSSH 客户端。装好后应能运行 ssh.exe。".into(),
                "webview2" => "安装微软 Evergreen WebView2 Runtime。Windows 11 多数已经自带，装好后注册表里能看到版本号。".into(),
                "readelf" => "安装带 readelf 的 binutils，或执行 scoop install llvm，之后使用 llvm-readelf.exe。".into(),
                _ => "本机需要已经装好这个命令。装好后点「扫描本机」。".into(),
            },
            Fetch::Scoop(pkgs) => format!(
                "需要已经装好 Scoop。获取时执行 scoop install {}。也可以用官网安装包，装好后点「扫描本机」。",
                pkgs.join(" ")
            ),
            Fetch::Npm(pkg) => format!(
                "需要本机已有 Node.js 和 npm。获取时执行 npm install -g {pkg}，装到 npm 的全局目录。"
            ),
            Fetch::Playwright => "需要本机已有 Node.js。获取时执行 npx --yes playwright install chromium，浏览器下到本机的 Playwright 缓存目录。".into(),
            Fetch::Pip(pkg) => format!(
                "需要 uv 或 Python。获取时在工具目录里建 py 虚拟环境，再执行 uv pip install {pkg}。没有 uv 时改用 python -m venv 和 pip install {pkg}。不会改系统里的 Python。"
            ),
            Fetch::Ocr => "从 RapidOCR 的 ModelScope 仓库下载 PP-OCRv6 small 的检测模型、方向分类模型、识别模型和字典，保存到数据目录的 models/paddleocr。".into(),
            Fetch::FontWasm => "需要 Node.js 24 或更高。把 Fontwasm 解码器放到工具目录的 fontwasm 文件夹，然后点「扫描本机」。".into(),
            Fetch::Rustup => "本机已有 rustup 时，获取会执行 rustup toolchain install stable。还没有 rustup 时，先从 rustup.rs 安装，再点获取。".into(),
        }
    }
}

fn spec(
    id: &'static str,
    name: &'static str,
    description: &'static str,
    category: ToolCategory,
    lane: Lane,
    fetch: Fetch,
) -> Spec {
    Spec {
        id,
        name,
        description,
        category,
        lane,
        fetch,
    }
}

fn specs() -> &'static [Spec] {
    use Fetch::{FontWasm, None, Npm, Ocr, Pip, Playwright, Rustup, Scoop};
    use Lane::{Free, Node, Python, Scoop as ScoopLane};
    use ToolCategory::{Browser, Chart, Docs, Language, Package, Remote, Runtime};
    static SPECS: OnceLock<Vec<Spec>> = OnceLock::new();
    SPECS.get_or_init(|| {
        vec![
            spec("uv", "uv", "安装和运行 Python。uv 管环境和包、uvx 临时运行命令", Runtime, Free, None),
            spec("node", "Node.js", "Node.js，以及同目录的 npm 和 npx", Runtime, Free, None),
            spec("git", "Git", "查看和操作仓库", Runtime, ScoopLane, Scoop(&["git"])),
            spec("ripgrep", "ripgrep", "按内容快速搜索文件", Runtime, ScoopLane, Scoop(&["ripgrep"])),
            spec("chromium", "Chromium", "独立的 Chromium 浏览器", Browser, ScoopLane, Scoop(&["chromium"])),
            spec("playwright", "Playwright", "Playwright 自带的浏览器，用来跑页面和截图", Browser, Node, Playwright),
            spec("browser-mcp", "Browser MCP", "Playwright MCP，让助手按页面结构操作浏览器", Browser, Node, Npm("@playwright/mcp")),
            spec("poppler", "Poppler", "把 PDF 转成文本或图片", Docs, ScoopLane, Scoop(&["poppler"])),
            spec("cairo", "Cairo", "矢量图形库，用来画图和渲染", Docs, ScoopLane, Scoop(&["cairo"])),
            spec("mermaid", "Mermaid", "把流程图、时序图、类图等 Mermaid 文本渲染成 SVG 或 PNG", Docs, Node, Npm("@mermaid-js/mermaid-cli")),
            spec("fontwasm", "Fontwasm", "用 WASM 字体解码器解析字体，并在 TTF、OTF、WOFF、WOFF2 之间转换。需要 Node.js 24 或更高版本", Docs, Node, FontWasm),
            spec("pp-ocr", "PP-OCRv6 small", "本地识图模型，识别图片和扫描件里的文字", Docs, Free, Ocr),
            spec("inkscape", "Inkscape", "编辑矢量图，用于 Logo、插画、海报和图标。放大不会发糊", Docs, ScoopLane, Scoop(&["inkscape"])),
            spec("ffmpeg", "FFmpeg", "转码、裁剪和查看音视频", Docs, ScoopLane, Scoop(&["ffmpeg"])),
            spec("openssh", "OpenSSH", "用 SSH 登录远程机器，并复制文件", Remote, Free, None),
            spec("sshfs", "SSHFS", "把远程目录挂到本地", Remote, ScoopLane, Scoop(&["sshfs"])),
            spec("go", "Go", "编译和运行 Go 程序", Language, ScoopLane, Scoop(&["go"])),
            spec("java-maven", "Java / Maven", "运行 Java，并用 Maven 构建", Language, ScoopLane, Scoop(&["temurin", "maven"])),
            spec("rust", "Rust", "编译 Rust。命令是 rustc.exe，旁边有 cargo.exe", Language, Free, Rustup),
            spec("ruby", "Ruby", "运行 Ruby 脚本", Language, ScoopLane, Scoop(&["ruby"])),
            spec("php", "PHP", "运行 PHP 脚本", Language, ScoopLane, Scoop(&["php"])),
            spec("dotnet", ".NET", "构建和运行 .NET 项目", Language, ScoopLane, Scoop(&["dotnet-sdk"])),
            spec("webview2", "WebView2", "内嵌网页和安装包要用的 WebView2 运行时", Package, Free, None),
            spec("redis", "Redis", "本地 Redis 服务和命令行", Package, ScoopLane, Scoop(&["redis"])),
            spec("nsis", "NSIS", "用 NSIS 脚本打 Windows 安装包", Package, ScoopLane, Scoop(&["nsis"])),
            spec("inno", "Inno Setup", "用 Inno Setup 打 Windows 安装包", Package, ScoopLane, Scoop(&["innosetup"])),
            spec("readelf", "readelf", "查看 ELF 文件头和符号。优先 readelf.exe，否则用 llvm-readelf.exe", Package, Free, None),
            spec("matplotlib", "Matplotlib", "用 Python 生成静态图表", Chart, Python, Pip("matplotlib")),
            spec("plotly", "Plotly", "用 Python 生成可交互的 HTML 图表", Chart, Python, Pip("plotly")),
            spec("altair", "Altair", "用 Python 生成 Vega-Lite 交互图", Chart, Python, Pip("altair")),
            spec("bokeh", "Bokeh", "用 Python 生成 Bokeh 交互图", Chart, Python, Pip("bokeh")),
        ]
    })
    .as_slice()
}

pub fn tools_directory() -> PathBuf {
    wb_store::resolve_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("tools")
}

pub fn read_tool_catalog() -> ToolCatalog {
    let _guard = catalog_lock().lock().unwrap();
    catalog_from_store(&read_store_unlocked())
}

pub fn scan_tool_catalog() -> ToolCatalog {
    // A rescan must observe the current machine, not what startup saw.
    crate::shell::which_bin_cache_clear();
    let _ = fs::create_dir_all(tools_directory());
    let ctx = ProbeCtx::full();
    let hits: Vec<(String, Hit)> = specs()
        .iter()
        .map(|spec| (spec.id.to_string(), probe_spec(spec, &ctx)))
        .collect();
    with_store(|stored| {
        stored.scanned_at = Some(timestamp());
        for (id, hit) in hits {
            let tool = stored.tools.entry(id).or_default();
            apply_hit(tool, hit);
        }
    });
    read_tool_catalog()
}

pub fn set_tool_enabled(id: &str, enabled: bool) {
    if specs().iter().all(|spec| spec.id != id) {
        return;
    }
    with_store(|stored| {
        stored.tools.entry(id.to_string()).or_default().enabled = enabled;
    });
}

pub fn clear_tool_busy() {
    with_store(|stored| {
        for tool in stored.tools.values_mut() {
            tool.busy = false;
        }
    });
}

pub fn tools_pending_fetch() -> Vec<String> {
    read_tool_catalog()
        .rows
        .into_iter()
        .filter(|row| needs_fetch(row.fetchable, row.enabled, row.availability))
        .map(|row| row.id.to_string())
        .collect()
}

/// Fetch the given tools. At most two run at once. Scoop, Node, and Python each
/// keep a single lane so installs that share a package manager do not overlap.
pub fn acquire_tools(ids: &[String], finish_bootstrap: bool, on_update: impl Fn() + Sync) {
    let on_update = &on_update;
    if !ids.is_empty() {
        with_store(|stored| {
            for id in ids {
                if let Some(tool) = stored.tools.get_mut(id)
                    && tool.enabled
                    && tool.availability != "installed"
                {
                    tool.busy = true;
                }
            }
        });
        on_update();
        let jobs = ids
            .iter()
            .filter_map(|id| {
                let spec = specs().iter().find(|spec| spec.id == id)?;
                spec.fetchable().then(|| ((*id).clone(), spec.lane))
            })
            .collect();
        schedule_jobs(jobs, &|id| {
            acquire_one(id);
            on_update();
        });
    }
    if finish_bootstrap {
        with_store(|stored| {
            stored.bootstrapped = true;
            for tool in stored.tools.values_mut() {
                tool.busy = false;
            }
        });
        on_update();
    }
}

pub fn managed_tool_block_reason(tool_key: &str) -> Option<String> {
    let id = catalog_alias(tool_key)?;
    let row = read_tool_catalog()
        .rows
        .into_iter()
        .find(|row| row.id == id)?;
    if row.enabled {
        None
    } else {
        Some(format!("工具「{}」已在设置里关闭", row.name))
    }
}

fn catalog_alias(tool_key: &str) -> Option<&'static str> {
    Some(match tool_key {
        "git" => "git",
        "node" | "nodejs" | "npm" | "npx" => "node",
        "uv" | "uvx" => "uv",
        "rg" | "ripgrep" => "ripgrep",
        "go" => "go",
        "java" | "javac" | "mvn" | "maven" => "java-maven",
        "rust" | "rustc" | "cargo" => "rust",
        "ruby" => "ruby",
        "php" => "php",
        "dotnet" => "dotnet",
        "ffmpeg" => "ffmpeg",
        "inkscape" => "inkscape",
        "pdftotext" | "pdfinfo" | "pdftoppm" | "poppler" => "poppler",
        "ssh" | "scp" | "sftp" | "openssh" => "openssh",
        "redis" | "redis-server" | "redis-cli" => "redis",
        "chromium" => "chromium",
        _ => return None,
    })
}

fn needs_fetch(fetchable: bool, enabled: bool, availability: ToolAvailability) -> bool {
    fetchable && enabled && availability != ToolAvailability::Installed
}

fn acquire_one(id: &str) {
    let Some(spec) = specs().iter().copied().find(|spec| spec.id == id) else {
        return;
    };
    let proceed = with_store(|stored| {
        let Some(tool) = stored.tools.get_mut(id) else {
            return false;
        };
        if !tool.enabled || tool.availability == "installed" || !spec.fetchable() {
            tool.busy = false;
            return false;
        }
        tool.busy = true;
        true
    });
    if !proceed {
        return;
    }
    let fetched = run_fetch(spec);
    let hit = probe_spec(&spec, &ProbeCtx::for_spec(spec));
    with_store(|stored| {
        let Some(tool) = stored.tools.get_mut(id) else {
            return;
        };
        if hit.availability == ToolAvailability::Installed {
            apply_hit(tool, hit);
            return;
        }
        let previous_location = tool.location.clone();
        let previous_version = tool.version.clone();
        tool.busy = false;
        tool.availability = "failed".into();
        tool.location = hit.location.or(previous_location);
        tool.version = hit.version.or(previous_version);
        tool.message = Some(match fetched {
            Err(err) => err,
            Ok(()) => hit
                .message
                .unwrap_or_else(|| "获取命令已结束，但本机仍未找到。".into()),
        });
    });
}

fn run_fetch(spec: Spec) -> Result<(), String> {
    match spec.fetch {
        Fetch::None => Err("这个工具只检查本机，不会自动安装。".into()),
        Fetch::Scoop(pkgs) => scoop_install(pkgs),
        Fetch::Npm(pkg) => npm_install(pkg),
        Fetch::Pip(pkg) => pip_install(pkg),
        Fetch::Playwright => playwright_install(),
        Fetch::Ocr => ocr_fetch(),
        Fetch::FontWasm => fontwasm_fetch(),
        Fetch::Rustup => rustup_install(),
    }
}

fn scoop_install(pkgs: &[&str]) -> Result<(), String> {
    if which_bin("scoop").is_none() {
        return Err("未找到 Scoop，无法获取。装好 Scoop 后可在详情里重试。".into());
    }
    let mut args = vec!["install".to_string()];
    args.extend(pkgs.iter().map(|pkg| (*pkg).to_string()));
    let out = run_program("scoop", &args)?;
    if out.code != 0 {
        return Err(command_error("scoop", &out));
    }
    Ok(())
}

fn npm_install(pkg: &str) -> Result<(), String> {
    if which_bin("npm").is_none() {
        return Err("需要 Node.js（含 npm）才能获取。".into());
    }
    let out = run_program(
        "npm",
        &[
            "install".into(),
            "-g".into(),
            "--no-fund".into(),
            "--no-audit".into(),
            pkg.into(),
        ],
    )?;
    if out.code != 0 {
        return Err(command_error("npm", &out));
    }
    Ok(())
}

fn playwright_install() -> Result<(), String> {
    if which_bin("npx").is_none() {
        return Err("需要 Node.js（npx）才能下载 Playwright 浏览器。".into());
    }
    let out = run_program(
        "npx",
        &[
            "--yes".into(),
            "playwright".into(),
            "install".into(),
            "chromium".into(),
        ],
    )?;
    if out.code != 0 {
        return Err(command_error("npx playwright", &out));
    }
    Ok(())
}

fn pip_install(pkg: &str) -> Result<(), String> {
    let python = ensure_venv()?;
    if which_bin("uv").is_some() {
        let out = run_program(
            "uv",
            &[
                "pip".into(),
                "install".into(),
                "--python".into(),
                python.display().to_string(),
                pkg.into(),
            ],
        )?;
        if out.code != 0 {
            return Err(command_error("uv pip", &out));
        }
        return Ok(());
    }
    let out = run_program_path(
        &python,
        &[
            "-m".into(),
            "pip".into(),
            "install".into(),
            "--disable-pip-version-check".into(),
            pkg.into(),
        ],
    )?;
    if out.code != 0 {
        return Err(command_error("pip", &out));
    }
    Ok(())
}

fn ensure_venv() -> Result<PathBuf, String> {
    let root = tools_directory().join("py");
    let python = venv_python(&root);
    if python.is_file() {
        return Ok(python);
    }
    fs::create_dir_all(tools_directory()).map_err(|err| format!("无法创建工具目录：{err}"))?;
    if which_bin("uv").is_some() {
        let out = run_program("uv", &["venv".into(), root.display().to_string()])?;
        if out.code != 0 {
            return Err(command_error("uv venv", &out));
        }
    } else if which_bin("python").is_some() || which_bin("python3").is_some() {
        let program = if which_bin("python").is_some() {
            "python"
        } else {
            "python3"
        };
        let out = run_program(
            program,
            &["-m".into(), "venv".into(), root.display().to_string()],
        )?;
        if out.code != 0 {
            return Err(command_error(program, &out));
        }
    } else {
        return Err("需要 uv 或 Python 才能获取。".into());
    }
    if python.is_file() {
        Ok(python)
    } else {
        Err("虚拟环境已创建，但没有找到 python。".into())
    }
}

fn fontwasm_fetch() -> Result<(), String> {
    let Some(path) = find_tool("node") else {
        return Err("需要 Node.js 24 或更高版本才能获取 Fontwasm。".into());
    };
    match version_of(&path, &["-v"]).as_deref().and_then(parse_major) {
        Some(major) if major >= 24 => Err("没有可自动下载的 Fontwasm 包。".into()),
        Some(major) => Err(format!("需要 Node.js 24 或更高版本，当前是 {major}。")),
        None => Err("需要 Node.js 24 或更高版本才能获取 Fontwasm。".into()),
    }
}

fn rustup_install() -> Result<(), String> {
    if which_bin("rustup").is_none() {
        return Err("未找到 rustup，无法获取 Rust。".into());
    }
    let out = run_program(
        "rustup",
        &["toolchain".into(), "install".into(), "stable".into()],
    )?;
    if out.code != 0 {
        return Err(command_error("rustup", &out));
    }
    Ok(())
}

fn ocr_fetch() -> Result<(), String> {
    match crate::ocr::ocr_ensure_models(true) {
        Ok(status) if status.ready => Ok(()),
        Ok(status) => Err(status
            .message
            .unwrap_or_else(|| format!("仍缺 {}", status.missing.join("、")))),
        Err(err) => Err(err.to_string()),
    }
}

struct Hit {
    availability: ToolAvailability,
    location: Option<String>,
    version: Option<String>,
    message: Option<String>,
}

impl Hit {
    fn installed(path: impl AsRef<Path>, version: Option<String>) -> Self {
        Self {
            availability: ToolAvailability::Installed,
            location: Some(path.as_ref().display().to_string()),
            version,
            message: None,
        }
    }

    fn missing() -> Self {
        Self {
            availability: ToolAvailability::Missing,
            location: None,
            version: None,
            message: None,
        }
    }

    fn missing_msg(message: impl Into<String>) -> Self {
        Self {
            availability: ToolAvailability::Missing,
            location: None,
            version: None,
            message: Some(message.into()),
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self {
            availability: ToolAvailability::Failed,
            location: None,
            version: None,
            message: Some(message.into()),
        }
    }
}

struct ProbeCtx {
    py: HashMap<String, PathBuf>,
    node_major: Option<u32>,
    npm_prefix: Option<PathBuf>,
}

impl ProbeCtx {
    fn empty() -> Self {
        Self {
            py: HashMap::new(),
            node_major: None,
            npm_prefix: None,
        }
    }

    fn full() -> Self {
        let mut ctx = Self::empty();
        ctx.fill_python();
        ctx.fill_node();
        ctx
    }

    fn for_spec(spec: Spec) -> Self {
        let mut ctx = Self::empty();
        match spec.id {
            "matplotlib" | "plotly" | "altair" | "bokeh" | "cairo" => ctx.fill_python(),
            "node" | "mermaid" | "browser-mcp" | "fontwasm" | "playwright" => ctx.fill_node(),
            _ => {}
        }
        ctx
    }

    fn fill_python(&mut self) {
        let mods = ["matplotlib", "plotly", "altair", "bokeh", "cairo"];
        for python in python_candidates() {
            for (name, ok) in query_python_modules(&python, &mods) {
                if ok {
                    self.py.entry(name).or_insert(python.clone());
                }
            }
        }
    }

    fn fill_node(&mut self) {
        if let Some(path) = find_tool("node") {
            self.node_major = version_of(&path, &["-v"]).as_deref().and_then(parse_major);
        }
        if which_bin("npm").is_some()
            && let Ok(out) = run_program("npm", &["prefix".into(), "-g".into()])
            && out.code == 0
            && let Some(prefix) = first_line(&out.stdout)
        {
            self.npm_prefix = Some(PathBuf::from(prefix));
        }
    }
}

fn probe_spec(spec: &Spec, ctx: &ProbeCtx) -> Hit {
    match spec.id {
        "uv" => probe_any(&["uv"], &["--version"]),
        "node" => probe_node(),
        "git" => probe_any(&["git"], &["--version"]),
        "ripgrep" => probe_any(&["rg"], &["--version"]),
        "chromium" => probe_chromium(),
        "playwright" => probe_playwright(),
        "browser-mcp" => probe_npm_or_bin(ctx, "@playwright/mcp", &["playwright-mcp"]),
        "poppler" => probe_poppler(),
        "cairo" => probe_cairo(ctx),
        "mermaid" => probe_npm_or_bin(ctx, "@mermaid-js/mermaid-cli", &["mmdc"]),
        "fontwasm" => probe_fontwasm(ctx),
        "pp-ocr" => probe_ocr(),
        "inkscape" => probe_any(&["inkscape"], &["--version"]),
        "ffmpeg" => probe_any(&["ffmpeg"], &["-version"]),
        "openssh" => probe_any(&["ssh"], &["-V"]),
        "sshfs" => probe_any(&["sshfs"], &[]),
        "go" => probe_any(&["go"], &["version"]),
        "java-maven" => probe_all(&["java", "mvn"], &["-version"]),
        "rust" => probe_all(&["rustc", "cargo"], &["--version"]),
        "ruby" => probe_any(&["ruby"], &["-v"]),
        "php" => probe_any(&["php"], &["-v"]),
        "dotnet" => probe_any(&["dotnet"], &["--version"]),
        "webview2" => probe_webview2(),
        "redis" => probe_any(&["redis-server", "redis-cli"], &["--version"]),
        "nsis" => probe_any(&["makensis"], &[]),
        "inno" => probe_any(&["ISCC", "iscc"], &[]),
        "readelf" => probe_any(&["readelf", "llvm-readelf"], &["--version"]),
        "matplotlib" => probe_python(ctx, "matplotlib"),
        "plotly" => probe_python(ctx, "plotly"),
        "altair" => probe_python(ctx, "altair"),
        "bokeh" => probe_python(ctx, "bokeh"),
        _ => Hit::missing(),
    }
}

fn probe_any(names: &[&str], version_args: &[&str]) -> Hit {
    let Some(path) = find_first(names) else {
        return Hit::missing();
    };
    Hit::installed(&path, version_of(&path, version_args))
}

fn probe_all(names: &[&str], version_args: &[&str]) -> Hit {
    let found: Vec<_> = names
        .iter()
        .filter_map(|name| find_tool(name).map(|path| (*name, path)))
        .collect();
    if found.len() == names.len() {
        return Hit::installed(&found[0].1, version_of(&found[0].1, version_args));
    }
    if found.is_empty() {
        return Hit::missing();
    }
    let have = found
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join("、");
    let lack = names
        .iter()
        .copied()
        .filter(|name| found.iter().all(|(have, _)| have != name))
        .collect::<Vec<_>>()
        .join("、");
    Hit {
        availability: ToolAvailability::Missing,
        location: Some(found[0].1.display().to_string()),
        version: None,
        message: Some(format!("已找到 {have}，还缺 {lack}")),
    }
}

fn probe_node() -> Hit {
    let Some(path) = find_tool("node") else {
        return Hit::missing();
    };
    let version = version_of(&path, &["-v"]);
    let mut hit = Hit::installed(&path, version);
    if let Some(parent) = path.parent() {
        let npm = parent.join(exe_name("npm"));
        let npm_cmd = parent.join("npm.cmd");
        if !npm.is_file() && !npm_cmd.is_file() && which_bin("npm").is_none() {
            hit.message = Some("已找到 Node.js，同目录没有 npm。".into());
        }
    }
    hit
}

fn probe_chromium() -> Hit {
    if let Some(path) = find_tool("chromium") {
        return Hit::installed(path, None);
    }
    if let Some(home) = dirs::home_dir() {
        let scooped = home
            .join("scoop")
            .join("apps")
            .join("chromium")
            .join("current")
            .join("chrome.exe");
        if scooped.is_file() {
            return Hit::installed(scooped, None);
        }
    }
    let bundled = tools_directory().join("chromium").join("chrome.exe");
    if bundled.is_file() {
        Hit::installed(bundled, None)
    } else {
        Hit::missing()
    }
}

fn probe_playwright() -> Hit {
    if let Some(dir) = playwright_dir() {
        return Hit::installed(dir, None);
    }
    Hit::missing()
}

fn probe_npm_or_bin(ctx: &ProbeCtx, pkg: &str, bins: &[&str]) -> Hit {
    if let Some(path) = find_first(bins) {
        return Hit::installed(path, None);
    }
    if npm_installed(ctx, pkg) {
        return Hit::installed(
            ctx.npm_prefix.clone().unwrap_or_else(|| PathBuf::from(pkg)),
            None,
        );
    }
    Hit::missing()
}

fn probe_poppler() -> Hit {
    if let Some(path) = find_first(&["pdftotext", "pdfinfo", "pdftoppm"]) {
        return Hit::installed(path, None);
    }
    if let Some(dir) = scoop_app("poppler") {
        return Hit::installed(dir, None);
    }
    Hit::missing()
}

fn probe_cairo(ctx: &ProbeCtx) -> Hit {
    if let Some(path) = ctx.py.get("cairo") {
        return Hit::installed(path, None);
    }
    if let Some(dir) = scoop_app("cairo") {
        return Hit::installed(dir, None);
    }
    Hit::missing()
}

fn probe_fontwasm(ctx: &ProbeCtx) -> Hit {
    let marker = tools_directory().join("fontwasm");
    if marker.is_dir() && ctx.node_major.is_some_and(|major| major >= 24) {
        return Hit::installed(marker, ctx.node_major.map(|major| format!("node {major}")));
    }
    Hit::missing()
}

fn probe_ocr() -> Hit {
    match crate::ocr::ocr_status() {
        Ok(status) if status.ready => Hit::installed(PathBuf::from(status.model_dir), None),
        Ok(status) => Hit::missing_msg(
            status
                .message
                .unwrap_or_else(|| format!("缺少 {} 个模型文件", status.missing.len())),
        ),
        Err(err) => Hit::failed(err.to_string()),
    }
}

fn probe_python(ctx: &ProbeCtx, module: &str) -> Hit {
    ctx.py
        .get(module)
        .map(|path| Hit::installed(path, None))
        .unwrap_or_else(Hit::missing)
}

fn probe_webview2() -> Hit {
    if let Some(version) = webview2_version() {
        return Hit {
            availability: ToolAvailability::Installed,
            location: Some("WebView2 Runtime".into()),
            version: Some(version),
            message: None,
        };
    }
    Hit::missing()
}

fn playwright_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    [
        home.join("AppData").join("Local").join("ms-playwright"),
        home.join(".cache").join("ms-playwright"),
    ]
    .into_iter()
    .find(|dir| has_chromium_dir(dir))
}

fn has_chromium_dir(dir: &Path) -> bool {
    fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .starts_with("chromium")
        })
}

fn npm_installed(ctx: &ProbeCtx, pkg: &str) -> bool {
    ctx.npm_prefix
        .as_ref()
        .is_some_and(|prefix| prefix.join("node_modules").join(pkg).is_dir())
}

fn webview2_version() -> Option<String> {
    const GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    let keys = [
        format!(r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{GUID}"),
        format!(r"HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{GUID}"),
        format!(r"HKCU\Software\Microsoft\EdgeUpdate\Clients\{GUID}"),
    ];
    for key in keys {
        if let Some(version) = reg_value(&key, "pv")
            && version != "0.0.0.0"
        {
            return Some(version);
        }
    }
    let roots = [
        PathBuf::from(r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application"),
        PathBuf::from(r"C:\Program Files\Microsoft\EdgeWebView\Application"),
    ];
    for root in roots {
        if root.is_dir() {
            return Some(root.display().to_string());
        }
    }
    None
}

fn reg_value(key: &str, name: &str) -> Option<String> {
    let out = run_program(
        "reg",
        &["query".into(), key.into(), "/v".into(), name.into()],
    )
    .ok()?;
    if out.code != 0 {
        return None;
    }
    for line in out.stdout.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix(name) else {
            continue;
        };
        let mut parts = rest.split_whitespace();
        let _kind = parts.next()?;
        let value = parts.collect::<Vec<_>>().join(" ");
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

fn find_first(names: &[&str]) -> Option<PathBuf> {
    names.iter().find_map(|name| find_tool(name))
}

fn find_tool(name: &str) -> Option<PathBuf> {
    if let Some(found) = which_bin(name) {
        let path = PathBuf::from(found);
        if path.exists() {
            return Some(path);
        }
    }
    known_locations(name)
        .into_iter()
        .find(|path| path.is_file())
}

fn known_locations(name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    out.push(tools_directory().join("bin").join(exe_name(name)));
    if let Some(home) = dirs::home_dir() {
        out.push(home.join("scoop").join("shims").join(exe_name(name)));
    }
    match name {
        "inkscape" => {
            for root in program_dirs() {
                out.push(root.join("Inkscape").join("bin").join("inkscape.exe"));
            }
        }
        "ISCC" | "iscc" => {
            for root in program_dirs() {
                out.push(root.join("Inno Setup 6").join("ISCC.exe"));
            }
        }
        "makensis" => {
            for root in program_dirs() {
                out.push(root.join("NSIS").join("makensis.exe"));
                out.push(root.join("NSIS").join("Bin").join("makensis.exe"));
            }
        }
        "llvm-readelf" | "readelf" => {
            for root in program_dirs() {
                out.push(root.join("LLVM").join("bin").join("llvm-readelf.exe"));
                out.push(root.join("LLVM").join("bin").join("readelf.exe"));
            }
        }
        "ssh" => out.push(PathBuf::from(r"C:\Windows\System32\OpenSSH\ssh.exe")),
        "sshfs" => {
            for root in program_dirs() {
                out.push(root.join("SSHFS-Win").join("bin").join("sshfs.exe"));
            }
        }
        _ => {}
    }
    out
}

fn scoop_app(name: &str) -> Option<PathBuf> {
    let dir = dirs::home_dir()?
        .join("scoop")
        .join("apps")
        .join(name)
        .join("current");
    dir.is_dir().then_some(dir)
}

fn program_dirs() -> Vec<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok())
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .collect()
}

fn exe_name(name: &str) -> String {
    if cfg!(windows) && !name.contains('.') {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn python_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(path) = find_tool("python").or_else(|| find_tool("python3")) {
        out.push(path);
    }
    let venv = venv_python(&tools_directory().join("py"));
    if venv.is_file() && out.iter().all(|path| path != &venv) {
        out.push(venv);
    }
    out
}

fn venv_python(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.join("Scripts").join("python.exe")
    } else {
        root.join("bin").join("python")
    }
}

fn query_python_modules(python: &Path, mods: &[&str]) -> HashMap<String, bool> {
    let list = mods
        .iter()
        .map(|module| format!("'{module}'"))
        .collect::<Vec<_>>()
        .join(",");
    let code = format!(
        "import importlib.util\nmods=[{list}]\nfor m in mods:\n    print(m + ('\\t1' if importlib.util.find_spec(m) else '\\t0'))\n"
    );
    let mut map = HashMap::new();
    let Ok(out) = run_program_path(python, &["-c".into(), code]) else {
        return map;
    };
    for line in out.stdout.lines() {
        let mut parts = line.split('\t');
        if let (Some(name), Some(flag)) = (parts.next(), parts.next()) {
            map.insert(name.to_string(), flag.trim() == "1");
        }
    }
    map
}

fn version_of(path: &Path, args: &[&str]) -> Option<String> {
    if args.is_empty() {
        return None;
    }
    let args = args
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    let out = run_program_path(path, &args).ok()?;
    first_line(&out.stdout).or_else(|| first_line(&out.stderr))
}

fn parse_major(version: &str) -> Option<u32> {
    version
        .trim()
        .trim_start_matches('v')
        .split(['.', ' ', '-'])
        .next()?
        .parse()
        .ok()
}

struct CmdOut {
    code: i32,
    stdout: String,
    stderr: String,
}

fn run_program(program: &str, args: &[String]) -> Result<CmdOut, String> {
    let resolved = which_bin(program).unwrap_or_else(|| program.to_string());
    run_resolved(&resolved, args, program)
}

fn run_program_path(path: &Path, args: &[String]) -> Result<CmdOut, String> {
    let label = path.display().to_string();
    run_resolved(&label, args, &label)
}

/// Extensionless `scoop` and `npm` shims are shell scripts. Run the sibling `.cmd` or `.exe`.
fn resolve_launcher(resolved: &str) -> String {
    let lower = resolved.to_ascii_lowercase();
    if lower.ends_with(".exe")
        || lower.ends_with(".cmd")
        || lower.ends_with(".bat")
        || lower.ends_with(".com")
    {
        return resolved.to_string();
    }
    #[cfg(windows)]
    {
        let path = Path::new(resolved);
        for ext in ["exe", "cmd", "bat", "com"] {
            let candidate = path.with_extension(ext);
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    resolved.to_string()
}

fn run_resolved(resolved: &str, args: &[String], label: &str) -> Result<CmdOut, String> {
    let resolved = resolve_launcher(resolved);
    let mut cmd = Command::new(&resolved);
    cmd.args(args);
    hide_console(&mut cmd);
    cmd.stdin(Stdio::null());
    cmd.env("CI", "1");
    match cmd.output() {
        Ok(out) => Ok(CmdOut {
            code: out.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }),
        Err(err) => Err(format!("无法运行 {label}：{err}")),
    }
}

#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

fn command_error(program: &str, out: &CmdOut) -> String {
    let detail = last_line(&out.stderr)
        .or_else(|| last_line(&out.stdout))
        .unwrap_or_else(|| "没有输出".into());
    format!("{program} 退出码 {}：{detail}", out.code)
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(120).collect())
}

fn last_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .map(|line| line.chars().take(240).collect())
}

struct Sched {
    queue: VecDeque<(String, Lane)>,
    inflight: usize,
    scoop: bool,
    node: bool,
    python: bool,
}

fn schedule_jobs(jobs: Vec<(String, Lane)>, run: &(dyn Fn(&str) + Sync)) {
    if jobs.is_empty() {
        return;
    }
    let state = Mutex::new(Sched {
        queue: VecDeque::from(jobs),
        inflight: 0,
        scoop: false,
        node: false,
        python: false,
    });
    let cv = Condvar::new();
    thread::scope(|scope| {
        for _ in 0..2 {
            scope.spawn(|| worker(&state, &cv, run));
        }
    });
}

fn worker(state: &Mutex<Sched>, cv: &Condvar, run: &(dyn Fn(&str) + Sync)) {
    loop {
        let job = {
            let mut guard = state.lock().unwrap();
            loop {
                if let Some(pos) = guard
                    .queue
                    .iter()
                    .position(|(_, lane)| lane_free(&guard, *lane))
                {
                    let job = guard.queue.remove(pos).expect("queued job");
                    guard.inflight += 1;
                    mark(&mut guard, job.1, true);
                    break job;
                }
                if guard.queue.is_empty() {
                    return;
                }
                guard = cv.wait(guard).unwrap();
            }
        };
        run(&job.0);
        let mut guard = state.lock().unwrap();
        guard.inflight = guard.inflight.saturating_sub(1);
        mark(&mut guard, job.1, false);
        cv.notify_all();
    }
}

fn lane_free(sched: &Sched, lane: Lane) -> bool {
    if sched.inflight >= 2 {
        return false;
    }
    match lane {
        Lane::Scoop => !sched.scoop,
        Lane::Node => !sched.node,
        Lane::Python => !sched.python,
        Lane::Free => true,
    }
}

fn mark(sched: &mut Sched, lane: Lane, busy: bool) {
    match lane {
        Lane::Scoop => sched.scoop = busy,
        Lane::Node => sched.node = busy,
        Lane::Python => sched.python = busy,
        Lane::Free => {}
    }
}

fn timestamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

fn catalog_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn catalog_file() -> PathBuf {
    tools_directory().join("catalog.json")
}

fn with_store<T>(f: impl FnOnce(&mut StoredCatalog) -> T) -> T {
    let _guard = catalog_lock().lock().unwrap();
    let mut stored = read_store_unlocked();
    let out = f(&mut stored);
    write_store_unlocked(&stored);
    out
}

fn read_store_unlocked() -> StoredCatalog {
    let Ok(text) = fs::read_to_string(catalog_file()) else {
        return default_store();
    };
    let mut stored: StoredCatalog = serde_json::from_str(&text).unwrap_or_else(|_| default_store());
    for spec in specs() {
        stored.tools.entry(spec.id.to_string()).or_default();
    }
    stored
}

fn write_store_unlocked(stored: &StoredCatalog) {
    let path = catalog_file();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let Ok(text) = serde_json::to_string_pretty(stored) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, text).is_ok() {
        let _ = fs::remove_file(&path);
        if fs::rename(&tmp, &path).is_err() {
            let _ = fs::write(&path, fs::read(&tmp).unwrap_or_default());
        }
    }
}

fn catalog_from_store(stored: &StoredCatalog) -> ToolCatalog {
    let rows = specs()
        .iter()
        .map(|spec| {
            let saved = stored.tools.get(spec.id);
            ToolRow {
                id: spec.id,
                name: spec.name,
                description: spec.description,
                category: spec.category,
                availability: saved
                    .map(|tool| parse_availability(&tool.availability))
                    .unwrap_or(ToolAvailability::Missing),
                enabled: saved.map(|tool| tool.enabled).unwrap_or(true),
                location: saved.and_then(|tool| tool.location.clone()),
                version: saved.and_then(|tool| tool.version.clone()),
                message: saved.and_then(|tool| tool.message.clone()),
                busy: saved.is_some_and(|tool| tool.busy),
                fetchable: spec.fetchable(),
                lane_label: spec.lane_label(),
                install_guide: spec.install_guide(),
            }
        })
        .collect();
    ToolCatalog {
        tools_dir: tools_directory().display().to_string(),
        scanned_at: stored.scanned_at.clone(),
        bootstrapped: stored.bootstrapped,
        rows,
    }
}

fn apply_hit(tool: &mut StoredTool, hit: Hit) {
    let enabled = tool.enabled;
    // A later scan should not forget a failed fetch while the tool is still missing.
    if tool.availability == "failed" && hit.availability == ToolAvailability::Missing {
        tool.enabled = enabled;
        tool.busy = false;
        if hit.location.is_some() {
            tool.location = hit.location;
        }
        if hit.version.is_some() {
            tool.version = hit.version;
        }
        return;
    }
    *tool = StoredTool {
        enabled,
        availability: availability_name(hit.availability).into(),
        location: hit.location,
        version: hit.version,
        message: hit.message,
        busy: false,
    };
}

fn parse_availability(raw: &str) -> ToolAvailability {
    match raw {
        "installed" => ToolAvailability::Installed,
        "failed" => ToolAvailability::Failed,
        _ => ToolAvailability::Missing,
    }
}

fn availability_name(kind: ToolAvailability) -> &'static str {
    match kind {
        ToolAvailability::Installed => "installed",
        ToolAvailability::Missing => "missing",
        ToolAvailability::Failed => "failed",
    }
}

fn default_store() -> StoredCatalog {
    let mut tools = HashMap::new();
    for spec in specs() {
        tools.insert(spec.id.to_string(), StoredTool::default());
    }
    StoredCatalog {
        scanned_at: None,
        bootstrapped: false,
        tools,
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCatalog {
    #[serde(default)]
    scanned_at: Option<String>,
    #[serde(default)]
    bootstrapped: bool,
    #[serde(default)]
    tools: HashMap<String, StoredTool>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTool {
    #[serde(default = "default_enabled")]
    enabled: bool,
    #[serde(default = "default_missing")]
    availability: String,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    busy: bool,
}

impl Default for StoredTool {
    fn default() -> Self {
        Self {
            enabled: true,
            availability: default_missing(),
            location: None,
            version: None,
            message: None,
            busy: false,
        }
    }
}

fn default_enabled() -> bool {
    true
}

fn default_missing() -> String {
    "missing".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[cfg(windows)]
    #[test]
    fn launcher_uses_sibling_cmd_instead_of_shell_script() {
        let dir = std::env::temp_dir().join(format!("wb-launcher-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("npm");
        let cmd = dir.join("npm.cmd");
        fs::write(&script, "#!/bin/sh\necho no\n").unwrap();
        fs::write(&cmd, "@echo off\r\n").unwrap();
        let resolved = resolve_launcher(&script.display().to_string());
        assert_eq!(resolved, cmd.display().to_string());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn catalog_matches_the_settings_groups() {
        let specs = specs();
        assert_eq!(specs.len(), 31);
        let mut ids = specs.iter().map(|spec| spec.id).collect::<Vec<_>>();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 31);
        let count = |category| {
            specs
                .iter()
                .filter(|spec| spec.category == category)
                .count()
        };
        assert_eq!(count(ToolCategory::Runtime), 4);
        assert_eq!(count(ToolCategory::Browser), 3);
        assert_eq!(count(ToolCategory::Docs), 7);
        assert_eq!(count(ToolCategory::Remote), 2);
        assert_eq!(count(ToolCategory::Language), 6);
        assert_eq!(count(ToolCategory::Package), 5);
        assert_eq!(count(ToolCategory::Chart), 4);
        assert!(
            specs
                .iter()
                .any(|spec| spec.id == "node" && !spec.fetchable())
        );
        assert!(
            specs
                .iter()
                .any(|spec| spec.id == "uv" && !spec.fetchable())
        );
        assert!(
            specs
                .iter()
                .any(|spec| spec.id == "matplotlib" && spec.fetchable())
        );
        let catalog = catalog_from_store(&default_store());
        assert!(catalog.rows.iter().all(|row| !row.install_guide.is_empty()));
        assert!(
            catalog
                .row("git")
                .unwrap()
                .install_guide
                .contains("scoop install git")
        );
        assert!(
            catalog
                .row("pp-ocr")
                .unwrap()
                .install_guide
                .contains("PP-OCRv6")
        );
    }

    #[test]
    fn scan_keeps_a_failed_fetch_until_the_tool_appears() {
        let mut tool = StoredTool {
            availability: "failed".into(),
            message: Some("未找到 Scoop".into()),
            ..StoredTool::default()
        };
        apply_hit(&mut tool, Hit::missing());
        assert_eq!(tool.availability, "failed");
        assert_eq!(tool.message.as_deref(), Some("未找到 Scoop"));
        apply_hit(
            &mut tool,
            Hit::installed(std::path::PathBuf::from("git.exe"), None),
        );
        assert_eq!(tool.availability, "installed");
    }

    #[test]
    fn pending_fetch_skips_installed_and_disabled() {
        assert!(needs_fetch(true, true, ToolAvailability::Missing));
        assert!(needs_fetch(true, true, ToolAvailability::Failed));
        assert!(!needs_fetch(true, true, ToolAvailability::Installed));
        assert!(!needs_fetch(true, false, ToolAvailability::Missing));
        assert!(!needs_fetch(false, true, ToolAvailability::Missing));
    }

    #[test]
    fn scheduler_caps_parallelism_and_keeps_a_lane_exclusive() {
        let current = AtomicUsize::new(0);
        let max = AtomicUsize::new(0);
        let python_current = AtomicUsize::new(0);
        let python_max = AtomicUsize::new(0);
        let ran = AtomicUsize::new(0);
        let jobs = vec![
            ("p1".into(), Lane::Python),
            ("p2".into(), Lane::Python),
            ("p3".into(), Lane::Python),
            ("f1".into(), Lane::Free),
            ("f2".into(), Lane::Free),
            ("f3".into(), Lane::Free),
        ];
        schedule_jobs(jobs, &|id| {
            let now = current.fetch_add(1, Ordering::SeqCst) + 1;
            max.fetch_max(now, Ordering::SeqCst);
            let python = id.starts_with('p');
            if python {
                let now = python_current.fetch_add(1, Ordering::SeqCst) + 1;
                python_max.fetch_max(now, Ordering::SeqCst);
            }
            thread::sleep(std::time::Duration::from_millis(40));
            if python {
                python_current.fetch_sub(1, Ordering::SeqCst);
            }
            current.fetch_sub(1, Ordering::SeqCst);
            ran.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(ran.load(Ordering::SeqCst), 6);
        assert!(max.load(Ordering::SeqCst) <= 2);
        assert!(python_max.load(Ordering::SeqCst) <= 1);
        assert!(max.load(Ordering::SeqCst) >= 2);
    }

    #[test]
    fn stored_catalog_roundtrip_keeps_enabled_and_status() {
        let dir = std::env::temp_dir().join(format!(
            "wb-tools-{}-{}",
            std::process::id(),
            timestamp().replace([' ', ':'], "-")
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("catalog.json");
        let mut stored = default_store();
        stored.bootstrapped = true;
        stored.scanned_at = Some("2026-11-22 11:00".into());
        stored.tools.get_mut("node").unwrap().enabled = false;
        stored.tools.get_mut("git").unwrap().availability = "installed".into();
        stored.tools.get_mut("git").unwrap().location = Some(r"C:\git.exe".into());
        stored.tools.get_mut("cairo").unwrap().availability = "failed".into();
        stored.tools.get_mut("cairo").unwrap().message = Some("未找到 Scoop".into());
        let text = serde_json::to_string_pretty(&stored).unwrap();
        fs::write(&path, text).unwrap();
        let loaded: StoredCatalog =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let catalog = catalog_from_store(&loaded);
        assert!(catalog.bootstrapped);
        assert!(!catalog.row("node").unwrap().enabled);
        assert_eq!(
            catalog.row("git").unwrap().availability,
            ToolAvailability::Installed
        );
        assert_eq!(
            catalog.row("cairo").unwrap().availability,
            ToolAvailability::Failed
        );
        assert_eq!(catalog.rows.len(), 31);
        let _ = fs::remove_dir_all(&dir);
    }
}
