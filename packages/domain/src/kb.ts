/** Knowledge-base file helpers: image refs, heading numbers, markdown highlight. */

export type ImageSlot = {
  dest: string;
  scale: number | null;
};

export type ImageTarget =
  { kind: "remote"; url: string } | { kind: "local"; candidates: string[] };

export type HighlightKind =
  | "text"
  | "hash"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "h7"
  | "h8"
  | "strong"
  | "em"
  | "code"
  | "link"
  | "image"
  | "quote"
  | "list"
  | "hr"
  | "fence";

export type HighlightSeg = { text: string; kind: HighlightKind };

export type HighlightLine = {
  level: number | null;
  numberLabel: string | null;
  segs: HighlightSeg[];
};

const MD_EXTS = new Set(["md", "markdown", "mdown", "mkd"]);
const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif",
  "ico",
]);
const TEXT_EXTS = new Set([
  "txt",
  "json",
  "csv",
  "log",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rs",
  "toml",
  "yml",
  "yaml",
  "ini",
  "cfg",
  "conf",
  "sh",
  "ps1",
  "bat",
  "sql",
  "java",
  "go",
  "c",
  "h",
  "cpp",
  "hpp",
  "vue",
  "svelte",
  "rb",
  "php",
  "lua",
  "zig",
  "kt",
  "swift",
  "env",
]);

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})/;
const ATX_RE = /^(#{1,8})([ \t]+.*|[ \t]*)$/;
const MD_IMAGE_RE = /!\[([^\]]*)\]\((<[^>\n]+>|[^)\n]+)\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*>/gi;

export function fileNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] ?? trimmed;
}

export function fileExtension(name: string): string {
  const base = fileNameOf(name);
  const i = base.lastIndexOf(".");
  if (i <= 0) return "";
  return base.slice(i + 1).toLowerCase();
}

export function fileStem(path: string): string {
  const base = fileNameOf(path);
  const ext = fileExtension(base);
  const stem = ext ? base.slice(0, -(ext.length + 1)) : base;
  return safeStem(stem);
}

export function safeStem(name: string): string {
  const stem = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return stem || "image";
}

export function isMarkdownFile(name: string): boolean {
  return MD_EXTS.has(fileExtension(name));
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXTS.has(fileExtension(name));
}

export function isTextFile(name: string): boolean {
  const ext = fileExtension(name);
  if (!ext) {
    const base = fileNameOf(name).toLowerCase();
    return base === "license" || base === "readme" || base === "dockerfile";
  }
  return TEXT_EXTS.has(ext);
}

export function imageMime(path: string): string {
  switch (fileExtension(path)) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "avif":
      return "image/avif";
    case "ico":
      return "image/x-icon";
    default:
      return "image/png";
  }
}

export function parentDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return "";
  if (/^[a-zA-Z]:$/.test(trimmed.slice(0, idx))) return trimmed.slice(0, idx) + "\\";
  if (idx === 0) return trimmed[0] === "\\" ? "\\" : "/";
  return trimmed.slice(0, idx);
}

export function normalizePath(path: string): string {
  const unc = path.startsWith("\\\\") || path.startsWith("//");
  const drive = /^[a-zA-Z]:/.exec(path)?.[0] ?? "";
  const absolute =
    unc || drive.length > 0 || path.startsWith("/") || path.startsWith("\\");
  const sep = path.includes("\\") ? "\\" : "/";
  const rest = drive ? path.slice(drive.length) : path;
  const rawParts = rest.split(/[/\\]/).filter((part) => part.length > 0 && part !== ".");
  const stack: string[] = [];
  for (const part of rawParts) {
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
      else if (!absolute) stack.push("..");
    } else {
      stack.push(part);
    }
  }
  const body = stack.join(sep);
  if (unc) return "\\\\" + body;
  if (drive) return body ? drive + sep + body : drive + sep;
  if (path.startsWith("/") || path.startsWith("\\")) return sep + body;
  return body;
}

export function joinPath(dir: string, rel: string): string {
  if (!dir) return normalizePath(rel);
  if (isAbsolutePath(rel)) return normalizePath(rel);
  const sep = dir.includes("\\") ? "\\" : "/";
  return normalizePath(dir.replace(/[\\/]+$/, "") + sep + rel);
}

export function isAbsolutePath(path: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.startsWith("\\\\") ||
    path.startsWith("/") ||
    path.startsWith("\\")
  );
}

export function pathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** True when `child` is inside `parent` or equal to it. */
export function isPathUnder(parent: string, child: string): boolean {
  const root = pathKey(parent);
  const target = pathKey(child);
  return target === root || target.startsWith(root + "/");
}

const IGNORED_KB_NAMES = new Set([
  ".git",
  ".svn",
  ".hg",
  ".obsidian",
  ".trash",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "dist",
  "build",
  ".idea",
  ".vscode",
]);

