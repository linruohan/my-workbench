import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Note } from "@wb/domain";
import {
  fileNameOf,
  fileStem,
  isImageFile,
  isMarkdownFile,
  isPathUnder,
  isTextFile,
  joinPath,
  parentDir,
  samePath,
} from "@wb/domain";
import { errorMessage } from "../lib/errors";
import { isTauriRuntime } from "../lib/paths";
import { PromptModal } from "../shell/PromptModal";
import { useDialog } from "../shell/Dialogs";
import { VoiceField } from "../voice";
import { FileTree } from "./FileTree";
import { KnowledgeLibraryMenu } from "./KnowledgeLibraryMenu";
import {
  ensureNoteAssetDir,
  kbExists,
  loadActiveKnowledgeRoot,
  loadKnowledgeRoots,
  loadKnowledgeSort,
  loadRecentKnowledgeRoots,
  pickDirectory,
  pushRecentKnowledgeRoot,
  readImageDataUrl,
  readTextFile,
  renameKbPath,
  revealInExplorer,
  saveActiveKnowledgeRoot,
  saveKnowledgeRoots,
  saveKnowledgeSort,
  scanKnowledgeFiles,
  writeTextFile,
  type KbEntry,
  type KbSortDir,
  type KbSortKey,
} from "./kb-api";
import { NoteEditor } from "./NoteEditor";
import { QuickOpen } from "./QuickOpen";

function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/[. ]+$/g, "")
    .trim();
}

function withPreservedExt(oldName: string, nextName: string): string {
  const trimmed = sanitizeFileName(nextName);
  if (!trimmed) return oldName;
  const dot = oldName.lastIndexOf(".");
  if (dot <= 0) return trimmed;
  const ext = oldName.slice(dot);
  if (trimmed.toLowerCase().endsWith(ext.toLowerCase())) return trimmed;
  return `${trimmed}${ext}`;
}

