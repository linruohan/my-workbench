import { describe, expect, it } from "vitest";
import {
  addAgentCommand,
  addAgentMemory,
  applyMention,
  CLEARED_TOOL_RESULT,
  PRUNED_TOOL_RESULT_MARK,
  compactMarkerText,
  formatActiveSkills,
  formatSessionContext,
  formatTodayForPrompt,
  microcompactToolResults,
  expandCommandTemplate,
  forgetAgentMemory,
  formatMcpForPrompt,
  hooksForEvent,
  isCompactMarker,
  manualCompactPlan,
  mentionSuggestions,
  modelTranscript,
  parseHooksDocument,
  parseMcpDocument,
  parsePluginManifest,
  planCompact,
  pruneOversizedToolResults,
  pruneToolResultText,
  resolveSlash,
  type AgentMessage,
} from "../src/index.js";

function message(role: AgentMessage["role"], content: string, id: string): AgentMessage {
  return {
    id,
    threadId: "t",
    role,
    content,
    toolName: null,
    toolCallId: null,
    toolCallsJson: null,
    createdAt: 1,
  };
}

describe("agent compact", () => {
  it("keeps the latest user turn and summarizes what came before", () => {
    const messages = [
      message("user", "第一件很长的事情".repeat(40), "1"),
      message("assistant", "好的，先处理第一件", "2"),
      message("user", "第二件", "3"),
    ];
    const plan = planCompact(messages, 30);
    expect(plan.needed).toBe(true);
    expect(plan.messages[0]?.content.startsWith("【上下文已压缩】")).toBe(true);
    expect(plan.messages.at(-1)?.content).toBe("第二件");
    expect(plan.summary).toContain("第一件");
  });

  it("does not compact a single turn", () => {
    const messages = [message("user", "你好", "1")];
    expect(manualCompactPlan(messages)).toBeNull();
    expect(planCompact(messages, 10).needed).toBe(false);
  });

  it("hides history before a manual compact boundary", () => {
    const messages = [
      message("user", "旧问题", "1"),
      message("assistant", "旧回答", "2"),
      message("system", compactMarkerText("用户：旧问题", 2), "3"),
      message("user", "新问题", "4"),
    ];
    expect(isCompactMarker(messages[2]!)).toBe(true);
    const visible = modelTranscript(messages, 10_000);
    expect(visible.map((item) => item.content)).toEqual([messages[2]!.content, "新问题"]);
    expect(visible[0]?.role).toBe("user");
  });

  it("clears old tool results and keeps the latest ones", () => {
    const bulky = "x".repeat(300);
    const messages = [
      message("user", "查一下", "u"),
      { ...message("tool", bulky, "t1"), toolName: "note_get" },
      { ...message("tool", bulky, "t2"), toolName: "search" },
      message("assistant", "好", "a"),
    ];
    const slim = microcompactToolResults(messages, 1);
    expect(slim[1]?.content.startsWith(CLEARED_TOOL_RESULT)).toBe(true);
    expect(slim[1]?.content).toContain("note_get");
    expect(slim[2]?.content).toBe(bulky);
    expect(slim[0]?.content).toBe("查一下");
  });

  it("prunes oversized tool results with head and tail", () => {
    const head = "H".repeat(100);
    const mid = "M".repeat(200);
    const tail = "T".repeat(50);
    const content = head + mid + tail;
    const pruned = pruneToolResultText(content, {
      thresholdChars: 200,
      headChars: 100,
      tailChars: 50,
    });
    expect(pruned.startsWith(head)).toBe(true);
    expect(pruned.endsWith(tail)).toBe(true);
    expect(pruned).toContain(PRUNED_TOOL_RESULT_MARK.trim());
    expect(pruned.length).toBeLessThan(content.length);
    expect(
      pruneToolResultText(pruned, { thresholdChars: 200, headChars: 100, tailChars: 50 }),
    ).toBe(pruned);
  });

  it("applies prune before microcompact in the model projection", () => {
    const huge = `HEAD${"x".repeat(9000)}TAIL`;
    const messages = [
      message("user", "跑一下", "u"),
      { ...message("tool", huge, "t1"), toolName: "shell" },
      message("assistant", "好", "a"),
    ];
    const pruned = pruneOversizedToolResults(messages, {
      thresholdChars: 8192,
      headChars: 4096,
      tailChars: 1024,
    });
    expect(pruned[1]?.content).toContain(PRUNED_TOOL_RESULT_MARK.trim());
    expect(pruned[1]?.content.length).toBeLessThan(huge.length);
  });
});

