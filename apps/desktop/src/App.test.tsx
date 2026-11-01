import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("App shell", () => {
  it("captures undated task into projects, not today", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByLabelText("快速捕获"),
      "回复邮件{Enter}",
    );

    await user.click(screen.getByRole("button", { name: "任务" }));
    expect(screen.getByText("回复邮件")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "今日" }));
    expect(screen.queryByText("回复邮件")).not.toBeInTheDocument();
  });

  it("schedules task onto today from projects", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText("快速捕获"), "写周报{Enter}");
    await user.click(screen.getByRole("button", { name: "任务" }));
    await user.click(screen.getByRole("button", { name: "今天" }));
    await user.click(screen.getByRole("button", { name: "今日" }));
    expect(screen.getByText("写周报")).toBeInTheDocument();
  });
});
