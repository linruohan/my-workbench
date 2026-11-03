import {
  assembleHostTools,
  parseHostToolRunArgs,
  type HostToolCategory,
  type HostToolProbe,
  type HostToolSnapshot,
} from "@wb/domain";
import { errorMessage } from "../lib/errors";
import { isTauriRuntime } from "../lib/paths";
import type { AgentToolResult } from "./execute";

/** How many tool installs may download and extract at once. */
export const HOST_TOOL_INSTALL_SLOTS = 2;

export function canStartHostToolInstall(
  running: readonly { id: string; category: HostToolCategory }[],
  next: { id: string; category: HostToolCategory },
  slots = HOST_TOOL_INSTALL_SLOTS,
): boolean {
  if (running.some((item) => item.id === next.id)) return false;
  if (running.length >= slots) return false;
  // Chart libraries share one Python and one package directory.
  if (next.category === "chart" && running.some((item) => item.category === "chart")) {
    return false;
  }
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
): Promise<HostToolSnapshot[]> {
  if (!isTauriRuntime()) return assembleHostTools([], disabledIds);
  const { invoke } = await import("@tauri-apps/api/core");
  const hits = await invoke<HostToolProbe[]>("tools_probe");
  return assembleHostTools(hits ?? [], disabledIds);
}

export async function installHostTool(id: string, proxy: string): Promise<void> {
  if (!isTauriRuntime()) throw new Error("安装需要桌面版");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("tools_install", { id, proxy: proxy.trim() || null });
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
