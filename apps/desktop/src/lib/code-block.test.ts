import { describe, expect, it } from "vitest";
import { highlightCode, languageLabel, renderCodeBlock } from "./code-block";

describe("code-block", () => {
  it("maps common language aliases to display labels", () => {
    expect(languageLabel("bash")).toBe("Shell");
    expect(languageLabel("js")).toBe("JavaScript");
    expect(languageLabel("py")).toBe("Python");
  });

  it("highlights keywords for known languages", () => {
    const html = highlightCode("const x = 1;", "js");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("const");
  });

  it("builds a chrome wrapper with gutter", () => {
    const html = renderCodeBlock("a\nb\n", "rust");
    expect(html).toContain("Rust");
    expect(html).toContain("md-code__gutter");
    expect(html).toContain(">1</span>");
    expect(html).toContain(">2</span>");
  });
});
