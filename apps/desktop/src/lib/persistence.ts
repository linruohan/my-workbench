import { MemoryWorkbenchRepository } from "@wb/db/memory";
import {
  applyWorkbenchDbChanges,
  dumpHasRows,
  loadWorkbenchDb,
  rowsToSnapshotJson,
} from "./sqlite-store";
import { dataFilePath, ensureDataDir, isTauriRuntime, STORE_FILE } from "./paths";

const STORAGE_KEY = "wb.local.v1";
/** 合并窗口：短时间内多次改动只落盘一次，避免每个按键都全量序列化 */
const SAVE_DEBOUNCE_MS = 400;
/** 每日一份的上一版快照，主文件损坏时可回退（兼容旧单文件备份） */
const BACKUP_FILE = "workbench.bak.json";
const BACKUP_PREFIX = "workbench.bak.";
const BACKUP_SUFFIX = ".json";
const BACKUP_STAMP_KEY = "wb.store.backup.day";
const MAX_ROLLING_BACKUPS = 7;
/** SQLite 为主路径时，JSON 快照降级为兜底副本，最长这个间隔才重写一次 */
const SNAPSHOT_FALLBACK_MS = 60_000;
/** 快照体积告警阈值：超过后保存状态条提示整理数据 */
export const SNAPSHOT_WARN_BYTES = 6 * 1024 * 1024;
/** 体积观测日志的最小间隔与最小增量，避免每次落盘都刷屏 */
const SNAPSHOT_LOG_MIN_MS = 30_000;
const SNAPSHOT_LOG_MIN_DELTA = 64 * 1024;

let pendingStore: MemoryWorkbenchRepository | null = null;
let pendingTimer: number | null = null;
let writing = false;
let lastJsonWriteAt = 0;
let lastLog: { at: number; bytes: number } | null = null;

export type SaveStatus = {
  ok: boolean;
  message: string | null;
  at: number;
  /** 最近一次快照字节数（观测用）。 */
  bytes?: number;
  /** 保存成功但需要用户注意的事项（如快照体积偏大）。 */
  warning?: string | null;
};
let lastSaveStatus: SaveStatus = { ok: true, message: null, at: 0 };
const saveListeners = new Set<(status: SaveStatus) => void>();

function publishSaveStatus(status: SaveStatus): void {
  lastSaveStatus = status;
  for (const fn of saveListeners) fn(status);
}

export function getLastSaveStatus(): SaveStatus {
  return lastSaveStatus;
}

export function subscribeSaveStatus(fn: (status: SaveStatus) => void): () => void {
  saveListeners.add(fn);
  return () => saveListeners.delete(fn);
}

async function readText(path: string): Promise<string | null> {
  try {
    const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
    if (!(await exists(path))) return null;
    return await readTextFile(path);
  } catch {
    return null;
  }
}

async function writeText(path: string, contents: string): Promise<void> {
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  await writeTextFile(path, contents);
}

