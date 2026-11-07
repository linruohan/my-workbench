import { useMemo, useState } from "react";
import {
  timedScheduleLabel,
  type AgentSkill,
  type AgentThread,
  type AgentWorkspace,
  type TimedSchedule,
  type TimedTask,
} from "@wb/domain";
import { VoiceField } from "../voice";
import { ScheduleAddMenu } from "./ScheduleAddMenu";
import { ScheduleRow } from "./ScheduleRow";

export type TimedDraft = {
  title: string;
  command: string;
  schedule: TimedSchedule | null;
  /** Bound Agent session; null means create on first run in the default workspace. */
  threadId: string | null;
  /** Skills to invoke when the schedule fires. */
  skillIds: string[];
  enabled: boolean;
};

type Props = {
  draft: TimedDraft;
  existing?: TimedTask | null;
  onChange: (patch: Partial<TimedDraft>) => void;
  onSubmit: () => void;
  onCancel: () => void;
  history?: TimedTask[];
  skills?: AgentSkill[];
  threads?: AgentThread[];
  workspaces?: AgentWorkspace[];
};

export function TimedTaskEditor({
  draft,
  existing,
  onChange,
  onSubmit,
  onCancel,
  history = [],
  skills = [],
  threads = [],
  workspaces = [],
}: Props) {
  const [tab, setTab] = useState<"settings" | "history">("settings");
  const [menuOpen, setMenuOpen] = useState(false);

  const hasPayload = draft.command.trim().length > 0 || draft.skillIds.length > 0;
  const canSubmit = draft.title.trim().length > 0 && draft.schedule != null && hasPayload;
  const enabledSkills = skills.filter((skill) => skill.enabled !== false);

  const workspaceTitle = useMemo(() => {
    const map = new Map(workspaces.map((item) => [item.id, item.title]));
    return (workspaceId: string) => map.get(workspaceId) ?? "工作区";
  }, [workspaces]);

  const groupedThreads = useMemo(() => {
    const groups = new Map<string, AgentThread[]>();
    for (const thread of threads) {
      const key = thread.workspaceId;
      const list = groups.get(key) ?? [];
      list.push(thread);
      groups.set(key, list);
    }
    return [...groups.entries()].map(([workspaceId, items]) => ({
      workspaceId,
      title: workspaceTitle(workspaceId),
      threads: items,
    }));
  }, [threads, workspaceTitle]);

  const toggleSkill = (id: string) => {
    const next = draft.skillIds.includes(id)
      ? draft.skillIds.filter((item) => item !== id)
      : [...draft.skillIds, id];
    onChange({ skillIds: next });
  };

  const ownHistory = existing
    ? history.filter((item) => item.id === existing.id && item.lastRunAt != null)
    : history.filter((item) => item.lastRunAt != null).slice(0, 12);

  return (
    <section className="timed panel">
      <header className="timed__header">
        <div>
          <h1>{existing ? "编辑定时任务" : "新建定时任务"}</h1>
          <p className="timed__lead">配置任务的执行时间、指令、技能与会话。</p>
        </div>
        <div className="timed__header-actions">
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canSubmit}
            onClick={onSubmit}
          >
            {existing ? "保存定时任务" : "创建定时任务"}
          </button>
        </div>
      </header>

      <div className="timed__tabs" role="tablist" aria-label="定时任务面板">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "settings"}
          className={tab === "settings" ? "timed__tab is-active" : "timed__tab"}
          onClick={() => setTab("settings")}
        >
          设置
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "history"}
          className={tab === "history" ? "timed__tab is-active" : "timed__tab"}
          onClick={() => setTab("history")}
        >
          历史
        </button>
      </div>

      {tab === "settings" ? (
        <div className="timed__form">
          <div className="field">
            <label className="field__label" htmlFor="timed-title">
              任务标题
            </label>
            <VoiceField value={draft.title} onChange={(title) => onChange({ title })}>
              <input
                id="timed-title"
                className="field__control"
                value={draft.title}
                placeholder="未命名定时任务"
                onChange={(e) => onChange({ title: e.target.value })}
              />
            </VoiceField>
          </div>

          <div className="field">
            <div className="field__label">调度</div>
            {draft.schedule ? (
              <ScheduleRow
                schedule={draft.schedule}
                onChange={(next) => onChange({ schedule: next })}
                onDelete={() => onChange({ schedule: null })}
              />
            ) : (
              <ScheduleAddMenu
                open={menuOpen}
                onOpenChange={setMenuOpen}
                onPick={(schedule) => onChange({ schedule })}
                addLabel="+ 添加计划"
                menuLabel="添加计划"
                emptyHint={
                  <p className="schedule-empty">还没有计划，请添加一个调度规则。</p>
                }
              />
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="timed-command">
              指令
            </label>
            <VoiceField
              value={draft.command}
              onChange={(command) => onChange({ command })}
            >
              <textarea
                id="timed-command"
                className="field__control field__control--area"
                rows={7}
                value={draft.command}
                placeholder="例如：Review 最近 24 小时的提交，总结可能引入的 bug 和修复建议。也可在指令中写 /技能名"
                onChange={(e) => onChange({ command: e.target.value })}
              />
            </VoiceField>
            {!hasPayload ? (
              <p className="timed__hint timed__hint--warn">
                请填写指令，或至少选择一个技能。
              </p>
            ) : null}
          </div>

          <div className="field">
            <div className="field__label" id="timed-skills-label">
              调用技能
            </div>
            {enabledSkills.length === 0 ? (
              <p className="timed__hint">还没有可用技能。可在设置 → 技能中添加。</p>
            ) : (
              <div
                className="timed-skill-picks"
                role="group"
                aria-labelledby="timed-skills-label"
              >
                {enabledSkills.map((skill) => {
                  const on = draft.skillIds.includes(skill.id);
                  return (
                    <button
                      key={skill.id}
                      type="button"
                      className={on ? "timed-skill-pick is-on" : "timed-skill-pick"}
                      aria-pressed={on}
                      title={skill.description || skill.name}
                      onClick={() => toggleSkill(skill.id)}
                    >
                      /{skill.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="timed-thread">
              绑定会话
            </label>
            <select
              id="timed-thread"
              className="field__control"
              value={draft.threadId ?? ""}
              onChange={(e) =>
                onChange({ threadId: e.target.value ? e.target.value : null })
              }
            >
              <option value="">首次执行时自动创建（默认工作区 · 会话名=任务标题）</option>
              {groupedThreads.map((group) => (
                <optgroup key={group.workspaceId} label={group.title}>
                  {group.threads.map((thread) => (
                    <option key={thread.id} value={thread.id}>
                      {thread.title || "未命名会话"}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <p className="timed__hint">
              未绑定会话时，首次执行会在默认工作区创建以任务标题命名的会话。
            </p>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="timed-enabled">
              状态
            </label>
            <label className="timed-enabled" htmlFor="timed-enabled">
              <input
                id="timed-enabled"
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => onChange({ enabled: e.target.checked })}
              />
              <span>
                {draft.enabled ? "已启用，到期自动执行" : "已暂停，不会自动执行"}
              </span>
            </label>
          </div>
        </div>
      ) : (
        <div className="timed__history">
          {ownHistory.length === 0 ? (
            <p className="empty">还没有运行历史。执行后会在此显示上次时间。</p>
          ) : (
            <ul className="list">
              {ownHistory.map((h) => (
                <li key={`${h.id}-${h.lastRunAt}`} className="list__row list__row--plain">
                  <div className="list__body">
                    <div className="list__title">{h.title}</div>
                    <div className="list__meta">
                      {timedScheduleLabel(h.schedule)}
                      {h.lastRunAt
                        ? ` · 上次 ${new Date(h.lastRunAt).toLocaleString("zh-CN")}`
                        : " · 尚未运行"}
                      {h.nextRunAt
                        ? ` · 下次 ${new Date(h.nextRunAt).toLocaleString("zh-CN")}`
                        : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
