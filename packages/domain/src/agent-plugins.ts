import type { AgentCustomCommand } from "./agent-custom-commands.js";
import type { AgentHook } from "./agent-hooks.js";
import type { McpServer } from "./agent-mcp.js";
import type { AgentSkill } from "./agent-skills.js";
import type { AgentSubagent } from "./agent-subagents.js";

/** Local plugin manifest. Components are discovered by the host and passed in. */

export type LoadedPlugin = {
  id: string;
  path: string;
  enabled: boolean;
  name: string;
  version: string;
  description: string;
  skills: AgentSkill[];
  commands: AgentCustomCommand[];
  subagents: AgentSubagent[];
  hooks: AgentHook[];
  mcp: McpServer[];
  error?: string;
};

export type PluginManifest = {
  name: string;
  version: string;
  description: string;
  skillsDir: string;
  commandsDir: string;
  agentsDir: string;
  hooksFile: string;
};

export function parsePluginManifest(raw: string): PluginManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return null;
  const version = typeof record.version === "string" ? record.version.trim() : "";
  const description =
    typeof record.description === "string" ? record.description.trim() : "";
  return {
    name,
    version: version || "0",
    description,
    skillsDir: dirName(record.skills, "skills"),
    commandsDir: dirName(record.commands, "commands"),
    agentsDir: dirName(record.agents, "agents"),
    hooksFile: "hooks/hooks.json",
  };
}

export function formatPluginsForPrompt(
  plugins: readonly { name: string; description: string }[],
): string {
  if (plugins.length === 0) return "";
  const lines = plugins.map(
    (plugin) => `- ${plugin.name}${plugin.description ? `：${plugin.description}` : ""}`,
  );
  return ["已启用插件：", ...lines].join("\n");
}

function dirName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!trimmed || trimmed.includes("..")) return fallback;
  return trimmed;
}
