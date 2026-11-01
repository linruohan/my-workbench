import { describe, expect, it } from "vitest";
import { enqueuePrompt, recallQueuedPrompt, removeQueuedPrompt } from "./prompt-queue";

describe("prompt queue", () => {
  it("appends trimmed prompts and drops blanks", () => {
    expect(enqueuePrompt(["先看今天"], "  再写周报  ")).toEqual(["先看今天", "再写周报"]);
    expect(enqueuePrompt(["先看今天"], "   ")).toEqual(["先看今天"]);
  });

  it("removes one line and recalls it only when the composer is empty", () => {
    expect(removeQueuedPrompt(["甲", "乙"], 0)).toEqual(["乙"]);
    expect(recallQueuedPrompt(["甲", "乙"], 1, "")).toEqual({
      queue: ["甲"],
      draft: "乙",
    });
    expect(recallQueuedPrompt(["甲"], 0, "还在写")).toBeNull();
  });
});
