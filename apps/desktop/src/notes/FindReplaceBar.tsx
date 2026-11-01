import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";

export type FindReplaceState = {
  query: string;
  replace: string;
  regex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  inSelection: boolean;
  preserveCase: boolean;
};

type Props = {
  open: boolean;
  value: FindReplaceState;
  status?: string | null;
  onChange: (patch: Partial<FindReplaceState>) => void;
  onClose: () => void;
  onFind: (reverse?: boolean) => void;
  onFindAll: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
};

function Toggle({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "find-bar__toggle is-active" : "find-bar__toggle"}
      title={title}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function FindReplaceBar({
  open,
  value,
  status,
  onChange,
  onClose,
  onFind,
  onFindAll,
  onReplace,
  onReplaceAll,
}: Props) {
  const findRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;

  const onFindKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onFind(event.shiftKey);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const onReplaceKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) onReplaceAll();
      else onReplace();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    onFind(false);
  };

  return (
    <form className="find-bar" aria-label="查找和替换" onSubmit={onSubmit}>
      <div className="find-bar__row">
        <div className="find-bar__toggles" role="group" aria-label="查找选项">
          <Toggle
            label=".*"
            title="正则表达式"
            active={value.regex}
            onClick={() => onChange({ regex: !value.regex })}
          />
          <Toggle
            label="Aa"
            title="区分大小写"
            active={value.matchCase}
            onClick={() => onChange({ matchCase: !value.matchCase })}
          />
          <Toggle
            label={'""'}
            title="全词匹配"
            active={value.wholeWord}
            onClick={() => onChange({ wholeWord: !value.wholeWord })}
          />
          <Toggle
            label="选集"
            title="在选区中搜索"
            active={value.inSelection}
            onClick={() => onChange({ inSelection: !value.inSelection })}
          />
        </div>
        <label className="find-bar__field">
          <span>Find:</span>
          <input
            ref={findRef}
            value={value.query}
            onChange={(e) => onChange({ query: e.target.value })}
            onKeyDown={onFindKey}
            spellCheck={false}
            aria-label="查找内容"
          />
        </label>
        <div className="find-bar__actions">
          <button type="submit">Find</button>
          <button type="button" onClick={() => onReplace()}>
            Replace
          </button>
          <button
            type="button"
            className="find-bar__close"
            title="关闭"
            aria-label="关闭查找"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </div>
      <div className="find-bar__row">
        <div className="find-bar__toggles" role="group" aria-label="替换选项">
          <Toggle
            label="AB"
            title="保留大小写"
            active={value.preserveCase}
            onClick={() => onChange({ preserveCase: !value.preserveCase })}
          />
        </div>
        <label className="find-bar__field">
          <span>Replace:</span>
          <input
            value={value.replace}
            onChange={(e) => onChange({ replace: e.target.value })}
            onKeyDown={onReplaceKey}
            spellCheck={false}
            aria-label="替换内容"
          />
        </label>
        <div className="find-bar__actions">
          <button type="button" onClick={() => onFindAll()}>
            Find All
          </button>
          <button type="button" onClick={() => onReplaceAll()}>
            Replace All
          </button>
          {status ? <span className="find-bar__status">{status}</span> : null}
        </div>
      </div>
    </form>
  );
}
