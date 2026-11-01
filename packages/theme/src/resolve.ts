import { THEME_STORAGE_KEY, type ResolvedTheme, type ThemeMode } from "./tokens.js";

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

export function resolveThemeMode(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return prefersDark ? "dark" : "light";
}

export function readStoredThemeMode(
  storage: Pick<Storage, "getItem"> | null | undefined,
): ThemeMode {
  if (!storage) return "system";
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

export function writeStoredThemeMode(
  storage: Pick<Storage, "setItem"> | null | undefined,
  mode: ThemeMode,
): void {
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // ignore quota / private mode
  }
}

export function cycleThemeMode(mode: ThemeMode): ThemeMode {
  if (mode === "system") return "light";
  if (mode === "light") return "dark";
  return "system";
}

export function themeModeLabel(mode: ThemeMode): string {
  if (mode === "system") return "跟随系统";
  if (mode === "light") return "浅色";
  return "深色";
}

/** Apply resolved theme onto documentElement for CSS `[data-theme]`. */
export function applyResolvedTheme(
  el: Pick<HTMLElement, "dataset" | "style">,
  resolved: ResolvedTheme,
): void {
  el.dataset.theme = resolved;
  el.style.colorScheme = resolved;
}
