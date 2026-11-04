/**
 * Agent skills: user-added directories of SKILL.md packs.
 * Discovery and parsing stay pure; the host supplies filesystem snapshots.
 */

import { createId } from "./id.js";
import { joinPath, normalizePath } from "./kb.js";

/** One folder the user registered under Settings → 技能. */
export type SkillSourceDir = {
  id: string;
  path: string;
  enabled: boolean;
  addedAt: number;
};

/** A discovered skill pack ready for the Agent. */
export type AgentSkill = {
  /** Stable id derived from the skill directory path. */
  id: string;
  name: string;
  description: string;
  /** Absolute path to the skill folder. */
  dirPath: string;
  /** Source directory id that contributed this skill. */
  sourceDirId: string;
  /** Markdown body after frontmatter. */
  body: string;
  /** False when the user switched this skill off. Omitted means on. */
  enabled?: boolean;
};

export type SkillSummary = Pick<AgentSkill, "id" | "name" | "description" | "dirPath">;

const SKILL_FILE_NAMES = ["SKILL.md", "skill.md"] as const;

/** Normalize and dedupe a user-picked skill root path. */
export function normalizeSkillRootPath(path: string): string {
  return normalizePath(path.trim());
}

export function skillRootsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const key = (path: string) =>
    normalizeSkillRootPath(path)
      .replace(/[\\/]+/g, "/")
      .toLowerCase();
  return key(a) === key(b);
}

export function addSkillSourceDir(
  roots: SkillSourceDir[],
  path: string,
  nowMs = Date.now(),
): { roots: SkillSourceDir[]; added: SkillSourceDir | null; reason?: string } {
  const normalized = normalizeSkillRootPath(path);
  if (!normalized) {
    return { roots, added: null, reason: "路径不能为空" };
  }
  if (roots.some((item) => skillRootsMatch(item.path, normalized))) {
    return { roots, added: null, reason: "该目录已添加" };
  }
  const added: SkillSourceDir = {
    id: createId(nowMs),
    path: normalized,
    enabled: true,
    addedAt: nowMs,
  };
  return { roots: [...roots, added], added };
}

export function removeSkillSourceDir(
  roots: SkillSourceDir[],
  id: string,
): SkillSourceDir[] {
  return roots.filter((item) => item.id !== id);
}

export function setSkillSourceDirEnabled(
  roots: SkillSourceDir[],
  id: string,
  enabled: boolean,
): SkillSourceDir[] {
  return roots.map((item) => (item.id === id ? { ...item, enabled } : item));
}

/** Parse Cursor-style SKILL.md (YAML frontmatter + markdown body). */
export function parseSkillMarkdown(
  raw: string,
  fallbackName: string,
): { name: string; description: string; body: string } {
  const trimmed = raw.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(trimmed);
  if (!match) {
    const body = trimmed.trim();
    return {
      name: sanitizeSkillName(fallbackName),
      description: firstLineDescription(body) || `技能 ${fallbackName}`,
      body,
    };
  }
  const meta = parseSimpleFrontmatter(match[1] ?? "");
  const body = (match[2] ?? "").trim();
  const name = sanitizeSkillName(
    typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : fallbackName,
  );
  const description =
    typeof meta.description === "string" && meta.description.trim()
      ? meta.description.trim()
      : firstLineDescription(body) || `技能 ${name}`;
  return { name, description, body };
}

export function skillIdFromDirPath(dirPath: string): string {
  return `skill:${normalizeSkillRootPath(dirPath).toLowerCase()}`;
}

export function skillFileNameCandidates(): readonly string[] {
  return SKILL_FILE_NAMES;
}

/** Host listing of one registered root for pure discovery. */
export type SkillRootSnapshot = {
  /** Content of SKILL.md directly under the root, if any. */
  rootSkillMd: string | null;
  /** Immediate child directories that may themselves be skills. */
  children: Array<{
    name: string;
    path: string;
    skillMd: string | null;
  }>;
};

/**
 * Discover skills under one source directory.
 * A root that itself contains SKILL.md counts as one skill;
 * each immediate child with SKILL.md is also a skill.
 */
export function discoverSkillsFromSnapshot(
  source: SkillSourceDir,
  snapshot: SkillRootSnapshot,
): AgentSkill[] {
  if (!source.enabled) return [];
  const out: AgentSkill[] = [];
  const seen = new Set<string>();

  const push = (dirPath: string, folderName: string, skillMd: string | null) => {
    if (!skillMd) return;
    const parsed = parseSkillMarkdown(skillMd, folderName);
    const id = skillIdFromDirPath(dirPath);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      name: parsed.name,
      description: parsed.description,
      dirPath: normalizeSkillRootPath(dirPath),
      sourceDirId: source.id,
      body: parsed.body,
    });
  };

  const rootName = folderNameFromPath(source.path) || "skill";
  push(source.path, rootName, snapshot.rootSkillMd);

  for (const child of snapshot.children) {
    push(
      child.path,
      child.name || folderNameFromPath(child.path) || "skill",
      child.skillMd,
    );
  }

  return out;
}

