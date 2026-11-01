import { describe, expect, it } from "vitest";
import { htmlTextHitCount, literalHitCount, markHtmlHits, splitHits } from "./find-text";

describe("conversation find", () => {
  it("counts case-insensitive hits without overlapping", () => {
    expect(literalHitCount("命令和命令", "命令")).toBe(2);
    expect(literalHitCount("AbCabc", "ab")).toBe(2);
    expect(literalHitCount("aaa", "aa")).toBe(1);
    expect(literalHitCount("没有", "   ")).toBe(0);
  });

  it("marks text nodes and leaves tags in place", () => {
    const html = markHtmlHits('<p class="x">命令和<em>命令</em></p>', "命令", 3, 4);
    expect(html.startsWith('<p class="x">')).toBe(true);
    expect(html).toContain('data-find-hit="3"');
    expect(html).toContain('data-find-hit="4"');
    expect(html).toContain("agent__hit is-current");
    expect(htmlTextHitCount("<p>命令和命令</p>", "命令")).toBe(2);
    expect(splitHits("你好", "你")[0]).toEqual({ text: "你", hit: true });
  });
});
