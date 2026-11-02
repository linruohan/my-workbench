import { useEffect, useId, useMemo, useRef, useState } from "react";
import { resolveTagChipColors, type Tag } from "@wb/domain";

type Props = {
  tags: Tag[];
  selectedIds: string[];
  onChange: (tagIds: string[]) => void;
  onCreateTag?: (title: string) => Tag | null;
  label?: string;
  placeholder?: string;
};

export function TagPicker({
  tags,
  selectedIds,
  onChange,
  onCreateTag,
  label = "标签",
  placeholder = "选择或新建标签",
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = useMemo(
    () => tags.filter((t) => selectedIds.includes(t.id)),
    [tags, selectedIds],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((t) => t.title.toLowerCase().includes(q));
  }, [tags, query]);

  const canCreate = Boolean(
    onCreateTag &&
      query.trim() &&
      !tags.some((t) => t.title.toLowerCase() === query.trim().toLowerCase()),
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = (tagId: string) => {
    if (selectedIds.includes(tagId)) {
      onChange(selectedIds.filter((id) => id !== tagId));
    } else {
      onChange([...selectedIds, tagId]);
    }
  };

  const createFromQuery = () => {
    const title = query.trim();
    if (!title || !onCreateTag) return;
    const created = onCreateTag(title);
    setQuery("");
    if (created && !selectedIds.includes(created.id)) {
      onChange([...selectedIds, created.id]);
    }
  };

  const summary =
    selected.length === 0
      ? placeholder
      : selected.map((t) => t.title).join("、");

  return (
    <div className="tag-picker" ref={rootRef}>
      <button
        type="button"
        className={
          open ? "tag-picker__trigger is-open" : "tag-picker__trigger"
        }
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setOpen((v) => {
            const next = !v;
            if (next) {
              requestAnimationFrame(() => inputRef.current?.focus());
            } else {
              setQuery("");
            }
            return next;
          });
        }}
      >
        {selected.length > 0 ? (
          <span className="tag-picker__chips" aria-hidden={open}>
            {selected.map((tag) => {
              const colors = resolveTagChipColors(tag);
              return (
                <span
                  key={tag.id}
                  className="tag-picker__chip"
                  style={{
                    background: colors.background,
                    borderColor: colors.border,
                    color: colors.text,
                  }}
                >
                  {tag.title}
                </span>
              );
            })}
          </span>
        ) : (
          <span className="tag-picker__placeholder">{summary}</span>
        )}
        <span className="tag-picker__caret" aria-hidden>
          ▾
        </span>
      </button>

      {open ? (
        <div className="tag-picker__panel" role="presentation">
          <input
            ref={inputRef}
            className="field__control tag-picker__search"
            aria-label="筛选或新建标签"
            placeholder={
              onCreateTag ? "搜索标签，回车新建" : "搜索标签"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
                setQuery("");
                return;
              }
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (canCreate) createFromQuery();
            }}
          />
          <ul
            id={listId}
            className="tag-picker__list"
            role="listbox"
            aria-label={label}
            aria-multiselectable="true"
          >
            {filtered.length === 0 && !canCreate ? (
              <li className="tag-picker__empty">没有匹配的标签</li>
            ) : null}
            {filtered.map((tag) => {
              const checked = selectedIds.includes(tag.id);
              return (
                <li key={tag.id} role="presentation">
                  <label
                    className={
                      checked
                        ? "tag-picker__option is-checked"
                        : "tag-picker__option"
                    }
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(tag.id)}
                    />
                    <span className="tag-picker__option-title">{tag.title}</span>
                  </label>
                </li>
              );
            })}
            {canCreate ? (
              <li role="presentation">
                <button
                  type="button"
                  className="tag-picker__create"
                  onClick={createFromQuery}
                >
                  新建「{query.trim()}」
                </button>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
