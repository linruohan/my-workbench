import { describe, expect, it } from "vitest";
import {
  applyLiteralEdit,
  boundDeepSeekSearchText,
  filePathFromArgs,
  formatNumberedLines,
  formatTodosForPrompt,
  formatWorkspaceToolsHint,
  globToRegExp,
  htmlToReadableText,
  insertAtLine,
  isAllowedFetchUrl,
  isWorkspaceBoundToolName,
  isWorkspaceToolName,
  parseAskUserMode,
  parseDeepSeekSearchResponse,
  parseDuckDuckGoHtml,
  parsePresentFiles,
  parseReadWindow,
  parseStrReplaceEditorArgs,
  parseTodoWriteArgs,
  parseAskUserQuestions,
  parseWebSearchQueries,
  resolveWorkspacePath,
  sniffImageDimensions,
  sniffImageMediaType,
  stripAnsiEscapes,
  toolsForMode,
  gateTool,
} from "../src/index.js";

describe("workspace tool catalog", () => {
  it("registers DSH-style names and gates bound tools without a workspace", () => {
    expect(isWorkspaceToolName("read")).toBe(true);
    expect(isWorkspaceToolName("read_image")).toBe(true);
    expect(isWorkspaceToolName("bash")).toBe(true);
    expect(isWorkspaceToolName("str_replace_editor")).toBe(true);
    expect(isWorkspaceToolName("present")).toBe(true);
    expect(isWorkspaceToolName("office_to_pdf")).toBe(true);
    expect(isWorkspaceToolName("web_search")).toBe(true);
    expect(isWorkspaceToolName("ask_user_question")).toBe(true);
    expect(isWorkspaceBoundToolName("web_search")).toBe(false);
    expect(isWorkspaceBoundToolName("terminal_open")).toBe(true);
    expect(isWorkspaceToolName("task_list")).toBe(false);
    const unbound = toolsForMode("confirm", undefined, { workspaceBound: false });
    expect(unbound.some((tool) => tool.name === "read")).toBe(false);
    expect(unbound.some((tool) => tool.name === "web_search")).toBe(true);
    expect(unbound.some((tool) => tool.name === "ask_user_question")).toBe(true);
    expect(unbound.some((tool) => tool.name === "job_list")).toBe(true);
    expect(
      toolsForMode("confirm", undefined, { workspaceBound: true }).some(
        (tool) => tool.name === "shell" || tool.name === "working_directory",
      ),
    ).toBe(true);
    expect(
      toolsForMode("confirm", undefined, { workspaceBound: true }).some(
        (tool) => tool.name === "present" || tool.name === "office_to_pdf",
      ),
    ).toBe(true);
    expect(formatWorkspaceToolsHint(true)).toContain("terminal_");
    expect(formatWorkspaceToolsHint(true)).toContain("read_image");
    expect(formatWorkspaceToolsHint(false)).toContain("ask_user_question");
  });
});

describe("new workspace helpers", () => {
  it("sniffs image media types", () => {
    expect(sniffImageMediaType(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0))).toBe(
      "image/png",
    );
    expect(sniffImageMediaType(Uint8Array.of(0xff, 0xd8, 0xff, 0, 0, 0, 0, 0))).toBe(
      "image/jpeg",
    );
    expect(sniffImageMediaType(new Uint8Array(), "shot.webp")).toBe("image/webp");
    expect(sniffImageMediaType(new Uint8Array(), "a.txt")).toBeUndefined();
  });

  it("sniffs PNG and GIF dimensions", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    png[16] = 0;
    png[17] = 0;
    png[18] = 0;
    png[19] = 32;
    png[20] = 0;
    png[21] = 0;
    png[22] = 0;
    png[23] = 16;
    expect(sniffImageDimensions(png)).toEqual({ width: 32, height: 16 });
    const gif = Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x0a, 0x00, 0x14, 0x00);
    expect(sniffImageDimensions(gif)).toEqual({ width: 10, height: 20 });
  });

  it("parses present / ask timed / str_replace_editor / insert", () => {
    expect(parsePresentFiles({ path: "out/a.pdf", description: "报告" })).toEqual({
      ok: true,
      files: [{ path: "out/a.pdf", description: "报告" }],
      reveal: true,
    });
    expect(parseAskUserMode({ mode: "timed", timeout: 30 })).toEqual({
      mode: "timed",
      timeoutSec: 30,
    });
    const editor = parseStrReplaceEditorArgs({
      command: "str_replace",
      path: "a.ts",
      old_str: "a",
      new_str: "b",
    });
    expect(editor.ok).toBe(true);
    if (editor.ok) {
      expect(editor.value.command).toBe("str_replace");
      expect(editor.value.oldStr).toBe("a");
    }
    expect(insertAtLine("a\nb\n", 1, "x")).toEqual({ ok: true, content: "a\nx\nb\n" });
  });
});

