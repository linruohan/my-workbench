import {
  fileNameOf,
  imageMime,
  isIgnoredKbName,
  joinPath,
  nestedImageDirs,
  parentDir,
  pastedImageRel,
  resolveImageTarget,
  samePath,
} from "@wb/domain";
import { errorMessage } from "../lib/errors";
import { isTauriRuntime, resolveDataDir } from "../lib/paths";

export type KbEntry = {
  name: string;
  path: string;
  isDir: boolean;
  mtimeMs?: number | null;
};

export type KbSortKey = "name" | "mtime" | "type";
export type KbSortDir = "asc" | "desc";

const ROOTS_KEY = "wb.kb.roots.v1";
const RECENT_KEY = "wb.kb.recent.v1";
const ACTIVE_ROOT_KEY = "wb.kb.activeRoot.v1";
const SORT_KEY = "wb.kb.sort.v1";
const imageCache = new Map<string, string>();

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw new Error(errorMessage(err, `调用 ${command} 失败`));
  }
}

export function loadKnowledgeRoots(): string[] {
  try {
    const raw = localStorage.getItem(ROOTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
  } catch {
    return [];
  }
}

export function saveKnowledgeRoots(roots: string[]): void {
  localStorage.setItem(ROOTS_KEY, JSON.stringify(roots));
}

export function loadActiveKnowledgeRoot(roots: string[]): string | null {
  try {
    const raw = localStorage.getItem(ACTIVE_ROOT_KEY);
    if (typeof raw === "string" && raw && roots.some((r) => samePath(r, raw))) {
      return roots.find((r) => samePath(r, raw)) ?? raw;
    }
  } catch {
    /* ignore */
  }
  return roots[0] ?? null;
}

export function saveActiveKnowledgeRoot(path: string | null): void {
  if (!path) {
    localStorage.removeItem(ACTIVE_ROOT_KEY);
    return;
  }
  localStorage.setItem(ACTIVE_ROOT_KEY, path);
}

export function loadRecentKnowledgeRoots(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
  } catch {
    return [];
  }
}

export function pushRecentKnowledgeRoot(path: string, limit = 8): string[] {
  const prev = loadRecentKnowledgeRoots().filter((item) => !samePath(item, path));
  const next = [path, ...prev].slice(0, limit);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  return next;
}

export function loadKnowledgeSort(): { key: KbSortKey; dir: KbSortDir } {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (
      parsed &&
      typeof parsed === "object" &&
      "key" in parsed &&
      "dir" in parsed
    ) {
      const key = (parsed as { key: string }).key;
      const dir = (parsed as { dir: string }).dir;
      if (
        (key === "name" || key === "mtime" || key === "type") &&
        (dir === "asc" || dir === "desc")
      ) {
        return { key, dir };
      }
    }
  } catch {
    /* ignore */
  }
  return { key: "name", dir: "asc" };
}

export function saveKnowledgeSort(key: KbSortKey, dir: KbSortDir): void {
  localStorage.setItem(SORT_KEY, JSON.stringify({ key, dir }));
}

export async function pickDirectory(title = "选择文件夹"): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  return call<string | null>("kb_pick_directory", { title });
}

/** Current git branch for a folder, or null when not a repo / unavailable. */
export async function readGitBranch(path: string): Promise<string | null> {
  if (!isTauriRuntime() || !path.trim()) return null;
  try {
    return await call<string | null>("kb_git_branch", { path });
  } catch {
    return null;
  }
}

export async function revealInExplorer(path: string): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("在资源管理器中显示需要在桌面应用中使用。");
  }
  await call("kb_reveal_in_explorer", { path });
}

export async function listDirectory(path: string): Promise<KbEntry[]> {
  return call<KbEntry[]>("kb_list_dir", { path });
}

/** Recursively list files under imported knowledge roots (skips ignored dirs). */
export async function listFilesRecursive(
  roots: string[],
  maxFiles = 8000,
): Promise<KbEntry[]> {
  const out: KbEntry[] = [];
  const walk = async (dir: string) => {
    if (out.length >= maxFiles) return;
    let entries: KbEntry[] = [];
    try {
      entries = await listDirectory(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.isDir) {
        if (isIgnoredKbName(entry.name)) continue;
        await walk(entry.path);
        continue;
      }
      if (isIgnoredKbName(entry.name)) continue;
      out.push(entry);
    }
  };
  for (const root of roots) {
    if (out.length >= maxFiles) break;
    await walk(root);
  }
  return out;
}

export async function readTextFile(path: string): Promise<string> {
  return call<string>("kb_read_text", { path });
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  await call("kb_write_text", { path, contents });
}

export async function kbExists(path: string): Promise<boolean> {
  return call<boolean>("kb_exists", { path });
}

export async function kbMkdir(path: string): Promise<void> {
  await call("kb_mkdir", { path });
}

export async function renameKbPath(from: string, to: string): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("重命名文件需要在桌面应用中使用。");
  }
  await call("kb_rename", { from, to });
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, i + size));
  }
  return btoa(binary);
}

export async function readImageDataUrl(path: string): Promise<string> {
  const cached = imageCache.get(path);
  if (cached) return cached;
  const data = await call<string>("kb_read_base64", { path });
  const url = `data:${imageMime(path)};base64,${data}`;
  imageCache.set(path, url);
  return url;
}

export async function ensureNoteAssetDir(noteId: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { join } = await import("@tauri-apps/api/path");
  const dir = await join(await resolveDataDir(), "kb-assets", noteId);
  await kbMkdir(dir);
  return dir;
}

export async function savePastedImage(input: {
  bytes: Uint8Array;
  parent: string;
  stem: string;
}): Promise<string> {
  const encoded = bytesToBase64(input.bytes);
  for (let index = 0; index < 10000; index += 1) {
    const rel = pastedImageRel(input.stem, index);
    const abs = joinPath(input.parent, rel);
    if (await kbExists(abs)) continue;
    await kbMkdir(parentDir(abs));
    await call("kb_write_base64", { path: abs, data: encoded });
    imageCache.delete(abs);
    return rel;
  }
  throw new Error("无法分配图片文件名");
}

export async function clipboardFileToPngBytes(file: File): Promise<Uint8Array> {
  if (file.type === "image/png" || file.type === "") {
    return new Uint8Array(await file.arrayBuffer());
  }
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法读取剪贴板图片");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error("无法把图片转成 PNG"))),
      "image/png",
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Resolve one image destination to a browser-loadable URL. */
export async function resolveImageSrc(
  dest: string,
  baseDir: string | null,
): Promise<string | null> {
  const target = resolveImageTarget(dest, baseDir);
  if (target.kind === "remote") return target.url;
  if (!isTauriRuntime()) return null;

  for (const candidate of target.candidates) {
    if (!(await kbExists(candidate))) continue;
    return readImageDataUrl(candidate);
  }

  if (!baseDir) return null;
  const name = fileNameOf(dest);
  if (!name || name === "." || name === "..") return null;
  const found: string[] = [];
  for (const dir of nestedImageDirs(baseDir)) {
    let entries: KbEntry[] = [];
    try {
      entries = await listDirectory(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDir) continue;
      const candidate = joinPath(entry.path, `imgs/${name}`);
      if (await kbExists(candidate)) found.push(candidate);
      if (found.length > 1) return null;
    }
  }
  const only = found[0];
  if (!only) return null;
  return readImageDataUrl(only);
}
