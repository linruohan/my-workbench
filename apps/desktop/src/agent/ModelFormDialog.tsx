import { useEffect, useId, useState } from "react";
import type { ModelAbility, ModelCaps, ModelInputKind } from "@wb/domain";
import { IconClose, IconPlus } from "../shell/icons";

export type ModelFormValues = {
  modelId: string;
  caps: ModelCaps;
};

type Draft = {
  smart: boolean;
  modelId: string;
  context: string;
  output: string;
  advanced: boolean;
  image: boolean;
  video: boolean;
  pdf: boolean;
  structured: boolean;
  web: boolean;
  system: boolean;
  levels: string[];
  reasoningMap: string;
};

const EMPTY: Draft = {
  smart: true,
  modelId: "",
  context: "",
  output: "",
  advanced: true,
  image: false,
  video: false,
  pdf: false,
  structured: false,
  web: false,
  system: false,
  levels: [],
  reasoningMap: "",
};

type Props = {
  title: string;
  initialModelId?: string;
  initialCaps?: ModelCaps;
  lockModelId?: boolean;
  onCancel: () => void;
  onSave: (values: ModelFormValues) => string | null;
};

export function ModelFormDialog({
  title,
  initialModelId = "",
  initialCaps,
  lockModelId = false,
  onCancel,
  onSave,
}: Props) {
  const titleId = useId();
  const modelFieldId = useId();
  const [draft, setDraft] = useState<Draft>(() => fromCaps(initialModelId, initialCaps));
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const reset = () => {
    setDraft(fromCaps(initialModelId, initialCaps));
    setError("");
  };

  const save = () => {
    const parsed = parseDraft(draft);
    if (typeof parsed === "string") {
      setError(parsed);
      return;
    }
    const rejected = onSave(parsed);
    if (rejected) setError(rejected);
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal model-form"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onCancel}>
            <IconClose size={16} />
          </button>
        </header>

        <div className="model-form__body">
          <div className="model-form__switch-row">
            <span className="model-form__label">
              智能配置
              <Hint
                label="智能配置说明"
                text="开启后使用默认上下文 8192、最大输出 2048。关闭后手动填写。"
              />
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={draft.smart}
              aria-label="智能配置"
              className={draft.smart ? "toggle is-on" : "toggle"}
              onClick={() =>
                setDraft((current) => ({ ...current, smart: !current.smart }))
              }
            >
              <span className="toggle__thumb" />
            </button>
          </div>

          <label className="model-form__field" htmlFor={modelFieldId}>
            <span className="model-form__label">模型 ID</span>
            <input
              id={modelFieldId}
              className="settings__input"
              aria-label="模型 ID"
              placeholder="模型 ID"
              value={draft.modelId}
              disabled={lockModelId}
              autoFocus
              onChange={(event) =>
                setDraft((current) => ({ ...current, modelId: event.target.value }))
              }
            />
          </label>

          <label className="model-form__field">
            <span className="model-form__label">
              上下文窗口
              <Hint label="上下文窗口说明" text="模型一次能读入的 token 上限。" />
            </span>
            <input
              className="settings__input"
              aria-label="上下文窗口"
              inputMode="numeric"
              placeholder="8192"
              disabled={draft.smart}
              value={draft.smart ? "" : draft.context}
              onChange={(event) =>
                setDraft((current) => ({ ...current, context: event.target.value }))
              }
            />
          </label>

          <label className="model-form__field">
            <span className="model-form__label">
              最大输出 Token
              <Hint label="最大输出说明" text="单次回复允许的 token 上限。" />
            </span>
            <input
              className="settings__input"
              aria-label="最大输出 Token"
              inputMode="numeric"
              placeholder="2048"
              disabled={draft.smart}
              value={draft.smart ? "" : draft.output}
              onChange={(event) =>
                setDraft((current) => ({ ...current, output: event.target.value }))
              }
            />
          </label>

          <button
            type="button"
            className="model-form__advanced"
            aria-expanded={draft.advanced}
            onClick={() =>
              setDraft((current) => ({ ...current, advanced: !current.advanced }))
            }
          >
            <span
              className={
                draft.advanced ? "model-form__chevron is-open" : "model-form__chevron"
              }
            >
              ›
            </span>
            高级配置
          </button>

          {draft.advanced ? (
            <div className="model-form__advanced-body">
              <div className="model-form__field">
                <span className="model-form__label">
                  输入类型
                  <Hint
                    label="输入类型说明"
                    text="文本始终可用。其余类型记在模型上，供以后调用时参考。"
                  />
                </span>
                <div className="model-form__chips">
                  <Chip label="文本" checked locked />
                  <Chip
                    label="图片"
                    checked={draft.image}
                    onClick={() =>
                      setDraft((current) => ({ ...current, image: !current.image }))
                    }
                  />
                  <Chip
                    label="视频"
                    checked={draft.video}
                    onClick={() =>
                      setDraft((current) => ({ ...current, video: !current.video }))
                    }
                  />
                  <Chip
                    label="PDF"
                    checked={draft.pdf}
                    onClick={() =>
                      setDraft((current) => ({ ...current, pdf: !current.pdf }))
                    }
                  />
                </div>
              </div>

              <div className="model-form__field">
                <span className="model-form__label">
                  模型能力
                  <Hint
                    label="模型能力说明"
                    text="勾选后记在模型上。当前请求仍按所选 API 格式发送。"
                  />
                </span>
                <div className="model-form__chips">
                  <Chip
                    label="结构化输出"
                    checked={draft.structured}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        structured: !current.structured,
                      }))
                    }
                  />
                  <Chip
                    label="原生联网搜索"
                    checked={draft.web}
                    onClick={() =>
                      setDraft((current) => ({ ...current, web: !current.web }))
                    }
                  />
                  <Chip
                    label="对话中系统消息"
                    checked={draft.system}
                    onClick={() =>
                      setDraft((current) => ({ ...current, system: !current.system }))
                    }
                  />
                </div>
              </div>

              <div className="model-form__field">
                <span className="model-form__label">
                  推理等级（从低到高）
                  <Hint
                    label="推理等级说明"
                    text="从上到下是从低到高。名称会随模型保存。"
                  />
                </span>
                {draft.levels.map((level, index) => (
                  <div key={index} className="model-form__level">
                    <input
                      className="settings__input"
                      aria-label={`推理等级 ${index + 1}`}
                      placeholder="例如 low"
                      value={level}
                      onChange={(event) =>
                        setDraft((current) => {
                          const levels = [...current.levels];
                          levels[index] = event.target.value;
                          return { ...current, levels };
                        })
                      }
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`移除推理等级 ${index + 1}`}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          levels: current.levels.filter((_, item) => item !== index),
                        }))
                      }
                    >
                      <IconClose size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="model-form__add-level"
                  aria-label="添加推理等级"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      levels: [...current.levels, ""],
                    }))
                  }
                >
                  <IconPlus size={14} />
                </button>
              </div>

              <label className="model-form__field">
                <span className="model-form__label">
                  推理参数映射
                  <Hint
                    label="推理参数映射说明"
                    text="把推理等级写成请求参数，例如 low=reasoning_effort:low。"
                  />
                </span>
                <textarea
                  className="model-form__map"
                  aria-label="推理参数映射"
                  value={draft.reasoningMap}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      reasoningMap: event.target.value,
                    }))
                  }
                />
              </label>
            </div>
          ) : null}

          {error ? <p className="model-form__error">{error}</p> : null}
        </div>

        <footer className="model-form__footer">
          <button type="button" className="model-form__reset" onClick={reset}>
            重置表单
          </button>
          <div className="model-form__actions">
            <button type="button" className="btn" onClick={onCancel}>
              取消
            </button>
            <button type="button" className="btn btn--primary" onClick={save}>
              保存
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function fromCaps(modelId: string, caps?: ModelCaps): Draft {
  if (!caps) return { ...EMPTY, modelId };
  return {
    smart: Boolean(caps.smart),
    modelId,
    context: caps.smart ? "" : String(caps.context),
    output: caps.smart ? "" : String(caps.output),
    advanced: true,
    image: caps.inputs?.includes("image") ?? false,
    video: caps.inputs?.includes("video") ?? false,
    pdf: caps.inputs?.includes("pdf") ?? false,
    structured: caps.abilities?.includes("structured") ?? false,
    web: caps.abilities?.includes("web") ?? false,
    system: caps.abilities?.includes("system") ?? false,
    levels: [...(caps.reasoningLevels ?? [])],
    reasoningMap: caps.reasoningMap ?? "",
  };
}

