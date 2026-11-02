import { useEffect, useMemo, useState } from "react";
import {
  BUILTIN_MODEL_REF,
  BUILTIN_PROVIDER_ID,
  type ProviderConfig,
  type ProviderKind,
} from "@wb/domain";
import { useDialog } from "../shell/Dialogs";
import { IconMore, IconPencil, IconPlus, IconRefresh } from "../shell/icons";
import {
  credentialExists,
  deleteCredential,
  readCredential,
  writeCredential,
} from "./credentials";
import {
  PROVIDER_TEMPLATES,
  addModel,
  addProvider,
  addProviderFromTemplate,
  providerKindLabel,
  readProviderStore,
  removeModel,
  removeProvider,
  setDefaultModel,
  setProviderEnabled,
  updateModel,
  updateProvider,
  type ProviderTemplate,
} from "./providers";

export function ModelsPane() {
  const dialog = useDialog();
  const [version, setVersion] = useState(0);
  const store = readProviderStore();
  void version;
  const providers = store.providers;
  const builtin = providers.find((item) => item.id === BUILTIN_PROVIDER_ID) ?? null;
  const customs = providers.filter((item) => item.id !== BUILTIN_PROVIDER_ID);
  const [selectedId, setSelectedId] = useState<string>(
    customs[0]?.id ?? builtin?.id ?? BUILTIN_PROVIDER_ID,
  );
  const [adding, setAdding] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const selected =
    providers.find((item) => item.id === selectedId) ??
    customs[0] ??
    builtin ??
    null;

  useEffect(() => {
    if (!selected) return;
    if (providers.some((item) => item.id === selectedId)) return;
    setSelectedId(customs[0]?.id ?? builtin?.id ?? BUILTIN_PROVIDER_ID);
  }, [providers, selected, selectedId, customs, builtin]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".agent-models__more")) return;
      setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const refresh = () => setVersion((value) => value + 1);

  const createFromTemplate = (template: ProviderTemplate) => {
    const provider = addProviderFromTemplate(template.id);
    if (!provider) return;
    setAdding(false);
    setSelectedId(provider.id);
    refresh();
  };

  const createBlank = () => {
    const provider = addProvider({
      name: "新供应商",
      kind: "openai-chat-completions",
      baseURL: "https://api.example.com/v1",
      modelId: "",
      apiKeyRequired: true,
    });
    setAdding(false);
    setSelectedId(provider.id);
    refresh();
  };

  return (
    <section className="settings__pane agent-models">
      <header className="agent-models__head">
        <div>
          <h1 className="settings__title">模型设置</h1>
          <p className="agent-models__lead">
            管理自定义模型供应商，配置后可在聊天时选择使用。
          </p>
        </div>
        <div className="agent-models__head-actions">
          <button
            type="button"
            className="agent-models__icon-btn"
            title="刷新"
            aria-label="刷新模型配置"
            onClick={refresh}
          >
            <IconRefresh size={15} />
          </button>
          <button
            type="button"
            className="primary agent-models__add-btn"
            onClick={() => setAdding(true)}
          >
            <IconPlus size={14} />
            添加供应商
          </button>
        </div>
      </header>

      <div className="agent-models__layout">
        <aside className="agent-models__nav" aria-label="模型供应商">
          {builtin ? (
            <div className="agent-models__nav-group">
              <div className="agent-models__nav-label">本机</div>
              <ProviderNavButton
                provider={builtin}
                active={selected?.id === builtin.id && !adding}
                onSelect={() => {
                  setAdding(false);
                  setSelectedId(builtin.id);
                }}
              />
            </div>
          ) : null}
          <div className="agent-models__nav-group">
            <div className="agent-models__nav-label">自定义供应商</div>
            {customs.length === 0 ? (
              <p className="agent-models__nav-empty">还没有自定义供应商</p>
            ) : (
              customs.map((provider) => (
                <ProviderNavButton
                  key={provider.id}
                  provider={provider}
                  active={selected?.id === provider.id && !adding}
                  onSelect={() => {
                    setAdding(false);
                    setSelectedId(provider.id);
                  }}
                />
              ))
            )}
          </div>
        </aside>

        <div className="agent-models__detail">
          {adding ? (
            <AddProviderPanel
              onCancel={() => setAdding(false)}
              onPickTemplate={createFromTemplate}
              onBlank={createBlank}
            />
          ) : selected?.kind === "builtin" ? (
            <BuiltinDetail
              defaultModelRef={store.defaultModelRef}
              onSetDefault={() => {
                setDefaultModel(BUILTIN_MODEL_REF);
                refresh();
              }}
            />
          ) : selected ? (
            <ProviderDetail
              key={selected.id}
              provider={selected}
              defaultModelRef={store.defaultModelRef}
              menuOpen={menuOpen}
              onMenuOpenChange={setMenuOpen}
              onRefresh={refresh}
              onRename={async () => {
                setMenuOpen(false);
                const next = await dialog.prompt({
                  title: "重命名供应商",
                  label: "名称",
                  initialValue: selected.name,
                });
                if (!next?.trim()) return;
                updateProvider(selected.id, { name: next.trim() });
                refresh();
              }}
              onDelete={async () => {
                setMenuOpen(false);
                const ok = await dialog.confirm({
                  title: "删除供应商",
                  message: `删除供应商「${selected.name}」？本机密钥会一起删除。`,
                  confirmLabel: "删除",
                  danger: true,
                });
                if (!ok) return;
                removeProvider(selected.id);
                deleteCredential(selected.id);
                setSelectedId(BUILTIN_PROVIDER_ID);
                refresh();
              }}
            />
          ) : (
            <p className="agent-models__hint">选择左侧供应商，或添加一个新的。</p>
          )}
        </div>
      </div>
    </section>
  );
}

