/**
 * Workspace-bound agent tools, modeled after DeepSeek Harness (`dsh-tool-*`).
 * Paths resolve against the session workspace root and must stay under it.
 */

import { isAbsolutePath, isPathUnder, joinPath, normalizePath } from "./kb.js";
import type { ToolEffect, ToolSpec } from "./agent.js";

/** Tools that need a bound workspace rootPath. */
export const WORKSPACE_BOUND_TOOL_NAMES = [
  "read",
  "read_image",
  "write",
  "edit",
  "apply_patch",
  "str_replace_editor",
  "glob",
  "grep",
  "bash",
  "pwsh",
  "shell",
  "working_directory",
  "terminal_open",
  "terminal_send",
  "terminal_read",
  "terminal_close",
  "terminal_list",
  "terminal_signal",
  "present",
  "office_to_pdf",
] as const;

/** Host-executed tools (workspace + web + jobs + todos + ask). */
export const HOST_AGENT_TOOL_NAMES = [
  ...WORKSPACE_BOUND_TOOL_NAMES,
  "web_fetch",
  "web_search",
  "todo_write",
  "job_list",
  "job_output",
  "job_kill",
  "ask_user_question",
] as const;

/** @deprecated Use HOST_AGENT_TOOL_NAMES / WORKSPACE_BOUND_TOOL_NAMES. */
export const WORKSPACE_TOOL_NAMES = HOST_AGENT_TOOL_NAMES;

export type WorkspaceToolName = (typeof HOST_AGENT_TOOL_NAMES)[number];

export const READ_LINE_LIMIT = 2000;
export const GREP_MATCH_LIMIT = 250;
export const GLOB_RESULT_LIMIT = 200;
export const SHELL_OUTPUT_LIMIT = 64 * 1024;
export const WEB_FETCH_LIMIT = 100_000;
export const WEB_SEARCH_MAX_QUERIES = 4;
export const WEB_SEARCH_MAX_RESULTS = 8;
/** DeepSeek Search/Fetch API base（含 `/v1/tools` 前缀）。 */
export const DEEPSEEK_WEB_API_BASE_URL = "https://api.deepseek.com/v1/tools";
/** DeepSeek Search API 单条 query / ori_question 最长字符数。 */
export const DEEPSEEK_SEARCH_TEXT_MAX = 128;

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

