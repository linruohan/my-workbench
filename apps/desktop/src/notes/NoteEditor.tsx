import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import {
  extractImageSlots,
  indentMarkdownSelection,
  joinMdBlocks,
  outdentMarkdownSelection,
  resolveImageTarget,
  safeStem,
  splitMdBlocks,
  type Note,
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
  onChange: (patch: { title?: string; bodyMd?: string }) => void;
  onDelete?: () => void;
  onSave?: () => void;
  titleReadOnly?: boolean;
  imageBaseDir?: string | null;
  imageStem?: string | null;
  onAssetSaved?: () => void;
  saveLabel?: string | null;
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

function autosize(area: HTMLTextAreaElement | null) {
  if (!area) return;
  area.style.height = "0px";
  area.style.height = `${Math.max(area.scrollHeight, 28)}px`;
}

export function NoteEditor({
  note,
  onChange,
  onDelete,
  onSave,
  titleReadOnly = false,
  imageBaseDir = null,
  imageStem = null,
  onAssetSaved,
  saveLabel = null,
}: Props) {
  const blocks = useMemo(() => splitMdBlocks(note.bodyMd), [note.bodyMd]);
  const [active, setActive] = useState<number | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const prepared = useMemo(() => extractImageSlots(note.bodyMd), [note.bodyMd]);

  const remoteUrls = useMemo(
    () =>
      prepared.slots.map((slot) => {
        const target = resolveImageTarget(slot.dest, imageBaseDir);
        return target.kind === "remote" ? target.url : null;
      }),
    [prepared, imageBaseDir],
  );
  const slotKey = remoteUrls
    .map((url, index) => url ?? prepared.slots[index]?.dest ?? "")
    .join("\0");
  const [local, setLocal] = useState<{ key: string; urls: Array<string | null> }>({
    key: "",
    urls: [],
  });
  const urls = remoteUrls.map(
    (url, index) => url ?? (local.key === slotKey ? (local.urls[index] ?? null) : null),
  );
  const urlByDest = useMemo(() => {
    const map = new Map<string, string>();
    prepared.slots.forEach((slot, index) => {
      const url = urls[index];
      if (url) map.set(slot.dest, url);
    });
    return map;
  }, [prepared, urls]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    if (remoteUrls.every((url, index) => url || !prepared.slots[index]?.dest)) return;
    let cancel = false;
    const key = slotKey;
    void (async () => {
      const next: Array<string | null> = prepared.slots.map(() => null);
      for (let index = 0; index < prepared.slots.length; index += 1) {
        if (remoteUrls[index]) continue;
        const dest = prepared.slots[index]?.dest;
        if (!dest) continue;
        next[index] = await resolveImageSrc(dest, imageBaseDir);
      }
      if (!cancel) setLocal({ key, urls: next });
    })();
    return () => {
      cancel = true;
    };
  }, [prepared, imageBaseDir, remoteUrls, slotKey]);

  useLayoutEffect(() => {
    if (active == null) return;
    const area = editRef.current;
    if (!area) return;
    area.focus();
    const caret = pendingCaret.current;
    if (caret != null) {
      const pos = Math.min(caret, area.value.length);
      area.setSelectionRange(pos, pos);
      pendingCaret.current = null;
    } else {
      const end = area.value.length;
      area.setSelectionRange(end, end);
    }
    autosize(area);
  }, [active, note.bodyMd, note.id]);

  const commitBlocks = (nextBlocks: string[], focus: number | null, caret?: number) => {
    if (caret != null) pendingCaret.current = caret;
    setActive(focus);
    onChange({ bodyMd: joinMdBlocks(nextBlocks) });
  };

  const updateActiveBlock = (text: string) => {
    if (active == null) return;
    const next = [...blocks];
    next[active] = text;
    onChange({ bodyMd: joinMdBlocks(next) });
  };

  const activate = (index: number) => {
    setActive(index);
  };

  const onEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSave?.();
      return;
    }

    const area = event.currentTarget;
    const value = area.value;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const index = active ?? 0;

    if (event.key === "Tab") {
      event.preventDefault();
      const next = event.shiftKey
        ? outdentMarkdownSelection(value, start, end)
        : indentMarkdownSelection(value, start, end);
      const nextBlocks = [...blocks];
      nextBlocks[index] = next.text;
      commitBlocks(nextBlocks, index, next.end);
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      const atEnd = start === end && end === value.length;
      const singleLine = !value.includes("\n");
      const heading = /^#{1,8}(\s|$)/.test(value);
      const image = /^(!\[[^\]]*\]\([^)]*\)|<img\b)/i.test(value.trim());
      if (atEnd && singleLine && (heading || image || value.trim() === "")) {
        event.preventDefault();
        const nextBlocks = [...blocks];
        nextBlocks.splice(index + 1, 0, "");
        commitBlocks(nextBlocks, index + 1, 0);
        return;
      }
      if (atEnd && singleLine && !/^ {0,3}(`{3,}|~{3,})/.test(value)) {
        event.preventDefault();
        const nextBlocks = [...blocks];
        nextBlocks.splice(index + 1, 0, "");
        commitBlocks(nextBlocks, index + 1, 0);
        return;
      }
    }

    if (event.key === "Backspace" && start === 0 && end === 0) {
      if (value === "" && blocks.length > 1) {
        event.preventDefault();
        const nextBlocks = blocks.filter((_, i) => i !== index);
        const focus = Math.max(0, index - 1);
        const caret = (nextBlocks[focus] ?? "").length;
        commitBlocks(nextBlocks, focus, caret);
        return;
      }
      if (index > 0) {
        event.preventDefault();
        const prev = blocks[index - 1] ?? "";
        const nextBlocks = [...blocks];
        nextBlocks[index - 1] = prev + (prev && value ? "\n" : "") + value;
        nextBlocks.splice(index, 1);
        commitBlocks(nextBlocks, index - 1, prev.length);
      }
    }

    if (event.key === "ArrowUp" && start === 0 && end === 0 && index > 0) {
      event.preventDefault();
      setActive(index - 1);
      pendingCaret.current = (blocks[index - 1] ?? "").length;
    }
    if (
      event.key === "ArrowDown" &&
      start === value.length &&
      end === value.length &&
      index < blocks.length - 1
    ) {
      event.preventDefault();
      setActive(index + 1);
      pendingCaret.current = 0;
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = clipboardImage(event.clipboardData);
    if (!file || active == null) return;
    event.preventDefault();
    const area = event.currentTarget;
    const start = area.selectionStart ?? area.value.length;
    const end = area.selectionEnd ?? start;
    const current = area.value;
    const index = active;
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
        const text = current.slice(0, start) + inserted + current.slice(end);
        const nextBlocks = [...blocks];
        nextBlocks[index] = text;
        commitBlocks(nextBlocks, index, start + inserted.length);
      } catch (err) {
        window.alert(err instanceof Error ? err.message : "粘贴图片失败");
      }
    })();
  };

  const renderBlock = (text: string) => {
    if (!text) return '<p class="md-live__blank">&nbsp;</p>';
    const { slots } = extractImageSlots(text);
    const blockUrls = slots.map((slot) => urlByDest.get(slot.dest) ?? null);
    return renderMarkdown(text, blockUrls);
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
        {saveLabel ? <span className="note-editor__save">{saveLabel}</span> : null}
        {onDelete ? (
          <button type="button" className="note-editor__danger" onClick={onDelete}>
            删除
          </button>
        ) : null}
      </header>

      <div
        className="note-editor__stage note-editor__stage--live-preview"
        aria-label="Markdown 编辑器"
      >
        <div className="md-live">
          {blocks.map((block, index) => {
            const isActive = active === index;
            if (isActive) {
              return (
                <div key={`edit-${index}`} className="md-live__block is-editing">
                  <textarea
                    ref={editRef}
                    className="md-live__source"
                    aria-label="Markdown 源码"
                    spellCheck={false}
                    value={block}
                    rows={1}
                    onChange={(e) => {
                      updateActiveBlock(e.target.value);
                      autosize(e.currentTarget);
                    }}
                    onKeyDown={onEditKeyDown}
                    onPaste={onPaste}
                    onBlur={() => {
                      // Keep editing if focus stays inside this editor.
                      requestAnimationFrame(() => {
                        const root = editRef.current?.closest(".md-live");
                        if (root && root.contains(document.activeElement)) return;
                        setActive(null);
                      });
                    }}
                  />
                </div>
              );
            }
            return (
              <div
                key={`view-${index}-${block.slice(0, 24)}`}
                className="md-live__block"
                role="button"
                tabIndex={0}
                aria-label={`编辑第 ${index + 1} 段`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  activate(index);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    activate(index);
                  }
                }}
              >
                <div
                  className="md-live__preview md-body"
                  dangerouslySetInnerHTML={{ __html: renderBlock(block) }}
                />
              </div>
            );
          })}
          <button
            type="button"
            className="md-live__trailer"
            onMouseDown={(e) => {
              e.preventDefault();
              const nextBlocks = [...blocks, ""];
              commitBlocks(nextBlocks, nextBlocks.length - 1, 0);
            }}
          >
            继续书写…
          </button>
        </div>
      </div>
    </div>
  );
}
