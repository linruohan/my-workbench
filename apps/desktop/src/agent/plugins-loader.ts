import {
  commandFromFile,
  discoverSkillsFromSnapshot,
  joinPath,
  parseHooksDocument,
  parseMcpDocument,
  parseMcpMap,
  parsePluginManifest,
  skillFileNameCandidates,
  subagentFromFile,
  type AgentSkill,
  type LoadedPlugin,
  type SkillSourceDir,
} from "@wb/domain";
import { isTauriRuntime } from "../lib/paths";
import { listDirectory, readTextFile } from "../notes/kb-api";
import { pickLocalDirectory } from "./skills-loader";

type AskPath = (opts: {
  title: string;
  label: string;
  initialValue?: string;
}) => Promise<string | null>;

export type { LoadedPlugin };

export async function pickPluginDirectory(askPath?: AskPath): Promise<string | null> {
  return pickLocalDirectory(
    "选择插件目录",
    askPath,
    "插件根目录，内含 .workbench-plugin/plugin.json 或 .zcode-plugin/plugin.json",
  );
}

/** Read enabled plugin folders. Browser preview returns nothing. */
export async function loadAgentPlugins(dirs: SkillSourceDir[]): Promise<LoadedPlugin[]> {
  if (!isTauriRuntime()) return [];
  const out: LoadedPlugin[] = [];
  for (const dir of dirs) {
    if (!dir.enabled) continue;
    out.push(await readPlugin(dir));
  }
  return out;
}

async function readPlugin(dir: SkillSourceDir): Promise<LoadedPlugin> {
  const empty: LoadedPlugin = {
    id: dir.id,
    path: dir.path,
    enabled: true,
    name: dir.path,
    version: "",
    description: "",
    skills: [],
    commands: [],
    subagents: [],
    hooks: [],
    mcp: [],
  };
  try {
    const manifestRaw = await readFirst([
      joinPath(joinPath(dir.path, ".workbench-plugin"), "plugin.json"),
      joinPath(joinPath(dir.path, ".zcode-plugin"), "plugin.json"),
    ]);
    if (!manifestRaw) return { ...empty, error: "缺少 plugin.json" };
    const manifest = parsePluginManifest(manifestRaw);
    if (!manifest) return { ...empty, error: "plugin.json 无法解析" };
    const skills = await loadSkills(dir, joinPath(dir.path, manifest.skillsDir));
    const commands = (await listMarkdown(joinPath(dir.path, manifest.commandsDir)))
      .map((file) => commandFromFile(file.fileName, file.raw, dir.id))
      .filter((item): item is NonNullable<typeof item> => item != null);
    const subagents = (await listMarkdown(joinPath(dir.path, manifest.agentsDir)))
      .map((file) => subagentFromFile(file.fileName, file.raw, dir.id))
      .filter((item): item is NonNullable<typeof item> => item != null);
    const hooksRaw = await readFirst([joinPath(dir.path, manifest.hooksFile)]);
    const mcpRaw = await readFirst([joinPath(dir.path, ".mcp.json")]);
    let manifestMcp: ReturnType<typeof parseMcpMap> = [];
    try {
      const parsed = JSON.parse(manifestRaw) as { mcpServers?: unknown };
      manifestMcp = parseMcpMap(parsed.mcpServers, dir.id);
    } catch {
      manifestMcp = [];
    }
    const fileMcp = mcpRaw ? parseMcpDocument(mcpRaw, dir.id) : [];
    return {
      ...empty,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      skills,
      commands,
      subagents,
      hooks: hooksRaw ? parseHooksDocument(hooksRaw, dir.id) : [],
      mcp: dedupeMcp([...manifestMcp, ...fileMcp]),
    };
  } catch (error) {
    return {
      ...empty,
      error: error instanceof Error ? error.message : "无法读取插件",
    };
  }
}

function dedupeMcp(servers: LoadedPlugin["mcp"]): LoadedPlugin["mcp"] {
  const seen = new Set<string>();
  return servers.filter((server) => {
    const key = server.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadSkills(
  dir: SkillSourceDir,
  skillsPath: string,
): Promise<AgentSkill[]> {
  const rootSkillMd = await readSkillMarkdown(skillsPath);
  const children: Array<{ name: string; path: string; skillMd: string | null }> = [];
  try {
    const entries = await listDirectory(skillsPath);
    for (const entry of entries) {
      if (!entry.isDir || entry.name.startsWith(".")) continue;
      children.push({
        name: entry.name,
        path: entry.path,
        skillMd: await readSkillMarkdown(entry.path),
      });
    }
  } catch {
    // Skills directory may be absent.
  }
  return discoverSkillsFromSnapshot(
    { ...dir, path: skillsPath, enabled: true },
    { rootSkillMd, children },
  );
}

async function readSkillMarkdown(dirPath: string): Promise<string | null> {
  for (const name of skillFileNameCandidates()) {
    try {
      return await readTextFile(joinPath(dirPath, name));
    } catch {
      // try the next filename
    }
  }
  return null;
}

async function listMarkdown(
  dir: string,
): Promise<Array<{ fileName: string; raw: string }>> {
  let entries: Awaited<ReturnType<typeof listDirectory>> = [];
  try {
    entries = await listDirectory(dir);
  } catch {
    return [];
  }
  const files: Array<{ fileName: string; raw: string }> = [];
  for (const entry of entries) {
    if (entry.isDir || !entry.name.toLowerCase().endsWith(".md")) continue;
    try {
      files.push({ fileName: entry.name, raw: await readTextFile(entry.path) });
    } catch {
      // skip unreadable files
    }
  }
  return files;
}

async function readFirst(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      return await readTextFile(path);
    } catch {
      // try the next candidate
    }
  }
  return null;
}