function tool(
  name: string,
  effect: ToolEffect,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolSpec {
  return {
    name,
    effect,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

/** Model-facing tools that operate on the bound workspace directory. */
export const WORKSPACE_AGENT_TOOLS: readonly ToolSpec[] = [
  tool(
    "read",
    "read",
    "读取工作区内的 UTF-8 文本文件，返回带行号的内容。目录则列出条目。大文件用 offset/limit 分段读取。",
    {
      file_path: str("相对工作区或绝对路径"),
      path: str("同 file_path，兼容别名"),
      offset: num("从第几行开始，1-based，默认 1"),
      limit: num(`最多返回多少行，默认且上限 ${READ_LINE_LIMIT}`),
    },
  ),
  tool(
    "read_image",
    "read",
    "读取工作区内的 PNG/JPEG/WebP/GIF 图片，供多模态模型查看；同时返回路径与大小。",
    {
      file_path: str("相对工作区或绝对路径"),
      path: str("同 file_path，兼容别名"),
    },
  ),
  tool(
    "write",
    "write",
    "在工作区内创建或整文件覆盖 UTF-8 文本。需要改局部内容时优先用 edit。",
    {
      file_path: str("相对工作区或绝对路径，参数顺序上先于 content"),
      path: str("同 file_path，兼容别名"),
      content: str("完整 UTF-8 正文"),
    },
    ["content"],
  ),
  tool(
    "edit",
    "write",
    "在工作区已有文件中做字面量替换。默认只替换唯一匹配；replace_all 为 true 时替换全部。",
    {
      file_path: str("相对工作区或绝对路径"),
      path: str("同 file_path，兼容别名"),
      old_string: str("要替换的原文"),
      new_string: str("替换后的文本；空字符串表示删除匹配"),
      replace_all: { type: "boolean", description: "是否替换全部匹配，默认 false" },
    },
    ["old_string", "new_string"],
  ),
  tool(
    "apply_patch",
    "write",
    "用一条 Codex 风格补丁跨文件增删改。多处改动优先用本工具，而不是多次 edit。",
    {
      patch: str(
        "Codex 补丁：*** Begin Patch … *** End Patch。*** Add File: / *** Update File: / *** Delete File:；Update 用 @@ 与 +/-/空格行。",
      ),
    },
    ["patch"],
  ),
  tool(
    "str_replace_editor",
    "write",
    "Claude Code 风格编辑器：view / create / str_replace / insert。路径须在工作区内。",
    {
      command: str("view | create | str_replace | insert"),
      path: str("相对工作区或绝对路径"),
      file_text: str("create 时的完整文件内容"),
      old_str: str("str_replace 要替换的原文（须唯一）"),
      new_str: str("str_replace 替换后的文本；省略表示删除"),
      insert_line: num("insert 的 0-based 插入行边界"),
      new_str_insert: str("insert 要插入的文本（也可用 new_str）"),
      view_range: {
        type: "array",
        items: { type: "number" },
        description: "view 可选 [start, end] 1-based 行范围",
      },
    },
    ["command", "path"],
  ),
  tool(
    "glob",
    "read",
    `按 glob 查找工作区内的文件（不含目录）。返回最多 ${GLOB_RESULT_LIMIT} 条路径，按修改时间新到旧。`,
    {
      pattern: str('glob，例如 "**/*.ts" 或 "src/**/*.test.js"'),
      path: str("搜索根目录，相对工作区；默认工作区根"),
    },
    ["pattern"],
  ),
  tool(
    "grep",
    "read",
    `在工作区文件内容中用正则搜索（ripgrep 语法）。返回带行号的匹配，最多 ${GREP_MATCH_LIMIT} 条。`,
    {
      pattern: str("正则表达式"),
      path: str("文件或目录，相对工作区；默认工作区根"),
      include: str('可选文件过滤，例如 "*.ts"'),
    },
    ["pattern"],
  ),
  tool(
    "bash",
    "write",
    "在工作区内用 bash 执行一条命令（Windows 需已安装 bash/Git Bash）。跨调用状态请用 terminal_*。",
    {
      command: str("bash 命令"),
      description: str("5–10 个词的主动语态说明，用于界面展示"),
      workdir: str("工作目录，相对或绝对，须在工作区内；默认会话 cwd"),
      timeout: num("超时毫秒，默认 120000；0 表示不限；后台任务不超时"),
      background: {
        type: "boolean",
        description: "后台运行并立即返回 job id；完成后用 job_output 读取",
      },
    },
    ["command"],
  ),
  tool(
    "pwsh",
    "write",
    "在工作区内执行一条 PowerShell 命令。优先用 read/edit/glob/grep；长命令请写清 description。后台任务用 background，再 job_output / job_kill。",
    {
      command: str("PowerShell 命令"),
      description: str("5–10 个词的主动语态说明，用于界面展示"),
      workdir: str("工作目录，相对或绝对，须在工作区内；默认会话 cwd"),
      timeout: num("超时毫秒，默认 120000；0 表示不限；后台任务不超时"),
      background: {
        type: "boolean",
        description: "后台运行并立即返回 job id；完成后用 job_output 读取",
      },
    },
    ["command"],
  ),
  tool(
    "shell",
    "write",
    "在工作区内执行一条 shell 命令（Windows 用 PowerShell，其它平台用 bash）。需要跨调用保留状态时改用 terminal_*。",
    {
      command: str("要执行的命令"),
      description: str("5–10 个词的主动语态说明，用于界面展示"),
      workdir: str("工作目录，相对或绝对，须在工作区内；默认会话 cwd"),
      timeout: num("超时毫秒，默认 120000；0 表示不限；后台任务不超时"),
      background: {
        type: "boolean",
        description: "后台运行并立即返回 job id；完成后用 job_output 读取",
      },
    },
    ["command"],
  ),
  tool(
    "working_directory",
    "none",
    "读取或切换本会话工作目录。相对路径基于当前 cwd；已打开的终端进程不会自动跟随。",
    {
      path: str("要进入的已存在目录；省略则只返回当前 cwd"),
      cd: str("同 path"),
    },
  ),
  tool(
    "terminal_open",
    "write",
    "打开一个基于 PTY/ConPTY 的持久终端会话（可跑交互程序）。一次性命令请用 shell/pwsh。",
    {
      name: str('可选显示名，例如 "main"'),
      workdir: str("初始工作目录，相对会话 cwd；默认会话 cwd"),
      shell: str("交互 shell：pwsh 或 bash；默认随操作系统（Windows=pwsh，其它=bash）"),
    },
  ),
  tool(
    "terminal_send",
    "write",
    "向持久 PTY 终端写入文本；默认追加回车并等待一段静默后返回新输出。",
    {
      session_id: str("terminal_open / terminal_list 返回的 id"),
      text: str("写入终端的 UTF-8 文本"),
      submit: {
        type: "boolean",
        description: "写入后是否追加回车，默认 true",
      },
      timeout: num("最长等待毫秒，默认 15000"),
    },
    ["session_id", "text"],
  ),
  tool(
    "terminal_read",
    "read",
    "读取持久终端已缓冲的输出，不发送输入。",
    {
      session_id: str("终端会话 id"),
      offset: num("从末尾往前跳过的行数，默认 0"),
      limit: num("返回行数，默认 500"),
    },
    ["session_id"],
  ),
  tool(
    "terminal_signal",
    "write",
    "向持久 PTY 发送信号：SIGINT 写入 Ctrl+C；SIGTERM/SIGKILL 结束进程。彻底结束也可用 terminal_close。",
    {
      session_id: str("终端会话 id"),
      signal: str("SIGINT（默认）| SIGTERM | SIGKILL"),
    },
    ["session_id"],
  ),
  tool(
    "terminal_close",
    "destructive",
    "关闭一个持久终端并结束其进程。",
    {
      session_id: str("终端会话 id"),
    },
    ["session_id"],
  ),
  tool("terminal_list", "read", "列出当前仍打开的持久终端会话。", {}),
  tool(
    "present",
    "none",
    "向用户交付工作区内已生成的文件：用系统默认应用打开，并可在资源管理器中显示。",
    {
      files: {
        type: "array",
        description: "要交付的文件列表",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: str("相对工作区或绝对路径"),
            description: str("可选说明"),
          },
          required: ["path"],
        },
      },
      path: str("单个文件（与 files 二选一）"),
      description: str("单个文件说明"),
      reveal: {
        type: "boolean",
        description: "是否同时在文件管理器中选中，默认 true",
      },
    },
  ),
  tool(
    "office_to_pdf",
    "write",
    "用 DeepSeek LibreOffice Kit（原生引擎）把工作区内的 Office 文档转为 PDF。",
    {
      input: str("输入 .docx/.xlsx/.pptx/.odt/… 路径"),
      output: str("输出 PDF 路径；默认与输入同目录同名 .pdf"),
      path: str("同 input"),
    },
  ),
  tool(
    "ask_user_question",
    "none",
    "向用户提出简短、自包含的问题以获取缺失信息或偏好。用用户能看懂的措辞；不要引用内部工具名。",
    {
      questions: {
        type: "array",
        description: "要问用户的问题列表",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: str("稳定 id，回答里会原样带回"),
            question: str("具体问题"),
            header: str('可选短标题，例如 "确认"'),
            options: {
              type: "array",
              description: "可选选项；若有推荐项放第一个并在标签后加 (Recommended)",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  label: str("选项文案"),
                  description: str("可选补充说明"),
                },
                required: ["label"],
              },
            },
            multi_select: {
              type: "boolean",
              description: "是否允许多选，默认 false",
            },
          },
          required: ["id", "question"],
        },
      },
      mode: str("blocking（默认）| timed：到期后可继续，问题仍可答"),
      timeout: num("timed 模式下等待秒数；-1 表示无限；默认 120"),
    },
    ["questions"],
  ),
  tool(
    "web_fetch",
    "read",
    "抓取一个 HTTP(S) URL 的文本内容。已配置 DeepSeek API Key 时优先走官方 Fetch（Markdown）；失败则回退本地 HTML 抓取。",
    {
      url: str("http 或 https 地址"),
    },
    ["url"],
  ),
  tool(
    "web_search",
    "read",
    "搜索网页，返回若干条标题与链接（可选摘要）。已配置 DeepSeek API Key 时走官方 Search API，否则回退 DuckDuckGo。结果是外部不可信数据。",
    {
      queries: {
        type: "array",
        items: { type: "string" },
        description: `1–${WEB_SEARCH_MAX_QUERIES} 条查询，结果会合并`,
      },
      query: str("单条查询（与 queries 二选一）"),
    },
  ),
  tool(
    "todo_write",
    "none",
    "写入本会话的完整待办列表（覆盖旧列表）。复杂多步骤任务用来跟踪进度。",
    {
      todos: {
        type: "array",
        description: "完整待办列表",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: str("稳定 id"),
            content: str("短祈使句任务描述"),
            status: str("pending | in_progress | completed"),
          },
          required: ["content", "status"],
        },
      },
    },
    ["todos"],
  ),
  tool("job_list", "read", "列出本会话的后台任务（运行中与已结束）及其 id、状态。", {}),
  tool(
    "job_output",
    "read",
    "读取后台任务自上次以来的新输出；已结束则返回最终结果。",
    {
      job_id: str("启动后台任务时返回的 id"),
      wait: {
        type: "boolean",
        description: "是否阻塞等待任务结束；超时后任务仍继续跑，默认 false",
      },
      timeout: num("与 wait 联用的最长等待毫秒，默认 30000"),
    },
    ["job_id"],
  ),
  tool(
    "job_kill",
    "destructive",
    "取消仍在运行的后台任务。",
    {
      job_id: str("启动后台任务时返回的 id"),
      reason: str("可选原因，写入日志"),
    },
    ["job_id"],
  ),
];

