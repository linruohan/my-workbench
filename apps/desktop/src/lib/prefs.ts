const PREFS_KEY = "wb.prefs.v1";

export type AppPrefs = {
  showTips: boolean;
  systemNotifications: boolean;
  warningNotifications: boolean;
  completionSound: boolean;
  displayName: string;
};

const DEFAULTS: AppPrefs = {
  showTips: true,
  systemNotifications: true,
  warningNotifications: true,
  completionSound: false,
  displayName: "本地用户",
};

export function readPrefs(): AppPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppPrefs>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writePrefs(prefs: AppPrefs): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}
