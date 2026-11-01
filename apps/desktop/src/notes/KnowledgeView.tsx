import { useEffect, useRef, useState } from "react";
import type { Note, NoteEditorMode } from "@wb/domain";
import {
  fileStem,
  isImageFile,
  isMarkdownFile,
  isPathUnder,
  isTextFile,
  joinPath,
  parentDir,
  samePath,
} from "@wb/domain";
import { isTauriRuntime } from "../lib/paths";
import { FileTree } from "./FileTree";
import {
  ensureNoteAssetDir,
  kbExists,
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

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

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
  const [filter, setFilter] = useState("");
  const [asset, setAsset] = useState<{ id: string; dir: string } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
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

  const flushSave = async () => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const item = pendingSave.current;
    pendingSave.current = null;
    if (!item || !isTauriRuntime()) return;
    setSaveState("saving");
    try {
      await writeTextFile(item.path, item.body);
      setSaveState("saved");
    } catch (err) {
      pendingSave.current = item;
      setSaveState("error");
      window.alert(err instanceof Error ? err.message : "保存失败");
    }
  };

  useEffect(() => {
    return () => {
      void flushSave();
    };
  }, []);

  const updateFileBody = (path: string, body: string) => {
    setOpenFile((current) =>
      current &&
      current.path === path &&
      (current.kind === "md" || current.kind === "text")
        ? { ...current, body }
        : current,
    );
    pendingSave.current = { path, body };
    setSaveState("dirty");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void flushSave();
    }, 400);
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
    if (!window.confirm(`从知识库移除目录？\n${path}\n（不会删除磁盘文件）`)) return;
    setRoots((current) => {
      const next = current.filter((item) => !samePath(item, path));
      saveKnowledgeRoots(next);
      return next;
    });
    setOpenFile((current) => {
      if (!current) return current;
      return isPathUnder(path, current.path) ? null : current;
    });
  };

  const createMarkdownIn = async (rootPath: string) => {
    if (!isTauriRuntime()) return;
    const name = window.prompt("新建 Markdown 文件名", "未命名笔记.md");
    if (!name?.trim()) return;
    const fileName = name.trim().toLowerCase().endsWith(".md")
      ? name.trim()
      : `${name.trim()}.md`;
    const path = joinPath(rootPath, fileName);
    try {
      if (await kbExists(path)) {
        window.alert("同名文件已存在。");
        return;
      }
      const title = fileStem(fileName);
      const body = `# ${title}\n\n`;
      await writeTextFile(path, body);
      setRefreshToken((value) => value + 1);
      setOpenFile({ kind: "md", path, title: fileName, body });
      setSaveState("saved");
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "无法创建文件");
    }
  };

  const openEntry = async (entry: KbEntry) => {
    await flushSave();
    if (entry.isDir) return;
    setSaveState("idle");
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
        setSaveState("saved");
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

  const saveLabel =
    openFile && (openFile.kind === "md" || openFile.kind === "text")
      ? saveState === "saving"
        ? "保存中…"
        : saveState === "dirty"
          ? "未保存"
          : saveState === "error"
            ? "保存失败"
            : saveState === "saved"
              ? "已保存"
              : null
      : null;

  return (
    <section className="knowledge">
      <aside className="knowledge__list" aria-label="笔记列表">
        <header className="knowledge__list-header">
          <h1>知识库</h1>
          <div className="knowledge__header-actions">
            <button type="button" onClick={() => void importDirectory()}>
              导入目录
            </button>
            <button
              type="button"
              title="刷新目录树"
              onClick={() => setRefreshToken((value) => value + 1)}
            >
              刷新
            </button>
            <button type="button" className="primary" onClick={onCreate}>
              新建
            </button>
          </div>
        </header>
        {roots.length > 0 ? (
          <div className="knowledge__filter">
            <input
              aria-label="筛选文件"
              placeholder="筛选目录中的文件…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        ) : null}
        <div className="knowledge__scroll">
          <FileTree
            roots={roots}
            activePath={openFile?.path ?? null}
            refreshToken={refreshToken}
            filter={filter}
            onOpen={(entry) => void openEntry(entry)}
            onRemoveRoot={removeRoot}
            onCreateIn={(root) => void createMarkdownIn(root)}
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
                      void flushSave().then(() => {
                        setOpenFile(null);
                        setSaveState("idle");
                        onSelect(n.id);
                      });
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
              saveLabel={saveLabel}
              imageBaseDir={parentDir(openFile.path)}
              imageStem={fileStem(openFile.path)}
              onAssetSaved={() => setRefreshToken((value) => value + 1)}
              onSave={() => void flushSave()}
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
            saveLabel={saveLabel}
            onSave={() => void flushSave()}
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
  saveLabel,
  onChange,
  onSave,
}: {
  path: string;
  title: string;
  body: string;
  saveLabel: string | null;
  onChange: (body: string) => void;
  onSave: () => void;
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
        {saveLabel ? <span className="note-editor__save">{saveLabel}</span> : null}
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
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            onSave();
          }
        }}
      />
    </div>
  );
}

function ImageFile({ path, title }: { path: string; title: string }) {
  const [result, setResult] = useState<{ path: string; url?: string; error?: string }>({
    path,
  });
  useEffect(() => {
    let cancel = false;
    void readImageDataUrl(path)
      .then((url) => {
        if (!cancel) setResult({ path, url });
      })
      .catch((err: unknown) => {
        if (!cancel) {
          setResult({
            path,
            error: err instanceof Error ? err.message : "无法显示图片",
          });
        }
      });
    return () => {
      cancel = true;
    };
  }, [path]);
  const current = result.path === path ? result : { path };
  return (
    <div className="knowledge__file-view">
      <h2>{title}</h2>
      <p className="knowledge__path">{path}</p>
      {current.error ? <p className="empty">{current.error}</p> : null}
      {current.url ? (
        <img className="knowledge__photo" src={current.url} alt={title} />
      ) : null}
      {!current.url && !current.error ? <p className="empty">正在加载图片…</p> : null}
    </div>
  );
}
