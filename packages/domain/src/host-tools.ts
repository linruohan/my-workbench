/**
 * Host tools the Agent may call. Detection and install happen in the desktop
 * host. This module is the catalog and the prompt/args rules shared with settings.
 */

export type HostToolCategory =
  "runtime" | "browser" | "document" | "remote" | "language" | "package" | "chart";

export type HostToolInstall = "auto" | "manual";

/** Installs that share a directory or package manager stay in one lane. */
export type HostToolLane = "none" | "scoop" | "python" | "node";

export type HostToolSpec = {
  id: string;
  name: string;
  category: HostToolCategory;
  summary: string;
  /** How the agent should fill host_tool_run.args. */
  usage: string;
  install: HostToolInstall;
  /** argv after the executable, used only to probe a version. */
  versionArgs: string[];
  /** Executable names the agent may pass as host_tool_run.bin. The first is the default. */
  programs: readonly string[];
  lane: HostToolLane;
};

export type HostToolProbe = {
  id: string;
  status: "ready" | "missing";
  source: "env" | "managed" | "manual" | "none";
  path: string;
  version: string;
  /** Executable the host will launch. Args are appended by host_tool_run. */
  invoke: string[];
};

export type HostToolSnapshot = HostToolSpec & {
  status: "ready" | "missing";
  source: "env" | "managed" | "manual" | "none";
  path: string;
  version: string;
  invoke: string[];
  enabled: boolean;
};

export const HOST_TOOL_CATEGORY_LABEL: Record<HostToolCategory, string> = {
  runtime: "基础运行时",
  browser: "浏览器",
  document: "文档与图片",
  remote: "远程开发",
  language: "语言工具",
  package: "打包工具",
  chart: "图表",
};

const PYTHON_USAGE =
  'args 是 Python 的参数数组，不是 shell。示例：["-c", "import 库并写入绝对路径"]。应用装上的库会由宿主加进 PYTHONPATH。';

function tool(
  spec: Omit<HostToolSpec, "install" | "lane"> & { lane?: HostToolLane },
): HostToolSpec {
  return { install: "auto", lane: spec.lane ?? "none", ...spec };
}

