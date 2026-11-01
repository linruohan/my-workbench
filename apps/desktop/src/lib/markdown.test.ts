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
    const html = renderMarkdown('<img src="https://example.com/a.png" style="zoom: 50%">');
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain("width:50%");
  });
});
