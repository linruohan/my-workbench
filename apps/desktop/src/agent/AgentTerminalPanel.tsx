import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/errors";
import { isTauriRuntime } from "../lib/paths";
import { IconClose, IconCommand, IconPlus, IconRefresh, IconStop } from "../shell/icons";
import {
  closeAgentTerminal,
  listAgentTerminals,
  openAgentTerminal,
  readAgentTerminal,
  sendAgentTerminal,
  signalAgentTerminal,
  type AgentTerminalInfo,
} from "./terminal-api";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Workspace root required to spawn a new PTY session. */
  rootPath: string;
  /** Default workdir for newly opened terminals. */
  cwd?: string | null;
  /** Bump to force an immediate refresh (e.g. after a tool turn). */
  refreshKey?: number;
};

const HISTORY_LIMIT = 50;

export function AgentTerminalPanel({
  open,
  onOpenChange,
  rootPath,
  cwd,
  refreshKey = 0,
}: Props) {
  const [terminals, setTerminals] = useState<AgentTerminalInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const stickBottom = useRef(true);
  const hadTerminals = useRef(false);
  const openChangeRef = useRef(onOpenChange);
  openChangeRef.current = onOpenChange;

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const rows = await listAgentTerminals();
        if (cancelled) return;
        setTerminals(rows);
        setActiveId((current) => {
          if (current && rows.some((row) => row.id === current)) return current;
          return rows[0]?.id ?? null;
        });
        if (rows.length > 0 && !hadTerminals.current) {
          openChangeRef.current(true);
        }
        hadTerminals.current = rows.length > 0;
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, "无法列出终端"));
      }
    };
    void tick();
    const timer = window.setInterval(tick, open ? 1500 : 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, refreshKey]);

  useEffect(() => {
    if (!open || !activeId || !isTauriRuntime()) {
      setOutput("");
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const hit = await readAgentTerminal(activeId);
        if (cancelled) return;
        setOutput(hit.output);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, "无法读取终端"));
      }
    };
    void load();
    const timer = window.setInterval(load, 900);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, activeId, refreshKey]);

  useEffect(() => {
    const node = preRef.current;
    if (!node || !stickBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [output]);

  if (!isTauriRuntime()) return null;
  if (!open && terminals.length === 0) return null;

  const active = terminals.find((row) => row.id === activeId) ?? null;
  const canType = Boolean(active?.alive);

  const refreshAfter = async (preferredId?: string | null) => {
    const rows = await listAgentTerminals();
    setTerminals(rows);
    const nextId =
      (preferredId && rows.some((row) => row.id === preferredId) ? preferredId : null) ||
      (activeId && rows.some((row) => row.id === activeId) ? activeId : null) ||
      rows[0]?.id ||
      null;
    setActiveId(nextId);
    if (nextId) {
      const hit = await readAgentTerminal(nextId);
      setOutput(hit.output);
    } else {
      setOutput("");
    }
  };

  const runAction = async (action: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const preferred = await action();
      await refreshAfter(typeof preferred === "string" ? preferred : null);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "终端操作失败"));
    } finally {
      setBusy(false);
    }
  };

  const submitDraft = async () => {
    if (!activeId || !canType || busy) return;
    const text = draft;
    setDraft("");
    setHistoryIndex(-1);
    if (text.trim()) {
      setHistory((prev) => {
        const next = [...prev.filter((item) => item !== text), text];
        return next.slice(-HISTORY_LIMIT);
      });
    }
    await runAction(async () => {
      await sendAgentTerminal(activeId, text, true);
      return activeId;
    });
    inputRef.current?.focus();
  };

  return (
    <section className="agent__term" aria-label="持久终端">
      <div className="agent__term-head">
        <div className="agent__term-title">
          <IconCommand size={14} />
          <strong>终端</strong>
          {terminals.length ? (
            <span className="agent__term-count">{terminals.length}</span>
          ) : null}
        </div>
        <div className="agent__term-actions">
          <button
            type="button"
            className="agent__term-btn"
            title="新建终端"
            aria-label="新建终端"
            disabled={busy || !rootPath.trim()}
            onClick={() =>
              void runAction(async () => {
                const hit = await openAgentTerminal({
                  root: rootPath,
                  workdir: cwd || rootPath,
                  name: `term_${terminals.length + 1}`,
                });
                return hit.id;
              })
            }
          >
            <IconPlus size={14} />
          </button>
          <button
            type="button"
            className="agent__term-btn"
            title="刷新"
            aria-label="刷新终端"
            disabled={busy || !activeId}
            onClick={() => void runAction(async () => undefined)}
          >
            <IconRefresh size={14} />
          </button>
          <button
            type="button"
            className="agent__term-btn"
            title="中断 (Ctrl+C)"
            aria-label="中断终端"
            disabled={busy || !active?.alive}
            onClick={() =>
              void runAction(async () => {
                if (activeId) await signalAgentTerminal(activeId, "SIGINT");
              })
            }
          >
            <IconStop size={14} />
          </button>
          <button
            type="button"
            className="agent__term-btn"
            title="关闭会话"
            aria-label="关闭终端会话"
            disabled={busy || !activeId}
            onClick={() =>
              void runAction(async () => {
                if (activeId) await closeAgentTerminal(activeId);
              })
            }
          >
            <IconClose size={14} />
          </button>
          <button
            type="button"
            className="agent__term-btn"
            title={open ? "折叠" : "展开"}
            aria-label={open ? "折叠终端面板" : "展开终端面板"}
            aria-expanded={open}
            onClick={() => onOpenChange(!open)}
          >
            {open ? "收起" : "展开"}
          </button>
        </div>
      </div>
      {open ? (
        <>
          <div className="agent__term-tabs" role="tablist" aria-label="终端会话">
            {terminals.length === 0 ? (
              <p className="agent__term-empty">
                还没有打开的终端。点 + 新建，或让 Agent 调用 terminal_open。
              </p>
            ) : (
              terminals.map((term) => (
                <button
                  key={term.id}
                  type="button"
                  role="tab"
                  aria-selected={term.id === activeId}
                  className={
                    term.id === activeId ? "agent__term-tab is-active" : "agent__term-tab"
                  }
                  onClick={() => {
                    setActiveId(term.id);
                    setDraft("");
                    setHistoryIndex(-1);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                >
                  <span className="agent__term-tab-name">{term.name}</span>
                  <span
                    className={
                      term.alive ? "agent__term-dot is-alive" : "agent__term-dot"
                    }
                    aria-label={term.alive ? "运行中" : "已结束"}
                  />
                </button>
              ))
            )}
          </div>
          {active ? (
            <p className="agent__term-meta">
              {active.shell || "shell"} · {active.cwd}
              {active.alive ? "" : " · 已结束"}
            </p>
          ) : null}
          {error ? <p className="agent__term-error">{error}</p> : null}
          <pre
            ref={preRef}
            className="agent__term-output"
            onScroll={(event) => {
              const node = event.currentTarget;
              stickBottom.current =
                node.scrollHeight - node.scrollTop - node.clientHeight < 48;
            }}
          >
            {output || (active ? "（暂无输出）" : "")}
          </pre>
          <form
            className="agent__term-input-row"
            onSubmit={(event) => {
              event.preventDefault();
              void submitDraft();
            }}
          >
            <input
              ref={inputRef}
              className="agent__term-input"
              aria-label="终端输入"
              placeholder={canType ? "输入命令，Enter 发送" : "终端不可用"}
              value={draft}
              disabled={!canType || busy}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setDraft(event.target.value);
                setHistoryIndex(-1);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  if (!history.length) return;
                  const next =
                    historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
                  setHistoryIndex(next);
                  setDraft(history[next] ?? "");
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  if (historyIndex < 0) return;
                  const next = historyIndex + 1;
                  if (next >= history.length) {
                    setHistoryIndex(-1);
                    setDraft("");
                    return;
                  }
                  setHistoryIndex(next);
                  setDraft(history[next] ?? "");
                } else if (event.key === "c" && event.ctrlKey && !event.altKey) {
                  if (draft) return;
                  event.preventDefault();
                  void runAction(async () => {
                    if (activeId) await signalAgentTerminal(activeId, "SIGINT");
                  });
                } else if (event.key === "l" && event.ctrlKey && !event.altKey) {
                  event.preventDefault();
                  setOutput("");
                }
              }}
            />
            <button
              type="submit"
              className="agent__term-send"
              disabled={!canType || busy}
            >
              发送
            </button>
          </form>
        </>
      ) : null}
    </section>
  );
}
