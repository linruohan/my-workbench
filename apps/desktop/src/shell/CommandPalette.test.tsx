import { cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentThread, AgentWorkspace, Note, Task } from "@wb/domain";
import { renderWithProviders } from "../test/render";
import { CommandPalette } from "./CommandPalette";

afterEach(() => {
  cleanup();
});

function task(partial: Partial<Task> & Pick<Task, "id" | "title">): Task {
  return {
    projectId: "inbox",
    parentId: null,
    notes: "",
    isDone: false,
    doneOn: null,
    dueDay: null,
    dueWithTime: null,
    deadlineDay: null,
    deadlineWithTime: null,
    remindAt: null,
    deadlineRemindAt: null,
    timeEstimate: 0,
    timeSpent: 0,
    timeSpentOnDay: {},
    repeatCfgId: null,
    createdAt: 1,
    updatedAt: 2,
    ...partial,
  };
}

function thread(
  partial: Partial<AgentThread> & Pick<AgentThread, "id" | "title" | "workspaceId">,
): AgentThread {
  return {
    projectId: null,
    modelRef: "local",
    permissionMode: "confirm",
    queueJson: null,
    webUrl: null,
    archivedAt: null,
    pinnedAt: null,
    createdAt: 1,
    updatedAt: 2,
    ...partial,
  };
}

function note(partial: Partial<Note> & Pick<Note, "id" | "title">): Note {
  return {
    projectId: null,
    bodyMd: "",
    createdAt: 1,
    updatedAt: 2,
    ...partial,
  };
}

const workspaces: AgentWorkspace[] = [
  {
    id: "ws1",
    title: "gpui-kit",
    rootPath: "D:/code/gpui-kit",
    createdAt: 1,
    updatedAt: 2,
  },
];

describe("CommandPalette", () => {
  it("searches sessions and opens the selected thread", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();

    renderWithProviders(
      <CommandPalette
        open
        tasks={[task({ id: "t1", title: "写周报" })]}
        projects={[{ id: "inbox", title: "收件箱" }]}
        threads={[
          thread({ id: "th1", title: "hi", workspaceId: "ws1", updatedAt: 90 }),
          thread({ id: "th2", title: "baidu", workspaceId: "ws1", updatedAt: 80 }),
        ]}
        workspaces={workspaces}
        notes={[note({ id: "n1", title: "架构笔记" })]}
        kbFiles={[]}
        onClose={onClose}
        onSelect={onSelect}
      />,
    );

    await user.type(screen.getByPlaceholderText(/搜索任务、会话、文档/), "a:hi");
    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(screen.queryByText("写周报")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith({ kind: "thread", id: "th1" });
    expect(onClose).toHaveBeenCalled();
  });

  it("groups results as 任务 / 会话 / 知识库", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderWithProviders(
      <CommandPalette
        open
        tasks={[task({ id: "t1", title: "设计搜索" })]}
        projects={[{ id: "inbox", title: "收件箱" }]}
        threads={[
          thread({ id: "th1", title: "搜索会话", workspaceId: "ws1", updatedAt: 90 }),
        ]}
        workspaces={workspaces}
        notes={[note({ id: "n1", title: "搜索方案" })]}
        kbFiles={[
          {
            name: "搜索手册.md",
            path: "D:/codehub/typora_book/搜索手册.md",
            isDir: false,
            mtimeMs: 10,
          },
        ]}
        kbRoots={["D:/codehub/typora_book"]}
        onClose={() => {}}
        onSelect={onSelect}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/搜索任务、会话、文档/), {
      target: { value: "搜索" },
    });
    const headers = Array.from(document.querySelectorAll(".quick-open__section")).map(
      (el) => el.textContent,
    );
    expect(headers).toEqual(["任务", "会话", "知识库"]);
    expect(screen.getByRole("option", { name: /设计搜索/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /搜索会话/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /搜索方案/ })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /搜索手册\.md.*typora_book/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /新建任务「搜索」/ })).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /新建笔记「搜索」/ }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "create-note", title: "搜索" });
  });

  it("can jump to a navigation view", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderWithProviders(
      <CommandPalette
        open
        tasks={[]}
        projects={[{ id: "inbox", title: "收件箱" }]}
        threads={[]}
        workspaces={[]}
        notes={[]}
        kbFiles={[]}
        onClose={() => {}}
        onSelect={onSelect}
      />,
    );

    await user.type(screen.getByPlaceholderText(/搜索任务、会话、文档/), "g:agent");
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith({ kind: "nav", id: "agent" });
  });
});
