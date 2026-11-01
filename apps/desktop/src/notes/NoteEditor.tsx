import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  BG_COLOR_PRESETS,
  TEXT_COLOR_PRESETS,
  applyHeadingNumbers,
  blockDocOffset,
  cutSelectedLines,
  dedupeSelectedLines,
  extractImageSlots,
  findAllMatches,
  findNextMatch,
  indentMarkdownSelection,
  isCompleteFenceBlock,
  joinMdBlocks,
  locateInBlocks,
  normalizeMdBlocks,
  outdentMarkdownSelection,
  replaceAllMatches,
  replaceMatchWithQuery,
  resolveImageTarget,
  safeStem,
  sortSelectedLines,
  splitMdBlocks,
  styleMarkdownSelection,
  wrapMarkdownSelection,
  type InlineStyleKind,
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
import { FindReplaceBar, type FindReplaceState } from "./FindReplaceBar";

const DEFAULT_FIND: FindReplaceState = {
  query: "",
  replace: "",
  regex: false,
  matchCase: false,
  wholeWord: false,
  inSelection: false,
  preserveCase: false,
};

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
  const [blocks, setBlocks] = useState(() => splitMdBlocks(note.bodyMd));
  const [active, setActive] = useState<number | null>(null);
  const [colorMenu, setColorMenu] = useState<"color" | "background" | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [find, setFind] = useState<FindReplaceState>(DEFAULT_FIND);
  const [findStatus, setFindStatus] = useState<string | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);
  const selectionScope = useRef<{ start: number; end: number } | null>(null);
  const findFrom = useRef(0);
  const noteIdRef = useRef(note.id);
  const prepared = useMemo(() => extractImageSlots(note.bodyMd), [note.bodyMd]);

  // Keep a stable block list while editing so fence edits do not re-split into empty blocks.
  useEffect(() => {
    if (noteIdRef.current !== note.id) {
      noteIdRef.current = note.id;
      setActive(null);
      setBlocks(splitMdBlocks(note.bodyMd));
      return;
    }
    if (active == null) {
      setBlocks(splitMdBlocks(note.bodyMd));
    }
  }, [note.bodyMd, note.id, active]);

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
    if (!findOpen) area.focus();
    const range = pendingSelection.current;
    if (range) {
      const start = Math.min(range.start, area.value.length);
      const end = Math.min(range.end, area.value.length);
      area.setSelectionRange(start, end);
      pendingSelection.current = null;
      pendingCaret.current = null;
    } else {
      const caret = pendingCaret.current;
      if (caret != null) {
        const pos = Math.min(caret, area.value.length);
        area.setSelectionRange(pos, pos);
        pendingCaret.current = null;
      }
    }
    autosize(area);
  }, [active, blocks, note.id, findOpen]);

  const commitBody = (body: string, focus: number | null, caret?: number) => {
    const numbered = applyHeadingNumbers(body);
    const normalized = normalizeMdBlocks(splitMdBlocks(numbered));
    if (caret != null) pendingCaret.current = caret;
    setBlocks(normalized);
    setActive(focus);
    onChange({ bodyMd: joinMdBlocks(normalized) });
  };

  const commitBlocks = (nextBlocks: string[], focus: number | null, caret?: number) => {
    commitBody(joinMdBlocks(normalizeMdBlocks(nextBlocks)), focus, caret);
  };

  const docText = () => joinMdBlocks(blocks);

  const captureScope = () => {
    if (active == null || !editRef.current) return selectionScope.current;
    const area = editRef.current;
    if (area.selectionEnd > area.selectionStart) {
      const base = blockDocOffset(blocks, active);
      selectionScope.current = {
        start: base + area.selectionStart,
        end: base + area.selectionEnd,
      };
    }
    return selectionScope.current;
  };

  const revealDocRange = (docStart: number, docEnd: number, nextBlocks = blocks) => {
    const located = locateInBlocks(nextBlocks, docStart);
    const endAt = locateInBlocks(nextBlocks, docEnd);
    const endLocal =
      endAt.index === located.index
        ? endAt.offset
        : (nextBlocks[located.index] ?? "").length;
    pendingSelection.current = { start: located.offset, end: endLocal };
    findFrom.current = docEnd;
    setBlocks(nextBlocks);
    if (active === located.index && editRef.current) {
      const area = editRef.current;
      area.focus();
      area.setSelectionRange(located.offset, endLocal);
      pendingSelection.current = null;
      autosize(area);
    } else {
      setActive(located.index);
    }
  };

  const findOptions = () => {
    const scope = find.inSelection ? captureScope() : null;
    return {
      query: find.query,
      replace: find.replace,
      regex: find.regex,
      matchCase: find.matchCase,
      wholeWord: find.wholeWord,
      preserveCase: find.preserveCase,
      inSelection: Boolean(find.inSelection && scope),
      selectionStart: scope?.start,
      selectionEnd: scope?.end,
    };
  };

  const openFind = (prefill = true) => {
    if (prefill && active != null && editRef.current) {
      const area = editRef.current;
      if (area.selectionEnd > area.selectionStart) {
        const selected = area.value.slice(area.selectionStart, area.selectionEnd);
        if (!selected.includes("\n")) {
          setFind((prev) => ({ ...prev, query: selected }));
        } else {
          captureScope();
          setFind((prev) => ({ ...prev, inSelection: true }));
        }
      }
    }
    setFindStatus(null);
    setFindOpen(true);
  };

  const runFind = (reverse = false) => {
    if (!find.query) {
      setFindStatus("输入查找内容");
      return;
    }
    const text = docText();
    const from = reverse ? Math.max(0, findFrom.current - 1) : findFrom.current;
    const match = findNextMatch(text, findOptions(), from, reverse);
    if (!match) {
      setFindStatus("未找到");
      return;
    }
    // Wrap: if we got a match before cursor while going forward, status optional.
    setFindStatus(null);
    revealDocRange(match.start, match.end);
  };

  const runFindAll = () => {
    if (!find.query) {
      setFindStatus("输入查找内容");
      return;
    }
    const matches = findAllMatches(docText(), findOptions());
    if (matches.length === 0) {
      setFindStatus("未找到");
      return;
    }
    setFindStatus(`${matches.length} 处`);
    const first = matches[0]!;
    revealDocRange(first.start, first.end);
  };

  const runReplace = () => {
    if (!find.query) return;
    const text = docText();
    const opts = findOptions();
    // Replace current selection if it is already a match; otherwise find next.
    let match = findNextMatch(text, opts, findFrom.current);
    if (active != null && editRef.current) {
      const base = blockDocOffset(blocks, active);
      const selStart = base + editRef.current.selectionStart;
      const selEnd = base + editRef.current.selectionEnd;
      const current = findAllMatches(text, opts).find(
        (m) => m.start === selStart && m.end === selEnd,
      );
      if (current) match = current;
      else match = findNextMatch(text, opts, selStart);
    }
    if (!match) {
      setFindStatus("未找到");
      return;
    }
    const next = replaceMatchWithQuery(text, match, find.query, find.replace, opts);
    const nextBlocks = splitMdBlocks(next.text);
    onChange({ bodyMd: next.text });
    setBlocks(nextBlocks);
    revealDocRange(next.start, next.end, nextBlocks);
    findFrom.current = next.end;
    setFindStatus(null);
  };

  const runReplaceAll = () => {
    if (!find.query) return;
    const result = replaceAllMatches(docText(), {
      ...findOptions(),
      replace: find.replace,
    });
    if (result.count === 0) {
      setFindStatus("未找到");
      return;
    }
    const nextBlocks = splitMdBlocks(result.text);
    setBlocks(nextBlocks);
    setActive(null);
    onChange({ bodyMd: result.text });
    setFindStatus(`已替换 ${result.count} 处`);
    if (find.inSelection && selectionScope.current) {
      // Selection span may shrink; clear stale scope.
      selectionScope.current = null;
      setFind((prev) => ({ ...prev, inSelection: false }));
    }
  };

  const applyLineEdit = (
    edit: (
      text: string,
      start: number,
      end: number,
    ) => { text: string; start: number; end: number; cut?: string },
  ) => {
    if (active == null) return;
    const area = editRef.current;
    if (!area) return;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const next = edit(blocks[active] ?? "", start, end);
    if (next.cut != null) {
      void navigator.clipboard?.writeText(next.cut).catch(() => undefined);
    }
    const nextBlocks = [...blocks];
    nextBlocks[active] = next.text;
    commitBlocks(nextBlocks, active, undefined);
    pendingSelection.current = { start: next.start, end: next.end };
    requestAnimationFrame(() => {
      const el = editRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.start, next.end);
      autosize(el);
    });
  };

  useEffect(() => {
    if (!findOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setFindOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [findOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const target = event.target as HTMLElement | null;
      const inEditor = rootRef.current?.contains(target ?? null);
      if (!inEditor) return;
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        openFind(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // openFind closes over latest active/blocks via refs/state at call time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, blocks]);

  const updateActiveBlock = (text: string) => {
    if (active == null) return;
    const next = [...blocks];
    next[active] = text;
    setBlocks(next);
    onChange({ bodyMd: joinMdBlocks(next) });
  };

  const finishEditing = () => {
    if (active == null) return;
    if (findOpen) return;
    const normalized = normalizeMdBlocks(blocks);
    setBlocks(normalized);
    setActive(null);
    setColorMenu(null);
    onChange({ bodyMd: joinMdBlocks(normalized) });
  };

  const activate = (index: number) => {
    let list = blocks;
    if (active != null) {
      list = normalizeMdBlocks(blocks);
      setBlocks(list);
      onChange({ bodyMd: joinMdBlocks(list) });
    }
    const target = blocks[index];
    let next = Math.min(index, Math.max(0, list.length - 1));
    if (target !== undefined) {
      const found = list.findIndex((block) => block === target);
      if (found >= 0) next = found;
    }
    setActive(next);
  };

  const applyWrap = (prefix: string, suffix = prefix) => {
    if (active == null) return;
    const area = editRef.current;
    if (!area) return;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const next = wrapMarkdownSelection(blocks[active] ?? "", start, end, prefix, suffix);
    const nextBlocks = [...blocks];
    nextBlocks[active] = next.text;
    commitBlocks(nextBlocks, active, undefined);
    pendingCaret.current = null;
    requestAnimationFrame(() => {
      const el = editRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.start, next.end);
      autosize(el);
    });
  };

  const applyStyle = (kind: InlineStyleKind, color: string | null) => {
    if (active == null) return;
    const area = editRef.current;
    if (!area) return;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    if (start === end) {
      setColorMenu(null);
      return;
    }
    const next = styleMarkdownSelection(
      blocks[active] ?? "",
      start,
      end,
      kind,
      color,
    );
    const nextBlocks = [...blocks];
    nextBlocks[active] = next.text;
    commitBlocks(nextBlocks, active, undefined);
    pendingCaret.current = null;
    setColorMenu(null);
    requestAnimationFrame(() => {
      const el = editRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.start, next.end);
      autosize(el);
    });
  };

  const onEditKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSave?.();
      return;
    }
    if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFind(true);
      return;
    }
    if (mod && event.key.toLowerCase() === "b") {
      event.preventDefault();
      applyWrap("**");
      return;
    }
    if (mod && event.key.toLowerCase() === "i") {
      event.preventDefault();
      applyWrap("*");
      return;
    }
    if (mod && event.key.toLowerCase() === "u") {
      event.preventDefault();
      applyWrap("++");
      return;
    }
    if (mod && event.key.toLowerCase() === "h") {
      event.preventDefault();
      applyWrap("==");
      return;
    }
    if (mod && event.key === "`") {
      event.preventDefault();
      applyWrap("`");
      return;
    }
    if (mod && event.shiftKey && event.key.toLowerCase() === "x") {
      event.preventDefault();
      applyWrap("~~");
      return;
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === "x") {
      event.preventDefault();
      applyLineEdit(cutSelectedLines);
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
      // Finished code fence: create the next block instead of trailing blank lines.
      if (atEnd && isCompleteFenceBlock(value)) {
        event.preventDefault();
        const nextBlocks = [...blocks];
        nextBlocks[index] = value;
        nextBlocks.splice(index + 1, 0, "");
        commitBlocks(nextBlocks, index + 1, 0);
        return;
      }
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
      activate(index - 1);
      pendingCaret.current = (blocks[index - 1] ?? "").length;
    }
    if (
      event.key === "ArrowDown" &&
      start === value.length &&
      end === value.length &&
      index < blocks.length - 1
    ) {
      event.preventDefault();
      activate(index + 1);
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
    <div className="note-editor" ref={rootRef}>
      <header className="note-editor__toolbar">
        <input
          className="note-editor__title"
          aria-label="笔记标题"
          value={note.title}
          readOnly={titleReadOnly}
          onChange={(e) => onChange({ title: e.target.value })}
        />
        {saveLabel ? <span className="note-editor__save">{saveLabel}</span> : null}
        <div className="note-editor__shortcuts" role="group" aria-label="格式快捷">
          <button type="button" title="加粗 Ctrl+B" onClick={() => applyWrap("**")}>
            B
          </button>
          <button type="button" title="斜体 Ctrl+I" onClick={() => applyWrap("*")}>
            I
          </button>
          <button type="button" title="高亮背景 Ctrl+H" onClick={() => applyWrap("==")}>
            高亮
          </button>
          <button type="button" title="下划线 Ctrl+U" onClick={() => applyWrap("++")}>
            U
          </button>
          <button type="button" title="行内代码 Ctrl+`" onClick={() => applyWrap("`")}>
            {"</>"}
          </button>
          <button
            type="button"
            title="删除线 Ctrl+Shift+X"
            onClick={() => applyWrap("~~")}
          >
            S
          </button>
          <button
            type="button"
            title="删除行 Ctrl+X"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyLineEdit(cutSelectedLines)}
          >
            删行
          </button>
          <button
            type="button"
            title="选中行排序"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyLineEdit(sortSelectedLines)}
          >
            排序
          </button>
          <button
            type="button"
            title="选中行去重"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyLineEdit(dedupeSelectedLines)}
          >
            去重
          </button>
          <button
            type="button"
            title="查找替换 Ctrl+F"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => openFind(true)}
          >
            查找
          </button>
          <div className="note-editor__swatch">
            <button
              type="button"
              className="note-editor__swatch-btn"
              title="文字颜色"
              aria-expanded={colorMenu === "color"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                setColorMenu((open) => (open === "color" ? null : "color"))
              }
            >
              <span className="note-editor__swatch-letter" style={{ color: "#e11d48" }}>
                A
              </span>
              <span className="note-editor__swatch-bar" style={{ background: "#e11d48" }} />
            </button>
            {colorMenu === "color" ? (
              <div className="note-editor__palette" role="listbox" aria-label="文字颜色">
                {TEXT_COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    role="option"
                    title={preset.label}
                    className={
                      preset.value
                        ? "note-editor__palette-chip"
                        : "note-editor__palette-chip is-clear"
                    }
                    style={preset.value ? { background: preset.value } : undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyStyle("color", preset.value)}
                  >
                    {preset.value ? null : "无"}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="note-editor__swatch">
            <button
              type="button"
              className="note-editor__swatch-btn"
              title="文字背景色"
              aria-expanded={colorMenu === "background"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                setColorMenu((open) => (open === "background" ? null : "background"))
              }
            >
              <span
                className="note-editor__swatch-letter note-editor__swatch-letter--bg"
                style={{ background: "#fef08a" }}
              >
                A
              </span>
              <span className="note-editor__swatch-bar" style={{ background: "#fef08a" }} />
            </button>
            {colorMenu === "background" ? (
              <div className="note-editor__palette" role="listbox" aria-label="文字背景色">
                {BG_COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    role="option"
                    title={preset.label}
                    className={
                      preset.value
                        ? "note-editor__palette-chip"
                        : "note-editor__palette-chip is-clear"
                    }
                    style={preset.value ? { background: preset.value } : undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyStyle("background", preset.value)}
                  >
                    {preset.value ? null : "无"}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        {onDelete ? (
          <button type="button" className="note-editor__danger" onClick={onDelete}>
            删除
          </button>
        ) : null}
      </header>

      <FindReplaceBar
        open={findOpen}
        value={find}
        status={findStatus}
        onChange={(patch) => {
          if (patch.inSelection) captureScope();
          setFind((prev) => ({ ...prev, ...patch }));
          setFindStatus(null);
        }}
        onClose={() => setFindOpen(false)}
        onFind={runFind}
        onFindAll={runFindAll}
        onReplace={runReplace}
        onReplaceAll={runReplaceAll}
      />

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
                      requestAnimationFrame(() => {
                        const root = rootRef.current;
                        if (root && root.contains(document.activeElement)) return;
                        finishEditing();
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
