import { describe, expect, it } from "vitest";
import {
  ensureTagColor,
  pickTagColor,
  resolveTagChipColors,
  TAG_PALETTE,
} from "../src/tag-color.js";

describe("tag-color", () => {
  it("picks a stable palette color for the same title", () => {
    expect(pickTagColor("历史")).toBe(pickTagColor("历史"));
    expect(TAG_PALETTE.some((p) => p.bg === pickTagColor("C++"))).toBe(true);
  });

  it("resolves chip colors from stored palette bg or title seed", () => {
    const fromTitle = resolveTagChipColors({ title: "历史", color: null });
    expect(fromTitle.background).toMatch(/^#/);
    expect(fromTitle.border).toMatch(/^#/);

    const stored = pickTagColor("工作");
    const fromStored = resolveTagChipColors({ title: "工作", color: stored });
    expect(fromStored.background).toBe(stored);
  });

  it("backfills legacy null/invalid colors", () => {
    expect(ensureTagColor({ title: "历史", color: null })).toBe(
      pickTagColor("历史"),
    );
    expect(ensureTagColor({ title: "历史", color: "not-a-color" })).toBe(
      pickTagColor("历史"),
    );
    expect(ensureTagColor({ title: "历史", color: "#f5e6d3" })).toBe("#f5e6d3");
  });
});
