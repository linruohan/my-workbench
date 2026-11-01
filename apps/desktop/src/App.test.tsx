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

describe("App shell", () => {
  it("captures undated task into projects, not today", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.type(screen.getByLabelText("快速捕获"), "回复邮件{Enter}");

    await user.click(screen.getByRole("button", { name: "任务" }));
    expect(screen.getByText("回复邮件")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "今日" }));
    expect(screen.queryByText("回复邮件")).not.toBeInTheDocument();
  });

  it("schedules task onto today from projects", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.type(screen.getByLabelText("快速捕获"), "写周报{Enter}");
    await user.click(screen.getByRole("button", { name: "任务" }));
    await user.click(screen.getByRole("button", { name: "今天" }));
    await user.click(screen.getByRole("button", { name: "今日" }));
    expect(screen.getByText("写周报")).toBeInTheDocument();
  });

  it("creates and previews a note in knowledge", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

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
    renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "打开设置" }));
    expect(screen.getByRole("heading", { name: "通用" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "外观" }));
    expect(screen.getByRole("heading", { name: "外观" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.getByLabelText("快速捕获")).toBeInTheDocument();
  });

  it("collapses and expands the left sidebar", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "收起左视图" }));
    expect(screen.getByRole("button", { name: "展开左视图" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开左视图" }));
    expect(screen.getByRole("button", { name: "收起左视图" })).toBeInTheDocument();
  });

  it("opens notification center from the title bar bell", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    expect(screen.queryByRole("button", { name: "通知" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "通知" }));
    expect(screen.getByRole("dialog", { name: "通知中心" })).toBeInTheDocument();
    expect(screen.getByText("暂无通知。提醒到期后会出现在这里。")).toBeInTheDocument();
  });

  it("cycles theme from the title bar toggle next to notifications", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    const toggle = screen.getByRole("button", { name: /主题：/ });
    await user.click(toggle);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
