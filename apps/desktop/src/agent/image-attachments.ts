/**
 * Session-scoped image attachment store (light DSH attachments for read_image).
 * In-memory refs plus optional disk persistence under the app data dir.
 */

import { dataFilePath, isTauriRuntime } from "../lib/paths";

export type StoredImageAttachment = {
  id: string;
  threadId: string;
  path: string;
  mediaType: string;
  dataUrl: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
  createdAt: number;
};

const byThread = new Map<string, StoredImageAttachment[]>();
const pendingByThread = new Map<string, string[]>();

const MAX_PER_THREAD = 24;

export function putImageAttachment(
  input: Omit<StoredImageAttachment, "id" | "createdAt"> & { id?: string },
  nowMs = Date.now(),
): StoredImageAttachment {
  const id =
    input.id?.trim() ||
    `img_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const entry: StoredImageAttachment = {
    id,
    threadId: input.threadId,
    path: input.path,
    mediaType: input.mediaType,
    dataUrl: input.dataUrl,
    bytes: input.bytes,
    width: input.width,
    height: input.height,
    name: input.name,
    createdAt: nowMs,
  };
  const list = byThread.get(input.threadId) ?? [];
  list.push(entry);
  while (list.length > MAX_PER_THREAD) {
    const dropped = list.shift();
    if (dropped) void removeDiskAttachment(dropped.threadId, dropped.id);
  }
  byThread.set(input.threadId, list);
  const pending = pendingByThread.get(input.threadId) ?? [];
  pending.push(id);
  pendingByThread.set(input.threadId, pending);
  void persistDiskAttachment(entry);
  return entry;
}

export function getImageAttachment(
  threadId: string,
  attachmentId: string,
): StoredImageAttachment | null {
  const list = byThread.get(threadId) ?? [];
  return list.find((item) => item.id === attachmentId) ?? null;
}

/** Async disk lookup when the in-memory slot was evicted or process restarted. */
export async function loadImageAttachment(
  threadId: string,
  attachmentId: string,
): Promise<StoredImageAttachment | null> {
  const hit = getImageAttachment(threadId, attachmentId);
  if (hit) return hit;
  if (!isTauriRuntime()) return null;
  try {
    const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await attachmentPath(threadId, attachmentId);
    if (!(await exists(path))) return null;
    const raw = JSON.parse(await readTextFile(path)) as StoredImageAttachment;
    if (!raw?.id || !raw.dataUrl) return null;
    const list = byThread.get(threadId) ?? [];
    list.push(raw);
    while (list.length > MAX_PER_THREAD) list.shift();
    byThread.set(threadId, list);
    return raw;
  } catch {
    return null;
  }
}

/** Data URLs queued since the last model request; clears the pending queue. */
export function takePendingImageDataUrls(threadId: string): string[] {
  const pending = pendingByThread.get(threadId) ?? [];
  pendingByThread.set(threadId, []);
  const list = byThread.get(threadId) ?? [];
  const byId = new Map(list.map((item) => [item.id, item]));
  const out: string[] = [];
  for (const id of pending) {
    const hit = byId.get(id);
    if (hit?.dataUrl) out.push(hit.dataUrl);
  }
  return out;
}

export function clearThreadImageAttachments(threadId: string): void {
  byThread.delete(threadId);
  pendingByThread.delete(threadId);
}

async function attachmentPath(threadId: string, attachmentId: string): Promise<string> {
  const { join } = await import("@tauri-apps/api/path");
  const root = await dataFilePath("attachments");
  return join(root, sanitize(threadId), `${sanitize(attachmentId)}.json`);
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "x";
}

async function persistDiskAttachment(entry: StoredImageAttachment): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { mkdir, writeTextFile, exists } = await import("@tauri-apps/plugin-fs");
    const { dirname } = await import("@tauri-apps/api/path");
    const root = await dataFilePath("attachments");
    if (!(await exists(root))) await mkdir(root, { recursive: true });
    const path = await attachmentPath(entry.threadId, entry.id);
    const dir = await dirname(path);
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
    await writeTextFile(path, JSON.stringify(entry));
  } catch {
    // keep memory-only on IO failure
  }
}

async function removeDiskAttachment(
  threadId: string,
  attachmentId: string,
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { exists, remove } = await import("@tauri-apps/plugin-fs");
    const path = await attachmentPath(threadId, attachmentId);
    if (await exists(path)) await remove(path);
  } catch {
    /* ignore */
  }
}
