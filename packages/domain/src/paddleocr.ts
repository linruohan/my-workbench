import type { ProviderKind } from "./agent.js";

/** Directory under the app config folder. */
export const PADDLEOCR_DIR = "models/paddleocr";

export type PaddleOcrFile = {
  name: string;
  url: string;
  minBytes: number;
};

/** PP-OCRv6 small weights. The runtime stays in the app; these files are downloaded. */
export const PADDLEOCR_FILES: readonly PaddleOcrFile[] = [
  {
    name: "PP-OCRv6_det_small.onnx",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx",
    minBytes: 800_000,
  },
  {
    name: "PP-OCRv6_rec_small.onnx",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx",
    minBytes: 2_000_000,
  },
  {
    name: "ppocrv6_dict.txt",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt",
    minBytes: 10_000,
  },
];

export function missingPaddleOcrFiles(
  present: ReadonlyArray<{ name: string; size: number }>,
  files: readonly PaddleOcrFile[] = PADDLEOCR_FILES,
): PaddleOcrFile[] {
  return files.filter((file) => {
    const found = present.find((item) => item.name === file.name);
    return !found || found.size < file.minBytes;
  });
}

/** Chat and Anthropic requests can carry an image. Other kinds cannot. */
export function modelCanSeeImages(
  kind: ProviderKind,
  caps: { inputs?: readonly string[] } | null | undefined,
): boolean {
  if (!caps?.inputs?.includes("image")) return false;
  return kind === "openai-chat-completions" || kind === "anthropic-messages";
}

export function localOcrReply(lines: readonly string[]): string {
  const text = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return text || "没有识别到文字。";
}

export function imageOnlyCaption(name: string): string {
  const label = name.trim() || "图片";
  return `[图片] ${label}`;
}

/** Question plus the local recognition, for a text model that cannot see the picture. */
export function withLocalOcrContext(question: string, lines: readonly string[]): string {
  const text = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return `${question.trim()}\n\n以下是本地识图模型识别出的文字：\n${text || "（没有识别到文字）"}`;
}

export function parseOcrKeys(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** CTC greedy decode. Class 0 is blank; later classes index the dictionary. */
export function ctcDecode(ids: ArrayLike<number>, keys: readonly string[]): string {
  let prev = -1;
  let out = "";
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i] ?? 0;
    if (id !== prev && id > 0) {
      const ch = keys[id - 1];
      if (ch) out += ch;
    }
    prev = id;
  }
  return out;
}

export function argmaxRows(
  data: ArrayLike<number>,
  steps: number,
  classes: number,
): number[] {
  const ids: number[] = [];
  for (let step = 0; step < steps; step += 1) {
    let best = 0;
    let score = -Infinity;
    const offset = step * classes;
    for (let cls = 0; cls < classes; cls += 1) {
      const value = data[offset + cls] ?? -Infinity;
      if (value > score) {
        score = value;
        best = cls;
      }
    }
    ids.push(best);
  }
  return ids;
}

export type OcrBox = { x: number; y: number; w: number; h: number };

/** Connected components above the threshold, in map pixel coordinates. */
export function boxesFromMap(
  map: ArrayLike<number>,
  width: number,
  height: number,
  threshold = 0.3,
): OcrBox[] {
  if (width < 1 || height < 1 || map.length < width * height) return [];
  const seen = new Uint8Array(width * height);
  const boxes: OcrBox[] = [];
  const stack: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (seen[start] || (map[start] ?? 0) < threshold) continue;
      seen[start] = 1;
      stack.push(start);
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let count = 0;
      while (stack.length) {
        const idx = stack.pop() ?? 0;
        count += 1;
        const cx = idx % width;
        const cy = (idx - cx) / width;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        const neighbors = [idx - 1, idx + 1, idx - width, idx + width];
        for (const next of neighbors) {
          if (next < 0 || next >= width * height) continue;
          const nx = next % width;
          const ny = (next - nx) / width;
          if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
          if (seen[next] || (map[next] ?? 0) < threshold) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      if (count < 8 || w < 2 || h < 2) continue;
      boxes.push({ x: minX, y: minY, w, h });
    }
  }
  return boxes;
}

export function scaleBoxes(
  boxes: readonly OcrBox[],
  fromW: number,
  fromH: number,
  toW: number,
  toH: number,
): OcrBox[] {
  const sx = toW / Math.max(1, fromW);
  const sy = toH / Math.max(1, fromH);
  return boxes.map((box) => ({
    x: Math.max(0, Math.floor(box.x * sx)),
    y: Math.max(0, Math.floor(box.y * sy)),
    w: Math.max(1, Math.round(box.w * sx)),
    h: Math.max(1, Math.round(box.h * sy)),
  }));
}

export function padBox(
  box: OcrBox,
  imageW: number,
  imageH: number,
  ratio = 0.08,
): OcrBox {
  const dx = Math.round(box.w * ratio);
  const dy = Math.round(box.h * ratio);
  const x = Math.max(0, box.x - dx);
  const y = Math.max(0, box.y - dy);
  const right = Math.min(imageW, box.x + box.w + dx);
  const bottom = Math.min(imageH, box.y + box.h + dy);
  return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
}

export function sortBoxes<T extends OcrBox>(boxes: readonly T[]): T[] {
  const sorted = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: T[][] = [];
  for (const box of sorted) {
    const line = lines[lines.length - 1];
    const mid = line?.[0];
    if (!line || !mid) {
      lines.push([box]);
      continue;
    }
    if (Math.abs(box.y - mid.y) < Math.max(box.h, mid.h) * 0.5) line.push(box);
    else lines.push([box]);
  }
  return lines.flatMap((line) => line.sort((a, b) => a.x - b.x));
}

export function selectOcrBoxes(boxes: readonly OcrBox[], limit = 40): OcrBox[] {
  const ranked = [...boxes].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, limit);
  return sortBoxes(ranked);
}

/** Detection input, snapped to a multiple of 32 and capped on the long side. */
export function detInputSize(
  width: number,
  height: number,
  limit = 960,
): { width: number; height: number } {
  const maxSide = Math.max(width, height, 1);
  const ratio = maxSide > limit ? limit / maxSide : 1;
  const snap = (value: number) => Math.max(32, Math.round((value * ratio) / 32) * 32);
  return { width: snap(width), height: snap(height) };
}

/** RGB NCHW, normalized the way PP-OCRv4 expects: (pixel / 255 - 0.5) / 0.5. */
export function pixelsToNchw(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
): Float32Array {
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    const offset = i * 4;
    out[i] = ((pixels[offset] ?? 0) / 255 - 0.5) / 0.5;
    out[plane + i] = ((pixels[offset + 1] ?? 0) / 255 - 0.5) / 0.5;
    out[2 * plane + i] = ((pixels[offset + 2] ?? 0) / 255 - 0.5) / 0.5;
  }
  return out;
}
