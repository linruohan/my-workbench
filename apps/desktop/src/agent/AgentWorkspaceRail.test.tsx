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
});
