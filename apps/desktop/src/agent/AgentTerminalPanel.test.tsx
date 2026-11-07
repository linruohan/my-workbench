import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTerminalPanel } from "./AgentTerminalPanel";

vi.mock("../lib/paths", () => ({
  isTauriRuntime: () => true,
}));

const listAgentTerminals = vi.fn();
const readAgentTerminal = vi.fn();
const sendAgentTerminal = vi.fn();
const openAgentTerminal = vi.fn();
const closeAgentTerminal = vi.fn();
const signalAgentTerminal = vi.fn();

vi.mock("./terminal-api", () => ({
  listAgentTerminals: (...args: unknown[]) => listAgentTerminals(...args),
  readAgentTerminal: (...args: unknown[]) => readAgentTerminal(...args),
  sendAgentTerminal: (...args: unknown[]) => sendAgentTerminal(...args),
  openAgentTerminal: (...args: unknown[]) => openAgentTerminal(...args),
  closeAgentTerminal: (...args: unknown[]) => closeAgentTerminal(...args),
  signalAgentTerminal: (...args: unknown[]) => signalAgentTerminal(...args),
}));

describe("AgentTerminalPanel", () => {
  beforeEach(() => {
    listAgentTerminals.mockReset();
    readAgentTerminal.mockReset();
    sendAgentTerminal.mockReset();
    openAgentTerminal.mockReset();
    closeAgentTerminal.mockReset();
    signalAgentTerminal.mockReset();
    listAgentTerminals.mockResolvedValue([
      {
        id: "term_1",
        name: "main",
        cwd: "D:\\repo",
        shell: "pwsh",
        alive: true,
      },
    ]);
    readAgentTerminal.mockResolvedValue({
      id: "term_1",
      output: "PS D:\\repo>",
      alive: true,
    });
    sendAgentTerminal.mockResolvedValue({
      id: "term_1",
      output: "hello\nPS D:\\repo>",
      alive: true,
    });
  });

  it("lists an open terminal session and shows output", async () => {
    render(
      <AgentTerminalPanel
        open
        onOpenChange={() => undefined}
        rootPath="D:\\repo"
        refreshKey={1}
      />,
    );
    expect(await screen.findByText("main")).toBeTruthy();
    expect(await screen.findByText("PS D:\\repo>")).toBeTruthy();
    expect(screen.getByText(/pwsh/)).toBeTruthy();
  });

  it("sends typed input to the active terminal", async () => {
    const user = userEvent.setup();
    render(
      <AgentTerminalPanel
        open
        onOpenChange={() => undefined}
        rootPath="D:\\repo"
        refreshKey={1}
      />,
    );
    const input = await screen.findByPlaceholderText(/输入命令/);
    await user.clear(input);
    await user.type(input, "echo hi");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(sendAgentTerminal).toHaveBeenCalledWith("term_1", "echo hi", true);
    });
  });
});
