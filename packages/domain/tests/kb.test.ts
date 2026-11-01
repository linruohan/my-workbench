import { describe, expect, it } from "vitest";
import {
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
  outdentMarkdownSelection,
  parseHtmlImage,
  pastedImageAbs,
  pastedImageRel,
  resolveImageTarget,
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
});