describe("agent context", () => {
  it("includes the clock, workspace, and branch", () => {
    const text = formatSessionContext({
      nowMs: new Date(2026, 10, 3, 23, 5).getTime(),
      workspaceTitle: "my-workbench",
      workspacePath: "D:/codehub/my-workbench",
      gitBranch: "main",
    });
    expect(text).toContain("2026-11-03");
    expect(text).toContain("23:05");
    expect(text).toContain("工作区：D:/codehub/my-workbench");
    expect(text).toContain("当前分支：main");
    const named = formatSessionContext({
      nowMs: new Date(2026, 10, 3, 23, 5).getTime(),
      workspaceTitle: "工作台",
      workspacePath: "D:/codehub/my-workbench",
    });
    expect(named).toContain("工作区：工作台 · D:/codehub/my-workbench");
  });

  it("puts plan, reminder, and estimate on today lines", () => {
    const nowMs = new Date(2026, 10, 3, 8, 0).getTime();
    const text = formatTodayForPrompt(
      [
        {
          title: "写周报",
          dueWithTime: new Date(2026, 10, 3, 9, 0).getTime(),
          remindAt: new Date(2026, 10, 3, 8, 45).getTime(),
          timeEstimate: 25 * 60_000,
          projectTitle: "工作",
        },
        {
          title: "收件",
          dueDay: "2026-11-02",
        },
      ],
      nowMs,
    );
    expect(text).toContain("· 写周报 · 今天 09:00 · 提醒 08:45 · 预计 25 分钟 · 工作");
    expect(text).toContain("· 收件 · 逾 2026-11-02");
  });

  it("keeps a skill named earlier in the visible transcript", () => {
    const skills = [
      {
        id: "skill:weekly",
        name: "weekly",
        description: "周报",
        dirPath: "D:/skills/weekly",
        sourceDirId: "1",
        body: "先列本周完成项。",
      },
    ];
    const text = formatActiveSkills(skills, [
      { role: "user", content: "用 /weekly" },
      { role: "assistant", content: "好" },
      { role: "user", content: "继续" },
    ]);
    expect(text).toContain("先列本周完成项。");
    expect(text).toContain("weekly");
  });
});

describe("agent memory", () => {
  it("adds, rejects duplicates, and forgets by text", () => {
    const first = addAgentMemory([], "周五写周报", 1);
    expect(first.added?.text).toBe("周五写周报");
    const again = addAgentMemory(first.memories, "周五写周报", 2);
    expect(again.added).toBeNull();
    const forgotten = forgetAgentMemory(first.memories, "周报");
    expect(forgotten.removed).toBe(1);
    expect(forgotten.memories).toEqual([]);
  });
});

describe("agent commands, hooks, plugins, mentions", () => {
  it("expands a custom command without shadowing builtins", () => {
    const added = addAgentCommand(
      [],
      { name: "review", summary: "复查", body: "请复查 $ARGUMENTS" },
      ["help", "compact"],
    );
    expect(added.added?.name).toBe("review");
    expect(expandCommandTemplate(added.added!.body, "今天的安排")).toBe(
      "请复查 今天的安排",
    );
    expect(resolveSlash("/review 今天的安排", "confirm", added.commands)).toEqual({
      type: "prompt",
      text: "请复查 今天的安排",
    });
    expect(resolveSlash("/compact", "confirm")).toEqual({ type: "compact" });
    expect(
      addAgentCommand([], { name: "help", summary: "", body: "x" }, ["help"]).added,
    ).toBe(null);
  });

  it("parses plugin manifest, hooks, and mcp registration", () => {
    const manifest = parsePluginManifest(
      JSON.stringify({
        name: "guide",
        version: "1.0.0",
        description: "说明",
        skills: "skills",
      }),
    );
    expect(manifest).toMatchObject({ name: "guide", skillsDir: "skills" });
    const hooks = parseHooksDocument(
      JSON.stringify([{ event: "SessionStart", title: "开场", body: "先看今日" }]),
      "plug",
    );
    expect(hooksForEvent(hooks, "session_start")).toHaveLength(1);
    const servers = parseMcpDocument(
      JSON.stringify({ mcpServers: { mail: { command: "node", args: ["srv.js"] } } }),
      "plug",
    );
    expect(formatMcpForPrompt(servers)).toContain("尚未连接");
    expect(formatMcpForPrompt(servers)).toContain("node srv.js");
  });

  it("suggests an @ subagent and inserts it", () => {
    const suggestions = mentionSuggestions("请看 @re", [
      { kind: "subagent", name: "reader", summary: "阅读" },
    ]);
    expect(suggestions.map((item) => item.name)).toEqual(["reader"]);
    expect(applyMention("请看 @re", "reader")).toBe("请看 @reader ");
  });
});