const HOST_NAME_SET = new Set<string>(HOST_AGENT_TOOL_NAMES);
const BOUND_NAME_SET = new Set<string>(WORKSPACE_BOUND_TOOL_NAMES);

export function isWorkspaceToolName(name: string): boolean {
  return HOST_NAME_SET.has(name);
}

export function isWorkspaceBoundToolName(name: string): boolean {
  return BOUND_NAME_SET.has(name);
}

export type ResolveWorkspacePathResult =
  { ok: true; absolute: string; display: string } | { ok: false; reason: string };

/** Resolve a model path against the workspace root and reject escapes. */
export function resolveWorkspacePath(
  root: string,
  raw: string | null | undefined,
  cwd?: string | null,
): ResolveWorkspacePathResult {
  const base = normalizePath(root.trim());
  if (!base) return { ok: false, reason: "当前会话未绑定工作区目录" };
  const sessionCwd = normalizePath((cwd ?? "").trim() || base);
  if (!isPathUnder(base, sessionCwd)) {
    return { ok: false, reason: "会话工作目录超出工作区范围" };
  }
  const input = typeof raw === "string" ? raw.trim() : "";
  const absolute = normalizePath(input ? joinPath(sessionCwd, input) : sessionCwd);
  if (!absolute) return { ok: false, reason: "路径无效" };
  if (!isPathUnder(base, absolute)) {
    return { ok: false, reason: "路径超出工作区范围" };
  }
  const display = isAbsolutePath(input) ? absolute : input || ".";
  return { ok: true, absolute, display };
}

