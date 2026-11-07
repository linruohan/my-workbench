import {
  DEEPSEEK_WEB_API_BASE_URL,
  GLOB_RESULT_LIMIT,
  GREP_CAPTURE_LIMIT,
  GREP_MATCH_LIMIT,
  READ_LINE_LIMIT,
  WEB_FETCH_LIMIT,
  WEB_SEARCH_MAX_RESULTS,
  FS_NOT_OBSERVED,
  applyHunks,
  applyLiteralEdit,
  assertCanDeleteExisting,
  assertCanModifyExisting,
  boundDeepSeekSearchText,
  filePathFromArgs,
  formatGrepSpillText,
  formatNumberedLines,
  formatRetentionNotice,
  clipStrReplaceView,
  collectManagedShellEnv,
  formatShellModelText,
  formatStrReplaceDirListing,
  globToRegExp,
  shouldSkipStrReplaceDirEntry,
  shouldSpillGrepMatches,
  STR_REPLACE_VIEW_MAX_CHARS,
  htmlToReadableText,
  insertAtLine,
  isAllowedFetchUrl,
  isPathUnder,
  isWorkspaceToolName,
  joinPath,
  normalizePath,
  parentDir,
  parseAskUserQuestions,
  parseDeepSeekSearchResponse,
  parseDuckDuckGoHtml,
  parsePatch,
  parsePresentFiles,
  parseReadWindow,
  parseStrReplaceEditorArgs,
  parseTodoWriteArgs,
  parseWebSearchQueries,
  resolveWorkspacePath,
  sniffImageDimensions,
  sniffImageMediaType,
  stripAnsiEscapes,
  PatchParseError,
  type AgentTodoItem,
  type HostToolSnapshot,
} from "@wb/domain";
import { errorMessage } from "../lib/errors";
import { isTauriRuntime, resolveDataDir } from "../lib/paths";
import {
  kbExists,
  kbMkdir,
  kbRemove,
  listDirectory,
  listFilesRecursive,
  openLocalPath,
  readTextFile,
  revealInExplorer,
  writeTextFile,
  type KbEntry,
} from "../notes/kb-api";
import type { AgentToolResult } from "./execute";
import { hostFetch } from "./host-fetch";
import { runHostTool } from "./host-tools";
import {
  forgetObservedPath,
  observedPathsFor,
  rememberObservedPath,
} from "./fs-observation-store";
import { putImageAttachment } from "./image-attachments";
import { normalizeImageForModel } from "./image-normalize";
import { clearJobNotice, trackBackgroundJob } from "./job-watch";
import { saveToolSpill } from "./spill-store";

export type WorkspaceToolEnv = {
  rootPath: string | null | undefined;
  /** Owning agent session (for background job completion notices). */
  threadId?: string | null;
  /** Session cwd under the workspace root. Defaults to rootPath. */
  cwd?: string | null;
  onCwd?: (next: string) => void;
  hostTools?: readonly HostToolSnapshot[];
  todos?: AgentTodoItem[];
  onTodos?: (next: AgentTodoItem[]) => void;
  /** Resolve a stored provider API key (e.g. `"deepseek"`). */
  readApiKey?: (providerId: string) => string | null;
  /** Attach a workspace image to the next model request (vision models). */
  onImage?: (dataUrl: string) => void;
  /** Cooperative cancel from the owning agent turn. */
  signal?: AbortSignal;
};

export async function runWorkspaceTool(
  name: string,
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
): Promise<AgentToolResult> {
  if (!isWorkspaceToolName(name)) {
    return fail(`未知工作区工具 ${name}`);
  }
  try {
    switch (name) {
      case "read":
        return await runRead(args, env);
      case "read_image":
        return await runReadImage(args, env);
      case "write":
        return await runWrite(args, env);
      case "edit":
        return await runEdit(args, env);
      case "apply_patch":
        return await runApplyPatch(args, env);
      case "str_replace_editor":
        return await runStrReplaceEditor(args, env);
      case "glob":
        return await runGlob(args, env);
      case "grep":
        return await runGrep(args, env);
      case "bash":
        return await runShellCommand(args, env, "bash");
      case "pwsh":
        return await runShellCommand(args, env, "pwsh");
      case "shell":
        return await runShellCommand(args, env, preferShell());
      case "working_directory":
        return await runWorkingDirectory(args, env);
      case "terminal_open":
        return await runTerminalOpen(args, env);
      case "terminal_send":
        return await runTerminalSend(args);
      case "terminal_read":
        return await runTerminalRead(args);
      case "terminal_list":
        return await runTerminalList();
      case "terminal_close":
        return await runTerminalClose(args);
      case "terminal_signal":
        return await runTerminalSignal(args);
      case "present":
        return await runPresent(args, env);
      case "office_to_pdf":
        return await runOfficeToPdf(args, env);
      case "ask_user_question":
        return fail("请通过界面回答提问，不要直接执行 ask_user_question");
      case "web_fetch":
        return await runWebFetch(args, env);
      case "web_search":
        return await runWebSearch(args, env);
      case "todo_write":
        return runTodoWrite(args, env);
      case "job_list":
        return await runJobList();
      case "job_output":
        return await runJobOutput(args);
      case "job_kill":
        return await runJobKill(args);
      default:
        return fail(`未知工作区工具 ${name}`);
    }
  } catch (error) {
    return fail(errorMessage(error, "工具执行失败"));
  }
}

async function runRead(
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
): Promise<AgentToolResult> {
  const root = requireRoot(env);
  const raw = filePathFromArgs(args);
  if (!raw) return fail("请提供 file_path");
  const resolved = resolveWorkspacePath(root, raw, env.cwd);
  if (resolved.ok === false) return fail(resolved.reason);
  const window = parseReadWindow(args);
  if (typeof window === "string") return fail(window);

  if (!(await kbExists(resolved.absolute))) return fail("路径不存在");
  const entries = await tryListDir(resolved.absolute);
  if (entries) {
    const lines = entries.map((entry) => (entry.isDir ? `${entry.name}/` : entry.name));
    const slice = lines.slice(window.offset - 1, window.offset - 1 + window.limit);
    return ok(`目录 ${resolved.display}（${lines.length} 项）`, {
      path: resolved.display,
      text: slice.join("\n"),
      total: lines.length,
    });
  }

  const content = await readTextFile(resolved.absolute);
  const numbered = formatNumberedLines(content, window.offset, window.limit);
  if (numbered.totalLines > 0 && numbered.start === 0) {
    return fail(`offset ${window.offset} 超出文件行数 ${numbered.totalLines}`);
  }
  rememberObservedPath(env.threadId, resolved.absolute);
  return ok(`已读取 ${resolved.display}`, {
    path: resolved.display,
    text: numbered.text,
    totalLines: numbered.totalLines,
    truncated: numbered.truncated,
  });
}

