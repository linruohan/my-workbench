import type { ReactNode } from "react";
import { SLASH_COMMANDS } from "@wb/domain";
import type { AppPrefs } from "../lib/prefs";
import {
  IconCommand,
  IconHook,
  IconMcp,
  IconMemory,
  IconPlugins,
  IconSkill,
  IconSubagents,
  IconUser,
} from "../shell/icons";

export type AgentCapabilityId =
  | "personal"
  | "memory"
  | "subagents"
  | "plugins"
  | "mcp"
  | "skills"
  | "commands"
  | "hooks";

export const AGENT_CAPABILITY_NAV: Array<{
  id: AgentCapabilityId;
  label: string;
  icon: ReactNode;
}> = [
  { id: "personal", label: "个性化", icon: <IconUser size={15} /> },
  { id: "memory", label: "记忆", icon: <IconMemory size={15} /> },
  { id: "subagents", label: "子智能体", icon: <IconSubagents size={15} /> },
  { id: "plugins", label: "插件", icon: <IconPlugins size={15} /> },
  { id: "mcp", label: "MCP 服务器", icon: <IconMcp size={15} /> },
  { id: "skills", label: "技能", icon: <IconSkill size={15} /> },
  { id: "commands", label: "命令", icon: <IconCommand size={15} /> },
  { id: "hooks", label: "钩子", icon: <IconHook size={15} /> },
];

const CAPABILITY_IDS = new Set<string>(AGENT_CAPABILITY_NAV.map((item) => item.id));

export function isAgentCapability(id: string): id is AgentCapabilityId {
  return CAPABILITY_IDS.has(id);
}

const HOOK_EVENTS = [
  ["任务完成", "任务被标为完成时"],
  ["提醒触发", "计划或截止提醒到期时"],
  ["会话开始", "新开或继续一个 Agent 会话时"],
] as const;

type Props = {
  id: AgentCapabilityId;
  prefs: AppPrefs;
  onPatch: (partial: Partial<AppPrefs>) => void;
};

export function AgentCapabilityPane({ id, prefs, onPatch }: Props) {
  const label = AGENT_CAPABILITY_NAV.find((item) => item.id === id)?.label ?? "";
  return (
    <section className="settings__pane">
      <h1 className="settings__title">{label}</h1>
      {id === "personal" ? <PersonalPane prefs={prefs} onPatch={onPatch} /> : null}
      {id === "memory" ? <MemoryPane /> : null}
      {id === "subagents" ? <SubagentsPane /> : null}
      {id === "plugins" ? <PluginsPane /> : null}
      {id === "mcp" ? <McpPane /> : null}
      {id === "skills" ? <SkillsPane /> : null}
      {id === "commands" ? <CommandsPane /> : null}
      {id === "hooks" ? <HooksPane /> : null}
    </section>
  );
}

function PersonalPane({
  prefs,
  onPatch,
}: {
  prefs: AppPrefs;
  onPatch: (partial: Partial<AppPrefs>) => void;
}) {
  return (
    <>
      <p className="agent-cap__lead">
        写给 Agent 的长期偏好，例如称呼、回复长短、排期习惯。每次会话都会放进系统提示，只保存在本机。
      </p>
      <textarea
        className="agent-cap__rules"
        aria-label="用户规则"
        placeholder="例如：用简体中文，回复尽量短。创建任务时若没说提醒，就提前 15 分钟。"
        value={prefs.agentRules}
        onChange={(e) => onPatch({ agentRules: e.target.value })}
      />
    </>
  );
}

function MemoryPane() {
  return (
    <>
      <p className="agent-cap__lead">
        跨会话仍然有用的事实会列在这里，只存在本机，可以查看和删除。当前还不会自动写入。
      </p>
      <p className="agent-cap__empty">还没有记忆。</p>
    </>
  );
}

function SubagentsPane() {
  return (
    <>
      <p className="agent-cap__lead">
        子智能体带有独立说明和工具范围，由本地插件的 agents 目录注册。启用插件后出现在这里。
      </p>
      <p className="agent-cap__empty">还没有子智能体。</p>
    </>
  );
}

function PluginsPane() {
  return (
    <>
      <p className="agent-cap__lead">
        插件是本机目录里的能力包。启用后会注册其中的技能、命令、子智能体、钩子和 MCP；停用则全部卸下。
      </p>
      <p className="agent-cap__empty">还没有安装插件。从本地文件夹安装会在宿主接入后开放。</p>
    </>
  );
}

function McpPane() {
  return (
    <>
      <p className="agent-cap__lead">
        MCP 服务器提供外部工具，并进入同一套权限。调用默认需要确认，密钥不会放进插件目录。
      </p>
      <p className="agent-cap__empty">还没有 MCP 服务器。它们来自已启用插件里的 .mcp.json。</p>
    </>
  );
}

function SkillsPane() {
  return (
    <>
      <p className="agent-cap__lead">
        技能说明某类工作该怎么做。已启用技能的短描述会进入会话上下文。
      </p>
      <p className="agent-cap__empty">还没有技能。</p>
    </>
  );
}

function CommandsPane() {
  return (
    <>
      <p className="agent-cap__lead">
        在 Agent 输入框以 / 开头。内置命令始终可用；插件里的命令在启用后才会出现。
      </p>
      <div className="settings__card">
        {SLASH_COMMANDS.map((command) => (
          <div key={command.name} className="settings__row">
            <div>
              <div className="settings__row-title agent-cap__mono">{command.usage}</div>
              <div className="settings__row-desc">{command.summary}</div>
            </div>
            <span className="settings__pill">内置</span>
          </div>
        ))}
      </div>
    </>
  );
}

function HooksPane() {
  return (
    <>
      <p className="agent-cap__lead">
        钩子挂在这些事件上。第一版只允许调用只读工具，或投递一条通知。
      </p>
      <div className="settings__card">
        {HOOK_EVENTS.map(([title, desc]) => (
          <div key={title} className="settings__row">
            <div>
              <div className="settings__row-title">{title}</div>
              <div className="settings__row-desc">{desc}</div>
            </div>
            <span className="agent-cap__muted">还没有钩子</span>
          </div>
        ))}
      </div>
    </>
  );
}
