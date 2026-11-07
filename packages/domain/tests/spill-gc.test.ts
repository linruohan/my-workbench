import { describe, expect, it } from "vitest";
import { selectExpiredSpillFiles } from "../src/spill-gc.js";

describe("selectExpiredSpillFiles", () => {
  it("keeps recent files and drops aged ones", () => {
    const now = Date.parse("2026-11-07T00:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    const hit = selectExpiredSpillFiles(
      [
        { name: "old.txt", path: "/a/old.txt", isDir: false, mtimeMs: now - 40 * day },
        { name: "new.txt", path: "/a/new.txt", isDir: false, mtimeMs: now - 2 * day },
        { name: "dir", path: "/a/dir", isDir: true, mtimeMs: now - 40 * day },
      ],
      { maxAgeDays: 30, nowMs: now },
    );
    expect(hit.map((item) => item.name)).toEqual(["old.txt"]);
  });

  it("disables cleanup when maxAgeDays is 0", () => {
    expect(
      selectExpiredSpillFiles(
        [{ name: "old.txt", path: "/a/old.txt", isDir: false, mtimeMs: 1 }],
        { maxAgeDays: 0, nowMs: 1_000_000 },
      ),
    ).toEqual([]);
  });
});
