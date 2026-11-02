import { describe, expect, it } from "vitest";
import { agentEditPlan, agentRetryPlan, type AgentMessage } from "../src/index.js";

function message(
  patch: Partial<AgentMessage> & Pick<AgentMessage, "id" | "role">,
): AgentMessage {
  return {
    threadId: "t",
    content: "",
    toolName: null,
    toolCallId: null,
    toolCallsJson: null,
    createdAt: 1,
    ...patch,
  };
}

describe("agent retry plan", () => {
  it("retries the latest user line when the reply did not call tools", () => {
    expect(
      agentRetryPlan([
        message({ id: "u1", role: "user", content: "先看今天" }),
        message({ id: "a1", role: "assistant", content: "今天没有安排。" }),
        message({ id: "u2", role: "user", content: "  你好  " }),
        message({ id: "a2", role: "assistant", content: "已停止。" }),
      ]),
    ).toEqual({ userMessageId: "u2", text: "你好" });
  });

  it("leaves turns that already called a tool", () => {
    expect(
      agentRetryPlan([
        message({ id: "u", role: "user", content: "创建任务 写周报" }),
        message({
          id: "a",
          role: "assistant",
          content: "正在创建任务。",
          toolCallsJson: "[]",
        }),
        message({ id: "t", role: "tool", content: "已创建" }),
      ]),
    ).toBeNull();
  });

  it("waits until a reply exists", () => {
    expect(
      agentRetryPlan([message({ id: "u", role: "user", content: "你好" })]),
    ).toBeNull();
  });
});

describe("agent edit plan", () => {
  it("returns the latest user line before or after a text reply", () => {
    expect(
      agentEditPlan([message({ id: "u", role: "user", content: "  你好  " })]),
    ).toEqual({
      userMessageId: "u",
      text: "你好",
    });
    expect(
      agentEditPlan([
        message({ id: "u1", role: "user", content: "先看今天" }),
        message({ id: "a1", role: "assistant", content: "今天没有安排。" }),
        message({ id: "u2", role: "user", content: "你好" }),
        message({ id: "a2", role: "assistant", content: "已停止。" }),
      ]),
    ).toEqual({ userMessageId: "u2", text: "你好" });
  });

  it("leaves turns that already called a tool", () => {
    expect(
      agentEditPlan([
        message({ id: "u", role: "user", content: "创建任务 写周报" }),
        message({ id: "a", role: "assistant", content: "正在创建任务。", toolCallsJson: "[]" }),
      ]),
    ).toBeNull();
  });
});
