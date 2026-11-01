import { describe, expect, it } from "vitest";
import {
  createNoteDraft,
  cycleNoteEditorMode,
  inferNoteTitleFromBody,
  noteEditorModeLabel,
  patchNote,
} from "../src/index.js";

describe("notes", () => {
  it("creates and patches notes locally", () => {
    const note = createNoteDraft({
      title: "  周报  ",
      bodyMd: "# 周报\n内容",
      nowMs: 1000,
    });
    expect(note.title).toBe("周报");
    expect(note.id.length).toBeGreaterThan(8);
    const next = patchNote(note, { bodyMd: "更新" }, 2000);
    expect(next.bodyMd).toBe("更新");
    expect(next.updatedAt).toBe(2000);
    expect(next.createdAt).toBe(1000);
  });

  it("cycles typora-like editor modes", () => {
    expect(cycleNoteEditorMode("live")).toBe("source");
    expect(cycleNoteEditorMode("source")).toBe("preview");
    expect(cycleNoteEditorMode("preview")).toBe("live");
    expect(noteEditorModeLabel("live")).toBe("实时");
  });

  it("infers title from heading", () => {
    expect(inferNoteTitleFromBody("# 标题\n正文")).toBe("标题");
    expect(inferNoteTitleFromBody("第一行\n第二行")).toBe("第一行");
    expect(inferNoteTitleFromBody("   ")).toBe("未命名笔记");
  });
});
