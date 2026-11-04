import { useEffect, useId, useRef, useState } from "react";
import {
  HOST_TOOL_CATEGORY_LABEL,
  assembleHostTools,
  setHostToolEnabled,
  type HostToolCategory,
  type HostToolLane,
  type HostToolProbe,
  type HostToolSnapshot,
} from "@wb/domain";
import {
  canStartHostToolInstall,
  checkHostTool,
  installHostTool,
  pickHostToolPath,
  probeHostTools,
} from "../agent/host-tools";
import { errorMessage } from "../lib/errors";
import type { AppPrefs } from "../lib/prefs";
import { useDialog } from "../shell/Dialogs";
import { IconClose } from "../shell/icons";

const CATEGORIES: HostToolCategory[] = [
  "runtime",
  "browser",
  "document",
  "remote",
  "language",
  "package",
  "chart",
];

type Props = {
  prefs: AppPrefs;
  dataDir: string;
  onPatch: (partial: Partial<AppPrefs>) => void;
  onDetected?: (tools: HostToolSnapshot[]) => void;
};

type InstallJob = { id: string; lane: HostToolLane };
type Phase = "idle" | "scan" | "fetch";
type ToolView = "all" | "ready" | "missing";

const VIEWS: { id: ToolView; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "ready", label: "可用" },
  { id: "missing", label: "缺失" },
];

function savedTools(prefs: AppPrefs): HostToolSnapshot[] {
  return assembleHostTools(
    prefs.hostToolsFetched ? prefs.hostToolRecords : [],
    prefs.disabledHostTools,
  );
}

function toRecords(tools: readonly HostToolSnapshot[]): HostToolProbe[] {
  return tools
    .filter((tool) => tool.status === "ready" && tool.path.trim())
    .map((tool) => ({
      id: tool.id,
      status: "ready" as const,
      source: tool.source === "managed" || tool.source === "manual" ? tool.source : "env",
      path: tool.path,
      version: tool.version,
      invoke: tool.invoke.length > 0 ? tool.invoke : [tool.path],
    }));
}

