import { createId } from "./id.js";
import type { Note, NoteEditorMode } from "./types.js";

export function createNoteDraft(input: {
  title?: string;
  bodyMd?: string;
  projectId?: string | null;
  nowMs?: number;
}): Note {
  const now = input.nowMs ?? Date.now();
  const title = (input.title ?? "未命名笔记").trim() || "未命名笔记";
  return {
    id: createId(now),
    projectId: input.projectId ?? null,
    title,
    bodyMd: input.bodyMd ?? "",
    createdAt: now,
    updatedAt: now,
  };
}

export function patchNote(
  note: Note,
  patch: { title?: string; bodyMd?: string; projectId?: string | null },
  nowMs = Date.now(),
): Note {
  return {
    ...note,
    title:
      patch.title !== undefined
        ? patch.title.trim() || "未命名笔记"
        : note.title,
    bodyMd: patch.bodyMd !== undefined ? patch.bodyMd : note.bodyMd,
    projectId: patch.projectId !== undefined ? patch.projectId : note.projectId,
    updatedAt: nowMs,
  };
}

export function cycleNoteEditorMode(mode: NoteEditorMode): NoteEditorMode {
  if (mode === "live") return "source";
  if (mode === "source") return "preview";
  return "live";
}

export function noteEditorModeLabel(mode: NoteEditorMode): string {
  if (mode === "live") return "实时";
  if (mode === "source") return "源码";
  return "预览";
}

/** Extract a display title from first markdown heading or first non-empty line. */
export function inferNoteTitleFromBody(bodyMd: string, fallback = "未命名笔记"): string {
  const lines = bodyMd.split(/\r?\n/);
  for (const line of lines) {
    const heading = /^#{1,8}\s+(.+)$/.exec(line.trim());
    if (heading?.[1]) return heading[1].trim().slice(0, 120);
    const plain = line.trim();
    if (plain) return plain.replace(/^[*_`>\-\s]+/, "").slice(0, 120) || fallback;
  }
  return fallback;
}
