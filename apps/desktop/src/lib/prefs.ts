import { dataFilePath, ensureDataDir, isTauriRuntime, PREFS_FILE } from "./paths";

const PREFS_KEY = "wb.prefs.v1";

export type UiLanguage = "system" | "zh-CN" | "en";
export type WorkMode = "office" | "focus";
export type StartupView = "today" | "planner" | "projects" | "knowledge";
export type WeekStart = "monday" | "sunday";
export type DefaultRemind = "none" | "m5" | "m15" | "m30" | "h1";
export type NoteEditorDefault = "live" | "source" | "preview";
export type WindowRestore = "default" | "maximized" | "remember";

export type AppPrefs = {
  displayName: string;
  uiLanguage: UiLanguage;
  workMode: WorkMode;
  proactiveSuggest: boolean;
  showTips: boolean;
  startupView: StartupView;
  weekStartsOn: WeekStart;
  defaultRemind: DefaultRemind;
  noteEditorDefault: NoteEditorDefault;
  windowRestore: WindowRestore;
  confirmBeforeDelete: boolean;
  openLastNote: boolean;
  httpProxy: string;
  enhancedSearch: boolean;
  systemNotifications: boolean;
  warningNotifications: boolean;
  completionSound: boolean;
};

const DEFAULTS: AppPrefs = {
  displayName: "本地用户",
  uiLanguage: "system",
  workMode: "office",
  proactiveSuggest: false,
  showTips: true,
  startupView: "today",
  weekStartsOn: "monday",
  defaultRemind: "m15",
  noteEditorDefault: "live",
  windowRestore: "default",
  confirmBeforeDelete: true,
  openLastNote: true,
  httpProxy: "",
  enhancedSearch: true,
  systemNotifications: true,
  warningNotifications: true,
  completionSound: false,
};

function mergePrefs(partial?: Partial<AppPrefs> | null): AppPrefs {
  return { ...DEFAULTS, ...(partial ?? {}) };
}

export function readPrefs(): AppPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULTS };
    return mergePrefs(JSON.parse(raw) as Partial<AppPrefs>);
  } catch {
    return { ...DEFAULTS };
  }
}

export function writePrefs(prefs: AppPrefs): void {
  const json = JSON.stringify(prefs);
  try {
    localStorage.setItem(PREFS_KEY, json);
  } catch {
    // ignore
  }
  if (isTauriRuntime()) {
    void (async () => {
      try {
        await ensureDataDir();
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(await dataFilePath(PREFS_FILE), json);
      } catch {
        // keep localStorage copy
      }
    })();
  }
}

/** Load prefs from AppData when available (Tauri). */
export async function hydratePrefs(): Promise<AppPrefs> {
  if (!isTauriRuntime()) return readPrefs();
  try {
    await ensureDataDir();
    const { exists, readTextFile, writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await dataFilePath(PREFS_FILE);
    if (await exists(path)) {
      const raw = await readTextFile(path);
      const prefs = mergePrefs(JSON.parse(raw) as Partial<AppPrefs>);
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      return prefs;
    }
    const legacy = readPrefs();
    await writeTextFile(path, JSON.stringify(legacy));
    return legacy;
  } catch {
    return readPrefs();
  }
}

export function uiLanguageLabel(v: UiLanguage): string {
  if (v === "zh-CN") return "简体中文";
  if (v === "en") return "English";
  return "系统默认";
}

export function workModeLabel(v: WorkMode): string {
  return v === "focus" ? "专注模式" : "办公模式";
}

export function startupViewLabel(v: StartupView): string {
  if (v === "planner") return "计划";
  if (v === "projects") return "项目";
  if (v === "knowledge") return "知识库";
  return "今日";
}

export function weekStartLabel(v: WeekStart): string {
  return v === "sunday" ? "周日" : "周一";
}

export function defaultRemindLabel(v: DefaultRemind): string {
  if (v === "none") return "不提醒";
  if (v === "m5") return "提前 5 分钟";
  if (v === "m15") return "提前 15 分钟";
  if (v === "m30") return "提前 30 分钟";
  return "提前 1 小时";
}

export function noteEditorDefaultLabel(v: NoteEditorDefault): string {
  if (v === "source") return "源码";
  if (v === "preview") return "预览";
  return "实时";
}

export function windowRestoreLabel(v: WindowRestore): string {
  if (v === "maximized") return "最大化";
  if (v === "remember") return "记住上次";
  return "默认";
}
