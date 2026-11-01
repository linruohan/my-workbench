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

function getPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function ThemeProvider(props: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() =>
    readStoredThemeMode(typeof localStorage === "undefined" ? null : localStorage),
  );
  const [prefersDark, setPrefersDark] = useState(getPrefersDark);

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setPrefersDark(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void hydrateThemeMode(
      readStoredThemeMode(
        typeof localStorage === "undefined" ? null : localStorage,
      ),
    ).then((next) => {
      if (cancelled) return;
      setModeState(next);
      writeStoredThemeMode(localStorage, next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const resolved = useMemo(
    () => resolveThemeMode(mode, prefersDark),
    [mode, prefersDark],
  );

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