/** Skip noisy VCS/tooling folders in the knowledge tree. */
export function isIgnoredKbName(name: string): boolean {
  if (!name || name === "." || name === "..") return true;
  if (IGNORED_KB_NAMES.has(name)) return true;
  return false;
}

export function indentMarkdownSelection(
  text: string,
  start: number,
  end: number,
  indent = "  ",
): { text: string; start: number; end: number } {
  const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const lineEnd = (() => {
    const next = text.indexOf("\n", end);
    return next === -1 ? text.length : next;
  })();
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const nextBlock = lines.map((line) => indent + line).join("\n");
  return {
    text: text.slice(0, lineStart) + nextBlock + text.slice(lineEnd),
    start: start + indent.length,
    end: end + indent.length * lines.length,
  };
}

export function outdentMarkdownSelection(
  text: string,
  start: number,
  end: number,
): { text: string; start: number; end: number } {
  const lineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const lineEnd = (() => {
    const next = text.indexOf("\n", end);
    return next === -1 ? text.length : next;
  })();
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  let removedBefore = 0;
  let removedTotal = 0;
  const nextLines = lines.map((line, index) => {
    const match = /^( {1,2}|\t)/.exec(line);
    const drop = match?.[1]?.length ?? 0;
    if (index === 0) removedBefore = drop;
    removedTotal += drop;
    return drop > 0 ? line.slice(drop) : line;
  });
  return {
    text: text.slice(0, lineStart) + nextLines.join("\n") + text.slice(lineEnd),
    start: Math.max(lineStart, start - removedBefore),
    end: Math.max(lineStart, end - removedTotal),
  };
}

/**
 * Wrap or unwrap the current selection (supports multi-line).
 * Empty selection inserts markers and places the caret between them.
 */
export function wrapMarkdownSelection(
  text: string,
  start: number,
  end: number,
  prefix: string,
  suffix = prefix,
): { text: string; start: number; end: number } {
  const selected = text.slice(start, end);
  if (
    selected.length >= prefix.length + suffix.length &&
    selected.startsWith(prefix) &&
    selected.endsWith(suffix)
  ) {
    const inner = selected.slice(prefix.length, selected.length - suffix.length);
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      start,
      end: start + inner.length,
    };
  }

  // Multi-line: wrap each non-empty line so bold/highlight stays per-line.
  if (selected.includes("\n")) {
    const wrapped = selected
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        if (line.startsWith(prefix) && line.endsWith(suffix)) {
          return line.slice(prefix.length, line.length - suffix.length);
        }
        return `${prefix}${line}${suffix}`;
      })
      .join("\n");
    return {
      text: text.slice(0, start) + wrapped + text.slice(end),
      start,
      end: start + wrapped.length,
    };
  }

  const next = `${prefix}${selected}${suffix}`;
  return {
    text: text.slice(0, start) + next + text.slice(end),
    start: start + prefix.length,
    end: start + prefix.length + selected.length,
  };
}

export type InlineStyleKind = "color" | "background";

export const TEXT_COLOR_PRESETS = [
  { id: "default", label: "默认", value: null },
  { id: "rose", label: "红", value: "#e11d48" },
  { id: "orange", label: "橙", value: "#ea580c" },
  { id: "amber", label: "黄", value: "#ca8a04" },
  { id: "green", label: "绿", value: "#16a34a" },
  { id: "teal", label: "青", value: "#0d9488" },
  { id: "blue", label: "蓝", value: "#2563eb" },
  { id: "violet", label: "紫", value: "#7c3aed" },
  { id: "pink", label: "粉", value: "#db2777" },
  { id: "gray", label: "灰", value: "#6b7280" },
] as const;

export const BG_COLOR_PRESETS = [
  { id: "default", label: "默认", value: null },
  { id: "rose", label: "红", value: "#fecdd3" },
  { id: "orange", label: "橙", value: "#fed7aa" },
  { id: "amber", label: "黄", value: "#fef08a" },
  { id: "green", label: "绿", value: "#bbf7d0" },
  { id: "teal", label: "青", value: "#99f6e4" },
  { id: "blue", label: "蓝", value: "#bfdbfe" },
  { id: "violet", label: "紫", value: "#ddd6fe" },
  { id: "pink", label: "粉", value: "#fbcfe8" },
  { id: "gray", label: "灰", value: "#e5e7eb" },
] as const;

const SAFE_COLOR =
  /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)|[a-zA-Z]+)$/;

export function isSafeCssColor(value: string): boolean {
  return SAFE_COLOR.test(value.trim());
}

function styleProp(kind: InlineStyleKind): string {
  return kind === "color" ? "color" : "background-color";
}

