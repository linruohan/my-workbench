import { MemoryWorkbenchRepository } from "@wb/db/memory";
import { WEB_AGENT_THREAD_TITLE } from "@wb/domain";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/render";
import { AgentWorkspaceRail } from "./AgentWorkspaceRail";

afterEach(() => {
  cleanup();
});

describe("agent workspace rail", () => {
  it("deletes a web session after confirmation", async () => {
    const user = userEvent.setup();
    const store = new MemoryWorkbenchRepository();
    const workspace = store.createAgentWorkspace({ title: "默认工作区" });
    const thread = store.createAgentThread({
      workspaceId: workspace.id,
      title: WEB_AGENT_THREAD_TITLE,
      webUrl: "https://example.com/",
    });
    const onSelectThread = vi.fn();
    const onRefresh = vi.fn();
    renderWithProviders(
      <AgentWorkspaceRail
        store={store}
        threadId={thread.id}
        onSelectThread={onSelectThread}
        onCreateThread={() => {}}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole("button", { name: "会话操作 网页会话" }));
    await user.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(screen.getByRole("dialog", { name: "删除会话" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "删除" }));

    expect(store.getAgentThread(thread.id)).toBeNull();
    expect(onSelectThread).toHaveBeenCalledWith(null);
    expect(onRefresh).toHaveBeenCalled();
  });

  it("filters sessions and can reveal archived ones", async () => {
    const user = userEvent.setup();
    const store = new MemoryWorkbenchRepository();
    const workspace = store.createAgentWorkspace({ title: "默认工作区" });
    const keep = store.createAgentThread({
      workspaceId: workspace.id,
      title: "晨报会话",
    });
    const archived = store.createAgentThread({
      workspaceId: workspace.id,
      title: "旧周报",
    });
    store.archiveAgentThread(archived.id);
    store.createAgentThread({
      workspaceId: workspace.id,
      title: "别的话题",
    });

    const { rerender } = renderWithProviders(
      <AgentWorkspaceRail
        store={store}
        threadId={keep.id}
        showArchived={false}
        onSelectThread={() => {}}
        onCreateThread={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(screen.queryByText(/旧周报/)).not.toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "筛选会话" }), "晨报");
    expect(screen.getByText("晨报会话")).toBeInTheDocument();
    expect(screen.queryByText("别的话题")).not.toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox", { name: "筛选会话" }));
    rerender(
      <AgentWorkspaceRail
        store={store}
        threadId={keep.id}
        showArchived
        onSelectThread={() => {}}
        onCreateThread={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText(/〔归档〕\s*旧周报/)).toBeInTheDocument();
  });

  it("shows one empty state when the filter matches nothing", async () => {
    const user = userEvent.setup();
    const store = new MemoryWorkbenchRepository();
    const first = store.createAgentWorkspace({ title: "工作区甲" });
    const second = store.createAgentWorkspace({ title: "工作区乙" });
    store.createAgentThread({ workspaceId: first.id, title: "晨报" });
    store.createAgentThread({ workspaceId: second.id, title: "周报" });

    renderWithProviders(
      <AgentWorkspaceRail
        store={store}
        threadId={null}
        onSelectThread={() => {}}
        onCreateThread={() => {}}
        onRefresh={() => {}}
      />,
    );

    await user.type(screen.getByRole("searchbox", { name: "筛选会话" }), "不存在");
    expect(screen.getByText("没有匹配的会话")).toBeInTheDocument();
    expect(screen.queryAllByText("没有匹配的会话")).toHaveLength(1);
  });

  it("marks the busy session in the rail", () => {
    const store = new MemoryWorkbenchRepository();
    const workspace = store.createAgentWorkspace({ title: "默认工作区" });
    const busy = store.createAgentThread({
      workspaceId: workspace.id,
      title: "正在跑",
    });
    store.createAgentThread({ workspaceId: workspace.id, title: "空闲" });

    renderWithProviders(
      <AgentWorkspaceRail
        store={store}
        threadId={busy.id}
        busyThreadId={busy.id}
        onSelectThread={() => {}}
        onCreateThread={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByLabelText("正在回答")).toBeInTheDocument();
  });
});
