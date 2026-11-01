import { beforeEach, describe, expect, it } from "vitest";
import { pushInputHistory, readInputHistory, rememberInput } from "./input-history";

describe("agent input history", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps the newest prompt and skips a repeated submit", () => {
    expect(pushInputHistory(["看看今天"], "看看今天")).toEqual(["看看今天"]);
    const next = pushInputHistory(["看看今天"], "/help");
    expect(next).toEqual(["/help", "看看今天"]);
    expect(pushInputHistory(next, "sk-abcdefghijklmnop")).toEqual(next);
    expect(
      pushInputHistory(
        Array.from({ length: 50 }, (_, index) => `a${index}`),
        "新的",
      ),
    ).toHaveLength(50);
  });

  it("stores history outside the workbench snapshot", () => {
    rememberInput("/mode 只读");
    expect(readInputHistory()).toEqual(["/mode 只读"]);
    expect(localStorage.getItem("wb.local.v1") ?? "").not.toContain("/mode");
  });
});