function stripStyleSpan(selected: string, kind: InlineStyleKind): string {
  const prop = styleProp(kind);
  const openRe = new RegExp(`^(\\s*)<span\\s+style="${prop}:\\s*[^"]+"\\s*>`, "i");
  let result = selected;
  for (;;) {
    const match = openRe.exec(result);
    if (!match) break;
    const trail = result.match(/\s*$/)?.[0] ?? "";
    const core = result.slice(0, result.length - trail.length);
    if (!core.toLowerCase().endsWith("</span>")) break;
    const lead = match[1] ?? "";
    result = lead + core.slice(match[0].length, core.length - "</span>".length) + trail;
  }
  return result;
}

function wrapStyleSpan(inner: string, kind: InlineStyleKind, color: string): string {
  const prop = styleProp(kind);
  const cleaned = stripStyleSpan(inner, kind);
  return `<span style="${prop}: ${color}">${cleaned}</span>`;
}

/** Apply or clear text/background color on the selection (multi-line aware). */
export function styleMarkdownSelection(
  text: string,
  start: number,
  end: number,
  kind: InlineStyleKind,
  color: string | null,
): { text: string; start: number; end: number } {
  if (color != null && !isSafeCssColor(color)) {
    return { text, start, end };
  }
  const selected = text.slice(start, end);
  const transform = (chunk: string) => {
    if (!chunk.trim()) return chunk;
    if (color == null) return stripStyleSpan(chunk, kind);
    return wrapStyleSpan(chunk, kind, color.trim());
  };

  if (selected.includes("\n")) {
    const wrapped = selected.split("\n").map(transform).join("\n");
    return {
      text: text.slice(0, start) + wrapped + text.slice(end),
      start,
      end: start + wrapped.length,
    };
  }

  const next = transform(selected);
  const openLen = color ? `<span style="${styleProp(kind)}: ${color.trim()}">`.length : 0;
  return {
    text: text.slice(0, start) + next + text.slice(end),
    start: color ? start + openLen : start,
    end: color
      ? start + openLen + stripStyleSpan(selected, kind).length
      : start + next.length,
  };
}

/** Inclusive line span covering the caret/selection (selection ending on `\n` stays on that line). */
export function selectedLineRange(
  text: string,
  start: number,
  end: number,
): { lineStart: number; lineEnd: number } {
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const adjustedTo = to > from && text[to - 1] === "\n" ? to - 1 : to;
  const lineStart = text.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  const nl = text.indexOf("\n", adjustedTo);
  const lineEnd = nl === -1 ? text.length : nl;
  return { lineStart, lineEnd };
}

/**
 * Cut/delete whole lines covered by the caret or selection.
 * `cut` is the removed text (including a trailing newline when present).
 */
export function cutSelectedLines(
  text: string,
  start: number,
  end: number,
): { text: string; start: number; end: number; cut: string } {
  const { lineStart, lineEnd } = selectedLineRange(text, start, end);
  if (lineEnd < text.length && text[lineEnd] === "\n") {
    const cut = text.slice(lineStart, lineEnd + 1);
    return {
      text: text.slice(0, lineStart) + text.slice(lineEnd + 1),
      start: lineStart,
      end: lineStart,
      cut,
    };
  }
  // Last line: drop the preceding newline so we do not leave a trailing blank line.
  if (lineStart > 0) {
    const cut = text.slice(lineStart - 1, lineEnd);
    return {
      text: text.slice(0, lineStart - 1) + text.slice(lineEnd),
      start: lineStart - 1,
      end: lineStart - 1,
      cut,
    };
  }
  const cut = text.slice(lineStart, lineEnd);
  return { text: "", start: 0, end: 0, cut };
}

function mapSelectedLines(
  text: string,
  start: number,
  end: number,
  mapLines: (lines: string[]) => string[],
): { text: string; start: number; end: number } {
  const { lineStart, lineEnd } = selectedLineRange(text, start, end);
  const block = text.slice(lineStart, lineEnd);
  const nextBlock = mapLines(block.split("\n")).join("\n");
  return {
    text: text.slice(0, lineStart) + nextBlock + text.slice(lineEnd),
    start: lineStart,
    end: lineStart + nextBlock.length,
  };
}

/** Sort selected lines alphabetically (localeCompare). */
export function sortSelectedLines(
  text: string,
  start: number,
  end: number,
  direction: "asc" | "desc" = "asc",
): { text: string; start: number; end: number } {
  return mapSelectedLines(text, start, end, (lines) => {
    const sorted = [...lines].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    return direction === "desc" ? sorted.reverse() : sorted;
  });
}

/** Remove duplicate lines in the selection (keep first occurrence). */
export function dedupeSelectedLines(
  text: string,
  start: number,
  end: number,
): { text: string; start: number; end: number } {
  return mapSelectedLines(text, start, end, (lines) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of lines) {
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
    return out;
  });
}

