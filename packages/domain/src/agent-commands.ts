import { permissionModeLabel, type AgentPermissionMode } from "./agent.js";

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
];

export type SlashAction =
  | { type: "reply"; text: string }
  | { type: "new" }
  | { type: "mode"; mode: AgentPermissionMode }
  | { type: "model-menu" }
  | { type: "model"; modelRef: string }
  | { type: "prompt"; text: string };

/** Command name being typed, before any argument. A space hides suggestions. */
export function slashQuery(draft: string): string | null {
  const text = draft.trimStart();
  if (!text.startsWith("/") || text.startsWith("//")) return null;
  if (/\s/.test(text)) return null;
  return text.slice(1);
}

export function slashSuggestions(draft: string): SlashCommand[] {
  const query = slashQuery(draft);
  if (query == null) return [];
  const folded = query.toLowerCase();
  return SLASH_COMMANDS.filter((command) => {
    if (command.name.startsWith(folded)) return true;
    return command.aliases.some(
      (alias) => alias.toLowerCase().startsWith(folded) || alias.startsWith(query),
    );
  }).slice(0, 6);
}

/** Local slash command. Ordinary chat returns null and still goes to the model. */
export function resolveSlash(
  text: string,
  mode: AgentPermissionMode,
): SlashAction | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  const body = trimmed.slice(1).trim();
  const splitAt = body.search(/\s/);
  const rawToken = splitAt === -1 ? body : body.slice(0, splitAt);
  const args = splitAt === -1 ? "" : body.slice(splitAt + 1).trim();
  if (!rawToken) return helpAction("");
  const command = findCommand(rawToken);
  if (!command) {
    return {
      type: "reply",
      text: `没有「/${rawToken || " "}」这个命令。输入 /help 查看可用命令。`,
    };
  }
  if (command.name === "help") return helpAction(args);
  if (command.name === "new") return { type: "new" };
  if (command.name === "mode") return modeAction(args, mode);
  if (command.name === "model") return modelAction(args);
  if (command.name === "today") return { type: "prompt", text: "看看今天有什么" };
  return { type: "prompt", text: "晨报" };
}

function helpAction(args: string): SlashAction {
  const target = args ? findCommand(args.replace(/^\//, "")) : null;
  if (args && !target) {
    return { type: "reply", text: `没有「${args}」这个命令。` };
  }
  if (target) return { type: "reply", text: `${target.usage}\n${target.summary}` };
  const lines = SLASH_COMMANDS.map(
    (command) => `- \`${command.usage}\` ${command.summary}`,
  );
  return { type: "reply", text: lines.join("\n") };
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
