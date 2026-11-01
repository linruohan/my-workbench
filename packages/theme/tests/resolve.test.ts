import { describe, expect, it } from "vitest";
import {
  applyResolvedTheme,
  cycleThemeMode,
  isThemeMode,
  readStoredThemeMode,
  resolveThemeMode,
  themeModeLabel,
  THEME_STORAGE_KEY,
  writeStoredThemeMode,
} from "../src/index.js";

describe("theme resolve", () => {
  it("resolves system against prefersDark", () => {
    expect(resolveThemeMode("system", true)).toBe("dark");
    expect(resolveThemeMode("system", false)).toBe("light");
    expect(resolveThemeMode("light", true)).toBe("light");
    expect(resolveThemeMode("dark", false)).toBe("dark");
  });

  it("cycles mode and labels", () => {
    expect(cycleThemeMode("system")).toBe("light");
    expect(cycleThemeMode("light")).toBe("dark");
    expect(cycleThemeMode("dark")).toBe("system");
    expect(themeModeLabel("system")).toBe("跟随系统");
  });

  it("persists only valid modes", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    };
    expect(readStoredThemeMode(storage)).toBe("system");
    writeStoredThemeMode(storage, "dark");
    expect(map.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(readStoredThemeMode(storage)).toBe("dark");
    map.set(THEME_STORAGE_KEY, "nope");
    expect(readStoredThemeMode(storage)).toBe("system");
    expect(isThemeMode("light")).toBe(true);
    expect(isThemeMode("neon")).toBe(false);
  });

  it("applies data-theme and color-scheme on element", () => {
    const el = {
      dataset: {} as DOMStringMap,
      style: { colorScheme: "" },
    };
    applyResolvedTheme(el, "dark");
    expect(el.dataset.theme).toBe("dark");
    expect(el.style.colorScheme).toBe("dark");
  });
});
