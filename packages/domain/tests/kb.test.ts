import { describe, expect, it } from "vitest";
import {
  applyHeadingNumbers,
  extractImageSlots,
  fileStem,
  headingMeta,
  highlightMarkdown,
  imageDestination,
  indentMarkdownSelection,
  isIgnoredKbName,
  isImageFile,
  isMarkdownFile,
  isPathUnder,
  joinMdBlocks,
  normalizeMdBlocks,
  outdentMarkdownSelection,
  parseHtmlImage,
  pastedImageAbs,
  pastedImageRel,
  resolveImageTarget,
  splitMdBlocks,
  stripHeadingNumber,
  cutSelectedLines,
  dedupeSelectedLines,
  findAllMatches,
  findNextMatch,
  locateInBlocks,
  locateLineInBlocks,
  countDocLines,
  replaceAllMatches,
  replaceMatchWithQuery,
  sortSelectedLines,
  styleMarkdownSelection,
  wrapMarkdownSelection,
} from "../src/index.js";

describe("knowledge images", () => {
  it("keeps spaces, titles, and angle-bracket destinations", () => {
    expect(imageDestination("./imgs/jinjia2 生成html0.png")).toBe(
      "./imgs/jinjia2 生成html0.png",
    );
    expect(imageDestination("<./imgs/a b.png>")).toBe("./imgs/a b.png");
    expect(imageDestination('./pic.png "标题"')).toBe("./pic.png");
  });

  it("reads html img src and zoom", () => {
    expect(parseHtmlImage('<img src="./a.png" style="zoom: 50%">')).toEqual({
      src: "./a.png",
      scale: 0.5,
    });
  });

  it("resolves relative, encoded, and remote images", () => {
    const local = resolveImageTarget("./imgs/AI%20agent.png", "D:\\notes\\book");
    expect(local.kind).toBe("local");
    if (local.kind === "local") {
      expect(local.candidates[0]).toBe("D:\\notes\\book\\imgs\\AI agent.png");
      expect(local.candidates).toContain("D:\\notes\\book\\imgs\\AI agent.png");
    }
    expect(resolveImageTarget("https://example.com/a.png", "D:\\notes")).toEqual({
      kind: "remote",
      url: "https://example.com/a.png",
    });
    const abs = resolveImageTarget("D:\\pic\\a.png", "D:\\notes");
    expect(abs).toEqual({ kind: "local", candidates: ["D:\\pic\\a.png"] });
  });

  it("falls back to an imgs directory beside the note", () => {
    const target = resolveImageTarget("missing.png", "D:\\notes\\chapter");
    expect(target.kind).toBe("local");
    if (target.kind === "local") {
      expect(target.candidates).toContain("D:\\notes\\chapter\\missing.png");
      expect(target.candidates).toContain("D:\\notes\\chapter\\imgs\\missing.png");
      expect(target.candidates).toContain("D:\\notes\\imgs\\missing.png");
    }
  });

  it("names pasted images like ImagePaste", () => {
    expect(pastedImageRel("日记", 0)).toBe("日记/日记0.png");
    expect(pastedImageRel("日记", 2)).toBe("日记/日记2.png");
    expect(pastedImageAbs("D:\\notes", "日记", 0)).toBe("D:\\notes\\日记\\日记0.png");
    expect(fileStem("D:\\notes\\周报.md")).toBe("周报");
  });

  it("extracts markdown and html images outside fences", () => {
    const source = [
      "![图](./a b.png)",
      '<img src="https://example.com/b.png" style="zoom: 80%">',
      "```",
      "![忽略](./no.png)",
      "```",
    ].join("\n");
    const { markdown, slots } = extractImageSlots(source);
    expect(slots).toEqual([
      { dest: "./a b.png", scale: null },
      { dest: "https://example.com/b.png", scale: 0.8 },
    ]);
    expect(markdown).toContain("![图](wbimg-0)");
    expect(markdown).toContain("![](wbimg-1)");
    expect(markdown).toContain("![忽略](./no.png)");
  });
});

