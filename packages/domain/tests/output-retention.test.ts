import { describe, expect, it } from "vitest";
import {
  formatImageOffloadNotice,
  formatRetentionNotice,
  retainText,
} from "../src/output-retention.js";

describe("retainText", () => {
  it("keeps short content intact", () => {
    const hit = retainText("hello", { headBytes: 10, tailBytes: 10 });
    expect(hit.text).toBe("hello");
    expect(hit.omittedBytes).toBe(0);
  });

  it("keeps head and tail when oversized", () => {
    const content = "A".repeat(20) + "MID" + "B".repeat(20);
    const hit = retainText(content, { kind: "headTail", headBytes: 10, tailBytes: 10 });
    expect(hit.text.startsWith("A".repeat(10))).toBe(true);
    expect(hit.text.endsWith("B".repeat(10))).toBe(true);
    expect(hit.text.includes("…")).toBe(true);
    expect(hit.omittedBytes).toBe(content.length - 20);
  });
});

describe("formatRetentionNotice", () => {
  it("points at spill path when truncated", () => {
    const content = "X".repeat(100);
    const hit = formatRetentionNotice({
      content,
      spillPath: ".wb/spill/job_1-stdout.txt",
      spillBytes: 100,
      headBytes: 20,
      tailBytes: 10,
    });
    expect(hit.preview.length).toBeLessThan(content.length);
    expect(hit.notice).toContain(".wb/spill/job_1-stdout.txt");
    expect(hit.notice).toContain("read");
  });
});

describe("formatImageOffloadNotice", () => {
  it("lists recoverable paths for omitted vision attachments", () => {
    expect(formatImageOffloadNotice([])).toBe("");
    const notice = formatImageOffloadNotice([
      { id: "img_1", path: "shots/a.png", reason: "count" },
      { id: "img_2", path: "shots/b.png", name: "b.png", reason: "bytes" },
    ]);
    expect(notice).toContain("<image_offload>");
    expect(notice).toContain("shots/a.png");
    expect(notice).toContain("read_image");
    expect(notice).toContain("张数上限");
    expect(notice).toContain("体积上限");
  });
});