export function filePathFromArgs(args: Record<string, unknown>): string {
  if (typeof args.file_path === "string" && args.file_path.trim()) {
    return args.file_path.trim();
  }
  if (typeof args.path === "string" && args.path.trim()) return args.path.trim();
  return "";
}

export type ReadWindow = { offset: number; limit: number };

export function parseReadWindow(args: Record<string, unknown>): ReadWindow | string {
  const offset = intOr(args.offset, 1, "offset");
  if (typeof offset === "string") return offset;
  const limit = intOr(args.limit, READ_LINE_LIMIT, "limit");
  if (typeof limit === "string") return limit;
  if (offset < 1) return "offset 须为从 1 开始的整数";
  if (limit < 1) return "limit 须为正整数";
  if (limit > READ_LINE_LIMIT) return `limit 不能超过 ${READ_LINE_LIMIT}`;
  return { offset, limit };
}

function intOr(value: unknown, fallback: number, label: string): number | string {
  if (value == null || value === "") return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return `${label} 须为整数`;
  }
  return value;
}

/** Prefix each returned line with its 1-based number, matching DSH read formatting. */
export function formatNumberedLines(
  text: string,
  offset: number,
  limit: number,
): {
  text: string;
  totalLines: number;
  start: number;
  end: number;
  truncated: boolean;
} {
  const lines = text.split(/\r?\n/);
  // A trailing empty segment from a final newline is kept as a blank last line
  // only when the file is non-empty; empty files have zero lines.
  if (lines.length === 1 && lines[0] === "") {
    return { text: "", totalLines: 0, start: 0, end: 0, truncated: false };
  }
  const totalLines = lines.length;
  if (offset > totalLines) {
    return {
      text: "",
      totalLines,
      start: 0,
      end: 0,
      truncated: false,
    };
  }
  const start = offset;
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const end = offset - 1 + slice.length;
  const body = slice.map((line, index) => `${start + index}|${line}`).join("\n");
  const truncated = end < totalLines;
  const footer = truncated
    ? `\n\n(Showing lines ${start}-${end} of ${totalLines}. Use offset=${end + 1} to continue.)`
    : "";
  return { text: body + footer, totalLines, start, end, truncated };
}

