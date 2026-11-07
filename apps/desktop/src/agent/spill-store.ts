/**
 * Workspace-local spill files for oversized tool output (under `.wb/spill/`).
 * Paths stay inside the bound root so `read` / `grep` can recover the full text.
 */

import {
  SPILL_CLEANUP_PERIOD_DAYS,
  joinPath,
  normalizePath,
  selectExpiredSpillFiles,
} from "@wb/domain";

export type SpillSaveResult = {
  /** Workspace-relative path using `/`. */
  locator: string;
  absolute: string;
  bytes: number;
  retrievalHint: string;
};

export type SpillCleanupResult = {
  scanned: number;
  deleted: number;
};

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "out";
}

/** Write full tool output into `<root>/.wb/spill/<name>.txt`. */
export async function saveToolSpill(input: {
  root: string;
  toolName: string;
  suggestedName?: string;
  content: string;
  callId?: string;
}): Promise<SpillSaveResult> {
  const root = normalizePath(input.root.trim());
  if (!root) throw new Error("未绑定工作区");
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const base =
    sanitizeName(input.suggestedName || "") ||
    sanitizeName(`${input.toolName}-${input.callId || stamp}`);
  const fileName = `${base}-${rand}.txt`;
  const relative = `.wb/spill/${fileName}`;
  const absolute = joinPath(root, relative);

  const { invoke } = await import("@tauri-apps/api/core");
  // Ensure parent dirs via kb_mkdir chain.
  await invoke("kb_mkdir", { path: joinPath(root, ".wb") });
  await invoke("kb_mkdir", { path: joinPath(root, ".wb/spill") });
  await invoke("kb_write_text", { path: absolute, contents: input.content });

  return {
    locator: relative.replace(/\\/g, "/"),
    absolute,
    bytes: input.content.length,
    retrievalHint: `用 read 打开 ${relative.replace(/\\/g, "/")}（可加 offset/limit），或用 grep 搜索该文件。`,
  };
}

/**
 * Delete aged spill files under `<root>/.wb/spill/`.
 * Failures are swallowed by the caller; this never throws for missing dirs.
 */
export async function cleanupToolSpill(
  root: string,
  options?: { maxAgeDays?: number; nowMs?: number },
): Promise<SpillCleanupResult> {
  const normalized = normalizePath(root.trim());
  if (!normalized) return { scanned: 0, deleted: 0 };
  const maxAgeDays = options?.maxAgeDays ?? SPILL_CLEANUP_PERIOD_DAYS;
  if (maxAgeDays <= 0) return { scanned: 0, deleted: 0 };

  const { invoke } = await import("@tauri-apps/api/core");
  const spillDir = joinPath(normalized, ".wb/spill");
  let entries: Array<{
    name: string;
    path: string;
    isDir: boolean;
    mtimeMs?: number | null;
  }> = [];
  try {
    entries = await invoke("kb_list_dir", { path: spillDir });
  } catch {
    return { scanned: 0, deleted: 0 };
  }

  const expired = selectExpiredSpillFiles(entries, {
    maxAgeDays,
    nowMs: options?.nowMs,
  });
  let deleted = 0;
  for (const entry of expired) {
    try {
      await invoke("kb_remove", { path: entry.path });
      deleted += 1;
    } catch {
      /* ignore single-file failures */
    }
  }
  return { scanned: entries.length, deleted };
}
