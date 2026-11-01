import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import {
  cycleNoteEditorMode,
  extractImageSlots,
  highlightMarkdown,
  noteEditorModeLabel,
  resolveImageTarget,
  safeStem,
  type Note,
  type NoteEditorMode,
} from "@wb/domain";
import { isTauriRuntime } from "../lib/paths";
import { renderMarkdown } from "../lib/markdown";
import {
  bytesToBase64,
  clipboardFileToPngBytes,
  resolveImageSrc,
  savePastedImage,
} from "./kb-api";

type Props = {
  note: Note;
  defaultMode?: NoteEditorMode;
  onChange: (patch: { title?: string; bodyMd?: string }) => void;
  onDelete?: () => void;
  titleReadOnly?: boolean;
  /** Directory used to resolve and save images. */
  imageBaseDir?: string | null;
  imageStem?: string | null;
  onAssetSaved?: () => void;
};

function clipboardImage(data: DataTransfer | null): File | null {
  if (!data) return null;
  if (data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) return file;
      }
    }
  }
  for (const file of Array.from(data.files)) {
    if (file.type.startsWith("image/")) return file;
  }
  return null;
}

export function NoteEditor({
  note,
  defaultMode = "live",
  onChange,
  onDelete,
  titleReadOnly = false,
  imageBaseDir = null,
  imageStem = null,
  onAssetSaved,
}: Props) {
  const [mode, setMode] = useState<NoteEditorMode>(defaultMode);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const prepared = useMemo(() => extractImageSlots(note.bodyMd), [note.bodyMd]);
  const highlighted = useMemo(() => highlightMarkdown(note.bodyMd), [note.bodyMd]);
  const [urls, setUrls] = useState<Array<string | null>>([]);

  useEffect(() => {
    let cancel = false;
    const sync = prepared.slots.map((slot) => {
      const target = resolveImageTarget(slot.dest, imageBaseDir);
      return target.kind === "remote" ? target.url : null;
    });
    setUrls(sync);
    if (!isTauriRuntime()) return;
    if (sync.every((url, index) => url || !prepared.slots[index]?.dest)) return;
    void (async () => {
      const next = [...sync];
      for (let index = 0; index < prepared.slots.length; index += 1) {
        if (next[index]) continue;
        const dest = prepared.slots[index]?.dest;
        if (!dest) continue;
        next[index] = await resolveImageSrc(dest, imageBaseDir);
      }
      if (!cancel) setUrls(next);
    })();
    return () => {
      cancel = true;
    };
  }, [prepared, imageBaseDir]);

  const html = useMemo(
    () => renderMarkdown(note.bodyMd, urls),
    [note.bodyMd, urls],
  );
  const inlineImages = urls.filter((url): url is string => Boolean(url));

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

  const onSourceScroll = () => {
    const source = sourceRef.current;
    const highlight = highlightRef.current;
    if (source && highlight) {
      highlight.scrollTop = source.scrollTop;
      highlight.scrollLeft = source.scrollLeft;
    }
    syncScroll("source");
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = clipboardImage(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    const area = event.currentTarget;
    const start = area.selectionStart ?? note.bodyMd.length;
    const end = area.selectionEnd ?? start;
    const current = note.bodyMd;
    void (async () => {
      try {
        const bytes = await clipboardFileToPngBytes(file);
        let inserted: string;
        if (imageBaseDir && isTauriRuntime()) {
          const rel = await savePastedImage({
            bytes,
            parent: imageBaseDir,
            stem: safeStem(imageStem || "image"),
          });
          inserted = `![](${rel})`;
          onAssetSaved?.();
        } else {
          inserted = `![](data:image/png;base64,${bytesToBase64(bytes)})`;
        }
        onChange({ bodyMd: current.slice(0, start) + inserted + current.slice(end) });
      } catch (err) {
        window.alert(err instanceof Error ? err.message : "粘贴图片失败");
      }
    })();
  };

  return (
    <div className="note-editor">
      <header className="note-editor__toolbar">
        <input
          className="note-editor__title"
          aria-label="笔记标题"
          value={note.title}
          readOnly={titleReadOnly}
          onChange={(e) => onChange({ title: e.target.value })}
        />
        <div className="note-editor__modes" role="group" aria-label="编辑模式">
          {(["live", "source", "preview"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={mode === m ? "note-editor__mode is-active" : "note-editor__mode"}
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
        {onDelete ? (
          <button type="button" className="note-editor__danger" onClick={onDelete}>
            删除
          </button>
        ) : null}
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
          <div className="md-editor">
            <div className="md-editor__pane">
            <pre ref={highlightRef} className="md-editor__hl" aria-hidden="true">
              {highlighted.map((line, index) => (
                <span
                  key={index}
                  className={line.level ? `md-line is-h${line.level}` : "md-line"}
                >
                  {line.numberLabel ? (
                    <span className="md-num">{line.numberLabel}</span>
                  ) : null}
                  {line.segs.map((seg, segIndex) =>
                    seg.kind === "text" ? (
                      <span key={segIndex}>{seg.text}</span>
                    ) : (
                      <span key={segIndex} className={`md-k-${seg.kind}`}>
                        {seg.text}
                      </span>
                    ),
                  )}
                  {line.segs.length === 0 ? " " : null}
                </span>
              ))}
            </pre>
            <textarea
              ref={sourceRef}
              className="note-editor__source md-editor__input"
              aria-label="Markdown 源码"
              spellCheck={false}
              value={note.bodyMd}
              placeholder="用 Markdown 书写… 支持标题、图片和粘贴截图"
              onChange={(e) => onChange({ bodyMd: e.target.value })}
              onScroll={onSourceScroll}
              onPaste={onPaste}
            />
            </div>
            {mode === "source" && inlineImages.length > 0 ? (
              <div className="md-inline-images" aria-label="文中图片">
                {inlineImages.map((url, index) => (
                  <img key={index} src={url} alt="" />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {mode !== "source" ? (
          <div
            ref={previewRef}
            className="note-editor__preview md-body"
            aria-label="预览"
            dangerouslySetInnerHTML={{ __html: html }}
            onScroll={() => syncScroll("preview")}
          />
        ) : null}
      </div>
    </div>
  );
}
