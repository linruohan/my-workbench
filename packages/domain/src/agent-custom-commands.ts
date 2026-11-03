/** User and plugin slash commands. Markdown body is a prompt template. */

import { createId } from "./id.js";

export type AgentCustomCommand = {
  id: string;
  name: string;
  summary: string;
  body: string;
  source: "user" | "plugin";
};

const NAME = /^[\p{L}][\p{L}\p{N}_-]{0,31}$/u;

export function isCommandName(name: string): boolean {
  return NAME.test(name.trim());
}

export function expandCommandTemplate(body: string, args: string): string {
  const trimmed = args.trim();
  const parts = trimmed ? trimmed.split(/\s+/) : [];
  let text = body.replaceAll("$ARGUMENTS", trimmed);
  parts.forEach((part, index) => {
    text = text.replaceAll(`$${index + 1}`, part);
  });
  return text.trim();
}

export function parseCommandMarkdown(
  raw: string,
  fallbackName: string,
): { name: string; summary: string; body: string } | null {
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return null;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(trimmed);
  const meta = match ? parseFrontmatter(match[1] ?? "") : {};
  const body = (match ? (match[2] ?? "") : trimmed).trim();
  if (!body) return null;
  const name = sanitize(typeof meta.name === "string" ? meta.name : fallbackName);
  if (!name) return null;
  const summary =
    (typeof meta.description === "string" && meta.description.trim()) ||
    firstLine(body) ||
    name;
  return { name, summary: summary.slice(0, 120), body };
}

export function addAgentCommand(
  list: readonly AgentCustomCommand[],
  input: { name: string; summary: string; body: string },
  taken: readonly string[],
  nowMs = Date.now(),
): { commands: AgentCustomCommand[]; added: AgentCustomCommand | null; reason?: string } {
  const name = input.name.trim();
  const body = input.body.trim();
  const summary = input.summary.trim() || firstLine(body) || name;
  if (!isCommandName(name)) {
    return { commands: [...list], added: null, reason: "命令名需以字母开头，最长 32 字" };
  }
  const folded = name.toLowerCase();
  if (
    taken.some((item) => item.toLowerCase() === folded) ||
    list.some((item) => item.name.toLowerCase() === folded)
  ) {
    return { commands: [...list], added: null, reason: "这个命令名已被占用" };
  }
  if (!body) return { commands: [...list], added: null, reason: "请写命令正文" };
  const added: AgentCustomCommand = {
    id: createId(nowMs),
    name,
    summary: summary.slice(0, 120),
    body,
    source: "user",
  };
  return { commands: [...list, added], added };
}

export function removeAgentCommand(
  list: readonly AgentCustomCommand[],
  id: string,
): AgentCustomCommand[] {
  return list.filter((item) => item.id !== id);
}

export function commandFromFile(
  fileName: string,
  raw: string,
  idPrefix: string,
): AgentCustomCommand | null {
  const fallback = fileName.replace(/\.md$/i, "");
  const parsed = parseCommandMarkdown(raw, fallback);
  if (!parsed) return null;
  return {
    id: `${idPrefix}:${parsed.name.toLowerCase()}`,
    name: parsed.name,
    summary: parsed.summary,
    body: parsed.body,
    source: "plugin",
  };
}

export function mergeCustomCommands(
  user: readonly AgentCustomCommand[],
  plugin: readonly AgentCustomCommand[],
): AgentCustomCommand[] {
  const seen = new Set<string>();
  const out: AgentCustomCommand[] = [];
  for (const command of [...user, ...plugin]) {
    if (!isCommandName(command.name)) continue;
    const key = command.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(command);
  }
  return out;
}

function sanitize(name: string): string {
  const trimmed = name.trim();
  return isCommandName(trimmed) ? trimmed : "";
}

function firstLine(body: string): string {
  const line = body
    .split(/\r?\n/)
    .map((item) => item.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return line?.slice(0, 120) ?? "";
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
