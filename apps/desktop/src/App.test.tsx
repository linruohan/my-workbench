import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";
import { renderWithProviders } from "./test/render";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

async function readyApp() {
  renderWithProviders(<App />);
  return screen.findByLabelText("快速捕获");
}

describe("App shell", () => {
  it("captures undated task into projects, not today", async () => {
    const user = userEvent.setup();
    await readyApp();

    await user.type(screen.getByLabelText("快速捕获"), "回复邮件{Enter}");

    await user.click(screen.getByRole("button", { name: "任务" }));
    expect(screen.getByText("回复邮件")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "今日" }));
    expect(screen.queryByText("回复邮件")).not.toBeInTheDocument();
  });

  it("schedules task onto today from projects", async () => {
    const user = userEvent.setup();
    await readyApp();

    await user.type(screen.getByLabelText("快速捕获"), "写周报{Enter}");
    await user.click(screen.getByRole("button", { name: "任务" }));
    await user.click(screen.getByRole("button", { name: "今天" }));
    await user.click(screen.getByRole("button", { name: "今日" }));
    expect(screen.getByText("写周报")).toBeInTheDocument();
  });

  it("creates and previews a note in knowledge", async () => {
    const user = userEvent.setup();
    await readyApp();

    await user.click(screen.getByRole("button", { name: "知识库" }));
    await user.click(screen.getByRole("button", { name: "新建" }));
    expect(screen.getByLabelText("Markdown 源码")).toBeInTheDocument();
    expect(screen.getByLabelText("预览")).toBeInTheDocument();

    const source = screen.getByLabelText("Markdown 源码");
    await user.clear(source);
    await user.type(source, "# 架构笔记{Enter}{Enter}本地优先");
    expect(screen.getByLabelText("预览")).toHaveTextContent("架构笔记");
    expect(screen.getByLabelText("预览")).toHaveTextContent("本地优先");
  });

  it("opens settings from sidebar gear and can go back", async () => {
    const user = userEvent.setup();
    await readyApp();

    await user.click(screen.getByRole("button", { name: "打开设置" }));
    expect(screen.getByRole("heading", { name: "常规" })).toBeInTheDocument();
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

  it("creates a timed task with daily schedule", async () => {
    const user = userEvent.setup();
    await readyApp();

    await user.click(screen.getByRole("button", { name: "定时任务" }));
    await user.click(screen.getByRole("button", { name: "新建定时任务" }));
    expect(screen.getByRole("heading", { name: "新建定时任务" })).toBeInTheDocument();

    const title = screen.getByLabelText("任务标题");
    await user.clear(title);
    await user.type(title, "晨间巡检");
    await user.click(screen.getByRole("button", { name: "+ 添加计划" }));
    await user.click(screen.getByRole("menuitem", { name: "每天" }));
    expect(
      screen.queryByRole("button", { name: "+ 添加计划" }),
    ).not.toBeInTheDocument();
    await user.type(
      screen.getByLabelText("指令"),
      "总结昨日任务与阻塞",
    );
    await user.click(screen.getByRole("button", { name: "创建定时任务" }));
    expect(screen.getByText("晨间巡检")).toBeInTheDocument();
    expect(screen.getByText(/每天 · 09:00/)).toBeInTheDocument();
  });
});
