import { describe, expect, it } from "vitest";
import { holdWebSession, onWebSessionResume, webSessionHeld } from "./web-session";

describe("web session hold", () => {
  it("stays hidden until the last hold releases", async () => {
    const seen: string[] = [];
    const stop = onWebSessionResume(() => {
      seen.push("resume");
    });
    const outer = await holdWebSession();
    const inner = await holdWebSession();
    expect(webSessionHeld()).toBe(true);
    inner();
    expect(webSessionHeld()).toBe(true);
    expect(seen).toEqual([]);
    outer();
    expect(webSessionHeld()).toBe(false);
    expect(seen).toEqual(["resume"]);
    stop();
  });
});
