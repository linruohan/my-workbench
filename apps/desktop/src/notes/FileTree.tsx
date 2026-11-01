import { useEffect, useState } from "react";
import { fileNameOf, isImageFile, isMarkdownFile } from "@wb/domain";
import { listDirectory, type KbEntry } from "./kb-api";

type Props = {
  roots: string[];
  activePath: string | null;
  refreshToken: number;
  onOpen: (entry: KbEntry) => void;
  onRemoveRoot: (path: string) => void;
};

export function FileTree({
  roots,
  activePath,
  refreshToken,
  onOpen,
  onRemoveRoot,
}: Props) {
  if (roots.length === 0) return null;
  return (
    <div className="knowledge__tree" aria-label="导入的目录">
      {roots.map((root) => (
        <DirNode
          key={root}
          path={root}
          name={fileNameOf(root)}
          depth={0}
          isRoot
          activePath={activePath}
          refreshToken={refreshToken}
          onOpen={onOpen}
          onRemoveRoot={onRemoveRoot}
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
  onOpen,
  onRemoveRoot,
}: {
  path: string;
  name: string;
  depth: number;
  isRoot?: boolean;
  activePath: string | null;
  refreshToken: number;
  onOpen: (entry: KbEntry) => void;
  onRemoveRoot: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const [entries, setEntries] = useState<KbEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancel = false;
    listDirectory(path)
      .then((rows) => {
        if (cancel) return;
        setEntries(rows);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : "无法读取目录");
      });
    return () => {
      cancel = true;
    };
  }, [open, path, refreshToken]);

  return (
    <div className="knowledge__branch">
      <div className="knowledge__row" style={{ paddingLeft: 8 + depth * 14 }}>
        <button
          type="button"
          className="knowledge__twist"
          aria-label={open ? `折叠 ${name}` : `展开 ${name}`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "▾" : "▸"}
        </button>
        <button
          type="button"
          className="knowledge__file"
          title={path}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="knowledge__file-name">{name}</span>
        </button>
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
      {open && entries
        ? entries.map((entry) =>
            entry.isDir ? (
              <DirNode
                key={entry.path}
                path={entry.path}
                name={entry.name}
                depth={depth + 1}
                activePath={activePath}
                refreshToken={refreshToken}
                onOpen={onOpen}
                onRemoveRoot={onRemoveRoot}
              />
            ) : (
              <button
                key={entry.path}
                type="button"
                className={
                  activePath === entry.path
                    ? "knowledge__file is-active"
                    : "knowledge__file"
                }
                style={{ paddingLeft: 28 + (depth + 1) * 14 }}
                title={entry.path}
                onClick={() => onOpen(entry)}
              >
                <FileMark name={entry.name} />
                <span className="knowledge__file-name">{entry.name}</span>
              </button>
            ),
          )
        : null}
    </div>
  );
}

function FileMark({ name }: { name: string }) {
  const label = isMarkdownFile(name) ? "MD" : isImageFile(name) ? "图" : "文件";
  return <span className="knowledge__mark">{label}</span>;
}
