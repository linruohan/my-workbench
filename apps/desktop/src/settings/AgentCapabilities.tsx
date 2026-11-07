import { useEffect, useState, type ReactNode } from "react";
import {
  addAgentCommand,
  addAgentHook,
  addAgentMemory,
  addAgentSubagent,
  addMcpServer,
  addSkillSourceDir,
  HOOK_EVENT_LABEL,
  mcpEndpointLabel,
  removeAgentCommand,
  removeAgentMemory,
  removeAgentSubagent,
  removeMcpServer,
  removeSkillSourceDir,
  setAgentHookEnabled,
  setMcpServerEnabled,
  setSkillEnabled,
  setSkillSourceDirEnabled,
  SLASH_COMMANDS,
  type AgentHookEvent,
  type AgentSkill,
  type HostToolSnapshot,
  type SkillSourceDir,
} from "@wb/domain";
import type { AppPrefs } from "../lib/prefs";
import { loadAgentPlugins, pickPluginDirectory } from "../agent/plugins-loader";
import { loadAgentSkills, pickSkillDirectory } from "../agent/skills-loader";
import { useDialog } from "../shell/Dialogs";
import {
  IconCommand,
  IconHook,
  IconMcp,
  IconMemory,
  IconPlugins,
  IconSkill,
  IconSubagents,
  IconTool,
  IconTrash,
  IconUser,
} from "../shell/icons";
import { VoiceField } from "../voice";
import { HostToolsPane } from "./HostToolsPane";

export type AgentCapabilityId =
  | "personal"
  | "memory"
  | "subagents"
  | "plugins"
  | "mcp"
  | "skills"
  | "commands"
  | "hooks"
  | "tools";

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
  { id: "tools", label: "工具", icon: <IconTool size={15} /> },
];

const CAPABILITY_IDS = new Set<string>(AGENT_CAPABILITY_NAV.map((item) => item.id));

export function isAgentCapability(id: string): id is AgentCapabilityId {
  return CAPABILITY_IDS.has(id);
}

const HOOK_EVENTS = [
  ["任务完成", "任务被标为完成时", "task_completed"],
  ["提醒触发", "计划或截止提醒到期时", "reminder_due"],
  ["会话开始", "新开或继续一个 Agent 会话时", "session_start"],
] as const;

type Props = {
  id: AgentCapabilityId;
  prefs: AppPrefs;
  dataDir: string;
  onPatch: (partial: Partial<AppPrefs>) => void;
  onHostTools?: (tools: HostToolSnapshot[]) => void;
};

export function AgentCapabilityPane({ id, prefs, dataDir, onPatch, onHostTools }: Props) {
  const label = AGENT_CAPABILITY_NAV.find((item) => item.id === id)?.label ?? "";
  return (
    <section className="settings__pane">
      <h1 className="settings__title">{label}</h1>
      {id === "personal" ? <PersonalPane prefs={prefs} onPatch={onPatch} /> : null}
      {id === "memory" ? <MemoryPane prefs={prefs} onPatch={onPatch} /> : null}
      {id === "subagents" ? <SubagentsPane prefs={prefs} onPatch={onPatch} /> : null}
      {id === "plugins" ? <PluginsPane prefs={prefs} onPatch={onPatch} /> : null}
      {id === "mcp" ? <McpPane prefs={prefs} onPatch={onPatch} /> : null}
      {id === "skills" ? <SkillsPane prefs={prefs} onPatch={onPatch} /> : null}
      {id === "commands" ? <CommandsPane prefs={prefs} onPatch={onPatch} /> : null}
      {id === "hooks" ? <HooksPane prefs={prefs} onPatch={onPatch} /> : null}
      {id === "tools" ? (
        <HostToolsPane
          prefs={prefs}
          dataDir={dataDir}
          onPatch={onPatch}
          onDetected={onHostTools}
        />
      ) : null}
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
        写给 Agent
        的长期偏好，例如称呼、回复长短、排期习惯。每次会话都会放进系统提示，只保存在本机。
      </p>
      <VoiceField
        value={prefs.agentRules}
        onChange={(agentRules) => onPatch({ agentRules })}
      >
        <textarea
          className="agent-cap__rules"
          aria-label="用户规则"
          placeholder="例如：用简体中文，回复尽量短。创建任务时若没说提醒，就提前 15 分钟。"
          value={prefs.agentRules}
          onChange={(e) => onPatch({ agentRules: e.target.value })}
        />
      </VoiceField>
    </>
  );
}