export const HOST_TOOL_CATALOG: readonly HostToolSpec[] = [
  tool({
    id: "uv",
    name: "uv",
    category: "runtime",
    summary: "安装和运行 Python。uv 管环境和包，uvx 临时运行命令",
    usage:
      'bin 用 uv 或 uvx。args 示例：["pip", "install", "包名"]，或 uvx 的 ["ruff", "check", "."]。',
    versionArgs: ["--version"],
    programs: ["uv", "uvx"],
  }),
  tool({
    id: "node",
    name: "Node.js",
    category: "runtime",
    summary: "Node.js，以及同目录的 npm 和 npx",
    usage:
      'bin 用 node、npm 或 npx。args 示例：["--version"] 或 npm 的 ["install", "包名"]。',
    versionArgs: ["--version"],
    programs: ["node", "npm", "npx"],
    lane: "node",
  }),
  tool({
    id: "git",
    name: "Git",
    category: "runtime",
    summary: "查看和操作仓库",
    usage:
      'args 示例：["status"] 或 ["diff"]。不要用会改写历史的命令，除非用户明确要求。',
    versionArgs: ["--version"],
    programs: ["git"],
    lane: "scoop",
  }),
  tool({
    id: "ripgrep",
    name: "ripgrep",
    category: "runtime",
    summary: "按内容快速搜索文件",
    usage: 'args 示例：["-n", "关键词", "."]。不要用管道。',
    versionArgs: ["--version"],
    programs: ["rg"],
  }),
  tool({
    id: "chromium",
    name: "Chromium",
    category: "browser",
    summary: "独立的 Chromium 浏览器",
    usage:
      'args 示例：["--headless", "--dump-dom", "https://example.com"]。不要带会改掉用户主配置的参数。',
    versionArgs: ["--version"],
    programs: ["chromium"],
    lane: "scoop",
  }),
  tool({
    id: "playwright",
    name: "Playwright",
    category: "browser",
    summary: "Playwright 自带的浏览器，用来跑页面和截图",
    usage:
      'args 示例：["--version"] 或 ["install", "chromium"]。浏览器文件在本机的 ms-playwright 目录。',
    versionArgs: ["--version"],
    programs: ["playwright"],
    lane: "node",
  }),
  tool({
    id: "browser-mcp",
    name: "Browser MCP",
    category: "browser",
    summary: "Playwright MCP，让助手按页面结构操作浏览器",
    usage:
      "bin 是 playwright-mcp。不传 args 会启动 MCP 服务，调用前先确认用户要开浏览器。",
    versionArgs: [],
    programs: ["playwright-mcp"],
    lane: "node",
  }),
  tool({
    id: "poppler",
    name: "Poppler",
    category: "document",
    summary: "把 PDF 转成文本或图片",
    usage: 'bin 用 pdftotext、pdfinfo 或 pdftoppm。args 示例：["输入.pdf", "输出.txt"]。',
    versionArgs: ["-v"],
    programs: ["pdftotext", "pdfinfo", "pdftoppm"],
    lane: "scoop",
  }),
  tool({
    id: "cairo",
    name: "Cairo",
    category: "document",
    summary: "矢量图形库，用来画图和渲染",
    usage: "这是图形库，没有独立命令。就绪后把路径交给要链接它的程序。",
    versionArgs: [],
    programs: ["cairo"],
    lane: "scoop",
  }),
  tool({
    id: "mermaid",
    name: "Mermaid",
    category: "document",
    summary: "把流程图、时序图、类图等 Mermaid 文本渲染成 SVG 或 PNG",
    usage:
      'args 示例：["-i", "图.mmd", "-o", "图.svg"]。支持 flowchart、sequenceDiagram、classDiagram。',
    versionArgs: ["--version"],
    programs: ["mmdc"],
    lane: "node",
  }),
  tool({
    id: "fontwasm",
    name: "Fontwasm",
    category: "document",
    summary:
      "用 WASM 字体解码器解析字体，并在 TTF、OTF、WOFF、WOFF2 之间转换。需要 Node.js 24 或更新版本",
    usage: 'args 示例：["字体.ttf", "-o", "字体.woff2"]。输出扩展名决定格式。',
    versionArgs: [],
    programs: ["web-font-codecs-cli"],
    lane: "node",
  }),
  tool({
    id: "ocr",
    name: "PP-OCRv6 small",
    category: "document",
    summary: "本地识图模型，识别图片和扫描件里的文字",
    usage: "模型就绪后，把图片发给对话即可。应用会在本地识别，不需要再传命令参数。",
    versionArgs: [],
    programs: ["ocr"],
  }),
  tool({
    id: "inkscape",
    name: "Inkscape",
    category: "document",
    summary: "编辑矢量图，用于 Logo、插画、海报和图标。放大不会发糊",
    usage: 'args 示例：["输入.svg", "--export-filename=输出.png"]。也可导出 pdf 或 svg。',
    versionArgs: ["--version"],
    programs: ["inkscape"],
    lane: "scoop",
  }),
  tool({
    id: "ffmpeg",
    name: "FFmpeg",
    category: "document",
    summary: "转码、裁剪和查看音视频",
    usage: 'args 示例：["-i", "输入文件", "输出文件"]。覆盖已有文件前先确认路径。',
    versionArgs: ["-version"],
    programs: ["ffmpeg"],
  }),
  tool({
    id: "openssh",
    name: "OpenSSH",
    category: "remote",
    summary: "用 SSH 登录远程机器，并复制文件",
    usage: 'bin 用 ssh 或 scp。args 示例：["user@host"]。不要把密码写进参数。',
    versionArgs: ["-V"],
    programs: ["ssh", "scp"],
    lane: "scoop",
  }),
  tool({
    id: "sshfs",
    name: "SSHFS",
    category: "remote",
    summary: "把远程目录挂到本地",
    usage:
      'args 示例：["user@host:/目录", "X:"]。Windows 上需要 WinFsp，安装可能要求管理员权限。',
    versionArgs: ["-V"],
    programs: ["sshfs"],
    lane: "scoop",
  }),
  tool({
    id: "go",
    name: "Go",
    category: "language",
    summary: "编译和运行 Go 程序",
    usage: 'args 示例：["version"] 或 ["run", "main.go"]。',
    versionArgs: ["version"],
    programs: ["go"],
  }),
  tool({
    id: "java",
    name: "Java / Maven",
    category: "language",
    summary: "运行 Java，并用 Maven 构建",
    usage: 'bin 用 java 或 mvn。args 示例：["-version"] 或 mvn 的 ["-q", "test"]。',
    versionArgs: ["-version"],
    programs: ["java", "mvn"],
    lane: "scoop",
  }),
  tool({
    id: "rust",
    name: "Rust",
    category: "language",
    summary: "编译 Rust。命令是 rustc.exe，旁边有 cargo.exe",
    usage: 'bin 用 rustc 或 cargo。args 示例：["build"] 或 rustc 的 ["--version"]。',
    versionArgs: ["--version"],
    programs: ["rustc", "cargo"],
  }),
  tool({
    id: "ruby",
    name: "Ruby",
    category: "language",
    summary: "运行 Ruby 脚本",
    usage: 'args 示例：["-v"] 或 ["脚本.rb"]。',
    versionArgs: ["-v"],
    programs: ["ruby"],
    lane: "scoop",
  }),
  tool({
    id: "php",
    name: "PHP",
    category: "language",
    summary: "运行 PHP 脚本",
    usage: 'args 示例：["-v"] 或 ["脚本.php"]。',
    versionArgs: ["-v"],
    programs: ["php"],
    lane: "scoop",
  }),
  tool({
    id: "dotnet",
    name: ".NET",
    category: "language",
    summary: "构建和运行 .NET 项目",
    usage: 'args 示例：["--version"] 或 ["build"]。',
    versionArgs: ["--version"],
    programs: ["dotnet"],
    lane: "scoop",
  }),
  tool({
    id: "webview2",
    name: "WebView2",
    category: "package",
    summary: "内嵌网页和安装包要用的 WebView2 运行时",
    usage: "这是系统运行时，没有命令行。就绪表示本机已经能加载 WebView2。",
    versionArgs: [],
    programs: ["webview2"],
  }),
  tool({
    id: "redis",
    name: "Redis",
    category: "package",
    summary: "本地 Redis 服务和命令行",
    usage: 'bin 用 redis-server 或 redis-cli。args 示例：["ping"]。',
    versionArgs: ["--version"],
    programs: ["redis-server", "redis-cli"],
    lane: "scoop",
  }),
  tool({
    id: "nsis",
    name: "NSIS",
    category: "package",
    summary: "用 NSIS 脚本打 Windows 安装包",
    usage: 'args 示例：["安装脚本.nsi"]。',
    versionArgs: ["/VERSION"],
    programs: ["makensis"],
    lane: "scoop",
  }),
  tool({
    id: "innosetup",
    name: "Inno Setup",
    category: "package",
    summary: "用 Inno Setup 打 Windows 安装包",
    usage: 'args 示例：["安装脚本.iss"]。',
    versionArgs: ["/?"],
    programs: ["iscc"],
    lane: "scoop",
  }),
  tool({
    id: "readelf",
    name: "readelf",
    category: "package",
    summary: "查看 ELF 文件头和符号。优先 readelf.exe，否则用 llvm-readelf.exe",
    usage: 'bin 用 readelf 或 llvm-readelf。args 示例：["-s", "程序"]。',
    versionArgs: ["--version"],
    programs: ["readelf", "llvm-readelf"],
    lane: "scoop",
  }),
  tool({
    id: "matplotlib",
    name: "Matplotlib",
    category: "chart",
    summary: "用 Python 生成静态图表",
    usage: PYTHON_USAGE,
    versionArgs: [],
    programs: ["python"],
    lane: "python",
  }),
  tool({
    id: "plotly",
    name: "Plotly",
    category: "chart",
    summary: "用 Python 生成可交互的 HTML 图表",
    usage: PYTHON_USAGE,
    versionArgs: [],
    programs: ["python"],
    lane: "python",
  }),
  tool({
    id: "altair",
    name: "Altair",
    category: "chart",
    summary: "用 Python 生成 Vega-Lite 交互图",
    usage: PYTHON_USAGE,
    versionArgs: [],
    programs: ["python"],
    lane: "python",
  }),
  tool({
    id: "bokeh",
    name: "Bokeh",
    category: "chart",
    summary: "用 Python 生成 Bokeh 交互图",
    usage: PYTHON_USAGE,
    versionArgs: [],
    programs: ["python"],
    lane: "python",
  }),
];

