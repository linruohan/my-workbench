import MarkdownIt from "markdown-it";
import { extractImageSlots, isSafeCssColor, type ImageSlot } from "@wb/domain";
import { renderCodeBlock } from "./code-block";

type BlockState = {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  sCount?: number[];
  blkIndent?: number;
  line: number;
  push: (
    type: string,
    tag: string,
    nesting: number,
  ) => {
    markup: string;
    map: [number, number] | null;
    content: string;
    children: unknown[] | null;
  };
};

/** ATX headings from one to eight hashes. markdown-it itself stops at h6. */
function atxHeading(
  state: BlockState,
  startLine: number,
  _endLine: number,
  silent: boolean,
): boolean {
  const src = state.src;
  if ((state.sCount?.[startLine] ?? 0) - (state.blkIndent ?? 0) >= 4) return false;
  const start = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0);
  let max = state.eMarks[startLine] ?? start;
  if (src.charCodeAt(start) !== 0x23) return false;

  let level = 0;
  let pos = start;
  while (pos < max && src.charCodeAt(pos) === 0x23 && level < 8) {
    level += 1;
    pos += 1;
  }
  if (level < 1) return false;
  const after = src.charCodeAt(pos);
  if (pos < max && after !== 0x20 && after !== 0x09) return false;
  if (silent) return true;

  while (pos < max && (src.charCodeAt(pos) === 0x20 || src.charCodeAt(pos) === 0x09))
    pos += 1;
  let end = max;
  while (
    end > pos &&
    (src.charCodeAt(end - 1) === 0x20 || src.charCodeAt(end - 1) === 0x09)
  ) {
    end -= 1;
  }
  let hashes = end;
  while (hashes > pos && src.charCodeAt(hashes - 1) === 0x23) hashes -= 1;
  if (
    hashes < end &&
    hashes > pos &&
    (src.charCodeAt(hashes - 1) === 0x20 || src.charCodeAt(hashes - 1) === 0x09)
  ) {
    end = hashes;
    while (
      end > pos &&
      (src.charCodeAt(end - 1) === 0x20 || src.charCodeAt(end - 1) === 0x09)
    ) {
      end -= 1;
    }
  }

  state.line = startLine + 1;
  const markup = "#".repeat(level);
  const open = state.push("heading_open", `h${level}`, 1);
  open.markup = markup;
  open.map = [startLine, state.line];
  const inline = state.push("inline", "", 0);
  inline.content = src.slice(pos, end);
  inline.map = [startLine, state.line];
  inline.children = [];
  const close = state.push("heading_close", `h${level}`, -1);
  close.markup = markup;
  return true;
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true,
});

md.block.ruler.at(
  "heading",
  atxHeading as unknown as (
    state: unknown,
    start: number,
    end: number,
    silent: boolean,
  ) => boolean,
);

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  if (!token) return "";
  return renderCodeBlock(token.content, token.info || "");
};

function addInlinePair(name: string, marker: string, tag: string): void {
  md.inline.ruler.before("emphasis", name, (state, silent) => {
    const start = state.pos;
    if (state.src.slice(start, start + marker.length) !== marker) return false;
    const close = state.src.indexOf(marker, start + marker.length);
    if (close < 0) return false;
    if (silent) return true;
    const tokenOpen = state.push(`${name}_open`, tag, 1);
    tokenOpen.markup = marker;
    const tokenText = state.push("text", "", 0);
    tokenText.content = state.src.slice(start + marker.length, close);
    const tokenClose = state.push(`${name}_close`, tag, -1);
    tokenClose.markup = marker;
    state.pos = close + marker.length;
    return true;
  });
}

/** ==highlight== background and ++underline++. */
addInlinePair("mark", "==", "mark");
addInlinePair("underline", "++", "u");

const SAFE_SPAN_OPEN = /^<span\s+style="((?:color|background-color)\s*:\s*[^";]+)"\s*>/i;

/** Allow only color / background-color spans (html remains disabled otherwise). */
md.inline.ruler.before("emphasis", "safe_style_span", (state, silent) => {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x3c /* < */) return false;
  const slice = state.src.slice(start);
  const open = SAFE_SPAN_OPEN.exec(slice);
  if (!open?.[1]) return false;

  const styleRaw = open[1].trim();
  const parts = /^(color|background-color)\s*:\s*(.+)$/i.exec(styleRaw);
  if (!parts?.[1] || parts[2] == null) return false;
  const prop = parts[1].toLowerCase();
  const color = parts[2].trim();
  if (!isSafeCssColor(color)) return false;

  const contentStart = start + open[0].length;
  let depth = 1;
  let pos = contentStart;
  while (pos < state.posMax && depth > 0) {
    if (state.src.charCodeAt(pos) === 0x3c /* < */) {
      const rest = state.src.slice(pos);
      if (SAFE_SPAN_OPEN.test(rest)) {
        const nested = SAFE_SPAN_OPEN.exec(rest);
        if (nested) {
          depth += 1;
          pos += nested[0].length;
          continue;
        }
      }
      if (rest.toLowerCase().startsWith("</span>")) {
        depth -= 1;
        if (depth === 0) break;
        pos += 7;
        continue;
      }
    }
    pos += 1;
  }
  if (depth !== 0) return false;

  if (silent) return true;

  const tokenOpen = state.push("span_open", "span", 1);
  tokenOpen.attrs = [["style", `${prop}: ${color}`]];
  tokenOpen.markup = open[0];

  const oldMax = state.posMax;
  state.pos = contentStart;
  state.posMax = pos;
  state.md.inline.tokenize(state);
  state.pos = pos + 7;
  state.posMax = oldMax;

  const tokenClose = state.push("span_close", "span", -1);
  tokenClose.markup = "</span>";
  return true;
});

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function isDirectUrl(dest: string): boolean {
  return (
    /^https?:\/\//i.test(dest) || /^data:image\//i.test(dest) || dest.startsWith("//")
  );
}

function applyImages(
  html: string,
  slots: ImageSlot[],
  imageUrls?: Array<string | null>,
): string {
  return html.replace(/src="wbimg-(\d+)"/g, (_full, num: string) => {
    const index = Number(num);
    const slot = slots[index];
    const provided = imageUrls?.[index];
    const url = provided || (slot && isDirectUrl(slot.dest) ? slot.dest : "");
    const style =
      slot?.scale != null
        ? ` style="width:${Math.round(slot.scale * 100)}%;height:auto"`
        : "";
    if (!url) return 'src=""';
    return `src="${escapeAttr(url)}"${style}`;
  });
}

/** Render note Markdown. `imageUrls[i]` replaces the i-th image outside code fences. */
export function renderMarkdown(source: string, imageUrls?: Array<string | null>): string {
  const { markdown, slots } = extractImageSlots(source || "");
  return applyImages(md.render(markdown), slots, imageUrls);
}

/** Chat replies keep single line breaks. Note rendering stays unchanged. */
export function renderChatMarkdown(source: string): string {
  const previous = md.options.breaks;
  md.options.breaks = true;
  try {
    return renderMarkdown(source);
  } finally {
    md.options.breaks = previous;
  }
}
