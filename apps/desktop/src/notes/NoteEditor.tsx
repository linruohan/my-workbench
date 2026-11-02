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
  blockLineCount,
  countDocLines,
  adjustSnippetStops,
  cutSelectedLines,
  dedupeSelectedLines,
  expandGithubMdSnippet,
  extractImageSlots,
  findAllMatches,
  findNextMatch,
  indentMarkdownSelection,
  isCompleteFenceBlock,
  isTableLine,
  joinMdBlocks,
  locateInBlocks,
  locateLineInBlocks,
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
  type MdSnippetRange,
  type Note,
} from "@wb/domain";
import { isTauriRuntime } from "../lib/paths";
import { copyCodeBlock } from "../lib/code-copy";
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

function rowMinHeightPx(area: HTMLTextAreaElement): number {
  const styles = window.getComputedStyle(area.parentElement?.closest(".md-live") ?? area);
  const size = Number.parseFloat(styles.getPropertyValue("--md-live-size")) || 16;
  const line = Number.parseFloat(styles.getPropertyValue("--md-live-line")) || 1.75;
  const padY = Number.parseFloat(styles.getPropertyValue("--md-live-pad-y")) || 4;
  return Math.ceil(size * line + 2 * padY);
}

function autosize(area: HTMLTextAreaElement | null, opts?: { force?: boolean }) {
  if (!area) return;
  const row = rowMinHeightPx(area);
  // Empty line: lock to one shared row height (edit == preview gap).
  // Always clear a prior editMinHeight lock — min-height can defeat max-height.
  if (!area.value) {
    area.style.height = `${row}px`;
    area.style.minHeight = `${row}px`;
    area.style.maxHeight = `${row}px`;
    return;
  }
  area.style.maxHeight = "";
  const current = area.offsetHeight;
  area.style.height = "auto";
  const needed = Math.max(area.scrollHeight, row);
  if (!opts?.force && Math.abs(needed - current) <= 1) {
    area.style.height = `${current}px`;
    return;
  }
  area.style.height = `${needed}px`;
}

