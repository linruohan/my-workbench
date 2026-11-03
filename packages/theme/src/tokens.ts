/** Semantic design tokens — single accent, density aligned with docs/design.md §9.2 */

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "wb.theme.mode";

export const SPACE = {
  0: 2,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
} as const;

export const LAYOUT = {
  sidebarWidth: 220,
  schedulePaneWidth: 320,
  rowHeight: 36,
  radiusXs: 4,
  radiusSm: 6,
  radiusControl: 8,
  radiusPanel: 12,
  radiusPill: 999,
} as const;

export const TYPE = {
  fontUi: '"Segoe UI Variable", "Segoe UI", system-ui, -apple-system, sans-serif',
  fontMono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
  sizeMicro: 10,
  sizeXs: 12,
  sizeSm: 13,
  sizeMd: 14,
  sizeLg: 20,
  sizeXl: 28,
} as const;

export const MOTION = {
  fastMs: 120,
  normalMs: 180,
} as const;

/** One accent family; status colors only for semantic states. */
export const COLOR = {
  light: {
    bg: "#f4f5f7",
    panel: "#ffffff",
    sidebar: "#eceef2",
    text: "#1c1f26",
    muted: "#5c6573",
    line: "#d7dbe3",
    accent: "#2563eb",
    accentSoft: "#dbe7ff",
    onAccent: "#ffffff",
    success: "#15803d",
    warning: "#a16207",
    danger: "#c2410c",
    onDanger: "#ffffff",
    windowClose: "#e81123",
    overlay: "rgb(28 31 38 / 28%)",
    overlayStrong: "rgb(28 31 38 / 45%)",
    shadow: "0 1px 2px rgb(16 24 40 / 6%)",
    shadowMd: "0 8px 24px rgb(16 24 40 / 14%)",
    shadowLg: "0 16px 48px rgb(16 24 40 / 18%)",
    shadowXl: "0 28px 90px rgb(16 24 40 / 22%)",
  },
  dark: {
    bg: "#0b0b0b",
    panel: "#1a1a1a",
    sidebar: "#141414",
    text: "#ececec",
    muted: "#9b9b9b",
    line: "#2a2a2a",
    accent: "#6b9cff",
    accentSoft: "#2a2a2a",
    onAccent: "#0b1220",
    success: "#22c55e",
    warning: "#fbbf24",
    danger: "#fb7185",
    onDanger: "#ffffff",
    windowClose: "#e81123",
    overlay: "rgb(0 0 0 / 48%)",
    overlayStrong: "rgb(0 0 0 / 55%)",
    shadow: "0 1px 2px rgb(0 0 0 / 35%)",
    shadowMd: "0 8px 24px rgb(0 0 0 / 28%)",
    shadowLg: "0 16px 48px rgb(0 0 0 / 35%)",
    shadowXl: "0 28px 90px rgb(0 0 0 / 42%)",
  },
} as const;
