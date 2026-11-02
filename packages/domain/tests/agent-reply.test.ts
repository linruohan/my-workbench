import { describe, expect, it } from "vitest";
import {
  agentEmptyGreeting,
  filterAgentThreads,
  formatAgentBubbleTime,
  groupAgentThreadsByWorkspace,
  modelSwitchText,
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
