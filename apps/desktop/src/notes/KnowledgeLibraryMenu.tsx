import { fileNameOf, samePath } from "@wb/domain";
import type { KbSortDir, KbSortKey } from "./kb-api";

type Props = {
  activeRoot: string | null;
  recentRoots: string[];
  sortKey: KbSortKey;
  sortDir: KbSortDir;
  onClose: () => void;
  onNewFile: () => void;
  onSearch: () => void;
  onReveal: () => void;
  onOpenFolder: () => void;
  onRefresh: () => void;
  onSelectRecent: (path: string) => void;
  onSortKey: (key: KbSortKey) => void;
  onToggleSortDir: () => void;
};

export function KnowledgeLibraryMenu({
  activeRoot,
  recentRoots,
  sortKey,
  sortDir,
  onClose,
  onNewFile,
  onSearch,
  onReveal,
  onOpenFolder,
  onRefresh,
  onSelectRecent,
  onSortKey,
  onToggleSortDir,
}: Props) {
  return (
    <div className="kb-menu" role="menu" aria-label="知识库目录菜单">
      <div className="kb-menu__head">
        <span className="kb-menu__section-title">操作</span>
        <button
          type="button"
          className="kb-menu__close"
          aria-label="关闭菜单"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="kb-menu__actions">
        <button type="button" role="menuitem" onClick={onNewFile}>
          新建文件
        </button>
        <button type="button" role="menuitem" onClick={onSearch}>
          搜索
        </button>
        <button type="button" role="menuitem" onClick={onReveal} disabled={!activeRoot}>
          在资源管理器中显示
        </button>
        <button type="button" role="menuitem" onClick={onOpenFolder}>
          打开文件夹…
        </button>
        <button type="button" role="menuitem" onClick={onRefresh}>
          刷新
        </button>
      </div>

      <div className="kb-menu__sort">
        <span className="kb-menu__section-title">排序</span>
        <div className="kb-menu__sort-icons" role="group" aria-label="排序方式">
          <button
            type="button"
            className="kb-menu__sort-btn is-active"
            title="目录树"
            aria-label="目录树"
            aria-pressed="true"
          >
            <IconFolder />
          </button>
          <button
            type="button"
            className={
              sortDir === "asc" ? "kb-menu__sort-btn is-active" : "kb-menu__sort-btn"
            }
            title={sortDir === "asc" ? "升序" : "降序"}
            aria-label={sortDir === "asc" ? "升序" : "降序"}
            aria-pressed={sortDir === "asc"}
            onClick={onToggleSortDir}
          >
            <IconSortDir asc={sortDir === "asc"} />
          </button>
          <button
            type="button"
            className={
              sortKey === "name" ? "kb-menu__sort-btn is-active" : "kb-menu__sort-btn"
            }
            title="按名称"
            aria-label="按名称"
            aria-pressed={sortKey === "name"}
            onClick={() => onSortKey("name")}
          >
            <IconSortName />
          </button>
          <button
            type="button"
            className={
              sortKey === "mtime" ? "kb-menu__sort-btn is-active" : "kb-menu__sort-btn"
            }
            title="按修改时间"
            aria-label="按修改时间"
            aria-pressed={sortKey === "mtime"}
            onClick={() => onSortKey("mtime")}
          >
            <IconSortTime />
          </button>
          <button
            type="button"
            className={
              sortKey === "type" ? "kb-menu__sort-btn is-active" : "kb-menu__sort-btn"
            }
            title="按类型"
            aria-label="按类型"
            aria-pressed={sortKey === "type"}
            onClick={() => onSortKey("type")}
          >
            <IconSortType />
          </button>
        </div>
      </div>

      <div className="kb-menu__recent">
        <span className="kb-menu__section-title">最近使用的目录</span>
        {recentRoots.length === 0 ? (
          <p className="kb-menu__empty">暂无最近目录</p>
        ) : (
          <ul className="kb-menu__recent-list">
            {recentRoots.map((path) => {
              const active = activeRoot ? samePath(activeRoot, path) : false;
              return (
                <li key={path}>
                  <button
                    type="button"
                    className={
                      active ? "kb-menu__recent-item is-active" : "kb-menu__recent-item"
                    }
                    title={path}
                    role="menuitem"
                    onClick={() => onSelectRecent(path)}
                  >
                    <span className="kb-menu__recent-icon" aria-hidden>
                      <IconFolder />
                    </span>
                    <span className="kb-menu__recent-name">{fileNameOf(path)}</span>
                    {active ? (
                      <span className="kb-menu__dot" aria-label="当前目录" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function IconFolder() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h3.1c.4 0 .77.2 1 .52L8.4 3.5H12.5A1.5 1.5 0 0 1 14 5v7.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9Z" />
    </svg>
  );
}

function IconSortDir({ asc }: { asc: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      {asc ? (
        <path d="M8 3.2 4.6 7h2.1v5.8h2.6V7h2.1L8 3.2ZM3 13.2h10v1.4H3v-1.4Z" />
      ) : (
        <path d="M8 12.8 11.4 9H9.3V3.2H6.7V9H4.6L8 12.8ZM3 1.4h10v1.4H3V1.4Z" />
      )}
    </svg>
  );
}

function IconSortName() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M5.2 2.2 2.4 9.5h1.7l.55-1.55h2.9L8.1 9.5h1.7L7 2.2H5.2Zm-.15 4.55.95-2.7.95 2.7H5.05ZM9.4 13.8V6.4h1.55v5.55H14v1.85H9.4Z" />
    </svg>
  );
}

function IconSortTime() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden
    >
      <circle cx="8" cy="8" r="5.2" />
      <path d="M8 5.2V8l2 1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconSortType() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4 2.2h5.2L12.8 6v7.8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.2a1 1 0 0 1 1-1Zm5 .9v2.7h2.7L9 3.1ZM5.2 8.2h5.6v1.2H5.2V8.2Zm0 2.4h4.2v1.2H5.2v-1.2Z" />
    </svg>
  );
}
