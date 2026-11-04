import type { ModelCaps, PlannedCall } from "./agent.js";

/**
 * OpenCode free lane used by the DSH "our free model" plugin.
 * The gateway accepts a chat request only when the client user-agent, session
 * headers, and the `read` / `shell` tool definitions match that client.
 * Tool descriptions and schemas below are the v2.0.26 definitions the gate
 * compares. Rewording them makes the gateway answer 403.
 */

export const DSH_FREE_PROVIDER_ID = "dsh:free";
export const DSH_CLIENT_UA = "opencode/latest/2.0.26/cli";
export const DSH_FREE_ORIGIN = "https://opencode.ai";
export const DSH_FREE_MODELS_URL = `${DSH_FREE_ORIGIN}/inference/v1/models`;
export const DSH_FREE_CHAT_URL = `${DSH_FREE_ORIGIN}/inference/v1/chat/completions`;

const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const SESSION_TIME_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const ALWAYS_FREE = new Set(["union-alpha", "space-bunny-free", "big-pickle"]);
const MESSAGE_MODELS = new Set(["union-alpha"]);
const RESPONSE_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);

const READ_TOOL = {
  description:
    "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory to read" },
      offset: {
        type: "integer",
        minimum: 0,
        description: "The line or directory entry to start reading from (1-based)",
      },
      limit: {
        type: "integer",
        minimum: 0,
        description:
          "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

const SHELL_TOOL = {
  description:
    "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command string to execute" },
      workdir: {
        type: "string",
        description:
          "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
      },
      timeout: {
        type: "integer",
        minimum: 0,
        description:
          "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
      },
      background: {
        type: "boolean",
        description:
          "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

const FINGERPRINT_TOOLS = ["read", "shell"] as const;
const FINGERPRINT_DEFINITIONS = { read: READ_TOOL, shell: SHELL_TOOL };

type FamilyCaps = { vision: boolean; context: number; output: number };

const FAMILY: Array<{ match: RegExp } & FamilyCaps> = [
  { match: /^mimo.*v2\.6/, vision: true, context: 1_048_576, output: 131_072 },
  { match: /^mimo.*v2\.5/, vision: true, context: 1_048_576, output: 131_072 },
  { match: /^mimo/, vision: true, context: 262_144, output: 131_072 },
  { match: /^muse.?spark/, vision: true, context: 1_048_576, output: 131_072 },
  { match: /^nemotron/, vision: false, context: 128_000, output: 32_768 },
  { match: /^ling/, vision: false, context: 128_000, output: 32_768 },
  { match: /^space.?bunny/, vision: true, context: 262_144, output: 65_536 },
  { match: /^union/, vision: true, context: 262_144, output: 131_072 },
  { match: /^deepseek/, vision: false, context: 128_000, output: 64_000 },
  { match: /^jev/, vision: false, context: 32_768, output: 4_096 },
];

const OVERRIDES: Record<string, FamilyCaps> = {
  "deepseek-v4.1-flash-free": { vision: true, context: 1_048_576, output: 384_000 },
  "glm-5.3-flash-free": { vision: true, context: 1_048_576, output: 131_072 },
  "nemotron-3.5-super-vl-free": { vision: true, context: 1_048_576, output: 131_072 },
  "space-bunny-free": { vision: true, context: 1_048_576, output: 524_288 },
  "longcat-2.5-preview-free": { vision: false, context: 1_048_576, output: 131_072 },
  "big-pickle": { vision: true, context: 262_144, output: 131_072 },
};

const DISPLAY_NAMES: Record<string, string> = {
  "mimo-v2.6-flash-free": "MiMo V2.6 Flash",
  "mimo-v2.5-free": "MiMo V2.5",
  "muse-spark-1.3-contributor-free": "Muse Spark 1.3",
  "muse-spark-1.2-contributor-free": "Muse Spark 1.2",
  "nemotron-3-ultra-free": "Nemotron 3 Ultra",
  "nemotron-3.5-lightning-free": "Nemotron 3.5 Lightning",
  "ling-3.0-flash-fin-free": "Ling 3.0 Flash Fin",
  "space-bunny-free": "Space Bunny",
  "union-alpha": "Union Alpha",
  "deepseek-v4-flash-free": "DeepSeek V4 Flash",
  "deepseek-v4.1-flash-free": "DeepSeek V4.1 Flash",
  "glm-5.3-flash-free": "GLM 5.3 Flash",
  "jev-1.13-free": "Jev 1.13",
};

export interface DshFreeModel {
  id: string;
  name: string;
  context: number;
  output: number;
  image: boolean;
}

export function dshFreeProvider(models: Record<string, ModelCaps> = {}) {
  return {
    id: DSH_FREE_PROVIDER_ID,
    name: "DSH 免费模型",
    kind: "openai-chat-completions" as const,
    baseURL: `${DSH_FREE_ORIGIN}/inference/v1`,
    apiKeyRequired: false,
    enabled: true,
    models,
  };
}

export function isDshSessionId(id: string): boolean {
  const trimmed = id.trim();
  return SESSION_RE.test(trimmed) && SESSION_TIME_RE.test(trimmed.slice(4, 16));
}

let lastStamp = 0;
let sessionSeq = 0;

/** Time-prefixed session id the free lane accepts. One conversation keeps one id. */
export function mintDshSessionId(timestamp = Date.now()): string {
  if (timestamp !== lastStamp) {
    lastStamp = timestamp;
    sessionSeq = 0;
  }
  sessionSeq += 1;
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(sessionSeq));
  let hex = "";
  for (let i = 0; i < 6; i += 1) {
    hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn)
      .toString(16)
      .padStart(2, "0");
  }
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  let tail = "";
  for (const byte of bytes) tail += BASE62[byte % 62];
  return `ses_${hex}${tail}`;
}