describe("knowledge headings", () => {
  it("numbers h1 through h8 and resets lower levels", () => {
    const source = [
      "# A",
      "## B",
      "### C",
      "## D",
      "####### G",
      "######## H",
      "# E",
    ].join("\n");
    const labels = headingMeta(source).map((item) => item?.label ?? null);
    expect(labels).toEqual([
      "1",
      "1.1",
      "1.1.1",
      "1.2",
      "1.2.0.0.0.0.1",
      "1.2.0.0.0.0.1.1",
      "2",
    ]);
  });

  it("writes outline numbers into source and strips duplicates", () => {
    expect(stripHeadingNumber("2.3 标题")).toBe("标题");
    const applied = applyHeadingNumbers("# A\n## B\n### 9.9 旧编号");
    expect(applied).toBe("# 1 A\n## 1.1 B\n### 1.1.1 旧编号");
    expect(applyHeadingNumbers(applied)).toBe(applied);
  });

  it("highlights headings without numbering inside fences", () => {
    const lines = highlightMarkdown("# 标题\n\n**粗** 与 `code`\n```\n# 不是标题\n```");
    expect(lines[0]?.numberLabel).toBe("1");
    expect(lines[0]?.segs[0]).toEqual({ text: "#", kind: "hash" });
    expect(lines[0]?.segs[1]?.kind).toBe("h1");
    expect(lines[2]?.segs.some((seg) => seg.kind === "strong")).toBe(true);
    expect(lines[2]?.segs.some((seg) => seg.kind === "code")).toBe(true);
    expect(lines[4]?.segs[0]?.kind).toBe("fence");
    expect(lines[4]?.numberLabel).toBeNull();
  });

  it("classifies files", () => {
    expect(isMarkdownFile("a.MD")).toBe(true);
    expect(isImageFile("图.webp")).toBe(true);
    expect(isMarkdownFile("a.png")).toBe(false);
    expect(isIgnoredKbName(".git")).toBe(true);
    expect(isIgnoredKbName("node_modules")).toBe(true);
    expect(isIgnoredKbName("notes")).toBe(false);
  });

  it("checks path containment and indent helpers", () => {
    expect(isPathUnder("D:\\notes", "D:\\notes\\a.md")).toBe(true);
    expect(isPathUnder("D:\\notes", "D:\\other\\a.md")).toBe(false);
    const indented = indentMarkdownSelection("a\nb", 0, 3);
    expect(indented.text).toBe("  a\n  b");
    const out = outdentMarkdownSelection("  a\n  b", 2, 6);
    expect(out.text).toBe("a\nb");
  });

  it("splits typora-like markdown blocks and round-trips", () => {
    const source = [
      "# 标题",
      "",
      "一段文字",
      "继续",
      "",
      "![图](./a.png)",
      "",
      "```js",
      "const a = 1;",
      "```",
      "",
      "- a",
      "- b",
    ].join("\n");
    const blocks = splitMdBlocks(source);
    expect(blocks[0]).toBe("# 标题");
    expect(blocks).toContain("![图](./a.png)");
    expect(blocks.some((block) => block.startsWith("```js"))).toBe(true);
    expect(joinMdBlocks(blocks)).toBe(source);
  });

  it("keeps blank lines editable and trims fence tails when normalizing", () => {
    const blocks = [
      "```bash\necho hi\n```\n",
      "",
      "",
      "正文",
      "",
    ];
    expect(normalizeMdBlocks(blocks)).toEqual([
      "```bash\necho hi\n```",
      "",
      "",
      "正文",
      "",
    ]);
  });

  it("wraps multi-line selections for bold and highlight", () => {
    const bold = wrapMarkdownSelection("a\nb\n", 0, 3, "**");
    expect(bold.text).toBe("**a**\n**b**\n");
    const mark = wrapMarkdownSelection("hello", 0, 5, "==");
    expect(mark.text).toBe("==hello==");
    const undone = wrapMarkdownSelection("**a**", 0, 5, "**");
    expect(undone.text).toBe("a");
  });

  it("applies and clears text color / background on selections", () => {
    const colored = styleMarkdownSelection("hello", 0, 5, "color", "#e11d48");
    expect(colored.text).toBe('<span style="color: #e11d48">hello</span>');
    expect(colored.start).toBe('<span style="color: #e11d48">'.length);
    expect(colored.end).toBe(colored.start + "hello".length);

    const cleared = styleMarkdownSelection(colored.text, 0, colored.text.length, "color", null);
    expect(cleared.text).toBe("hello");

    const bg = styleMarkdownSelection("a\nb", 0, 3, "background", "#fef08a");
    expect(bg.text).toBe(
      '<span style="background-color: #fef08a">a</span>\n<span style="background-color: #fef08a">b</span>',
    );

    const nested = styleMarkdownSelection(
      '<span style="color: #e11d48">hi</span>',
      0,
      '<span style="color: #e11d48">hi</span>'.length,
      "background",
      "#bfdbfe",
    );
    expect(nested.text).toBe(
      '<span style="background-color: #bfdbfe"><span style="color: #e11d48">hi</span></span>',
    );

    const rejected = styleMarkdownSelection("x", 0, 1, "color", "red;evil");
    expect(rejected.text).toBe("x");
  });

  it("cuts selected lines and sorts / dedupes them", () => {
    const cut = cutSelectedLines("a\nb\nc", 2, 2);
    expect(cut.cut).toBe("b\n");
    expect(cut.text).toBe("a\nc");

    const sorted = sortSelectedLines("c\na\nb", 0, 5);
    expect(sorted.text).toBe("a\nb\nc");

    const deduped = dedupeSelectedLines("a\nb\na\nc\nb", 0, 9);
    expect(deduped.text).toBe("a\nb\nc");
  });

  it("finds and replaces with regex / selection scope", () => {
    const text = "foo Foo FOO food";
    const all = findAllMatches(text, { query: "foo", matchCase: false, wholeWord: true });
    expect(all).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);

    const next = findNextMatch(text, { query: "foo", matchCase: true }, 1);
    expect(next).toEqual({ start: 12, end: 15 });

    const replaced = replaceMatchWithQuery(
      text,
      { start: 0, end: 3 },
      "foo",
      "bar",
      { preserveCase: true },
    );
    expect(replaced.text.startsWith("bar")).toBe(true);

    const scoped = replaceAllMatches("aa bb aa", {
      query: "aa",
      replace: "xx",
      inSelection: true,
      selectionStart: 3,
      selectionEnd: 8,
    });
    expect(scoped.text).toBe("aa bb xx");
    expect(scoped.count).toBe(1);

    const regex = replaceAllMatches("a1 a2", {
      query: "a(\\d)",
      replace: "b$1",
      regex: true,
    });
    expect(regex.text).toBe("b1 b2");

    expect(locateInBlocks(["hi", "there"], 4)).toEqual({ index: 1, offset: 1 });
  });

  it("maps document line numbers across blocks", () => {
    const blocks = ["# A", "", "hello\nworld", ""];
    expect(countDocLines(blocks)).toBe(5);
    expect(locateLineInBlocks(blocks, 1)).toEqual({ index: 0, offset: 0 });
    expect(locateLineInBlocks(blocks, 2)).toEqual({ index: 1, offset: 0 });
    expect(locateLineInBlocks(blocks, 4)).toEqual({ index: 2, offset: 6 });
  });
});
