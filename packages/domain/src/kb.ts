/** Knowledge-base file helpers: image refs, heading numbers, markdown highlight. */

export type ImageSlot = {
  dest: string;
  scale: number | null;
};

export type ImageTarget =
  | { kind: "remote"; url: string }
  | { kind: "local"; candidates: string[] };

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
  const absolute = unc || drive.length > 0 || path.startsWith("/") || path.startsWith("\\");
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

export function samePath(a: string, b: string): boolean {
  const norm = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
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

export function parseHtmlImage(tag: string): { src: string | null; scale: number | null } {
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

export function extractImageSlots(source: string): { markdown: string; slots: ImageSlot[] } {
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
      if (!dest) return full;
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

export function headingMeta(source: string): Array<{ level: number; label: string } | null> {
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
          { text: match?.[2] ?? "", kind: (`h${heading.level}` as HighlightKind) },
        ],
      };
    }
    return { level: null, numberLabel: null, segs: highlightInline(line) };
  });
}
