import { MemoryWorkbenchRepository } from "@wb/db/memory";

const STORAGE_KEY = "wb.local.v1";

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

export function saveStore(store: MemoryWorkbenchRepository): void {
  localStorage.setItem(STORAGE_KEY, store.exportSnapshot());
}
