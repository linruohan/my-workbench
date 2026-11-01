import MarkdownIt from "markdown-it";
import { extractImageSlots, type ImageSlot } from "@wb/domain";

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
