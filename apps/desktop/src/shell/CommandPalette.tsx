import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fileNameOf,
  formatAgentRelativeShort,
  isPathUnder,
  samePath,
  type AgentThread,
  type AgentWorkspace,
  type Note,
  type Task,
} from "@wb/domain";
import type { KbEntry } from "../notes/kb-api";
import { FileIcon } from "../notes/FileTreeIcons";
import {
  IconChat,
  IconDone,
  IconInbox,
  IconKnowledge,
  IconPlanner,
  IconPlus,
  IconTasks,
  IconTimed,
  IconToday,
} from "./icons";
import type { AppNavId } from "./Sidebar";

export type CommandPaletteResult =
  | { kind: "task"; id: string }
  | { kind: "thread"; id: string }
  | { kind: "note"; id: string }
  | { kind: "kb-file"; path: string }
  | { kind: "nav"; id: AppNavId }
  | { kind: "project"; id: string }
  | { kind: "create-task"; title: string }
  | { kind: "create-note"; title: string };

type ItemKind = CommandPaletteResult["kind"];

type SectionId = "task" | "thread" | "knowledge";

type RankedItem = {
  key: string;
  kind: ItemKind;
  section: SectionId;
  title: string;
  subtitle: string;
  score: number;
  result: CommandPaletteResult;
};

const SECTION_ORDER: SectionId[] = ["task", "thread", "knowledge"];

type Props = {
  open: boolean;
  tasks: Task[];
  projects: Array<{ id: string; title: string }>;
  threads: AgentThread[];
  workspaces: AgentWorkspace[];
  notes: Note[];
  kbFiles: KbEntry[];
  /** Knowledge library roots; used to show short library names instead of full paths. */
  kbRoots?: string[];
  kbLoading?: boolean;
  /** Live scan progress from the backend index session, when indexing. */
  kbProgress?: { files: number; dirs: number; done: boolean } | null;
  onClose: () => void;
  onSelect: (result: CommandPaletteResult) => void;
};

const MAX_RESULTS = 48;
const PER_KIND = 10;

type Scope = "all" | "task" | "thread" | "note" | "file" | "nav";

const NAV_ITEMS: Array<{
  id: AppNavId;
  label: string;
  keywords: string[];
  icon: ReactNode;
}> = [
  {
    id: "today",
    label: "今日",
    keywords: ["today", "今天"],
    icon: <IconToday size={15} />,
  },
  { id: "inbox", label: "收件箱", keywords: ["inbox"], icon: <IconInbox size={15} /> },
  {
    id: "done",
    label: "已完成",
    keywords: ["done", "完成"],
    icon: <IconDone size={15} />,
  },
  {
    id: "planner",
    label: "计划",
    keywords: ["planner", "计划"],
    icon: <IconPlanner size={15} />,
  },
  {
    id: "timed",
    label: "定时任务",
    keywords: ["timed", "定时", "schedule"],
    icon: <IconTimed size={15} />,
  },
  {
    id: "knowledge",
    label: "知识库",
    keywords: ["knowledge", "笔记", "文档", "kb"],
    icon: <IconKnowledge size={15} />,
  },
  {
    id: "agent",
    label: "Agent",
    keywords: ["agent", "会话", "聊天", "chat"],
    icon: <IconChat size={15} />,
  },
];

function parseScope(raw: string): { scope: Scope; query: string } {
  const text = raw.trim();
  const match =
    /^(t|task|任务|a|agent|会话|n|note|笔记|f|file|文件|g|go|导航)[:：\s]+(.*)$/i.exec(
      text,
    );
  if (!match) return { scope: "all", query: text };
  const token = match[1]!.toLowerCase();
  const rest = (match[2] ?? "").trim();
  if (token === "t" || token === "task" || token === "任务")
    return { scope: "task", query: rest };
  if (token === "a" || token === "agent" || token === "会话")
    return { scope: "thread", query: rest };
  if (token === "n" || token === "note" || token === "笔记")
    return { scope: "note", query: rest };
  if (token === "f" || token === "file" || token === "文件")
    return { scope: "file", query: rest };
  return { scope: "nav", query: rest };
}