export function HostToolsPane({ prefs, dataDir, onPatch, onDetected }: Props) {
  const [tools, setTools] = useState<HostToolSnapshot[]>(() => savedTools(prefs));
  const [seen, setSeen] = useState(prefs.hostToolsFetched);
  const [phase, setPhase] = useState<Phase>("idle");
  const [installing, setInstalling] = useState<InstallJob[]>([]);
  const [waiting, setWaiting] = useState<InstallJob[]>([]);
  const [view, setView] = useState<ToolView>("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [failures, setFailures] = useState<{ id: string; message: string }[]>([]);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const dialog = useDialog();
  const installingRef = useRef(installing);
  const queueRef = useRef<InstallJob[]>([]);
  const probeSeq = useRef(0);
  const snapshotRef = useRef<HostToolSnapshot[]>(savedTools(prefs));
  const prefsRef = useRef(prefs);
  const onPatchRef = useRef(onPatch);
  const onDetectedRef = useRef(onDetected);
  const scanRef = useRef<() => void>(() => undefined);
  prefsRef.current = prefs;
  onPatchRef.current = onPatch;
  onDetectedRef.current = onDetected;
  const toolsDir = `${dataDir.replace(/[\\/]+$/, "")}/tools`;

  const commit = () => {
    onPatchRef.current({
      hostToolRecords: toRecords(snapshotRef.current),
      hostToolsFetched: true,
    });
  };

  const publish = (next: HostToolSnapshot[]) => {
    snapshotRef.current = next;
    setTools(next);
    setSeen(true);
    onDetectedRef.current?.(next);
    if (prefsRef.current.hostToolsFetched) commit();
  };

  const refresh = (
    disabled: readonly string[],
    paths = prefsRef.current.hostToolPaths,
  ) => {
    const seq = ++probeSeq.current;
    return probeHostTools(disabled, paths)
      .then((next) => {
        if (seq !== probeSeq.current) return;
        publish(next);
      })
      .catch((err: unknown) => {
        if (seq !== probeSeq.current) return;
        setFailures((current) => [
          ...current.filter((item) => item.id !== "probe"),
          { id: "probe", message: errorMessage(err, "检测本机工具失败") },
        ]);
      });
  };

  const settle = (id: string) => {
    installingRef.current = installingRef.current.filter((item) => item.id !== id);
    setInstalling(installingRef.current);
    pump();
    if (installingRef.current.length === 0 && queueRef.current.length === 0) {
      setPhase("idle");
      commit();
    }
  };

  const appendLog = (id: string, text: string) => {
    setLogs((current) => {
      const next = `${current[id] ?? ""}${text}`;
      const capped = next.length > 64_000 ? next.slice(next.length - 64_000) : next;
      return { ...current, [id]: capped };
    });
  };

  const begin = (job: InstallJob, confirmName?: string) => {
    if (!canStartHostToolInstall(installingRef.current, job)) return;
    installingRef.current = [...installingRef.current, job];
    setInstalling(installingRef.current);
    setFailures((current) => current.filter((item) => item.id !== job.id));
    const proxy = prefsRef.current.httpProxy;
    const disabled = prefsRef.current.disabledHostTools;
    void installHostTool(job.id, proxy, (text) => appendLog(job.id, text))
      .then(() => refresh(disabled))
      .then(() => {
        if (!confirmName) return;
        void dialog.alert({
          title: "安装已完成",
          message: `${confirmName} 已安装。`,
          confirmLabel: "确定",
        });
      })
      .catch((err: unknown) => {
        const message = errorMessage(err, "安装失败");
        appendLog(job.id, `\n${message}\n`);
        setFailures((current) => [
          ...current.filter((item) => item.id !== job.id),
          { id: job.id, message },
        ]);
      })
      .finally(() => settle(job.id));
  };

  const pump = () => {
    const disabled = new Set(prefsRef.current.disabledHostTools);
    const stay: InstallJob[] = [];
    for (const job of queueRef.current) {
      if (disabled.has(job.id)) continue;
      if (installingRef.current.some((item) => item.id === job.id)) continue;
      if (canStartHostToolInstall(installingRef.current, job)) begin(job);
      else stay.push(job);
    }
    queueRef.current = stay;
    setWaiting(stay);
  };

  const scan = () => {
    if (phase !== "idle" || installingRef.current.length > 0) return;
    setFailures((current) => current.filter((item) => item.id !== "probe"));
    setPhase("scan");
    const seq = ++probeSeq.current;
    const disabled = prefsRef.current.disabledHostTools;
    void probeHostTools(disabled, prefsRef.current.hostToolPaths)
      .then((next) => {
        if (seq !== probeSeq.current) return;
        publish(next);
        queueRef.current = next
          .filter(
            (tool) => tool.enabled && tool.install === "auto" && tool.status !== "ready",
          )
          .map((tool) => ({ id: tool.id, lane: tool.lane }));
        if (queueRef.current.length === 0) {
          setWaiting([]);
          setPhase("idle");
          commit();
          return;
        }
        setPhase("fetch");
        pump();
        if (installingRef.current.length === 0 && queueRef.current.length === 0) {
          setPhase("idle");
          commit();
        }
      })
      .catch((err: unknown) => {
        if (seq !== probeSeq.current) return;
        setFailures((current) => [
          ...current.filter((item) => item.id !== "probe"),
          { id: "probe", message: errorMessage(err, "检测本机工具失败") },
        ]);
        setPhase("idle");
      });
  };
  scanRef.current = scan;

  useEffect(() => {
    if (prefsRef.current.hostToolsFetched) return;
    scanRef.current();
    return () => {
      probeSeq.current += 1;
    };
  }, []);

  const install = (id: string, lane: HostToolLane, name: string) => {
    begin({ id, lane }, name);
  };

  const savePath = (id: string, path: string) => {
    const next = { ...prefs.hostToolPaths };
    const file = path.trim();
    if (file) next[id] = file;
    else delete next[id];
    prefsRef.current = { ...prefsRef.current, hostToolPaths: next };
    onPatch({ hostToolPaths: next });
    if (phase === "idle" && installingRef.current.length === 0) {
      void refresh(prefs.disabledHostTools, next);
    }
  };

  const shown = tools.map((tool) => ({
    ...tool,
    enabled: !prefs.disabledHostTools.includes(tool.id),
  }));
  const detail = shown.find((item) => item.id === detailId) ?? null;

  const busy = phase !== "idle" || installing.length > 0;
  const waitingIds = new Set(waiting.map((item) => item.id));
  const failureById = new Map(failures.map((item) => [item.id, item.message]));
  const status =
    phase === "scan"
      ? "正在扫描本机…"
      : phase === "fetch"
        ? fetchStatus(installing.length, waiting.length)
        : installing.length > 0
          ? "正在安装所选工具…"
          : seen
            ? readyCount(shown)
            : "正在读取本机…";

  return (
    <>
      <div className="agent-cap__scan">
        <button type="button" className="settings__save" onClick={scan} disabled={busy}>
          扫描本机
        </button>
        <span className="agent-cap__muted">{status}</span>
        <div className="agent-cap__filters" role="group" aria-label="筛选工具">
          {VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={
                view === item.id ? "agent-cap__filter is-on" : "agent-cap__filter"
              }
              aria-pressed={view === item.id}
              onClick={() => setView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <p className="agent-cap__lead">
        第一次打开会自动获取还没装的工具，并记住结果。之后打开直接读这份记录。
        需要再查本机时点扫描。同时最多两个，共用 Scoop、Node 或 Python 的会排开。
      </p>
      <p className="agent-cap__dir">
        工具目录 <code aria-label="工具目录">{toolsDir}</code>
      </p>
      {failureById.get("probe") ? (
        <p className="agent-cap__error">{failureById.get("probe")}</p>
      ) : null}
      {CATEGORIES.map((category) => {
        const all = shown.filter((item) => item.category === category);
        const rows = all.filter((item) => matchesView(item, view));
        if (rows.length === 0) return null;
        const ready = all.filter(
          (item) => item.enabled && item.status === "ready",
        ).length;
        return (
          <section key={category}>
            <h2 className="agent-cap__section-title">
              {HOST_TOOL_CATEGORY_LABEL[category]}
              <span className="agent-cap__muted">
                {" "}
                {ready}/{all.length}
              </span>
            </h2>
            <div className="settings__card">
              {rows.map((tool) => (
                <ToolRow
                  key={tool.id}
                  tool={tool}
                  busy={installing.some((item) => item.id === tool.id)}
                  queued={waitingIds.has(tool.id)}
                  failure={failureById.get(tool.id) ?? ""}
                  onToggle={(enabled) =>
                    onPatch({
                      disabledHostTools: setHostToolEnabled(
                        prefs.disabledHostTools,
                        tool.id,
                        enabled,
                      ),
                    })
                  }
                  onDetail={() => setDetailId(tool.id)}
                />
              ))}
            </div>
          </section>
        );
      })}
      {detail ? (
        <ToolDetail
          tool={detail}
          savedPath={prefs.hostToolPaths[detail.id] ?? ""}
          busy={installing.some((item) => item.id === detail.id)}
          queued={waitingIds.has(detail.id)}
          locked={
            !canStartHostToolInstall(installing, {
              id: detail.id,
              lane: detail.lane,
            })
          }
          log={logs[detail.id] ?? ""}
          onInstall={() => install(detail.id, detail.lane, detail.name)}
          onClose={() => setDetailId(null)}
          onSave={(path) => savePath(detail.id, path)}
          onClear={() => savePath(detail.id, "")}
        />
      ) : null}
    </>
  );
}

function matchesView(tool: HostToolSnapshot, view: ToolView): boolean {
  if (view === "ready") return tool.enabled && tool.status === "ready";
  if (view === "missing") return tool.enabled && tool.status !== "ready";
  return true;
}

function fetchStatus(active: number, queued: number): string {
  if (queued === 0) return `正在自动获取：${active} 个进行中`;
  return `正在自动获取：${active} 个进行中，还有 ${queued} 个等待`;
}

function readyCount(tools: HostToolSnapshot[]): string {
  const ready = tools.filter((item) => item.status === "ready").length;
  return `${ready}/${tools.length} 可用`;
}

function rowStatus(
  tool: HostToolSnapshot,
  busy: boolean,
  queued: boolean,
  failure: string,
): { text: string; ready: boolean } {
  if (!tool.enabled) return { text: "已停用", ready: false };
  if (busy) return { text: "正在安装…", ready: false };
  if (queued) return { text: "等待获取", ready: false };
  if (tool.status === "ready") return { text: "已安装", ready: true };
  if (failure) return { text: "获取失败", ready: false };
  return { text: "未安装", ready: false };
}

function pathLabel(tool: HostToolSnapshot): string {
  if (tool.id === "ocr") return "模型目录";
  if (tool.programs[0] === "python" || tool.id === "cairo" || tool.id === "webview2") {
    return "路径";
  }
  return "二进制路径";
}

function ToolRow({
  tool,
  busy,
  queued,
  failure,
  onToggle,
  onDetail,
}: {
  tool: HostToolSnapshot;
  busy: boolean;
  queued: boolean;
  failure: string;
  onToggle: (enabled: boolean) => void;
  onDetail: () => void;
}) {
  const status = rowStatus(tool, busy, queued, failure);
  return (
    <div
      className={
        tool.enabled
          ? "settings__row settings__row--stack agent-tools__row"
          : "settings__row settings__row--stack agent-tools__row is-disabled"
      }
    >
      <div className="settings__row-main">
        <div className="agent-tools__copy">
          <div className="settings__row-title">{tool.name}</div>
          <div className="agent-tools__meta">{tool.summary}</div>
        </div>
        <div className="agent-cap__row-actions">
          <span
            className={
              status.ready ? "agent-tools__state is-ready" : "agent-tools__state"
            }
          >
            {status.text}
          </span>
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
          <button
            type="button"
            className="agent-tools__detail"
            aria-label={`${tool.name} 详情`}
            onClick={onDetail}
          >
            详情
          </button>
        </div>
      </div>
    </div>
  );
}

function ToolDetail({
  tool,
  savedPath,
  busy,
  queued,
  locked,
  log,
  onInstall,
  onClose,
  onSave,
  onClear,
}: {
  tool: HostToolSnapshot;
  savedPath: string;
  busy: boolean;
  queued: boolean;
  locked: boolean;
  log: string;
  onInstall: () => void;
  onClose: () => void;
  onSave: (path: string) => void;
  onClear: () => void;
}) {
  const inputId = useId();
  const logRef = useRef<HTMLTextAreaElement>(null);
  const [path, setPath] = useState(savedPath || tool.path);
  const [checking, setChecking] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState<boolean | null>(null);
  const label = pathLabel(tool);
  const canInstall = tool.enabled && tool.install === "auto" && tool.status !== "ready";
  const showLog = busy || queued || log.length > 0;

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [log]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const check = () => {
    const file = path.trim();
    if (!file || checking) return;
    setChecking(true);
    setMessage("");
    setOk(null);
    void checkHostTool(tool.id, file)
      .then((hit) => {
        onSave(hit.path || file);
        setPath(hit.path || file);
        setOk(true);
        setMessage(hit.version ? `可以使用。${hit.version}` : "可以使用。");
      })
      .catch((err: unknown) => {
        setOk(false);
        setMessage(errorMessage(err, "检测失败"));
      })
      .finally(() => setChecking(false));
  };

  const browse = () => {
    if (browsing) return;
    setBrowsing(true);
    void pickHostToolPath(tool.id)
      .then((picked) => {
        if (picked) setPath(picked);
      })
      .finally(() => setBrowsing(false));
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal agent-tools__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={tool.name}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <h2>{tool.name}</h2>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </header>
        <div className="modal__body">
          <section>
            <h3 className="agent-tools__label">功能</h3>
            <p className="modal__message">{tool.summary}</p>
          </section>
          <section>
            <h3 className="agent-tools__label">使用说明</h3>
            <p className="modal__message">{tool.usage}</p>
            <p className="agent-tools__hint">可执行名：{tool.programs.join("、")}</p>
          </section>
          <section>
            <h3 className="agent-tools__label">当前路径</h3>
            <div className="agent-tools__current">{tool.path || "尚未检测到"}</div>
            {tool.version ? (
              <div className="agent-tools__hint">{tool.version}</div>
            ) : null}
          </section>
          <div className="field">
            <label className="field__label" htmlFor={inputId}>
              {label}
            </label>
            <div className="agent-tools__path-row">
              <input
                id={inputId}
                className="date-input"
                value={path}
                placeholder="选择或粘贴绝对路径"
                spellCheck={false}
                onChange={(event) => setPath(event.target.value)}
              />
              <button type="button" className="btn" onClick={browse} disabled={browsing}>
                {browsing ? "正在选择…" : "浏览"}
              </button>
            </div>
            <p className="agent-tools__hint">
              检测通过后，Agent 会改用这个文件。清除后恢复自动检测。
            </p>
          </div>
          {message ? (
            <p className={ok ? "agent-tools__ok" : "agent-cap__error"}>{message}</p>
          ) : null}
          {showLog ? (
            <div className="field">
              <label className="field__label" htmlFor={`${inputId}-log`}>
                安装日志
              </label>
              <textarea
                ref={logRef}
                id={`${inputId}-log`}
                className="agent-tools__log"
                aria-label="安装日志"
                readOnly
                value={log}
                spellCheck={false}
              />
            </div>
          ) : null}
        </div>
        <footer className="modal__footer">
          {savedPath ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPath("");
                setMessage("");
                setOk(null);
                onClear();
              }}
            >
              清除
            </button>
          ) : null}
          {canInstall ? (
            <button
              type="button"
              className="btn"
              onClick={onInstall}
              disabled={busy || queued || locked}
            >
              {busy ? "正在安装…" : queued ? "等待获取" : "安装"}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--primary"
            disabled={checking || !path.trim()}
            onClick={check}
          >
            {checking ? "正在检测…" : "检测"}
          </button>
        </footer>
      </div>
    </div>
  );
}
