import { TYPE } from "@wb/theme";
import { isTauriRuntime } from "./paths";

/** Empty string means the built-in Mac-style system stack. */
export type FontFamilyPref = string;

export const SYSTEM_DEFAULT_LABEL = "系统默认（Mac 风格）";

const FORBIDDEN = /["';{}<>\\\n\r\0]/;

type LocalFontFace = { family: string };

type FontQueryWindow = Window & {
  queryLocalFonts?: () => Promise<LocalFontFace[]>;
};

let cachedSystemFonts: string[] | null = null;
let systemFontsPromise: Promise<string[]> | null = null;

/** Keep only safe single font-family names for CSS/JS injection. */
export function normalizeFontFamily(value: unknown): FontFamilyPref {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) return "";
  if (FORBIDDEN.test(trimmed)) return "";
  return trimmed;
}

function sanitizeFamilyList(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = normalizeFontFamily(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return out;
}

async function queryBrowserLocalFonts(): Promise<string[]> {
  const query = (window as FontQueryWindow).queryLocalFonts;
  if (typeof query !== "function") return [];
  try {
    const faces = await query.call(window);
    return sanitizeFamilyList(faces.map((face) => face.family));
  } catch {
    return [];
  }
}

/** Installed font families on this machine (cached after first success). */
export async function listSystemFonts(): Promise<string[]> {
  if (cachedSystemFonts) return cachedSystemFonts;
  if (!systemFontsPromise) {
    systemFontsPromise = (async () => {
      if (isTauriRuntime()) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const families = await invoke<string[]>("list_system_fonts");
          return sanitizeFamilyList(families);
        } catch {
          // Fall through to browser API when the host command is unavailable.
        }
      }
      return queryBrowserLocalFonts();
    })().then((fonts) => {
      cachedSystemFonts = fonts;
      return fonts;
    });
  }
  return systemFontsPromise;
}

/** Build `<select>` options: system default first, then installed families. */
export function buildFontOptions(systemFonts: string[]): Array<[string, string]> {
  const options: Array<[string, string]> = [["", SYSTEM_DEFAULT_LABEL]];
  for (const name of systemFonts) {
    options.push([name, name]);
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
