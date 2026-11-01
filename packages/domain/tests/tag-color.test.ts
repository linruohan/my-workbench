import { describe, expect, it } from "vitest";
import {
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
});