export type FindReplaceOptions = {
  query: string;
  replace?: string;
  regex?: boolean;
  matchCase?: boolean;
  wholeWord?: boolean;
  /** Limit search to [selectionStart, selectionEnd). */
  inSelection?: boolean;
  selectionStart?: number;
  selectionEnd?: number;
  /** Preserve case patterns when replacing (foo→bar, Foo→Bar, FOO→BAR). */
  preserveCase?: boolean;
};

export type TextMatch = { start: number; end: number };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildFindRegExp(
  query: string,
  options: Pick<FindReplaceOptions, "regex" | "matchCase" | "wholeWord">,
): RegExp | null {
  if (!query) return null;
  let source: string;
  if (options.regex) {
    source = query;
  } else {
    source = escapeRegExp(query);
  }
  if (options.wholeWord) {
    source = `\\b(?:${source})\\b`;
  }
  const flags = options.matchCase ? "g" : "gi";
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function searchWindow(
  text: string,
  options: FindReplaceOptions,
): { haystack: string; offset: number } {
  if (
    options.inSelection &&
    options.selectionStart != null &&
    options.selectionEnd != null &&
    options.selectionEnd > options.selectionStart
  ) {
    return {
      haystack: text.slice(options.selectionStart, options.selectionEnd),
      offset: options.selectionStart,
    };
  }
  return { haystack: text, offset: 0 };
}

/** All matches in document (or selection). */
export function findAllMatches(text: string, options: FindReplaceOptions): TextMatch[] {
  const re = buildFindRegExp(options.query, options);
  if (!re) return [];
  const { haystack, offset } = searchWindow(text, options);
  const matches: TextMatch[] = [];
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(haystack))) {
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    matches.push({
      start: offset + match.index,
      end: offset + match.index + match[0].length,
    });
    if (matches.length > 10000) break;
  }
  return matches;
}

export function findNextMatch(
  text: string,
  options: FindReplaceOptions,
  from: number,
  reverse = false,
): TextMatch | null {
  const matches = findAllMatches(text, options);
  if (matches.length === 0) return null;
  if (reverse) {
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const m = matches[i]!;
      if (m.start < from) return m;
    }
    return matches[matches.length - 1] ?? null;
  }
  for (const m of matches) {
    if (m.start >= from) return m;
  }
  return matches[0] ?? null;
}

function applyPreserveCase(sample: string, replacement: string): string {
  if (!sample || !replacement) return replacement;
  if (sample === sample.toUpperCase()) return replacement.toUpperCase();
  if (sample === sample.toLowerCase()) return replacement.toLowerCase();
  if (
    sample[0] === sample[0]?.toUpperCase() &&
    sample.slice(1) === sample.slice(1).toLowerCase()
  ) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
  }
  return replacement;
}

/** Replace using the same pattern that found `match` (supports `$1` groups when regex). */
export function replaceMatchWithQuery(
  text: string,
  match: TextMatch,
  query: string,
  replacement: string,
  options: Pick<FindReplaceOptions, "regex" | "matchCase" | "wholeWord" | "preserveCase">,
): { text: string; start: number; end: number } {
  const matched = text.slice(match.start, match.end);
  let next = replacement;
  if (options.regex) {
    const re = buildFindRegExp(query, {
      regex: true,
      matchCase: options.matchCase,
      wholeWord: options.wholeWord,
    });
    if (re) {
      re.lastIndex = 0;
      next = matched.replace(re, replacement);
    }
  }
  if (options.preserveCase) next = applyPreserveCase(matched, next);
  const out = text.slice(0, match.start) + next + text.slice(match.end);
  return { text: out, start: match.start, end: match.start + next.length };
}

export function replaceAllMatches(
  text: string,
  options: FindReplaceOptions & { replace: string },
): { text: string; count: number } {
  const matches = findAllMatches(text, options);
  if (matches.length === 0) return { text, count: 0 };
  let out = text;
  // Replace from the end so earlier offsets stay valid.
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const m = matches[i]!;
    const next = replaceMatchWithQuery(out, m, options.query, options.replace, options);
    out = next.text;
  }
  return { text: out, count: matches.length };
}

/** Map a document offset into a block index / local caret (blocks joined by `\n`). */
export function locateInBlocks(
  blocks: string[],
  offset: number,
): { index: number; offset: number } {
  let cursor = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    const len = (blocks[i] ?? "").length;
    if (offset <= cursor + len) {
      return { index: i, offset: Math.max(0, offset - cursor) };
    }
    cursor += len + 1;
  }
  const last = Math.max(0, blocks.length - 1);
  return { index: last, offset: (blocks[last] ?? "").length };
}

