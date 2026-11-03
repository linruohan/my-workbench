import { useEffect, useMemo, useRef, useState } from "react";
import { parseModelRef } from "@wb/domain";
import { credentialExists } from "./credentials";
import { modelGroups } from "./providers";

type Props = {
  modelRef: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (modelRef: string) => void;
  onOpenSettings: () => void;
};

type ModelChoice = {
  ref: string;
  id: string;
  providerId: string;
  providerName: string;
  kind: string;
  label: string;
  missingKey: boolean;
};

/** Compact composer model picker — flat list of configured models only. */
export function ModelMenu({
  modelRef,
  open,
  onOpenChange,
  onSelect,
  onOpenSettings,
}: Props) {
  const [version, setVersion] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const choices = useMemo<ModelChoice[]>(() => {
    const groups = modelGroups();
    const multi = groups.filter((group) => group.models.length > 0).length > 1;
    return groups.flatMap((group) => {
      const missingKey = group.kind !== "builtin" && !credentialExists(group.id);
      return group.models.map((model) => ({
        ref: model.ref,
        id: model.id,
        providerId: group.id,
        providerName: group.name,
        kind: group.kind,
        missingKey,
        label:
          group.kind === "builtin"
            ? group.name
            : multi
              ? `${group.name} · ${model.id}`
              : model.id,
      }));
    });
  }, [version]);
  const current =
    choices.find((item) => item.ref === modelRef) ??
    choices.find((item) => {
      const parsed = parseModelRef(modelRef);
      return (
        parsed != null &&
        item.providerId === parsed.providerId &&
        item.id === parsed.modelId
      );
    }) ??
    null;
  const missingKey = Boolean(current?.missingKey);
  const triggerLabel = current?.label ?? (choices.length ? "选择模型" : "未配置模型");
  const openRef = useRef(open);
  const onOpenChangeRef = useRef(onOpenChange);
  openRef.current = open;
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onOpenChange]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "m") {
        return;
      }
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      event.preventDefault();
      onOpenChangeRef.current(!openRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="agent__model" ref={rootRef}>
      <button
        type="button"
        className="agent__model-trigger"
        aria-label="会话模型"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="选择模型（Ctrl+M）"
        onClick={() => {
          setVersion((value) => value + 1);
          onOpenChange(!open);
        }}
      >
        <span>{triggerLabel}</span>
        {missingKey ? <small>未填密钥</small> : null}
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div
          className="agent__model-menu agent__model-menu--simple"
          role="listbox"
          aria-label="选择模型"
        >
          {choices.length === 0 ? (
            <div className="agent__model-empty">
              <p>还没有可用模型</p>
              <p>请先到设置里配置 Providers</p>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  onOpenChange(false);
                  onOpenSettings();
                }}
              >
                去设置
              </button>
            </div>
          ) : (
            <ul className="agent__model-flat" aria-label="模型列表">
              {choices.map((model) => {
                const active = model.ref === modelRef;
                return (
                  <li key={model.ref}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={active ? "is-active" : undefined}
                      onClick={() => {
                        onSelect(model.ref);
                        onOpenChange(false);
                      }}
                    >
                      <span className="agent__model-option-main">
                        <span>{model.label}</span>
                        {model.missingKey ? <small>未填密钥</small> : null}
                      </span>
                      {active ? <span aria-hidden="true">✓</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
