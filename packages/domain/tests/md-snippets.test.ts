import { describe, expect, it } from "vitest";
import {
  adjustSnippetStops,
  expandGithubMdSnippet,
  materializeSnippetTemplate,
} from "../src/md-snippets.js";

describe("github markdown snippets", () => {
  it("materializes placeholders and orders tab stops", () => {
    const built = materializeSnippetTemplate("[${1:Link Title}](${2:Link Source}) ${0}");
    expect(built.text).toBe("[Link Title](Link Source) ");
    expect(built.stops).toEqual([
      { start: 1, end: 11 },
      { start: 13, end: 24 },
      { start: 26, end: 26 },
    ]);
  });

  it("expands h1 / table / ul triggers at the caret", () => {
    const h1 = expandGithubMdSnippet("h1", 2);
    expect(h1?.text).toBe("# Heading 1\n");
    expect(h1?.stops[0]).toEqual({ start: 2, end: 11 });

    const table = expandGithubMdSnippet("see table", 9);
    expect(table?.text.startsWith("see | Column 1 | Column 2 |")).toBe(true);
    expect(table?.text).toContain("| Cell 2-1 | Cell 2-2 |");

    const ul = expandGithubMdSnippet("ul", 2);
    expect(ul?.text).toBe("- I\n- Love\n- Markdown\n");
  });

  it("does not expand mid-word or unknown triggers", () => {
    expect(expandGithubMdSnippet("xh1", 3)).toBeNull();
    expect(expandGithubMdSnippet("hello", 5)).toBeNull();
  });

  it("adjusts later stops when typing into the active placeholder", () => {
    const stops = [
      { start: 2, end: 11 },
      { start: 12, end: 12 },
    ];
    // Replace "Heading 1" (9 chars) with "Hi" (2 chars).
    expect(adjustSnippetStops(stops, 2, 9, 2)).toEqual([
      { start: 2, end: 4 },
      { start: 5, end: 5 },
    ]);
  });
});
