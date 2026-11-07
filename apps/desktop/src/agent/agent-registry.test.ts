import { describe, expect, it } from "vitest";
import {
  completeManagedAgent,
  interruptManagedAgent,
  listManagedAgents,
  registerManagedAgent,
  removeManagedAgent,
  sendManagedAgentMessage,
  takePendingAgentNotices,
} from "./agent-registry";

describe("managed agent registry", () => {
  it("registers, lists, messages, interrupts, and notifies", () => {
    const child = registerManagedAgent({
      id: "c1",
      parentThreadId: "p1",
      name: "researcher",
      depth: 1,
    });
    expect(listManagedAgents("p1")).toHaveLength(1);
    expect(listManagedAgents("p1")[0]?.status).toBe("running");
    const sent = sendManagedAgentMessage("c1", "p1", "补充一点上下文");
    expect(sent.ok).toBe(true);
    if (sent.ok) expect(sent.agent.inbox).toBe(1);
    const stopped = interruptManagedAgent("c1", "p1");
    expect(stopped.ok).toBe(true);
    completeManagedAgent("c1", "done", "subagent researcher (c1) finished.");
    expect(takePendingAgentNotices("p1")[0]).toContain("researcher");
    expect(takePendingAgentNotices("p1")).toEqual([]);
    removeManagedAgent(child.id);
    expect(listManagedAgents("p1")).toEqual([]);
  });
});