export function blockDocOffset(blocks: string[], index: number): number {
  let offset = 0;
  for (let i = 0; i < index; i += 1) {
    offset += (blocks[i] ?? "").length + 1;
  }
  return offset;
}

/** ImagePaste: `{stem}/{stem}{index}.png` beside the markdown file. */
export function pastedImageRel(
  stem: string,
  index: number,
  imageDirName?: string | null,
): string {
  const dir = imageDirName && imageDirName.length > 0 ? imageDirName : stem;
  return `${dir}/${stem}${index}.png`.replace(/\\/g, "/");
}

export function pastedImageAbs(
  parent: string,
  stem: string,
  index: number,
  imageDirName?: string | null,
): string {
  return joinPath(parent, pastedImageRel(stem, index, imageDirName));
}

export function imageDestination(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }
  const titled = /^(.*\S)\s+(?:"[^"]*"|'[^']*')\s*$/.exec(trimmed);
  if (titled?.[1]) return titled[1].trim();
  return trimmed;
}

export function parseHtmlImage(tag: string): {
  src: string | null;
  scale: number | null;
} {
  const match = /src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  if (!match) return { src: null, scale: null };
  const src = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  const zoom = /zoom\s*:\s*(\d+(?:\.\d+)?)\s*%/i.exec(tag);
  const scale = zoom?.[1] ? Number(zoom[1]) / 100 : null;
  return { src: src || null, scale: scale && Number.isFinite(scale) ? scale : null };
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/%20/gi, " ");
  }
}

