import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { HostToolSnapshot } from "@wb/domain";
import { useTheme } from "../theme/ThemeProvider";
import {
  buildFontOptions,
  fontFamilyLabel,
  listSystemFonts,
  resolveUiFontStack,
} from "../lib/fonts";
import {
  defaultRemindLabel,
  startupViewLabel,
  uiLanguageLabel,
  weekStartLabel,
  windowRestoreLabel,
  workModeLabel,
  type AppPrefs,
  type DefaultRemind,
  type StartupView,
  type UiLanguage,
  type WeekStart,
  type WindowRestore,
  type WorkMode,
} from "../lib/prefs";
import { ModelsPane } from "../agent/ModelsPane";
import {
  AGENT_CAPABILITY_NAV,
  AgentCapabilityPane,
  isAgentCapability,
  type AgentCapabilityId,
} from "./AgentCapabilities";
import {
  IconBack,
  IconBell,
  IconBot,
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
  | "models"
  | AgentCapabilityId
  | "data"
  | "about";

const SECTION_GROUPS: Array<{
  label: string;
  items: Array<{
    id: SettingsSectionId;
    label: string;
    icon: ReactNode;
  }>;
}> = [
  {
    label: "基础设置",
    items: [
      { id: "general", label: "常规", icon: <IconSettings size={15} /> },
      { id: "appearance", label: "外观", icon: <IconSun size={15} /> },
      { id: "notifications", label: "通知", icon: <IconBell size={15} /> },
    ],
  },
  {
    label: "Agent",
    items: [
      { id: "models", label: "模型", icon: <IconBot size={15} /> },
      ...AGENT_CAPABILITY_NAV,
    ],
  },
  {
    label: "数据与关于",
    items: [
      { id: "data", label: "数据", icon: <IconDatabase size={15} /> },
      { id: "about", label: "关于", icon: <IconInfo size={15} /> },
    ],
  },
];

type Props = {
  prefs: AppPrefs;
  dataDir: string;
  onPrefsChange: (next: AppPrefs) => void;
  onBack: () => void;
  initialSection?: SettingsSectionId;
  onHostTools?: (tools: HostToolSnapshot[]) => void;
};

export function SettingsView({
  prefs,
  dataDir,
  onPrefsChange,
  onBack,
  initialSection = "general",
  onHostTools,
}: Props) {
  const { mode, setMode, label } = useTheme();
  const [section, setSection] = useState<SettingsSectionId>(initialSection);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTION_GROUPS;
    return SECTION_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((s) => s.label.toLowerCase().includes(q)),
    })).filter((g) => g.items.length > 0);
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
            <span>返回工作区</span>
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
          {groups.map((group) => (
            <div key={group.label} className="settings__group">
              <div className="settings__group-label">{group.label}</div>
              {group.items.map((s) => (
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
            </div>
          ))}
        </nav>
      </aside>

      <div className="settings__main">
        {section === "general" ? <GeneralPane prefs={prefs} onPatch={patch} /> : null}
        {section === "appearance" ? (
          <AppearancePane
            modeLabel={label}
            mode={mode}
            setMode={setMode}
            prefs={prefs}
            onPatch={patch}
          />
        ) : null}
        {section === "notifications" ? (
          <NotificationsPane prefs={prefs} onPatch={patch} />
        ) : null}
        {section === "models" ? <ModelsPane /> : null}
        {isAgentCapability(section) ? (
          <AgentCapabilityPane
            id={section}
            prefs={prefs}
            dataDir={dataDir}
            onPatch={patch}
            onHostTools={onHostTools}
          />
        ) : null}
        {section === "data" ? (
          <DataPane prefs={prefs} dataDir={dataDir} onPatch={patch} />
        ) : null}
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
  const [proxyDraft, setProxyDraft] = useState(prefs.httpProxy);

  return (
    <section className="settings__pane">
      <header className="settings__pane-head">
        <h1 className="settings__title">常规</h1>
        <span className="settings__pill">{uiLanguageLabel(prefs.uiLanguage)}</span>
      </header>

      <div className="settings__card">
        <div className="settings__row">
          <div>
            <div className="settings__row-title">本地账号</div>
            <div className="settings__row-desc">仅保存在本机的显示名称，无云端登录</div>
          </div>
          <input
            className="settings__input"
            aria-label="显示名称"
            value={prefs.displayName}
            onChange={(e) => onPatch({ displayName: e.target.value })}
          />
        </div>
        <SelectRow
          title="界面语言"
          desc="选择应用界面的显示语言（文案国际化将逐步接入）"
          ariaLabel="界面语言"
          value={prefs.uiLanguage}
          options={[
            ["system", "系统默认"],
            ["zh-CN", "简体中文"],
            ["en", "English"],
          ]}
          onChange={(uiLanguage) => onPatch({ uiLanguage: uiLanguage as UiLanguage })}
        />
        <SelectRow
          title="界面模式"
          desc="办公模式侧重今日与结果；专注模式展示更多计划细节与元信息"
          ariaLabel="界面模式"
          value={prefs.workMode}
          options={[
            ["office", "办公模式"],
            ["focus", "专注模式"],
          ]}
          onChange={(workMode) => onPatch({ workMode: workMode as WorkMode })}
        />
        <ToggleRow
          title="主动任务推荐"
          desc="根据计划与未排期任务给出今日建议（仅办公模式）"
          checked={prefs.proactiveSuggest}
          disabled={prefs.workMode !== "office"}
          onChange={(proactiveSuggest) => onPatch({ proactiveSuggest })}
        />
      </div>

      <h2 className="settings__subtitle">启动与工作区</h2>
      <div className="settings__card">
        <SelectRow
          title="启动打开"
          desc="启动应用后默认进入的视图"
          ariaLabel="启动打开"
          value={prefs.startupView}
          options={[
            ["today", "今日"],
            ["planner", "计划"],
            ["projects", "项目"],
            ["knowledge", "知识库"],
          ]}
          onChange={(startupView) => onPatch({ startupView: startupView as StartupView })}
        />
        <SelectRow
          title="窗口恢复"
          desc="下次启动时的窗口状态（宿主接线后生效）"
          ariaLabel="窗口恢复"
          value={prefs.windowRestore}
          options={[
            ["default", "默认"],
            ["maximized", "最大化"],
            ["remember", "记住上次"],
          ]}
          onChange={(windowRestore) =>
            onPatch({ windowRestore: windowRestore as WindowRestore })
          }
        />
        <ToggleRow
          title="显示操作提示"
          desc="在空列表时展示操作提示文案"
          checked={prefs.showTips}
          onChange={(showTips) => onPatch({ showTips })}
        />
        <ToggleRow
          title="删除前确认"
          desc="删除笔记等操作前弹出确认"
          checked={prefs.confirmBeforeDelete}
          onChange={(confirmBeforeDelete) => onPatch({ confirmBeforeDelete })}
        />
      </div>

      <h2 className="settings__subtitle">日程与提醒</h2>
      <div className="settings__card">
        <SelectRow
          title="一周起始日"
          desc="计划与日历视图的周起始"
          ariaLabel="一周起始日"
          value={prefs.weekStartsOn}
          options={[
            ["monday", "周一"],
            ["sunday", "周日"],
          ]}
          onChange={(weekStartsOn) =>
            onPatch({ weekStartsOn: weekStartsOn as WeekStart })
          }
        />
        <SelectRow
          title="默认提醒偏移"
          desc="为带时刻的任务设置计划时的默认提前提醒"
          ariaLabel="默认提醒偏移"
          value={prefs.defaultRemind}
          options={[
            ["none", "不提醒"],
            ["m5", "提前 5 分钟"],
            ["m15", "提前 15 分钟"],
            ["m30", "提前 30 分钟"],
            ["h1", "提前 1 小时"],
          ]}
          onChange={(defaultRemind) =>
            onPatch({ defaultRemind: defaultRemind as DefaultRemind })
          }
        />
      </div>

      <h2 className="settings__subtitle">知识库</h2>
      <div className="settings__card">
        <ToggleRow
          title="记住上次笔记"
          desc="进入知识库时优先打开最近编辑的笔记"
          checked={prefs.openLastNote}
          onChange={(openLastNote) => onPatch({ openLastNote })}
        />
        <ToggleRow
          title="增强搜索"
          desc="标题与正文的增强检索（FTS 接入后生效）"
          checked={prefs.enhancedSearch}
          onChange={(enhancedSearch) => onPatch({ enhancedSearch })}
        />
      </div>

      <h2 className="settings__subtitle">网络</h2>
      <div className="settings__card">
        <div className="settings__row settings__row--stack">
          <div className="settings__row-main">
            <div>
              <div className="settings__row-title">HTTP 代理</div>
              <div className="settings__row-desc">
                外部模型请求将使用此代理；不读取系统环境变量。留空为直连，修改后需重启生效。
              </div>
            </div>
          </div>
          <div className="settings__inline">
            <input
              className="settings__input settings__input--grow"
              aria-label="HTTP 代理"
              placeholder="例如 http://127.0.0.1:7890"
              value={proxyDraft}
              onChange={(e) => setProxyDraft(e.target.value)}
            />
            <button
              type="button"
              className="settings__save"
              onClick={() => onPatch({ httpProxy: proxyDraft.trim() })}
            >
              保存
            </button>
          </div>
        </div>
      </div>

      <p className="settings__footnote">
        当前模式：{workModeLabel(prefs.workMode)} · 启动：
        {startupViewLabel(prefs.startupView)} · 提醒：
        {defaultRemindLabel(prefs.defaultRemind)} · 周起始：
        {weekStartLabel(prefs.weekStartsOn)} · 知识库：Typora 实时预览
      </p>
    </section>
  );
}

function AppearancePane({
  mode,
  modeLabel,
  setMode,
  prefs,
  onPatch,
}: {
  mode: "system" | "light" | "dark";
  modeLabel: string;
  setMode: (m: "system" | "light" | "dark") => void;
  prefs: AppPrefs;
  onPatch: (p: Partial<AppPrefs>) => void;
}) {
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [fontQuery, setFontQuery] = useState("");
  const [fontsLoading, setFontsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setFontsLoading(true);
    void listSystemFonts().then((fonts) => {
      if (cancelled) return;
      setSystemFonts(fonts);
      setFontsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const fontOptions = useMemo(() => {
    const q = fontQuery.trim().toLowerCase();
    const filtered = q
      ? systemFonts.filter((name) => name.toLowerCase().includes(q))
      : systemFonts;
    const options = buildFontOptions(filtered);
    // Keep the current selection visible even when the filter hides it.
    for (const current of [prefs.uiFont, prefs.webFont]) {
      if (!current) continue;
      if (options.some(([value]) => value === current)) continue;
      options.push([current, current]);
    }
    return options;
  }, [fontQuery, prefs.uiFont, prefs.webFont, systemFonts]);

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
        <SelectRow
          title="窗口恢复"
          desc={`当前：${windowRestoreLabel(prefs.windowRestore)}`}
          ariaLabel="外观窗口恢复"
          value={prefs.windowRestore}
          options={[
            ["default", "默认"],
            ["maximized", "最大化"],
            ["remember", "记住上次"],
          ]}
          onChange={(windowRestore) =>
            onPatch({ windowRestore: windowRestore as WindowRestore })
          }
        />
        <div className="settings__row">
          <div>
            <div className="settings__row-title">布局风格</div>
            <div className="settings__row-desc">无边框窗口，顶栏可拖拽移动</div>
          </div>
          <IconLayout size={18} />
        </div>
      </div>

      <h2 className="settings__subtitle">字体</h2>
      <div className="settings__card">
        <div className="settings__row">
          <div>
            <div className="settings__row-title">搜索字体</div>
            <div className="settings__row-desc">
              {fontsLoading
                ? "正在读取本机已安装字体…"
                : `共 ${systemFonts.length} 个已安装字体`}
            </div>
          </div>
          <input
            className="settings__input"
            aria-label="搜索字体"
            placeholder="筛选字体名称"
            value={fontQuery}
            onChange={(e) => setFontQuery(e.target.value)}
          />
        </div>
        <FontSelectRow
          title="应用字体"
          desc={`界面全部文本。当前：${fontFamilyLabel(prefs.uiFont)}`}
          ariaLabel="应用字体"
          value={prefs.uiFont}
          options={fontOptions}
          onChange={(uiFont) => onPatch({ uiFont })}
        />
        <FontSelectRow
          title="网页默认字体"
          desc={`嵌入网页未指定字体时使用。当前：${fontFamilyLabel(prefs.webFont)}`}
          ariaLabel="网页默认字体"
          value={prefs.webFont}
          options={fontOptions}
          onChange={(webFont) => onPatch({ webFont })}
        />
        <div className="settings__row settings__row--stack">
          <div>
            <div className="settings__row-title">预览</div>
            <div className="settings__row-desc">应用字体即时预览</div>
          </div>
          <p
            className="settings__font-preview"
            style={{ fontFamily: resolveUiFontStack(prefs.uiFont) }}
          >
            个人工作台 My Workbench 123
          </p>
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

function DataPane({
  prefs,
  dataDir,
  onPatch,
}: {
  prefs: AppPrefs;
  dataDir: string;
  onPatch: (p: Partial<AppPrefs>) => void;
}) {
  return (
    <section className="settings__pane">
      <h1 className="settings__title">数据</h1>
      <div className="settings__card">
        <div className="settings__row settings__row--stack">
          <div>
            <div className="settings__row-title">默认保存路径</div>
            <div className="settings__row-desc">
              数据与设置默认保存在本机 AppData；桌面壳写入该目录下的 workbench.json /
              prefs.json / theme.json
            </div>
          </div>
          <code className="settings__path" aria-label="数据目录">
            {dataDir}
          </code>
        </div>
        <div className="settings__row">
          <div>
            <div className="settings__row-title">文件说明</div>
            <div className="settings__row-desc">
              workbench.json（任务/笔记快照）· prefs.json（设置）· theme.json（主题）·
              models/paddleocr（本地识图模型）
            </div>
          </div>
        </div>
        <ToggleRow
          title="删除前确认"
          desc="删除笔记等破坏性操作前要求确认"
          checked={prefs.confirmBeforeDelete}
          onChange={(confirmBeforeDelete) => onPatch({ confirmBeforeDelete })}
        />
        <div className="settings__row">
          <div>
            <div className="settings__row-title">导出与备份</div>
            <div className="settings__row-desc">
              复制上述目录即可完整备份；浏览器预览态仍会同步一份 localStorage
            </div>
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

function SelectRow({
  title,
  desc,
  ariaLabel,
  value,
  options,
  onChange,
}: {
  title: string;
  desc: string;
  ariaLabel: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="settings__row">
      <div>
        <div className="settings__row-title">{title}</div>
        <div className="settings__row-desc">{desc}</div>
      </div>
      <select
        className="settings__select"
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map(([v, text]) => (
          <option key={v || "__system__"} value={v}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

function FontSelectRow({
  title,
  desc,
  ariaLabel,
  value,
  options,
  onChange,
}: {
  title: string;
  desc: string;
  ariaLabel: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="settings__row">
      <div>
        <div className="settings__row-title">{title}</div>
        <div className="settings__row-desc">{desc}</div>
      </div>
      <select
        className="settings__select settings__select--font"
        aria-label={ariaLabel}
        value={value}
        style={value ? { fontFamily: `"${value}"` } : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map(([v, text]) => (
          <option
            key={v || "__system__"}
            value={v}
            style={v ? { fontFamily: `"${v}"` } : undefined}
          >
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

function ToggleRow({
  title,
  desc,
  checked,
  onChange,
  disabled = false,
}: {
  title: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={disabled ? "settings__row is-disabled" : "settings__row"}>
      <div>
        <div className="settings__row-title">{title}</div>
        <div className="settings__row-desc">{desc}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        disabled={disabled}
        className={checked ? "toggle is-on" : "toggle"}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle__thumb" />
      </button>
    </div>
  );
}
