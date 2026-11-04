import { describe, expect, it } from "vitest";
import { DomainError } from "@wb/domain";
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
    expect(thread.archivedAt).toBeNull();
    expect(store.listAgentThreads({ workspaceId: workspace.id })).toHaveLength(1);
    expect(store.getAgentWorkspace(workspace.id)?.updatedAt).toBe(2);
    expect(store.getAgentWorkspace(workspace.id)?.rootPath).toBeNull();

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
    expect(store.listAgentThreads()[0]?.archivedAt).toBeNull();
  });

  it("binds a folder path and reuses the same workspace", () => {
    const store = new MemoryWorkbenchRepository();
    const first = store.createAgentWorkspace({
      title: "my-workbench",
      rootPath: "D:\\codehub\\my-workbench",
      nowMs: 1,
    });
    expect(first.rootPath).toBe("D:\\codehub\\my-workbench");
    expect(store.findAgentWorkspaceByRootPath("D:/codehub/my-workbench/")?.id).toBe(
      first.id,
    );
  });

  it("archives sessions out of the default list", () => {
    const store = new MemoryWorkbenchRepository();
    const workspace = store.createAgentWorkspace({ title: "本机", nowMs: 1 });
    const thread = store.createAgentThread({ workspaceId: workspace.id, nowMs: 2 });
    store.archiveAgentThread(thread.id, 3);
    expect(store.listAgentThreads()).toHaveLength(0);
    expect(store.listAgentThreads({ includeArchived: true })).toHaveLength(1);
    expect(store.getAgentThread(thread.id)?.archivedAt).toBe(3);
    store.unarchiveAgentThread(thread.id, 4);
    expect(store.listAgentThreads()).toHaveLength(1);
    expect(store.getAgentThread(thread.id)?.archivedAt).toBeNull();
  });

  it("stores a web session address and keeps it across snapshots", () => {
    const store = new MemoryWorkbenchRepository();
    const workspace = store.createAgentWorkspace({ title: "默认工作区", nowMs: 1 });
    const thread = store.createAgentThread({
      workspaceId: workspace.id,
      title: "网页会话",
      webUrl: "example.com/docs",
      nowMs: 2,
    });
    expect(thread.webUrl).toBe("https://example.com/docs");
    expect(store.getAgentThread(thread.id)?.webUrl).toBe("https://example.com/docs");
    expect(() =>
      store.createAgentThread({
        workspaceId: workspace.id,
        webUrl: "javascript:alert(1)",
      }),
    ).toThrow(DomainError);

    const copy = new MemoryWorkbenchRepository();
    copy.importSnapshot(store.exportSnapshot());
    expect(copy.getAgentThread(thread.id)?.webUrl).toBe("https://example.com/docs");

    const legacy = new MemoryWorkbenchRepository();
    legacy.importSnapshot(
      JSON.stringify({
        tasks: [],
        projects: [],
        buckets: [],
        todayOrder: [],
        notifications: [],
        agentWorkspaces: [
          {
            id: "w1",
            title: "默认工作区",
            rootPath: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        agentThreads: [
          {
            id: "t1",
            workspaceId: "w1",
            projectId: null,
            title: "旧会话",
            modelRef: "builtin:workbench/local",
            permissionMode: "confirm",
            queueJson: null,
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        agentMessages: [],
        agentApprovals: [],
      }),
    );
    expect(legacy.getAgentThread("t1")?.webUrl).toBeNull();
    expect(legacy.getAgentThread("t1")?.pinnedAt).toBeNull();
  });

  it("pins a session and keeps the pin across a snapshot", () => {
    const store = new MemoryWorkbenchRepository();
    const thread = store.createAgentThread({ title: "要置顶", nowMs: 1 });
    expect(thread.pinnedAt).toBeNull();
    store.pinAgentThread(thread.id, 8);
    expect(store.getAgentThread(thread.id)?.pinnedAt).toBe(8);
    const copy = new MemoryWorkbenchRepository();
    copy.importSnapshot(store.exportSnapshot());
    expect(copy.getAgentThread(thread.id)?.pinnedAt).toBe(8);
    copy.unpinAgentThread(thread.id, 9);
    expect(copy.getAgentThread(thread.id)?.pinnedAt).toBeNull();
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
    store.archiveAgentThread(thread.id, 4);
    store.deleteAgentWorkspace(workspace.id);
    expect(store.listAgentWorkspaces()).toHaveLength(0);
    expect(store.listAgentThreads({ includeArchived: true })).toHaveLength(0);
    expect(store.listAgentMessages(thread.id)).toHaveLength(0);
  });
});
