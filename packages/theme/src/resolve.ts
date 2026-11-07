import { THEME_STORAGE_KEY, type ResolvedTheme, type ThemeMode } from "./tokens.js";

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark";
}

/** Map legacy stored values (e.g. "system") onto the two explicit themes. */
export function coerceThemeMode(
  value: unknown,
  fallback: ThemeMode = "light",
): ThemeMode {
  if (isThemeMode(value)) return value;
  return fallback;
}

export function resolveThemeMode(mode: ThemeMode): ResolvedTheme {
  return mode;
}

export function readStoredThemeMode(
  storage: Pick<Storage, "getItem"> | null | undefined,
): ThemeMode {
  if (!storage) return "light";
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return coerceThemeMode(raw, "light");
  } catch {
    return "light";
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
  return mode === "light" ? "dark" : "light";
}

export function themeModeLabel(mode: ThemeMode): string {
  return mode === "light" ? "浅色" : "深色";
}

/** Apply resolved theme onto documentElement for CSS `[data-theme]`. */
export function applyResolvedTheme(
  el: Pick<HTMLElement, "dataset" | "style">,
  resolved: ResolvedTheme,
): void {
  el.dataset.theme = resolved;
  el.style.colorScheme = resolved;
}
