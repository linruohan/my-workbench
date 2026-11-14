/**
 * SQLite 增量持久化的前端接线：宿主侧（Rust）持有 `workbench.db`，
 * 前端在节流落盘时把内存仓储的变更日志增量写入，启动时优先从库回读。
 * 旧运行时或命令失败时全部回退 JSON 快照路径，不影响可用性。
 */

import type { PendingChanges } from "@wb/db/memory";
import { dataFilePath, isTauriRuntime } from "./paths";

export const WORKBENCH_DB_FILE = "workbench.db";

export type WbDbRow = { kind: string; id: string; seq: number; data: string };
export type WbDbDump = { rows: WbDbRow[] };

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/** 打开（或创建）工作台 SQLite 并回读全部实体行；不可用时返回 null。 */
export async function loadWorkbenchDb(): Promise<WbDbDump | null> {
  if (!isTauriRuntime()) return null;
  try {
    const path = await dataFilePath(WORKBENCH_DB_FILE);
    return await call<WbDbDump>("wb_db_open", { path });
  } catch (err) {
    console.warn("[sqlite] 打开 workbench.db 失败，回退 JSON 快照", err);
    return null;
  }
}

/** 应用一次增量变更；无变更（null）视为成功。失败返回 false，调用方回退全量快照。 */
export async function applyWorkbenchDbChanges(
  changes: PendingChanges | null,
): Promise<boolean> {
  if (!changes) return true;
  if (!isTauriRuntime()) return false;
  try {
    await call("wb_db_apply", {
      changes: {
        upserts: changes.upserts,
        deletes: changes.deletes,
        replaced: changes.replaced,
      },
    });
    return true;
  } catch (err) {
    console.warn("[sqlite] 增量写库失败，本次回退 JSON 快照", err);
    return false;
  }
}

/**
 * 把实体行还原成与 exportSnapshot 同构的快照 JSON，交 importSnapshot 装载。
 * 会话消息按 seq（创建时间）排序，同毫秒再按 id（时间前缀 ULID）稳定排序。
 */
export function rowsToSnapshotJson(dump: WbDbDump): string {
  const byKind = new Map<string, WbDbRow[]>();
  for (const row of dump.rows) {
    const list = byKind.get(row.kind);
    if (list) list.push(row);
    else byKind.set(row.kind, [row]);
  }
  const data = (kind: string): unknown[] =>
    (byKind.get(kind) ?? []).map((row) => JSON.parse(row.data) as unknown);
  const pairs = (kind: string): Array<[string, unknown]> =>
    (byKind.get(kind) ?? []).map((row) => [row.id, JSON.parse(row.data) as unknown]);
  const messages = (byKind.get("agent_message") ?? [])
    .slice()
    .sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => JSON.parse(row.data) as unknown);
  return JSON.stringify({
    tasks: data("task"),
    projects: data("project"),
    buckets: pairs("task_bucket"),
    todayOrder: (data("today_order")[0] as string[] | undefined) ?? [],
    notifications: data("notification"),
    notes: data("note"),
    timedTasks: data("timed_task"),
    tags: data("tag"),
    taskTags: pairs("task_tag"),
    agentWorkspaces: data("agent_workspace"),
    agentThreads: data("agent_thread"),
    agentMessages: messages,
    agentApprovals: data("agent_approval"),
  });
}

/** SQLite 是否已装载数据（空库视为未装载，走 JSON 快照路径）。 */
export function dumpHasRows(dump: WbDbDump | null): boolean {
  return !!dump && dump.rows.length > 0;
}
