/** Semantic design tokens — single accent, density aligned with docs/design.md §9.2 */

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "wb.theme.mode";

export const SPACE = {
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
  radiusControl: 6,
  radiusPanel: 10,
} as const;

export const TYPE = {
  fontUi: '"Segoe UI Variable", "Segoe UI", system-ui, -apple-system, sans-serif',
  fontMono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
  sizeXs: 12,
  sizeSm: 13,
  sizeMd: 14,
  sizeLg: 20,
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
    shadow: "0 1px 2px rgb(16 24 40 / 6%)",
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
    shadow: "0 1px 2px rgb(0 0 0 / 35%)",
  },
} as const;