export type EditApplyResult =
  { ok: true; content: string; replacements: number } | { ok: false; reason: string };

export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditApplyResult {
  if (!oldString) return { ok: false, reason: "old_string 不能为空" };
  if (oldString === newString) {
    return { ok: false, reason: "old_string 与 new_string 相同，无需修改" };
  }
  if (replaceAll) {
    const parts = content.split(oldString);
    const replacements = parts.length - 1;
    if (replacements === 0) return { ok: false, reason: "未找到要替换的原文" };
    return { ok: true, content: parts.join(newString), replacements };
  }
  const first = content.indexOf(oldString);
  if (first < 0) return { ok: false, reason: "未找到要替换的原文" };
  const second = content.indexOf(oldString, first + oldString.length);
  if (second >= 0) {
    return {
      ok: false,
      reason: "old_string 出现多次；请扩大上下文或设 replace_all=true",
    };
  }
  return {
    ok: true,
    content:
      content.slice(0, first) + newString + content.slice(first + oldString.length),
    replacements: 1,
  };
}

/** Minimal glob → RegExp. Supports *, **, ? and path separators. */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").trim();
  let source = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;
    if (ch === "*" && normalized[i + 1] === "*") {
      source += ".*";
      i += 1;
      if (normalized[i + 1] === "/") i += 1;
      continue;
    }
    if (ch === "*") {
      source += "[^/]*";
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      continue;
    }
    if ("+.^$()[]{}|".includes(ch)) source += `\\${ch}`;
    else source += ch;
  }
  source += "$";
  return new RegExp(source, "i");
}

export type AgentTodoItem = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
};

export function parseTodoWriteArgs(
  args: Record<string, unknown>,
): { ok: true; todos: AgentTodoItem[] } | { ok: false; reason: string } {
  if (!Array.isArray(args.todos)) return { ok: false, reason: "todos 须为数组" };
  if (args.todos.length === 0) return { ok: false, reason: "todos 不能为空" };
  if (args.todos.length > 40) return { ok: false, reason: "待办过多" };
  const todos: AgentTodoItem[] = [];
  for (let i = 0; i < args.todos.length; i += 1) {
    const item = args.todos[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, reason: `todos[${i}] 无效` };
    }
    const row = item as Record<string, unknown>;
    const content = typeof row.content === "string" ? row.content.trim() : "";
    if (!content) return { ok: false, reason: `todos[${i}].content 不能为空` };
    const statusRaw = typeof row.status === "string" ? row.status.trim() : "";
    if (
      statusRaw !== "pending" &&
      statusRaw !== "in_progress" &&
      statusRaw !== "completed"
    ) {
      return { ok: false, reason: `todos[${i}].status 无效` };
    }
    const id =
      typeof row.id === "string" && row.id.trim() ? row.id.trim() : `todo-${i + 1}`;
    todos.push({ id, content, status: statusRaw });
  }
  return { ok: true, todos };
}

