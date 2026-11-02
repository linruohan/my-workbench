import { useEffect, useMemo, useState } from "react";
import { fileNameOf, isIgnoredKbName, isPathUnder, samePath } from "@wb/domain";
import {
  listDirectory,
  type KbEntry,
  type KbSortDir,
  type KbSortKey,
} from "./kb-api";
import { FileIcon, FolderIcon } from "./FileTreeIcons";

type Props = {
  roots: string[];
  /** When set, only this root is shown (current library folder). */
  activeRoot?: string | null;
  activePath: string | null;
  refreshToken: number;
  filter?: string;
  sortKey?: KbSortKey;
  sortDir?: KbSortDir;
  onOpen: (entry: KbEntry) => void;
  onRemoveRoot: (path: string) => void;
  onCreateIn?: (rootPath: string) => void;
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function sortKbEntries(
  entries: KbEntry[],
  sortKey: KbSortKey,
  sortDir: KbSortDir,
): KbEntry[] {
  const dir = sortDir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let cmp = 0;
    if (sortKey === "mtime") {
      cmp = (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0);
    } else if (sortKey === "type") {
      cmp =
        extOf(a.name).localeCompare(extOf(b.name), undefined, {
          sensitivity: "base",
        }) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    } else {
      cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    }
    if (cmp === 0) {
      cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    }
    return cmp * dir;
  });
}

export function FileTree({
  roots,
  activeRoot = null,
  activePath,
  refreshToken,
  filter = "",
  sortKey = "name",
  sortDir = "asc",
  onOpen,
  onRemoveRoot,
  onCreateIn,
}: Props) {
  const visibleRoots =
    activeRoot && roots.some((r) => samePath(r, activeRoot))
      ? roots.filter((r) => samePath(r, activeRoot))
      : roots;
  if (visibleRoots.length === 0) return null;
  const query = filter.trim().toLowerCase();
  return (
    <div className="knowledge__tree" aria-label="导入的目录">
      {visibleRoots.map((root) => (
        <DirNode
          key={root}
          path={root}
          name={fileNameOf(root)}
          depth={0}
          isRoot
          activePath={activePath}
          refreshToken={refreshToken}
          filter={query}
          sortKey={sortKey}
          sortDir={sortDir}
          onOpen={onOpen}
          onRemoveRoot={onRemoveRoot}
          onCreateIn={onCreateIn}
        />
      ))}
    </div>
  );
}

function DirNode({
  path,
  name,
  depth,
  isRoot,
  activePath,
  refreshToken,
  filter,
  sortKey,
  sortDir,
  onOpen,
  onRemoveRoot,
  onCreateIn,
}: {
  path: string;
  name: string;
  depth: number;
  isRoot?: boolean;
  activePath: string | null;
  refreshToken: number;
  filter: string;
  sortKey: KbSortKey;
  sortDir: KbSortDir;
  onOpen: (entry: KbEntry) => void;
  onRemoveRoot: (path: string) => void;
  onCreateIn?: (rootPath: string) => void;
}) {
  const [open, setOpen] = useState(
    () =>
      depth === 0 ||
      Boolean(filter) ||
      Boolean(activePath && isPathUnder(path, activePath)),
  );
  const [trackedActive, setTrackedActive] = useState(activePath);
  const [trackedFilter, setTrackedFilter] = useState(filter);
  const [entries, setEntries] = useState<KbEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // Reveal the active file when selection changes; user can still collapse afterward.
  if (activePath !== trackedActive) {
    setTrackedActive(activePath);
    if (activePath && isPathUnder(path, activePath)) setOpen(true);
  }
  if (filter !== trackedFilter) {
    setTrackedFilter(filter);
    if (filter) setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    let cancel = false;
    const token = `${path}:${refreshToken}`;
    listDirectory(path)
      .then((rows) => {
        if (cancel) return;
        setEntries(rows.filter((entry) => !isIgnoredKbName(entry.name)));
        setError(null);
        setLoadedFor(token);
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : "无法读取目录");
      });
    return () => {
      cancel = true;
    };
  }, [open, path, refreshToken]);

  const visible = useMemo(() => {
    if (!entries) return null;
    const filtered = filter
      ? entries.filter(
          (entry) => entry.isDir || entry.name.toLowerCase().includes(filter),
        )
      : entries;
    return sortKbEntries(filtered, sortKey, sortDir);
  }, [entries, filter, sortKey, sortDir]);

  const loading = open && !error && loadedFor !== `${path}:${refreshToken}`;
  const toggle = () => setOpen((value) => !value);

  return (
    <div className="knowledge__branch">
      <div className="knowledge__row" style={{ paddingLeft: 8 + depth * 14 }}>
        <button
          type="button"
          className="knowledge__twist"
          aria-label={open ? `折叠 ${name}` : `展开 ${name}`}
          aria-expanded={open}
          onClick={toggle}
        >
          {open ? "▾" : "▸"}
        </button>
        <button type="button" className="knowledge__file" title={path} onClick={toggle}>
          <FolderIcon open={open} />
          <span className="knowledge__file-name">{name}</span>
        </button>
        {isRoot && onCreateIn ? (
          <button
            type="button"
            className="knowledge__remove"
            title="在此目录新建 Markdown"
            onClick={() => onCreateIn(path)}
          >
            新建
          </button>
        ) : null}
        {isRoot ? (
          <button
            type="button"
            className="knowledge__remove"
            onClick={() => onRemoveRoot(path)}
          >
            移除
          </button>
        ) : null}
      </div>
      {open && error ? <p className="knowledge__tree-error">{error}</p> : null}
      {open && loading ? <p className="knowledge__tree-hint">加载中…</p> : null}
      {open && visible
        ? visible.map((entry) =>
            entry.isDir ? (
              <DirNode
                key={entry.path}
                path={entry.path}
                name={entry.name}
                depth={depth + 1}
                activePath={activePath}
                refreshToken={refreshToken}
                filter={filter}
                sortKey={sortKey}
                sortDir={sortDir}
                onOpen={onOpen}
                onRemoveRoot={onRemoveRoot}
              />
            ) : (
              <button
                key={entry.path}
                type="button"
                className={
                  activePath && samePath(activePath, entry.path)
                    ? "knowledge__file is-active"
                    : "knowledge__file"
                }
                style={{ paddingLeft: 28 + (depth + 1) * 14 }}
                title={entry.path}
                onClick={() => onOpen(entry)}
              >
                <FileIcon name={entry.name} />
                <span className="knowledge__file-name">{entry.name}</span>
              </button>
            ),
          )
        : null}
    </div>
  );
}
