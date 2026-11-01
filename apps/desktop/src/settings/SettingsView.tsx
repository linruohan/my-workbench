import { useMemo, useState, type ReactNode } from "react";
import { useTheme } from "../theme/ThemeProvider";
import type { AppPrefs } from "../lib/prefs";
import {
  IconBack,
  IconBell,
  IconDatabase,
  IconInfo,
  IconLayout,
  IconSearch,
  IconSettings,
  IconSun,
} from "../shell/icons";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "notifications"
  | "data"
  | "about";

const SECTIONS: Array<{
  id: SettingsSectionId;
  label: string;
  icon: ReactNode;
}> = [
  { id: "general", label: "通用", icon: <IconSettings size={15} /> },
  { id: "appearance", label: "外观", icon: <IconSun size={15} /> },
  { id: "notifications", label: "通知", icon: <IconBell size={15} /> },
  { id: "data", label: "数据", icon: <IconDatabase size={15} /> },
  { id: "about", label: "关于", icon: <IconInfo size={15} /> },
];

type Props = {
  prefs: AppPrefs;
  onPrefsChange: (next: AppPrefs) => void;
  onBack: () => void;
  initialSection?: SettingsSectionId;
};

export function SettingsView({
  prefs,
  onPrefsChange,
  onBack,
  initialSection = "general",
}: Props) {
  const { mode, setMode, label } = useTheme();
  const [section, setSection] = useState<SettingsSectionId>(initialSection);
  const [query, setQuery] = useState("");

  const visibleSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.filter((s) => s.label.toLowerCase().includes(q));
  }, [query]);

  const patch = (partial: Partial<AppPrefs>) => {
    onPrefsChange({ ...prefs, ...partial });
  };

  return (
    <div className="settings">
      <aside className="settings__nav" aria-label="设置分类">
        <div className="settings__nav-top">
          <button type="button" className="settings__back" onClick={onBack}>
            <IconBack size={16} />
            <span>返回</span>
          </button>
          <label className="settings__search">
            <IconSearch size={14} />
            <input
              aria-label="搜索设置"
              placeholder="搜索设置"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        <nav className="settings__cats">
          {visibleSections.map((s) => (
            <button
              key={s.id}
              type="button"
              className={
                section === s.id ? "settings__cat is-active" : "settings__cat"
              }
              onClick={() => setSection(s.id)}
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="settings__main">
        {section === "general" ? (
          <GeneralPane prefs={prefs} onPatch={patch} />
        ) : null}
        {section === "appearance" ? (
          <AppearancePane modeLabel={label} mode={mode} setMode={setMode} />
        ) : null}
        {section === "notifications" ? (
          <NotificationsPane prefs={prefs} onPatch={patch} />
        ) : null}
        {section === "data" ? <DataPane /> : null}
        {section === "about" ? <AboutPane /> : null}
      </div>
    </div>
  );
}

function GeneralPane({
  prefs,
  onPatch,
}: {
  prefs: AppPrefs;
  onPatch: (p: Partial<AppPrefs>) => void;
}) {
  return (
    <section className="settings__pane">
      <h1 className="settings__title">通用</h1>
      <div className="settings__card">
        <div className="settings__row">
          <div>
            <div className="settings__row-title">本地账号</div>
            <div className="settings__row-desc">
              仅保存在本机的显示名称，无云端登录
            </div>
          </div>
          <input
            className="settings__input"
            aria-label="显示名称"
            value={prefs.displayName}
            onChange={(e) => onPatch({ displayName: e.target.value })}
          />
        </div>
      </div>

      <h2 className="settings__subtitle">启动</h2>
      <div className="settings__card">
        <ToggleRow
          title="显示提示"
          desc="在空列表时展示操作提示"
          checked={prefs.showTips}
          onChange={(showTips) => onPatch({ showTips })}
        />
      </div>
    </section>
  );
}

function AppearancePane({
  mode,
  modeLabel,
  setMode,
}: {
  mode: "system" | "light" | "dark";
  modeLabel: string;
  setMode: (m: "system" | "light" | "dark") => void;
}) {
  return (
    <section className="settings__pane">
      <h1 className="settings__title">外观</h1>
      <div className="settings__card">
        <div className="settings__row">
          <div>
            <div className="settings__row-title">主题</div>
            <div className="settings__row-desc">当前：{modeLabel}</div>
          </div>
          <div className="settings__segment" role="group" aria-label="主题">
            {(
              [
                ["system", "系统"],
                ["light", "浅色"],
                ["dark", "深色"],
              ] as const
            ).map(([value, text]) => (
              <button
                key={value}
                type="button"
                className={
                  mode === value
                    ? "settings__segment-btn is-active"
                    : "settings__segment-btn"
                }
                onClick={() => setMode(value)}
              >
                {text}
              </button>
            ))}
          </div>
        </div>
        <div className="settings__row">
          <div>
            <div className="settings__row-title">布局风格</div>
            <div className="settings__row-desc">无边框窗口，顶栏可拖拽移动</div>
          </div>
          <IconLayout size={18} />
        </div>
      </div>
    </section>
  );
}

function NotificationsPane({
  prefs,
  onPatch,
}: {
  prefs: AppPrefs;
  onPatch: (p: Partial<AppPrefs>) => void;
}) {
  return (
    <section className="settings__pane">
      <h1 className="settings__title">通知</h1>
      <div className="settings__card">
        <ToggleRow
          title="系统通知"
          desc="提醒到期时尝试使用系统通知（宿主就绪后生效）"
          checked={prefs.systemNotifications}
          onChange={(systemNotifications) => onPatch({ systemNotifications })}
        />
        <ToggleRow
          title="警告通知"
          desc="对重要截止与失败项显示警告样式"
          checked={prefs.warningNotifications}
          onChange={(warningNotifications) => onPatch({ warningNotifications })}
        />
        <ToggleRow
          title="完成提示音"
          desc="完成任务时播放提示音"
          checked={prefs.completionSound}
          onChange={(completionSound) => onPatch({ completionSound })}
        />
      </div>
    </section>
  );
}

function DataPane() {
  return (
    <section className="settings__pane">
      <h1 className="settings__title">数据</h1>
      <div className="settings__card">
        <div className="settings__row">
          <div>
            <div className="settings__row-title">本地存储</div>
            <div className="settings__row-desc">
              当前使用浏览器 localStorage 快照；Tauri 下将切换为 workbench.db
            </div>
          </div>
        </div>
        <div className="settings__row">
          <div>
            <div className="settings__row-title">导出</div>
            <div className="settings__row-desc">复制本机数据目录即可完整备份</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function AboutPane() {
  return (
    <section className="settings__pane">
      <h1 className="settings__title">关于</h1>
      <div className="settings__card">
        <div className="settings__row">
          <div>
            <div className="settings__row-title">个人工作台</div>
            <div className="settings__row-desc">版本 0.1.0 · 本地优先</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ToggleRow({
  title,
  desc,
  checked,
  onChange,
}: {
  title: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="settings__row">
      <div>
        <div className="settings__row-title">{title}</div>
        <div className="settings__row-desc">{desc}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        className={checked ? "toggle is-on" : "toggle"}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle__thumb" />
      </button>
    </div>
  );
}