export function formatTodosForPrompt(todos: readonly AgentTodoItem[]): string {
  if (todos.length === 0) return "";
  const lines = todos.map((item) => {
    const mark =
      item.status === "completed" ? "x" : item.status === "in_progress" ? "~" : " ";
    return `- [${mark}] ${item.content}`;
  });
  return ["当前会话待办：", ...lines].join("\n");
}

export function formatWorkspaceToolsHint(hasRoot: boolean): string {
  const lines = [
    "web_search / web_fetch 可查网页；todo_write 维护本会话待办；缺信息时用 ask_user_question（可用 mode=timed）。后台任务用 job_list / job_output / job_kill。定时投递用 schedule_*（仅在用户明确要求时创建/修改）。会话 goal 用 get_goal / create_goal / update_goal；历史检索用 session_search / session_event_*。",
  ];
  if (hasRoot) {
    lines.unshift(
      "当前会话已绑定本地工作区。用 read / read_image / write / edit / apply_patch / str_replace_editor / glob / grep / bash / shell / pwsh 操作文件与命令；present 交付文件；office_to_pdf 转 PDF；working_directory 切换会话 cwd；需要跨调用状态时用 terminal_*。不要用 shell 去 cat/sed 代替专用工具。",
    );
  }
  return lines.join("");
}

export type StrReplaceEditorCommand = "view" | "create" | "str_replace" | "insert";

export type StrReplaceEditorArgs = {
  command: StrReplaceEditorCommand;
  path: string;
  fileText?: string;
  oldStr?: string;
  newStr?: string;
  insertLine?: number;
  viewRange?: [number, number];
};

export function parseStrReplaceEditorArgs(
  args: Record<string, unknown>,
): { ok: true; value: StrReplaceEditorArgs } | { ok: false; reason: string } {
  const commandRaw = typeof args.command === "string" ? args.command.trim() : "";
  if (
    commandRaw !== "view" &&
    commandRaw !== "create" &&
    commandRaw !== "str_replace" &&
    commandRaw !== "insert"
  ) {
    return { ok: false, reason: "command 须为 view | create | str_replace | insert" };
  }
  const path =
    (typeof args.path === "string" && args.path.trim()) ||
    (typeof args.file_path === "string" && args.file_path.trim()) ||
    "";
  if (!path) return { ok: false, reason: "请提供 path" };
  const value: StrReplaceEditorArgs = { command: commandRaw, path };
  if (typeof args.file_text === "string") value.fileText = args.file_text;
  if (typeof args.old_str === "string") value.oldStr = args.old_str;
  if (typeof args.new_str === "string") value.newStr = args.new_str;
  if (typeof args.new_str_insert === "string" && value.newStr === undefined) {
    value.newStr = args.new_str_insert;
  }
  if (typeof args.insert_line === "number" && Number.isInteger(args.insert_line)) {
    value.insertLine = args.insert_line;
  }
  if (Array.isArray(args.view_range) && args.view_range.length === 2) {
    const start = args.view_range[0];
    const end = args.view_range[1];
    if (
      typeof start === "number" &&
      typeof end === "number" &&
      Number.isInteger(start) &&
      Number.isInteger(end)
    ) {
      value.viewRange = [start, end];
    } else {
      return { ok: false, reason: "view_range 须为两个整数" };
    }
  }
  return { ok: true, value };
}

/** Insert text at a 0-based line boundary (0 = before first line). */
export function insertAtLine(
  content: string,
  insertLine: number,
  text: string,
): { ok: true; content: string } | { ok: false; reason: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
    return { ok: false, reason: `insert_line 须在 [0, ${lines.length}]` };
  }
  const inserted = text.replace(/\r\n/g, "\n").split("\n");
  lines.splice(insertLine, 0, ...inserted);
  return { ok: true, content: lines.join("\n") };
}

export type AskUserOption = { label: string; description?: string };
export type AskUserQuestion = {
  id: string;
  question: string;
  header?: string;
  options?: AskUserOption[];
  multiSelect: boolean;
};

