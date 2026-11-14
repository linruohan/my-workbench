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
  extractMdHeadings,
  findAllMatches,
  findNextMatch,
  indentMarkdownSelection,
  isCompleteFenceBlock,
  isTableLine,
  isTocSource,
  joinMdBlocks,
  locateHeadingBlockIndex,
  locateInBlocks,
  locateLineInBlocks,
  mergeBlocksRange,
  mergeBlockToward,
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
  type ImageSlot,
  type InlineStyleKind,
  type MdSnippetRange,
  type Note,
} from "@wb/domain";
import { copyCodeBlock } from "../lib/code-copy";
import { errorMessage } from "../lib/errors";
import { buildHeadingOccurrenceMap, renderMarkdown } from "../lib/markdown";
import { externalHrefFromEvent, openExternalUrl } from "../lib/open-external";
import { isTauriRuntime } from "../lib/paths";
import { useDialog } from "../shell/Dialogs";
import { appendVoiceText, injectVoiceIntoField, VoiceInputButton } from "../voice";
import {
  bytesToBase64,
  clipboardFileToPngBytes,
  resolveImageSrc,
  savePastedImage,
} from "./kb-api";
import { FindReplaceBar, type FindReplaceState } from "./FindReplaceBar";
import {
  buildRowMetrics,
  lineNumberText,
  mapPool,
  visibleRange,
} from "./md-live-virtual";

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
  /** Double-click the title to rename the backing file (knowledge files). */
  onRenameFile?: (nextFileName: string) => void | Promise<void>;
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

type SelectionDirection = "forward" | "backward" | "none";

function selectionAnchorFocus(area: HTMLTextAreaElement): {
  anchor: number;
  focus: number;
  direction: SelectionDirection;
} {
  const start = area.selectionStart;
  const end = area.selectionEnd;
  const direction = (area.selectionDirection || "none") as SelectionDirection;
  if (direction === "backward") {
    return { anchor: end, focus: start, direction };
  }
  return {
    anchor: start,
    focus: end,
    direction: start === end ? "none" : direction === "none" ? "forward" : direction,
  };
}

function selectionRangeFromAnchorFocus(
  anchor: number,
  focus: number,
): { start: number; end: number; direction: SelectionDirection } {
  if (focus < anchor) {
    return { start: focus, end: anchor, direction: "backward" };
  }
  if (focus > anchor) {
    return { start: anchor, end: focus, direction: "forward" };
  }
  return { start: anchor, end: focus, direction: "none" };
}

/** 块内最后一行的起始下标。 */
function lastLineStart(text: string): number {
  const nl = text.lastIndexOf("\n");
  return nl < 0 ? 0 : nl + 1;
}

/** 块内第一行结束后的下标。 */
function firstLineEnd(text: string): number {
  const nl = text.indexOf("\n");
  return nl < 0 ? text.length : nl;
}

/** 向左跨块查找上一个词边界（Ctrl+ArrowLeft 语义）。 */
function prevWordBoundary(text: string, pos: number): number {
  let i = Math.max(0, Math.min(pos, text.length));
  while (i > 0 && /\s/.test(text[i - 1] ?? "")) i -= 1;
  while (i > 0 && !/\s/.test(text[i - 1] ?? "")) i -= 1;
  return i;
}

/** 向右跨块查找下一个词边界（Ctrl+ArrowRight 语义）。 */
function nextWordBoundary(text: string, pos: number): number {
  let i = Math.max(0, Math.min(pos, text.length));
  while (i < text.length && /\s/.test(text[i] ?? "")) i += 1;
  while (i < text.length && !/\s/.test(text[i] ?? "")) i += 1;
  return i;
}

