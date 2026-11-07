import { describe, expect, it } from "vitest";
import {
  FS_NOT_OBSERVED,
  assertCanDeleteExisting,
  assertCanModifyExisting,
  clearObserved,
  isObserved,
  markObserved,
  observationKey,
} from "../src/fs-observation-policy.js";

describe("fs-observation-policy", () => {
  it("normalizes path keys", () => {
    expect(observationKey(String.raw`D:\repo\a.ts`)).toBe("D:/repo/a.ts");
    expect(observationKey("D:/repo/a.ts/")).toBe("D:/repo/a.ts");
  });

  it("blocks modify until observed, then allows", () => {
    const set = new Set<string>();
    const path = "D:/repo/a.ts";
    const blocked = assertCanModifyExisting(set, path, "a.ts");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe(FS_NOT_OBSERVED);
    markObserved(set, path);
    expect(assertCanModifyExisting(set, path).ok).toBe(true);
    expect(isObserved(set, path)).toBe(true);
  });

  it("clears observation after delete gate passes", () => {
    const set = new Set<string>();
    markObserved(set, "/x/y");
    expect(assertCanDeleteExisting(set, "/x/y").ok).toBe(true);
    clearObserved(set, "/x/y");
    expect(assertCanDeleteExisting(set, "/x/y").ok).toBe(false);
  });
});
