import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@wb/domain";
import { renderWithProviders } from "../test/render";
import { TasksView } from "./TasksView";

afterEach(() => {
  cleanup();
});

function makeTask(partial: Partial<Task> & Pick<Task, "id" | "title">): Task {
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
    updatedAt: 1,
    ...partial,
  };
}

const baseProps = {
  projects: [
    { id: "inbox", title: "收件箱" },
    { id: "p1", title: "工作" },
  ],
  tags: [],
  taskTagMap: {},
  buckets: { t1: "active" as const, t2: "backlog" as const },
  filterProjectId: null as string | null,
  viewMode: "list" as const,
  showCompleted: false,
  defaultRemind: "m15" as const,
  confirmBeforeDelete: false,
  activeTimerTaskId: null as string | null,
  timerElapsedMs: 0,
  onViewModeChange: vi.fn(),
  onFilterProject: vi.fn(),
  onShowCompletedChange: vi.fn(),
  onToggleDone: vi.fn(),
  onPlanToday: vi.fn(),
  onPlanTime: vi.fn(),
  onClearPlan: vi.fn(),
  onToggleTimer: vi.fn(),
  onMoveColumn: vi.fn(),
  onSaveTask: vi.fn(),
  onDeleteTask: vi.fn(),
  onDuplicateTask: vi.fn(),
  onClearCompleted: vi.fn(),
  onCreateTag: vi.fn(),
  onAddSubtask: vi.fn(),
  onCreate: vi.fn(),
};

describe("TasksView", () => {
  it("lists tasks and opens editor for save", async () => {
    const user = userEvent.setup();
    const onSaveTask = vi.fn();
    renderWithProviders(
      <TasksView
        {...baseProps}
        onSaveTask={onSaveTask}
        tasks={[
          makeTask({ id: "t1", title: "写周报", dueDay: "2026-11-01" }),
        ]}
      />,
    );

    expect(screen.getByText("写周报")).toBeInTheDocument();
    expect(screen.getByLabelText("任务统计")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "打开 写周报" }));
    expect(screen.getByRole("heading", { name: "编辑任务" })).toBeInTheDocument();

    const title = screen.getByLabelText("标题");
    await user.clear(title);
    await user.type(title, "周报定稿");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onSaveTask).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ title: "周报定稿" }),
    );
  });

  it("filters by search and shows board columns", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <TasksView
        {...baseProps}
        viewMode="board"
        showCompleted
        tasks={[
          makeTask({ id: "t1", title: "进行中任务" }),
          makeTask({ id: "t2", title: "积压任务" }),
          makeTask({ id: "t3", title: "已完成任务", isDone: true }),
        ]}
        buckets={{
          t1: "active",
          t2: "backlog",
          t3: "active",
        }}
      />,
    );

    expect(screen.getByLabelText("任务看板")).toBeInTheDocument();
    expect(screen.getByLabelText("进行中")).toHaveTextContent("进行中任务");

    await user.type(screen.getByLabelText("搜索任务"), "积压");
    expect(screen.queryByText("进行中任务")).not.toBeInTheDocument();
    expect(screen.getByText("积压任务")).toBeInTheDocument();
  });

  it("creates a task and can delete from the list", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onDeleteTask = vi.fn();
    renderWithProviders(
      <TasksView
        {...baseProps}
        onCreate={onCreate}
        onDeleteTask={onDeleteTask}
        tasks={[makeTask({ id: "t1", title: "待删" })]}
      />,
    );
    await user.type(screen.getByLabelText("新建任务标题"), "新任务{Enter}");
    expect(onCreate).toHaveBeenCalledWith("新任务");

    await user.click(screen.getByRole("button", { name: "删除" }));
    expect(onDeleteTask).toHaveBeenCalledWith("t1");
  });
});
