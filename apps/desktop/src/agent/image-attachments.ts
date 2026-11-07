/**
 * Session-scoped image attachment store (light DSH attachments for read_image).
 * In-memory refs plus optional disk persistence under the app data dir.
 */

import type { ImageOffloadItem } from "@wb/domain";
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

export type PendingImagesTake = {
  dataUrls: string[];
  attached: Array<{ id: string; path: string; name?: string }>;
  offloaded: ImageOffloadItem[];
};

const byThread = new Map<string, StoredImageAttachment[]>();
const pendingByThread = new Map<string, string[]>();

const MAX_PER_THREAD = 24;
/** Cap how many pending images ride the next model request. */
export const PENDING_IMAGE_MAX_COUNT = 4;
/** Rough total data-URL budget for one vision turn. */
export const PENDING_IMAGE_MAX_BYTES = 12 * 1024 * 1024;

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

/**
 * Drain pending vision attachments for one model request.
 * Keeps the newest images within count/byte budget; older ones stay in the
 * attachment store and are reported as offloaded so the model can read_image again.
 */
export function takePendingImages(threadId: string): PendingImagesTake {
  const pending = pendingByThread.get(threadId) ?? [];
  pendingByThread.set(threadId, []);
  const list = byThread.get(threadId) ?? [];
  const byId = new Map(list.map((item) => [item.id, item]));
  const queued: StoredImageAttachment[] = [];
  for (const id of pending) {
    const hit = byId.get(id);
    if (hit?.dataUrl) queued.push(hit);
  }
  const selected: StoredImageAttachment[] = [];
  const offloaded: ImageOffloadItem[] = [];
  let bytes = 0;
  for (let i = queued.length - 1; i >= 0; i -= 1) {
    const hit = queued[i]!;
    const size = estimateDataUrlBytes(hit.dataUrl);
    if (selected.length >= PENDING_IMAGE_MAX_COUNT) {
      offloaded.unshift({
        id: hit.id,
        path: hit.path,
        name: hit.name,
        reason: "count",
      });
      continue;
    }
    if (selected.length > 0 && bytes + size > PENDING_IMAGE_MAX_BYTES) {
      offloaded.unshift({
        id: hit.id,
        path: hit.path,
        name: hit.name,
        reason: "bytes",
      });
      continue;
    }
    selected.unshift(hit);
    bytes += size;
  }
  return {
    dataUrls: selected.map((item) => item.dataUrl),
    attached: selected.map((item) => ({
      id: item.id,
      path: item.path,
      name: item.name,
    })),
    offloaded,
  };
}

/** Data URLs queued since the last model request; clears the pending queue. */
export function takePendingImageDataUrls(threadId: string): string[] {
  return takePendingImages(threadId).dataUrls;
}

function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return dataUrl.length;
  return Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
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