export function parseAskUserQuestions(
  args: Record<string, unknown>,
): { ok: true; questions: AskUserQuestion[] } | { ok: false; reason: string } {
  if (!Array.isArray(args.questions) || args.questions.length === 0) {
    return { ok: false, reason: "请提供 questions" };
  }
  if (args.questions.length > 8) return { ok: false, reason: "一次最多 8 个问题" };
  const seen = new Set<string>();
  const questions: AskUserQuestion[] = [];
  for (let i = 0; i < args.questions.length; i += 1) {
    const item = args.questions[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, reason: `questions[${i}] 无效` };
    }
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const question = typeof row.question === "string" ? row.question.trim() : "";
    if (!id || !question)
      return { ok: false, reason: `questions[${i}] 需要 id 与 question` };
    if (seen.has(id)) return { ok: false, reason: `问题 id 重复：${id}` };
    seen.add(id);
    const header = typeof row.header === "string" ? row.header.trim() : "";
    const multiSelect = row.multi_select === true;
    let options: AskUserOption[] | undefined;
    if (Array.isArray(row.options)) {
      options = [];
      for (const opt of row.options) {
        if (!opt || typeof opt !== "object" || Array.isArray(opt)) continue;
        const option = opt as Record<string, unknown>;
        const label = typeof option.label === "string" ? option.label.trim() : "";
        if (!label) continue;
        const description =
          typeof option.description === "string" ? option.description.trim() : "";
        options.push(description ? { label, description } : { label });
      }
      if (options.length === 0) options = undefined;
    }
    questions.push({
      id,
      question,
      ...(header ? { header } : {}),
      ...(options ? { options } : {}),
      multiSelect,
    });
  }
  return { ok: true, questions };
}

export function parseWebSearchQueries(
  args: Record<string, unknown>,
): { ok: true; queries: string[] } | { ok: false; reason: string } {
  const fromArray = Array.isArray(args.queries)
    ? args.queries.filter((item): item is string => typeof item === "string")
    : [];
  const single = typeof args.query === "string" ? args.query.trim() : "";
  const queries = [...fromArray.map((item) => item.trim()).filter(Boolean)];
  if (single) queries.push(single);
  const unique = [...new Set(queries)];
  if (unique.length === 0) return { ok: false, reason: "请提供 query 或 queries" };
  if (unique.length > WEB_SEARCH_MAX_QUERIES) {
    return { ok: false, reason: `最多 ${WEB_SEARCH_MAX_QUERIES} 条查询` };
  }
  return { ok: true, queries: unique };
}

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** Detect PNG/JPEG/WebP/GIF from magic bytes; falls back to extension hints. */
export function sniffImageMediaType(
  bytes: Uint8Array,
  filePath = "",
): ImageMediaType | undefined {
  if (bytes.length >= 8) {
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      return "image/png";
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    if (
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38
    ) {
      return "image/gif";
    }
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return "image/webp";
    }
  }
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return undefined;
}

/** Best-effort width/height from PNG / GIF / WebP headers (JPEG returns 0,0). */
export function sniffImageDimensions(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const width = readU32be(bytes, 16);
    const height = readU32be(bytes, 20);
    return { width, height };
  }
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return {
      width: bytes[6]! | (bytes[7]! << 8),
      height: bytes[8]! | (bytes[9]! << 8),
    };
  }
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    // VP8X extended header carries canvas size; otherwise leave unknown.
    if (
      bytes[12] === 0x56 &&
      bytes[13] === 0x50 &&
      bytes[14] === 0x38 &&
      bytes[15] === 0x58 &&
      bytes.length >= 30
    ) {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      return { width, height };
    }
  }
  return { width: 0, height: 0 };
}

function readU32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

export type PresentFile = { path: string; description?: string };

export function parsePresentFiles(
  args: Record<string, unknown>,
): { ok: true; files: PresentFile[]; reveal: boolean } | { ok: false; reason: string } {
  const reveal = args.reveal !== false;
  const files: PresentFile[] = [];
  if (Array.isArray(args.files)) {
    for (const item of args.files) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const path = typeof row.path === "string" ? row.path.trim() : "";
      if (!path) continue;
      const description =
        typeof row.description === "string" && row.description.trim()
          ? row.description.trim()
          : undefined;
      files.push({ path, ...(description ? { description } : {}) });
    }
  }
  const single =
    (typeof args.path === "string" && args.path.trim()) ||
    (typeof args.file_path === "string" && args.file_path.trim()) ||
    "";
  if (single) {
    const description =
      typeof args.description === "string" && args.description.trim()
        ? args.description.trim()
        : undefined;
    files.push({ path: single, ...(description ? { description } : {}) });
  }
  if (!files.length) return { ok: false, reason: "请提供 path 或 files" };
  if (files.length > 8) return { ok: false, reason: "一次最多交付 8 个文件" };
  return { ok: true, files, reveal };
}

