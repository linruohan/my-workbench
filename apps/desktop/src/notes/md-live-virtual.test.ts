import { describe, expect, it } from "vitest";
import {
  buildRowMetrics,
  estimateBlockHeight,
  indexAtOffset,
  lineNumberText,
  mapPool,
  visibleRange,
} from "./md-live-virtual";

describe("md-live-virtual", () => {
  it("estimates empty rows as a single live row", () => {
    expect(estimateBlockHeight("")).toBeGreaterThan(0);
    expect(estimateBlockHeight("hello")).toBe(estimateBlockHeight(""));
    expect(estimateBlockHeight("a\nb")).toBeGreaterThan(estimateBlockHeight("hello"));
  });

  it("builds monotonic offsets", () => {
    const metrics = buildRowMetrics(["a", "", "b\nc"]);
    expect(metrics.offsets[0]).toBe(0);
    expect(metrics.offsets[1]).toBe(metrics.heights[0]);
    expect(metrics.total).toBe(
      (metrics.heights[0] ?? 0) + (metrics.heights[1] ?? 0) + (metrics.heights[2] ?? 0),
    );
  });

  it("finds index at offset", () => {
    const metrics = buildRowMetrics(["a", "b", "c"]);
    expect(indexAtOffset(metrics.offsets, 0)).toBe(0);
    expect(indexAtOffset(metrics.offsets, (metrics.offsets[2] ?? 0) + 1)).toBe(2);
  });

  it("returns a visible window with overscan", () => {
    const blocks = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const metrics = buildRowMetrics(blocks);
    const range = visibleRange(metrics, metrics.offsets[10] ?? 0, 100, 2);
    expect(range.start).toBeLessThanOrEqual(10);
    expect(range.end).toBeGreaterThan(10);
    expect(range.end).toBeLessThanOrEqual(blocks.length);
  });

  it("formats line number text without per-line nodes", () => {
    expect(lineNumberText(3, 3)).toBe("3\n4\n5");
  });

  it("runs mapPool with concurrency", async () => {
    let peak = 0;
    let live = 0;
    const out = await mapPool(
      [1, 2, 3, 4, 5],
      async (n) => {
        live += 1;
        peak = Math.max(peak, live);
        await Promise.resolve();
        live -= 1;
        return n * 2;
      },
      2,
    );
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
