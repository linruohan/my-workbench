import { useMemo, useRef, useState } from "react";
import {
  cycleNoteEditorMode,
  noteEditorModeLabel,
  type Note,
  type NoteEditorMode,
} from "@wb/domain";
import { renderMarkdown } from "../lib/markdown";

type Props = {
  note: Note;
  defaultMode?: NoteEditorMode;
  onChange: (patch: { title?: string; bodyMd?: string }) => void;
  onDelete: () => void;
};

export function NoteEditor({
  note,
  defaultMode = "live",
  onChange,
  onDelete,
}: Props) {
  const [mode, setMode] = useState<NoteEditorMode>(defaultMode);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  const html = useMemo(() => renderMarkdown(note.bodyMd), [note.bodyMd]);

  const syncScroll = (from: "source" | "preview") => {
    if (mode !== "live" || syncing.current) return;
    const source = sourceRef.current;
    const preview = previewRef.current;
    if (!source || !preview) return;
    const srcMax = source.scrollHeight - source.clientHeight;
    const prevMax = preview.scrollHeight - preview.clientHeight;
    if (srcMax <= 0 || prevMax <= 0) return;
    syncing.current = true;
    if (from === "source") {
      preview.scrollTop = (source.scrollTop / srcMax) * prevMax;
    } else {
      source.scrollTop = (preview.scrollTop / prevMax) * srcMax;
    }
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  };

  return (
    <div className="note-editor">
      <header className="note-editor__toolbar">
        <input
          className="note-editor__title"
          aria-label="笔记标题"
          value={note.title}
          onChange={(e) => onChange({ title: e.target.value })}
        />
        <div className="note-editor__modes" role="group" aria-label="编辑模式">
          {(["live", "source", "preview"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={
                mode === m ? "note-editor__mode is-active" : "note-editor__mode"
              }
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {noteEditorModeLabel(m)}
            </button>
          ))}
          <button
            type="button"
            className="note-editor__mode"
            title="循环切换模式 (Ctrl+/)"
            onClick={() => setMode((m) => cycleNoteEditorMode(m))}
          >
            切换
          </button>
        </div>
        <button type="button" className="note-editor__danger" onClick={onDelete}>
          删除
        </button>
      </header>

      <div
        className={`note-editor__stage note-editor__stage--${mode}`}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key === "/") {
            e.preventDefault();
            setMode((m) => cycleNoteEditorMode(m));
          }
        }}
      >
        {mode !== "preview" ? (
          <textarea
            ref={sourceRef}
            className="note-editor__source"
            aria-label="Markdown 源码"
            spellCheck={false}
            value={note.bodyMd}
            placeholder="用 Markdown 书写… 实时模式下右侧即时预览"
            onChange={(e) => onChange({ bodyMd: e.target.value })}
            onScroll={() => syncScroll("source")}
          />
        ) : null}
        {mode !== "source" ? (
          <div
            ref={previewRef}
            className="note-editor__preview md-body"
            aria-label="预览"
            // markdown-it with html:false; content is user notes only
            dangerouslySetInnerHTML={{ __html: html }}
            onScroll={() => syncScroll("preview")}
          />
        ) : null}
      </div>
    </div>
  );
}