function fileUrlToPath(url: string): string {
  const stripped = url.replace(/^file:\/\//i, "");
  const decoded = decodePath(stripped);
  if (/^\/[a-zA-Z]:/.test(decoded)) return decoded.slice(1).replace(/\//g, "\\");
  return decoded;
}

function pushCandidate(list: string[], path: string) {
  const next = normalizePath(path);
  if (!next || list.includes(next)) return;
  list.push(next);
}

/**
 * Resolve a markdown image destination the way the Sublime Markdown Images
 * plugin does: remote http(s), file-relative paths, %20, and an imgs/ fallback.
 */
export function resolveImageTarget(dest: string, baseDir: string | null): ImageTarget {
  const raw = dest.trim();
  if (!raw) return { kind: "local", candidates: [] };
  if (/^https?:\/\//i.test(raw) || /^data:image\//i.test(raw) || raw.startsWith("//")) {
    return { kind: "remote", url: raw };
  }
  let pathPart = /^file:/i.test(raw) ? fileUrlToPath(raw) : raw;
  if (!/^[a-zA-Z]:/.test(pathPart)) {
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(pathPart);
    if (scheme && scheme[1]?.toLowerCase() !== "file") {
      return { kind: "local", candidates: [] };
    }
  }
  pathPart = decodePath(pathPart);
  const candidates: string[] = [];
  if (isAbsolutePath(pathPart)) {
    pushCandidate(candidates, pathPart);
    return { kind: "local", candidates };
  }
  if (baseDir) {
    pushCandidate(candidates, joinPath(baseDir, pathPart));
    const name = fileNameOf(pathPart);
    if (name && name !== "." && name !== "..") {
      pushCandidate(candidates, joinPath(baseDir, "imgs/" + name));
      const parent = parentDir(baseDir);
      if (parent && !samePath(parent, baseDir)) {
        pushCandidate(candidates, joinPath(parent, "imgs/" + name));
      }
    }
  } else {
    pushCandidate(candidates, pathPart);
  }
  return { kind: "local", candidates };
}

/** Extra relative locations searched when the direct path is missing. */
export function nestedImageDirs(baseDir: string): string[] {
  return [baseDir, parentDir(baseDir)].filter((dir, index, all) => {
    return dir.length > 0 && all.findIndex((item) => samePath(item, dir)) === index;
  });
}

function fenceChar(line: string): string | null {
  const match = FENCE_RE.exec(line);
  return match?.[2]?.[0] ?? null;
}

export function extractImageSlots(source: string): {
  markdown: string;
  slots: ImageSlot[];
} {
  const slots: ImageSlot[] = [];
  const lines = source.split(/\r?\n/);
  let fence: string | null = null;
  const out = lines.map((line) => {
    const mark = fenceChar(line);
    if (mark) {
      if (!fence) fence = mark;
      else if (fence === mark) fence = null;
      return line;
    }
    if (fence) return line;
    const mdRe = new RegExp(MD_IMAGE_RE.source, "g");
    const htmlRe = new RegExp(HTML_IMAGE_RE.source, "gi");
    let next = line.replace(mdRe, (_full, alt: string, inner: string) => {
      const dest = imageDestination(inner);
      if (!dest) return _full;
      const id = slots.length;
      slots.push({ dest, scale: null });
      return `![${alt}](wbimg-${id})`;
    });
    next = next.replace(htmlRe, (tag) => {
      const parsed = parseHtmlImage(tag);
      if (!parsed.src) return tag;
      const id = slots.length;
      slots.push({ dest: parsed.src, scale: parsed.scale });
      return `![](wbimg-${id})`;
    });
    return next;
  });
  return { markdown: out.join("\n"), slots };
}

export function headingMeta(
  source: string,
): Array<{ level: number; label: string } | null> {
  const lines = source.split(/\r?\n/);
  const counts = [0, 0, 0, 0, 0, 0, 0, 0];
  let fence: string | null = null;
  return lines.map((line) => {
    const mark = fenceChar(line);
    if (mark) {
      if (!fence) fence = mark;
      else if (fence === mark) fence = null;
      return null;
    }
    if (fence) return null;
    const match = ATX_RE.exec(line);
    if (!match?.[1]) return null;
    const level = match[1].length;
    if (level < 1 || level > 8) return null;
    const after = match[2] ?? "";
    if (after.length > 0 && !/^[ \t]/.test(after) && after.trim().length > 0) return null;
    counts[level - 1] = (counts[level - 1] ?? 0) + 1;
    for (let i = level; i < counts.length; i += 1) counts[i] = 0;
    const label = counts.slice(0, level).join(".");
    return { level, label };
  });
}

/** Leading auto-number already present in a heading title (`2.3 标题`). */
const HEADING_NUMBER_PREFIX = /^(\d+(?:\.\d+)*)\.?[ \t]+(.*)$/;

/** Strip a leading outline number from heading title text. */
export function stripHeadingNumber(title: string): string {
  const match = HEADING_NUMBER_PREFIX.exec(title.trim());
  return match?.[2] != null ? match[2] : title.trim();
}

/**
 * Write outline numbers into ATX headings so source matches render.
 * Replaces an existing leading number (`### 2.3 标题` → correct label).
 */
export function applyHeadingNumbers(source: string): string {
  const lines = (source ?? "").split(/\r?\n/);
  const counts = [0, 0, 0, 0, 0, 0, 0, 0];
  let fence: string | null = null;
  const out = lines.map((line) => {
    const mark = fenceChar(line);
    if (mark) {
      if (!fence) fence = mark;
      else if (fence === mark) fence = null;
      return line;
    }
    if (fence) return line;
    const match = ATX_RE.exec(line);
    if (!match?.[1]) return line;
    const hashes = match[1];
    const level = hashes.length;
    if (level < 1 || level > 8) return line;
    const after = match[2] ?? "";
    if (after.length > 0 && !/^[ \t]/.test(after) && after.trim().length > 0) {
      return line;
    }
    let title = after.replace(/^[ \t]+/, "").replace(/[ \t]+#*[ \t]*$/, "");
    title = stripHeadingNumber(title);
    counts[level - 1] = (counts[level - 1] ?? 0) + 1;
    for (let i = level; i < counts.length; i += 1) counts[i] = 0;
    const label = counts.slice(0, level).join(".");
    return title ? `${hashes} ${label} ${title}` : `${hashes} ${label}`;
  });
  return out.join("\n");
}

function highlightInline(line: string): HighlightSeg[] {
  const segs: HighlightSeg[] = [];
  let i = 0;
  if (line.startsWith(">")) {
    const quote = /^>\s?/.exec(line);
    if (quote) {
      segs.push({ text: quote[0], kind: "quote" });
      i = quote[0].length;
    }
  } else {
    const list = /^(\s*)([-*+]|\d+[.)])\s/.exec(line);
    if (list) {
      segs.push({ text: list[0], kind: "list" });
      i = list[0].length;
    }
  }
  let buf = "";
  const flush = () => {
    if (!buf) return;
    segs.push({ text: buf, kind: "text" });
    buf = "";
  };
  while (i < line.length) {
    if (line.startsWith("**", i) || line.startsWith("__", i)) {
      const marker = line.slice(i, i + 2);
      const end = line.indexOf(marker, i + 2);
      if (end !== -1) {
        flush();
        segs.push({ text: line.slice(i, end + 2), kind: "strong" });
        i = end + 2;
        continue;
      }
    }
    const ch = line[i];
    if ((ch === "*" || ch === "_") && line[i + 1] !== ch) {
      const end = line.indexOf(ch, i + 1);
      if (end > i + 1) {
        flush();
        segs.push({ text: line.slice(i, end + 1), kind: "em" });
        i = end + 1;
        continue;
      }
    }
    if (ch === "`") {
      const end = line.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        segs.push({ text: line.slice(i, end + 1), kind: "code" });
        i = end + 1;
        continue;
      }
    }
    const rest = line.slice(i);
    const image = /^!\[[^\]]*\]\([^)\n]*\)/.exec(rest);
    if (image) {
      flush();
      segs.push({ text: image[0], kind: "image" });
      i += image[0].length;
      continue;
    }
    const link = /^\[[^\]]*\]\([^)\n]*\)/.exec(rest);
    if (link) {
      flush();
      segs.push({ text: link[0], kind: "link" });
      i += link[0].length;
      continue;
    }
    const auto = /^https?:\/\/[^\s)]+/.exec(rest);
    if (auto) {
      flush();
      segs.push({ text: auto[0], kind: "link" });
      i += auto[0].length;
      continue;
    }
    buf += ch ?? "";
    i += 1;
  }
  flush();
  return segs.length > 0 ? segs : [{ text: line, kind: "text" }];
}