describe("resolveWorkspacePath", () => {
  it("joins relative paths against cwd and rejects escapes", () => {
    const root = "D:\\codehub\\demo";
    expect(resolveWorkspacePath(root, "src\\a.ts")).toEqual({
      ok: true,
      absolute: "D:\\codehub\\demo\\src\\a.ts",
      display: "src\\a.ts",
    });
    expect(resolveWorkspacePath(root, "a.ts", "D:\\codehub\\demo\\src")).toEqual({
      ok: true,
      absolute: "D:\\codehub\\demo\\src\\a.ts",
      display: "a.ts",
    });
    expect(resolveWorkspacePath(root, "..\\secret").ok).toBe(false);
    expect(resolveWorkspacePath(root, "D:\\other\\x.ts").ok).toBe(false);
    expect(resolveWorkspacePath("", "a.ts").ok).toBe(false);
  });
});

describe("read formatting", () => {
  it("numbers lines and reports continuation", () => {
    const text = ["a", "b", "c", "d"].join("\n");
    const first = formatNumberedLines(text, 2, 2);
    expect(first.text).toContain("2|b");
    expect(first.text).toContain("3|c");
    expect(first.truncated).toBe(true);
    expect(parseReadWindow({ offset: 0 })).toBe("offset 须为从 1 开始的整数");
    expect(filePathFromArgs({ path: "a.ts" })).toBe("a.ts");
    expect(filePathFromArgs({ file_path: "b.ts", path: "a.ts" })).toBe("b.ts");
  });
});

describe("edit and glob", () => {
  it("applies unique literal edits", () => {
    const hit = applyLiteralEdit("foo bar foo", "bar", "baz", false);
    expect(hit).toEqual({ ok: true, content: "foo baz foo", replacements: 1 });
    expect(applyLiteralEdit("foo foo", "foo", "x", false).ok).toBe(false);
    expect(applyLiteralEdit("foo foo", "foo", "x", true)).toEqual({
      ok: true,
      content: "x x",
      replacements: 2,
    });
  });

  it("matches common globs", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/a.js")).toBe(false);
    expect(globToRegExp("*.md").test("readme.md")).toBe(true);
  });
});

describe("todo_write and web helpers", () => {
  it("parses todos and formats them", () => {
    const parsed = parseTodoWriteArgs({
      todos: [
        { content: "读文件", status: "completed" },
        { id: "2", content: "改配置", status: "in_progress" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(formatTodosForPrompt(parsed.todos)).toContain("[x] 读文件");
    expect(formatTodosForPrompt(parsed.todos)).toContain("[~] 改配置");
  });

  it("accepts http urls and strips html", () => {
    expect(isAllowedFetchUrl("https://example.com/a")).toBe(true);
    expect(isAllowedFetchUrl("file:///etc/passwd")).toBe(false);
    expect(htmlToReadableText("<p>你好</p><script>x()</script>")).toBe("你好");
  });

  it("parses search queries and DDG html cards", () => {
    expect(parseWebSearchQueries({ query: "rust napi" })).toEqual({
      ok: true,
      queries: ["rust napi"],
    });
    const html = `
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent("https://example.com/doc")}">Example Docs</a>
      <a class="result__snippet">A short blurb</a>
    `;
    const hits = parseDuckDuckGoHtml(html);
    expect(hits[0]?.url).toBe("https://example.com/doc");
    expect(hits[0]?.title).toContain("Example Docs");
  });

  it("strips ANSI / OSC escapes from PTY text", () => {
    expect(stripAnsiEscapes("\u001b[31mred\u001b[0m plain")).toBe("red plain");
    expect(stripAnsiEscapes("a\rb\n")).toBe("a\nb\n");
    expect(stripAnsiEscapes("\u001b]0;title\u0007hi")).toBe("hi");
  });

  it("parses DeepSeek Search API results and bounds query text", () => {
    expect(boundDeepSeekSearchText("  hello   world  ")).toBe("hello world");
    expect(boundDeepSeekSearchText("a".repeat(200)).length).toBe(128);
    const hits = parseDeepSeekSearchResponse({
      results: [
        {
          title: "Docs",
          url: "https://example.com/a",
          snippet: "short",
          summary: "longer model summary",
          date: null,
        },
        {
          title: "Skip",
          url: "file:///etc/passwd",
          snippet: "nope",
          summary: "",
          date: null,
        },
      ],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toBe("longer model summary");
  });

  it("parses ask_user_question and always gates it as ask", () => {
    expect(gateTool("session_auto", "ask_user_question")).toBe("ask");
    expect(gateTool("readonly", "ask_user_question")).toBe("ask");
    const parsed = parseAskUserQuestions({
      questions: [
        {
          id: "mode",
          question: "用哪种模式？",
          options: [{ label: "快速" }, { label: "仔细 (Recommended)" }],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.questions[0]?.id).toBe("mode");
  });
});
