import { describe, expect, it } from "vitest";
import {
  canonicalToolArgs,
  noteRepeatedToolCall,
  reminderForRepeat,
} from "../src/agent-repeat-tool.js";

describe("agent-repeat-tool", () => {
  it("canonicalizes args regardless of key order", () => {
    expect(canonicalToolArgs({ b: 1, a: 2 })).toBe(canonicalToolArgs({ a: 2, b: 1 }));
  });

  it("reminds at 3, 5, and 8 exact repeats", () => {
    let state = null;
    const args = { path: "a.ts" };
    const reminders: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const next = noteRepeatedToolCall(state, "read", args);
      state = next.state;
      if (next.reminder) reminders.push(next.reminder);
    }
    expect(state?.count).toBe(8);
    expect(reminders).toHaveLength(3);
    expect(reminders[0]).toContain("3 次");
    expect(reminders[1]).toContain("`read`");
    expect(reminders[1]).toContain("5 次");
    expect(reminders[2]).toContain("8 次");
  });

  it("resets when the tool or args change", () => {
    const first = noteRepeatedToolCall(null, "read", { path: "a" });
    const second = noteRepeatedToolCall(first.state, "read", { path: "b" });
    expect(second.state?.count).toBe(1);
    expect(second.reminder).toBeNull();
  });

  it("ignores excluded tools without resetting the streak", () => {
    const base = noteRepeatedToolCall(null, "read", { path: "a" });
    const twice = noteRepeatedToolCall(base.state, "read", { path: "a" });
    const ignored = noteRepeatedToolCall(twice.state, "todo_write", { todos: [] });
    expect(ignored.state?.count).toBe(2);
    expect(ignored.reminder).toBeNull();
    const third = noteRepeatedToolCall(ignored.state, "read", { path: "a" });
    expect(third.state?.count).toBe(3);
    expect(third.reminder).toContain("3 次");
  });

  it("skips non-threshold counts", () => {
    expect(reminderForRepeat({ tool: "read", argsKey: "{}", count: 2 }, {})).toBeNull();
  });
});
