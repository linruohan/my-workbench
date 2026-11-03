import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makePresetSchedule } from "@wb/domain";
import { renderWithProviders } from "../test/render";
import { TimedTaskEditor } from "./TimedTaskEditor";

afterEach(() => {
  cleanup();
});

describe("TimedTaskEditor", () => {
  it("adds a daily schedule from the plan menu", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <TimedTaskEditor
        draft={{ title: "未命名定时任务", command: "", schedule: null }}
        onChange={onChange}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "+ 添加计划" }));
    await user.click(screen.getByRole("menuitem", { name: "每天" }));
    expect(onChange).toHaveBeenCalledWith({
      schedule: makePresetSchedule("daily"),
    });
  });

  it("edits the single schedule inline and can delete it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <TimedTaskEditor
        draft={{
          title: "巡检",
          command: "检查日志",
          schedule: makePresetSchedule("daily", "09:00"),
        }}
        onChange={onChange}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(screen.getByLabelText("计划类型")).toHaveTextContent("每天");
    expect(screen.getByText("GMT+8 每天，09:00")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ 添加计划" })).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("计划类型"));
    await user.click(screen.getByRole("button", { name: "自定义" }));
    expect(onChange).toHaveBeenCalledWith({
      schedule: expect.objectContaining({
        kind: "custom",
        every: 1,
        unit: "day",
        atTime: "09:00",
      }),
    });

    await user.click(screen.getByRole("button", { name: "删除计划 每天" }));
    expect(onChange).toHaveBeenCalledWith({ schedule: null });
  });
});