/** Prefer unique names; on collision keep the first and suffix later ones. */
export function dedupeSkillNames(skills: AgentSkill[]): AgentSkill[] {
  const counts = new Map<string, number>();
  return skills.map((skill) => {
    const key = skill.name.toLowerCase();
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    if (n === 0) return skill;
    return { ...skill, name: `${skill.name}-${n + 1}` };
  });
}

/** Remember a skill the user switched off. Turning it back on drops the id. */
export function setSkillEnabled(
  disabledIds: readonly string[],
  id: string,
  enabled: boolean,
): string[] {
  const next = disabledIds.filter((item) => item !== id);
  if (!enabled) next.push(id);
  return next;
}

export function skillIsOn(skill: { enabled?: boolean }): boolean {
  return skill.enabled !== false;
}

/** Sits after a skill the user picked from the menu. Typing the name does not add it. */
export const SKILL_PICK_MARK = "\u200b";

export type SkillComposerToken = { start: number; end: number };

/** Insert `/name` as a picked skill, followed by the invisible mark and a space. */
export function acceptSkillSlashToken(draft: string, name: string): string {
  const token = `/${name}${SKILL_PICK_MARK}`;
  if (/\/[^\s/]*$/.test(draft)) return draft.replace(/\/[^\s/]*$/, `${token} `);
  const gap = draft.length === 0 || /\s$/.test(draft) ? "" : " ";
  return `${draft}${gap}${token} `;
}

export function stripSkillPickMarks(text: string): string {
  return text.split(SKILL_PICK_MARK).join("");
}

