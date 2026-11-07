import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTimedTaskDraft,
  makePresetSchedule,
  TIMED_TASK_MISS_GRACE_MS,
} from "@wb/domain";
import { renderWithProviders } from "../test/render";
import { TimedTaskList } from "./TimedTaskList";

afterEach(() => {
  cleanup();
});

describe("TimedTaskList", () => {
  it("shows expired tasks and supports run / skip / batch actions", async () => {
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
    const onRunNow = vi.fn();
    const onSkip = vi.fn();
    const onRunAllMissed = vi.fn();
    const onSkipAllMissed = vi.fn();

    renderWithProviders(
      <TimedTaskList
        tasks={[expired]}
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
    expect(screen.getAllByText(/1 个技能/).length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole("button", { name: "立即执行" })[0]!);
    expect(onRunNow).toHaveBeenCalledWith(expired.id);
    await user.click(screen.getAllByRole("button", { name: "跳过本次" })[0]!);
    expect(onSkip).toHaveBeenCalledWith(expired.id);
    await user.click(screen.getByRole("button", { name: "全部立即执行" }));
    expect(onRunAllMissed).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "全部跳过" }));
    expect(onSkipAllMissed).toHaveBeenCalled();
  });
});
