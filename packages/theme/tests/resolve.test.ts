import { describe, expect, it } from "vitest";
import {
  applyResolvedTheme,
  coerceThemeMode,
  cycleThemeMode,
  isThemeMode,
  readStoredThemeMode,
  resolveThemeMode,
  themeModeLabel,
  THEME_STORAGE_KEY,
  writeStoredThemeMode,
} from "../src/index.js";

describe("theme resolve", () => {
  it("resolves explicit light and dark modes", () => {
    expect(resolveThemeMode("light")).toBe("light");
    expect(resolveThemeMode("dark")).toBe("dark");
  });

  it("cycles mode and labels between light and dark", () => {
    expect(cycleThemeMode("light")).toBe("dark");
    expect(cycleThemeMode("dark")).toBe("light");
    expect(themeModeLabel("light")).toBe("浅色");
    expect(themeModeLabel("dark")).toBe("深色");
  });

  it("persists only light or dark, migrating legacy system", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    };
    expect(readStoredThemeMode(storage)).toBe("light");
    writeStoredThemeMode(storage, "dark");
    expect(map.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(readStoredThemeMode(storage)).toBe("dark");
    map.set(THEME_STORAGE_KEY, "system");
    expect(readStoredThemeMode(storage)).toBe("light");
    expect(coerceThemeMode("system")).toBe("light");
    expect(isThemeMode("light")).toBe(true);
    expect(isThemeMode("system")).toBe(false);
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