/** Drop marks that no longer sit directly after a complete skill name. */
export function tidySkillPickMarks(
  text: string,
  skills: readonly { name: string; enabled?: boolean }[],
): string {
  if (!text.includes(SKILL_PICK_MARK)) return text;
  const names = new Set(
    skills
      .filter((skill) => skillIsOn(skill) && skill.name.trim())
      .map((skill) => skill.name),
  );
  let out = "";
  for (const ch of text) {
    if (ch !== SKILL_PICK_MARK) {
      out += ch;
      continue;
    }
    const kept = [...names].some((name) => {
      const token = `/${name}`;
      if (!out.endsWith(token)) return false;
      const before = out.length - token.length;
      return before === 0 || /\s/.test(out[before - 1] ?? "");
    });
    if (kept) out += ch;
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Picked `/name` tokens. The range includes the slash and excludes the invisible mark. */
export function skillComposerTokens(
  text: string,
  skills: readonly { name: string; enabled?: boolean }[],
): SkillComposerToken[] {
  const names = [
    ...new Set(
      skills
        .filter((skill) => skillIsOn(skill) && skill.name.trim())
        .map((skill) => skill.name),
    ),
  ].sort((a, b) => b.length - a.length);
  if (!names.length || !text) return [];
  const pattern = new RegExp(
    `(^|\\s)(/(?:${names.map(escapeRegExp).join("|")}))(?=${SKILL_PICK_MARK})`,
    "g",
  );
  const tokens: SkillComposerToken[] = [];
  for (const match of text.matchAll(pattern)) {
    const lead = match[1]?.length ?? 0;
    const token = match[2] ?? "";
    const start = (match.index ?? 0) + lead;
    tokens.push({ start, end: start + token.length });
  }
  return tokens;
}

/**
 * Backspace or Delete inside a matched skill removes the whole name and leaves `/`.
 * Returns null when the key does not touch a skill name.
 */
export function collapseSkillTokenOnDelete(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  key: "Backspace" | "Delete",
  skills: readonly { name: string; enabled?: boolean }[],
): { text: string; caret: number } | null {
  const tokens = skillComposerTokens(text, skills);
  if (!tokens.length) return null;
  let from = Math.min(selectionStart, selectionEnd);
  let to = Math.max(selectionStart, selectionEnd);
  if (from === to) {
    if (key === "Backspace") {
      if (from === 0) return null;
      from -= 1;
    } else if (to >= text.length) {
      return null;
    } else {
      to += 1;
    }
  }
  const touched = tokens.filter((token) => {
    const markEnd = text[token.end] === SKILL_PICK_MARK ? token.end + 1 : token.end;
    return from < markEnd && to > token.start + 1;
  });
  if (!touched.length) return null;
  const skip = new Set<number>();
  for (let index = from; index < to; index += 1) skip.add(index);
  for (const token of touched) {
    skip.delete(token.start);
    for (let index = token.start + 1; index < token.end; index += 1) skip.add(index);
    if (text[token.end] === SKILL_PICK_MARK) skip.add(token.end);
  }
  let next = "";
  for (let index = 0; index < text.length; index += 1) {
    if (!skip.has(index)) next += text[index];
  }
  const anchor = touched[0]!;
  let caret = 0;
  for (let index = 0; index < anchor.start + 1; index += 1) {
    if (!skip.has(index)) caret += 1;
  }
  return { text: next, caret };
}

/** Skills that still enter the session. An empty disabled list keeps every skill. */
export function enabledSkills(
  skills: readonly AgentSkill[],
  disabledIds: readonly string[],
): AgentSkill[] {
  if (disabledIds.length === 0) return [...skills];
  const off = new Set(disabledIds);
  return skills.filter((skill) => !off.has(skill.id));
}

export function listEnabledSkillSummaries(skills: AgentSkill[]): SkillSummary[] {
  return skills.filter(skillIsOn).map(({ id, name, description, dirPath }) => ({
    id,
    name,
    description,
    dirPath,
  }));
}

export function findSkill(skills: AgentSkill[], query: string): AgentSkill | null {
  const q = query.trim();
  if (!q) return null;
  const byId = skills.find((item) => item.id === q);
  if (byId) return byId;
  const lower = q.toLowerCase();
  return (
    skills.find((item) => item.name.toLowerCase() === lower) ??
    skills.find((item) => item.name.toLowerCase().includes(lower)) ??
    null
  );
}

/** A `/name` token. Skills are invoked with a slash, same as commands. */
function skillSlashPattern(): RegExp {
  return /(?:^|\s)\/([^\s/]+)/g;
}

/** Exact `/name` match. Partial names stay as ordinary text. */
export function findSkillBySlashName(
  skills: readonly AgentSkill[],
  name: string,
): AgentSkill | null {
  const folded = name.trim().toLowerCase();
  if (!folded) return null;
  return skills.find((item) => item.name.toLowerCase() === folded) ?? null;
}

/** Skills the user named with / in this message, in first-seen order. */
export function invokedSkillsInText(skills: AgentSkill[], text: string): AgentSkill[] {
  const found: AgentSkill[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(skillSlashPattern())) {
    const skill = findSkillBySlashName(skills, match[1] ?? "");
    if (!skill || !skillIsOn(skill) || seen.has(skill.id)) continue;
    seen.add(skill.id);
    found.push(skill);
  }
  return found;
}

/** Drop `/name` tokens that name a known skill, leaving the rest of the request. */
export function omitInvokedSkillTokens(skills: AgentSkill[], text: string): string {
  return text
    .replace(skillSlashPattern(), (full, name: string) => {
      const found = findSkillBySlashName(skills, name);
      return found && skillIsOn(found) ? " " : full;
    })
    .replace(/\s+/g, " ")
    .trim();
}

type SkillHistoryMessage = {
  role: string;
  content: string;
  toolName?: string | null;
};

const LOADED_SKILL = /已加载技能「([^」]+)」/;

/** Skills still named in the model-visible transcript, including earlier turns. */
export function skillsLoadedInTranscript(
  skills: AgentSkill[],
  messages: readonly SkillHistoryMessage[],
): AgentSkill[] {
  const found: AgentSkill[] = [];
  const seen = new Set<string>();
  const add = (skill: AgentSkill | null) => {
    if (!skill || !skillIsOn(skill) || seen.has(skill.id)) return;
    seen.add(skill.id);
    found.push(skill);
  };
  for (const message of messages) {
    if (message.role === "tool" && message.toolName === "skill_load") {
      const named = LOADED_SKILL.exec(message.content)?.[1] ?? "";
      add(named ? findSkill(skills, named) : null);
    }
    for (const match of message.content.matchAll(skillSlashPattern())) {
      add(findSkillBySlashName(skills, match[1] ?? ""));
    }
  }
  return found;
}

/** Skill bodies that should stay in the prompt until compact drops their mention. */
export function formatActiveSkills(
  skills: AgentSkill[],
  messages: readonly SkillHistoryMessage[],
): string {
  const loaded = skillsLoadedInTranscript(skills, messages);
  if (loaded.length === 0) return "";
  return loaded
    .map((skill) => {
      const body = skill.body.trim();
      return [`技能「${skill.name}」仍在这次会话里。继续按它的说明做。`, body]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/** Full instructions for skills the user explicitly named in the latest message. */
export function formatInvokedSkills(skills: AgentSkill[], text: string): string {
  const invoked = invokedSkillsInText(skills, text);
  if (invoked.length === 0) return "";
  return invoked
    .map((skill) => {
      const body = skill.body.trim();
      return [`用户在这条消息里点名了技能「${skill.name}」。按它的说明完成请求。`, body]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export function formatSkillsForPrompt(skills: SkillSummary[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => `- /${skill.name}：${skill.description}`);
  return ["已启用技能（用 /名称 点名；需要完整说明时调用 skill_load）：", ...lines].join(
    "\n",
  );
}

export function joinSkillFile(dirPath: string, fileName: string): string {
  return joinPath(dirPath, fileName);
}

function sanitizeSkillName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fff.-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "skill";
}

function firstLineDescription(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const text = line.replace(/^#+\s*/, "").trim();
    if (text) return text.slice(0, 160);
  }
  return "";
}

function parseSimpleFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function folderNameFromPath(path: string): string {
  const normalized = normalizeSkillRootPath(path).replace(/[\\/]+$/, "");
  const idx = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}
