import { cleanup, screen, within } from "@testing-library/react";
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
  initialSection?: "general" | "personal" | "skills" | "memory" | "tools";
  onPrefs?: (prefs: AppPrefs) => void;
}) {
  const [prefs, setPrefs] = useState<AppPrefs>({
    ...readPrefs(),
    agentRules: "",
    skillDirs: [],
    hostToolsFetched: true,
  });
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
    expect(labels.indexOf("工具")).toBe(models + 9);
    expect(screen.queryByText("Agent 能力")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "能力" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "命令" }));
    expect(screen.getByRole("heading", { name: "命令" })).toBeInTheDocument();
    expect(screen.getByText("/today")).toBeInTheDocument();
    expect(screen.getByText("根据今天的安排写晨报")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "钩子" }));
    expect(screen.getByRole("option", { name: "任务完成" })).toBeInTheDocument();
    expect(screen.getAllByText("还没有钩子")).toHaveLength(3);
  });

  it("saves user rules into prefs", async () => {
    const user = userEvent.setup();
    const seen: AppPrefs[] = [];
    renderWithProviders(
      <Harness initialSection="personal" onPrefs={(prefs) => seen.push(prefs)} />,
    );

    await user.type(screen.getByLabelText("用户规则"), "用短句");
    expect(screen.getByLabelText("用户规则")).toHaveValue("用短句");
    expect(seen.at(-1)?.agentRules).toBe("用短句");
  });

  it("saves a memory into prefs", async () => {
    const user = userEvent.setup();
    const seen: AppPrefs[] = [];
    renderWithProviders(
      <Harness initialSection="memory" onPrefs={(prefs) => seen.push(prefs)} />,
    );
    await user.type(screen.getByLabelText("新记忆"), "周五写周报");
    await user.click(screen.getByRole("button", { name: "添加记忆" }));
    expect(screen.getByText("周五写周报")).toBeInTheDocument();
    expect(seen.at(-1)?.agentMemories.map((item) => item.text)).toEqual(["周五写周报"]);
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

  it("lists host tools and an install action when nothing is detected", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initialSection="tools" />);

    expect(await screen.findByRole("heading", { name: "工具" })).toBeInTheDocument();
    expect(await screen.findByText("Go")).toBeInTheDocument();
    expect(screen.getByText("ripgrep")).toBeInTheDocument();
    expect(screen.getByText("FFmpeg")).toBeInTheDocument();
    expect(screen.getByText("Inkscape")).toBeInTheDocument();
    expect(screen.getByText("Mermaid")).toBeInTheDocument();
    expect(screen.getByText("Matplotlib")).toBeInTheDocument();
    expect(screen.getByText("Plotly")).toBeInTheDocument();
    expect(screen.getByText("Altair")).toBeInTheDocument();
    expect(screen.getByText("Bokeh")).toBeInTheDocument();
    expect(screen.getByLabelText("工具目录").textContent).toMatch(/my-workbench\/tools$/);
    expect(screen.queryByRole("button", { name: "安装" })).not.toBeInTheDocument();
    expect(screen.getByText("Cairo")).toBeInTheDocument();
    expect(screen.getAllByText(/矢量图/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Go 详情" }));
    const dialog = await screen.findByRole("dialog", { name: "Go" });
    expect(within(dialog).getByRole("button", { name: "安装" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));

    await user.click(screen.getByRole("switch", { name: "停用 Go" }));
    expect(screen.getByText("已停用")).toBeInTheDocument();
  });

  it("shows skills pane actions for adding directories", async () => {
    renderWithProviders(<Harness initialSection="skills" />);
    expect(screen.getByRole("heading", { name: "技能" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加技能目录" })).toBeInTheDocument();
    expect(
      screen.getByText("还没有技能目录。选择包含 SKILL.md 的文件夹即可。"),
    ).toBeInTheDocument();
  });
});
