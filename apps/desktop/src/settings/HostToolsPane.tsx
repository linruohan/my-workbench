import { useEffect, useState } from "react";
import {
  HOST_TOOL_CATEGORY_LABEL,
  setHostToolEnabled,
  type HostToolCategory,
  type HostToolSnapshot,
} from "@wb/domain";
import { installHostTool, probeHostTools } from "../agent/host-tools";
import { errorMessage } from "../lib/errors";
import type { AppPrefs } from "../lib/prefs";

const CATEGORIES: HostToolCategory[] = ["cli", "diagram", "chart"];

type Props = {
  prefs: AppPrefs;
  dataDir: string;
  onPatch: (partial: Partial<AppPrefs>) => void;
  onDetected?: (tools: HostToolSnapshot[]) => void;
};

export function HostToolsPane({ prefs, dataDir, onPatch, onDetected }: Props) {
  const [tools, setTools] = useState<HostToolSnapshot[]>([]);
  const [scanning, setScanning] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toolsDir = `${dataDir.replace(/[\\/]+$/, "")}/tools`;

  const load = (disabled: readonly string[]) => {
    setScanning(true);
    return probeHostTools(disabled)
      .then((next) => {
        setTools(next);
        setError(null);
        onDetected?.(next);
      })
      .catch((err: unknown) => {
        setTools([]);
        setError(errorMessage(err, "检测本机工具失败"));
      })
      .finally(() => setScanning(false));
  };

  useEffect(() => {
    let cancelled = false;
    void probeHostTools(prefs.disabledHostTools)
      .then((next) => {
        if (cancelled) return;
        setTools(next);
        setError(null);
        onDetected?.(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTools([]);
        setError(errorMessage(err, "检测本机工具失败"));
      })
      .finally(() => {
        if (!cancelled) setScanning(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onDetected, prefs.disabledHostTools]);

  const install = (id: string) => {
    setInstalling(id);
    setError(null);
    void installHostTool(id, prefs.httpProxy)
      .then(() => load(prefs.disabledHostTools))
      .catch((err: unknown) => setError(errorMessage(err, "安装失败")))
      .finally(() => setInstalling(null));
  };

  const shown = tools.map((tool) => ({
    ...tool,
    enabled: !prefs.disabledHostTools.includes(tool.id),
  }));

  return (
    <>
      <p className="agent-cap__lead">
        打开设置时检测本机已有的命令和作图库，记下路径与调用方式，供 Agent 用
        host_tool_run 调用。没有的可以安装到下面的目录。确认模式下运行前会征求同意。
      </p>
      <div className="agent-cap__toolbar">
        <button
          type="button"
          className="settings__save"
          onClick={() => void load(prefs.disabledHostTools)}
          disabled={scanning || installing !== null}
        >
          重新检测
        </button>
        <code className="agent-cap__path" aria-label="工具目录">
          {toolsDir}
        </code>
        <span className="agent-cap__muted">
          {scanning ? "正在检测…" : readyCount(shown)}
        </span>
      </div>
      {error ? <p className="agent-cap__error">{error}</p> : null}
      {CATEGORIES.map((category) => {
        const rows = shown.filter((item) => item.category === category);
        if (rows.length === 0) return null;
        return (
          <section key={category}>
            <h2 className="agent-cap__section-title">
              {HOST_TOOL_CATEGORY_LABEL[category]}
            </h2>
            <div className="settings__card">
              {rows.map((tool) => (
                <ToolRow
                  key={tool.id}
                  tool={tool}
                  busy={installing === tool.id}
                  locked={installing !== null}
                  onToggle={(enabled) =>
                    onPatch({
                      disabledHostTools: setHostToolEnabled(
                        prefs.disabledHostTools,
                        tool.id,
                        enabled,
                      ),
                    })
                  }
                  onInstall={() => install(tool.id)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

function readyCount(tools: HostToolSnapshot[]): string {
  const ready = tools.filter((item) => item.status === "ready").length;
  return `${ready}/${tools.length} 可用`;
}

function statusText(tool: HostToolSnapshot): string {
  if (!tool.enabled) return "已停用";
  if (tool.status !== "ready") return "未安装";
  return tool.source === "managed" ? "已安装" : "环境中";
}

function ToolRow({
  tool,
  busy,
  locked,
  onToggle,
  onInstall,
}: {
  tool: HostToolSnapshot;
  busy: boolean;
  locked: boolean;
  onToggle: (enabled: boolean) => void;
  onInstall: () => void;
}) {
  const probe =
    tool.versionArgs.length > 0 ? tool.versionArgs.join(" ") : "import 后读取版本";
  return (
    <div className="settings__row settings__row--stack">
      <div className="settings__row-main">
        <div>
          <div className="settings__row-title">{tool.name}</div>
          <div className="settings__row-desc">{tool.summary}</div>
          {tool.status === "ready" ? (
            <>
              <div className="settings__row-desc agent-cap__path">{tool.path}</div>
              <div className="settings__row-desc">
                {tool.version ? `版本 ${tool.version} · ` : ""}探测参数 {probe}
              </div>
            </>
          ) : (
            <div className="settings__row-desc">调用参数：{tool.usage}</div>
          )}
          {tool.status === "ready" ? (
            <div className="settings__row-desc">调用参数：{tool.usage}</div>
          ) : null}
          {tool.install === "manual" && tool.status !== "ready" ? (
            <div className="settings__row-desc">此工具需要自行安装后重新检测。</div>
          ) : null}
        </div>
        <div className="agent-cap__row-actions">
          <span className="settings__pill">{busy ? "正在安装…" : statusText(tool)}</span>
          {tool.install === "auto" && tool.status !== "ready" ? (
            <button
              type="button"
              className="settings__save"
              onClick={onInstall}
              disabled={locked}
            >
              安装
            </button>
          ) : null}
          <button
            type="button"
            role="switch"
            aria-checked={tool.enabled}
            aria-label={`${tool.enabled ? "停用" : "启用"} ${tool.name}`}
            className={tool.enabled ? "toggle is-on" : "toggle"}
            onClick={() => onToggle(!tool.enabled)}
          >
            <span className="toggle__thumb" />
          </button>
        </div>
      </div>
    </div>
  );
}
