import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders headings through h8", () => {
    const html = renderMarkdown("# 一\n## 二\n####### 七\n######## 八");
    expect(html).toContain("<h1>一</h1>");
    expect(html).toContain("<h2>二</h2>");
    expect(html).toContain("<h7>七</h7>");
    expect(html).toContain("<h8>八</h8>");
  });

  it("embeds resolved local images and remote urls", () => {
    const local = renderMarkdown("![图](./a b.png)", ["data:image/png;base64,aaaa"]);
    expect(local).toContain('src="data:image/png;base64,aaaa"');
    expect(local).not.toContain("./a b.png");

    const remote = renderMarkdown("![远程](https://example.com/a.png)");
    expect(remote).toContain('src="https://example.com/a.png"');
  });

  it("keeps html image zoom as a width style", () => {
    const html = renderMarkdown(
      '<img src="https://example.com/a.png" style="zoom: 50%">',
    );
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain("width:50%");
  });

  it("renders fenced code with mac chrome, language, and line numbers", () => {
    const html = renderMarkdown("```bash\necho hello\nls\n```");
    expect(html).toContain('class="md-code"');
    expect(html).toContain("md-code__dots");
    expect(html).toContain("Shell");
    expect(html).toContain('class="md-code__num">1<');
    expect(html).toContain('class="md-code__num">2<');
    expect(html).toContain("hljs");
  });

  it("renders highlight and underline markers", () => {
    const html = renderMarkdown("这是==高亮==和++下划线++");
    expect(html).toContain("<mark>");
    expect(html).toContain("高亮");
    expect(html).toContain("<u>");
    expect(html).toContain("下划线");
  });

  it("renders safe text color and background spans", () => {
    const html = renderMarkdown(
      '字<span style="color: #e11d48">红</span>和<span style="background-color: #fef08a">黄底</span>',
    );
    expect(html).toContain('style="color: #e11d48"');
    expect(html).toContain("红");
    expect(html).toContain('style="background-color: #fef08a"');
    expect(html).toContain("黄底");
  });

  it("does not render unsafe span styles as HTML", () => {
    const html = renderMarkdown('<span style="color: red; width:1px">x</span>');
    expect(html).not.toContain("<span");
    expect(html).toContain("&lt;span");
  });
});
