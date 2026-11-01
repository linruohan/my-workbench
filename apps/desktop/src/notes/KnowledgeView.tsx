import type { Note } from "@wb/domain";
import { NoteEditor } from "./NoteEditor";

type Props = {
  notes: Note[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onChange: (id: string, patch: { title?: string; bodyMd?: string }) => void;
  onDelete: (id: string) => void;
};

export function KnowledgeView({
  notes,
  activeId,
  onSelect,
  onCreate,
  onChange,
  onDelete,
}: Props) {
  const active = notes.find((n) => n.id === activeId) ?? notes[0] ?? null;

  return (
    <section className="knowledge">
      <aside className="knowledge__list" aria-label="笔记列表">
        <header className="knowledge__list-header">
          <h1>知识库</h1>
          <button type="button" className="primary" onClick={onCreate}>
            新建
          </button>
        </header>
        {notes.length === 0 ? (
          <p className="empty">还没有笔记。点「新建」开始写 Markdown。</p>
        ) : (
          <ul className="knowledge__items">
            {notes.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className={
                    active?.id === n.id
                      ? "knowledge__item is-active"
                      : "knowledge__item"
                  }
                  onClick={() => onSelect(n.id)}
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
      </aside>
      <div className="knowledge__editor">
        {active ? (
          <NoteEditor
            key={active.id}
            note={active}
            onChange={(patch) => onChange(active.id, patch)}
            onDelete={() => onDelete(active.id)}
          />
        ) : (
          <p className="empty knowledge__empty">选择或新建一篇笔记。</p>
        )}
      </div>
    </section>
  );
}
