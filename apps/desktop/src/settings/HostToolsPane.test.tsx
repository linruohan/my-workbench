import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPrefs } from "../lib/prefs";
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
    installHostTool: (id: string) =>
      new Promise<void>((resolve) => {
        pending.set(id, resolve);
      }),
  };
});

afterEach(() => {
  cleanup();
  pending.clear();
});

function renderPane() {
  renderWithProviders(
    <HostToolsPane
      prefs={{ ...readPrefs(), disabledHostTools: [], httpProxy: "" }}
      dataDir="C:\\Users\\me\\AppData\\Roaming\\my-workbench"
      onPatch={() => undefined}
    />,
  );
}

describe("HostToolsPane installs", () => {
  it("runs two installs and holds the rest", async () => {
    const user = userEvent.setup();
    renderPane();
    const buttons = await screen.findAllByRole("button", { name: "安装" });

    await user.click(buttons[0]!);
    await user.click(buttons[1]!);

    expect(await screen.findAllByText("正在安装…")).toHaveLength(2);
    expect(buttons[2]).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新检测" })).toBeDisabled();
  });

  it("keeps a second chart library waiting while another install can start", async () => {
    const user = userEvent.setup();
    renderPane();
    const buttons = await screen.findAllByRole("button", { name: "安装" });
    const matplotlib = buttons[5]!;
    const plotly = buttons[6]!;
    const go = buttons[0]!;

    await user.click(matplotlib);

    expect(await screen.findByText("正在安装…")).toBeInTheDocument();
    expect(plotly).toBeDisabled();
    expect(go).toBeEnabled();

    await user.click(go);

    expect(screen.getAllByText("正在安装…")).toHaveLength(2);
    expect(buttons[1]).toBeDisabled();
  });
});
