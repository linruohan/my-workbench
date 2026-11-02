import { describe, expect, it } from "vitest";
import { MemoryWorkbenchRepository } from "../src/memory-repository.js";

describe("agent workspaces", () => {
  it("creates sessions under a workspace and migrates old snapshots", () => {
    const store = new MemoryWorkbenchRepository();
    const workspace = store.createAgentWorkspace({ title: "本机", nowMs: 1 });
    const thread = store.createAgentThread({
      workspaceId: workspace.id,
      title: "你好",
      nowMs: 2,
    });
    expect(thread.workspaceId).toBe(workspace.id);
    expect(store.listAgentThreads(workspace.id)).toHaveLength(1);
    expect(store.getAgentWorkspace(workspace.id)?.updatedAt).toBe(2);

    const legacy = JSON.stringify({
      tasks: [],
      projects: [],
      buckets: [],
      todayOrder: [],
      notifications: [],
      agentThreads: [
        {
          id: "t1",
          projectId: null,
          title: "旧会话",
          modelRef: "builtin:workbench/local",
          permissionMode: "confirm",
          queueJson: null,
          createdAt: 10,
          updatedAt: 10,
        },
      ],
      agentMessages: [],
      agentApprovals: [],
    });
    store.importSnapshot(legacy);
    expect(store.listAgentWorkspaces()).toHaveLength(1);
    expect(store.listAgentThreads()[0]?.workspaceId).toBe(
      store.listAgentWorkspaces()[0]?.id,
    );
    expect(store.listAgentThreads()[0]?.title).toBe("旧会话");
  });

  it("deletes a workspace together with its sessions", () => {
    const store = new MemoryWorkbenchRepository();
    const workspace = store.createAgentWorkspace({ title: "临时", nowMs: 1 });
    const thread = store.createAgentThread({ workspaceId: workspace.id, nowMs: 2 });
    store.appendAgentMessage({
      threadId: thread.id,
      role: "user",
      content: "你好",
      nowMs: 3,
    });
    store.deleteAgentWorkspace(workspace.id);
    expect(store.listAgentWorkspaces()).toHaveLength(0);
    expect(store.listAgentThreads()).toHaveLength(0);
    expect(store.listAgentMessages(thread.id)).toHaveLength(0);
  });
});
