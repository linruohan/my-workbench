import { useEffect, useMemo, useRef, useState } from "react";
import { fileNameOf, parentDir } from "@wb/domain";
import type { KbEntry } from "./kb-api";
import { FileIcon } from "./FileTreeIcons";

type Props = {
  open: boolean;
  files: KbEntry[];
  loading?: boolean;
  activePath?: string | null;
  onClose: () => void;
  onOpen: (entry: KbEntry) => void;
};

function rank(query: string, entry: KbEntry): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const name = entry.name.toLowerCase();
  const path = entry.path.toLowerCase().replace(/\\/g, "/");
  if (name === q) return 1000;
  if (name.startsWith(q)) return 800 - name.length;
  if (name.includes(q)) return 600 - name.indexOf(q);
  if (path.includes(q)) return 400 - path.indexOf(q);
  // Loose subsequence match on file name.
  let at = 0;
  for (const ch of q) {
    at = name.indexOf(ch, at);
    if (at < 0) return -1;
    at += 1;
  }
  return 100 - name.length;
}

export function QuickOpen({
  open,
  files,
  loading = false,
  activePath = null,
  onClose,
  onOpen,
}: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const scored = files
      .map((entry) => ({ entry, score: rank(query, entry) }))
      .filter((row) => row.score >= 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
    return scored.slice(0, 80).map((row) => row.entry);
  }, [files, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

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

  const select = (entry: KbEntry) => {
    onOpen(entry);
    onClose();
  };

  return (
    <div className="quick-open" role="dialog" aria-label="搜索打开文件">
      <button type="button" className="quick-open__backdrop" aria-label="关闭" onClick={onClose} />
      <div className="quick-open__panel">
        <input
          ref={inputRef}
          className="quick-open__input"
          placeholder="搜索知识库文件…"
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
              const entry = matches[index];
              if (entry) select(entry);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="quick-open__list" role="listbox" aria-label="匹配文件">
          {loading ? <p className="quick-open__hint">正在扫描目录…</p> : null}
          {!loading && matches.length === 0 ? (
            <p className="quick-open__hint">没有匹配的文件</p>
          ) : null}
          {matches.map((entry, i) => {
            const active = i === index;
            const current = activePath ? entry.path === activePath : false;
            return (
              <button
                key={entry.path}
                type="button"
                role="option"
                aria-selected={active}
                className={
                  active
                    ? "quick-open__item is-active"
                    : current
                      ? "quick-open__item is-current"
                      : "quick-open__item"
                }
                onMouseEnter={() => setIndex(i)}
                onClick={() => select(entry)}
              >
                <FileIcon name={entry.name} />
                <span className="quick-open__name">{fileNameOf(entry.path)}</span>
                <span className="quick-open__path" title={entry.path}>
                  {parentDir(entry.path)}
                </span>
              </button>
            );
          })}
        </div>
        <p className="quick-open__footer">
          Enter 打开 · ↑↓ 选择 · Esc 关闭
          {files.length > 0 ? ` · 已索引 ${files.length} 个文件` : null}
        </p>
      </div>
    </div>
  );
}