function isFenceOpen(line: string): string | null {
  return fenceChar(line);
}

function isHeadingLine(line: string): boolean {
  return ATX_RE.test(line);
}

function isHrLine(line: string): boolean {
  return /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function isImageLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^!\[[^\]]*\]\((<[^>\n]+>|[^)\n]+)\)\s*$/.test(trimmed) ||
    /^<img\b[^>]*>\s*$/i.test(trimmed)
  );
}

function isListLine(line: string): boolean {
  return /^\s*([-*+]|\d+[.)])\s+/.test(line);
}

/** GFM table row or alignment separator (kept as one live-edit block). */
export function isTableLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // | --- | :---: | ---: |
  if (/^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(t)) return true;
  // | a | b |
  if (/^\|.+\|\s*$/.test(t)) return true;
  // a | b | c  (pipe row without leading pipe)
  if (/^[^|]+(\s*\|\s*[^|]+)+\s*$/.test(t) && t.includes("|")) return true;
  return false;
}

/** Typora-style TOC markers: [toc], [TOC], [[toc]], @[toc]. */
export function isTocSource(text: string): boolean {
  return (
    /^\s*(?:@\s*)?\[\[\s*toc\s*\]\]\s*$/i.test(text.trim()) ||
    /^\s*(?:@\s*)?\[\s*toc\s*\]\s*$/i.test(text.trim())
  );
}

export type MdHeading = { level: number; text: string; id: string };

function slugifyHeading(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fff-]+/g, "");
  return slug || "heading";
}

/** Collect ATX headings outside fences (for [toc] and heading anchors). */
export function extractMdHeadings(source: string): MdHeading[] {
  const lines = (source ?? "").split(/\r?\n/);
  const out: MdHeading[] = [];
  const used = new Map<string, number>();
  let fence: string | null = null;
  for (const line of lines) {
    const open = isFenceOpen(line);
    if (open) {
      if (fence === open) fence = null;
      else if (!fence) fence = open;
      continue;
    }
    if (fence) continue;
    if (isTocSource(line)) continue;
    const m = /^(#{1,8})\s+(.+?)\s*$/.exec(line);
    if (!m?.[1] || m[2] == null) continue;
    const text = m[2].replace(/\s+#+\s*$/, "").trim();
    if (!text) continue;
    const base = slugifyHeading(text);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    const id = n === 0 ? base : `${base}-${n}`;
    out.push({ level: m[1].length, text, id });
  }
  return out;
}

function isBlockBoundaryLine(line: string): boolean {
  return (
    isHeadingLine(line) ||
    isHrLine(line) ||
    isImageLine(line) ||
    isFenceOpen(line) != null ||
    isListLine(line) ||
    isTableLine(line) ||
    isTocSource(line)
  );
}

/**
 * Split Markdown into Typora-like blocks. Joining with `\n` reconstructs the source.
 */
export function splitMdBlocks(source: string): string[] {
  const lines = (source ?? "").split(/\r?\n/);
  if (lines.length === 0) return [""];
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = isFenceOpen(line);
    if (fence) {
      let j = i + 1;
      while (j < lines.length) {
        const close = isFenceOpen(lines[j] ?? "");
        if (close === fence) {
          j += 1;
          break;
        }
        j += 1;
      }
      blocks.push(lines.slice(i, j).join("\n"));
      i = j;
      continue;
    }
    if (line.trim() === "") {
      blocks.push("");
      i += 1;
      continue;
    }
    if (isTocSource(line) || isHeadingLine(line) || isHrLine(line) || isImageLine(line)) {
      blocks.push(line);
      i += 1;
      continue;
    }
    if (isTableLine(line)) {
      let j = i + 1;
      while (j < lines.length && isTableLine(lines[j] ?? "")) j += 1;
      blocks.push(lines.slice(i, j).join("\n"));
      i = j;
      continue;
    }
    if (isListLine(line)) {
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j] ?? "";
        if (next.trim() === "") break;
        if (isListLine(next) || /^\s{2,}\S/.test(next)) {
          j += 1;
          continue;
        }
        break;
      }
      blocks.push(lines.slice(i, j).join("\n"));
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j] ?? "";
      if (next.trim() === "" || isBlockBoundaryLine(next)) break;
      j += 1;
    }
    blocks.push(lines.slice(i, j).join("\n"));
    i = j;
  }
  return blocks.length > 0 ? blocks : [""];
}