function MemoryPane({
  prefs,
  onPatch,
}: {
  prefs: AppPrefs;
  onPatch: (partial: Partial<AppPrefs>) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const result = addAgentMemory(prefs.agentMemories, text);
    if (!result.added) {
      setError(result.reason ?? "无法添加");
      return;
    }
    setError(null);
    setText("");
    onPatch({ agentMemories: result.memories });
  };
  return (
    <>
      <p className="agent-cap__lead">
        跨会话仍然有用的事实存在本机。聊天里可以说「记住 …」，或在这里添加。模型通过
        memory_save / memory_forget 读写，删除需要确认。
      </p>
      <form
        className="agent-cap__form"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <VoiceField value={text} onChange={setText}>
          <input
            className="agent-cap__input"
            aria-label="新记忆"
            placeholder="例如：周五写周报，提前 15 分钟提醒"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </VoiceField>
        <button type="submit" className="settings__save">
          添加记忆
        </button>
      </form>
      {error ? <p className="agent-cap__error">{error}</p> : null}
      {prefs.agentMemories.length === 0 ? (
        <p className="agent-cap__empty">还没有记忆。</p>
      ) : (
        <div className="settings__card">
          {prefs.agentMemories.map((memory) => (
            <div key={memory.id} className="settings__row">
              <div className="settings__row-title">{memory.text}</div>
              <button
                type="button"
                className="settings__save"
                aria-label={`删除记忆 ${memory.text}`}
                onClick={() =>
                  onPatch({
                    agentMemories: removeAgentMemory(prefs.agentMemories, memory.id),
                  })
                }
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function SubagentsPane({
  prefs,
  onPatch,
}: {
  prefs: AppPrefs;
  onPatch: (partial: Partial<AppPrefs>) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [tools, setTools] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const result = addAgentSubagent(prefs.agentSubagents, {
      name,
      description,
      prompt,
      toolNames: tools.split(/[,，\s]+/),
    });
    if (!result.added) {
      setError(result.reason ?? "无法添加");
      return;
    }
    setError(null);
    setName("");
    setDescription("");
    setPrompt("");
    setTools("");
    onPatch({ agentSubagents: result.subagents });
  };
  return (
    <>
      <p className="agent-cap__lead">
        子智能体有自己的说明，可选一份工具名单。聊天里用 /agent 名称 任务。插件 agents
        目录里的定义会和这里的放在一起，同名时以这里为准。
      </p>
      <form
        className="agent-cap__stack"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          className="agent-cap__input"
          aria-label="子智能体名称"
          placeholder="名称，例如 researcher"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          className="agent-cap__input"
          aria-label="子智能体描述"
          placeholder="一句话描述"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <textarea
          className="agent-cap__rules"
          aria-label="子智能体说明"
          placeholder="给这个子智能体的说明"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <input
          className="agent-cap__input"
          aria-label="子智能体工具"
          placeholder="可选工具名，用逗号分隔。留空表示沿用当前会话的工具"
          value={tools}
          onChange={(event) => setTools(event.target.value)}
        />
        <button type="submit" className="settings__save">
          添加子智能体
        </button>
      </form>
      {error ? <p className="agent-cap__error">{error}</p> : null}
      {prefs.agentSubagents.length === 0 ? (
        <p className="agent-cap__empty">还没有子智能体。</p>
      ) : (
        <div className="settings__card">
          {prefs.agentSubagents.map((agent) => (
            <div key={agent.id} className="settings__row">
              <div>
                <div className="settings__row-title agent-cap__mono">{agent.name}</div>
                <div className="settings__row-desc">{agent.description}</div>
              </div>
              <button
                type="button"
                className="settings__save"
                aria-label={`删除子智能体 ${agent.name}`}
                onClick={() =>
                  onPatch({
                    agentSubagents: removeAgentSubagent(prefs.agentSubagents, agent.id),
                  })
                }
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function PluginsPane({
  prefs,
  onPatch,
}: {
  prefs: AppPrefs;
  onPatch: (partial: Partial<AppPrefs>) => void;
}) {
  const dialog = useDialog();
  const dirs = prefs.pluginDirs;
  const [plugins, setPlugins] = useState<Awaited<ReturnType<typeof loadAgentPlugins>>>(
    [],
  );
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setScanning(true);
    void loadAgentPlugins(dirs)
      .then((next) => {
        if (cancelled) return;
        setPlugins(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPlugins([]);
        setError(err instanceof Error ? err.message : "扫描插件失败");
      })
      .finally(() => {
        if (!cancelled) setScanning(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dirs]);

  const addDirectory = async () => {
    const picked = await pickPluginDirectory(dialog.prompt);
    if (!picked) return;
    const result = addSkillSourceDir(dirs, picked);
    if (!result.added) {
      setError(result.reason ?? "无法添加目录");
      return;
    }
    setError(null);
    onPatch({ pluginDirs: result.roots });
  };

  return (
    <>
      <p className="agent-cap__lead">
        插件是本机目录。启用后会登记其中的技能、命令、子智能体、钩子和 MCP。清单放在
        .workbench-plugin/plugin.json，也认
        .zcode-plugin/plugin.json。停用后这些组件不再进入会话。
      </p>
      <div className="agent-cap__toolbar">
        <button
          type="button"
          className="settings__save"
          onClick={() => void addDirectory()}
        >
          添加插件目录
        </button>
        <span className="agent-cap__muted">
          {scanning
            ? "正在扫描…"
            : dirs.length
              ? `${dirs.length} 个目录`
              : "尚未添加目录"}
        </span>
      </div>
      {error ? <p className="agent-cap__error">{error}</p> : null}
      {dirs.length === 0 ? (
        <p className="agent-cap__empty">还没有安装插件。选择包含清单的文件夹即可。</p>
      ) : (
        <div className="settings__card">
          {dirs.map((dir) => {
            const found = plugins.find((item) => item.id === dir.id);
            return (
              <SkillDirRow
                key={dir.id}
                dir={dir}
                icon={<IconPlugins size={15} />}
                skillCount={found?.skills.length ?? 0}
                detail={
                  found?.error
                    ? found.error
                    : found
                      ? `${found.name}${found.version ? ` ${found.version}` : ""}`
                      : dir.enabled
                        ? "启用中"
                        : "已停用"
                }
                onToggle={(enabled) =>
                  onPatch({
                    pluginDirs: setSkillSourceDirEnabled(dirs, dir.id, enabled),
                  })
                }
                onRemove={() =>
                  onPatch({ pluginDirs: removeSkillSourceDir(dirs, dir.id) })
                }
              />
            );
          })}
        </div>
      )}
    </>
  );
}

function McpPane({
  prefs,
  onPatch,
}: {
  prefs: AppPrefs;
  onPatch: (partial: Partial<AppPrefs>) => void;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const result = addMcpServer(prefs.mcpServers, { name, command, url });
    if (!result.added) {
      setError(result.reason ?? "无法添加");
      return;
    }
    setError(null);
    setName("");
    setCommand("");
    setUrl("");
    onPatch({ mcpServers: result.servers });
  };
  return (
    <>
      <p className="agent-cap__lead">
        在这里登记 MCP 服务器的命令或
        URL。当前版本只登记、不启动外部进程，也不能从会话里真正调用；列表里会标「尚未连接」。插件里的
        .mcp.json 启用后会出现在工具说明里。密钥不要写在这里。
      </p>
      <form
        className="agent-cap__stack"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          className="agent-cap__input"
          aria-label="MCP 名称"
          placeholder="名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          className="agent-cap__input"
          aria-label="MCP 命令"
          placeholder="命令，例如 npx some-server"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
        />
        <input
          className="agent-cap__input"
          aria-label="MCP URL"
          placeholder="或填写 URL"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button type="submit" className="settings__save">
          登记服务器
        </button>
      </form>
      {error ? <p className="agent-cap__error">{error}</p> : null}
      {prefs.mcpServers.length === 0 ? (
        <p className="agent-cap__empty">还没有 MCP 服务器。</p>
      ) : (
        <div className="settings__card">
          {prefs.mcpServers.map((server) => (
            <div key={server.id} className="settings__row settings__row--stack">
              <div className="settings__row-main">
                <div>
                  <div className="settings__row-title">
                    {server.name}
                    <span className="agent-cap__badge" title="本版不启动外部进程">
                      尚未连接
                    </span>
                    {!server.enabled ? (
                      <span className="agent-cap__badge is-muted">已停用</span>
                    ) : null}
                  </div>
                  <div className="settings__row-desc agent-cap__path">
                    {mcpEndpointLabel(server)}
                  </div>
                </div>
                <div className="agent-cap__row-actions">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={server.enabled}
                    aria-label={`启用 ${server.name}`}
                    className={server.enabled ? "toggle is-on" : "toggle"}
                    onClick={() =>
                      onPatch({
                        mcpServers: setMcpServerEnabled(
                          prefs.mcpServers,
                          server.id,
                          !server.enabled,
                        ),
                      })
                    }
                  >
                    <span className="toggle__thumb" />
                  </button>
                  <button
                    type="button"
                    className="settings__save"
                    onClick={() =>
                      onPatch({
                        mcpServers: removeMcpServer(prefs.mcpServers, server.id),
                      })
                    }
                  >
                    移除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function SkillsPane({
  prefs,
  onPatch,
}: {
  prefs: AppPrefs;
  onPatch: (partial: Partial<AppPrefs>) => void;
}) {
  const dialog = useDialog();
  const dirs = prefs.skillDirs;
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setScanning(true);
    void loadAgentSkills(dirs)
      .then((next) => {
        if (cancelled) return;
        setSkills(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSkills([]);
        setError(err instanceof Error ? err.message : "扫描技能失败");
      })
      .finally(() => {
        if (!cancelled) setScanning(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dirs]);

  const patchDirs = (next: SkillSourceDir[]) => {
    onPatch({ skillDirs: next });
  };

  const addDirectory = async () => {
    const picked = await pickSkillDirectory(dialog.prompt);
    if (!picked) return;
    const result = addSkillSourceDir(dirs, picked);
    if (!result.added) {
      setError(result.reason ?? "无法添加目录");
      return;
    }
    setError(null);
    patchDirs(result.roots);
  };

  const enabledCount = dirs.filter((item) => item.enabled).length;

  return (
    <>
      <p className="agent-cap__lead">
        添加本机技能目录。目录本身或子目录内含 SKILL.md
        时会被发现；已启用技能的短描述进入会话，完整说明由 Agent 调用 skill_load 读取。
      </p>
      <div className="agent-cap__toolbar">
        <button
          type="button"
          className="settings__save"
          onClick={() => void addDirectory()}
        >
          添加技能目录
        </button>
        <span className="agent-cap__muted">
          {scanning
            ? "正在扫描…"
            : dirs.length
              ? `${enabledCount} 个目录启用 · 发现 ${skills.length} 个技能`
              : "尚未添加目录"}
        </span>
      </div>
      {error ? <p className="agent-cap__error">{error}</p> : null}
      {dirs.length === 0 ? (
        <p className="agent-cap__empty">
          还没有技能目录。选择包含 SKILL.md 的文件夹即可。
        </p>
      ) : (
        <div className="settings__card">
          {dirs.map((dir) => (
            <SkillDirRow
              key={dir.id}
              dir={dir}
              skillCount={skills.filter((item) => item.sourceDirId === dir.id).length}
              onToggle={(enabled) =>
                patchDirs(setSkillSourceDirEnabled(dirs, dir.id, enabled))
              }
              onRemove={() => patchDirs(removeSkillSourceDir(dirs, dir.id))}
            />
          ))}
        </div>
      )}
      {skills.length > 0 ? (
        <>
          <h2 className="agent-cap__section-title">已发现技能</h2>
          <div className="settings__card">
            {skills.map((skill) => {
              const enabled = !prefs.disabledSkillIds.includes(skill.id);
              return (
                <div
                  key={skill.id}
                  className={enabled ? "skill-line" : "skill-line is-off"}
                  title={skill.dirPath}
                >
                  <span className="skill-line__mark">
                    <IconSkill size={15} />
                  </span>
                  <div className="skill-line__copy">
                    <div className="skill-line__name">{skill.name}</div>
                    <div className="skill-line__desc" title={skill.description}>
                      {skill.description}
                    </div>
                  </div>
                  <div className="skill-line__actions">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={`启用 ${skill.name}`}
                      className={enabled ? "toggle is-on" : "toggle"}
                      onClick={() =>
                        onPatch({
                          disabledSkillIds: setSkillEnabled(
                            prefs.disabledSkillIds,
                            skill.id,
                            !enabled,
                          ),
                        })
                      }
                    >
                      <span className="toggle__thumb" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </>
  );
}

function SkillDirRow({
  dir,
  skillCount,
  detail,
  icon,
  onToggle,
  onRemove,
}: {
  dir: SkillSourceDir;
  skillCount: number;
  detail?: string;
  icon?: ReactNode;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const summary =
    detail ??
    (dir.enabled
      ? skillCount
        ? `已发现 ${skillCount} 个技能`
        : "启用中，尚未发现 SKILL.md"
      : "已停用");
  const title = dir.path.split(/[\\/]/).filter(Boolean).pop() || dir.path;
  return (
    <div className="skill-line">
      <span className="skill-line__mark">{icon ?? <IconSkill size={15} />}</span>
      <div className="skill-line__copy">
        <div className="skill-line__name" title={dir.path}>
          {title}
        </div>
        <div className="skill-line__desc" title={`${summary} · ${dir.path}`}>
          {summary}
        </div>
      </div>
      <div className="skill-line__actions">
        <button
          type="button"
          role="switch"
          aria-checked={dir.enabled}
          aria-label={`启用 ${dir.path}`}
          className={dir.enabled ? "toggle is-on" : "toggle"}
          onClick={() => onToggle(!dir.enabled)}
        >
          <span className="toggle__thumb" />
        </button>
        <button
          type="button"
          className="skill-line__remove"
          aria-label={`移除 ${dir.path}`}
          onClick={onRemove}
        >
          <IconTrash size={15} />
        </button>
      </div>
    </div>
  );
}

function CommandsPane({
  prefs,
  onPatch,
}: {
  prefs: AppPrefs;
  onPatch: (partial: Partial<AppPrefs>) => void;
}) {
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const taken = SLASH_COMMANDS.flatMap((command) => [command.name, ...command.aliases]);
  const add = () => {
    const result = addAgentCommand(prefs.agentCommands, { name, summary, body }, taken);
    if (!result.added) {
      setError(result.reason ?? "无法添加");
      return;
    }
    setError(null);
    setName("");
    setSummary("");
    setBody("");
    onPatch({ agentCommands: result.commands });
  };
  return (
    <>
      <p className="agent-cap__lead">
        在 Agent 输入框以 / 开头。内置命令始终优先。自定义命令的正文是提示词，可以用
        $ARGUMENTS 带上后面的参数。插件 commands 目录里的 Markdown 会一并出现。
      </p>
      <form
        className="agent-cap__stack"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          className="agent-cap__input"
          aria-label="命令名"
          placeholder="命令名，例如 review"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          className="agent-cap__input"
          aria-label="命令说明"
          placeholder="一句话说明"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
        />
        <textarea
          className="agent-cap__rules"
          aria-label="命令正文"
          placeholder="提示词。$ARGUMENTS 会换成命令后面的文字。"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <button type="submit" className="settings__save">
          添加命令
        </button>
      </form>
      {error ? <p className="agent-cap__error">{error}</p> : null}
      {prefs.agentCommands.length > 0 ? (
        <div className="settings__card">
          {prefs.agentCommands.map((command) => (
            <div key={command.id} className="settings__row">
              <div>
                <div className="settings__row-title agent-cap__mono">/{command.name}</div>
                <div className="settings__row-desc">{command.summary}</div>
              </div>
              <button
                type="button"
                className="settings__save"
                aria-label={`删除命令 ${command.name}`}
                onClick={() =>
                  onPatch({
                    agentCommands: removeAgentCommand(prefs.agentCommands, command.id),
                  })
                }
              >
                删除
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <h2 className="agent-cap__section-title">内置</h2>
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

function HooksPane({
  prefs,
  onPatch,
}: {
  prefs: AppPrefs;
  onPatch: (partial: Partial<AppPrefs>) => void;
}) {
  const [event, setEvent] = useState<AgentHookEvent>("session_start");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const result = addAgentHook(prefs.agentHooks, { event, title, body });
    if (!result.added) {
      setError(result.reason ?? "无法添加");
      return;
    }
    setError(null);
    setTitle("");
    setBody("");
    onPatch({ agentHooks: result.hooks });
  };
  return (
    <>
      <p className="agent-cap__lead">
        钩子只投递一段文字，不运行命令。会话开始时写进对话，任务完成时附在工具结果上，提醒触发时出现在提醒卡片里。
      </p>
      <form
        className="agent-cap__stack"
        onSubmit={(eventForm) => {
          eventForm.preventDefault();
          add();
        }}
      >
        <label className="agent-cap__field">
          <span>事件</span>
          <select
            aria-label="钩子事件"
            value={event}
            onChange={(change) => setEvent(change.target.value as AgentHookEvent)}
          >
            {(Object.keys(HOOK_EVENT_LABEL) as AgentHookEvent[]).map((id) => (
              <option key={id} value={id}>
                {HOOK_EVENT_LABEL[id]}
              </option>
            ))}
          </select>
        </label>
        <input
          className="agent-cap__input"
          aria-label="钩子标题"
          placeholder="标题"
          value={title}
          onChange={(change) => setTitle(change.target.value)}
        />
        <textarea
          className="agent-cap__rules"
          aria-label="钩子文字"
          placeholder="要投递的文字"
          value={body}
          onChange={(change) => setBody(change.target.value)}
        />
        <button type="submit" className="settings__save">
          添加钩子
        </button>
      </form>
      {error ? <p className="agent-cap__error">{error}</p> : null}
      <div className="settings__card">
        {HOOK_EVENTS.map(([label, desc, id]) => {
          const hooks = prefs.agentHooks.filter((item) => item.event === id);
          return (
            <div key={id} className="settings__row settings__row--stack">
              <div className="settings__row-main">
                <div>
                  <div className="settings__row-title">{label}</div>
                  <div className="settings__row-desc">{desc}</div>
                  {hooks.map((hook) => (
                    <div key={hook.id} className="settings__row-desc">
                      {hook.title}：{hook.body}
                    </div>
                  ))}
                </div>
                {hooks.length === 0 ? (
                  <span className="agent-cap__muted">还没有钩子</span>
                ) : (
                  <button
                    type="button"
                    className="settings__save"
                    onClick={() =>
                      onPatch({
                        agentHooks: prefs.agentHooks.filter((item) => item.event !== id),
                      })
                    }
                  >
                    清空
                  </button>
                )}
              </div>
              {hooks.map((hook) => (
                <button
                  key={`${hook.id}-toggle`}
                  type="button"
                  role="switch"
                  aria-checked={hook.enabled}
                  aria-label={`${hook.enabled ? "停用" : "启用"} ${hook.title}`}
                  className={hook.enabled ? "toggle is-on" : "toggle"}
                  onClick={() =>
                    onPatch({
                      agentHooks: setAgentHookEnabled(
                        prefs.agentHooks,
                        hook.id,
                        !hook.enabled,
                      ),
                    })
                  }
                >
                  <span className="toggle__thumb" />
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}
