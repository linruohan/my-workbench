import {
  dataFilePath,
  ensureDataDir,
  isTauriRuntime,
  THEME_FILE,
} from "./paths";
import type { ThemeMode } from "@wb/theme";

export async function hydrateThemeMode(
  fallback: ThemeMode,
): Promise<ThemeMode> {
  if (!isTauriRuntime()) return fallback;
  try {
    await ensureDataDir();
    const { exists, readTextFile, writeTextFile } = await import(
      "@tauri-apps/plugin-fs"
    );
    const path = await dataFilePath(THEME_FILE);
    if (await exists(path)) {
      const raw = JSON.parse(await readTextFile(path)) as { mode?: ThemeMode };
      if (raw.mode === "system" || raw.mode === "light" || raw.mode === "dark") {
        return raw.mode;
      }
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
      await writeTextFile(
        await dataFilePath(THEME_FILE),
        JSON.stringify({ mode }),
      );
    } catch {
      // ignore
    }
  })();
}