/** 原子写：先落临时文件再改名；改名不可用时回退为直接覆盖 */
async function writeTextAtomic(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp`;
  try {
    await writeText(tmp, contents);
    const { rename } = await import("@tauri-apps/plugin-fs");
    await rename(tmp, path);
  } catch {
    await writeText(path, contents);
  }
}

/** 把快照导入仓储；解析失败返回 false，避免静默清空后覆盖原文件 */
function importInto(store: MemoryWorkbenchRepository, raw: string): boolean {
  try {
    store.importSnapshot(raw);
    return true;
  } catch {
    return false;
  }
}

/** 取本地日期（YYYY-MM-DD），用于每天只保留一份备份 */
function localDayStamp(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

async function listRollingBackups(): Promise<string[]> {
  try {
    const { readDir } = await import("@tauri-apps/plugin-fs");
    const dir = await ensureDataDir();
    const entries = await readDir(dir);
    const names = entries
      .map((entry) => entry.name ?? "")
      .filter(
        (name) =>
          name.startsWith(BACKUP_PREFIX) &&
          name.endsWith(BACKUP_SUFFIX) &&
          name !== BACKUP_FILE,
      )
      .sort()
      .reverse();
    return await Promise.all(names.map((name) => dataFilePath(name)));
  } catch {
    return [];
  }
}

/** 每日首次保存前，把上一版快照写入按日滚动备份（保留最近 N 份） */
async function backupBeforeOverwrite(path: string, next: string): Promise<void> {
  const today = localDayStamp();
  try {
    if (localStorage.getItem(BACKUP_STAMP_KEY) === today) return;
  } catch {
    // localStorage 不可用时照常备份
  }
  const prev = await readText(path);
  if (!prev || prev === next) return;
  try {
    const daily = await dataFilePath(`${BACKUP_PREFIX}${today}${BACKUP_SUFFIX}`);
    await writeText(daily, prev);
    // 兼容旧恢复逻辑：同时维护一份固定备份文件
    await writeText(await dataFilePath(BACKUP_FILE), prev);
    const backups = await listRollingBackups();
    const stale = backups.slice(MAX_ROLLING_BACKUPS);
    if (stale.length) {
      const { remove } = await import("@tauri-apps/plugin-fs");
      await Promise.allSettled(stale.map((file) => remove(file)));
    }
    localStorage.setItem(BACKUP_STAMP_KEY, today);
  } catch {
    // 备份失败不影响主文件保存
  }
}

export function createPersistedStore(): MemoryWorkbenchRepository {
  const store = new MemoryWorkbenchRepository();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) importInto(store, raw);
  } catch {
    // ignore corrupt local data; start fresh
  }
  return store;
}

export type HydrateResult = {
  restoredFromBackup: boolean;
  migratedLegacy: boolean;
  hadLoadIssue: boolean;
  /** 工作台 SQLite 已打开（此后落盘走增量主路径）。 */
  sqliteReady: boolean;
  /** 数据来自 SQLite 增量库。 */
  loadedFromSqlite: boolean;
};

/**
 * 装载顺序：SQLite 增量库 → AppData JSON 快照（含备份回退）→ 浏览器 localStorage。
 * 从 JSON / localStorage 装载时保留全量替换日志，下一次落盘会完整迁移进 SQLite。
 */
export async function hydrateStore(
  store: MemoryWorkbenchRepository,
): Promise<HydrateResult> {
  const result: HydrateResult = {
    restoredFromBackup: false,
    migratedLegacy: false,
    hadLoadIssue: false,
    sqliteReady: false,
    loadedFromSqlite: false,
  };
  if (!isTauriRuntime()) return result;
  const dump = await loadWorkbenchDb();
  result.sqliteReady = dump != null;
  if (dumpHasRows(dump)) {
    if (importInto(store, rowsToSnapshotJson(dump!))) {
      result.loadedFromSqlite = true;
      // 库里的内容即已持久化状态，复位变更日志
      store.markPersisted();
      return result;
    }
    result.hadLoadIssue = true;
  }
  try {
    await ensureDataDir();
    const path = await dataFilePath(STORE_FILE);
    const raw = await readText(path);
    // 主文件损坏时回退到日备份，并用备份修复主文件。
    if (raw && importInto(store, raw)) return result;
    if (raw) result.hadLoadIssue = true;
    const backupPaths = [
      ...(await listRollingBackups()),
      await dataFilePath(BACKUP_FILE),
    ];
    for (const backupPath of backupPaths) {
      const backup = await readText(backupPath);
      if (!backup || !importInto(store, backup)) continue;
      result.restoredFromBackup = true;
      try {
        await writeTextAtomic(path, backup);
      } catch {
        // 修复失败也保留内存中的备份数据
      }
      return result;
    }
    // Migrate existing browser snapshot into the AppData file once.
    const legacy = localStorage.getItem(STORAGE_KEY);
    if (legacy && importInto(store, legacy)) {
      result.migratedLegacy = true;
      await writeText(path, legacy);
    }
  } catch {
    result.hadLoadIssue = true;
    // keep in-memory / localStorage state
  }
  return result;
}

/** 节流落盘：合并 400ms 内的多次改动，避免每键全量序列化 */
export function scheduleSaveStore(store: MemoryWorkbenchRepository): void {
  pendingStore = store;
  if (pendingTimer != null) return;
  pendingTimer = window.setTimeout(() => {
    pendingTimer = null;
    void flushStore();
  }, SAVE_DEBOUNCE_MS);
}

/** 立即落盘：用于退出、切库等必须落地的时刻 */
export function saveStore(store: MemoryWorkbenchRepository): void {
  pendingStore = store;
  if (pendingTimer != null) {
    window.clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  void flushStore();
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/**
 * 快照体积观测：序列化耗时、体积、增量写库与 JSON 写盘耗时。
 * 体积增量达到阈值或间隔超时才输出一行日志，避免刷屏；超阈值时附告警。
 */
function observeSnapshot(input: {
  bytes: number;
  exportMs: number;
  sqliteMs: number | null;
  sqliteChanges: number | null;
  jsonMs: number | null;
}): string | null {
  const now = Date.now();
  const prev = lastLog;
  const delta = prev ? input.bytes - prev.bytes : input.bytes;
  const due =
    !prev ||
    Math.abs(delta) >= SNAPSHOT_LOG_MIN_DELTA ||
    now - prev.at >= SNAPSHOT_LOG_MIN_MS;
  if (!due) return null;
  lastLog = { at: now, bytes: input.bytes };
  const parts = [`快照 ${formatBytes(input.bytes)}`];
  if (prev) parts.push(`(${delta >= 0 ? "+" : "−"}${formatBytes(Math.abs(delta))})`);
  parts.push(`序列化 ${Math.max(1, Math.round(input.exportMs))}ms`);
  if (input.sqliteMs != null) {
    parts.push(`SQLite ${Math.max(1, Math.round(input.sqliteMs))}ms`);
    if (input.sqliteChanges != null) parts.push(`${input.sqliteChanges} 行`);
  }
  if (input.jsonMs != null) {
    parts.push(`JSON 写盘 ${Math.max(1, Math.round(input.jsonMs))}ms`);
  }
  const line = `[persistence] ${parts.join(" · ")}`;
  console.info(line);
  if (input.bytes > SNAPSHOT_WARN_BYTES) {
    return `快照体积较大（${formatBytes(input.bytes)}），可在设置中备份数据目录，或整理旧会话与已完成任务。`;
  }
  return null;
}

/** 执行一次真实写入；写入期间的新改动会重新排队 */
async function flushStore(): Promise<void> {
  if (writing) {
    if (pendingTimer == null && pendingStore) {
      pendingTimer = window.setTimeout(() => {
        pendingTimer = null;
        void flushStore();
      }, SAVE_DEBOUNCE_MS);
    }
    return;
  }
  const store = pendingStore;
  if (!store) return;
  pendingStore = null;
  const exportStart = performance.now();
  const json = store.exportSnapshot();
  const exportMs = performance.now() - exportStart;
  const bytes = json.length;
  // 浏览器预览态只用 localStorage；桌面端不再双写，避免 WebView 配额溢出。
  if (!isTauriRuntime()) {
    try {
      localStorage.setItem(STORAGE_KEY, json);
      const warning = observeSnapshot({
        bytes,
        exportMs,
        sqliteMs: null,
        sqliteChanges: null,
        jsonMs: null,
      });
      publishSaveStatus({ ok: true, message: null, warning, at: Date.now(), bytes });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "浏览器本地存储空间不足或不可用";
      console.warn("[persistence] 写入浏览器快照失败", err);
      publishSaveStatus({ ok: false, message, at: Date.now(), bytes });
    }
    return;
  }
  writing = true;
  try {
    const changes = store.collectPendingChanges();
    const sqliteStart = performance.now();
    const applied = await applyWorkbenchDbChanges(changes);
    const sqliteMs = performance.now() - sqliteStart;
    if (applied) store.markPersisted();
    // SQLite 增量为主路径；JSON 快照降级为兜底副本（失败或到期时重写）。
    const jsonDue = !applied || Date.now() - lastJsonWriteAt >= SNAPSHOT_FALLBACK_MS;
    let jsonMs: number | null = null;
    if (jsonDue) {
      const jsonStart = performance.now();
      await ensureDataDir();
      const path = await dataFilePath(STORE_FILE);
      await backupBeforeOverwrite(path, json);
      await writeTextAtomic(path, json);
      lastJsonWriteAt = Date.now();
      jsonMs = performance.now() - jsonStart;
    }
    const sqliteChanges = changes
      ? changes.upserts.length + changes.deletes.length + changes.replaced.length
      : null;
    const warning = observeSnapshot({
      bytes,
      exportMs,
      sqliteMs,
      sqliteChanges,
      jsonMs,
    });
    publishSaveStatus({ ok: true, message: null, warning, at: Date.now(), bytes });
  } catch (err) {
    const message = err instanceof Error ? err.message : "写入工作台快照失败";
    console.warn("[persistence] 写入工作台快照失败", err);
    publishSaveStatus({ ok: false, message, at: Date.now(), bytes });
  } finally {
    writing = false;
  }
}
