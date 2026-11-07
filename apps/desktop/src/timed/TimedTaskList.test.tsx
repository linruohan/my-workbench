import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTimedTaskDraft, makePresetSchedule, TIMED_TASK_MISS_GRACE_MS } from "@wb/domain";
import { renderWithProviders } from "../test/render";
import { TimedTaskList } from "./TimedTaskList";

afterEach(() => {
  cleanup();
});

describe("TimedTaskList", () => {
  it("keeps expired tasks in the banner only and supports run / skip / batch", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    const expired = {
      ...createTimedTaskDraft({
        title: "夜间巡检",
        command: "检查日志",
        schedule: makePresetSchedule("daily"),
        nowMs: now,
      }),
      nextRunAt: now - TIMED_TASK_MISS_GRACE_MS - 60_000,
    };
    const upcoming = createTimedTaskDraft({
      title: "午间同步",
      command: "同步状态",
      schedule: makePresetSchedule("daily", "12:00"),
      nowMs: now,
    });
    const onRunNow = vi.fn();
    const onSkip = vi.fn();
    const onRunAllMissed = vi.fn();
    const onSkipAllMissed = vi.fn();

    renderWithProviders(
      <TimedTaskList
        tasks={[expired, upcoming]}
        nowMs={now}
        bindings={{
          [expired.id]: {
            threadTitle: null,
            skillCount: 1,
            autoSession: true,
          },
        }}
        onCreate={() => undefined}
        onOpen={() => undefined}
        onDelete={() => undefined}
        onRunNow={onRunNow}
        onSkip={onSkip}
        onRunAllMissed={onRunAllMissed}
        onSkipAllMissed={onSkipAllMissed}
      />,
    );

    expect(screen.getByText(/有 1 个已过期的定时任务/)).toBeInTheDocument();
    expect(screen.getByText(/1 个技能/)).toBeInTheDocument();
    expect(screen.getByText("午间同步")).toBeInTheDocument();
    // Expired title appears in banner; upcoming stays in the main list.
    expect(screen.getAllByText("夜间巡检")).toHaveLength(1);

    const missed = within(screen.getByRole("status"));
    await user.click(missed.getByRole("button", { name: "立即执行" }));
    expect(onRunNow).toHaveBeenCalledWith(expired.id);
    await user.click(missed.getByRole("button", { name: "跳过本次" }));
    expect(onSkip).toHaveBeenCalledWith(expired.id);
    await user.click(missed.getByRole("button", { name: "全部立即执行" }));
    expect(onRunAllMissed).toHaveBeenCalled();
    await user.click(missed.getByRole("button", { name: "全部跳过" }));
    expect(onSkipAllMissed).toHaveBeenCalled();
  });
});