type Props = {
  notes: Note[];
  activeId: string | null;
  preferLastNote?: boolean;
  /** Open a knowledge-base disk file after navigating from global search. */
  pendingOpenPath?: string | null;
  onPendingOpenPathConsumed?: () => void;
  /** Bumped when global search focuses an in-app note so disk preview yields. */
  noteFocusToken?: number;
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

/** 输入停顿多久后自动写盘 */
const AUTOSAVE_DELAY_MS = 800;

export function KnowledgeView({
  notes,
  activeId,
  preferLastNote = true,
  pendingOpenPath = null,
  onPendingOpenPathConsumed,
  noteFocusToken = 0,
  onSelect,
  onCreate,
  onChange,
  onDelete,
}: Props) {
  const dialog = useDialog();
  const [roots, setRoots] = useState<string[]>(() => loadKnowledgeRoots());
  const [activeRoot, setActiveRoot] = useState<string | null>(() =>
    loadActiveKnowledgeRoot(loadKnowledgeRoots()),
  );
  const [recentRoots, setRecentRoots] = useState<string[]>(() =>
    loadRecentKnowledgeRoots(),
  );
  const initialSort = loadKnowledgeSort();
  const [sortKey, setSortKey] = useState<KbSortKey>(initialSort.key);
  const [sortDir, setSortDir] = useState<KbSortDir>(initialSort.dir);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [filter, setFilter] = useState("");
  const [asset, setAsset] = useState<{ id: string; dir: string } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [createFileRoot, setCreateFileRoot] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickFiles, setQuickFiles] = useState<KbEntry[]>([]);
  const [quickLoading, setQuickLoading] = useState(false);
  const pendingSave = useRef<Map<string, string>>(new Map());
  const saveTimer = useRef<number | null>(null);
  const libraryRef = useRef<HTMLDivElement>(null);
  /** 当前 QuickOpen 扫描会话；关闭面板或重新打开时置 cancelled 终止旧扫描。 */
  const quickScanRef = useRef<{ cancelled: boolean } | null>(null);

  const activeRootLabel = useMemo(() => {
    if (!activeRoot) return "选择目录";
    return fileNameOf(activeRoot) || activeRoot;
  }, [activeRoot]);

  const activateRoot = useCallback((path: string) => {
    setActiveRoot(path);
    saveActiveKnowledgeRoot(path);
    setRecentRoots(pushRecentKnowledgeRoot(path));
  }, []);

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

  const flushSave = useCallback(async () => {
    if (saveTimer.current != null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const pending = pendingSave.current;
    if (pending.size === 0) return;
    if (!isTauriRuntime()) {
      pending.clear();
      setSaveState("saved");
      return;
    }
    const entries = [...pending.entries()];
    pending.clear();
    setSaveState("saving");
    const failed: Array<[string, string]> = [];
    let firstError: unknown = null;
    for (const [path, body] of entries) {
      try {
        await writeTextFile(path, body);
      } catch (err) {
        failed.push([path, body]);
        firstError ??= err;
      }
    }
    for (const [path, body] of failed) {
      // 保存期间又有新输入时，保留更新的内容而不是回填旧文本
      if (!pending.has(path)) pending.set(path, body);
    }
    if (!failed.length) {
      setSaveState("saved");
      return;
    }
    setSaveState("error");
    void dialog.alert({
      title: "保存失败",
      message: errorMessage(firstError, "保存失败"),
    });
  }, [dialog]);

  // Save pending edits when hiding/closing the app or leaving this view.
  useEffect(() => {
    const onLeave = () => {
      const pending = pendingSave.current;
      if (pending.size === 0 || !isTauriRuntime()) return;
      for (const [path, body] of pending) void writeTextFile(path, body);
      pending.clear();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onLeave();
    };
    window.addEventListener("beforeunload", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      void flushSave();
    };
  }, [flushSave]);

  /** 输入停顿 800ms 后自动写盘，避免只在切视图/关窗时才保存 */
  const scheduleSave = useCallback(() => {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void flushSave();
    }, AUTOSAVE_DELAY_MS);
  }, [flushSave]);

  const updateFileBody = (path: string, body: string) => {
    setOpenFile((current) =>
      current &&
      current.path === path &&
      (current.kind === "md" || current.kind === "text")
        ? { ...current, body }
        : current,
    );
    pendingSave.current.set(path, body);
    setSaveState("dirty");
    scheduleSave();
  };

  const renameOpenFile = async (nextFileName: string) => {
    if (!openFile || (openFile.kind !== "md" && openFile.kind !== "text")) return;
    const nextName = withPreservedExt(openFile.title, nextFileName);
    if (!sanitizeFileName(nextName)) {
      throw new Error("文件名不能为空或包含非法字符。");
    }
    if (!nextName || nextName === openFile.title) return;
    const dest = joinPath(parentDir(openFile.path), nextName);
    if (samePath(dest, openFile.path)) return;
    const fromPath = openFile.path;
    await flushSave();
    if (await kbExists(dest)) {
      throw new Error("同名文件已存在。");
    }
    await renameKbPath(fromPath, dest);
    const pendingBody = pendingSave.current.get(fromPath);
    if (pendingBody !== undefined) {
      pendingSave.current.delete(fromPath);
      pendingSave.current.set(dest, pendingBody);
    }
    setOpenFile((current) =>
      current && current.path === fromPath
        ? { ...current, path: dest, title: nextName }
        : current,
    );
    setRefreshToken((value) => value + 1);
    setSaveState("saved");
  };

  const openQuickOpen = useCallback(() => {
    setQuickOpen(true);
    if (!isTauriRuntime() || roots.length === 0) {
      setQuickFiles([]);
      setQuickLoading(false);
      return;
    }
    if (quickScanRef.current) quickScanRef.current.cancelled = true;
    const run = { cancelled: false };
    quickScanRef.current = run;
    setQuickFiles([]);
    setQuickLoading(true);
    // 扫描会话：逐批增量填充结果；关闭面板即取消。
    void scanKnowledgeFiles(roots, {
      maxFiles: 8000,
      isCancelled: () => run.cancelled,
      onBatch: (batch) => {
        if (run.cancelled) return;
        setQuickFiles((prev) => [...prev, ...batch]);
        setQuickLoading(false);
      },
    })
      .then((files) => {
        if (run.cancelled) return;
        setQuickFiles(files);
      })
      .catch(() => {
        if (run.cancelled) return;
        setQuickFiles([]);
      })
      .finally(() => {
        if (!run.cancelled) setQuickLoading(false);
      });
  }, [roots]);

  const closeQuickOpen = useCallback(() => {
    setQuickOpen(false);
    if (quickScanRef.current) quickScanRef.current.cancelled = true;
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void flushSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flushSave]);

  useEffect(() => {
    if (!libraryOpen) return;
    const onDoc = (event: MouseEvent) => {
      const root = libraryRef.current;
      if (!root) return;
      if (event.target instanceof Node && root.contains(event.target)) return;
      setLibraryOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLibraryOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [libraryOpen]);

  const openFolder = async () => {
    if (!isTauriRuntime()) {
      await dialog.alert("打开本地目录需要在桌面应用中使用。");
      return;
    }
    try {
      const picked = await pickDirectory("打开知识库目录");
      if (!picked) return;
      setRoots((current) => {
        const exists = current.some((item) => samePath(item, picked));
        const next = exists ? current : [...current, picked];
        saveKnowledgeRoots(next);
        return next;
      });
      activateRoot(picked);
      setLibraryOpen(false);
    } catch (err) {
      await dialog.alert({
        title: "无法打开目录",
        message: errorMessage(err, "无法打开目录选择器"),
      });
    }
  };

  const removeRoot = async (path: string) => {
    const ok = await dialog.confirm({
      title: "移除目录",
      message: `从知识库移除目录？\n${path}\n（不会删除磁盘文件）`,
      confirmLabel: "移除",
      danger: true,
    });
    if (!ok) return;
    setRoots((current) => {
      const next = current.filter((item) => !samePath(item, path));
      saveKnowledgeRoots(next);
      if (activeRoot && samePath(activeRoot, path)) {
        const fallback = next[0] ?? null;
        setActiveRoot(fallback);
        saveActiveKnowledgeRoot(fallback);
      }
      return next;
    });
    setOpenFile((current) => {
      if (!current) return current;
      return isPathUnder(path, current.path) ? null : current;
    });
  };

  const selectRecentRoot = (path: string) => {
    setRoots((current) => {
      const exists = current.some((item) => samePath(item, path));
      const next = exists ? current : [...current, path];
      saveKnowledgeRoots(next);
      return next;
    });
    activateRoot(path);
    setRefreshToken((value) => value + 1);
    setLibraryOpen(false);
  };

  const createMarkdownIn = async (rootPath: string, name: string) => {
    if (!isTauriRuntime()) return;
    const fileName = name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
    const path = joinPath(rootPath, fileName);
    try {
      if (await kbExists(path)) {
        await dialog.alert("同名文件已存在。");
        return;
      }
      const title = fileStem(fileName);
      const body = `# ${title}\n\n`;
      await writeTextFile(path, body);
      setRefreshToken((value) => value + 1);
      setOpenFile({ kind: "md", path, title: fileName, body });
      setSaveState("saved");
    } catch (err) {
      await dialog.alert({
        title: "创建失败",
        message: errorMessage(err, "无法创建文件"),
      });
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

  useEffect(() => {
    if (!pendingOpenPath) return;
    const path = pendingOpenPath;
    onPendingOpenPathConsumed?.();
    void openEntry({
      name: fileNameOf(path),
      path,
      isDir: false,
    });
    // One-shot intent from global search; openEntry identity is not part of the contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpenPath]);

  useEffect(() => {
    if (!activeId || pendingOpenPath) return;
    setOpenFile(null);
  }, [activeId, pendingOpenPath]);

  useEffect(() => {
    if (!noteFocusToken) return;
    setOpenFile(null);
  }, [noteFocusToken]);

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
          <div className="knowledge__library" ref={libraryRef}>
            <button
              type="button"
              className="knowledge__library-trigger"
              title={activeRoot ?? "打开知识库目录"}
              aria-haspopup="menu"
              aria-expanded={libraryOpen}
              onClick={() => setLibraryOpen((open) => !open)}
            >
              <span className="knowledge__library-name">{activeRootLabel}</span>
              <span className="knowledge__library-caret" aria-hidden>
                ▾
              </span>
            </button>
            {libraryOpen ? (
              <KnowledgeLibraryMenu
                activeRoot={activeRoot}
                recentRoots={recentRoots}
                sortKey={sortKey}
                sortDir={sortDir}
                onClose={() => setLibraryOpen(false)}
                onNewFile={() => {
                  setLibraryOpen(false);
                  if (activeRoot && isTauriRuntime()) {
                    setCreateFileRoot(activeRoot);
                    return;
                  }
                  // Browser / no folder yet: fall back to an in-app note.
                  onCreate();
                }}
                onSearch={() => {
                  setLibraryOpen(false);
                  openQuickOpen();
                }}
                onReveal={() => {
                  if (!activeRoot) return;
                  void revealInExplorer(activeRoot).catch((err: unknown) => {
                    void dialog.alert({
                      title: "无法打开",
                      message: errorMessage(err, "无法在资源管理器中显示"),
                    });
                  });
                  setLibraryOpen(false);
                }}
                onOpenFolder={() => void openFolder()}
                onRefresh={() => {
                  setRefreshToken((value) => value + 1);
                  setLibraryOpen(false);
                }}
                onSelectRecent={selectRecentRoot}
                onSortKey={(key) => {
                  setSortKey(key);
                  saveKnowledgeSort(key, sortDir);
                }}
                onToggleSortDir={() => {
                  setSortDir((dir) => {
                    const next = dir === "asc" ? "desc" : "asc";
                    saveKnowledgeSort(sortKey, next);
                    return next;
                  });
                }}
              />
            ) : null}
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
            activeRoot={activeRoot}
            activePath={openFile?.path ?? null}
            refreshToken={refreshToken}
            filter={filter}
            sortKey={sortKey}
            sortDir={sortDir}
            onOpen={(entry) => void openEntry(entry)}
            onRemoveRoot={removeRoot}
            onCreateIn={(root) => {
              if (!isTauriRuntime()) return;
              setCreateFileRoot(root);
            }}
          />
          {roots.length > 0 ? <p className="knowledge__section">笔记</p> : null}
          {notes.length === 0 && roots.length === 0 ? (
            <p className="empty">
              还没有笔记。点击右侧目录名打开文件夹，或用 Ctrl+N 新建应用内笔记。
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
              key={openFile.path}
              note={{
                id: openFile.path,
                projectId: null,
                title: openFile.title,
                bodyMd: openFile.body,
                createdAt: 0,
                updatedAt: 0,
              }}
              titleReadOnly
              onRenameFile={(name) => renameOpenFile(name)}
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
            onRenameFile={(name) => renameOpenFile(name)}
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
            key={active.id}
            note={active}
            imageBaseDir={noteAssetDir}
            imageStem={active.title}
            onChange={(patch) => onChange(active.id, patch)}
            onDelete={() => onDelete(active.id)}
          />
        ) : (
          <p className="empty knowledge__empty">
            选择或新建一篇笔记，或点击目录名打开本地文件夹。
          </p>
        )}
      </div>
      <PromptModal
        open={createFileRoot !== null}
        title="新建 Markdown"
        label="文件名"
        initialValue="未命名笔记.md"
        confirmLabel="创建"
        onCancel={() => setCreateFileRoot(null)}
        onConfirm={(name) => {
          const root = createFileRoot;
          setCreateFileRoot(null);
          if (!root) return;
          void createMarkdownIn(root, name);
        }}
      />
      <QuickOpen
        open={quickOpen}
        files={quickFiles}
        loading={quickLoading}
        activePath={openFile?.path ?? null}
        onClose={closeQuickOpen}
        onOpen={(entry) => void openEntry(entry)}
      />
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
  onRenameFile,
}: {
  path: string;
  title: string;
  body: string;
  saveLabel: string | null;
  onChange: (body: string) => void;
  onSave: () => void;
  onRenameFile?: (nextFileName: string) => void | Promise<void>;
}) {
  const dialog = useDialog();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const titleRef = useRef<HTMLInputElement>(null);
  const commitLock = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  useEffect(() => {
    if (!editing) return;
    titleRef.current?.focus();
    titleRef.current?.select();
  }, [editing]);

  const commit = async () => {
    if (!editing || commitLock.current) return;
    commitLock.current = true;
    setEditing(false);
    const next = draft.trim();
    try {
      if (!next || next === title || !onRenameFile) {
        setDraft(title);
        return;
      }
      await onRenameFile(next);
    } catch (err) {
      setDraft(title);
      await dialog.alert({
        title: "重命名失败",
        message: errorMessage(err, "重命名失败"),
      });
    } finally {
      commitLock.current = false;
    }
  };

  return (
    <div className="note-editor">
      <header className="note-editor__toolbar">
        <input
          ref={titleRef}
          className="note-editor__title"
          aria-label="文件名（双击重命名）"
          title="双击重命名文件"
          value={editing ? draft : title}
          readOnly={!editing}
          onDoubleClick={() => {
            if (!onRenameFile) return;
            setDraft(title);
            setEditing(true);
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (editing) void commit();
          }}
          onKeyDown={(e) => {
            if (!editing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setDraft(title);
              setEditing(false);
            }
          }}
        />
        {saveLabel ? <span className="note-editor__save">{saveLabel}</span> : null}
      </header>
      <p className="knowledge__path" title={path}>
        {path}
      </p>
      <VoiceField value={body} onChange={onChange} className="knowledge__voice">
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
      </VoiceField>
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
