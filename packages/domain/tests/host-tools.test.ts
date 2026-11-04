import { describe, expect, it } from "vitest";
import {
  assembleHostTools,
  formatHostToolsForPrompt,
  gateTool,
  HOST_TOOL_CATALOG,
  parseHostToolRunArgs,
  setHostToolEnabled,
  toolCallSummary,
} from "../src/index.js";

describe("host tool catalog", () => {
  it("covers the local commands and chart libraries", () => {
    const ids = HOST_TOOL_CATALOG.map((item) => item.id);
    expect(ids).toEqual([
      "uv",
      "node",
      "git",
      "ripgrep",
      "chromium",
      "playwright",
      "browser-mcp",
      "poppler",
      "cairo",
      "mermaid",
      "fontwasm",
      "ocr",
      "inkscape",
      "ffmpeg",
      "openssh",
      "sshfs",
      "go",
      "java",
      "rust",
      "ruby",
      "php",
      "dotnet",
      "webview2",
      "redis",
      "nsis",
      "innosetup",
      "readelf",
      "matplotlib",
      "plotly",
      "altair",
      "bokeh",
    ]);
    expect(HOST_TOOL_CATALOG.find((item) => item.id === "inkscape")?.summary).toContain(
      "矢量",
    );
    expect(HOST_TOOL_CATALOG.find((item) => item.id === "mermaid")?.summary).toContain(
      "时序图",
    );
  });

  it("keeps an environment hit ahead of a missing install", () => {
    const tools = assembleHostTools(
      [
        {
          id: "ripgrep",
          status: "ready",
          source: "env",
          path: "C:\\Tools\\rg.exe",
          version: "ripgrep 14.1.1",
          invoke: ["C:\\Tools\\rg.exe"],
        },
      ],
      [],
    );
    const rg = tools.find((item) => item.id === "ripgrep");
    expect(rg).toMatchObject({
      status: "ready",
      source: "env",
      path: "C:\\Tools\\rg.exe",
      enabled: true,
    });
    expect(tools.find((item) => item.id === "go")).toMatchObject({
      status: "missing",
      source: "none",
      enabled: true,
    });
  });

  it("hides disabled tools from the agent prompt", () => {
    const disabled = setHostToolEnabled([], "go", false);
    const tools = assembleHostTools(
      [
        {
          id: "go",
          status: "ready",
          source: "managed",
          path: "D:\\data\\tools\\go\\bin\\go.exe",
          version: "go1.25.0",
          invoke: ["D:\\data\\tools\\go\\bin\\go.exe"],
        },
        {
          id: "ffmpeg",
          status: "ready",
          source: "env",
          path: "C:\\ffmpeg\\ffmpeg.exe",
          version: "ffmpeg 7",
          invoke: ["C:\\ffmpeg\\ffmpeg.exe"],
        },
      ],
      disabled,
    );
    const prompt = formatHostToolsForPrompt(tools);
    expect(prompt).toContain("ffmpeg");
    expect(prompt).toContain("host_tool_run");
    expect(prompt).not.toContain("go1.25.0");
    expect(setHostToolEnabled(disabled, "go", true)).toEqual([]);
  });

  it("rejects a shell string and unknown tool ids", () => {
    expect(parseHostToolRunArgs({ toolId: "ripgrep", args: "rg -n foo" }).ok).toBe(false);
    expect(parseHostToolRunArgs({ toolId: "bash", args: [] }).ok).toBe(false);
    expect(
      parseHostToolRunArgs({ toolId: "matplotlib", args: ["-c", "print(1)"] }),
    ).toEqual({
      ok: true,
      toolId: "matplotlib",
      bin: "python",
      args: ["-c", "print(1)"],
      cwd: "",
    });
    expect(parseHostToolRunArgs({ toolId: "uv", bin: "uvx", args: ["ruff"] })).toEqual({
      ok: true,
      toolId: "uv",
      bin: "uvx",
      args: ["ruff"],
      cwd: "",
    });
    expect(parseHostToolRunArgs({ toolId: "uv", bin: "pip", args: [] }).ok).toBe(false);
  });

  it("asks before running a host tool", () => {
    expect(gateTool("confirm", "host_tool_list")).toBe("run");
    expect(gateTool("confirm", "host_tool_run")).toBe("ask");
    expect(gateTool("readonly", "host_tool_run")).toBe("block");
    expect(gateTool("session_auto", "host_tool_run")).toBe("run");
    expect(toolCallSummary("host_tool_run", { toolId: "mermaid" })).toBe(
      "运行工具 mermaid",
    );
  });
});