async function runReadImage(
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
): Promise<AgentToolResult> {
  const root = requireRoot(env);
  const raw = filePathFromArgs(args);
  if (!raw) return fail("请提供 file_path");
  const resolved = resolveWorkspacePath(root, raw, env.cwd);
  if (resolved.ok === false) return fail(resolved.reason);
  if (!(await kbExists(resolved.absolute))) return fail("文件不存在");
  if (!isTauriRuntime()) return fail("当前环境不能读取图片");
  const { invoke } = await import("@tauri-apps/api/core");
  const b64 = await invoke<string>("kb_read_base64", { path: resolved.absolute });
  const bytes = base64ToBytes(b64);
  const mediaType = sniffImageMediaType(bytes, resolved.absolute);
  if (!mediaType) {
    return fail("仅支持 PNG / JPEG / WebP / GIF");
  }
  const dims = sniffImageDimensions(bytes);
  let dataUrl = `data:${mediaType};base64,${b64}`;
  let outMedia = mediaType;
  let outBytes = bytes.length;
  let outWidth = dims.width;
  let outHeight = dims.height;
  let normalized = false;
  try {
    const norm = await normalizeImageForModel(bytes, mediaType);
    dataUrl = norm.dataUrl;
    outMedia = norm.normalized ? "image/jpeg" : mediaType;
    outBytes = norm.bytes;
    outWidth = norm.width;
    outHeight = norm.height;
    normalized = norm.normalized;
  } catch {
    // Fall back to the original bytes when canvas decode fails.
  }
  const name = resolved.display.split(/[\\/]/).pop() || resolved.display;
  const threadId = env.threadId?.trim() || "";
  const stored = threadId
    ? putImageAttachment({
        threadId,
        path: resolved.display,
        mediaType: outMedia,
        dataUrl,
        bytes: outBytes,
        width: outWidth,
        height: outHeight,
        name,
      })
    : null;
  rememberObservedPath(env.threadId, resolved.absolute);
  env.onImage?.(dataUrl);
  return ok(`已读取图片 ${resolved.display}`, {
    path: resolved.display,
    mediaType: outMedia,
    bytes: outBytes,
    sourceBytes: bytes.length,
    normalized,
    imageAttached: Boolean(env.onImage),
    image: {
      attachmentId: stored?.id ?? "ephemeral",
      mediaType: outMedia,
      bytes: outBytes,
      width: outWidth,
      height: outHeight,
      name,
    },
  });
}

async function runStrReplaceEditor(
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
): Promise<AgentToolResult> {
  const root = requireRoot(env);
  const parsed = parseStrReplaceEditorArgs(args);
  if (parsed.ok === false) return fail(parsed.reason);
  const { value } = parsed;
  const resolved = resolveWorkspacePath(root, value.path, env.cwd);
  if (resolved.ok === false) return fail(resolved.reason);

  if (value.command === "view") {
    if (!(await kbExists(resolved.absolute))) return fail("路径不存在");
    const entries = await tryListDir(resolved.absolute);
    if (entries) {
      if (value.viewRange) {
        return fail("目录 view 不能使用 view_range");
      }
      const rows = await collectStrReplaceDirRows(resolved.absolute, resolved.display);
      const listing = formatStrReplaceDirListing(resolved.display, rows);
      const clipped = clipStrReplaceView(listing, STR_REPLACE_VIEW_MAX_CHARS);
      return ok(`目录 ${resolved.display}`, {
        path: resolved.display,
        text: clipped.text,
        total: rows.length,
        truncated: clipped.clipped,
        clipped: clipped.clipped,
      });
    }
    const content = await readTextFile(resolved.absolute);
    let offset = 1;
    let limit = READ_LINE_LIMIT;
    if (value.viewRange) {
      const [start, end] = value.viewRange;
      if (start < 1) return fail("view_range 起始行须 ≥ 1");
      offset = start;
      limit = end === -1 ? READ_LINE_LIMIT : Math.max(1, end - start + 1);
    }
    const numbered = formatNumberedLines(content, offset, limit);
    if (numbered.totalLines > 0 && numbered.start === 0) {
      return fail(`view_range 超出文件行数 ${numbered.totalLines}`);
    }
    const clipped = clipStrReplaceView(numbered.text, STR_REPLACE_VIEW_MAX_CHARS);
    rememberObservedPath(env.threadId, resolved.absolute);
    return ok(`已查看 ${resolved.display}`, {
      path: resolved.display,
      text: clipped.text,
      totalLines: numbered.totalLines,
      truncated: numbered.truncated || clipped.clipped,
      clipped: clipped.clipped,
    });
  }

  if (value.command === "create") {
    if (value.fileText === undefined) return fail("create 需要 file_text");
    if (await kbExists(resolved.absolute)) {
      return fail(`文件已存在：${resolved.display}；create 不会覆盖`);
    }
    await ensureParent(resolved.absolute);
    await writeTextFile(resolved.absolute, value.fileText);
    rememberObservedPath(env.threadId, resolved.absolute);
    return ok(`已创建 ${resolved.display}`, {
      path: resolved.display,
      bytes: value.fileText.length,
    });
  }

  if (value.command === "str_replace") {
    if (typeof value.oldStr !== "string" || !value.oldStr.length) {
      return fail("str_replace 需要非空 old_str");
    }
    if (!(await kbExists(resolved.absolute))) return fail("文件不存在");
    const gate = requireObserved(env, resolved.absolute, resolved.display);
    if (gate) return gate;
    const before = await readTextFile(resolved.absolute);
    const edited = applyLiteralEdit(before, value.oldStr, value.newStr ?? "", false);
    if (edited.ok === false) return fail(edited.reason);
    await writeTextFile(resolved.absolute, edited.content);
    rememberObservedPath(env.threadId, resolved.absolute);
    return ok(`已替换 ${resolved.display}`, {
      path: resolved.display,
      replacements: edited.replacements,
    });
  }

  // insert
  if (value.insertLine === undefined) return fail("insert 需要 insert_line");
  if (typeof value.newStr !== "string") return fail("insert 需要 new_str");
  if (!(await kbExists(resolved.absolute))) return fail("文件不存在");
  const gate = requireObserved(env, resolved.absolute, resolved.display);
  if (gate) return gate;
  const before = await readTextFile(resolved.absolute);
  const inserted = insertAtLine(before, value.insertLine, value.newStr);
  if (inserted.ok === false) return fail(inserted.reason);
  await writeTextFile(resolved.absolute, inserted.content);
  rememberObservedPath(env.threadId, resolved.absolute);
  return ok(`已插入 ${resolved.display}`, {
    path: resolved.display,
    insertLine: value.insertLine,
  });
}