function ProviderNavButton({
  provider,
  active,
  onSelect,
}: {
  provider: ProviderConfig;
  active: boolean;
  onSelect: () => void;
}) {
  const ready =
    provider.kind === "builtin" ||
    (provider.enabled &&
      Object.keys(provider.models).length > 0 &&
      (!provider.apiKeyRequired || credentialExists(provider.id)));
  return (
    <button
      type="button"
      className={active ? "agent-models__nav-item is-active" : "agent-models__nav-item"}
      onClick={onSelect}
    >
      <span className="agent-models__nav-name">{provider.name}</span>
      <span
        className={
          ready ? "agent-models__dot is-ready" : "agent-models__dot is-warn"
        }
        title={ready ? "可用" : "待完善"}
        aria-hidden="true"
      />
    </button>
  );
}

function AddProviderPanel({
  onCancel,
  onPickTemplate,
  onBlank,
}: {
  onCancel: () => void;
  onPickTemplate: (template: ProviderTemplate) => void;
  onBlank: () => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, ProviderTemplate[]>();
    for (const template of PROVIDER_TEMPLATES) {
      const list = map.get(template.group) ?? [];
      list.push(template);
      map.set(template.group, list);
    }
    return [...map.entries()];
  }, []);

  return (
    <div className="agent-models__card">
      <div className="agent-models__card-head">
        <div>
          <h2 className="agent-models__card-title">添加供应商</h2>
          <p className="agent-models__card-desc">从目录选择模板，或创建空白自定义端点。</p>
        </div>
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
      {groups.map(([group, templates]) => (
        <div key={group} className="agent-models__template-group">
          <div className="agent-models__nav-label">{group}</div>
          <div className="agent-models__template-grid">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                className="agent-models__template"
                onClick={() =>
                  template.id === "custom" ? onBlank() : onPickTemplate(template)
                }
              >
                <strong>{template.name}</strong>
                <span>{providerKindLabel(template.kind)}</span>
                <small>{template.baseURL}</small>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function BuiltinDetail({
  defaultModelRef,
  onSetDefault,
}: {
  defaultModelRef: string;
  onSetDefault: () => void;
}) {
  const isDefault = defaultModelRef === BUILTIN_MODEL_REF;
  return (
    <div className="agent-models__card">
      <div className="agent-models__card-head">
        <div>
          <h2 className="agent-models__card-title">本机工作台</h2>
          <p className="agent-models__card-desc">
            离线理解常用指令，不调用外部 API，也不需要密钥。
          </p>
        </div>
        <span className="settings__pill">内置</span>
      </div>
      <div className="agent-models__field">
        <span>状态</span>
        <span className="agent-models__field-value">始终可用</span>
      </div>
      <div className="agent-models__models-head">
        <h3>模型列表</h3>
      </div>
      <ul className="agent-models__models">
        <li className="agent-models__model">
          <div>
            <strong>local</strong>
            <small>上下文 8192 · 输出 2048</small>
          </div>
          {isDefault ? (
            <span className="settings__pill">默认</span>
          ) : (
            <button type="button" className="btn" onClick={onSetDefault}>
              设为默认
            </button>
          )}
        </li>
      </ul>
    </div>
  );
}

function ProviderDetail({
  provider,
  defaultModelRef,
  menuOpen,
  onMenuOpenChange,
  onRefresh,
  onRename,
  onDelete,
}: {
  provider: ProviderConfig;
  defaultModelRef: string;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onRefresh: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const dialog = useDialog();
  const [baseURL, setBaseURL] = useState(provider.baseURL);
  const [kind, setKind] = useState<Exclude<ProviderKind, "builtin">>(
    provider.kind === "anthropic-messages"
      ? "anthropic-messages"
      : "openai-chat-completions",
  );
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [apiKeyRequired, setApiKeyRequired] = useState(provider.apiKeyRequired);
  const [modelDraft, setModelDraft] = useState("");
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [contextDraft, setContextDraft] = useState("8192");
  const [outputDraft, setOutputDraft] = useState("2048");
  const hasKey = credentialExists(provider.id);
  const models = Object.entries(provider.models);

  useEffect(() => {
    setBaseURL(provider.baseURL);
    setKind(
      provider.kind === "anthropic-messages"
        ? "anthropic-messages"
        : "openai-chat-completions",
    );
    setApiKeyRequired(provider.apiKeyRequired);
    setApiKey("");
    setShowKey(false);
    setEditingModel(null);
  }, [provider.id, provider.baseURL, provider.kind, provider.apiKeyRequired]);

  const saveConnection = () => {
    updateProvider(provider.id, {
      baseURL,
      kind,
      apiKeyRequired,
    });
    if (apiKey.trim() || showKey) writeCredential(provider.id, apiKey);
    onRefresh();
  };

  const beginEditModel = (modelId: string) => {
    const caps = provider.models[modelId];
    if (!caps) return;
    setEditingModel(modelId);
    setContextDraft(String(caps.context));
    setOutputDraft(String(caps.output));
  };

  return (
    <div className="agent-models__card">
      <div className="agent-models__card-head">
        <div className="agent-models__card-title-row">
          <h2 className="agent-models__card-title">{provider.name}</h2>
          <button
            type="button"
            role="switch"
            aria-checked={provider.enabled}
            aria-label="启用供应商"
            className={provider.enabled ? "toggle is-on" : "toggle"}
            onClick={() => {
              setProviderEnabled(provider.id, !provider.enabled);
              onRefresh();
            }}
          >
            <span className="toggle__thumb" />
          </button>
          <div className="agent-models__more">
            <button
              type="button"
              className="agent-models__icon-btn"
              aria-label="更多"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => onMenuOpenChange(!menuOpen)}
            >
              <IconMore size={16} />
            </button>
            {menuOpen ? (
              <div className="agent__thread-menu agent-models__menu" role="menu">
                <button type="button" role="menuitem" onClick={onRename}>
                  <IconPencil size={14} />
                  重命名
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="is-danger"
                  onClick={onDelete}
                >
                  删除
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <label className="agent-models__field">
        <span>Base URL</span>
        <input
          className="settings__input"
          aria-label="Base URL"
          value={baseURL}
          placeholder="https://api.example.com/v1"
          onChange={(event) => setBaseURL(event.target.value)}
          onBlur={saveConnection}
        />
      </label>

      <label className="agent-models__field">
        <span>API 格式</span>
        <select
          className="settings__select"
          aria-label="API 格式"
          value={kind}
          onChange={(event) => {
            const next = event.target.value as Exclude<ProviderKind, "builtin">;
            setKind(next);
            setApiKeyRequired(next === "anthropic-messages" ? true : apiKeyRequired);
            updateProvider(provider.id, {
              kind: next,
              apiKeyRequired: next === "anthropic-messages" ? true : apiKeyRequired,
            });
            onRefresh();
          }}
        >
          <option value="openai-chat-completions">
            Chat Completions (/chat/completions)
          </option>
          <option value="anthropic-messages">Anthropic Messages</option>
        </select>
      </label>

      <label className="agent-models__field">
        <span>API Key</span>
        <div className="agent-models__key-row">
          <input
            className="settings__input settings__input--grow"
            aria-label="API Key"
            type={showKey ? "text" : "password"}
            autoComplete="off"
            value={apiKey}
            placeholder={hasKey ? "已保存，输入新密钥可覆盖" : "输入 API Key"}
            onChange={(event) => setApiKey(event.target.value)}
            onBlur={saveConnection}
          />
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (!showKey && hasKey && !apiKey) {
                setApiKey(readCredential(provider.id) ?? "");
              }
              setShowKey((value) => !value);
            }}
          >
            {showKey ? "隐藏" : "显示"}
          </button>
        </div>
      </label>

      <label className="agent-models__check">
        <input
          type="checkbox"
          checked={apiKeyRequired}
          onChange={(event) => {
            setApiKeyRequired(event.target.checked);
            updateProvider(provider.id, { apiKeyRequired: event.target.checked });
            onRefresh();
          }}
        />
        调用前必须有密钥
      </label>

      <div className="agent-models__models-head">
        <h3>模型列表</h3>
        <form
          className="agent-models__model-add"
          onSubmit={(event) => {
            event.preventDefault();
            const ref = addModel(provider.id, modelDraft);
            if (!ref) return;
            setModelDraft("");
            onRefresh();
          }}
        >
          <input
            className="settings__input"
            aria-label="新模型 ID"
            placeholder="模型 ID"
            value={modelDraft}
            onChange={(event) => setModelDraft(event.target.value)}
          />
          <button type="submit" className="btn" disabled={!modelDraft.trim()}>
            <IconPlus size={14} />
            添加模型
          </button>
        </form>
      </div>

      {models.length === 0 ? (
        <div className="agent-models__empty">
          当前没有配置模型，添加模型后可在聊天中使用。
        </div>
      ) : (
        <ul className="agent-models__models">
          {models.map(([modelId, caps]) => {
            const ref = `${provider.id}/${modelId}`;
            const isDefault = defaultModelRef === ref;
            const editing = editingModel === modelId;
            return (
              <li key={modelId} className="agent-models__model">
                {editing ? (
                  <div className="agent-models__model-edit">
                    <strong>{modelId}</strong>
                    <label>
                      上下文
                      <input
                        className="settings__input"
                        inputMode="numeric"
                        value={contextDraft}
                        onChange={(event) => setContextDraft(event.target.value)}
                      />
                    </label>
                    <label>
                      最大输出
                      <input
                        className="settings__input"
                        inputMode="numeric"
                        value={outputDraft}
                        onChange={(event) => setOutputDraft(event.target.value)}
                      />
                    </label>
                    <div className="agent-models__model-edit-actions">
                      <button
                        type="button"
                        className="primary"
                        onClick={() => {
                          updateModel(provider.id, modelId, {
                            context: Number(contextDraft),
                            output: Number(outputDraft),
                          });
                          setEditingModel(null);
                          onRefresh();
                        }}
                      >
                        保存
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setEditingModel(null)}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div>
                      <strong>{modelId}</strong>
                      <small>
                        上下文 {caps.context} · 输出 {caps.output}
                      </small>
                    </div>
                    <div className="agent-models__model-actions">
                      {isDefault ? (
                        <span className="settings__pill">默认</span>
                      ) : (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            setDefaultModel(ref);
                            onRefresh();
                          }}
                        >
                          设为默认
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn"
                        onClick={() => beginEditModel(modelId)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={models.length <= 1}
                        onClick={() => {
                          void (async () => {
                            const ok = await dialog.confirm({
                              title: "删除模型",
                              message: `从「${provider.name}」删除模型 ${modelId}？`,
                              confirmLabel: "删除",
                              danger: true,
                            });
                            if (!ok) return;
                            removeModel(provider.id, modelId);
                            onRefresh();
                          })();
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
