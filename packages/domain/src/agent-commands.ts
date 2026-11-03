import { permissionModeLabel, type AgentPermissionMode } from "./agent.js";
import {
  expandCommandTemplate,
  type AgentCustomCommand,
} from "./agent-custom-commands.js";

export type SlashCommand = {
  name: string;
  aliases: string[];
  summary: string;
  usage: string;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", aliases: ["?"], summary: "列出可用命令", usage: "/help [命令]" },
  { name: "new", aliases: ["clear"], summary: "新开一个会话", usage: "/new" },
  {
    name: "mode",
    aliases: [],
    summary: "查看或切换写入权限",
    usage: "/mode [变更前确认|本会话自动|只读]",
  },
  {
    name: "model",
    aliases: [],
    summary: "打开模型菜单，或按引用切换",
    usage: "/model [provider/model]",
  },
  { name: "today", aliases: [], summary: "看看今天有什么", usage: "/today" },
  { name: "brief", aliases: ["晨报"], summary: "根据今天的安排写晨报", usage: "/brief" },
  {
    name: "compact",
    aliases: ["压缩"],
    summary: "压缩更早的对话，减轻模型上下文",
    usage: "/compact",
  },
  {
    name: "memory",
    aliases: ["记忆"],
    summary: "查看或记下一条本机记忆",
    usage: "/memory [内容]",
  },
  {
    name: "agent",
    aliases: ["子智能体"],
    summary: "列出子智能体，或让其中一个处理任务",
    usage: "/agent [名称] [任务]",
  },
];

export type SlashAction =
  | { type: "reply"; text: string }
  | { type: "new" }
  | { type: "mode"; mode: AgentPermissionMode }
  | { type: "model-menu" }
  | { type: "model"; modelRef: string }
  | { type: "prompt"; text: string }
  | { type: "compact" }
  | { type: "memory"; text: string }
  | { type: "agent"; name: string; task: string };

/** Command name being typed, before any argument. A space hides suggestions. */
export function slashQuery(draft: string): string | null {
  const text = draft.trimStart();
  if (!text.startsWith("/") || text.startsWith("//")) return null;
  if (/\s/.test(text)) return null;
  return text.slice(1);
}

export function slashSuggestions(
  draft: string,
  extras: readonly AgentCustomCommand[] = [],
): SlashCommand[] {
  const query = slashQuery(draft);
  if (query == null) return [];
  const folded = query.toLowerCase();
  const builtin = SLASH_COMMANDS.filter((command) =>
    commandMatches(command, folded, query),
  );
  const builtinNames = new Set(
    SLASH_COMMANDS.flatMap((command) => [
      command.name.toLowerCase(),
      ...command.aliases.map((alias) => alias.toLowerCase()),
    ]),
  );
  const custom = extras
    .filter((command) => !builtinNames.has(command.name.toLowerCase()))
    .filter((command) => command.name.toLowerCase().startsWith(folded))
    .map((command): SlashCommand => ({
      name: command.name,
      aliases: [],
      summary: command.summary,
      usage: `/${command.name}`,
    }));
  return [...builtin, ...custom].slice(0, 12);
}

export type SlashSkillHit = {
  name: string;
  summary: string;
};

/** Skills offered from the same `/` menu as commands. */
export function slashSkillSuggestions(
  draft: string,
  skills: readonly { name: string; description: string }[],
): SlashSkillHit[] {
  const query = slashQuery(draft);
  if (query == null) return [];
  const folded = query.toLowerCase();
  const matched = skills.filter((skill) => {
    if (!folded) return true;
    const name = skill.name.toLowerCase();
    if (name.includes(folded)) return true;
    return folded.length >= 2 && skill.description.toLowerCase().includes(folded);
  });
  return matched.slice(0, folded ? 12 : 8).map((skill) => ({
    name: skill.name,
    summary: skill.description,
  }));
}

/** Replace the `/…` token being typed with a finished token and a trailing space. */
export function applySlashToken(draft: string, token: string): string {
  if (/\/[^\s/]*$/.test(draft)) return draft.replace(/\/[^\s/]*$/, `${token} `);
  const gap = draft.length === 0 || /\s$/.test(draft) ? "" : " ";
  return `${draft}${gap}${token} `;
}

