/**
 * Host tools the Agent may call: local CLIs, Mermaid, and Python chart libraries.
 * Detection and install happen in the desktop host. This module is the catalog
 * and the prompt/args rules shared with the settings screen.
 */

export type HostToolCategory = "cli" | "diagram" | "chart";

export type HostToolInstall = "auto" | "manual";

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
};

export type HostToolProbe = {
  id: string;
  status: "ready" | "missing";
  source: "env" | "managed" | "none";
  path: string;
  version: string;
  /** Executable the host will launch. Args are appended by host_tool_run. */
  invoke: string[];
};

export type HostToolSnapshot = HostToolSpec & {
  status: "ready" | "missing";
  source: "env" | "managed" | "none";
  path: string;
  version: string;
  invoke: string[];
  enabled: boolean;
};

export const HOST_TOOL_CATEGORY_LABEL: Record<HostToolCategory, string> = {
  cli: "命令行",
  diagram: "图示",
  chart: "图表",
};

const PYTHON_USAGE =
  'args 是 Python 的参数数组，不是 shell。示例：["-c", "import 库并写入绝对路径"]。应用装上的库会由宿主加进 PYTHONPATH。';

export const HOST_TOOL_CATALOG: readonly HostToolSpec[] = [
  {
    id: "go",
    name: "Go",
    category: "cli",
    summary: "编译和运行 Go 程序",
    usage: 'args 示例：["version"] 或 ["run", "main.go"]。',
    install: "auto",
    versionArgs: ["version"],
  },
  {
    id: "ripgrep",
    name: "ripgrep",
    category: "cli",
    summary: "按内容快速搜索文件",
    usage: 'args 示例：["-n", "关键词", "."]。不要用管道。',
    install: "auto",
    versionArgs: ["--version"],
  },
  {
    id: "ffmpeg",
    name: "FFmpeg",
    category: "cli",
    summary: "转码、裁剪和查看音视频",
    usage: 'args 示例：["-i", "输入文件", "输出文件"]。覆盖已有文件前先确认路径。',
    install: "auto",
    versionArgs: ["-version"],
  },
  {
    id: "inkscape",
    name: "Inkscape",
    category: "diagram",
    summary: "编辑矢量图，用于 Logo、插画、海报和图标。放大不会发糊",
    usage: 'args 示例：["输入.svg", "--export-filename=输出.png"]。也可导出 pdf 或 svg。',
    install: "auto",
    versionArgs: ["--version"],
  },
  {
    id: "mermaid",
    name: "Mermaid",
    category: "diagram",
    summary: "把流程图、时序图、类图等 Mermaid 文本渲染成 SVG 或 PNG",
    usage:
      'args 示例：["-i", "图.mmd", "-o", "图.svg"]。支持 flowchart、sequenceDiagram、classDiagram。',
    install: "auto",
    versionArgs: ["--version"],
  },
  {
    id: "matplotlib",
    name: "Matplotlib",
    category: "chart",
    summary: "用 Python 生成静态图表",
    usage: PYTHON_USAGE,
    install: "auto",
    versionArgs: [],
  },
  {
    id: "plotly",
    name: "Plotly",
    category: "chart",
    summary: "用 Python 生成可交互的 HTML 图表",
    usage: PYTHON_USAGE,
    install: "auto",
    versionArgs: [],
  },
  {
    id: "altair",
    name: "Altair",
    category: "chart",
    summary: "用 Python 生成 Vega-Lite 交互图",
    usage: PYTHON_USAGE,
    install: "auto",
    versionArgs: [],
  },
  {
    id: "bokeh",
    name: "Bokeh",
    category: "chart",
    summary: "用 Python 生成 Bokeh 交互图",
    usage: PYTHON_USAGE,
    install: "auto",
    versionArgs: [],
  },
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
    const source = ready ? (hit?.source === "managed" ? "managed" : "env") : "none";
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
    return `- ${item.id}（${item.name}）：${item.summary}。${at}${version}。${item.usage}`;
  });
  return [
    "本机已就绪的外部工具。用 host_tool_run 调用，toolId 用下面的 id，args 是字符串数组。不要拼 shell，也不要声称未列出的工具已经可用。",
    ...lines,
  ].join("\n");
}

export function parseHostToolRunArgs(
  args: Record<string, unknown>,
):
  | { ok: true; toolId: string; args: string[]; cwd: string }
  | { ok: false; reason: string } {
  const toolId = typeof args.toolId === "string" ? args.toolId.trim() : "";
  if (!toolId) return { ok: false, reason: "请提供 toolId" };
  if (!CATALOG_IDS.has(toolId)) return { ok: false, reason: `未知工具 ${toolId}` };
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
  return { ok: true, toolId, args: argv, cwd };
}
