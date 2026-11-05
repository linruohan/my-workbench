import { useState } from "react";
import { timedScheduleLabel, type TimedSchedule, type TimedTask } from "@wb/domain";
import { ScheduleAddMenu } from "./ScheduleAddMenu";
import { ScheduleRow } from "./ScheduleRow";

export type TimedDraft = {
  title: string;
  command: string;
  schedule: TimedSchedule | null;
};

type Props = {
  draft: TimedDraft;
  existing?: TimedTask | null;
  onChange: (patch: Partial<TimedDraft>) => void;
  onSubmit: () => void;
  onCancel: () => void;
  history?: TimedTask[];
};

export function TimedTaskEditor({
  draft,
  existing,
  onChange,
  onSubmit,
  onCancel,
  history = [],
}: Props) {
  const [tab, setTab] = useState<"settings" | "history">("settings");
  const [menuOpen, setMenuOpen] = useState(false);

  const canSubmit = draft.title.trim().length > 0 && draft.schedule != null;

  return (
    <section className="timed panel">
      <header className="timed__header">
        <div>
          <h1>{existing ? "编辑定时任务" : "新建定时任务"}</h1>
          <p className="timed__lead">配置任务的执行时间、指令和运行方式。</p>
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
            <input
              id="timed-title"
              className="field__control"
              value={draft.title}
              placeholder="未命名定时任务"
              onChange={(e) => onChange({ title: e.target.value })}
            />
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
            <textarea
              id="timed-command"
              className="field__control field__control--area"
              rows={7}
              value={draft.command}
              placeholder="例如：Review 最近 24 小时的提交，总结可能引入的 bug 和修复建议"
              onChange={(e) => onChange({ command: e.target.value })}
            />
          </div>
        </div>
      ) : (
        <div className="timed__history">
          {history.length === 0 ? (
            <p className="empty">还没有运行历史。创建后会在此显示。</p>
          ) : (
            <ul className="list">
              {history.map((h) => (
                <li key={h.id} className="list__row list__row--plain">
                  <div className="list__body">
                    <div className="list__title">{h.title}</div>
                    <div className="list__meta">
                      {timedScheduleLabel(h.schedule)}
                      {h.lastRunAt
                        ? ` · 上次 ${new Date(h.lastRunAt).toLocaleString("zh-CN")}`
                        : " · 尚未运行"}
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
