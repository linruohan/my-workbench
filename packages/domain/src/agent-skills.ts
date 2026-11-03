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

export function listEnabledSkillSummaries(skills: AgentSkill[]): SkillSummary[] {
  return skills.map(({ id, name, description, dirPath }) => ({
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

/** Compact block for the system prompt; empty when no skills. */
const SKILL_MENTION = /(?:^|\s)@([^\s@]+)/g;

/** Skills the user named with @ in this message, in first-seen order. */
export function invokedSkillsInText(skills: AgentSkill[], text: string): AgentSkill[] {
  const found: AgentSkill[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(SKILL_MENTION)) {
    const skill = findSkill(skills, match[1] ?? "");
    if (!skill || seen.has(skill.id)) continue;
    seen.add(skill.id);
    found.push(skill);
  }
  return found;
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
  const lines = skills.map((skill) => `- ${skill.name}：${skill.description}`);
  return [
    "已启用技能（需要完整说明时调用 skill_load，参数为技能 name）：",
    ...lines,
  ].join("\n");
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