const CATALOG_IDS = new Set(HOST_TOOL_CATALOG.map((item) => item.id));

export function hostToolById(id: string): HostToolSpec | null {
  return HOST_TOOL_CATALOG.find((item) => item.id === id) ?? null;
}

export function assembleHostTools(
  probes: readonly HostToolProbe[],
  disabledIds: readonly string[],
): HostToolSnapshot[] {
  const disabled = new Set(disabledIds);
  const byId = new Map(probes.map((item) => [item.id, item]));
  return HOST_TOOL_CATALOG.map((spec) => {
    const hit = byId.get(spec.id);
    const ready = hit?.status === "ready" && Boolean(hit.path.trim());
    const source = ready
      ? hit?.source === "managed"
        ? "managed"
        : hit?.source === "manual"
          ? "manual"
          : "env"
      : "none";
    return {
      ...spec,
      status: ready ? "ready" : "missing",
      source,
      path: ready ? (hit?.path ?? "") : "",
      version: ready ? (hit?.version ?? "") : "",
      invoke: ready ? (hit?.invoke ?? []).filter((item) => item.trim()) : [],
      enabled: !disabled.has(spec.id),
    };
  });
}

export function setHostToolEnabled(
  disabledIds: readonly string[],
  id: string,
  enabled: boolean,
): string[] {
  const next = disabledIds.filter((item) => item !== id);
  if (!enabled && CATALOG_IDS.has(id)) next.push(id);
  return next;
}

