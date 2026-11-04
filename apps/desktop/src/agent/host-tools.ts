import {
  assembleHostTools,
  parseHostToolRunArgs,
  type HostToolLane,
  type HostToolProbe,
  type HostToolSnapshot,
} from "@wb/domain";
import { errorMessage } from "../lib/errors";
import { isTauriRuntime } from "../lib/paths";
import type { AgentToolResult } from "./execute";

/** How many tool installs may download and extract at once. */
export const HOST_TOOL_INSTALL_SLOTS = 2;

export function canStartHostToolInstall(
  running: readonly { id: string; lane: HostToolLane }[],
  next: { id: string; lane: HostToolLane },
  slots = HOST_TOOL_INSTALL_SLOTS,
): boolean {
  if (running.some((item) => item.id === next.id)) return false;
  if (running.length >= slots) return false;
  if (next.lane !== "none" && running.some((item) => item.lane === next.lane))
    return false;
  return true;
}

type RunPayload = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

export async function probeHostTools(
  disabledIds: readonly string[],
  paths: Readonly<Record<string, string>> = {},
): Promise<HostToolSnapshot[]> {
  if (!isTauriRuntime()) return assembleHostTools([], disabledIds);
  const { invoke } = await import("@tauri-apps/api/core");
  const hits = await invoke<HostToolProbe[]>("tools_probe", { paths });
  return assembleHostTools(hits ?? [], disabledIds);
}

export async function pickHostToolPath(id: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("tools_pick_path", { id });
}

export async function checkHostTool(
  id: string,
  path: string,
): Promise<{ path: string; version: string }> {
  if (!isTauriRuntime()) throw new Error("检测需要桌面版");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<{ path: string; version: string }>("tools_check", {
    id,
    path,
  });
}

export async function installHostTool(
  id: string,
  proxy: string,
  onLog?: (text: string) => void,
): Promise<void> {
  if (!isTauriRuntime()) throw new Error("安装需要桌面版");
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<{ id: string; text: string }>(
    "host-tool-install-log",
    (event) => {
      if (event.payload?.id === id && event.payload.text) onLog?.(event.payload.text);
    },
  );
  try {
    await invoke("tools_install", { id, proxy: proxy.trim() || null });
  } finally {
    unlisten();
  }
}

export async function runHostTool(
  tools: readonly HostToolSnapshot[],
  raw: Record<string, unknown>,
): Promise<AgentToolResult> {
  const parsed = parseHostToolRunArgs(raw);
  if (parsed.ok === false) return fail(parsed.reason);
  const tool = tools.find((item) => item.id === parsed.toolId);
  if (!tool || !tool.enabled || tool.status !== "ready") {
    return fail(`工具 ${parsed.toolId} 未启用或尚未就绪`);
  }
  if (!isTauriRuntime()) return fail("当前环境不能运行本机工具");
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<RunPayload>("tools_run", {
      id: parsed.toolId,
      args: parsed.args,
      cwd: parsed.cwd || null,
      bin: parsed.bin || null,
      path: tool.source === "manual" ? tool.path : null,
    });
    return {
      ok: result.ok,
      summary: result.ok ? `${tool.name} 已完成` : `${tool.name} 退出码 ${result.code}`,
      data: {
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        code: result.code,
      },
      effects: [],
    };
  } catch (err) {
    return fail(errorMessage(err, "运行本机工具失败"));
  }
}

function fail(message: string): AgentToolResult {
  return { ok: false, summary: message, data: { error: message }, effects: [] };
}