export function joinMdBlocks(blocks: string[]): string {
  return blocks.join("\n");
}

export function isCompleteFenceBlock(text: string): boolean {
  const lines = text.split("\n");
  if (lines.length < 2) return false;
  const open = fenceChar(lines[0] ?? "");
  if (!open) return false;
  for (let i = 1; i < lines.length; i += 1) {
    if (fenceChar(lines[i] ?? "") === open) return true;
  }
  return false;
}

/** Drop trailing blanks after a closed fence so re-splitting does not create empty blocks. */
export function trimFenceBlock(text: string): string {
  const lines = text.split("\n");
  const open = fenceChar(lines[0] ?? "");
  if (!open) return text;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (fenceChar(lines[i] ?? "") === open) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx < 0) return text;
  return lines.slice(0, closeIdx + 1).join("\n");
}

/**
 * Tidy closed fences and keep blank lines editable.
 * Preserves mid-document blank lines; keeps a single trailing blank so the
 * caret can always move below the last content line.
 * Also re-joins table rows that were split into adjacent blocks while typing.
 */
export function normalizeMdBlocks(blocks: string[]): string[] {
  const cleaned: string[] = [];
  for (const raw of blocks) {
    const block = isCompleteFenceBlock(raw) ? trimFenceBlock(raw) : raw;
    const prev = cleaned[cleaned.length - 1];
    if (
      prev != null &&
      prev !== "" &&
      block !== "" &&
      prev.split("\n").every(isTableLine) &&
      block.split("\n").every(isTableLine)
    ) {
      cleaned[cleaned.length - 1] = `${prev}\n${block}`;
      continue;
    }
    cleaned.push(block);
  }
  while (
    cleaned.length > 1 &&
    cleaned[cleaned.length - 1] === "" &&
    cleaned[cleaned.length - 2] === ""
  ) {
    cleaned.pop();
  }
  if (cleaned.length === 0) return [""];
  if (cleaned[cleaned.length - 1] !== "") cleaned.push("");
  return cleaned;
}

export function blockLineCount(block: string): number {
  if (block === "") return 1;
  return block.split("\n").length;
}

export function countDocLines(blocks: string[]): number {
  if (blocks.length === 0) return 1;
  return blocks.reduce((sum, block) => sum + blockLineCount(block), 0);
}

/** Map a 1-based document line number to block index + caret offset. */
export function locateLineInBlocks(
  blocks: string[],
  line1Based: number,
): { index: number; offset: number } {
  if (blocks.length === 0) return { index: 0, offset: 0 };
  const target = Math.max(1, Math.floor(line1Based));
  let line = 1;
  for (let i = 0; i < blocks.length; i += 1) {
    const text = blocks[i] ?? "";
    const count = blockLineCount(text);
    if (target < line + count) {
      const local = target - line;
      if (text === "") return { index: i, offset: 0 };
      const parts = text.split("\n");
      let offset = 0;
      for (let j = 0; j < local; j += 1) {
        offset += (parts[j] ?? "").length + 1;
      }
      return { index: i, offset };
    }
    line += count;
  }
  const last = blocks.length - 1;
  return { index: last, offset: (blocks[last] ?? "").length };
}

export function highlightMarkdown(source: string): HighlightLine[] {
  const lines = source.split(/\r?\n/);
  const meta = headingMeta(source);
  let fence: string | null = null;
  return lines.map((line, index) => {
    const mark = fenceChar(line);
    if (mark) {
      if (!fence) fence = mark;
      else if (fence === mark) fence = null;
      return { level: null, numberLabel: null, segs: [{ text: line, kind: "fence" }] };
    }
    if (fence) {
      return { level: null, numberLabel: null, segs: [{ text: line, kind: "fence" }] };
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      return { level: null, numberLabel: null, segs: [{ text: line, kind: "hr" }] };
    }
    const heading = meta[index];
    if (heading) {
      const match = /^(#{1,8})([\s\S]*)$/.exec(line);
      return {
        level: heading.level,
        numberLabel: heading.label,
        segs: [
          { text: match?.[1] ?? "", kind: "hash" },
          { text: match?.[2] ?? "", kind: `h${heading.level}` as HighlightKind },
        ],
      };
    }
    return { level: null, numberLabel: null, segs: highlightInline(line) };
  });
}
