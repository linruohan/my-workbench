import { blockLineCount } from "@wb/domain";

/** Matches --md-live-size * --md-live-line in app.css (16 * 1.75). */
export const MD_LIVE_LINE_PX = 28;
/** Matches 2 * --md-live-pad-y (4px). */
export const MD_LIVE_PAD_Y = 8;
/** One empty/gap row: line + vertical padding. */
export const MD_LIVE_ROW_PX = MD_LIVE_LINE_PX + MD_LIVE_PAD_Y;

export function estimateBlockHeight(block: string): number {
  const lines = blockLineCount(block);
  if (block === "") return MD_LIVE_ROW_PX;
  // Fenced blocks have chrome; add a small constant so scroll estimates stay usable.
  const fenceBoost = block.startsWith("```") || block.startsWith("~~~") ? 36 : 0;
  return lines * MD_LIVE_LINE_PX + MD_LIVE_PAD_Y + fenceBoost;
}

export type RowMetrics = {
  heights: number[];
  offsets: number[];
  total: number;
};

export function buildRowMetrics(
  blocks: string[],
  measured?: Map<number, number>,
): RowMetrics {
  const heights: number[] = new Array(blocks.length);
  const offsets: number[] = new Array(blocks.length);
  let y = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    offsets[i] = y;
    const measuredH = measured?.get(i);
    const h =
      measuredH != null && measuredH > 0
        ? measuredH
        : estimateBlockHeight(blocks[i] ?? "");
    heights[i] = h;
    y += h;
  }
  return { heights, offsets, total: y };
}

/** Largest index whose offset <= y (or 0). */
export function indexAtOffset(offsets: number[], y: number): number {
  if (offsets.length === 0) return 0;
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] ?? 0) <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function visibleRange(
  metrics: RowMetrics,
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): { start: number; end: number } {
  const { offsets, heights, total } = metrics;
  const n = offsets.length;
  if (n === 0) return { start: 0, end: 0 };
  const start = Math.max(
    0,
    indexAtOffset(offsets, Math.max(0, scrollTop)) - overscan,
  );
  const bottom = Math.min(total, scrollTop + Math.max(viewportHeight, 1));
  let end = indexAtOffset(offsets, bottom) + 1 + overscan;
  // Include the row that contains bottom even when offset equals bottom.
  while (end < n && (offsets[end - 1] ?? 0) + (heights[end - 1] ?? 0) < bottom) {
    end += 1;
  }
  end = Math.min(n, Math.max(start + 1, end));
  return { start, end };
}

/** Build "1\\n2\\n3" for a line-number gutter without per-line DOM nodes. */
export function lineNumberText(startLine: number, lineCount: number): string {
  if (lineCount <= 0) return String(startLine);
  const parts = new Array<string>(lineCount);
  for (let i = 0; i < lineCount; i += 1) parts[i] = String(startLine + i);
  return parts.join("\n");
}

const IMAGE_CONCURRENCY = 6;

/** Run async work over items with a concurrency limit. */
export async function mapPool<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency = IMAGE_CONCURRENCY,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await mapper(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
