import { hostToolById, type HostToolProbe } from "@wb/domain";
import type {
  AgentCustomCommand,
  AgentHook,
  AgentHookEvent,
  AgentMemory,
  AgentSubagent,
  McpServer,
  SkillSourceDir,
} from "@wb/domain";
import { normalizeFontFamily, type FontFamilyPref } from "./fonts";
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
  /** App UI text font. Empty = system default stack. */
  uiFont: FontFamilyPref;
  /** Default font for embedded web pages. Empty = browser default. */
  webFont: FontFamilyPref;
  confirmBeforeDelete: boolean;
  openLastNote: boolean;
  httpProxy: string;
  enhancedSearch: boolean;
  systemNotifications: boolean;
  warningNotifications: boolean;
  completionSound: boolean;
  /** Standing instructions injected into every Agent session. Local only. */
  agentRules: string;
  /** Local skill directories registered in Settings → 技能. */
  skillDirs: SkillSourceDir[];
  /** Facts kept across Agent sessions. */
  agentMemories: AgentMemory[];
  agentHooks: AgentHook[];
  agentSubagents: AgentSubagent[];
  agentCommands: AgentCustomCommand[];
  /** Local plugin folders. */
  pluginDirs: SkillSourceDir[];
  mcpServers: McpServer[];
  /** Catalog ids the user turned off in Settings → 工具. */
  disabledHostTools: string[];
  /** Absolute paths the user confirmed in 工具 → 详情. */
  hostToolPaths: Record<string, string>;
  /** Saved tool detection. Later opens read this instead of fetching again. */
  hostToolRecords: HostToolProbe[];
  /** True after the first automatic fetch has finished. */
  hostToolsFetched: boolean;
  /** Skill ids the user turned off in Settings → 技能. */
  disabledSkillIds: string[];
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
  uiFont: "",
  webFont: "",
  confirmBeforeDelete: true,
  openLastNote: true,
  httpProxy: "",
  enhancedSearch: true,
  systemNotifications: true,
  warningNotifications: true,
  completionSound: false,
  agentRules: "",
  skillDirs: [],
  agentMemories: [],
  agentHooks: [],
  agentSubagents: [],
  agentCommands: [],
  pluginDirs: [],
  mcpServers: [],
  disabledHostTools: [],
  hostToolPaths: {},
  hostToolRecords: [],
  hostToolsFetched: false,
  disabledSkillIds: [],
};

function normalizeSkillDirs(value: unknown): SkillSourceDir[] {
  if (!Array.isArray(value)) return [];
  const out: SkillSourceDir[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<SkillSourceDir>;
    if (typeof row.id !== "string" || !row.id.trim()) continue;
    if (typeof row.path !== "string" || !row.path.trim()) continue;
    out.push({
      id: row.id.trim(),
      path: row.path.trim(),
      enabled: row.enabled !== false,
      addedAt: typeof row.addedAt === "number" ? row.addedAt : 0,
    });
  }
  return out;
}

function mergePrefs(partial?: Partial<AppPrefs> | null): AppPrefs {
  const next = { ...DEFAULTS, ...(partial ?? {}) };
  next.skillDirs = normalizeSkillDirs(next.skillDirs);
  next.pluginDirs = normalizeSkillDirs(next.pluginDirs);
  next.agentMemories = normalizeMemories(next.agentMemories);
  next.agentHooks = normalizeHooks(next.agentHooks);
  next.agentSubagents = normalizeSubagents(next.agentSubagents);
  next.agentCommands = normalizeCommands(next.agentCommands);
  next.mcpServers = normalizeMcp(next.mcpServers);
  next.disabledHostTools = normalizeDisabledHostTools(next.disabledHostTools);
  next.disabledSkillIds = normalizeDisabledHostTools(next.disabledSkillIds);
  next.hostToolPaths = normalizeHostToolPaths(next.hostToolPaths);
  next.hostToolRecords = normalizeHostToolRecords(next.hostToolRecords);
  next.hostToolsFetched = next.hostToolsFetched === true;
  next.uiFont = normalizeFontFamily(next.uiFont);
  next.webFont = normalizeFontFamily(next.webFont);
  return next;
}