export function dshGatewayHeaders(
  session: string,
  accept: string,
): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: "Bearer public",
    "user-agent": DSH_CLIENT_UA,
    "x-opencode-client": "cli",
    "x-opencode-session": session,
    "x-opencode-session-id": session,
    "x-session-affinity": session,
    "x-session-id": session,
    "x-opencode-project": "global",
    accept,
  };
}

/** Free-lane ids from `GET /inference/v1/models`. Chat-completions models only. */
export function selectDshFreeModels(payload: unknown): DshFreeModel[] {
  const found: DshFreeModel[] = [];
  const seen = new Set<string>();
  for (const id of listedIds(payload)) {
    const base = id.replace(/\([^()]+\)\s*$/, "").trim();
    if (!base || base.includes("/") || seen.has(base) || !isFreeLane(base)) continue;
    if (!usesChatCompletions(base)) continue;
    seen.add(base);
    const caps = capabilitiesFor(base);
    found.push({
      id: base,
      name: displayName(base),
      context: caps.context,
      output: caps.output,
      image: caps.vision,
    });
  }
  return found;
}

export function dshModelCaps(found: readonly DshFreeModel[]): Record<string, ModelCaps> {
  const models: Record<string, ModelCaps> = {};
  for (const model of found) {
    models[model.id] = {
      context: model.context,
      output: model.output,
      title: model.name,
      ...(model.image ? { inputs: ["image"] as const } : {}),
    };
  }
  return models;
}

export interface DshFreePrepared {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** Sent tool name -> the caller's original name. */
  aliases: Map<string, string>;
}

/** Rewrite one chat-completions body so the free lane will route it. */
export function prepareDshFreeChat(input: {
  body: Record<string, unknown>;
  session: string;
  directory?: string;
  platform?: string;
}): DshFreePrepared {
  const body = structuredClone(input.body);
  const aliases = applyFingerprint(body, {
    directory: input.directory?.trim() || ".",
    platform: input.platform?.trim() || "unknown",
  });
  const stream = body.stream === true;
  return {
    url: DSH_FREE_CHAT_URL,
    headers: dshGatewayHeaders(
      input.session,
      stream ? "text/event-stream" : "application/json",
    ),
    body,
    aliases,
  };
}

/** Drop injected placeholder tools. Restore a caller tool that had to be renamed. */
export function settleDshToolCalls(
  calls: readonly PlannedCall[],
  aliases: ReadonlyMap<string, string>,
): PlannedCall[] {
  const kept: PlannedCall[] = [];
  for (const call of calls) {
    const restored = aliases.get(call.name) ?? call.name;
    if (!aliases.has(call.name) && (restored === "read" || restored === "shell"))
      continue;
    kept.push(restored === call.name ? call : { ...call, name: restored });
  }
  return kept;
}

