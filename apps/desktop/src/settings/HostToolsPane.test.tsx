import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPrefs, type AppPrefs } from "../lib/prefs";
import { renderWithProviders } from "../test/render";
import { HostToolsPane } from "./HostToolsPane";

const { pending } = vi.hoisted(() => ({
  pending: new Map<string, () => void>(),
}));

vi.mock("../agent/host-tools", async () => {
  const actual =
    await vi.importActual<typeof import("../agent/host-tools")>("../agent/host-tools");
  return {
    ...actual,
    installHostTool: (id: string, _proxy?: string, onLog?: (text: string) => void) =>
      new Promise<void>((resolve) => {
        onLog?.(`> install ${id}\n`);
        pending.set(id, resolve);
      }),
  };
});

afterEach(() => {
  cleanup();
  pending.clear();
});

function renderPane(
  extra: Partial<AppPrefs> = {},
  onPatch: (partial: Partial<AppPrefs>) => void = () => undefined,
) {
  renderWithProviders(
    <HostToolsPane
      prefs={{
        ...readPrefs(),
        disabledHostTools: [],
        httpProxy: "",
        hostToolsFetched: true,
        ...extra,
      }}
      dataDir="C:\\Users\\me\\AppData\\Roaming\\my-workbench"
      onPatch={onPatch}
    />,
  );
}

function rowOf(name: string): HTMLElement {
  const title = screen
    .getAllByText(name)
    .find((el) => el.classList.contains("settings__row-title"));
  const row = title?.closest(".settings__row");
  if (!(row instanceof HTMLElement)) throw new Error(`找不到 ${name}`);
  return row;
}

describe("HostToolsPane installs", () => {
  it("shows status as text and installs from 详情 with a live log", async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByText("uv");

    expect(within(rowOf("uv")).getByText("未安装")).toBeInTheDocument();
    expect(within(rowOf("uv")).queryByRole("button", { name: "安装" })).toBeNull();
    expect(within(rowOf("uv")).queryByRole("button", { name: "已安装" })).toBeNull();

    await user.click(within(rowOf("uv")).getByRole("button", { name: "uv 详情" }));
    const dialog = await screen.findByRole("dialog", { name: "uv" });
    await user.click(within(dialog).getByRole("button", { name: "安装" }));

    expect(await within(dialog).findByRole("textbox", { name: "安装日志" })).toHaveValue(
      "> install uv\n",
    );
    expect(within(rowOf("uv")).getByText("正在安装…")).toBeInTheDocument();

    await act(async () => {
      pending.get("uv")?.();
    });

    expect(await screen.findByRole("dialog", { name: "安装已完成" })).toBeInTheDocument();
    expect(screen.getByText("uv 已安装。")).toBeInTheDocument();
  });

  it("starts fetching missing tools after a scan", async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByRole("button", { name: "扫描本机" });

    await user.click(screen.getByRole("button", { name: "扫描本机" }));

    expect(await screen.findByText(/正在自动获取/)).toBeInTheDocument();
    expect(await screen.findAllByText("正在安装…")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "扫描本机" })).toBeDisabled();
    expect(within(rowOf("ripgrep")).getByText("等待获取")).toBeInTheDocument();
    expect(within(rowOf("ripgrep")).queryByRole("button", { name: "安装" })).toBeNull();
  });

  it("fetches once on the first open and stores the result", async () => {
    const patches: Partial<AppPrefs>[] = [];
    renderPane({ hostToolsFetched: false, hostToolRecords: [] }, (partial) => {
      patches.push(partial);
    });

    expect(await screen.findByText(/正在自动获取/)).toBeInTheDocument();
    expect(pending.size).toBeGreaterThan(0);

    for (let i = 0; i < 80 && !patches.some((item) => item.hostToolsFetched); i++) {
      const resolvers = [...pending.values()];
      pending.clear();
      await act(async () => {
        for (const resolve of resolvers) resolve();
      });
    }

    const saved = patches.find((item) => item.hostToolsFetched);
    expect(saved?.hostToolsFetched).toBe(true);
    expect(saved?.hostToolRecords).toEqual([]);
  });

  it("reads the saved record on the next open and does not fetch again", async () => {
    renderPane({
      hostToolsFetched: true,
      hostToolRecords: [
        {
          id: "uv",
          status: "ready",
          source: "env",
          path: "C:\\Tools\\uv.exe",
          version: "0.13.7",
          invoke: ["C:\\Tools\\uv.exe"],
        },
      ],
    });

    expect(await screen.findByText("uv")).toBeInTheDocument();
    expect(within(rowOf("uv")).getByText("已安装")).toBeInTheDocument();
    expect(within(rowOf("uv")).queryByRole("button", { name: "已安装" })).toBeNull();
    expect(pending.size).toBe(0);
    expect(screen.queryByText(/正在自动获取/)).not.toBeInTheDocument();
    expect(screen.queryByText(/正在扫描/)).not.toBeInTheDocument();
  });

  it("opens usage, path, and a manual binary field from 详情", async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByText("readelf");

    await user.click(screen.getByRole("button", { name: "readelf 详情" }));

    const dialog = await screen.findByRole("dialog", { name: "readelf" });
    expect(within(dialog).getByText("功能")).toBeInTheDocument();
    expect(within(dialog).getByText("使用说明")).toBeInTheDocument();
    expect(within(dialog).getByText(/bin 用 readelf/)).toBeInTheDocument();
    expect(within(dialog).getByText("尚未检测到")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/可执行名：readelf、llvm-readelf/),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText("二进制路径")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "浏览" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "安装" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "检测" })).toBeDisabled();
  });

  it("filters the list down to missing tools", async () => {
    const user = userEvent.setup();
    renderPane();
    await screen.findByText("uv");

    await user.click(screen.getByRole("button", { name: "可用" }));
    expect(screen.queryByText("uv")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "缺失" }));
    expect(screen.getByText("uv")).toBeInTheDocument();
    expect(screen.getByText("Matplotlib")).toBeInTheDocument();
  });
});