function parseDraft(draft: Draft): ModelFormValues | string {
  const modelId = draft.modelId.trim();
  if (!modelId) return "请填写模型 ID。";
  if (modelId.includes("/")) return "模型 ID 不能包含 /。";
  let context = 8192;
  let output = 2048;
  if (!draft.smart) {
    context = Number(draft.context);
    output = Number(draft.output);
    if (
      !Number.isFinite(context) ||
      context <= 0 ||
      !Number.isFinite(output) ||
      output <= 0
    ) {
      return "请填写大于 0 的上下文窗口和最大输出 Token。";
    }
  }
  const inputs: ModelInputKind[] = [];
  if (draft.image) inputs.push("image");
  if (draft.video) inputs.push("video");
  if (draft.pdf) inputs.push("pdf");
  const abilities: ModelAbility[] = [];
  if (draft.structured) abilities.push("structured");
  if (draft.web) abilities.push("web");
  if (draft.system) abilities.push("system");
  const levels = draft.levels.map((level) => level.trim()).filter(Boolean);
  const caps: ModelCaps = {
    context: Math.floor(context),
    output: Math.floor(output),
    smart: draft.smart,
    inputs,
    abilities,
    reasoningLevels: levels,
    reasoningMap: draft.reasoningMap.trim(),
  };
  return { modelId, caps };
}

function Hint({ label, text }: { label: string; text: string }) {
  return (
    <button type="button" className="model-form__hint" aria-label={label} title={text}>
      ?
    </button>
  );
}

function Chip({
  label,
  checked,
  locked = false,
  onClick,
}: {
  label: string;
  checked: boolean;
  locked?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={checked ? "model-form__chip is-on" : "model-form__chip"}
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={locked}
      onClick={onClick}
    >
      <span
        className={checked ? "model-form__box is-on" : "model-form__box"}
        aria-hidden
      />
      {label}
      {locked ? <LockIcon /> : null}
    </button>
  );
}

function LockIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
