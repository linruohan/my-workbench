import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { renderWithProviders } from "./test/render";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
});

async function readyApp() {
  renderWithProviders(<App />);
  return screen.findByLabelText("快速捕获");
}

describe("App shell", () => {
  it("captures into today when current view is today", async () => {
    const user = userEvent.setup();
    await readyApp();

    await user.type(screen.getByLabelText("快速捕获"), "今日事项{Enter}");
    expect(screen.getByText("今日事项")).toBeInTheDocument();
  });

  it("shows captured tasks on the planner timeline", async () => {
    const user = userEvent.setup();
    await readyApp();

    await user.click(screen.getByRole("button", { name: "计划" }));
    await user.type(screen.getByLabelText("快速捕获"), "计划事项甲{Enter}");
    expect(screen.getByText("计划事项甲")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "今天" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("快速捕获"), "明天 计划事项乙{Enter}");
    expect(screen.getByText("计划事项乙")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "明天" })).toBeInTheDocument();
  });

  it("captures into the active project without planning when in project view", async () => {
    const user = userEvent.setup();
    await readyApp();

    await user.click(screen.getByRole("button", { name: "收件箱" }));
    await user.type(screen.getByLabelText("快速捕获"), "回复邮件{Enter}");
    expect(screen.getByText("回复邮件")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "今日" }));
    expect(screen.queryByText("回复邮件")).not.toBeInTheDocument();
  });

  it("schedules task onto today from a project action", async () => {
    const user = userEvent.setup();
    await readyApp();

    await user.click(screen.getByRole("button", { name: "收件箱" }));
    await user.type(screen.getByLabelText("快速捕获"), "写周报{Enter}");
    await user.click(screen.getByRole("button", { name: /可见项排到今天/ }));
    await user.click(screen.getByRole("button", { name: "今日" }));
    expect(screen.getByText("写周报")).toBeInTheDocument();
  });

  it("creates timed task from composer while on timed view", async () => {
    const user = userEvent.setup();
    await readyApp();

    await user.click(screen.getByRole("button", { name: "定时任务" }));
    await user.type(screen.getByLabelText("快速捕获"), "晨间巡检{Enter}");
    expect(screen.getByText("晨间巡检")).toBeInTheDocument();
    expect(screen.getByText(/每天 · 09:00/)).toBeInTheDocument();
  });

  it("groups task views and lists projects under 任务", async () => {
    const user = userEvent.setup();
    await readyApp();

    expect(screen.getByRole("region", { name: "任务分组" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "今日" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收件箱" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已完成" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "计划" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "时间表" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "定时任务" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加项目" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "收件箱" }));
    await user.type(screen.getByLabelText("快速捕获"), "跨项目事项{Enter}");
    await user.click(screen.getByRole("button", { name: /可见项排到今天/ }));
    await user.click(screen.getByRole("button", { name: "今日" }));
    expect(screen.getByText("汇总全部项目 · 拖拽可调整今日顺序")).toBeInTheDocument();
    expect(screen.getByText("跨项目事项")).toBeInTheDocument();
  });

  it("creates and previews a note in knowledge", async () => {
    const user = userEvent.setup();
    await readyApp();

    await user.click(screen.getByRole("button", { name: "知识库" }));
    await user.click(screen.getByRole("button", { name: "选择目录" }));
    await user.click(screen.getByRole("menuitem", { name: "新建文件" }));
    expect(screen.getByLabelText("Markdown 编辑器")).toBeInTheDocument();
    await user.click(screen.getByLabelText("编辑第 1 行"));
    const source = screen.getByLabelText("Markdown 源码");
    await user.clear(source);
    await user.type(source, "# 架构笔记");
    expect(screen.getByLabelText("Markdown 源码")).toHaveValue("# 架构笔记");
  });

  it("opens settings from sidebar gear and can go back", async () => {
    const user = userEvent.setup();
    await readyApp();

    await user.click(screen.getByRole("button", { name: "打开设置" }));
    expect(screen.getByRole("heading", { name: "常规" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "侧栏" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开设置" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("界面语言")).toBeInTheDocument();
    expect(screen.getByLabelText("界面模式")).toBeInTheDocument();
    expect(screen.getByLabelText("HTTP 代理")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "数据" }));
    expect(screen.getByLabelText("数据目录")).toHaveTextContent(
      "AppData\\Roaming\\my-workbench",
    );
    await user.click(screen.getByRole("button", { name: "外观" }));
    expect(screen.getByRole("heading", { name: "外观" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回工作区" }));
    expect(screen.getByLabelText("快速捕获")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "侧栏" })).toBeInTheDocument();
  });

  it("collapses and expands the left sidebar", async () => {
    const user = userEvent.setup();
    await readyApp();

    await user.click(screen.getByRole("button", { name: "收起左视图" }));
    expect(screen.getByRole("button", { name: "展开左视图" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开左视图" }));
    expect(screen.getByRole("button", { name: "收起左视图" })).toBeInTheDocument();
  });

  it("opens notification center from the title bar bell", async () => {
    const user = userEvent.setup();
    await readyApp();

    expect(screen.queryByRole("button", { name: "通知" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "通知" }));
    expect(screen.getByRole("dialog", { name: "通知中心" })).toBeInTheDocument();
    expect(screen.getByText("暂无通知。提醒到期后会出现在这里。")).toBeInTheDocument();
  });

  it("cycles theme from the title bar toggle next to notifications", async () => {
    const user = userEvent.setup();
    await readyApp();

    const toggle = screen.getByRole("button", { name: /主题：/ });
    await user.click(toggle);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("creates a timed task with daily schedule via editor", async () => {
    const user = userEvent.setup();
    await readyApp();

    await user.click(screen.getByRole("button", { name: "定时任务" }));
    await user.click(screen.getByRole("button", { name: "新建定时任务" }));
    expect(screen.getByRole("heading", { name: "新建定时任务" })).toBeInTheDocument();

    const title = screen.getByLabelText("任务标题");
    await user.clear(title);
    await user.type(title, "深度巡检");
    await user.click(screen.getByRole("button", { name: "+ 添加计划" }));
    await user.click(screen.getByRole("menuitem", { name: "每天" }));
    expect(screen.queryByRole("button", { name: "+ 添加计划" })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("指令"), "总结昨日任务与阻塞");
    await user.click(screen.getByRole("button", { name: "创建定时任务" }));
    expect(screen.getByText("深度巡检")).toBeInTheDocument();
    expect(screen.getByText(/每天 · 09:00/)).toBeInTheDocument();
  });

  it("creates a task from an agent session only after approval", async () => {
    const user = userEvent.setup();
    await readyApp();

    await user.click(screen.getByRole("button", { name: "Agent" }));
    await user.click(screen.getAllByRole("button", { name: "新建会话" })[0]!);
    const path = await screen.findByLabelText("工作区目录的完整路径");
    await user.type(path, "D:/tmp/agent-ws");
    await user.click(screen.getByRole("button", { name: "确定" }));
    const box = await screen.findByLabelText("给 Agent 发消息");
    await waitFor(() => expect(box).toBeEnabled());
    await user.type(box, "创建任务 验收事项");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(await screen.findByRole("button", { name: "批准" }));
    expect(await screen.findByText(/已创建任务/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "收件箱" }));
    expect(screen.getByText("验收事项")).toBeInTheDocument();
  });
});
