import { describe, expect, it } from "vitest";
import { parseQuickCapture } from "../src/index.js";

describe("parseQuickCapture", () => {
  const now = new Date(2026, 10, 1, 9, 0).getTime();

  it("puts undated capture into inbox project id", () => {
    const r = parseQuickCapture("回复邮件", { nowMs: now });
    expect(r.projectId).toBe("inbox");
    expect(r.dueDay).toBeNull();
    expect(r.dueWithTime).toBeNull();
    expect(r.title).toBe("回复邮件");
  });

  it("parses tomorrow and afternoon time with remind offset", () => {
    const r = parseQuickCapture("明天 下午3:00 评审 提前15分钟", {
      nowMs: now,
    });
    expect(r.dueDay).toBeNull();
    expect(r.dueWithTime).not.toBeNull();
    expect(r.remindAt).toBe(r.dueWithTime! - 15 * 60_000);
    expect(r.title).toContain("评审");
  });

  it("keeps unknown project as candidate without inventing id", () => {
    const r = parseQuickCapture("#工作台 定数据表", { nowMs: now });
    expect(r.projectTitle).toBe("工作台");
    expect(r.projectId).toBeNull();
    expect(r.title).toBe("定数据表");
  });

  it("parses dotted month-day with bare hour as morning time", () => {
    const r = parseQuickCapture("11.3 号 9点记得开会", { nowMs: now });
    expect(r.dueDay).toBeNull();
    expect(r.dueWithTime).toBe(new Date(2026, 10, 3, 9, 0, 0, 0).getTime());
    expect(r.title).toBe("记得开会");
  });

  it("parses slash date and half-hour", () => {
    const r = parseQuickCapture("11/3 9点半 同步", { nowMs: now });
    expect(r.dueWithTime).toBe(new Date(2026, 10, 3, 9, 30, 0, 0).getTime());
    expect(r.title).toBe("同步");
  });
});
