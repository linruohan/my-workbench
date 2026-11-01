import {
  fileNameOf,
  imageMime,
  isIgnoredKbName,
  joinPath,
  nestedImageDirs,
  parentDir,
  pastedImageRel,
  resolveImageTarget,
} from "@wb/domain";
import { isTauriRuntime, resolveDataDir } from "../lib/paths";

export type KbEntry = {
  name: string;
  path: string;
  isDir: boolean;
};

const ROOTS_KEY = "wb.kb.roots.v1";
const imageCache = new Map<string, string>();

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
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

export async function pickDirectory(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  return call<string | null>("kb_pick_directory");
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
