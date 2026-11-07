import { useEffect, useMemo, useRef, useState } from "react";
import { parseModelRef } from "@wb/domain";
import { credentialExists } from "./credentials";
import { refreshDshFreeModels } from "./dsh-models";
import { refreshOcFreeModels } from "./oc-models";
import { modelGroups } from "./providers";

type Props = {
  modelRef: string;
  open: boolean;
  disabled?: boolean;
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
  title: string;
  missingKey: boolean;
};

type ModelSection = {
  providerId: string;
  providerName: string;
  missingKey: boolean;
  models: ModelChoice[];
};

/** Compact composer model picker — provider headers with model titles underneath. */
export function ModelMenu({
  modelRef,
  open,
  disabled = false,
  onOpenChange,
  onSelect,
  onOpenSettings,
}: Props) {
  const [version, setVersion] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const sections = useMemo<ModelSection[]>(() => {
    return modelGroups()
      .map((group) => {
        const missingKey =
          group.kind !== "builtin" && group.apiKeyRequired && !credentialExists(group.id);
        const models = group.models.map((model) => {
          const titled = model.title?.trim();
          return {
            ref: model.ref,
            id: model.id,
            providerId: group.id,
            providerName: group.name,
            kind: group.kind,
            missingKey,
            title:
              titled ||
              (group.kind === "builtin" && model.id === "local" ? "本地" : model.id),
          };
        });
        return {
          providerId: group.id,
          providerName: group.name,
          missingKey,
          models,
        };
      })
      .filter((section) => section.models.length > 0);
  }, [version]);
  const choices = useMemo(
    () => sections.flatMap((section) => section.models),
    [sections],
  );
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
  const triggerLabel = current?.title ?? (choices.length ? "选择模型" : "未配置模型");
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
      if (disabled) return;
      const target = event.target as HTMLElement | null;
      const inComposer = Boolean(target?.closest(".agent__composer, .agent__model"));
      const tag = target?.tagName;
      // Keep working while typing in the composer; skip other form fields.
      if (!inComposer && (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT")) {
        return;
      }
      event.preventDefault();
      onOpenChangeRef.current(!openRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled]);

  return (
    <div className="agent__model" ref={rootRef}>
      <button
        type="button"
        className="agent__model-trigger"
        aria-label="会话模型"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={
          disabled
            ? "请先处理待确认操作"
            : current
              ? `${current.providerName} · ${current.title}（Ctrl+M）`
              : "选择模型（Ctrl+M）"
        }
        onClick={() => {
          if (disabled) return;
          setVersion((value) => value + 1);
          const next = !open;
          onOpenChange(next);
          if (next) {
            void Promise.allSettled([refreshOcFreeModels(), refreshDshFreeModels()]).then(
              () => setVersion((value) => value + 1),
            );
          }
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
          {sections.length === 0 ? (
            <div className="agent__model-empty">
              <p>还没有可用模型</p>
              <p>请先到设置里配置供应商</p>
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
            <>
              <div className="agent__model-groups" aria-label="模型列表">
                {sections.map((section) => (
                  <section
                    key={section.providerId}
                    className="agent__model-section"
                    aria-label={section.providerName}
                  >
                    <div className="agent__model-section-label">
                      <span>{section.providerName}</span>
                      {section.missingKey ? <small>未填密钥</small> : null}
                    </div>
                    <ul>
                      {section.models.map((model) => {
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
                                <span>{model.title}</span>
                                {model.missingKey ? <small>未填密钥</small> : null}
                              </span>
                              {active ? <span aria-hidden="true">✓</span> : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
              <div className="agent__model-foot agent__model-foot--simple">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    onOpenChange(false);
                    onOpenSettings();
                  }}
                >
                  管理模型…
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
