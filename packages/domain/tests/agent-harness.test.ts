import { describe, expect, it } from "vitest";
import {
  addAgentCommand,
  addAgentMemory,
  applyMention,
  compactMarkerText,
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

  it("suggests an @ skill and inserts it", () => {
    const suggestions = mentionSuggestions("请看 @we", [
      { kind: "skill", name: "weekly", summary: "周报" },
      { kind: "subagent", name: "reader", summary: "阅读" },
    ]);
    expect(suggestions.map((item) => item.name)).toEqual(["weekly"]);
    expect(applyMention("请看 @we", "weekly")).toBe("请看 @weekly ");
  });
});