function scoreText(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const value = text.toLowerCase();
  if (!q) return 1;
  if (value === q) return 1000;
  if (value.startsWith(q)) return 800 - Math.min(value.length, 200);
  const at = value.indexOf(q);
  if (at >= 0) return 600 - at;
  let cursor = 0;
  for (const ch of q) {
    cursor = value.indexOf(ch, cursor);
    if (cursor < 0) return -1;
    cursor += 1;
  }
  return 100 - Math.min(value.length, 200);
}

function scorePath(query: string, path: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const normalized = path.toLowerCase().replace(/\\/g, "/");
  const name = fileNameOf(path).toLowerCase();
  const byName = scoreText(q, name);
  if (byName < 0 && !normalized.includes(q)) return -1;
  if (byName >= 0) return byName;
  return 400 - normalized.indexOf(q);
}

function sectionLabel(section: SectionId): string {
  if (section === "task") return "任务";
  if (section === "thread") return "会话";
  return "知识库";
}

function navSection(id: AppNavId): SectionId {
  if (id === "agent") return "thread";
  if (id === "knowledge") return "knowledge";
  return "task";
}

function libraryLabelOf(path: string, roots: readonly string[]): string {
  let best: string | null = null;
  for (const root of roots) {
    if (samePath(path, root) || isPathUnder(root, path)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  if (best) return fileNameOf(best) || best;
  return "知识库";
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const at = lower.indexOf(needle);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="quick-open__mark">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

function KindIcon({ item }: { item: RankedItem }) {
  if (item.kind === "create-task" || item.kind === "create-note") {
    return <IconPlus size={15} />;
  }
  if (item.kind === "task") return <IconTasks size={15} />;
  if (item.kind === "thread") return <IconChat size={15} />;
  if (item.kind === "note") return <IconKnowledge size={15} />;
  if (item.kind === "kb-file") return <FileIcon name={item.title} />;
  if (item.kind === "project") return <IconTasks size={15} />;
  const nav = NAV_ITEMS.find((row) => row.id === (item.result as { id: AppNavId }).id);
  return <>{nav?.icon ?? <IconTasks size={15} />}</>;
}

function takeTop(items: RankedItem[], limit: number): RankedItem[] {
  return [...items]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh-CN"))
    .slice(0, limit);
}

export function CommandPalette({
  open,
  tasks,
  projects,
  threads,
  workspaces,
  notes,
  kbFiles,
  kbRoots = [],
  kbLoading = false,
  kbProgress = null,
  onClose,
  onSelect,
}: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [nowMs, setNowMs] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const projectTitle = useMemo(() => {
    const map = new Map(projects.map((item) => [item.id, item.title]));
    return (id: string) => map.get(id) ?? "项目";
  }, [projects]);

  const workspaceTitle = useMemo(() => {
    const map = new Map(workspaces.map((item) => [item.id, item.title]));
    return (id: string) => map.get(id) ?? "工作区";
  }, [workspaces]);

  const { scope, query: needle } = useMemo(() => parseScope(query), [query]);

  const matches = useMemo(() => {
    const empty = needle.length === 0;
    const allow = (section: SectionId) => {
      if (scope === "all") return true;
      if (scope === "task") return section === "task";
      if (scope === "thread") return section === "thread";
      if (scope === "note" || scope === "file") return section === "knowledge";
      // g: 导航：按视图归入三组
      return true;
    };

    const taskItems: RankedItem[] = [];
    const threadItems: RankedItem[] = [];
    const knowledgeItems: RankedItem[] = [];

    if (!empty && (scope === "all" || scope === "task")) {
      taskItems.push({
        key: `create-task:${needle}`,
        kind: "create-task",
        section: "task",
        title: `新建任务「${needle}」`,
        subtitle: "收件箱",
        score: 10_000,
        result: { kind: "create-task", title: needle },
      });
    }
    if (!empty && (scope === "all" || scope === "note")) {
      knowledgeItems.push({
        key: `create-note:${needle}`,
        kind: "create-note",
        section: "knowledge",
        title: `新建笔记「${needle}」`,
        subtitle: "知识库",
        score: 10_000,
        result: { kind: "create-note", title: needle },
      });
    }

    if (scope === "all" || scope === "nav") {
      for (const item of NAV_ITEMS) {
        const section = navSection(item.id);
        if (!allow(section)) continue;
        const score = Math.max(
          scoreText(needle, item.label),
          ...item.keywords.map((word) => scoreText(needle, word)),
        );
        if (score < 0) continue;
        const row: RankedItem = {
          key: `nav:${item.id}`,
          kind: "nav",
          section,
          title: item.label,
          subtitle: "视图",
          score: empty ? 50 : score + 20,
          result: { kind: "nav", id: item.id },
        };
        if (section === "task") taskItems.push(row);
        else if (section === "thread") threadItems.push(row);
        else knowledgeItems.push(row);
      }
      for (const project of projects) {
        if (project.id === "inbox") continue;
        if (!allow("task")) continue;
        const score = scoreText(needle, project.title);
        if (score < 0) continue;
        taskItems.push({
          key: `project:${project.id}`,
          kind: "project",
          section: "task",
          title: project.title,
          subtitle: "项目",
          score: empty ? 40 : score,
          result: { kind: "project", id: project.id },
        });
      }
    }

    if (scope === "all" || scope === "task") {
      for (const task of tasks) {
        if (task.parentId) continue;
        const titleScore = scoreText(needle, task.title);
        const notesScore = task.notes ? scoreText(needle, task.notes) : -1;
        const score = Math.max(titleScore, notesScore > 0 ? notesScore - 80 : -1);
        if (score < 0) continue;
        taskItems.push({
          key: `task:${task.id}`,
          kind: "task",
          section: "task",
          title: task.title || "未命名任务",
          subtitle: `${projectTitle(task.projectId)}${task.isDone ? " · 已完成" : ""}`,
          score: empty ? task.updatedAt / 1e12 : score,
          result: { kind: "task", id: task.id },
        });
      }
    }

    if (scope === "all" || scope === "thread") {
      for (const thread of threads) {
        const titleScore = scoreText(needle, thread.title);
        const ws = workspaceTitle(thread.workspaceId);
        const wsScore = scoreText(needle, ws);
        const score = Math.max(titleScore, wsScore > 0 ? wsScore - 40 : -1);
        if (score < 0) continue;
        threadItems.push({
          key: `thread:${thread.id}`,
          kind: "thread",
          section: "thread",
          title: thread.title || "未命名会话",
          subtitle: `${ws} · ${formatAgentRelativeShort(thread.updatedAt, nowMs || Date.now())}`,
          score: empty ? thread.updatedAt / 1e12 : score,
          result: { kind: "thread", id: thread.id },
        });
      }
    }

    if (scope === "all" || scope === "note") {
      for (const note of notes) {
        const titleScore = scoreText(needle, note.title);
        const bodyScore = note.bodyMd ? scoreText(needle, note.bodyMd.slice(0, 400)) : -1;
        const score = Math.max(titleScore, bodyScore > 0 ? bodyScore - 100 : -1);
        if (score < 0) continue;
        knowledgeItems.push({
          key: `note:${note.id}`,
          kind: "note",
          section: "knowledge",
          title: note.title || "未命名笔记",
          subtitle: "知识库",
          score: empty ? note.updatedAt / 1e12 : score,
          result: { kind: "note", id: note.id },
        });
      }
    }
    if (scope === "all" || scope === "file") {
      for (const entry of kbFiles) {
        if (entry.isDir) continue;
        const score = scorePath(needle, entry.path);
        if (score < 0) continue;
        knowledgeItems.push({
          key: `kb:${entry.path}`,
          kind: "kb-file",
          section: "knowledge",
          title: entry.name || fileNameOf(entry.path),
          subtitle: libraryLabelOf(entry.path, kbRoots),
          score: empty ? (entry.mtimeMs ?? 0) / 1e12 : score,
          result: { kind: "kb-file", path: entry.path },
        });
      }
    }

    const recentLimit = empty ? 5 : PER_KIND;
    const bySection: Record<SectionId, RankedItem[]> = {
      task: allow("task") ? takeTop(taskItems, recentLimit + (empty ? 0 : 2)) : [],
      thread: allow("thread") ? takeTop(threadItems, recentLimit) : [],
      knowledge: allow("knowledge")
        ? takeTop(knowledgeItems, recentLimit + (empty ? 0 : 2))
        : [],
    };

    const flat: RankedItem[] = [];
    for (const section of SECTION_ORDER) {
      for (const item of bySection[section]) {
        flat.push(item);
        if (flat.length >= MAX_RESULTS) return flat;
      }
    }
    return flat;
  }, [
    tasks,
    threads,
    notes,
    kbFiles,
    kbRoots,
    projects,
    needle,
    scope,
    projectTitle,
    workspaceTitle,
    nowMs,
  ]);

  const rows = useMemo(() => {
    const out: Array<
      | { type: "header"; key: string; label: string }
      | { type: "item"; key: string; item: RankedItem; flatIndex: number }
    > = [];
    let prev: RankedItem["section"] | null = null;
    let flatIndex = 0;
    for (const item of matches) {
      if (item.section !== prev) {
        out.push({
          type: "header",
          key: `sec:${item.section}`,
          label: sectionLabel(item.section),
        });
        prev = item.section;
      }
      out.push({ type: "item", key: item.key, item, flatIndex });
      flatIndex += 1;
    }
    return out;
  }, [matches]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    setNowMs(Date.now());
    const id = requestAnimationFrame(() => {
      const node = inputRef.current;
      if (!node) return;
      if (document.activeElement !== node) node.focus();
      // 只在输入框还空着时全选，避免把用户已经打进去的首字选中后被下一个字符覆盖。
      if (node.value === "") node.select();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    const node = activeRef.current;
    if (!node || typeof node.scrollIntoView !== "function") return;
    node.scrollIntoView({ block: "nearest" });
  }, [index, matches]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const select = (item: RankedItem) => {
    onSelect(item.result);
    onClose();
  };

  const placeholder =
    scope === "task"
      ? "搜索任务…"
      : scope === "thread"
        ? "搜索会话…"
        : scope === "note"
          ? "搜索笔记…"
          : scope === "file"
            ? "搜索文件…"
            : scope === "nav"
              ? "搜索视图或项目…"
              : "搜索任务、会话、文档…  可用 t: / a: / n:";

  return (
    <div className="quick-open" role="dialog" aria-label="全局搜索">
      <button
        type="button"
        className="quick-open__backdrop"
        aria-label="关闭"
        onClick={onClose}
      />
      <div className="quick-open__panel">
        <input
          ref={inputRef}
          className="quick-open__input"
          placeholder={placeholder}
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((value) => Math.min(value + 1, Math.max(0, matches.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((value) => Math.max(0, value - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const item = matches[index];
              if (item) select(item);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="quick-open__list" role="listbox" aria-label="搜索结果">
          {kbLoading && (scope === "all" || scope === "file" || scope === "note") ? (
            <p className="quick-open__hint">
              正在索引知识库文件…
              {kbProgress
                ? ` 已扫描 ${kbProgress.files} 个文件 · ${kbProgress.dirs} 个目录`
                : ""}
            </p>
          ) : null}
          {!kbLoading && matches.length === 0 ? (
            <p className="quick-open__hint">
              没有匹配的任务、会话或知识库项。可用 `t:` / `a:` / `n:` 限定范围。
            </p>
          ) : null}
          {rows.map((row) => {
            if (row.type === "header") {
              return (
                <p key={row.key} className="quick-open__section">
                  {row.label}
                </p>
              );
            }
            const { item, flatIndex } = row;
            const active = flatIndex === index;
            return (
              <button
                key={item.key}
                ref={active ? activeRef : undefined}
                type="button"
                role="option"
                aria-selected={active}
                className={active ? "quick-open__item is-active" : "quick-open__item"}
                onMouseEnter={() => setIndex(flatIndex)}
                onClick={() => select(item)}
              >
                <span className="quick-open__kind" aria-hidden>
                  <KindIcon item={item} />
                </span>
                <span className="quick-open__name">
                  {item.kind === "create-task" || item.kind === "create-note" ? (
                    item.title
                  ) : (
                    <Highlight text={item.title} query={needle} />
                  )}
                </span>
                {item.subtitle ? (
                  <span className="quick-open__path">{item.subtitle}</span>
                ) : null}
              </button>
            );
          })}
        </div>
        <p className="quick-open__footer">
          Enter 跳转/创建 · ↑↓ 选择 · Esc 关闭 · Ctrl+P
          {kbFiles.length > 0 ? ` · 已索引 ${kbFiles.length} 个文件` : null}
        </p>
      </div>
    </div>
  );
}