async function runPresent(
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
): Promise<AgentToolResult> {
  const root = requireRoot(env);
  const parsed = parsePresentFiles(args);
  if (parsed.ok === false) return fail(parsed.reason);
  if (!isTauriRuntime()) return fail("当前环境不能打开本地文件");
  const delivered: Array<{ path: string; description?: string }> = [];
  for (const file of parsed.files) {
    const resolved = resolveWorkspacePath(root, file.path, env.cwd);
    if (resolved.ok === false) return fail(`${file.path}: ${resolved.reason}`);
    if (!(await kbExists(resolved.absolute))) {
      return fail(`文件不存在：${resolved.display}`);
    }
    const listed = await tryListDir(resolved.absolute);
    if (listed) return fail(`不能交付目录：${resolved.display}`);
    await openLocalPath(resolved.absolute);
    if (parsed.reveal) {
      await revealInExplorer(resolved.absolute).catch(() => undefined);
    }
    delivered.push({
      path: resolved.display,
      ...(file.description ? { description: file.description } : {}),
    });
  }
  return ok(`已交付 ${delivered.length} 个文件`, { files: delivered });
}

async function runOfficeToPdf(
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
): Promise<AgentToolResult> {
  const root = requireRoot(env);
  const inputRaw =
    (typeof args.input === "string" && args.input.trim()) ||
    (typeof args.path === "string" && args.path.trim()) ||
    (typeof args.file_path === "string" && args.file_path.trim()) ||
    "";
  if (!inputRaw) return fail("请提供 input");
  const input = resolveWorkspacePath(root, inputRaw, env.cwd);
  if (input.ok === false) return fail(input.reason);
  if (!(await kbExists(input.absolute))) return fail("输入文件不存在");
  let outputRaw = typeof args.output === "string" ? args.output.trim() : "";
  if (!outputRaw) {
    const base = input.absolute.replace(/\.[^.\\/]+$/u, "");
    outputRaw = `${base}.pdf`;
  }
  const output = resolveWorkspacePath(root, outputRaw, env.cwd);
  if (output.ok === false) return fail(output.reason);
  if (!isTauriRuntime()) return fail("当前环境不能转换 Office 文档");
  if (env.signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const opId = `office_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const invokePromise = invoke<{
    input: string;
    output: string;
    backend?: string | null;
  }>("agent_office_to_pdf", {
    root,
    input: input.absolute,
    output: output.absolute,
    opId,
  });
  const hit = env.signal
    ? await raceAbort(invokePromise, env.signal, async () => {
        try {
          await invoke("agent_office_cancel", { opId });
        } catch {
          /* ignore */
        }
      })
    : await invokePromise;
  return ok(`已转为 PDF ${output.display}`, {
    input: input.display,
    output: output.display,
    backend: hit.backend ?? null,
  });
}

function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort?: () => void | Promise<void>,
): Promise<T> {
  if (signal.aborted) {
    void onAbort?.();
    return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      void Promise.resolve(onAbort?.()).finally(() => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      },
    );
  });
}

async function runWrite(
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
): Promise<AgentToolResult> {
  const root = requireRoot(env);
  const raw = filePathFromArgs(args);
  if (!raw) return fail("请提供 file_path");
  if (typeof args.content !== "string") return fail("请提供 content");
  const resolved = resolveWorkspacePath(root, raw, env.cwd);
  if (resolved.ok === false) return fail(resolved.reason);
  if (await kbExists(resolved.absolute)) {
    const gate = requireObserved(env, resolved.absolute, resolved.display);
    if (gate) return gate;
  }
  await ensureParent(resolved.absolute);
  await writeTextFile(resolved.absolute, args.content);
  rememberObservedPath(env.threadId, resolved.absolute);
  return ok(`已写入 ${resolved.display}`, {
    path: resolved.display,
    bytes: args.content.length,
  });
}

async function runEdit(
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
): Promise<AgentToolResult> {
  const root = requireRoot(env);
  const raw = filePathFromArgs(args);
  if (!raw) return fail("请提供 file_path");
  if (typeof args.old_string !== "string") return fail("请提供 old_string");
  if (typeof args.new_string !== "string") return fail("请提供 new_string");
  const resolved = resolveWorkspacePath(root, raw, env.cwd);
  if (resolved.ok === false) return fail(resolved.reason);
  if (!(await kbExists(resolved.absolute))) return fail("文件不存在");
  const gate = requireObserved(env, resolved.absolute, resolved.display);
  if (gate) return gate;
  const before = await readTextFile(resolved.absolute);
  const edited = applyLiteralEdit(
    before,
    args.old_string,
    args.new_string,
    args.replace_all === true,
  );
  if (edited.ok === false) return fail(edited.reason);
  await writeTextFile(resolved.absolute, edited.content);
  rememberObservedPath(env.threadId, resolved.absolute);
  return ok(`已编辑 ${resolved.display}（${edited.replacements} 处）`, {
    path: resolved.display,
    replacements: edited.replacements,
  });
}

async function runGlob(
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
): Promise<AgentToolResult> {
  const root = requireRoot(env);
  const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
  if (!pattern) return fail("请提供 pattern");
  const scopeRaw = typeof args.path === "string" ? args.path.trim() : "";
  const scope = resolveWorkspacePath(root, scopeRaw || ".", env.cwd);
  if (scope.ok === false) return fail(scope.reason);

  const rg = await tryRipgrepFiles(env, pattern, scope.absolute);
  if (rg) return rg;

  const matcher = globToRegExp(pattern.includes("/") ? pattern : `**/${pattern}`);
  const files = await listFilesRecursive([scope.absolute], 8000);
  const hits = files
    .map((entry) => ({
      path: relativeTo(root, entry.path),
      absolute: entry.path,
      mtimeMs: entry.mtimeMs ?? 0,
    }))
    .filter((item) => matcher.test(item.path.replace(/\\/g, "/")))
    .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
    .slice(0, GLOB_RESULT_LIMIT);
  return ok(`找到 ${hits.length} 个文件`, {
    paths: hits.map((item) => item.path),
    truncated: files.length >= 8000,
  });
}

async function runGrep(
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
): Promise<AgentToolResult> {
  const root = requireRoot(env);
  const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
  if (!pattern) return fail("请提供 pattern");
  const scopeRaw = typeof args.path === "string" ? args.path.trim() : "";
  const scope = resolveWorkspacePath(root, scopeRaw || ".", env.cwd);
  if (scope.ok === false) return fail(scope.reason);
  const include = typeof args.include === "string" ? args.include.trim() : "";

  const rgArgs = [
    "-n",
    "--no-heading",
    "--color",
    "never",
    "-m",
    String(GREP_CAPTURE_LIMIT),
  ];
  if (include) rgArgs.push("--glob", include);
  rgArgs.push(pattern, ".");
  if (!env.hostTools) return fail("本机搜索工具尚未就绪");
  const result = await runHostTool(env.hostTools, {
    toolId: "ripgrep",
    args: rgArgs,
    cwd: scope.absolute,
  });
  if (!result.ok) {
    // ripgrep exit 1 = no matches
    const code =
      result.data && typeof result.data === "object" && "code" in result.data
        ? (result.data as { code?: number }).code
        : undefined;
    if (code === 1) {
      return ok("没有匹配", {
        matches: [],
        paths: [],
        truncated: false,
        spillPath: null,
        spillBytes: null,
        retentionNotice: null,
      });
    }
    return result;
  }
  const stdout =
    result.data && typeof result.data === "object" && "stdout" in result.data
      ? String((result.data as { stdout?: string }).stdout ?? "")
      : "";
  const captured = parseRgLines(stdout, root).slice(0, GREP_CAPTURE_LIMIT);
  const matches = captured.slice(0, GREP_MATCH_LIMIT);
  let spillPath: string | null = null;
  let spillBytes: number | null = null;
  let retentionNotice: string | null = null;
  const spill = shouldSpillGrepMatches(captured.length);
  if (spill) {
    const spillBody = formatGrepSpillText(captured);
    if (isTauriRuntime()) {
      try {
        const saved = await saveToolSpill({
          root,
          toolName: "grep",
          suggestedName: "grep",
          content: spillBody,
        });
        spillPath = saved.locator;
        spillBytes = saved.bytes;
      } catch {
        /* keep inline preview without spill */
      }
    }
    const retained = formatRetentionNotice({
      content: spillBody,
      spillPath,
      spillBytes,
      headBytes: Math.min(spillBody.length, formatGrepSpillText(matches).length + 1),
      tailBytes: 0,
      kind: "head",
      toolHint: spillPath
        ? `用 read 打开 ${spillPath}（可加 offset/limit），或用 grep 搜索该文件。`
        : "匹配过多；请收窄 pattern / path / include 后再搜。",
    });
    retentionNotice = retained.notice || null;
  }
  const hitCeiling = captured.length >= GREP_CAPTURE_LIMIT;
  const summary = spill
    ? hitCeiling
      ? `匹配至少 ${captured.length} 处（已截断内联，详见 spill）`
      : `匹配 ${captured.length} 处（内联 ${matches.length} 条，详见 spill）`
    : `匹配 ${matches.length} 处`;
  return ok(summary, {
    matches,
    paths: matches.map((m) => m.path),
    matchCount: captured.length,
    truncated: spill,
    spillPath,
    spillBytes,
    retentionNotice,
  });
}

async function runApplyPatch(
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
): Promise<AgentToolResult> {
  const root = requireRoot(env);
  const patch = typeof args.patch === "string" ? args.patch : "";
  if (!patch.trim()) return fail("请提供 patch");
  let operations;
  try {
    operations = parsePatch(patch);
  } catch (error) {
    if (error instanceof PatchParseError) {
      return fail(`补丁语法错误（第 ${error.lineNumber} 行）：${error.reason}`);
    }
    throw error;
  }
  if (operations.length === 0) return fail("补丁为空");
  const changed: string[] = [];
  for (const op of operations) {
    const resolved = resolveWorkspacePath(root, op.path, env.cwd);
    if (resolved.ok === false) return fail(`${op.path}: ${resolved.reason}`);
    if (op.kind === "add") {
      if (await kbExists(resolved.absolute)) {
        const gate = requireObserved(env, resolved.absolute, resolved.display);
        if (gate) return gate;
      }
      await ensureParent(resolved.absolute);
      await writeTextFile(resolved.absolute, op.content);
      rememberObservedPath(env.threadId, resolved.absolute);
      changed.push(`+ ${resolved.display}`);
      continue;
    }
    if (op.kind === "delete") {
      if (!(await kbExists(resolved.absolute))) {
        return fail(`删除失败，文件不存在：${resolved.display}`);
      }
      const delGate = assertCanDeleteExisting(
        observedPathsFor(env.threadId),
        resolved.absolute,
        resolved.display,
      );
      if (delGate.ok === false) {
        return failNotObserved(delGate.reason);
      }
      await kbRemove(resolved.absolute);
      forgetObservedPath(env.threadId, resolved.absolute);
      changed.push(`- ${resolved.display}`);
      continue;
    }
    if (!(await kbExists(resolved.absolute))) {
      return fail(`更新失败，文件不存在：${resolved.display}`);
    }
    const gate = requireObserved(env, resolved.absolute, resolved.display);
    if (gate) return gate;
    const before = await readTextFile(resolved.absolute);
    const applied = applyHunks(before.replace(/\r\n/g, "\n"), op.hunks);
    if (applied.ok === false) {
      return fail(
        `无法匹配 ${resolved.display} 的 hunk（补丁第 ${applied.failure.hunkLineNumber} 行）`,
      );
    }
    let display = resolved.display;
    if (op.moveTo) {
      const moved = resolveWorkspacePath(root, op.moveTo, env.cwd);
      if (moved.ok === false) return fail(`Move to ${op.moveTo}: ${moved.reason}`);
      if (await kbExists(moved.absolute)) {
        const moveGate = requireObserved(env, moved.absolute, moved.display);
        if (moveGate) return moveGate;
      }
      await ensureParent(moved.absolute);
      await writeTextFile(moved.absolute, applied.after);
      await kbRemove(resolved.absolute);
      forgetObservedPath(env.threadId, resolved.absolute);
      rememberObservedPath(env.threadId, moved.absolute);
      display = `${resolved.display} → ${moved.display}`;
    } else {
      await writeTextFile(resolved.absolute, applied.after);
      rememberObservedPath(env.threadId, resolved.absolute);
    }
    changed.push(`~ ${display}`);
  }
  return ok(`已应用补丁（${changed.length} 个文件）`, { files: changed });
}

async function runShellCommand(
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
  shell: "pwsh" | "bash",
): Promise<AgentToolResult> {
  const root = requireRoot(env);
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) return fail("请提供 command");
  const workdirRaw = typeof args.workdir === "string" ? args.workdir.trim() : "";
  let workdir = sessionCwd(env);
  if (workdirRaw) {
    const resolved = resolveWorkspacePath(root, workdirRaw, env.cwd);
    if (resolved.ok === false) return fail(resolved.reason);
    workdir = resolved.absolute;
  }
  const label =
    typeof args.description === "string" && args.description.trim()
      ? args.description.trim()
      : "已执行命令";
  if (!isTauriRuntime()) return fail("当前环境不能执行终端命令");
  const { invoke } = await import("@tauri-apps/api/core");
  const managedEnv = await managedShellEnvFor(env, root, workdir);
  if (args.background === true) {
    const hit = await invoke<{ id: string; description: string }>(
      "agent_workspace_job_start",
      { root, command, workdir, description: label, shell, managedEnv },
    );
    if (env.threadId) {
      trackBackgroundJob(env.threadId, hit.id, hit.description || label);
    }
    return ok(`已后台启动 ${hit.id}`, { jobId: hit.id, description: hit.description });
  }
  const timeout =
    typeof args.timeout === "number" && Number.isFinite(args.timeout)
      ? Math.max(0, Math.floor(args.timeout))
      : 120_000;
  // Always run via job registry so timeout can promote (DSH promoteOnTimeout)
  // and AbortSignal can still hard-kill on user cancel.
  return runCancelableShell({
    root,
    command,
    workdir,
    label,
    shell,
    timeoutMs: timeout,
    signal: env.signal ?? new AbortController().signal,
    threadId: env.threadId,
    managedEnv,
  });
}

type JobOutputHit = {
  id: string;
  status: string;
  code: number | null;
  output: string;
  stderr: string;
  truncated: boolean;
  done: boolean;
  spillPath?: string | null;
  spillBytes?: number | null;
};

function presentShellResult(input: {
  label: string;
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  spillPath?: string | null;
  spillBytes?: number | null;
  jobId?: string;
  status?: string;
  cwd?: string;
  /** Foreground wait timed out; process kept as background job. */
  promoted?: boolean;
  timeoutMs?: number;
  stopped?: string | null;
}): AgentToolResult {
  const combined = [input.stdout, input.stderr].filter(Boolean).join("\n");
  const retained = formatRetentionNotice({
    content: combined,
    spillPath: input.spillPath,
    spillBytes: input.spillBytes,
  });
  const truncated =
    input.truncated || retained.omittedBytes > 0 || Boolean(input.spillPath);
  let stdout = input.stdout;
  let stderr = input.stderr;
  if (truncated) {
    // Combined head/tail preview; DSH-style markers appended in `text`.
    stdout = retained.preview;
    stderr = "";
  }
  const text = formatShellModelText({
    stdout,
    stderr,
    code: input.code,
    truncated,
    spillPath: input.spillPath,
    promoted: input.promoted,
    timeoutMs: input.timeoutMs,
    jobId: input.jobId,
    stopped: input.stopped,
  });
  // Non-zero exit is a result for the model, not a tool infrastructure failure.
  const summary = input.promoted
    ? `${input.label}（已转后台 ${input.jobId}）`
    : input.code === 0
      ? input.label
      : `${input.label}（退出码 ${input.code}）`;
  return {
    ok: true,
    summary,
    data: {
      ok: input.code === 0 && !input.promoted,
      code: input.code,
      cwd: input.cwd ?? null,
      stdout,
      stderr,
      text,
      truncated,
      spillPath: input.spillPath ?? null,
      spillBytes: input.spillBytes ?? null,
      retentionNotice: retained.notice || null,
      promoted: Boolean(input.promoted),
      ...(input.jobId ? { jobId: input.jobId, status: input.status } : {}),
    },
    effects: [],
  };
}

async function managedShellEnvFor(
  env: WorkspaceToolEnv,
  root: string,
  cwd: string,
): Promise<Record<string, string>> {
  let home: string | null = null;
  try {
    home = await resolveDataDir();
  } catch {
    home = null;
  }
  return collectManagedShellEnv({
    home,
    sessionId: env.threadId,
    workspaceRoot: root,
    cwd,
  });
}

async function runCancelableShell(input: {
  root: string;
  command: string;
  workdir: string;
  label: string;
  shell: "pwsh" | "bash";
  timeoutMs: number;
  signal: AbortSignal;
  threadId?: string | null;
  managedEnv?: Record<string, string>;
}): Promise<AgentToolResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  if (input.signal.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  const managedEnv =
    input.managedEnv ??
    (await managedShellEnvFor(
      { rootPath: input.root, threadId: input.threadId },
      input.root,
      input.workdir,
    ));
  const started = await invoke<{ id: string; description: string }>(
    "agent_workspace_job_start",
    {
      root: input.root,
      command: input.command,
      workdir: input.workdir,
      description: input.label,
      shell: input.shell,
      managedEnv,
    },
  );
  const deadline = Date.now() + input.timeoutMs;
  let stdout = "";
  let stderr = "";
  let truncated = false;
  let spillPath: string | null = null;
  let spillBytes: number | null = null;
  try {
    while (true) {
      if (input.signal.aborted) {
        await invoke("agent_workspace_job_kill", {
          jobId: started.id,
          reason: "user stopped",
        });
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const remaining = Math.max(0, deadline - Date.now());
      if (input.timeoutMs > 0 && remaining === 0) {
        // promoteOnTimeout: keep the process; hand the same job id to the model.
        if (input.threadId) {
          trackBackgroundJob(
            input.threadId,
            started.id,
            started.description || input.label,
          );
        }
        return presentShellResult({
          label: input.label,
          code: -1,
          stdout: stripAnsiEscapes(stdout),
          stderr: stripAnsiEscapes(stderr),
          truncated,
          spillPath,
          spillBytes,
          jobId: started.id,
          status: "running",
          cwd: input.workdir,
          promoted: true,
          timeoutMs: input.timeoutMs,
        });
      }
      const slice = Math.min(400, remaining || 400);
      const hit = await invoke<JobOutputHit>("agent_workspace_job_output", {
        jobId: started.id,
        wait: true,
        timeoutMs: slice,
      });
      if (hit.output) stdout += hit.output;
      if (hit.stderr) stderr = hit.stderr;
      truncated = truncated || hit.truncated;
      if (hit.spillPath) spillPath = hit.spillPath;
      if (hit.spillBytes != null) spillBytes = hit.spillBytes;
      if (hit.done) {
        const stopped =
          hit.status === "killed" || hit.status === "failed" ? hit.status : null;
        return presentShellResult({
          label: input.label,
          code: hit.code ?? (hit.status === "completed" ? 0 : -1),
          stdout: stripAnsiEscapes(stdout),
          stderr: stripAnsiEscapes(stderr),
          truncated,
          spillPath,
          spillBytes,
          jobId: started.id,
          status: hit.status,
          cwd: input.workdir,
          stopped,
        });
      }
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    try {
      await invoke("agent_workspace_job_kill", {
        jobId: started.id,
        reason: "error",
      });
    } catch {
      /* ignore */
    }
    throw error;
  }
}

async function runWorkingDirectory(
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
): Promise<AgentToolResult> {
  const root = requireRoot(env);
  const raw =
    (typeof args.path === "string" && args.path.trim()) ||
    (typeof args.cd === "string" && args.cd.trim()) ||
    "";
  if (!raw) {
    const cwd = sessionCwd(env);
    return ok(`当前工作目录 ${cwd}`, { cwd });
  }
  const resolved = resolveWorkspacePath(root, raw, env.cwd);
  if (resolved.ok === false) return fail(resolved.reason);
  if (!(await kbExists(resolved.absolute))) return fail("目录不存在");
  const listed = await tryListDir(resolved.absolute);
  if (!listed) return fail("目标不是目录");
  env.onCwd?.(resolved.absolute);
  return ok(`已切换到 ${resolved.absolute}`, { cwd: resolved.absolute });
}

async function runTerminalOpen(
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
): Promise<AgentToolResult> {
  const root = requireRoot(env);
  if (!isTauriRuntime()) return fail("当前环境不能打开终端");
  const workdirRaw = typeof args.workdir === "string" ? args.workdir.trim() : "";
  let workdir = sessionCwd(env);
  if (workdirRaw) {
    const resolved = resolveWorkspacePath(root, workdirRaw, env.cwd);
    if (resolved.ok === false) return fail(resolved.reason);
    workdir = resolved.absolute;
  }
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const shellRaw = typeof args.shell === "string" ? args.shell.trim().toLowerCase() : "";
  const shell =
    shellRaw === "bash" || shellRaw === "sh"
      ? "bash"
      : shellRaw === "pwsh" || shellRaw === "powershell"
        ? "pwsh"
        : preferShell();
  const { invoke } = await import("@tauri-apps/api/core");
  const managedEnv = await managedShellEnvFor(env, root, workdir);
  const hit = await invoke<{ id: string; name: string; cwd: string; shell: string }>(
    "agent_terminal_open",
    { root, workdir, name: name || null, shell, managedEnv },
  );
  return ok(`已打开终端 ${hit.id}（${hit.shell || shell}）`, hit);
}

async function runTerminalSend(args: Record<string, unknown>): Promise<AgentToolResult> {
  const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
  if (!sessionId) return fail("请提供 session_id");
  if (typeof args.text !== "string") return fail("请提供 text");
  if (!isTauriRuntime()) return fail("当前环境不能写入终端");
  const submit = args.submit !== false;
  const timeout =
    typeof args.timeout === "number" && Number.isFinite(args.timeout)
      ? Math.max(200, Math.floor(args.timeout))
      : 15_000;
  const { invoke } = await import("@tauri-apps/api/core");
  const hit = await invoke<{ id: string; output: string; alive: boolean }>(
    "agent_terminal_send",
    { sessionId, text: args.text, submit, timeoutMs: timeout },
  );
  return ok(hit.alive ? `已写入 ${hit.id}` : `终端 ${hit.id} 已结束`, {
    ...hit,
    output: stripAnsiEscapes(hit.output ?? ""),
  });
}

async function runTerminalRead(args: Record<string, unknown>): Promise<AgentToolResult> {
  const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
  if (!sessionId) return fail("请提供 session_id");
  if (!isTauriRuntime()) return fail("当前环境不能读取终端");
  const offset =
    typeof args.offset === "number" && Number.isFinite(args.offset)
      ? Math.max(0, Math.floor(args.offset))
      : 0;
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.max(1, Math.floor(args.limit))
      : 500;
  const { invoke } = await import("@tauri-apps/api/core");
  const hit = await invoke<{ id: string; output: string; alive: boolean }>(
    "agent_terminal_read",
    { sessionId, offset, limit },
  );
  return ok(`终端 ${hit.id}`, {
    ...hit,
    output: stripAnsiEscapes(hit.output ?? ""),
  });
}

async function runTerminalList(): Promise<AgentToolResult> {
  if (!isTauriRuntime()) return fail("当前环境不能列出终端");
  const { invoke } = await import("@tauri-apps/api/core");
  const terminals =
    await invoke<Array<{ id: string; name: string; cwd: string; alive: boolean }>>(
      "agent_terminal_list",
    );
  return ok(terminals.length ? `终端 ${terminals.length} 个` : "没有打开的终端", {
    terminals,
  });
}

async function runTerminalClose(args: Record<string, unknown>): Promise<AgentToolResult> {
  const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
  if (!sessionId) return fail("请提供 session_id");
  if (!isTauriRuntime()) return fail("当前环境不能关闭终端");
  const { invoke } = await import("@tauri-apps/api/core");
  const hit = await invoke<{ id: string; name: string; cwd: string; alive: boolean }>(
    "agent_terminal_close",
    { sessionId },
  );
  return ok(`已关闭 ${hit.id}`, hit);
}

async function runTerminalSignal(
  args: Record<string, unknown>,
): Promise<AgentToolResult> {
  const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
  if (!sessionId) return fail("请提供 session_id");
  if (!isTauriRuntime()) return fail("当前环境不能发信号");
  const signal = typeof args.signal === "string" ? args.signal.trim() : "SIGINT";
  const { invoke } = await import("@tauri-apps/api/core");
  const hit = await invoke<{ id: string; name: string; cwd: string; alive: boolean }>(
    "agent_terminal_signal",
    { sessionId, signal },
  );
  return ok(`已向 ${hit.id} 发送 ${signal || "SIGINT"}`, hit);
}

function preferShell(): "pwsh" | "bash" {
  if (typeof navigator !== "undefined") {
    const platform = `${navigator.platform || ""} ${(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || ""}`;
    if (/win/i.test(platform)) return "pwsh";
  }
  if (typeof process !== "undefined" && process.platform === "win32") return "pwsh";
  return "bash";
}

function deepSeekApiKey(env: WorkspaceToolEnv): string | null {
  const fromStore = env.readApiKey?.("deepseek")?.trim();
  if (fromStore) return fromStore;
  return null;
}

function sessionCwd(env: WorkspaceToolEnv): string {
  const root = requireRoot(env);
  const cwd = env.cwd?.trim();
  return cwd || root;
}

/** Validate ask_user_question args for the approval/question UI. */
export function validateAskUserQuestions(args: Record<string, unknown>) {
  return parseAskUserQuestions(args);
}

async function runWebFetch(
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
): Promise<AgentToolResult> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) return fail("请提供 url");
  if (!isAllowedFetchUrl(url)) return fail("只支持 http/https URL");
  if (env.signal?.aborted)
    throw new DOMException("The operation was aborted.", "AbortError");
  const apiKey = deepSeekApiKey(env);
  if (apiKey) {
    const deep = await tryDeepSeekFetch(url, apiKey, env.signal, env.rootPath);
    if (deep) return deep;
  }
  const response = await hostFetch(url, {
    method: "GET",
    timeoutMs: 30_000,
    signal: env.signal,
  });
  const raw = await response.text();
  const text = htmlToReadableText(raw);
  return presentFetchedText({
    url,
    status: response.status,
    text,
    provider: "http",
    okStatus: response.ok,
    root: env.rootPath,
  });
}

async function tryDeepSeekFetch(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
  root?: string | null,
): Promise<AgentToolResult | null> {
  try {
    const response = await hostFetch(`${DEEPSEEK_WEB_API_BASE_URL}/fetch`, {
      method: "POST",
      timeoutMs: 60_000,
      signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "WorkbenchAgent/1.0",
      },
      body: JSON.stringify({ url }),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { content?: unknown };
    if (typeof payload.content !== "string" || !payload.content.trim()) return null;
    return presentFetchedText({
      url,
      status: 200,
      text: htmlToReadableText(payload.content),
      provider: "deepseek",
      okStatus: true,
      root: root ?? undefined,
    });
  } catch {
    return null;
  }
}

async function presentFetchedText(input: {
  url: string;
  status: number;
  text: string;
  provider: string;
  okStatus: boolean;
  root?: string;
}): Promise<AgentToolResult> {
  let text = input.text;
  let spillPath: string | null = null;
  let spillBytes: number | null = null;
  let retentionNotice: string | null = null;
  if (text.length > WEB_FETCH_LIMIT) {
    if (input.root?.trim() && isTauriRuntime()) {
      try {
        const spill = await saveToolSpill({
          root: input.root,
          toolName: "web_fetch",
          suggestedName: "web-fetch",
          content: text,
        });
        spillPath = spill.locator;
        spillBytes = spill.bytes;
      } catch {
        /* keep truncated preview without spill */
      }
    }
    const retained = formatRetentionNotice({
      content: text,
      spillPath,
      spillBytes,
      headBytes: Math.floor(WEB_FETCH_LIMIT * 0.6),
      tailBytes: Math.floor(WEB_FETCH_LIMIT * 0.3),
    });
    text = retained.preview;
    retentionNotice = retained.notice || null;
  }
  return ok(
    input.okStatus ? `已抓取 ${input.url}` : `抓取 ${input.url} 返回 ${input.status}`,
    {
      url: input.url,
      status: input.status,
      text,
      provider: input.provider,
      truncated: Boolean(retentionNotice),
      spillPath,
      spillBytes,
      retentionNotice,
    },
  );
}

async function runWebSearch(
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
): Promise<AgentToolResult> {
  const parsed = parseWebSearchQueries(args);
  if (parsed.ok === false) return fail(parsed.reason);
  if (env.signal?.aborted)
    throw new DOMException("The operation was aborted.", "AbortError");
  const apiKey = deepSeekApiKey(env);
  if (apiKey) {
    const deep = await searchViaDeepSeek(parsed.queries, apiKey, env.signal);
    if (deep) return deep;
  }
  return searchViaDuckDuckGo(parsed.queries, env.signal);
}

async function searchViaDeepSeek(
  queries: string[],
  apiKey: string,
  signal?: AbortSignal,
): Promise<AgentToolResult | null> {
  const results = [];
  const seen = new Set<string>();
  let anyOk = false;
  for (const raw of queries) {
    if (signal?.aborted)
      throw new DOMException("The operation was aborted.", "AbortError");
    const query = boundDeepSeekSearchText(raw);
    if (!query) continue;
    try {
      const response = await hostFetch(`${DEEPSEEK_WEB_API_BASE_URL}/search`, {
        method: "POST",
        timeoutMs: 60_000,
        signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "WorkbenchAgent/1.0",
        },
        body: JSON.stringify({
          query,
          count: Math.min(WEB_SEARCH_MAX_RESULTS, 10),
          need_content: false,
        }),
      });
      if (!response.ok) continue;
      anyOk = true;
      const payload = await response.json();
      for (const hit of parseDeepSeekSearchResponse(payload, WEB_SEARCH_MAX_RESULTS)) {
        if (seen.has(hit.url)) continue;
        seen.add(hit.url);
        results.push(hit);
        if (results.length >= WEB_SEARCH_MAX_RESULTS) break;
      }
      if (results.length >= WEB_SEARCH_MAX_RESULTS) break;
    } catch {
      /* try next query / fall through to DDG */
    }
  }
  if (!anyOk && results.length === 0) return null;
  return ok(results.length ? `找到 ${results.length} 条结果` : "没有搜索结果", {
    queries,
    results,
    provider: "deepseek",
  });
}

async function searchViaDuckDuckGo(
  queries: string[],
  signal?: AbortSignal,
): Promise<AgentToolResult> {
  const results = [];
  const seen = new Set<string>();
  for (const query of queries) {
    if (signal?.aborted)
      throw new DOMException("The operation was aborted.", "AbortError");
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await hostFetch(url, {
      method: "GET",
      timeoutMs: 30_000,
      signal,
      headers: { "user-agent": "Mozilla/5.0 WorkbenchAgent/1.0" },
    });
    if (!response.ok) continue;
    const html = await response.text();
    for (const hit of parseDuckDuckGoHtml(html, WEB_SEARCH_MAX_RESULTS)) {
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      results.push(hit);
      if (results.length >= WEB_SEARCH_MAX_RESULTS) break;
    }
    if (results.length >= WEB_SEARCH_MAX_RESULTS) break;
  }
  return ok(results.length ? `找到 ${results.length} 条结果` : "没有搜索结果", {
    queries,
    results,
    provider: "duckduckgo",
  });
}

function runTodoWrite(
  args: Record<string, unknown>,
  env: WorkspaceToolEnv,
): AgentToolResult {
  const parsed = parseTodoWriteArgs(args);
  if (parsed.ok === false) return fail(parsed.reason);
  env.onTodos?.(parsed.todos);
  return ok(`已更新待办 ${parsed.todos.length} 项`, { todos: parsed.todos });
}

async function runJobList(): Promise<AgentToolResult> {
  if (!isTauriRuntime()) return fail("当前环境不能查看后台任务");
  const { invoke } = await import("@tauri-apps/api/core");
  const jobs = await invoke<
    Array<{
      id: string;
      description: string;
      status: string;
      code: number | null;
      truncated: boolean;
    }>
  >("agent_workspace_job_list");
  return ok(jobs.length ? `后台任务 ${jobs.length} 个` : "没有后台任务", { jobs });
}

async function runJobOutput(args: Record<string, unknown>): Promise<AgentToolResult> {
  const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
  if (!jobId) return fail("请提供 job_id");
  if (!isTauriRuntime()) return fail("当前环境不能读取后台任务");
  clearJobNotice(jobId);
  const wait = args.wait === true;
  const timeout =
    typeof args.timeout === "number" && Number.isFinite(args.timeout)
      ? Math.max(0, Math.floor(args.timeout))
      : 30_000;
  const { invoke } = await import("@tauri-apps/api/core");
  const hit = await invoke<{
    id: string;
    status: string;
    code: number | null;
    output: string;
    stderr: string;
    truncated: boolean;
    done: boolean;
  }>("agent_workspace_job_output", {
    jobId,
    wait,
    timeoutMs: timeout,
  });
  const summary = hit.done
    ? `任务 ${hit.id} 已结束（${hit.status}）`
    : `任务 ${hit.id} 仍在运行`;
  return ok(summary, {
    ...hit,
    output: stripAnsiEscapes(hit.output ?? ""),
    stderr: stripAnsiEscapes(hit.stderr ?? ""),
  });
}

async function runJobKill(args: Record<string, unknown>): Promise<AgentToolResult> {
  const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
  if (!jobId) return fail("请提供 job_id");
  if (!isTauriRuntime()) return fail("当前环境不能取消后台任务");
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  const { invoke } = await import("@tauri-apps/api/core");
  const hit = await invoke<{
    id: string;
    description: string;
    status: string;
    code: number | null;
    truncated: boolean;
  }>("agent_workspace_job_kill", {
    jobId,
    reason: reason || null,
  });
  return ok(`已请求取消 ${hit.id}`, hit);
}

async function tryRipgrepFiles(
  env: WorkspaceToolEnv,
  pattern: string,
  cwd: string,
): Promise<AgentToolResult | null> {
  if (!env.hostTools) return null;
  const ready = env.hostTools.find(
    (item) => item.id === "ripgrep" && item.enabled && item.status === "ready",
  );
  if (!ready) return null;
  const result = await runHostTool(env.hostTools, {
    toolId: "ripgrep",
    args: ["--files", "--glob", pattern, "."],
    cwd,
  });
  if (!result.ok) return null;
  const stdout =
    result.data && typeof result.data === "object" && "stdout" in result.data
      ? String((result.data as { stdout?: string }).stdout ?? "")
      : "";
  const root = env.rootPath ? normalizePath(env.rootPath) : cwd;
  const paths = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => relativeTo(root, joinMaybe(cwd, line)))
    .slice(0, GLOB_RESULT_LIMIT);
  return ok(`找到 ${paths.length} 个文件`, { paths });
}

function joinMaybe(cwd: string, rel: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith("/") || rel.startsWith("\\")) {
    return normalizePath(rel);
  }
  const sep = cwd.includes("\\") ? "\\" : "/";
  return normalizePath(cwd.replace(/[\\/]+$/, "") + sep + rel);
}

function relativeTo(root: string, absolute: string): string {
  const base = normalizePath(root);
  const target = normalizePath(absolute);
  if (!isPathUnder(base, target)) return target;
  const prefix = base.replace(/[\\/]+$/, "");
  const rest = target.slice(prefix.length).replace(/^[\\/]+/, "");
  return rest || ".";
}

function parseRgLines(
  stdout: string,
  root: string,
): Array<{ path: string; line: number; text: string }> {
  const out: Array<{ path: string; line: number; text: string }> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    const match = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!match) continue;
    out.push({
      path: relativeTo(root, match[1]!),
      line: Number(match[2]),
      text: match[3] ?? "",
    });
  }
  return out;
}

async function tryListDir(path: string): Promise<KbEntry[] | null> {
  try {
    return await listDirectory(path);
  } catch {
    return null;
  }
}

/** Two-level directory rows for str_replace_editor view (DSH shallow listing). */
async function collectStrReplaceDirRows(
  absoluteRoot: string,
  displayRoot: string,
): Promise<Array<{ kind: "d" | "f"; path: string }>> {
  const rows: Array<{ kind: "d" | "f"; path: string }> = [
    { kind: "d", path: displayRoot },
  ];
  const top = (await tryListDir(absoluteRoot)) ?? [];
  for (const entry of top) {
    if (shouldSkipStrReplaceDirEntry(entry.name)) continue;
    const childDisplay = `${displayRoot.replace(/[\\/]+$/, "")}/${entry.name}`;
    const childAbsolute = joinPath(absoluteRoot, entry.name);
    if (entry.isDir) {
      rows.push({ kind: "d", path: childDisplay });
      const nested = (await tryListDir(childAbsolute)) ?? [];
      for (const child of nested) {
        if (shouldSkipStrReplaceDirEntry(child.name)) continue;
        rows.push({
          kind: child.isDir ? "d" : "f",
          path: `${childDisplay}/${child.name}`,
        });
      }
    } else {
      rows.push({ kind: "f", path: childDisplay });
    }
  }
  return rows;
}

async function ensureParent(filePath: string): Promise<void> {
  const parent = parentDir(filePath);
  if (!parent || parent === filePath) return;
  if (await kbExists(parent)) return;
  await kbMkdir(parent);
}

function requireObserved(
  env: WorkspaceToolEnv,
  absolutePath: string,
  displayPath: string,
): AgentToolResult | null {
  const decision = assertCanModifyExisting(
    observedPathsFor(env.threadId),
    absolutePath,
    displayPath,
  );
  if (decision.ok === true) return null;
  return failNotObserved(decision.reason);
}

function failNotObserved(reason: string): AgentToolResult {
  return {
    ok: false,
    summary: reason,
    data: { error: reason, code: FS_NOT_OBSERVED },
    effects: [],
  };
}

function requireRoot(env: WorkspaceToolEnv): string {
  const root = env.rootPath?.trim() ?? "";
  if (!root) throw new Error("当前会话未绑定工作区目录");
  return normalizePath(root);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function ok(summary: string, data: unknown): AgentToolResult {
  return { ok: true, summary, data, effects: [] };
}

function fail(summary: string): AgentToolResult {
  return { ok: false, summary, data: { error: summary }, effects: [] };
}