/** Local slash command. Ordinary chat returns null and still goes to the model. */
export function resolveSlash(
  text: string,
  mode: AgentPermissionMode,
  extras: readonly AgentCustomCommand[] = [],
): SlashAction | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  const body = trimmed.slice(1).trim();
  const splitAt = body.search(/\s/);
  const rawToken = splitAt === -1 ? body : body.slice(0, splitAt);
  const args = splitAt === -1 ? "" : body.slice(splitAt + 1).trim();
  if (!rawToken) return helpAction("", extras);
  const command = findCommand(rawToken);
  if (!command) {
    const custom = extras.find(
      (item) => item.name.toLowerCase() === rawToken.toLowerCase(),
    );
    if (custom) {
      return { type: "prompt", text: expandCommandTemplate(custom.body, args) };
    }
    return {
      type: "reply",
      text: `没有「/${rawToken || " "}」这个命令。输入 /help 查看可用命令。`,
    };
  }
  if (command.name === "help") return helpAction(args, extras);
  if (command.name === "new") return { type: "new" };
  if (command.name === "mode") return modeAction(args, mode);
  if (command.name === "model") return modelAction(args);
  if (command.name === "today") return { type: "prompt", text: "看看今天有什么" };
  if (command.name === "compact") return { type: "compact" };
  if (command.name === "memory") return { type: "memory", text: args };
  if (command.name === "agent") return agentAction(args);
  return { type: "prompt", text: "晨报" };
}

function helpAction(args: string, extras: readonly AgentCustomCommand[]): SlashAction {
  const token = args.replace(/^\//, "");
  const target = args ? findCommand(token) : null;
  if (args && !target) {
    const custom = extras.find((item) => item.name.toLowerCase() === token.toLowerCase());
    if (custom) {
      return { type: "reply", text: `/${custom.name}\n${custom.summary}` };
    }
    return { type: "reply", text: `没有「${args}」这个命令。` };
  }
  if (target) return { type: "reply", text: `${target.usage}\n${target.summary}` };
  const lines = [
    ...SLASH_COMMANDS.map((command) => `- \`${command.usage}\` ${command.summary}`),
    ...extras.map((command) => `- \`/${command.name}\` ${command.summary}`),
  ];
  return { type: "reply", text: lines.join("\n") };
}

function agentAction(args: string): SlashAction {
  const trimmed = args.trim();
  if (!trimmed) return { type: "agent", name: "", task: "" };
  const splitAt = trimmed.search(/\s/);
  if (splitAt === -1) return { type: "agent", name: trimmed, task: "" };
  return {
    type: "agent",
    name: trimmed.slice(0, splitAt),
    task: trimmed.slice(splitAt + 1).trim(),
  };
}

function commandMatches(command: SlashCommand, folded: string, query: string): boolean {
  if (command.name.startsWith(folded)) return true;
  return command.aliases.some(
    (alias) => alias.toLowerCase().startsWith(folded) || alias.startsWith(query),
  );
}

function modeAction(args: string, mode: AgentPermissionMode): SlashAction {
  if (!args) {
    return {
      type: "reply",
      text: `当前权限：${permissionModeLabel(mode)}。可改为变更前确认、本会话自动或只读。`,
    };
  }
  const next = parseMode(args);
  if (!next) return { type: "reply", text: "权限只能是：变更前确认、本会话自动、只读。" };
  if (next === mode) {
    return { type: "reply", text: `当前已经是${permissionModeLabel(mode)}。` };
  }
  return { type: "mode", mode: next };
}

function modelAction(args: string): SlashAction {
  if (!args) return { type: "model-menu" };
  if (!args.includes("/") || args.startsWith("/") || args.endsWith("/")) {
    return {
      type: "reply",
      text: "模型要写成 provider/model。留空 /model 会打开选择菜单。",
    };
  }
  return { type: "model", modelRef: args };
}

function findCommand(token: string): SlashCommand | null {
  const folded = token.toLowerCase();
  return (
    SLASH_COMMANDS.find(
      (command) =>
        command.name === folded ||
        command.aliases.some(
          (alias) => alias.toLowerCase() === folded || alias === token,
        ),
    ) ?? null
  );
}

function parseMode(args: string): AgentPermissionMode | null {
  const folded = args.trim().toLowerCase();
  if (
    folded === "confirm" ||
    args === "变更前确认" ||
    args === "需确认" ||
    args === "确认"
  ) {
    return "confirm";
  }
  if (
    folded === "session_auto" ||
    folded === "auto" ||
    args === "本会话自动" ||
    args === "自动"
  ) {
    return "session_auto";
  }
  if (folded === "readonly" || folded === "read" || args === "只读") return "readonly";
  return null;
}
