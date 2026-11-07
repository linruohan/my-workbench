import { stripAnsiEscapes } from "@wb/domain";
import { isTauriRuntime } from "../lib/paths";

export type AgentTerminalInfo = {
  id: string;
  name: string;
  cwd: string;
  shell: string;
  alive: boolean;
};

export type AgentTerminalOutput = {
  id: string;
  output: string;
  alive: boolean;
};

export type AgentTerminalOpenHit = {
  id: string;
  name: string;
  cwd: string;
  shell: string;
};

const TERM_OPEN_KEY = "wb.agent.termOpen.v1";

export function readTerminalPanelOpen(): boolean {
  try {
    return localStorage.getItem(TERM_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeTerminalPanelOpen(open: boolean): void {
  try {
    localStorage.setItem(TERM_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* ignore quota / private mode */
  }
}

export async function listAgentTerminals(): Promise<AgentTerminalInfo[]> {
  if (!isTauriRuntime()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  const rows =
    await invoke<
      Array<{ id: string; name: string; cwd: string; shell?: string; alive: boolean }>
    >("agent_terminal_list");
  return rows.map((row) => ({
    id: row.id,
    name: row.name || row.id,
    cwd: row.cwd,
    shell: row.shell || "",
    alive: row.alive,
  }));
}

export async function openAgentTerminal(input: {
  root: string;
  workdir?: string | null;
  name?: string | null;
  shell?: "pwsh" | "bash" | null;
}): Promise<AgentTerminalOpenHit> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AgentTerminalOpenHit>("agent_terminal_open", {
    root: input.root,
    workdir: input.workdir?.trim() || null,
    name: input.name?.trim() || null,
    shell: input.shell || null,
  });
}

export async function sendAgentTerminal(
  sessionId: string,
  text: string,
  submit = true,
  timeoutMs = 15_000,
): Promise<AgentTerminalOutput> {
  const { invoke } = await import("@tauri-apps/api/core");
  const hit = await invoke<{ id: string; output: string; alive: boolean }>(
    "agent_terminal_send",
    { sessionId, text, submit, timeoutMs },
  );
  return {
    id: hit.id,
    output: stripAnsiEscapes(hit.output ?? ""),
    alive: hit.alive,
  };
}

export async function readAgentTerminal(
  sessionId: string,
  limit = 400,
): Promise<AgentTerminalOutput> {
  const { invoke } = await import("@tauri-apps/api/core");
  const hit = await invoke<{ id: string; output: string; alive: boolean }>(
    "agent_terminal_read",
    { sessionId, offset: 0, limit },
  );
  return {
    id: hit.id,
    output: stripAnsiEscapes(hit.output ?? ""),
    alive: hit.alive,
  };
}

export async function closeAgentTerminal(sessionId: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("agent_terminal_close", { sessionId });
}

export async function signalAgentTerminal(
  sessionId: string,
  signal = "SIGINT",
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("agent_terminal_signal", { sessionId, signal });
}