export function formatHostToolsForPrompt(tools: readonly HostToolSnapshot[]): string {
  const ready = tools.filter((item) => item.enabled && item.status === "ready");
  if (ready.length === 0) return "";
  const lines = ready.map((item) => {
    const at = item.path ? `路径 ${item.path}` : "路径未知";
    const version = item.version ? `，版本 ${item.version}` : "";
    const bins =
      item.programs.length > 1 ? `可执行名：${item.programs.join("、")}。` : "";
    return `- ${item.id}（${item.name}）：${item.summary}。${at}${version}。${bins}${item.usage}`;
  });
  return [
    "本机已就绪的外部工具。用 host_tool_run 调用，toolId 用下面的 id，args 是字符串数组。不要拼 shell，也不要声称未列出的工具已经可用。",
    ...lines,
  ].join("\n");
}

export function parseHostToolRunArgs(
  args: Record<string, unknown>,
):
  | { ok: true; toolId: string; bin: string; args: string[]; cwd: string }
  | { ok: false; reason: string } {
  const toolId = typeof args.toolId === "string" ? args.toolId.trim() : "";
  if (!toolId) return { ok: false, reason: "请提供 toolId" };
  const spec = hostToolById(toolId);
  if (!spec) return { ok: false, reason: `未知工具 ${toolId}` };
  const requested = typeof args.bin === "string" ? args.bin.trim() : "";
  const bin = requested || spec.programs[0] || "";
  if (!bin || !spec.programs.includes(bin)) {
    return { ok: false, reason: `工具 ${toolId} 没有程序 ${requested || bin}` };
  }
  const raw = args.args;
  if (!Array.isArray(raw)) return { ok: false, reason: "args 需要字符串数组" };
  if (raw.some((item) => typeof item !== "string")) {
    return { ok: false, reason: "args 里的每一项都要是字符串" };
  }
  if (raw.length > 64) return { ok: false, reason: "参数过多" };
  const argv = raw as string[];
  if (argv.some((item) => item.includes("\0") || item.length > 32_000)) {
    return { ok: false, reason: "参数无效" };
  }
  const cwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
  return { ok: true, toolId, bin, args: argv, cwd };
}
