import { beforeEach, describe, expect, it } from "vitest";
import { readTerminalPanelOpen, writeTerminalPanelOpen } from "./terminal-api";

describe("terminal panel open preference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips the open flag", () => {
    expect(readTerminalPanelOpen()).toBe(false);
    writeTerminalPanelOpen(true);
    expect(readTerminalPanelOpen()).toBe(true);
    writeTerminalPanelOpen(false);
    expect(readTerminalPanelOpen()).toBe(false);
  });
});