function isFenceSource(text: string): boolean {
  return /^ {0,3}(`{3,}|~{3,})/.test(text);
}

/** Caret line metrics inside a textarea value (for leaving the block at edges). */
function caretLineInfo(text: string, pos: number) {
  const lineStart = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const nextNl = text.indexOf("\n", pos);
  const col = pos - lineStart;
  return {
    col,
    isFirstLine: lineStart === 0,
    isLastLine: nextNl === -1,
  };
}

function caretOnLastLine(text: string, col: number): number {
  const lastNl = text.lastIndexOf("\n");
  const lineStart = lastNl + 1;
  const lineLen = text.length - lineStart;
  return lineStart + Math.min(Math.max(0, col), lineLen);
}

function caretOnFirstLine(text: string, col: number): number {
  const firstNl = text.indexOf("\n");
  const lineLen = firstNl === -1 ? text.length : firstNl;
  return Math.min(Math.max(0, col), lineLen);
}

let measureCtx: CanvasRenderingContext2D | null = null;

function textWidth(text: string, font: string): number {
  if (!measureCtx) {
    const canvas = document.createElement("canvas");
    measureCtx = canvas.getContext("2d");
  }
  if (!measureCtx) return text.length * 8;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

function caretFromDomPoint(
  source: string,
  clientX: number,
  clientY: number,
): number | null {
  type CaretPos = { offsetNode: Node; offset: number };
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => CaretPos | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(clientX, clientY);
    if (!pos) return null;
    node = pos.offsetNode;
    offset = pos.offset;
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(clientX, clientY);
    if (!range) return null;
    node = range.startContainer;
    offset = range.startOffset;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const piece = node.textContent ?? "";
  if (!piece) return source.length > 0 ? null : 0;
  const before = piece.slice(0, Math.min(offset, piece.length));
  // Prefer the occurrence nearest the full text node content.
  let found = source.indexOf(piece);
  if (found < 0) found = source.indexOf(before);
  if (found < 0) {
    const trimmed = piece.trim();
    if (!trimmed) return null;
    found = source.indexOf(trimmed);
    if (found < 0) return null;
    return Math.min(found + Math.min(offset, trimmed.length), source.length);
  }
  return Math.min(found + before.length, source.length);
}

/** Map a mouse click on the preview to a caret index in the markdown source. */
function caretIndexFromClick(
  source: string,
  clientX: number,
  clientY: number,
  el: HTMLElement,
): number {
  if (!source) return 0;
  const fromDom = caretFromDomPoint(source, clientX, clientY);
  if (fromDom != null) return fromDom;

  const style = window.getComputedStyle(el);
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const lineHeight =
    Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.75;
  const padX = Number.parseFloat(style.paddingLeft) || 0;
  const padY = Number.parseFloat(style.paddingTop) || 0;
  const rect = el.getBoundingClientRect();
  const x = Math.max(0, clientX - rect.left - padX);
  const y = Math.max(0, clientY - rect.top - padY);
  const lines = source.split("\n");
  const lineIndex = Math.min(Math.max(0, Math.floor(y / lineHeight)), lines.length - 1);
  let offset = 0;
  for (let i = 0; i < lineIndex; i += 1) offset += (lines[i] ?? "").length + 1;
  const line = lines[lineIndex] ?? "";
  if (!line) return offset;
  let lo = 0;
  let hi = line.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(line.slice(0, mid), font) <= x) lo = mid;
    else hi = mid - 1;
  }
  // Snap to nearer edge between lo and lo+1.
  if (lo < line.length) {
    const left = textWidth(line.slice(0, lo), font);
    const right = textWidth(line.slice(0, lo + 1), font);
    if (x - left > right - x) lo += 1;
  }
  return offset + lo;
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
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoValue, setGotoValue] = useState("1");
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const gotoRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);
  const selectionScope = useRef<{ start: number; end: number } | null>(null);
  const suppressBlur = useRef(false);
  const editMinHeight = useRef<number | null>(null);
  const snippetStops = useRef<MdSnippetRange[] | null>(null);
  const snippetStopIndex = useRef(0);
  const lastEditSel = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  const findFrom = useRef(0);
  const gPending = useRef(false);
  const gTimer = useRef<number | null>(null);
  const noteIdRef = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const prepared = useMemo(() => extractImageSlots(note.bodyMd), [note.bodyMd]);
  const lineStarts = useMemo(() => {
    const starts: number[] = [];
    let line = 1;
    for (const block of blocks) {
      starts.push(line);
      line += blockLineCount(block);
    }
    return starts;
  }, [blocks]);

  // Keep a stable block list while editing so fence edits do not re-split into empty blocks.
  useEffect(() => {
    if (noteIdRef.current !== note.id) {
      noteIdRef.current = note.id;
      setActive(null);
      const numbered = applyHeadingNumbers(note.bodyMd);
      const next = normalizeMdBlocks(splitMdBlocks(numbered));
      setBlocks(next);
      const body = joinMdBlocks(next);
      if (body !== note.bodyMd) onChangeRef.current({ bodyMd: body });
      return;
    }
    if (active == null) {
      setBlocks(normalizeMdBlocks(splitMdBlocks(note.bodyMd)));
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

  // Only re-focus / place caret when the active block changes — not on every keystroke.
  // (Depending on `blocks` re-ran autosize→height:0 and caused the editor to jitter.)
  useLayoutEffect(() => {
    if (active == null) return;
    const area = editRef.current;
    if (!area) return;
    // Empty rows always use the shared --md-live-row; never inherit a taller lock.
    if (editMinHeight.current != null && area.value) {
      area.style.minHeight = `${editMinHeight.current}px`;
    }
    editMinHeight.current = null;
    autosize(area, { force: true });
    if (findOpen) return;
    area.focus({ preventScroll: true });
    const range = pendingSelection.current;
    if (range) {
      const start = Math.min(range.start, area.value.length);
      const end = Math.min(range.end, area.value.length);
      area.setSelectionRange(start, end);
      pendingSelection.current = null;
      pendingCaret.current = null;
      return;
    }
    const caret = pendingCaret.current;
    if (caret != null) {
      const pos = Math.min(Math.max(0, caret), area.value.length);
      area.setSelectionRange(pos, pos);
      pendingCaret.current = null;
    } else {
      const pos = Math.min(area.selectionStart, area.value.length);
      area.setSelectionRange(pos, pos);
    }
  }, [active, note.id, findOpen]);

  const commitBlocks = (nextBlocks: string[], focus: number | null, caret?: number) => {
    const normalized = normalizeMdBlocks(nextBlocks);
    if (caret != null) pendingCaret.current = caret;
    setBlocks(normalized);
    setActive(focus);
    onChange({ bodyMd: joinMdBlocks(normalized) });
  };

  /** Sync outline numbers into source when leaving edit (keeps render free of CSS counters). */
  const commitNumbered = (nextBlocks: string[], focus: number | null) => {
    const numbered = applyHeadingNumbers(joinMdBlocks(normalizeMdBlocks(nextBlocks)));
    const normalized = normalizeMdBlocks(splitMdBlocks(numbered));
    setBlocks(normalized);
    setActive(focus);
    onChange({ bodyMd: joinMdBlocks(normalized) });
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
      // Empty-block cut has no characters; still put a newline on the clipboard (Sublime-style).
      const clip = next.cut || "\n";
      void navigator.clipboard?.writeText(clip).catch(() => undefined);
      // Live editor keeps each source line as its own block — cutting the whole
      // block (including a blank line) must remove it, not leave "".
      if (next.text === "" && blocks.length > 1) {
        const nextBlocks = blocks.filter((_, i) => i !== active);
        const focus = Math.min(active, nextBlocks.length - 1);
        const caret = active < nextBlocks.length ? 0 : (nextBlocks[focus] ?? "").length;
        pendingSelection.current = null;
        commitBlocks(nextBlocks, focus, caret);
        requestAnimationFrame(() => {
          const el = editRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(caret, caret);
          autosize(el);
        });
        return;
      }
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

  const jumpToLine = (line1Based: number) => {
    const list = normalizeMdBlocks(blocks);
    const located = locateLineInBlocks(list, line1Based);
    setBlocks(list);
    pendingCaret.current = located.offset;
    setActive(located.index);
    setGotoOpen(false);
    requestAnimationFrame(() => {
      editRef.current?.scrollIntoView({ block: "center" });
    });
  };

  const openGoto = () => {
    setGotoValue("1");
    setGotoOpen(true);
    setFindOpen(false);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const target = event.target as HTMLElement | null;
      const inEditor = rootRef.current?.contains(target ?? null);
      if (!inEditor) return;

      if (mod && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openFind(true);
        return;
      }
      if (mod && event.key.toLowerCase() === "g") {
        event.preventDefault();
        openGoto();
        return;
      }
      if (mod && event.key === "Home") {
        event.preventDefault();
        jumpToLine(1);
        return;
      }

      // Vim-like `gg` → top (when not typing in an input/textarea).
      const tag = target?.tagName;
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || (target?.isContentEditable ?? false);
      if (!typing && !mod && (event.key === "g" || event.key === "G")) {
        if (gPending.current) {
          event.preventDefault();
          gPending.current = false;
          if (gTimer.current != null) window.clearTimeout(gTimer.current);
          jumpToLine(1);
        } else {
          gPending.current = true;
          if (gTimer.current != null) window.clearTimeout(gTimer.current);
          gTimer.current = window.setTimeout(() => {
            gPending.current = false;
          }, 600);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, blocks]);

  useEffect(() => {
    if (!gotoOpen) return;
    const id = requestAnimationFrame(() => gotoRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [gotoOpen]);

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
    setColorMenu(null);
    snippetStops.current = null;
    snippetStopIndex.current = 0;
    if (editRef.current) {
      editRef.current.style.minHeight = "";
      editRef.current.style.height = "";
      editRef.current.style.maxHeight = "";
    }
    editMinHeight.current = null;
    commitNumbered(blocks, null);
  };

  const activate = (index: number, opts?: { renumber?: boolean; caret?: number }) => {
    const renumber = opts?.renumber === true;
    let list = blocks;
    if (active != null && renumber) {
      const numbered = applyHeadingNumbers(joinMdBlocks(normalizeMdBlocks(blocks)));
      list = normalizeMdBlocks(splitMdBlocks(numbered));
      setBlocks(list);
      onChange({ bodyMd: joinMdBlocks(list) });
    }
    // Prefer the requested index so duplicate/empty blocks do not snap to the first match.
    const next = Math.min(Math.max(0, index), Math.max(0, list.length - 1));
    if (opts?.caret != null) pendingCaret.current = opts.caret;
    setActive(next);
  };

  /** Move focus across blocks without renumbering (keeps arrow navigation stable). */
  const moveToBlock = (index: number, caret: number) => {
    suppressBlur.current = true;
    activate(index, { renumber: false, caret });
    requestAnimationFrame(() => {
      suppressBlur.current = false;
    });
  };

  /** Enter edit mode at the clicked character (no renumber — keeps click snappy). */
  const beginEditAt = (
    index: number,
    caret: number,
    event?: { preventDefault: () => void; currentTarget?: EventTarget | null },
  ) => {
    event?.preventDefault();
    suppressBlur.current = true;
    pendingCaret.current = caret;
    pendingSelection.current = null;
    // Lock min-height to the preview box so code/images/headings do not jump on enter.
    // Skip for blank gaps — those must stay exactly one --md-live-row.
    const host = event?.currentTarget as HTMLElement | null | undefined;
    const enteringEmpty = !(blocks[index] ?? "");
    if (!enteringEmpty && host && typeof host.getBoundingClientRect === "function") {
      editMinHeight.current = Math.ceil(host.getBoundingClientRect().height);
    } else {
      editMinHeight.current = null;
    }
    setActive(index);
    requestAnimationFrame(() => {
      const area = editRef.current;
      if (area) {
        if (editMinHeight.current != null && area.value) {
          area.style.minHeight = `${editMinHeight.current}px`;
        }
        editMinHeight.current = null;
        area.focus({ preventScroll: true });
        const pos = Math.min(Math.max(0, caret), area.value.length);
        area.setSelectionRange(pos, pos);
        autosize(area, { force: true });
      }
      suppressBlur.current = false;
    });
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
    const next = styleMarkdownSelection(blocks[active] ?? "", start, end, kind, color);
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
    if (mod && event.key.toLowerCase() === "g") {
      event.preventDefault();
      openGoto();
      return;
    }
    if (mod && event.key === "Home") {
      event.preventDefault();
      jumpToLine(1);
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
      // GitHub markdown snippets: cycle tab stops, or expand trigger (h1/ul/table/…).
      if (!event.shiftKey && snippetStops.current && snippetStops.current.length > 0) {
        const stops = snippetStops.current;
        if (snippetStopIndex.current < stops.length - 1) {
          event.preventDefault();
          snippetStopIndex.current += 1;
          const stop = stops[snippetStopIndex.current]!;
          area.setSelectionRange(stop.start, stop.end);
          lastEditSel.current = { start: stop.start, end: stop.end };
          return;
        }
        snippetStops.current = null;
        snippetStopIndex.current = 0;
      }
      if (
        !event.shiftKey &&
        start === end &&
        !isFenceSource(value) &&
        !isCompleteFenceBlock(value)
      ) {
        const expanded = expandGithubMdSnippet(value, start);
        if (expanded) {
          event.preventDefault();
          const nextBlocks = [...blocks];
          nextBlocks[index] = expanded.text;
          snippetStops.current = expanded.stops;
          snippetStopIndex.current = 0;
          const first = expanded.stops[0] ?? { start: start, end: start };
          pendingSelection.current = { start: first.start, end: first.end };
          commitBlocks(nextBlocks, index, undefined);
          requestAnimationFrame(() => {
            const el = editRef.current;
            if (!el) return;
            el.focus();
            el.setSelectionRange(first.start, first.end);
            lastEditSel.current = { start: first.start, end: first.end };
            autosize(el, { force: true });
          });
          return;
        }
      }
      event.preventDefault();
      const next = event.shiftKey
        ? outdentMarkdownSelection(value, start, end)
        : indentMarkdownSelection(value, start, end);
      snippetStops.current = null;
      snippetStopIndex.current = 0;
      const nextBlocks = [...blocks];
      nextBlocks[index] = next.text;
      commitBlocks(nextBlocks, index, next.end);
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      // Inside a fenced code block (open or closed): keep Enter as a real newline.
      // Splitting would insert blank preview gaps and break the fence.
      if (/^ {0,3}(`{3,}|~{3,})/.test(value) || isCompleteFenceBlock(value)) {
        return;
      }
      const before = value.slice(0, start);
      const after = value.slice(end);
      const lineBefore = before.split("\n").pop() ?? "";
      const lineAfter = after.split("\n")[0] ?? "";
      // Keep GFM tables in one block so rows can render; blank line still splits out.
      if (
        lineBefore.trim() !== "" &&
        (isTableLine(lineBefore) ||
          isTableLine(lineAfter) ||
          value.split("\n").some(isTableLine))
      ) {
        return;
      }
      // Keep consecutive list items together (ul / ol) while typing.
      if (
        lineBefore.trim() !== "" &&
        (/^\s*([-*+]|\d+[.)])\s+/.test(lineBefore) ||
          /^\s*([-*+]|\d+[.)])\s+/.test(lineAfter) ||
          /^\s*([-*+]|\d+[.)])\s+/.test(value))
      ) {
        return;
      }
      // Split at caret so every line (including new blank lines) is its own editable row.
      event.preventDefault();
      const nextBlocks = [...blocks];
      nextBlocks[index] = before;
      nextBlocks.splice(index + 1, 0, after);
      commitBlocks(nextBlocks, index + 1, 0);
      return;
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

    if (start === end) {
      const line = caretLineInfo(value, start);
      if (event.key === "ArrowUp" && line.isFirstLine && index > 0) {
        event.preventDefault();
        const prev = blocks[index - 1] ?? "";
        moveToBlock(index - 1, caretOnLastLine(prev, line.col));
        return;
      }
      if (event.key === "ArrowDown" && line.isLastLine && index < blocks.length - 1) {
        event.preventDefault();
        const next = blocks[index + 1] ?? "";
        moveToBlock(index + 1, caretOnFirstLine(next, line.col));
        return;
      }
      if (event.key === "ArrowLeft" && start === 0 && index > 0) {
        event.preventDefault();
        moveToBlock(index - 1, (blocks[index - 1] ?? "").length);
        return;
      }
      if (
        event.key === "ArrowRight" &&
        start === value.length &&
        index < blocks.length - 1
      ) {
        event.preventDefault();
        moveToBlock(index + 1, 0);
        return;
      }
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
    if (!text) return "";
    const { slots } = extractImageSlots(text);
    const blockUrls = slots.map((slot) => urlByDest.get(slot.dest) ?? null);
    return renderMarkdown(text, blockUrls, { document: joinMdBlocks(blocks) });
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
          <button
            type="button"
            title={showLineNumbers ? "隐藏行号" : "显示行号"}
            aria-pressed={showLineNumbers}
            className={showLineNumbers ? "is-active" : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setShowLineNumbers((open) => !open)}
          >
            #
          </button>
          <button
            type="button"
            title="跳转到行 Ctrl+G"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => openGoto()}
          >
            跳转
          </button>
          <div className="note-editor__swatch">
            <button
              type="button"
              className="note-editor__swatch-btn"
              title="文字颜色"
              aria-expanded={colorMenu === "color"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setColorMenu((open) => (open === "color" ? null : "color"))}
            >
              <span className="note-editor__swatch-letter" style={{ color: "#e11d48" }}>
                A
              </span>
              <span
                className="note-editor__swatch-bar"
                style={{ background: "#e11d48" }}
              />
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
              <span
                className="note-editor__swatch-bar"
                style={{ background: "#fef08a" }}
              />
            </button>
            {colorMenu === "background" ? (
              <div
                className="note-editor__palette"
                role="listbox"
                aria-label="文字背景色"
              >
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

      {gotoOpen ? (
        <form
          className="goto-bar"
          aria-label="跳转到行"
          onSubmit={(e) => {
            e.preventDefault();
            const line = Number.parseInt(gotoValue, 10);
            if (!Number.isFinite(line) || line < 1) return;
            jumpToLine(Math.min(line, countDocLines(blocks)));
          }}
        >
          <label className="goto-bar__field">
            <span>行号:</span>
            <input
              ref={gotoRef}
              type="number"
              min={1}
              max={countDocLines(blocks)}
              value={gotoValue}
              onChange={(e) => setGotoValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setGotoOpen(false);
                }
              }}
              aria-label="目标行号"
            />
            <span className="goto-bar__total">/ {countDocLines(blocks)}</span>
          </label>
          <button type="submit">跳转</button>
          <button type="button" onClick={() => setGotoOpen(false)}>
            取消
          </button>
        </form>
      ) : null}

      <div
        className="note-editor__stage note-editor__stage--live-preview"
        aria-label="Markdown 编辑器"
      >
        <div
          className={["md-live", showLineNumbers ? "has-line-nos" : ""]
            .filter(Boolean)
            .join(" ")}
        >
          {blocks.map((block, index) => {
            const isActive = active === index;
            const startLine = lineStarts[index] ?? 1;
            const lineCount = blockLineCount(block);
            const gutter = showLineNumbers ? (
              <div className="md-live__gutter" aria-hidden="true">
                {Array.from({ length: lineCount }, (_, offset) => (
                  <span key={offset} className="md-live__line-no">
                    {startLine + offset}
                  </span>
                ))}
              </div>
            ) : null;
            if (isActive) {
              return (
                <div key={`edit-${index}`} className="md-live__row is-editing">
                  {gutter}
                  <div className="md-live__block is-editing">
                    <textarea
                      ref={editRef}
                      className={[
                        "md-live__source",
                        block ? "" : "is-empty",
                        isFenceSource(block) ? "is-fence" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      aria-label="Markdown 源码"
                      spellCheck={false}
                      value={block}
                      rows={1}
                      onSelect={(e) => {
                        lastEditSel.current = {
                          start: e.currentTarget.selectionStart,
                          end: e.currentTarget.selectionEnd,
                        };
                      }}
                      onKeyUp={(e) => {
                        lastEditSel.current = {
                          start: e.currentTarget.selectionStart,
                          end: e.currentTarget.selectionEnd,
                        };
                      }}
                      onClick={(e) => {
                        lastEditSel.current = {
                          start: e.currentTarget.selectionStart,
                          end: e.currentTarget.selectionEnd,
                        };
                      }}
                      onChange={(e) => {
                        const area = e.currentTarget;
                        const nextValue = area.value;
                        const prevValue = block;
                        if (snippetStops.current) {
                          const sel = lastEditSel.current;
                          const oldSpan = Math.max(0, sel.end - sel.start);
                          const newSpan = Math.max(
                            0,
                            nextValue.length - (prevValue.length - oldSpan),
                          );
                          snippetStops.current = adjustSnippetStops(
                            snippetStops.current,
                            sel.start,
                            oldSpan,
                            newSpan,
                          );
                        }
                        updateActiveBlock(nextValue);
                        autosize(area);
                        requestAnimationFrame(() => {
                          lastEditSel.current = {
                            start: area.selectionStart,
                            end: area.selectionEnd,
                          };
                        });
                      }}
                      onKeyDown={onEditKeyDown}
                      onPaste={onPaste}
                      onBlur={() => {
                        requestAnimationFrame(() => {
                          if (suppressBlur.current) return;
                          const root = rootRef.current;
                          if (root && root.contains(document.activeElement)) return;
                          finishEditing();
                        });
                      }}
                    />
                  </div>
                </div>
              );
            }
            if (!block) {
              // Blank source lines stay in the model, but no longer render as grey bars.
              return (
                <div key={`view-${index}`} className="md-live__row">
                  {gutter}
                  <div
                    className="md-live__gap"
                    role="button"
                    tabIndex={0}
                    aria-label={`编辑空行（第 ${startLine} 行）`}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      beginEditAt(index, 0, {
                        preventDefault: () => e.preventDefault(),
                        currentTarget: e.currentTarget,
                      });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        beginEditAt(index, 0);
                      }
                    }}
                  />
                </div>
              );
            }
            return (
              <div key={`view-${index}`} className="md-live__row">
                {gutter}
                <div
                  className="md-live__block"
                  role="button"
                  tabIndex={0}
                  aria-label={`编辑第 ${startLine} 行`}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    const target = e.currentTarget.querySelector(
                      ".md-live__preview",
                    ) as HTMLElement | null;
                    const caret = target
                      ? caretIndexFromClick(block, e.clientX, e.clientY, target)
                      : 0;
                    beginEditAt(index, caret, {
                      preventDefault: () => e.preventDefault(),
                      currentTarget: e.currentTarget,
                    });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      beginEditAt(index, 0);
                    }
                  }}
                >
                  <div
                    className="md-live__preview md-body"
                    onMouseDown={(event) => {
                      if (
                        event.target instanceof Element &&
                        event.target.closest(".md-code__copy")
                      ) {
                        event.stopPropagation();
                      }
                    }}
                    onClick={(event) => {
                      if (copyCodeBlock(event.target)) {
                        event.preventDefault();
                        event.stopPropagation();
                      }
                    }}
                    dangerouslySetInnerHTML={{ __html: renderBlock(block) }}
                  />
                </div>
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