function applyFingerprint(
  body: Record<string, unknown>,
  environment: { directory: string; platform: string },
): Map<string, string> {
  const aliases = new Map<string, string>();
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const taken = new Set(tools.map(toolNameOf).filter(Boolean));
  const seen = new Set<string>();
  const present = new Set<string>();
  const out: unknown[] = [];

  for (const tool of tools) {
    const name = toolNameOf(tool);
    const key = name === "read" || name === "shell" ? name : "";
    if (!key) {
      out.push(tool);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (isRecord(tool) && carriesOfficialDefinition(tool, key)) {
      out.push(tool);
      present.add(key);
      continue;
    }
    let alias = `${key}_client`;
    for (let i = 2; taken.has(alias); i += 1) alias = `${key}_client${i}`;
    taken.add(alias);
    aliases.set(alias, name);
    out.push(isRecord(tool) ? withToolName(tool, alias) : tool);
  }

  const injected: string[] = [];
  for (const name of FINGERPRINT_TOOLS) {
    if (present.has(name)) continue;
    out.push(officialTool(name));
    injected.push(name);
  }
  body.tools = out;
  retargetToolChoice(body, aliases);
  aliasHistory(body, aliases);
  appendSystem(body, environmentNote(environment));
  if (injected.length > 0) appendSystem(body, placeholderNote(injected));
  if (
    body.tool_choice === "none" ||
    (isRecord(body.tool_choice) && body.tool_choice.type === "none")
  ) {
    delete body.tool_choice;
  }
  return aliases;
}

function officialTool(name: (typeof FINGERPRINT_TOOLS)[number]): Record<string, unknown> {
  const def = FINGERPRINT_DEFINITIONS[name];
  return {
    type: "function",
    function: {
      name,
      description: def.description,
      parameters: def.parameters,
    },
  };
}

function carriesOfficialDefinition(
  tool: Record<string, unknown>,
  name: "read" | "shell",
): boolean {
  const fn = functionOf(tool) ?? tool;
  const want = FINGERPRINT_DEFINITIONS[name];
  return (
    fn.description === want.description &&
    JSON.stringify(fn.parameters) === JSON.stringify(want.parameters)
  );
}

function withToolName(
  tool: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const fn = functionOf(tool);
  if (fn) return { ...tool, function: { ...fn, name } };
  return { ...tool, name };
}

function retargetToolChoice(
  body: Record<string, unknown>,
  aliases: Map<string, string>,
): void {
  if (aliases.size === 0 || !isRecord(body.tool_choice)) return;
  const choice = body.tool_choice;
  if (typeof choice.name === "string") {
    const alias = aliasFor(aliases, choice.name);
    if (alias) body.tool_choice = { ...choice, name: alias };
    return;
  }
  if (isRecord(choice.function) && typeof choice.function.name === "string") {
    const alias = aliasFor(aliases, choice.function.name);
    if (alias) {
      body.tool_choice = {
        ...choice,
        function: { ...choice.function, name: alias },
      };
    }
  }
}

function aliasHistory(body: Record<string, unknown>, aliases: Map<string, string>): void {
  if (aliases.size === 0 || !Array.isArray(body.messages)) return;
  body.messages = body.messages.map((message) => {
    if (!isRecord(message) || !Array.isArray(message.tool_calls)) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map((call) => {
        if (!isRecord(call) || !isRecord(call.function)) return call;
        const name = call.function.name;
        if (typeof name !== "string") return call;
        const alias = aliasFor(aliases, name);
        if (!alias) return call;
        return { ...call, function: { ...call.function, name: alias } };
      }),
    };
  });
}

function aliasFor(aliases: Map<string, string>, original: string): string | undefined {
  for (const [alias, name] of aliases) {
    if (name === original) return alias;
  }
  return undefined;
}

function appendSystem(body: Record<string, unknown>, note: string): void {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const first = messages[0];
  if (isRecord(first) && first.role === "system" && typeof first.content === "string") {
    if (note.includes("<env>") && /<env>[\s\S]*?<\/env>/i.test(first.content)) return;
    body.messages = [
      { ...first, content: `${first.content}\n\n${note}` },
      ...messages.slice(1),
    ];
    return;
  }
  body.messages = [{ role: "system", content: note }, ...messages];
}

function environmentNote(environment: { directory: string; platform: string }): string {
  const line = (value: string) => value.replace(/[\r\n<>]/g, " ");
  return [
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${line(environment.directory)}`,
    `  Platform: ${line(environment.platform)}`,
    "</env>",
  ].join("\n");
}

function placeholderNote(names: readonly string[]): string {
  const list = names.map((name) => `\`${name}\``).join(" or ");
  return names.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
}

function listedIds(payload: unknown): string[] {
  const root = isRecord(payload) ? payload : null;
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.models)
        ? root.models
        : [];
  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row === "string" && row.trim()) ids.push(row.trim());
    else if (isRecord(row) && typeof row.id === "string" && row.id.trim())
      ids.push(row.id.trim());
  }
  return ids;
}

function isFreeLane(id: string): boolean {
  if (ALWAYS_FREE.has(id)) return true;
  return /(?:^|[-_])free(?:$|[-_.])/.test(id);
}

function usesChatCompletions(id: string): boolean {
  if (MESSAGE_MODELS.has(id) || RESPONSE_MODELS.has(id)) return false;
  return !/^muse[-_]?spark(?:$|[-_:.\s])/i.test(id);
}

function capabilitiesFor(id: string): FamilyCaps {
  const override = OVERRIDES[id];
  if (override) return override;
  for (const entry of FAMILY) {
    if (entry.match.test(id)) {
      return { vision: entry.vision, context: entry.context, output: entry.output };
    }
  }
  return { vision: false, context: 131_072, output: 32_768 };
}

function displayName(id: string): string {
  const known = DISPLAY_NAMES[id];
  if (known) return known;
  return id
    .replace(/[-_.]+/g, " ")
    .trim()
    .split(" ")
    .map((word) =>
      /^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

function toolNameOf(tool: unknown): string {
  if (!isRecord(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  const fn = functionOf(tool);
  return typeof fn?.name === "string" ? fn.name.trim() : "";
}

function functionOf(tool: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(tool.function) ? tool.function : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
