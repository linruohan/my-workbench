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
});
