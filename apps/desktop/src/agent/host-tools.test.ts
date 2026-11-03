import { describe, expect, it } from "vitest";
import { canStartHostToolInstall } from "./host-tools";

describe("canStartHostToolInstall", () => {
  it("allows two installs and then waits", () => {
    expect(canStartHostToolInstall([], { id: "go", category: "cli" })).toBe(true);
    const one = [{ id: "go", category: "cli" as const }];
    expect(canStartHostToolInstall(one, { id: "ffmpeg", category: "cli" })).toBe(true);
    const two = [...one, { id: "ffmpeg", category: "cli" as const }];
    expect(canStartHostToolInstall(two, { id: "ripgrep", category: "cli" })).toBe(false);
  });

  it("keeps chart libraries from sharing the Python directory", () => {
    const running = [{ id: "matplotlib", category: "chart" as const }];
    expect(canStartHostToolInstall(running, { id: "plotly", category: "chart" })).toBe(
      false,
    );
    expect(canStartHostToolInstall(running, { id: "go", category: "cli" })).toBe(true);
  });

  it("rejects a tool that is already installing", () => {
    const running = [{ id: "go", category: "cli" as const }];
    expect(canStartHostToolInstall(running, { id: "go", category: "cli" })).toBe(false);
  });
});
