import { describe, expect, it } from "vitest";
import {
  applySlashToken,
  resolveSlash,
  slashSkillSuggestions,
  slashSuggestions,
} from "../src/agent-commands.js";

describe("slash commands", () => {
  it("suggests commands while the name is still being typed", () => {
    expect(slashSuggestions("/").map((command) => command.name)).toEqual([
      "help",
      "new",
      "mode",
      "model",
      "today",
      "brief",
      "compact",
      "memory",
      "agent",
    ]);
    expect(slashSuggestions("/mo").map((command) => command.name)).toEqual([
      "mode",
      "model",
    ]);
    expect(slashSuggestions("/晨").map((command) => command.name)).toEqual(["brief"]);
    expect(slashSuggestions("/mode 只读")).toEqual([]);
    expect(slashSuggestions("今天有什么")).toEqual([]);
  });

  it("lists skills from the slash menu and inserts a mention", () => {
    const skills = [
      { name: "weekly", description: "写周报" },
      { name: "review", description: "代码评审" },
    ];
    expect(slashSkillSuggestions("/", skills).map((item) => item.name)).toEqual([
      "weekly",
      "review",
    ]);
    expect(slashSkillSuggestions("/we", skills).map((item) => item.name)).toEqual([
      "weekly",
    ]);
    expect(slashSkillSuggestions("/周报", skills).map((item) => item.name)).toEqual([
      "weekly",
    ]);
    expect(slashSkillSuggestions("/mode 只读", skills)).toEqual([]);
    expect(applySlashToken("/we", "@weekly")).toBe("@weekly ");
  });

  it("keeps local commands away from the model", () => {
    expect(resolveSlash("看看今天", "confirm")).toBeNull();
    expect(resolveSlash("/help", "confirm")).toMatchObject({ type: "reply" });
    expect(resolveSlash("/?", "confirm")?.type).toBe("reply");
    expect(resolveSlash("/help mode", "confirm")).toMatchObject({
      type: "reply",
      text: expect.stringContaining("/mode"),
    });
    expect(resolveSlash("/new", "confirm")).toEqual({ type: "new" });
    expect(resolveSlash("/clear", "confirm")).toEqual({ type: "new" });
    expect(resolveSlash("/mode", "readonly")).toMatchObject({
      type: "reply",
      text: expect.stringContaining("只读"),
    });
    expect(resolveSlash("/mode 只读", "confirm")).toEqual({
      type: "mode",
      mode: "readonly",
    });
    expect(resolveSlash("/mode auto", "confirm")).toEqual({
      type: "mode",
      mode: "session_auto",
    });
    expect(resolveSlash("/mode 随便", "confirm")).toMatchObject({ type: "reply" });
    expect(resolveSlash("/model", "confirm")).toEqual({ type: "model-menu" });
    expect(resolveSlash("/model builtin:workbench/local", "confirm")).toEqual({
      type: "model",
      modelRef: "builtin:workbench/local",
    });
    expect(resolveSlash("/today", "confirm")).toEqual({
      type: "prompt",
      text: "看看今天有什么",
    });
    expect(resolveSlash("/晨报", "confirm")).toEqual({ type: "prompt", text: "晨报" });
    expect(resolveSlash("/nope", "confirm")).toMatchObject({
      type: "reply",
      text: expect.stringContaining("/help"),
    });
  });
});
