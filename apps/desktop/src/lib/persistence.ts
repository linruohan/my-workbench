import { MemoryWorkbenchRepository } from "@wb/db/memory";
import {
  dataFilePath,
  ensureDataDir,
  isTauriRuntime,
  STORE_FILE,
} from "./paths";

const STORAGE_KEY = "wb.local.v1";

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

export function createPersistedStore(): MemoryWorkbenchRepository {
  const store = new MemoryWorkbenchRepository();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) store.importSnapshot(raw);
  } catch {
    // ignore corrupt local data; start fresh
  }
  return store;
}

/** Prefer AppData file when running in Tauri; keep localStorage as browser fallback. */
export async function hydrateStore(
  store: MemoryWorkbenchRepository,
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await ensureDataDir();
    const path = await dataFilePath(STORE_FILE);
    const raw = await readText(path);
    if (raw) {
      store.importSnapshot(raw);
      return;
    }
    // Migrate existing browser snapshot into the AppData file once.
    const legacy = localStorage.getItem(STORAGE_KEY);
    if (legacy) {
      await writeText(path, legacy);
      store.importSnapshot(legacy);
    }
  } catch {
    // keep in-memory / localStorage state
  }
}

export function saveStore(store: MemoryWorkbenchRepository): void {
  const json = store.exportSnapshot();
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch {
    // ignore quota / private mode
  }
  if (isTauriRuntime()) {
    void (async () => {
      try {
        await ensureDataDir();
        await writeText(await dataFilePath(STORE_FILE), json);
      } catch {
        // keep localStorage copy
      }
    })();
  }
}
