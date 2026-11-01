import { describe, expect, it } from "vitest";
import { agentEmptyGreeting } from "../src/index.js";

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
