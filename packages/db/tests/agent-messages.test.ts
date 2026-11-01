import { describe, expect, it } from "vitest";
import { MemoryWorkbenchRepository } from "../src/memory-repository.js";

describe("agent messages", () => {
  it("drops a turn from the chosen message and clears the tool queue", () => {
    const store = new MemoryWorkbenchRepository();
    const thread = store.createAgentThread({ nowMs: 1 });
    store.updateAgentThread(thread.id, { queueJson: "[{}]" }, 2);
    const first = store.appendAgentMessage({
      threadId: thread.id,
      role: "user",
      content: "先看今天",
      nowMs: 3,
    });
    const firstReply = store.appendAgentMessage({
      threadId: thread.id,
      role: "assistant",
      content: "今天没有安排。",
      nowMs: 4,
    });
    const second = store.appendAgentMessage({
      threadId: thread.id,
      role: "user",
      content: "你好",
      nowMs: 5,
    });
    store.appendAgentMessage({
      threadId: thread.id,
      role: "assistant",
      content: "已停止。",
      nowMs: 6,
    });

    store.deleteAgentMessagesFrom(thread.id, second.id, 7);

    expect(store.listAgentMessages(thread.id).map((message) => message.id)).toEqual([
      first.id,
      firstReply.id,
    ]);
    expect(store.getAgentThread(thread.id)?.queueJson).toBeNull();
    expect(store.getAgentThread(thread.id)?.updatedAt).toBe(7);
  });
});
