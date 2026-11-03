/** Named helpers with their own instructions and an optional tool allowlist. */

import { createId } from "./id.js";

export type AgentSubagent = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  toolNames: string[];
  source: "user" | "plugin";
};

const NAME = /^[\p{L}][\p{L}\p{N}_-]{0,31}$/u;

export function isSubagentName(name: string): boolean {
  return NAME.test(name.trim());
}

export function addAgentSubagent(
  list: readonly AgentSubagent[],
  input: { name: string; description: string; prompt: string; toolNames?: string[] },
  nowMs = Date.now(),
): { subagents: AgentSubagent[]; added: AgentSubagent | null; reason?: string } {
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  const description = input.description.trim() || firstLine(prompt) || name;
  if (!isSubagentName(name)) {
    return { subagents: [...list], added: null, reason: "名称需以字母开头，最长 32 字" };
  }
  if (list.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
    return { subagents: [...list], added: null, reason: "已经有同名子智能体" };
  }
  if (!prompt) return { subagents: [...list], added: null, reason: "请写子智能体说明" };
  const added: AgentSubagent = {
    id: createId(nowMs),
    name,
    description: description.slice(0, 160),
    prompt,
    toolNames: cleanTools(input.toolNames ?? []),
    source: "user",
  };
  return { subagents: [...list, added], added };
}

export function removeAgentSubagent(
  list: readonly AgentSubagent[],
  id: string,
): AgentSubagent[] {
  return list.filter((item) => item.id !== id);
}

export function findSubagent(
  list: readonly AgentSubagent[],
  name: string,
): AgentSubagent | null {
  const folded = name.trim().toLowerCase();
  if (!folded) return null;
  return list.find((item) => item.name.toLowerCase() === folded) ?? null;
}

export function formatSubagentsForPrompt(list: readonly AgentSubagent[]): string {
  if (list.length === 0) return "";
  const lines = list.map((item) => `- ${item.name}：${item.description}`);
  return ["可用子智能体（用户可用 /agent 名称 任务）：", ...lines].join("\n");
}

export function formatSubagentList(list: readonly AgentSubagent[]): string {
  if (list.length === 0) return "还没有子智能体。可以在设置里添加，或由已启用插件注册。";
  return list.map((item) => `- \`${item.name}\` ${item.description}`).join("\n");
}

export function subagentTurnText(agent: AgentSubagent, task: string): string {
  return `（子智能体 ${agent.name}）\n${task.trim()}`;
}

export function parseSubagentMarkdown(
  raw: string,
  fallbackName: string,
): { name: string; description: string; prompt: string; toolNames: string[] } | null {
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return null;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(trimmed);
  const meta = match ? parseFrontmatter(match[1] ?? "") : {};
  const prompt = (match ? (match[2] ?? "") : trimmed).trim();
  if (!prompt) return null;
  const name = (typeof meta.name === "string" ? meta.name : fallbackName).trim();
  if (!isSubagentName(name)) return null;
  const description =
    (typeof meta.description === "string" && meta.description.trim()) ||
    firstLine(prompt) ||
    name;
  const toolsRaw = typeof meta.tools === "string" ? meta.tools : "";
  return {
    name,
    description: description.slice(0, 160),
    prompt,
    toolNames: cleanTools(toolsRaw.split(/[,，\s]+/)),
  };
}

export function subagentFromFile(
  fileName: string,
  raw: string,
  idPrefix: string,
): AgentSubagent | null {
  const fallback = fileName.replace(/\.md$/i, "");
  const parsed = parseSubagentMarkdown(raw, fallback);
  if (!parsed) return null;
  return {
    id: `${idPrefix}:${parsed.name.toLowerCase()}`,
    ...parsed,
    source: "plugin",
  };
}

export function mergeSubagents(
  user: readonly AgentSubagent[],
  plugin: readonly AgentSubagent[],
): AgentSubagent[] {
  const seen = new Set<string>();
  const out: AgentSubagent[] = [];
  for (const agent of [...user, ...plugin]) {
    const key = agent.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(agent);
  }
  return out;
}

function cleanTools(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function firstLine(body: string): string {
  const line = body
    .split(/\r?\n/)
    .map((item) => item.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return line?.slice(0, 160) ?? "";
}

function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const split = line.indexOf(":");
    if (split <= 0) continue;
    const key = line.slice(0, split).trim();
    const value = line
      .slice(split + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key) out[key] = value;
  }
  return out;
}
