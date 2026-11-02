import { describe, expect, it } from "vitest";
import {
  formatLocalDay,
  formatRelativeDay,
  formatRelativeMoment,
  formatTimelineDayHeader,
  parseLocalDay,
} from "../src/date.js";

describe("formatRelativeDay", () => {
  // Fixed local noon on 2026-11-02 (Monday)
  const now = parseLocalDay("2026-11-02") + 12 * 60 * 60 * 1000;

  it("maps near days to 今天/明天/后天/昨天/前天", () => {
    expect(formatRelativeDay("2026-11-02", now)).toBe("今天");
    expect(formatRelativeDay("2026-11-03", now)).toBe("明天");
    expect(formatRelativeDay("2026-11-04", now)).toBe("后天");
    expect(formatRelativeDay("2026-11-01", now)).toBe("昨天");
    expect(formatRelativeDay("2026-10-31", now)).toBe("前天");
  });

  it("shifts labels as the clock day changes", () => {
    const tomorrowNoon = parseLocalDay("2026-11-03") + 12 * 60 * 60 * 1000;
    expect(formatRelativeDay("2026-11-03", now)).toBe("明天");
    expect(formatRelativeDay("2026-11-03", tomorrowNoon)).toBe("今天");
    expect(formatRelativeDay("2026-11-02", tomorrowNoon)).toBe("昨天");
  });

  it("uses 周X / 下周X / 上周X within nearby weeks", () => {
    // Same week Wednesday
    expect(formatRelativeDay("2026-11-05", now)).toBe("周四");
    // Next Monday
    expect(formatRelativeDay("2026-11-09", now)).toBe("下周一");
    // Previous Friday
    expect(formatRelativeDay("2026-10-30", now)).toBe("上周五");
  });

  it("falls back to month-day farther out", () => {
    expect(formatRelativeDay("2026-12-01", now)).toBe("12月1日");
    expect(formatRelativeDay("2027-01-15", now)).toBe("2027年1月15日");
  });

  it("formats moments with clock", () => {
    const ms = parseLocalDay("2026-11-03") + 9 * 60 * 60 * 1000 + 30 * 60 * 1000;
    expect(formatRelativeMoment(ms, now)).toBe("明天 09:30");
    expect(formatLocalDay(ms)).toBe("2026-11-03");
  });

  it("formats timeline day headers", () => {
    expect(formatTimelineDayHeader("2026-11-02", now)).toBe("今天");
    expect(formatTimelineDayHeader("2026-11-03", now)).toBe("明天");
    expect(formatTimelineDayHeader("2026-11-01", now)).toBe("昨天");
    // 2026-05-03 is Sunday
    expect(formatTimelineDayHeader("2026-05-03", now)).toBe("周日, 5/3");
    expect(formatTimelineDayHeader("2027-02-10", now)).toBe("2027-2-10");
  });
});
