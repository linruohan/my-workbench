import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { readPrefs, type AppPrefs } from "../lib/prefs";
import { renderWithProviders } from "../test/render";
import { SettingsView } from "./SettingsView";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function Harness({
  initialSection = "general" as const,
  onPrefs,
}: {
  initialSection?: "general" | "personal";
  onPrefs?: (prefs: AppPrefs) => void;
}) {
  const [prefs, setPrefs] = useState<AppPrefs>({ ...readPrefs(), agentRules: "" });
  return (
    <SettingsView
      prefs={prefs}
      dataDir="C:\\Users\\me\\AppData\\Roaming\\my-workbench"
      onPrefsChange={(next) => {
        setPrefs(next);
        onPrefs?.(next);
      }}
      onBack={() => undefined}
      initialSection={initialSection}
    />
  );
}

function navLabels(): string[] {
  return screen.getAllByRole("button").map((button) => button.textContent ?? "");
}

describe("Agent capabilities settings", () => {
  it("lists capabilities under Agent, below models, without a second column", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const labels = navLabels();
    const models = labels.indexOf("模型");
    expect(models).toBeGreaterThan(-1);
    expect(labels.indexOf("个性化")).toBe(models + 1);
    expect(labels.indexOf("钩子")).toBe(models + 8);
    expect(screen.queryByText("Agent 能力")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "能力" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "命令" }));
    expect(screen.getByRole("heading", { name: "命令" })).toBeInTheDocument();
    expect(screen.getByText("/today")).toBeInTheDocument();
    expect(screen.getByText("根据今天的安排写晨报")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "钩子" }));
    expect(screen.getByText("任务完成")).toBeInTheDocument();
    expect(screen.getAllByText("还没有钩子")).toHaveLength(3);
  });

  it("saves user rules into prefs", async () => {
    const user = userEvent.setup();
    const seen: AppPrefs[] = [];
    renderWithProviders(<Harness initialSection="personal" onPrefs={(prefs) => seen.push(prefs)} />);

    await user.type(screen.getByLabelText("用户规则"), "用短句");
    expect(screen.getByLabelText("用户规则")).toHaveValue("用短句");
    expect(seen.at(-1)?.agentRules).toBe("用短句");
  });

  it("finds a capability from the settings search", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.type(screen.getByLabelText("搜索设置"), "记忆");
    expect(screen.getByRole("button", { name: "记忆" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "插件" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "记忆" }));
    expect(screen.getByRole("heading", { name: "记忆" })).toBeInTheDocument();
  });
});