function normalizeHostToolRecords(value: unknown): HostToolProbe[] {
  if (!Array.isArray(value)) return [];
  const out: HostToolProbe[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<HostToolProbe>;
    if (typeof row.id !== "string" || !hostToolById(row.id) || seen.has(row.id)) continue;
    if (row.status !== "ready" || typeof row.path !== "string") continue;
    const path = row.path.trim();
    if (!path || path.includes("\0") || path.length > 1024) continue;
    const invoke = Array.isArray(row.invoke)
      ? row.invoke
          .filter(
            (part): part is string => typeof part === "string" && part.trim().length > 0,
          )
          .slice(0, 8)
      : [];
    seen.add(row.id);
    out.push({
      id: row.id,
      status: "ready",
      source: row.source === "managed" || row.source === "manual" ? row.source : "env",
      path,
      version: typeof row.version === "string" ? row.version.slice(0, 200) : "",
      invoke: invoke.length > 0 ? invoke : [path],
    });
  }
  return out;
}

function normalizeHostToolPaths(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, path] of Object.entries(value)) {
    if (typeof path !== "string") continue;
    const id = key.trim();
    const file = path.trim();
    if (!id || !hostToolById(id) || !file || file.includes("\0") || file.length > 1024) {
      continue;
    }
    out[id] = file;
  }
  return out;
}

function normalizeDisabledHostTools(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

function normalizeMemories(value: unknown): AgentMemory[] {
  if (!Array.isArray(value)) return [];
  const out: AgentMemory[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<AgentMemory>;
    if (typeof row.id !== "string" || typeof row.text !== "string" || !row.text.trim()) {
      continue;
    }
    out.push({
      id: row.id,
      text: row.text.trim(),
      createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
    });
  }
  return out;
}

function normalizeHooks(value: unknown): AgentHook[] {
  if (!Array.isArray(value)) return [];
  const events = new Set<AgentHookEvent>([
    "session_start",
    "task_completed",
    "reminder_due",
  ]);
  const out: AgentHook[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<AgentHook>;
    if (
      typeof row.id !== "string" ||
      typeof row.title !== "string" ||
      typeof row.body !== "string"
    ) {
      continue;
    }
    if (!events.has(row.event as AgentHookEvent)) continue;
    out.push({
      id: row.id,
      event: row.event as AgentHookEvent,
      title: row.title.trim(),
      body: row.body.trim(),
      enabled: row.enabled !== false,
    });
  }
  return out;
}

function normalizeSubagents(value: unknown): AgentSubagent[] {
  if (!Array.isArray(value)) return [];
  const out: AgentSubagent[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<AgentSubagent>;
    if (
      typeof row.id !== "string" ||
      typeof row.name !== "string" ||
      typeof row.prompt !== "string"
    ) {
      continue;
    }
    out.push({
      id: row.id,
      name: row.name.trim(),
      description: typeof row.description === "string" ? row.description : "",
      prompt: row.prompt,
      toolNames: Array.isArray(row.toolNames)
        ? row.toolNames.filter((name): name is string => typeof name === "string")
        : [],
      source: "user",
    });
  }
  return out;
}

function normalizeCommands(value: unknown): AgentCustomCommand[] {
  if (!Array.isArray(value)) return [];
  const out: AgentCustomCommand[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<AgentCustomCommand>;
    if (
      typeof row.id !== "string" ||
      typeof row.name !== "string" ||
      typeof row.body !== "string"
    ) {
      continue;
    }
    out.push({
      id: row.id,
      name: row.name.trim(),
      summary: typeof row.summary === "string" ? row.summary : "",
      body: row.body,
      source: "user",
    });
  }
  return out;
}

function normalizeMcp(value: unknown): McpServer[] {
  if (!Array.isArray(value)) return [];
  const out: McpServer[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<McpServer>;
    if (typeof row.id !== "string" || typeof row.name !== "string") continue;
    out.push({
      id: row.id,
      name: row.name.trim(),
      command: typeof row.command === "string" ? row.command : "",
      args: Array.isArray(row.args)
        ? row.args.filter((arg): arg is string => typeof arg === "string")
        : [],
      url: typeof row.url === "string" ? row.url : "",
      enabled: row.enabled !== false,
      source: "user",
    });
  }
  return out;
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
