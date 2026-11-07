import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  applyResolvedTheme,
  cycleThemeMode,
  readStoredThemeMode,
  resolveThemeMode,
  themeModeLabel,
  writeStoredThemeMode,
  type ResolvedTheme,
  type ThemeMode,
} from "@wb/theme";
import { hydrateThemeMode, persistThemeMode } from "../lib/theme-persist";

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  cycleMode: () => void;
  label: string;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider(props: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() =>
    readStoredThemeMode(typeof localStorage === "undefined" ? null : localStorage),
  );

  useEffect(() => {
    let cancelled = false;
    void hydrateThemeMode(
      readStoredThemeMode(typeof localStorage === "undefined" ? null : localStorage),
    ).then((next) => {
      if (cancelled) return;
      setModeState(next);
      writeStoredThemeMode(localStorage, next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const resolved = useMemo(() => resolveThemeMode(mode), [mode]);

  useEffect(() => {
    applyResolvedTheme(document.documentElement, resolved);
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    writeStoredThemeMode(localStorage, next);
    persistThemeMode(next);
  }, []);

  const cycleMode = useCallback(() => {
    setModeState((prev) => {
      const next = cycleThemeMode(prev);
      writeStoredThemeMode(localStorage, next);
      persistThemeMode(next);
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolved,
      setMode,
      cycleMode,
      label: themeModeLabel(mode),
    }),
    [mode, resolved, setMode, cycleMode],
  );

  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return ctx;
}
