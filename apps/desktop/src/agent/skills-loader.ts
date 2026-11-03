import {
  dedupeSkillNames,
  discoverSkillsFromSnapshot,
  joinSkillFile,
  skillFileNameCandidates,
  type AgentSkill,
  type SkillRootSnapshot,
  type SkillSourceDir,
} from "@wb/domain";
import { isTauriRuntime } from "../lib/paths";
import { listDirectory, readTextFile } from "../notes/kb-api";

type AskPath = (opts: {
  title: string;
  label: string;
  initialValue?: string;
}) => Promise<string | null>;

/** Open the OS folder picker (or an in-app path prompt in the browser). */
export async function pickLocalDirectory(
  title: string,
  askPath?: AskPath,
  label = "文件夹的完整路径",
): Promise<string | null> {
  if (isTauriRuntime()) {
    const { pickDirectory } = await import("../notes/kb-api");
    return pickDirectory(title);
  }
  if (!askPath) return null;
  const typed = await askPath({ title, label });
  const path = typed?.trim() ?? "";
  return path || null;
}

export async function pickSkillDirectory(askPath?: AskPath): Promise<string | null> {
  return pickLocalDirectory(
    "选择技能目录",
    askPath,
    "技能目录的完整路径（内含 SKILL.md，或子目录各自含 SKILL.md）",
  );
}

async function readSkillMarkdown(dirPath: string): Promise<string | null> {
  for (const name of skillFileNameCandidates()) {
    try {
      return await readTextFile(joinSkillFile(dirPath, name));
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function snapshotRoot(rootPath: string): Promise<SkillRootSnapshot> {
  const rootSkillMd = await readSkillMarkdown(rootPath);
  const children: SkillRootSnapshot["children"] = [];
  try {
    const entries = await listDirectory(rootPath);
    for (const entry of entries) {
      if (!entry.isDir) continue;
      if (entry.name.startsWith(".")) continue;
      children.push({
        name: entry.name,
        path: entry.path,
        skillMd: await readSkillMarkdown(entry.path),
      });
    }
  } catch {
    // Root may itself be a single skill folder without list permission.
  }
  return { rootSkillMd, children };
}

/** Scan enabled skill directories and return discovered packs. */
export async function loadAgentSkills(dirs: SkillSourceDir[]): Promise<AgentSkill[]> {
  const enabled = dirs.filter((item) => item.enabled);
  if (enabled.length === 0) return [];
  if (!isTauriRuntime()) {
    // Browser preview cannot read arbitrary local paths.
    return [];
  }
  const collected: AgentSkill[] = [];
  for (const source of enabled) {
    try {
      const snapshot = await snapshotRoot(source.path);
      collected.push(...discoverSkillsFromSnapshot(source, snapshot));
    } catch {
      // Skip unreadable roots; settings UI can still show the path.
    }
  }
  return dedupeSkillNames(collected);
}
