import { coerceThemeMode, type ThemeMode } from "@wb/theme";
import { dataFilePath, ensureDataDir, isTauriRuntime, THEME_FILE } from "./paths";

export async function hydrateThemeMode(fallback: ThemeMode): Promise<ThemeMode> {
  if (!isTauriRuntime()) return fallback;
  try {
    await ensureDataDir();
    const { exists, readTextFile, writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await dataFilePath(THEME_FILE);
    if (await exists(path)) {
      const raw = JSON.parse(await readTextFile(path)) as { mode?: unknown };
      const mode = coerceThemeMode(raw.mode, fallback);
      // Rewrite legacy "system" (or other invalid values) as an explicit theme.
      if (raw.mode !== mode) {
        await writeTextFile(path, JSON.stringify({ mode }));
      }
      return mode;
    }
    await writeTextFile(path, JSON.stringify({ mode: fallback }));
  } catch {
    // keep fallback
  }
  return fallback;
}

export function persistThemeMode(mode: ThemeMode): void {
  if (!isTauriRuntime()) return;
  void (async () => {
    try {
      await ensureDataDir();
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(await dataFilePath(THEME_FILE), JSON.stringify({ mode }));
    } catch {
      // ignore
    }
  })();
}