/** 指定块的文档起始偏移；越界时返回兜底位置。 */
function indexAtBlockStart(blocks: string[], index: number, fallback: number): number {
  if (index < 0 || index >= blocks.length) return fallback;
  return blockDocOffset(blocks, index);
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
  onRenameFile,
  imageBaseDir = null,
  imageStem = null,
  onAssetSaved,
  saveLabel = null,
}: Props) {
  const dialog = useDialog();
  const [blocks, setBlocks] = useState(() => splitMdBlocks(note.bodyMd));
  const [active, setActive] = useState<number | null>(null);
  const [colorMenu, setColorMenu] = useState<"color" | "background" | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [find, setFind] = useState<FindReplaceState>(DEFAULT_FIND);
  const [findStatus, setFindStatus] = useState<string | null>(null);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoValue, setGotoValue] = useState("1");
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(note.title);
  const titleCommitLock = useRef(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const gotoRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const measuredHeights = useRef(new Map<number, number>());
  const measureRaf = useRef<number | null>(null);
  const pinIndexRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(800);
  const [measureTick, setMeasureTick] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const pendingSelection = useRef<{
    start: number;
    end: number;
    direction?: SelectionDirection;
  } | null>(null);
  const selectionScope = useRef<{ start: number; end: number } | null>(null);
  const suppressBlur = useRef(false);
  /** Document offset of the selection anchor while Shift-extending or drag-selecting. */
  const selAnchorDoc = useRef<number | null>(null);
  const dragSelecting = useRef(false);
  /** 最近一次拖拽应用的文档选区；重复命中同一位置时直接跳过。 */
  const lastAppliedDoc = useRef<{ anchor: number; focus: number; text: string } | null>(
    null,
  );
  /** 预览区拖拽：先记录起点，跨块后才进入编辑态。 */
  const previewDrag = useRef<{
    anchorDoc: number;
    focusDoc: number;
    startX: number;
    startY: number;
    moved: boolean;
    crossed: boolean;
  } | null>(null);
  const editMinHeight = useRef<number | null>(null);
  const snippetStops = useRef<MdSnippetRange[] | null>(null);
  const snippetStopIndex = useRef(0);
  const lastEditSel = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  const findFrom = useRef(0);
  const gPending = useRef(false);
  const gTimer = useRef<number | null>(null);
  const noteIdRef = useRef<string | null>(null);
  /** 上一次提交给外部的正文，用于跳过外部回写引起的重复拆分 */
  const lastCommittedRef = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lineStarts = useMemo(() => {
    const starts: number[] = [];
    let line = 1;
    for (const block of blocks) {
      starts.push(line);
      line += blockLineCount(block);
    }
    return starts;
  }, [blocks]);

  const documentText = useMemo(() => joinMdBlocks(blocks), [blocks]);
  const prepared = useMemo(() => extractImageSlots(documentText), [documentText]);
  const documentHeadings = useMemo(() => extractMdHeadings(documentText), [documentText]);
  const documentHeadingMap = useMemo(
    () => buildHeadingOccurrenceMap(documentHeadings),
    [documentHeadings],
  );
  const slotsCacheRef = useRef(new Map<string, ImageSlot[]>());
  const cachedSlots = (text: string): ImageSlot[] => {
    const cache = slotsCacheRef.current;
    const hit = cache.get(text);
    if (hit) return hit;
    const { slots } = extractImageSlots(text);
    if (cache.size > 512) cache.clear();
    cache.set(text, slots);
    return slots;
  };
  const rowMetrics = useMemo(
    () => buildRowMetrics(blocks, measuredHeights.current),
    [blocks, measureTick],
  );
  const virtualRange = useMemo(() => {
    const base = visibleRange(rowMetrics, scrollTop, viewportH, 12);
    let start = base.start;
    let end = base.end;
    if (active != null) {
      start = Math.min(start, active);
      end = Math.max(end, active + 1);
    }
    const pin = pinIndexRef.current;
    if (pin != null) {
      start = Math.min(start, pin);
      end = Math.max(end, pin + 1);
    }
    return { start, end };
  }, [rowMetrics, scrollTop, viewportH, active, measureTick]);

  useEffect(() => {
    if (!titleEditing) setTitleDraft(note.title);
  }, [note.title, titleEditing]);

  useEffect(() => {
    if (!titleEditing) return;
    const el = titleRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [titleEditing]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const sync = () => {
      setScrollTop(el.scrollTop);
      setViewportH(el.clientHeight || 800);
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, [note.id]);

  const scheduleMeasure = () => {
    if (measureRaf.current != null) return;
    measureRaf.current = requestAnimationFrame(() => {
      measureRaf.current = null;
      setMeasureTick((value) => value + 1);
    });
  };

  const bindRowMeasure = (index: number, el: HTMLDivElement | null) => {
    if (!el) return;
    const height = el.getBoundingClientRect().height;
    if (!(height > 0)) return;
    const prev = measuredHeights.current.get(index);
    if (prev != null && Math.abs(prev - height) < 2) return;
    measuredHeights.current.set(index, height);
    scheduleMeasure();
  };

  const blocksLen = blocks.length;
  useEffect(() => {
    measuredHeights.current = new Map();
    scheduleMeasure();
    // Length changes shift row indices — drop stale measured heights.
  }, [blocksLen]);

  // Keep a stable block list while editing so fence edits do not re-split into empty blocks.
  useEffect(() => {
    if (noteIdRef.current !== note.id) {
      noteIdRef.current = note.id;
      lastCommittedRef.current = null;
      setActive(null);
      measuredHeights.current = new Map();
      pinIndexRef.current = null;
      setScrollTop(0);
      // Fast first paint: split only. Defer outline numbering so open stays responsive.
      const next = normalizeMdBlocks(splitMdBlocks(note.bodyMd));
      setBlocks(next);
      const handle = window.setTimeout(() => {
        if (noteIdRef.current !== note.id) return;
        const numbered = applyHeadingNumbers(note.bodyMd);
        const numberedBlocks = normalizeMdBlocks(splitMdBlocks(numbered));
        const body = joinMdBlocks(numberedBlocks);
        if (body === note.bodyMd) return;
        measuredHeights.current = new Map();
        setBlocks(numberedBlocks);
        lastCommittedRef.current = body;
        onChangeRef.current({ bodyMd: body });
      }, 0);
      return () => window.clearTimeout(handle);
    }
    if (active == null) {
      // 外部回写的正是自己刚提交的正文时，无需再拆分一次
      if (note.bodyMd === lastCommittedRef.current) return;
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
  const urls = useMemo(
    () =>
      remoteUrls.map(
        (url, index) =>
          url ?? (local.key === slotKey ? (local.urls[index] ?? null) : null),
      ),
    [remoteUrls, local, slotKey],
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
      const resolved = await mapPool(prepared.slots, async (slot, index) => {
        if (remoteUrls[index]) return remoteUrls[index] ?? null;
        if (!slot.dest) return null;
        return resolveImageSrc(slot.dest, imageBaseDir);
      });
      if (!cancel) setLocal({ key, urls: resolved });
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
      area.setSelectionRange(start, end, range.direction ?? "none");
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

  /** 提交块数组；正文未变化时跳过 onChange，避免无意义的脏状态。 */
  const commitBlocks = (nextBlocks: string[], focus: number | null, caret?: number) => {
    const normalized = normalizeMdBlocks(nextBlocks);
    if (caret != null) pendingCaret.current = caret;
    const nextText = joinMdBlocks(normalized);
    // 复用本帧已拼接好的正文，避免每次按键再拼一遍全文
    const prevText = documentText;
    setBlocks(normalized);
    setActive(focus);
    if (nextText !== prevText) {
      lastCommittedRef.current = nextText;
      onChange({ bodyMd: nextText });
    }
  };

  /** Sync outline numbers into source when leaving edit (keeps render free of CSS counters). */
  const commitNumbered = (nextBlocks: string[], focus: number | null) => {
    const baseText = joinMdBlocks(normalizeMdBlocks(nextBlocks));
    const numbered = applyHeadingNumbers(baseText);
    const normalized = normalizeMdBlocks(splitMdBlocks(numbered));
    const nextText = joinMdBlocks(normalized);
    const prevText = documentText;
    if (nextText === prevText) {
      if (normalized !== blocks) setBlocks(normalized);
      setActive(focus);
      return;
    }
    setBlocks(normalized);
    setActive(focus);
    lastCommittedRef.current = nextText;
    onChange({ bodyMd: nextText });
  };

  const docText = () => documentText;

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

  const scrollToBlockIndex = (index: number) => {
    const el = stageRef.current;
    if (!el) return;
    pinIndexRef.current = index;
    const top = rowMetrics.offsets[index] ?? 0;
    el.scrollTop = Math.max(0, top - Math.min(120, el.clientHeight * 0.2));
    scheduleMeasure();
    requestAnimationFrame(() => {
      pinIndexRef.current = null;
    });
  };

  const jumpToLine = (line1Based: number) => {
    const list = normalizeMdBlocks(blocks);
    const located = locateLineInBlocks(list, line1Based);
    setBlocks(list);
    pendingCaret.current = located.offset;
    setActive(located.index);
    setGotoOpen(false);
    scrollToBlockIndex(located.index);
    requestAnimationFrame(() => {
      editRef.current?.scrollIntoView({ block: "center" });
    });
  };

  const tocLinkFromEvent = (target: EventTarget | null): string | null => {
    if (!(target instanceof Element)) return null;
    const link = target.closest("a.md-toc__link, .md-toc a[href^='#']");
    if (!(link instanceof HTMLAnchorElement)) return null;
    return (
      link.getAttribute("data-heading-id") ||
      link.getAttribute("href")?.replace(/^#/, "") ||
      null
    );
  };

  const tryOpenExternalLink = (
    event: {
      ctrlKey: boolean;
      metaKey: boolean;
      preventDefault: () => void;
      stopPropagation: () => void;
    },
    target: EventTarget | null,
  ): boolean => {
    if (!(event.ctrlKey || event.metaKey)) return false;
    const href = externalHrefFromEvent(target);
    if (!href) return false;
    event.preventDefault();
    event.stopPropagation();
    void openExternalUrl(href).catch((err) => {
      void dialog.alert({
        title: "无法打开链接",
        message: errorMessage(err, "无法打开链接"),
      });
    });
    return true;
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
    const body = joinMdBlocks(next);
    lastCommittedRef.current = body;
    setBlocks(next);
    onChange({ bodyMd: body });
  };

  const finishEditing = () => {
    if (active == null) return;
    if (findOpen) return;
    setColorMenu(null);
    snippetStops.current = null;
    snippetStopIndex.current = 0;
    selAnchorDoc.current = null;
    dragSelecting.current = false;
    previewDrag.current = null;
    lastAppliedDoc.current = null;
    if (editRef.current) {
      editRef.current.style.minHeight = "";
      editRef.current.style.height = "";
      editRef.current.style.maxHeight = "";
    }
    editMinHeight.current = null;
    commitNumbered(blocks, null);
  };

  /** Scroll to a heading from a [toc] link without entering edit mode. */
  const jumpToHeadingId = (headingId: string) => {
    const id = headingId.replace(/^#/, "").trim();
    if (!id) return;
    const root = rootRef.current;
    const escapeId =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(id)
        : id.replace(/"/g, '\\"');
    const flash = (el: HTMLElement) => {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("is-toc-target");
      window.setTimeout(() => el.classList.remove("is-toc-target"), 1200);
    };
    const byId = root?.querySelector(`#${escapeId}`);
    if (byId instanceof HTMLElement) {
      flash(byId);
      return;
    }
    const index = locateHeadingBlockIndex(blocks, id);
    if (index < 0) return;
    // Leave edit mode so the heading preview (with id) can receive scroll.
    if (active != null) finishEditing();
    scrollToBlockIndex(index);
    requestAnimationFrame(() => {
      const heading = rootRef.current?.querySelector(`#${escapeId}`);
      if (heading instanceof HTMLElement) {
        flash(heading);
        return;
      }
      const row = rootRef.current?.querySelector(`[data-block-index="${index}"]`);
      if (row instanceof HTMLElement) flash(row);
    });
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
    if (next !== active) {
      snippetStops.current = null;
      snippetStopIndex.current = 0;
    }
    setActive(next);
  };

  /** Move focus across blocks without renumbering (keeps arrow navigation stable). */
  const moveToBlock = (index: number, caret: number) => {
    suppressBlur.current = true;
    selAnchorDoc.current = null;
    activate(index, { renumber: false, caret });
    requestAnimationFrame(() => {
      suppressBlur.current = false;
    });
  };

  const applyMergedSelection = (
    nextBlocks: string[],
    focusIndex: number,
    anchor: number,
    focus: number,
  ) => {
    const range = selectionRangeFromAnchorFocus(anchor, focus);
    const nextText = joinMdBlocks(nextBlocks);
    const structuralSame =
      nextBlocks.length === blocks.length &&
      nextBlocks.every((text, i) => text === (blocks[i] ?? ""));
    pendingSelection.current = range;
    pendingCaret.current = null;
    selAnchorDoc.current = blockDocOffset(nextBlocks, focusIndex) + anchor;
    suppressBlur.current = true;
    if (!structuralSame) setBlocks(nextBlocks);
    setActive(focusIndex);
    // 拖拽重复命中同一选区时，文本域已经处于该状态，无需再排一次 rAF。
    const area = editRef.current;
    if (
      structuralSame &&
      active === focusIndex &&
      area &&
      document.activeElement === area &&
      area.selectionStart === range.start &&
      area.selectionEnd === range.end
    ) {
      pendingSelection.current = null;
      suppressBlur.current = false;
      return;
    }
    // 纯选择合并不会改变正文文本：跳过 onChange，避免用户仅拖选就被标记为脏。
    if (nextText !== documentText) onChange({ bodyMd: nextText });
    requestAnimationFrame(() => {
      const area = editRef.current;
      if (area) {
        area.focus({ preventScroll: true });
        area.setSelectionRange(range.start, range.end, range.direction);
        lastEditSel.current = { start: range.start, end: range.end };
        autosize(area, { force: true });
        scheduleMeasure();
      }
      suppressBlur.current = false;
    });
  };

  /** Expand the live-edit selection to a document-level anchor/focus pair (may merge blocks). */
  const focusDocRange = (docAnchor: number, docFocus: number, sourceBlocks = blocks) => {
    const text = joinMdBlocks(sourceBlocks);
    const a = Math.max(0, Math.min(Math.floor(docAnchor), text.length));
    const f = Math.max(0, Math.min(Math.floor(docFocus), text.length));
    // mousemove 每秒会触发很多次；同一文档选区重复命中时不再做合并与渲染。
    const applied = lastAppliedDoc.current;
    if (applied && applied.anchor === a && applied.focus === f && applied.text === text) {
      return;
    }
    lastAppliedDoc.current = { anchor: a, focus: f, text };
    const locA = locateInBlocks(sourceBlocks, a);
    const locF = locateInBlocks(sourceBlocks, f);
    const from = Math.min(locA.index, locF.index);
    const to = Math.max(locA.index, locF.index);
    const merged = mergeBlocksRange(sourceBlocks, from, to);
    if (!merged) return;
    const base = blockDocOffset(sourceBlocks, from);
    selAnchorDoc.current = a;
    applyMergedSelection(merged.blocks, merged.index, a - base, f - base);
  };

  const selectAllDocument = () => {
    const text = joinMdBlocks(blocks);
    selAnchorDoc.current = 0;
    applyMergedSelection([text], 0, 0, text.length);
  };

  /** Enter edit mode at the clicked character (no renumber — keeps click snappy). */
  const beginEditAt = (index: number, caret: number, host?: HTMLElement | null) => {
    suppressBlur.current = true;
    previewDrag.current = null;
    lastAppliedDoc.current = null;
    pendingCaret.current = caret;
    pendingSelection.current = null;
    selAnchorDoc.current = blockDocOffset(blocks, index) + caret;
    // Lock min-height to the preview box so code/images/headings do not jump on enter.
    // Skip for blank gaps — those must stay exactly one --md-live-row.
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

  /** Shift-click / drag: extend selection to a caret inside another block. */
  const extendSelectionTo = (index: number, caret: number) => {
    if (active == null) {
      beginEditAt(index, caret);
      return;
    }
    const area = editRef.current;
    const base = blockDocOffset(blocks, active);
    const anchorDoc =
      selAnchorDoc.current ?? (area ? base + selectionAnchorFocus(area).anchor : base);
    const focusDoc = blockDocOffset(blocks, index) + caret;
    focusDocRange(anchorDoc, focusDoc);
  };

  // 文档级拖拽追踪：原生选区在文本域边缘会断开，用 elementFromPoint 命中行后继续合并。
  useEffect(() => {
    const rowAt = (x: number, y: number): HTMLElement | null => {
      if (typeof document.elementFromPoint !== "function") return null;
      const hit = document.elementFromPoint(x, y);
      if (!(hit instanceof Element)) return null;
      return hit.closest("[data-block-index]") as HTMLElement | null;
    };

    /** 把视口坐标映射成块下标和块内光标位置。 */
    const caretAt = (x: number, y: number): { index: number; caret: number } | null => {
      const row = rowAt(x, y);
      if (!row) return null;
      const index = Number(row.dataset.blockIndex);
      if (!Number.isInteger(index) || index < 0 || index >= blocks.length) return null;
      const area = editRef.current;
      if (active != null && index === active && area) {
        return { index, caret: caretIndexFromClick(area.value, x, y, area) };
      }
      const preview = row.querySelector(".md-live__preview") as HTMLElement | null;
      if (!preview) return { index, caret: 0 };
      return { index, caret: caretIndexFromClick(blocks[index] ?? "", x, y, preview) };
    };

    const onMove = (event: MouseEvent) => {
      if ((event.buttons & 1) === 0) return;
      const preview = previewDrag.current;
      if (preview) {
        const dx = event.clientX - preview.startX;
        const dy = event.clientY - preview.startY;
        if (!preview.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        preview.moved = true;
        const pos = caretAt(event.clientX, event.clientY);
        if (!pos) return;
        preview.focusDoc = blockDocOffset(blocks, pos.index) + pos.caret;
        if (
          !preview.crossed &&
          pos.index !== locateInBlocks(blocks, preview.anchorDoc).index
        ) {
          preview.crossed = true;
        }
        // 仍在同一块内时保留原生选区（复制粘贴不受影响）。
        if (preview.crossed) focusDocRange(preview.anchorDoc, preview.focusDoc);
        return;
      }
      if (!dragSelecting.current || active == null) return;
      const hit =
        typeof document.elementFromPoint === "function"
          ? document.elementFromPoint(event.clientX, event.clientY)
          : null;
      // 指针还在文本域内部时交给浏览器处理原生选区。
      if (hit === editRef.current) return;
      const pos = caretAt(event.clientX, event.clientY);
      if (!pos) return;
      extendSelectionTo(pos.index, pos.caret);
    };

    const onUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      dragSelecting.current = false;
      const drag = previewDrag.current;
      previewDrag.current = null;
      if (!drag) return;
      if (!drag.moved) {
        // 纯点击：此时才进入编辑态，mousedown 不再阻断预览区文本复制。
        const loc = locateInBlocks(blocks, drag.anchorDoc);
        const row = rowAt(event.clientX, event.clientY);
        const preview = row?.querySelector(".md-live__preview") as HTMLElement | null;
        beginEditAt(loc.index, loc.offset, preview ?? row);
        return;
      }
      if (drag.crossed) focusDocRange(drag.anchorDoc, drag.focusDoc);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // `blocks` / `active` 跟随渲染更新，保证命中测试使用当前行数据。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, active]);

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
    // 需要跨越块边界的 Ctrl/Cmd+Shift 选区快捷键。
    if (mod && event.shiftKey) {
      const text = joinMdBlocks(blocks);
      const area = event.currentTarget;
      const { anchor, focus } = selectionAnchorFocus(area);
      const base = blockDocOffset(blocks, active ?? 0);
      const anchorDoc = selAnchorDoc.current ?? base + anchor;
      const focusDoc = base + focus;
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        focusDocRange(anchorDoc, event.key === "Home" ? 0 : text.length);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const target =
          event.key === "ArrowLeft"
            ? prevWordBoundary(text, focusDoc)
            : nextWordBoundary(text, focusDoc);
        focusDocRange(anchorDoc, target);
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const target =
          event.key === "ArrowUp"
            ? indexAtBlockStart(blocks, (active ?? 0) - 1, 0)
            : indexAtBlockStart(blocks, (active ?? 0) + 1, text.length);
        focusDocRange(anchorDoc, target);
        return;
      }
    }
    if (mod && !event.shiftKey && event.key === "Home") {
      event.preventDefault();
      jumpToLine(1);
      return;
    }
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAllDocument();
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
    const { anchor, focus } = selectionAnchorFocus(area);
    const focusLine = caretLineInfo(value, focus);

    // Shift+arrows at block edges: merge the neighbor so native multi-line select continues.
    if (event.shiftKey && !mod) {
      // Shift+Home / Shift+End 抵达块边缘后继续延伸到相邻块。
      if (event.key === "Home" && focus === 0 && index > 0) {
        event.preventDefault();
        const prev = blocks[index - 1] ?? "";
        const anchorDoc = selAnchorDoc.current ?? blockDocOffset(blocks, index) + anchor;
        focusDocRange(anchorDoc, blockDocOffset(blocks, index - 1) + lastLineStart(prev));
        return;
      }
      if (event.key === "End" && focus === value.length && index < blocks.length - 1) {
        event.preventDefault();
        const next = blocks[index + 1] ?? "";
        const anchorDoc = selAnchorDoc.current ?? blockDocOffset(blocks, index) + anchor;
        focusDocRange(anchorDoc, blockDocOffset(blocks, index + 1) + firstLineEnd(next));
        return;
      }
      if (event.key === "ArrowUp" && focusLine.isFirstLine && index > 0) {
        event.preventDefault();
        const prev = blocks[index - 1] ?? "";
        const merged = mergeBlockToward(blocks, index, "up");
        if (!merged) return;
        const adj = merged.offsetAdj;
        applyMergedSelection(
          merged.blocks,
          merged.index,
          anchor + adj,
          caretOnLastLine(prev, focusLine.col),
        );
        return;
      }
      if (
        event.key === "ArrowDown" &&
        focusLine.isLastLine &&
        index < blocks.length - 1
      ) {
        event.preventDefault();
        const next = blocks[index + 1] ?? "";
        const merged = mergeBlockToward(blocks, index, "down");
        if (!merged) return;
        const nextStart = value.length + 1;
        applyMergedSelection(
          merged.blocks,
          merged.index,
          anchor,
          nextStart + caretOnFirstLine(next, focusLine.col),
        );
        return;
      }
      if (event.key === "ArrowLeft" && focus === 0 && index > 0) {
        event.preventDefault();
        const merged = mergeBlockToward(blocks, index, "up");
        if (!merged) return;
        const adj = merged.offsetAdj;
        applyMergedSelection(
          merged.blocks,
          merged.index,
          anchor + adj,
          Math.max(0, adj - 1),
        );
        return;
      }
      if (
        event.key === "ArrowRight" &&
        focus === value.length &&
        index < blocks.length - 1
      ) {
        event.preventDefault();
        const merged = mergeBlockToward(blocks, index, "down");
        if (!merged) return;
        applyMergedSelection(merged.blocks, merged.index, anchor, value.length + 1);
        return;
      }
    }

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

    if (start === end && !event.shiftKey) {
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
        void dialog.alert({
          title: "粘贴失败",
          message: errorMessage(err, "粘贴图片失败"),
        });
      }
    })();
  };

  const renderBlock = (text: string) => {
    if (!text) return "";
    const slots = cachedSlots(text);
    const blockUrls = slots.map((slot) => urlByDest.get(slot.dest) ?? null);
    return renderMarkdown(text, blockUrls, {
      document: documentText,
      documentHeadings,
      documentHeadingMap,
    });
  };

  const fileTitleMode = Boolean(titleReadOnly && onRenameFile);
  const titleLocked = titleReadOnly && !titleEditing;

  const commitTitleRename = async () => {
    if (!fileTitleMode || !titleEditing || titleCommitLock.current) return;
    titleCommitLock.current = true;
    const next = titleDraft.trim();
    setTitleEditing(false);
    try {
      if (!next || next === note.title) {
        setTitleDraft(note.title);
        return;
      }
      await onRenameFile?.(next);
    } catch (err) {
      setTitleDraft(note.title);
      await dialog.alert({
        title: "重命名失败",
        message: errorMessage(err, "重命名失败"),
      });
    } finally {
      titleCommitLock.current = false;
    }
  };

  return (
    <div className="note-editor" ref={rootRef}>
      <header className="note-editor__toolbar">
        <input
          ref={titleRef}
          className="note-editor__title"
          aria-label={fileTitleMode ? "文件名（双击重命名）" : "笔记标题"}
          title={fileTitleMode ? "双击重命名文件" : undefined}
          value={fileTitleMode ? titleDraft : note.title}
          readOnly={titleLocked || (!fileTitleMode && titleReadOnly)}
          onDoubleClick={() => {
            if (!fileTitleMode) return;
            setTitleDraft(note.title);
            setTitleEditing(true);
          }}
          onChange={(e) => {
            if (fileTitleMode && titleEditing) {
              setTitleDraft(e.target.value);
              return;
            }
            if (!titleReadOnly) onChange({ title: e.target.value });
          }}
          onBlur={() => {
            if (fileTitleMode && titleEditing) void commitTitleRename();
          }}
          onKeyDown={(e) => {
            if (!fileTitleMode || !titleEditing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              void commitTitleRename();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setTitleDraft(note.title);
              setTitleEditing(false);
            }
          }}
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
          <VoiceInputButton
            className="note-editor__voice"
            onArm={() => {
              if (active != null && editRef.current) {
                const area = editRef.current;
                const pos = area.selectionStart ?? area.value.length;
                area.focus({ preventScroll: true });
                area.setSelectionRange(pos, pos);
                return;
              }
              if (blocks.length === 0) {
                activate(0, { caret: 0 });
                return;
              }
              const last = blocks.length - 1;
              activate(last, { caret: (blocks[last] ?? "").length });
            }}
            onInsert={(text) => {
              if (active != null && editRef.current) {
                const area = editRef.current;
                const { value, caret } = injectVoiceIntoField(area, text);
                const nextBlocks = [...blocks];
                nextBlocks[active] = value;
                commitBlocks(nextBlocks, active, caret);
                return;
              }
              onChange({ bodyMd: appendVoiceText(note.bodyMd, text) });
            }}
          />
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
        ref={stageRef}
        className="note-editor__stage note-editor__stage--live-preview"
        aria-label="Markdown 编辑器"
      >
        <div
          className={["md-live", showLineNumbers ? "has-line-nos" : ""]
            .filter(Boolean)
            .join(" ")}
        >
          <div
            className="md-live__spacer"
            style={{ height: rowMetrics.offsets[virtualRange.start] ?? 0 }}
            aria-hidden
          />
          {blocks.slice(virtualRange.start, virtualRange.end).map((block, offset) => {
            const index = virtualRange.start + offset;
            const isActive = active === index;
            const startLine = lineStarts[index] ?? 1;
            const lineCount = blockLineCount(block);
            const gutter = showLineNumbers ? (
              <div className="md-live__gutter" aria-hidden="true">
                <pre className="md-live__line-nos">
                  {lineNumberText(startLine, lineCount)}
                </pre>
              </div>
            ) : null;
            if (isActive) {
              return (
                <div
                  key={`edit-${index}`}
                  ref={(el) => bindRowMeasure(index, el)}
                  className="md-live__row is-editing"
                  data-block-index={index}
                >
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
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        previewDrag.current = null;
                        lastAppliedDoc.current = null;
                        dragSelecting.current = true;
                        const area = e.currentTarget;
                        // Capture anchor after the browser places the caret.
                        requestAnimationFrame(() => {
                          if (active == null) return;
                          const { anchor } = selectionAnchorFocus(area);
                          selAnchorDoc.current = blockDocOffset(blocks, active) + anchor;
                        });
                      }}
                      onSelect={(e) => {
                        lastEditSel.current = {
                          start: e.currentTarget.selectionStart,
                          end: e.currentTarget.selectionEnd,
                        };
                        if (!dragSelecting.current && active != null) {
                          const { anchor } = selectionAnchorFocus(e.currentTarget);
                          selAnchorDoc.current = blockDocOffset(blocks, active) + anchor;
                        }
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
                        scheduleMeasure();
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
                <div
                  key={`view-${index}`}
                  ref={(el) => bindRowMeasure(index, el)}
                  className="md-live__row"
                  data-block-index={index}
                >
                  {gutter}
                  <div
                    className="md-live__gap"
                    role="button"
                    tabIndex={0}
                    aria-label={`编辑空行（第 ${startLine} 行）`}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      if (e.shiftKey && active != null) {
                        e.preventDefault();
                        extendSelectionTo(index, 0);
                        return;
                      }
                      dragSelecting.current = true;
                      lastAppliedDoc.current = null;
                      beginEditAt(index, 0, e.currentTarget);
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
            const tocBlock = isTocSource(block);
            return (
              <div
                key={`view-${index}`}
                ref={(el) => bindRowMeasure(index, el)}
                className="md-live__row"
                data-block-index={index}
              >
                {gutter}
                <div
                  className={tocBlock ? "md-live__block is-toc" : "md-live__block"}
                  role="button"
                  tabIndex={0}
                  aria-label={tocBlock ? "目录" : `编辑第 ${startLine} 行`}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    // Ctrl/Cmd+link: swallow here; open once on click.
                    if ((e.ctrlKey || e.metaKey) && externalHrefFromEvent(e.target)) {
                      e.preventDefault();
                      e.stopPropagation();
                      return;
                    }
                    const tocId = tocLinkFromEvent(e.target);
                    if (tocId) {
                      e.preventDefault();
                      e.stopPropagation();
                      jumpToHeadingId(tocId);
                      return;
                    }
                    // Keep TOC preview clickable; edit via keyboard / double intent on chrome.
                    if (tocBlock && e.target instanceof Element) {
                      if (e.target.closest(".md-toc")) {
                        e.preventDefault();
                        return;
                      }
                    }
                    const target = e.currentTarget.querySelector(
                      ".md-live__preview",
                    ) as HTMLElement | null;
                    const caret = target
                      ? caretIndexFromClick(block, e.clientX, e.clientY, target)
                      : 0;
                    if (e.shiftKey && active != null) {
                      e.preventDefault();
                      extendSelectionTo(index, caret);
                      return;
                    }
                    // 延迟到 mouseup 才进入编辑态；mousedown 不再阻止原生文本选区，复制保持可用。
                    dragSelecting.current = false;
                    lastAppliedDoc.current = null;
                    const anchorDoc = blockDocOffset(blocks, index) + caret;
                    previewDrag.current = {
                      anchorDoc,
                      focusDoc: anchorDoc,
                      startX: e.clientX,
                      startY: e.clientY,
                      moved: false,
                      crossed: false,
                    };
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
                        (event.ctrlKey || event.metaKey) &&
                        externalHrefFromEvent(event.target)
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                        return;
                      }
                      if (
                        event.target instanceof Element &&
                        (event.target.closest(".md-code__copy") ||
                          event.target.closest(".md-toc a") ||
                          event.target.closest("a[href]"))
                      ) {
                        event.stopPropagation();
                      }
                    }}
                    onClick={(event) => {
                      if (tryOpenExternalLink(event, event.target)) return;
                      const tocId = tocLinkFromEvent(event.target);
                      if (tocId) {
                        event.preventDefault();
                        event.stopPropagation();
                        jumpToHeadingId(tocId);
                        return;
                      }
                      // Block in-app navigation; use Ctrl/Cmd+click to open externally.
                      if (externalHrefFromEvent(event.target)) {
                        event.preventDefault();
                        event.stopPropagation();
                        return;
                      }
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
          <div
            className="md-live__spacer"
            style={{
              height: Math.max(
                0,
                rowMetrics.total -
                  ((rowMetrics.offsets[virtualRange.end] ?? rowMetrics.total) as number),
              ),
            }}
            aria-hidden
          />
        </div>
      </div>
    </div>
  );
}
