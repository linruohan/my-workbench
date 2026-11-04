import { describe, expect, it } from "vitest";
import { canStartHostToolInstall } from "./host-tools";

describe("canStartHostToolInstall", () => {
  it("allows two installs and then waits", () => {
    expect(canStartHostToolInstall([], { id: "go", lane: "none" })).toBe(true);
    const one = [{ id: "go", lane: "none" as const }];
    expect(canStartHostToolInstall(one, { id: "ffmpeg", lane: "none" })).toBe(true);
    const two = [...one, { id: "ffmpeg", lane: "none" as const }];
    expect(canStartHostToolInstall(two, { id: "ripgrep", lane: "none" })).toBe(false);
  });

  it("keeps chart libraries from sharing the Python directory", () => {
    const running = [{ id: "matplotlib", lane: "python" as const }];
    expect(canStartHostToolInstall(running, { id: "plotly", lane: "python" })).toBe(
      false,
    );
    expect(canStartHostToolInstall(running, { id: "go", lane: "none" })).toBe(true);
  });

  it("rejects a tool that is already installing", () => {
    const running = [{ id: "go", lane: "none" as const }];
    expect(canStartHostToolInstall(running, { id: "go", lane: "none" })).toBe(false);
  });
});
