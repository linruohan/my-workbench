import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  BUILTIN_MODEL_REF,
  BUILTIN_PROVIDER_ID,
  parseModelRef,
  type ProviderKind,
} from "@wb/domain";
import { useDialog } from "../shell/Dialogs";
import { credentialExists, deleteCredential, writeCredential } from "./credentials";
import {
  addModel,
  addProvider,
  modelGroups,
  readProviderStore,
  removeProvider,
  setDefaultModel,
  updateProvider,
} from "./providers";

type Props = {
  modelRef: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (modelRef: string) => void;
  onOpenSettings: () => void;
};

export function ModelMenu({
  modelRef,
  open,
  onOpenChange,
  onSelect,
  onOpenSettings,
}: Props) {
  const dialog = useDialog();
  const [version, setVersion] = useState(0);
  const [configuring, setConfiguring] = useState<false | "add" | "edit">(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const parsed = parseModelRef(modelRef);
  const groups = useMemo(() => modelGroups(), [version]);
  const currentGroup =
    groups.find((group) => group.id === parsed?.providerId) ?? groups[0] ?? null;
  const [browseId, setBrowseId] = useState(currentGroup?.id ?? "");
  const browse = groups.find((group) => group.id === browseId) ?? currentGroup;
  const selectedId =
    currentGroup?.models.find((model) => model.ref === modelRef)?.id ??
    parsed?.modelId ??
    "";
  const editing = configuring === "edit" ? providerDraft(browse?.id) : null;
  const missingKey =
    currentGroup != null &&
    currentGroup.kind !== "builtin" &&
    !credentialExists(currentGroup.id);
  const triggerLabel = currentGroup
    ? currentGroup.kind === "builtin"
      ? currentGroup.name
      : `${currentGroup.name} · ${selectedId}`
    : modelRef;
  const isDefault = readProviderStore().defaultModelRef === modelRef;
  const openRef = useRef(open);
  const onOpenChangeRef = useRef(onOpenChange);
  openRef.current = open;
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    if (open) return;
    setConfiguring(false);
  }, [open]);

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
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "m") return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      event.preventDefault();
      onOpenChangeRef.current(!openRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const choose = (ref: string) => {
    onSelect(ref);
    onOpenChange(false);
  };

  return (
    <div className="agent__model" ref={rootRef}>
      <button
        type="button"
        className="agent__model-trigger"
        aria-label="会话模型"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="选择模型和提供商（Ctrl+M）"
        onClick={() => {
          setBrowseId(currentGroup?.id ?? "");
          setConfiguring(false);
          onOpenChange(!open);
        }}
      >
        <span>{triggerLabel}</span>
        {missingKey ? <small>未填密钥</small> : null}
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="agent__model-menu" role="dialog" aria-label="选择模型">
          {configuring === "add" || editing ? (
            <ProviderForm
              existing={editing}
              onCancel={() => setConfiguring(false)}
              onAdded={(ref, providerId) => {
                setVersion((value) => value + 1);
                setBrowseId(providerId);
                onSelect(ref);
                onOpenChange(false);
              }}
              onSaved={() => {
                setVersion((value) => value + 1);
                onOpenChange(false);
              }}
            />
          ) : (
            <>
              <div
                className={
                  groups.length > 1 ? "agent__model-cols" : "agent__model-cols is-single"
                }
              >
                {groups.length > 1 ? (
                  <ul aria-label="提供商">
                    {groups.map((group) => (
                      <li key={group.id}>
                        <button
                          type="button"
                          className={group.id === browse?.id ? "is-active" : undefined}
                          aria-pressed={group.id === browse?.id}
                          onClick={() => {
                            setBrowseId(group.id);
                            if (group.id === parsed?.providerId) return;
                            const first = group.models[0];
                            if (first) onSelect(first.ref);
                          }}
                        >
                          <span>{group.name}</span>
                          <small>
                            {kindLabel(group.kind)}
                            {group.kind !== "builtin" && !credentialExists(group.id)
                              ? " · 未填密钥"
                              : ""}
                          </small>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <ul aria-label="模型">
                  {(browse?.models ?? []).map((model) => (
                    <li key={model.ref}>
                      <button
                        type="button"
                        className={model.ref === modelRef ? "is-active" : undefined}
                        aria-pressed={model.ref === modelRef}
                        onClick={() => choose(model.ref)}
                      >
                        <span>{model.id === "local" ? "本机工作台" : model.id}</span>
                        {model.ref === modelRef ? (
                          <span aria-hidden="true">✓</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              {browse && browse.kind !== "builtin" ? (
                <ModelAppender
                  providerId={browse.id}
                  hasKey={credentialExists(browse.id)}
                  onAdded={(ref) => {
                    setVersion((value) => value + 1);
                    choose(ref);
                  }}
                />
              ) : null}
              <div className="agent__model-foot">
                {isDefault ? (
                  <span className="agent__model-note">已是新会话默认</span>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setDefaultModel(modelRef);
                      setVersion((value) => value + 1);
                    }}
                  >
                    设为默认
                  </button>
                )}
                {browse && browse.kind !== "builtin" ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      void (async () => {
                        const ok = await dialog.confirm({
                          title: "移除提供商",
                          message: `移除提供商「${browse.name}」？本机密钥会一起删除。`,
                          confirmLabel: "移除",
                          danger: true,
                        });
                        if (!ok) return;
                        const current = parsed?.providerId === browse.id;
                        removeProvider(browse.id);
                        deleteCredential(browse.id);
                        setVersion((value) => value + 1);
                        setBrowseId(BUILTIN_PROVIDER_ID);
                        if (current) onSelect(BUILTIN_MODEL_REF);
                      })();
                    }}
                  >
                    移除
                  </button>
                ) : null}
              </div>
              <div className="agent__model-foot">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setConfiguring("add")}
                >
                  配置提供商
                </button>
                {browse && browse.kind !== "builtin" ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setConfiguring("edit")}
                  >
                    编辑
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    onOpenChange(false);
                    onOpenSettings();
                  }}
                >
                  打开设置
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ModelAppender({
  providerId,
  hasKey,
  onAdded,
}: {
  providerId: string;
  hasKey: boolean;
  onAdded: (ref: string) => void;
}) {
  const [modelId, setModelId] = useState("");
  const add = () => {
    const ref = addModel(providerId, modelId);
    if (!ref) return;
    setModelId("");
    onAdded(ref);
  };
  return (
    <div className="agent__model-append">
      <p>{hasKey ? "密钥已保存在本机。" : "还没有密钥，远程调用会失败。"}</p>
      <div className="agent__model-append-row">
        <input
          aria-label="追加模型 ID"
          value={modelId}
          placeholder="再加一个模型 ID"
          onChange={(event) => setModelId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            event.stopPropagation();
            add();
          }}
        />
        <button type="button" className="btn" onClick={add}>
          添加
        </button>
      </div>
    </div>
  );
}

function providerDraft(id: string | undefined): ProviderDraft | null {
  if (!id) return null;
  const provider = readProviderStore().providers.find((item) => item.id === id);
  if (!provider || provider.kind === "builtin") return null;
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseURL: provider.baseURL,
    apiKeyRequired: provider.apiKeyRequired,
    hasKey: credentialExists(provider.id),
  };
}

type ProviderDraft = {
  id: string;
  name: string;
  kind: Exclude<ProviderKind, "builtin">;
  baseURL: string;
  apiKeyRequired: boolean;
  hasKey: boolean;
};

function ProviderForm({
  existing,
  onCancel,
  onAdded,
  onSaved,
}: {
  existing: ProviderDraft | null;
  onCancel: () => void;
  onAdded: (ref: string, providerId: string) => void;
  onSaved: () => void;
}) {
  const formId = useId();
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<Exclude<ProviderKind, "builtin">>(
    existing?.kind ?? "openai-chat-completions",
  );
  const [baseURL, setBaseURL] = useState(
    existing?.baseURL || "http://127.0.0.1:11434/v1",
  );
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyRequired, setApiKeyRequired] = useState(existing?.apiKeyRequired ?? false);
  const [error, setError] = useState("");

  const save = () => {
    if (existing) {
      const ok = updateProvider(existing.id, { name, baseURL, apiKeyRequired });
      if (!ok) {
        setError("提供商没有保存。");
        return;
      }
      if (apiKey.trim()) writeCredential(existing.id, apiKey);
      onSaved();
      return;
    }
    if (!modelId.trim() || modelId.includes("/")) {
      setError("请填写不含 / 的模型 ID。");
      return;
    }
    const provider = addProvider({ name, kind, baseURL, modelId, apiKeyRequired });
    if (apiKey.trim()) writeCredential(provider.id, apiKey);
    const ref = `${provider.id}/${modelId.trim()}`;
    const stored = readProviderStore().providers.some((item) => item.id === provider.id);
    if (!stored) {
      setError("提供商没有保存。");
      return;
    }
    onAdded(ref, provider.id);
  };

  return (
    <div
      className="agent__model-form"
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.target instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        event.stopPropagation();
        save();
      }}
    >
      <strong>{existing ? "编辑提供商" : "配置提供商"}</strong>
      <label htmlFor={`${formId}-name`}>
        名称
        <input
          id={`${formId}-name`}
          aria-label="提供商名称"
          value={name}
          placeholder="Ollama"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label htmlFor={`${formId}-kind`}>
        协议
        <select
          id={`${formId}-kind`}
          aria-label="提供商协议"
          value={kind}
          disabled={Boolean(existing)}
          onChange={(event) => {
            const next = event.target.value as Exclude<ProviderKind, "builtin">;
            setKind(next);
            setApiKeyRequired(next === "anthropic-messages");
            setBaseURL(
              next === "anthropic-messages"
                ? "https://api.anthropic.com"
                : "http://127.0.0.1:11434/v1",
            );
          }}
        >
          <option value="openai-chat-completions">OpenAI 兼容</option>
          <option value="anthropic-messages">Anthropic Messages</option>
        </select>
      </label>
      <label htmlFor={`${formId}-url`}>
        Base URL
        <input
          id={`${formId}-url`}
          aria-label="提供商 Base URL"
          value={baseURL}
          onChange={(event) => setBaseURL(event.target.value)}
        />
      </label>
      {existing ? null : (
        <label htmlFor={`${formId}-model`}>
          模型 ID
          <input
            id={`${formId}-model`}
            aria-label="新模型 ID"
            value={modelId}
            placeholder="llama3.1"
            onChange={(event) => setModelId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.stopPropagation();
              save();
            }}
          />
        </label>
      )}
      <label htmlFor={`${formId}-key`}>
        API 密钥
        <input
          id={`${formId}-key`}
          aria-label="提供商 API 密钥"
          type="password"
          autoComplete="off"
          value={apiKey}
          placeholder={
            existing?.hasKey
              ? "留空则保持原密钥"
              : apiKeyRequired
                ? "必填，仅保存在本机"
                : "可选，仅保存在本机"
          }
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      <label className="agent__model-check">
        <input
          type="checkbox"
          checked={apiKeyRequired}
          onChange={(event) => setApiKeyRequired(event.target.checked)}
        />
        调用前必须有密钥
      </label>
      {error ? <p className="agent__error">{error}</p> : null}
      <div className="agent__model-foot">
        <button type="button" className="btn" onClick={onCancel}>
          返回
        </button>
        <button type="button" className="primary" onClick={save}>
          {existing ? "保存" : "保存并使用"}
        </button>
      </div>
    </div>
  );
}

function kindLabel(kind: ProviderKind): string {
  if (kind === "builtin") return "本机";
  if (kind === "anthropic-messages") return "Anthropic";
  return "OpenAI 兼容";
}
