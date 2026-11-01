/** App data folder name under the OS roaming/config root. */
export const APP_DATA_DIR_NAME = "my-workbench";

export const STORE_FILE = "workbench.json";
export const PREFS_FILE = "prefs.json";
export const THEME_FILE = "theme.json";

/** Display path used in settings (Windows default). */
export const DEFAULT_DATA_DIR_DISPLAY =
  "C:\\Users\\Administrator\\AppData\\Roaming\\my-workbench";

export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

/** Resolve the live data directory; falls back to the documented Windows path. */
export async function resolveDataDir(): Promise<string> {
  if (!isTauriRuntime()) return DEFAULT_DATA_DIR_DISPLAY;
  try {
    const { dataDir, join } = await import("@tauri-apps/api/path");
    return await join(await dataDir(), APP_DATA_DIR_NAME);
  } catch {
    return DEFAULT_DATA_DIR_DISPLAY;
  }
}

export async function ensureDataDir(): Promise<string> {
  const dir = await resolveDataDir();
  if (!isTauriRuntime()) return dir;
  const { mkdir, exists } = await import("@tauri-apps/plugin-fs");
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

export async function dataFilePath(fileName: string): Promise<string> {
  const { join } = await import("@tauri-apps/api/path");
  return join(await ensureDataDir(), fileName);
}
