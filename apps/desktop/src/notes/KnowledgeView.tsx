import { useEffect, useRef, useState } from "react";
import type { Note, NoteEditorMode } from "@wb/domain";
import {
  fileStem,
  isImageFile,
  isMarkdownFile,
  isTextFile,
  parentDir,
  samePath,
} from "@wb/domain";
import { isTauriRuntime } from "../lib/paths";
import { FileTree } from "./FileTree";
import {
  ensureNoteAssetDir,
  loadKnowledgeRoots,
  pickDirectory,
  readImageDataUrl,
  readTextFile,
  saveKnowledgeRoots,
  writeTextFile,
  type KbEntry,
} from "./kb-api";
import { NoteEditor } from "./NoteEditor";

type Props = {
  notes: Note[];
  activeId: string | null;
  preferLastNote?: boolean;
  defaultEditorMode?: NoteEditorMode;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onChange: (id: string, patch: { title?: string; bodyMd?: string }) => void;
  onDelete: (id: string) => void;
};

type OpenFile =
  | { kind: "md" | "text"; path: string; title: string; body: string }
  | { kind: "image"; path: string; title: string }
  | { kind: "other"; path: string; title: string; message?: string };

export function KnowledgeView({
  notes,
  activeId,
  preferLastNote = true,
  defaultEditorMode = "live",
  onSelect,
  onCreate,
  onChange,
  onDelete,
}: Props) {
  const [roots, setRoots] = useState<string[]>(() => loadKnowledgeRoots());
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [asset, setAsset] = useState<{ id: string; dir: string } | null>(null);
  const pendingSave = useRef<{ path: string; body: string } | null>(null);
  const saveTimer = useRef<number | null>(null);

  const selected = activeId ? notes.find((n) => n.id === activeId) : null;
  const active = openFile
    ? null
    : (selected ?? (preferLastNote ? (notes[0] ?? null) : null));
  const activeNoteId = active?.id ?? null;

  const noteAssetDir = asset?.id === activeNoteId ? asset.dir : null;

  useEffect(() => {
    if (!activeNoteId || !isTauriRuntime()) return;
    let cancel = false;
    const noteId = activeNoteId;
    void ensureNoteAssetDir(noteId).then((dir) => {
      if (!cancel && dir) setAsset({ id: noteId, dir });
    });
    return () => {
      cancel = true;
    };
  }, [activeNoteId]);

  const flushSave = () => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const item = pendingSave.current;
    pendingSave.current = null;
    if (!item || !isTauriRuntime()) return;
    void writeTextFile(item.path, item.body);
  };

  useEffect(() => () => flushSave(), []);

  const updateFileBody = (path: string, body: string) => {
    setOpenFile((current) =>
      current &&
      current.path === path &&
      (current.kind === "md" || current.kind === "text")
        ? { ...current, body }
        : current,
    );
    pendingSave.current = { path, body };
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushSave, 400);
  };

  const importDirectory = async () => {
    if (!isTauriRuntime()) {
      window.alert("导入本地目录需要在桌面应用中使用。");
      return;
    }
    try {
      const picked = await pickDirectory();
      if (!picked) return;
      setRoots((current) => {
        if (current.some((item) => samePath(item, picked))) return current;
        const next = [...current, picked];
        saveKnowledgeRoots(next);
        return next;
      });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "无法打开目录选择器");
    }
  };

  const removeRoot = (path: string) => {
    setRoots((current) => {
      const next = current.filter((item) => !samePath(item, path));
      saveKnowledgeRoots(next);
      return next;
    });
    setOpenFile((current) => {
      if (!current) return current;
      const prefix = path.replace(/[\\/]+$/, "").toLowerCase();
      const file = current.path.replace(/\\/g, "/").toLowerCase();
      const root = prefix.replace(/\\/g, "/");
      if (file === root || file.startsWith(root + "/")) return null;
      return current;
    });
  };

  const openEntry = async (entry: KbEntry) => {
    flushSave();
    if (entry.isDir) return;
    if (isImageFile(entry.name)) {
      setOpenFile({ kind: "image", path: entry.path, title: entry.name });
      return;
    }
    if (isMarkdownFile(entry.name) || isTextFile(entry.name)) {
      try {
        const body = (await readTextFile(entry.path)).replace(/\r\n/g, "\n");
        setOpenFile({
          kind: isMarkdownFile(entry.name) ? "md" : "text",
          path: entry.path,
          title: entry.name,
          body,
        });
      } catch (err) {
        setOpenFile({
          kind: "other",
          path: entry.path,
          title: entry.name,
          message: err instanceof Error ? err.message : "无法读取文件",
        });
      }
      return;
    }
    setOpenFile({ kind: "other", path: entry.path, title: entry.name });
  };

  return (
    <section className="knowledge">
      <aside className="knowledge__list" aria-label="笔记列表">
        <header className="knowledge__list-header">
          <h1>知识库</h1>
          <div className="knowledge__header-actions">
            <button type="button" onClick={() => void importDirectory()}>
              导入目录
            </button>
            <button type="button" className="primary" onClick={onCreate}>
              新建
            </button>
          </div>
        </header>
        <div className="knowledge__scroll">
          <FileTree
            roots={roots}
            activePath={openFile?.path ?? null}
            refreshToken={refreshToken}
            onOpen={(entry) => void openEntry(entry)}
            onRemoveRoot={removeRoot}
          />
          {roots.length > 0 ? <p className="knowledge__section">笔记</p> : null}
          {notes.length === 0 && roots.length === 0 ? (
            <p className="empty">
              还没有笔记。可以「新建」，或「导入目录」浏览本地文件。
            </p>
          ) : notes.length === 0 ? (
            <p className="empty">没有应用内笔记。目录里的 Markdown 可以直接编辑。</p>
          ) : (
            <ul className="knowledge__items">
              {notes.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={
                      !openFile && active?.id === n.id
                        ? "knowledge__item is-active"
                        : "knowledge__item"
                    }
                    onClick={() => {
                      flushSave();
                      setOpenFile(null);
                      onSelect(n.id);
                    }}
                  >
                    <span className="knowledge__item-title">{n.title}</span>
                    <span className="knowledge__item-meta">
                      {new Date(n.updatedAt).toLocaleString("zh-CN")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
      <div className="knowledge__editor">
        {openFile?.kind === "md" ? (
          <>
            <p className="knowledge__path" title={openFile.path}>
              {openFile.path}
            </p>
            <NoteEditor
              key={`${openFile.path}:${defaultEditorMode}`}
              note={{
                id: openFile.path,
                projectId: null,
                title: openFile.title,
                bodyMd: openFile.body,
                createdAt: 0,
                updatedAt: 0,
              }}
              defaultMode={defaultEditorMode}
              titleReadOnly
              imageBaseDir={parentDir(openFile.path)}
              imageStem={fileStem(openFile.path)}
              onAssetSaved={() => setRefreshToken((value) => value + 1)}
              onChange={(patch) => {
                if (patch.bodyMd !== undefined)
                  updateFileBody(openFile.path, patch.bodyMd);
              }}
            />
          </>
        ) : openFile?.kind === "text" ? (
          <PlainTextFile
            path={openFile.path}
            title={openFile.title}
            body={openFile.body}
            onChange={(body) => updateFileBody(openFile.path, body)}
          />
        ) : openFile?.kind === "image" ? (
          <ImageFile key={openFile.path} path={openFile.path} title={openFile.title} />
        ) : openFile?.kind === "other" ? (
          <div className="knowledge__file-view">
            <h2>{openFile.title}</h2>
            <p className="knowledge__path">{openFile.path}</p>
            <p className="empty">
              {openFile.message ?? "此文件类型只在目录树中展示，不能当作 Markdown 编辑。"}
            </p>
          </div>
        ) : active ? (
          <NoteEditor
            key={`${active.id}:${defaultEditorMode}`}
            note={active}
            defaultMode={defaultEditorMode}
            imageBaseDir={noteAssetDir}
            imageStem={active.title}
            onChange={(patch) => onChange(active.id, patch)}
            onDelete={() => onDelete(active.id)}
          />
        ) : (
          <p className="empty knowledge__empty">
            选择或新建一篇笔记，或导入一个本地目录。
          </p>
        )}
      </div>
    </section>
  );
}

function PlainTextFile({
  path,
  title,
  body,
  onChange,
}: {
  path: string;
  title: string;
  body: string;
  onChange: (body: string) => void;
}) {
  return (
    <div className="note-editor">
      <header className="note-editor__toolbar">
        <input
          className="note-editor__title"
          aria-label="文件名"
          value={title}
          readOnly
        />
      </header>
      <p className="knowledge__path" title={path}>
        {path}
      </p>
      <textarea
        className="note-editor__source knowledge__plain"
        aria-label="文件内容"
        spellCheck={false}
        value={body}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function ImageFile({ path, title }: { path: string; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancel = false;
    void readImageDataUrl(path)
      .then((next) => {
        if (!cancel) setUrl(next);
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : "无法显示图片");
      });
    return () => {
      cancel = true;
    };
  }, [path]);
  return (
    <div className="knowledge__file-view">
      <h2>{title}</h2>
      <p className="knowledge__path">{path}</p>
      {error ? <p className="empty">{error}</p> : null}
      {url ? <img className="knowledge__photo" src={url} alt={title} /> : null}
      {!url && !error ? <p className="empty">正在加载图片…</p> : null}
    </div>
  );
}
