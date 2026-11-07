import { TYPE } from "@wb/theme";
import { isTauriRuntime } from "./paths";

/** Empty string means the built-in Mac-style system stack. */
export type FontFamilyPref = string;

export const SYSTEM_DEFAULT_LABEL = "系统默认（Mac 风格）";

export type FontCatalogSource = "idle" | "pending" | "host";

export type SystemFontEntry = {
  family: string;
  aliases: string[];
};

export type FontCatalog = {
  fonts: SystemFontEntry[];
  source: FontCatalogSource;
  loading: boolean;
  error: string;
};

const FORBIDDEN = /["';{}<>\\\n\r\0]/;

let catalog: FontCatalog = {
  fonts: [],
  source: "idle",
  loading: false,
  error: "",
};
let catalogPromise: Promise<FontCatalog> | null = null;
const listeners = new Set<() => void>();

function emitCatalog(): void {
  for (const listener of [...listeners]) listener();
}

function setCatalog(next: FontCatalog): FontCatalog {
  catalog = next;
  emitCatalog();
  return catalog;
}

/** Keep only safe single font-family names for CSS/JS injection. */
export function normalizeFontFamily(value: unknown): FontFamilyPref {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120) return "";
  if (FORBIDDEN.test(trimmed)) return "";
  return trimmed;
}

function normalizeAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const alias = normalizeFontFamily(item);
    if (!alias) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

function sanitizeFontEntries(entries: SystemFontEntry[]): SystemFontEntry[] {
  const byKey = new Map<string, SystemFontEntry>();
  for (const entry of entries) {
    const family = normalizeFontFamily(entry.family);
    if (!family) continue;
    const key = family.toLowerCase();
    const aliases = normalizeAliases(entry.aliases).filter(
      (alias) => alias.toLowerCase() !== key,
    );
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { family, aliases });
      continue;
    }
    for (const alias of aliases) {
      if (existing.aliases.some((item) => item.toLowerCase() === alias.toLowerCase())) {
        continue;
      }
      existing.aliases.push(alias);
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.family.localeCompare(b.family, undefined, { sensitivity: "base" }),
  );
}

export function fontSearchBlob(font: SystemFontEntry): string {
  return `${font.family} ${font.aliases.join(" ")}`.toLowerCase();
}

export function fontMatchesQuery(font: SystemFontEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fontSearchBlob(font).includes(q);
}

export function fontOptionLabel(font: SystemFontEntry): string {
  const asciiAlias = font.aliases.find(
    (alias) => /[a-z]/i.test(alias) && alias.toLowerCase() !== font.family.toLowerCase(),
  );
  if (asciiAlias) return `${font.family} · ${asciiAlias}`;
  return font.family;
}

async function listFontsFromHost(): Promise<SystemFontEntry[]> {
  if (!isTauriRuntime()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  const rows =
    await invoke<Array<{ family?: unknown; aliases?: unknown }>>("list_system_fonts");
  return sanitizeFontEntries(
    rows.map((row) => ({
      family: typeof row.family === "string" ? row.family : "",
      aliases: Array.isArray(row.aliases)
        ? row.aliases.filter((item): item is string => typeof item === "string")
        : [],
    })),
  );
}

export function getFontCatalog(): FontCatalog {
  return catalog;
}

/** Subscribe to background font-catalog updates. */
export function subscribeFontCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Background scan of OS font directories via the desktop host.
 * No hardcoded family list — the host walks installed font files and sorts them.
 */
export async function refreshSystemFonts(force = false): Promise<FontCatalog> {
  if (
    !force &&
    catalog.source === "host" &&
    catalog.fonts.length > 0 &&
    !catalog.loading
  ) {
    return catalog;
  }
  if (catalogPromise) return catalogPromise;

  catalogPromise = (async () => {
    setCatalog({
      fonts: catalog.fonts,
      source: "pending",
      loading: true,
      error: "",
    });

    if (!isTauriRuntime()) {
      return setCatalog({
        fonts: [],
        source: "idle",
        loading: false,
        error: "完整系统字体列表仅桌面端可用",
      });
    }

    try {
      const fonts = await listFontsFromHost();
      return setCatalog({
        fonts,
        source: "host",
        loading: false,
        error: fonts.length ? "" : "字体目录中未读到可用字体",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return setCatalog({
        fonts: [],
        source: "idle",
        loading: false,
        error: message || "读取系统字体失败",
      });
    }
  })().finally(() => {
    catalogPromise = null;
  });

  return catalogPromise;
}

/** Installed font family names (waits for the current background search). */
export async function listSystemFonts(): Promise<string[]> {
  const next = await refreshSystemFonts();
  return next.fonts.map((font) => font.family);
}

/** Kick off a background directory scan when the desktop shell is ready. */
export function prefetchSystemFonts(): void {
  void refreshSystemFonts(true);
}

/** Build `<select>` options: system default first, then installed families. */
export function buildFontOptions(
  systemFonts: SystemFontEntry[],
): Array<[string, string]> {
  const options: Array<[string, string]> = [["", SYSTEM_DEFAULT_LABEL]];
  for (const font of systemFonts) {
    options.push([font.family, fontOptionLabel(font)]);
  }
  return options;
}

export function resolveUiFontStack(font: FontFamilyPref): string {
  const name = normalizeFontFamily(font);
  if (!name) return TYPE.fontUi;
  return `"${name}", ${TYPE.fontUi}`;
}

/** Apply the app-wide UI font via the design-token CSS variable. */
export function applyUiFont(font: FontFamilyPref): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const name = normalizeFontFamily(font);
  if (!name) {
    root.style.removeProperty("--wb-font-ui");
    return;
  }
  root.style.setProperty("--wb-font-ui", resolveUiFontStack(name));
}

export function fontFamilyLabel(font: FontFamilyPref): string {
  const name = normalizeFontFamily(font);
  return name || SYSTEM_DEFAULT_LABEL;
}

/** @deprecated Use fontFamilyLabel. */
export function fontPresetLabel(font: FontFamilyPref): string {
  return fontFamilyLabel(font);
}
