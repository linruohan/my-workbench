import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makePresetSchedule } from "@wb/domain";
import { renderWithProviders } from "../test/render";
import { TimedTaskEditor } from "./TimedTaskEditor";

afterEach(() => {
  cleanup();
});

const baseDraft = {
  title: "未命名定时任务",
  command: "",
  schedule: null as ReturnType<typeof makePresetSchedule> | null,
  threadId: null as string | null,
  skillIds: [] as string[],
  enabled: true,
};

describe("TimedTaskEditor", () => {
  it("adds a daily schedule from the plan menu", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <TimedTaskEditor
        draft={{ ...baseDraft }}
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
          ...baseDraft,
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

  it("toggles skills and binds a session", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <TimedTaskEditor
        draft={{
          ...baseDraft,
          title: "巡检",
          command: "检查日志",
          schedule: makePresetSchedule("daily", "09:00"),
        }}
        skills={[
          {
            id: "sk1",
            name: "weekly-report",
            description: "周报",
            dirPath: "D:/skills/weekly",
            sourceDirId: "src",
            body: "",
          },
        ]}
        threads={[
          {
            id: "th1",
            workspaceId: "ws1",
            projectId: null,
            title: "已有会话",
            modelRef: "builtin:workbench/local",
            permissionMode: "confirm",
            queueJson: null,
            webUrl: null,
            archivedAt: null,
            pinnedAt: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
        workspaces={[
          { id: "ws1", title: "默认工作区", rootPath: null, createdAt: 1, updatedAt: 1 },
        ]}
        onChange={onChange}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "/weekly-report" }));
    expect(onChange).toHaveBeenCalledWith({ skillIds: ["sk1"] });
    await user.selectOptions(screen.getByLabelText("绑定会话"), "th1");
    expect(onChange).toHaveBeenCalledWith({ threadId: "th1" });
  });

  it("blocks submit when neither command nor skill is set", () => {
    renderWithProviders(
      <TimedTaskEditor
        draft={{
          ...baseDraft,
          title: "空载荷",
          schedule: makePresetSchedule("daily"),
        }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "创建定时任务" })).toBeDisabled();
    expect(screen.getByText(/请填写指令，或至少选择一个技能/)).toBeInTheDocument();
  });
});