export type AskUserMode = "blocking" | "timed";

export function parseAskUserMode(args: Record<string, unknown>): {
  mode: AskUserMode;
  timeoutSec: number;
} {
  const raw = typeof args.mode === "string" ? args.mode.trim().toLowerCase() : "";
  const mode: AskUserMode = raw === "timed" ? "timed" : "blocking";
  let timeoutSec = 120;
  if (typeof args.timeout === "number" && Number.isFinite(args.timeout)) {
    timeoutSec = Math.floor(args.timeout);
  }
  if (timeoutSec < -1) timeoutSec = -1;
  return { mode, timeoutSec };
}

export type WebSearchHit = { title: string; url: string; snippet: string };

/**
 * Strip CSI / OSC / other ESC sequences so PTY and shell output is readable by models and UI.
 * Also normalizes lone CR (common from ConPTY) into newlines.
 */
export function stripAnsiEscapes(input: string): string {
  if (!input) return "";
  return input
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "")
    .replace(/\u001b[()][0-9A-Za-z]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "");
}

/** Collapse whitespace and keep the first `max` Unicode characters (DeepSeek Search limits). */
export function boundDeepSeekSearchText(
  value: string,
  max = DEEPSEEK_SEARCH_TEXT_MAX,
): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return Array.from(collapsed).slice(0, Math.max(1, max)).join("");
}

/**
 * Project DeepSeek Search API JSON into WebSearchHit rows.
 * Prefer model-facing `summary` when present; fall back to display `snippet`.
 */
export function parseDeepSeekSearchResponse(
  payload: unknown,
  max = WEB_SEARCH_MAX_RESULTS,
): WebSearchHit[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const hits: WebSearchHit[] = [];
  for (const item of results) {
    if (hits.length >= max) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!url || !isAllowedFetchUrl(url)) continue;
    const title = typeof row.title === "string" ? row.title.trim() : "";
    const summary = typeof row.summary === "string" ? row.summary.trim() : "";
    const snippetRaw = typeof row.snippet === "string" ? row.snippet.trim() : "";
    const snippet = (summary || snippetRaw).replace(/\s+/g, " ").trim();
    hits.push({
      title: title || url,
      url,
      snippet: snippet.slice(0, 800),
    });
  }
  return hits;
}

/** Parse DuckDuckGo HTML lite result cards. */
export function parseDuckDuckGoHtml(
  html: string,
  max = WEB_SEARCH_MAX_RESULTS,
): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  const blockRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) && hits.length < max) {
    const rawUrl = decodeHtml(match[1] ?? "").trim();
    const title = htmlToReadableText(match[2] ?? "", 200)
      .replace(/\s+/g, " ")
      .trim();
    const url = unwrapDdgRedirect(rawUrl);
    if (!title || !isAllowedFetchUrl(url)) continue;
    const after = html.slice(match.index, match.index + 1200);
    const snipMatch =
      /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)/i.exec(after);
    const snippet = snipMatch
      ? htmlToReadableText(snipMatch[1] ?? "", 280)
          .replace(/\s+/g, " ")
          .trim()
      : "";
    hits.push({ title, url, snippet });
  }
  return hits;
}

function unwrapDdgRedirect(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("duckduckgo.com") && parsed.pathname === "/l/") {
      const target = parsed.searchParams.get("uddg");
      if (target) return decodeURIComponent(target);
    }
  } catch {
    /* keep original */
  }
  return url;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function isAllowedFetchUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Strip tags roughly so the model sees readable text from HTML pages. */
export function htmlToReadableText(html: string, max = WEB_FETCH_LIMIT): string {
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = noScript
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…(已截断)`;
}
