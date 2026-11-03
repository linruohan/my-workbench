import { describe, expect, it } from "vitest";
import {
  agentEmptyGreeting,
  agentRootsMatch,
  agentWorkspaceTitleFromPath,
  filterAgentThreads,
  formatAgentBubbleTime,
  formatAgentRelativeShort,
  groupAgentThreadsByWorkspace,
  modelSwitchText,
  normalizeAgentRootPath,
  normalizeAgentWebUrl,
  orderAgentWorkspaceThreads,
} from "../src/index.js";

describe("agent empty greeting", () => {
  it("follows the local hour", () => {
    expect(agentEmptyGreeting(5)).toBe("早上好呀，新的一天开始啦");
    expect(agentEmptyGreeting(8)).toBe("早上好呀，新的一天开始啦");
    expect(agentEmptyGreeting(9)).toBe("上午好呀，有什么想让我帮忙的吗");
    expect(agentEmptyGreeting(11)).toBe("上午好呀，有什么想让我帮忙的吗");
    expect(agentEmptyGreeting(12)).toBe("中午好呀，要不要先休息一下");
    expect(agentEmptyGreeting(13)).toBe("中午好呀，要不要先休息一下");
    expect(agentEmptyGreeting(14)).toBe("下午好呀，接下来交给我吧");
    expect(agentEmptyGreeting(17)).toBe("下午好呀，接下来交给我吧");
    expect(agentEmptyGreeting(18)).toBe("晚上好呀，今天辛苦啦");
    expect(agentEmptyGreeting(22)).toBe("晚上好呀，今天辛苦啦");
    expect(agentEmptyGreeting(23)).toBe("夜深啦，别忘了照顾好自己哦");
    expect(agentEmptyGreeting(0)).toBe("夜深啦，别忘了照顾好自己哦");
    expect(agentEmptyGreeting(4)).toBe("夜深啦，别忘了照顾好自己哦");
  });
});

describe("agent thread filter", () => {
  const threads = [{ title: "你好" }, { title: "今天有什么" }];

  it("matches a trimmed title and leaves the full list when the query is blank", () => {
    expect(filterAgentThreads(threads, "  你好 ")).toEqual([{ title: "你好" }]);
    expect(filterAgentThreads(threads, "   ")).toBe(threads);
  });

  it("matches without caring about letter case", () => {
    expect(filterAgentThreads([{ title: "Hello" }], "hello")).toEqual([
      { title: "Hello" },
    ]);
  });
});

describe("agent web url", () => {
  it("accepts http(s) addresses and rejects other schemes", () => {
    expect(normalizeAgentWebUrl("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeAgentWebUrl("127.0.0.1:3080")).toBe("http://127.0.0.1:3080/");
    expect(normalizeAgentWebUrl("http://127.0.0.1:3080/?token=abc")).toBe(
      "http://127.0.0.1:3080/?token=abc",
    );
    expect(normalizeAgentWebUrl("  http://localhost:3000/a  ")).toBe(
      "http://localhost:3000/a",
    );
    expect(normalizeAgentWebUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeAgentWebUrl("not a url")).toBeNull();
    expect(normalizeAgentWebUrl("")).toBeNull();
  });

  it("keeps web sessions above chats in the default workspace", () => {
    const ordered = orderAgentWorkspaceThreads(
      [
        { updatedAt: 5, title: "聊天", webUrl: null },
        { updatedAt: 2, title: "网页会话", webUrl: "https://example.com/" },
        { updatedAt: 4, title: "另一页", webUrl: "https://a.test/" },
      ],
      true,
    );
    expect(ordered.map((item) => item.title)).toEqual(["另一页", "网页会话", "聊天"]);
    expect(
      orderAgentWorkspaceThreads(
        [
          { updatedAt: 1, title: "旧" },
          { updatedAt: 3, title: "新" },
        ],
        false,
      ).map((item) => item.title),
    ).toEqual(["旧", "新"]);
  });
});

describe("agent workspace groups", () => {
  it("keeps sessions under their workspace and sorts by update time", () => {
    const groups = groupAgentThreadsByWorkspace(
      [
        { id: "w1", updatedAt: 1 },
        { id: "w2", updatedAt: 5 },
      ],
      [
        { workspaceId: "w1", updatedAt: 2, title: "旧" },
        { workspaceId: "w1", updatedAt: 4, title: "新" },
        { workspaceId: "w2", updatedAt: 3, title: "另一边" },
      ],
    );
    expect(groups.map((group) => group.workspace.id)).toEqual(["w2", "w1"]);
    expect(groups[1]?.threads.map((thread) => thread.title)).toEqual(["新", "旧"]);
  });
});

describe("model switch marker", () => {
  const label = (ref: string) =>
    ref.startsWith("builtin:") ? "本机工作台" : "切换验证 · ping";

  it("names both sides and ignores a repeated choice", () => {
    expect(modelSwitchText("builtin:workbench/local", "custom:x/ping", label)).toBe(
      "模型已切换 本机工作台 → 切换验证 · ping",
    );
    expect(
      modelSwitchText("builtin:workbench/local", "builtin:workbench/local", label),
    ).toBe(null);
  });
});

describe("agent bubble time", () => {
  const now = new Date(2026, 10, 2, 19, 27, 0).getTime();

  it("shows only the clock for today and keeps the day otherwise", () => {
    expect(formatAgentBubbleTime(now, now)).toBe("19:27");
    expect(formatAgentBubbleTime(new Date(2026, 10, 1, 8, 5, 0).getTime(), now)).toBe(
      "昨天 08:05",
    );
  });
});

describe("agent relative short", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");

  it("compacts minutes hours and days", () => {
    expect(formatAgentRelativeShort(now, now)).toBe("刚刚");
    expect(formatAgentRelativeShort(now - 3 * 60_000, now)).toBe("3m");
    expect(formatAgentRelativeShort(now - 5 * 60 * 60_000, now)).toBe("5h");
    expect(formatAgentRelativeShort(now - 7 * 24 * 60 * 60_000, now)).toBe("7d");
  });
});

describe("agent workspace path", () => {
  it("normalizes Windows roots and titles from the folder name", () => {
    expect(normalizeAgentRootPath("D:\\codehub\\my-workbench\\")).toBe(
      "d:\\codehub\\my-workbench",
    );
    expect(
      agentRootsMatch("D:/codehub/my-workbench", "D:\\codehub\\my-workbench\\"),
    ).toBe(true);
    expect(agentWorkspaceTitleFromPath("D:\\codehub\\my-workbench")).toBe("my-workbench");
  });
});
