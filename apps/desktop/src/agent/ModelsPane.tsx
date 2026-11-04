import { useEffect, useMemo, useRef, useState } from "react";
import { BUILTIN_PROVIDER_ID, type ProviderConfig, type ProviderKind } from "@wb/domain";
import { ModelFormDialog, type ModelFormValues } from "./ModelFormDialog";
import { useDialog } from "../shell/Dialogs";
import { IconMore, IconPencil, IconPlus, IconRefresh, IconUnplug } from "../shell/icons";
import { testModelConnectivity } from "./connectivity";
import { fetchAvailableModels } from "./models-list";
import { recognizeLocalImage } from "./ocr-engine";
import { ensurePaddleOcr } from "./ocr-models";
import { refreshOcFreeModels } from "./oc-models";
import {
  credentialExists,
  deleteCredential,
  readCredential,
  writeCredential,
} from "./credentials";
import {
  API_FORMATS,
  PROVIDER_TEMPLATES,
  addModel,
  addProvider,
  mergeDiscoveredModels,
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
    providers.find((item) => item.id === selectedId) ?? customs[0] ?? builtin ?? null;

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
              provider={selected}
              defaultModelRef={store.defaultModelRef}
              onRefresh={refresh}
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
        className={ready ? "agent-models__dot is-ready" : "agent-models__dot is-warn"}
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
          <p className="agent-models__card-desc">
            从目录选择模板，或创建空白自定义端点。
          </p>
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

function editableKind(kind: ProviderKind): Exclude<ProviderKind, "builtin"> {
  return kind === "builtin" ? "openai-chat-completions" : kind;
}

function BuiltinDetail({
  provider,
  defaultModelRef,
  onRefresh,
}: {
  provider: ProviderConfig;
  defaultModelRef: string;
  onRefresh: () => void;
}) {
  const [catalog, setCatalog] = useState<null | { pending: boolean; message: string }>(
    null,
  );
  const [probes, setProbes] = useState<
    Record<string, { pending: boolean; ok: boolean; message: string }>
  >({});
  const models = Object.entries(provider.models);

  useEffect(() => {
    let live = true;
    void refreshOcFreeModels()
      .then(() => {
        if (live) onRefresh();
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // Load the catalog once when this provider card opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadCatalog = () => {
    if (catalog?.pending) return;
    setCatalog({ pending: true, message: "正在获取 OpenCode 免费模型" });
    void refreshOcFreeModels()
      .then((count) => {
        onRefresh();
        setCatalog({ pending: false, message: `获取到 ${count} 个免费模型` });
      })
      .catch((error: unknown) => {
        setCatalog({
          pending: false,
          message: error instanceof Error ? error.message : "没有获取到免费模型",
        });
      });
  };

  return (
    <div className="agent-models__card">
      <div className="agent-models__card-head">
        <div>
          <h2 className="agent-models__card-title">本机工作台</h2>
          <p className="agent-models__card-desc">
            local 离线理解常用指令。其余模型从 OpenCode 目录按价格动态筛出，由本机
            OpenCode 的默认配置调用，不需要另填密钥。
          </p>
        </div>
        <span className="settings__pill">内置</span>
      </div>
      <div className="agent-models__models-head">
        <h3>模型列表</h3>
        <button
          type="button"
          className="btn"
          disabled={catalog?.pending}
          onClick={loadCatalog}
        >
          <IconRefresh size={14} />
          获取免费模型
        </button>
      </div>
      {catalog ? (
        <p className={catalog.pending ? "agent-models__probe" : "agent-models__probe"}>
          {catalog.message}
        </p>
      ) : null}
      <ul className="agent-models__models">
        {models.map(([modelId, caps]) => {
          const ref = `${provider.id}/${modelId}`;
          const isDefault = defaultModelRef === ref;
          const probe = probes[modelId];
          return (
            <li key={modelId} className="agent-models__model">
              <div className="agent-models__model-main">
                <strong>{caps.title || modelId}</strong>
                <small>
                  {modelId === "local" ? "离线指令 · " : ""}
                  上下文 {caps.context} · 输出 {caps.output}
                </small>
                {probe ? (
                  <small
                    className={
                      probe.ok
                        ? "agent-models__probe is-ok"
                        : "agent-models__probe is-bad"
                    }
                  >
                    {probe.message}
                  </small>
                ) : null}
              </div>
              <div className="agent-models__model-actions">
                {caps.endpoint ? (
                  <button
                    type="button"
                    className="agent-models__icon-btn"
                    aria-label={`测试模型 ${modelId}`}
                    title="测试模型"
                    disabled={probe?.pending}
                    onClick={() => {
                      setProbes((current) => ({
                        ...current,
                        [modelId]: {
                          pending: true,
                          ok: false,
                          message: `正在测试 ${provider.name} / ${caps.title || modelId}`,
                        },
                      }));
                      void testModelConnectivity({
                        provider,
                        modelId,
                        apiKey: null,
                      }).then((result) => {
                        const ok = result.success === true;
                        setProbes((current) => ({
                          ...current,
                          [modelId]: {
                            pending: false,
                            ok,
                            message: ok
                              ? `${provider.name} / ${caps.title || modelId} 连接成功`
                              : `${provider.name} / ${caps.title || modelId} 连接失败：${
                                  result.success === false ? result.error.message : ""
                                }`,
                          },
                        }));
                      });
                    }}
                  >
                    <IconUnplug size={14} />
                  </button>
                ) : null}
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
              </div>
            </li>
          );
        })}
      </ul>
      <LocalOcrModel />
    </div>
  );
}

function LocalOcrModel() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("正在准备识图模型");
  const [ready, setReady] = useState(false);
  const [probe, setProbe] = useState<null | {
    pending: boolean;
    ok: boolean;
    message: string;
  }>(null);

  useEffect(() => {
    let live = true;
    void ensurePaddleOcr().then((result) => {
      if (!live) return;
      if (result.ok === true) {
        setReady(true);
        setStatus("已就绪");
        return;
      }
      setReady(false);
      setStatus(result.message);
    });
    return () => {
      live = false;
    };
  }, []);

  const debugImage = (file: File | undefined) => {
    if (!file || probe?.pending) return;
    setProbe({ pending: true, ok: false, message: "正在识图" });
    void recognizeLocalImage(file).then((result) => {
      if (result.ok === true) {
        const text = result.lines.join("\n").trim();
        setReady(true);
        setStatus("已就绪");
        setProbe({
          pending: false,
          ok: true,
          message: text ? `识别到：${text}` : "没有识别到文字",
        });
        return;
      }
      setProbe({ pending: false, ok: false, message: result.message });
    });
  };

  return (
    <div className="agent-models__local">
      <div className="agent-models__models-head">
        <h3>本地模型</h3>
      </div>
      <ul className="agent-models__models">
        <li className="agent-models__model">
          <div className="agent-models__model-main">
            <strong>PP-OCRv6 small</strong>
            <small>本地识图。对话模型看不到图片时，用它识别文字。</small>
            <small
              className={ready ? "agent-models__probe is-ok" : "agent-models__probe"}
            >
              {status}
            </small>
            {probe && !probe.pending ? (
              <small
                className={
                  probe.ok ? "agent-models__probe is-ok" : "agent-models__probe is-bad"
                }
              >
                {probe.message}
              </small>
            ) : probe?.pending ? (
              <small className="agent-models__probe">{probe.message}</small>
            ) : null}
          </div>
          <div className="agent-models__model-actions">
            <button
              type="button"
              className="btn"
              disabled={probe?.pending}
              onClick={() => inputRef.current?.click()}
            >
              调试
            </button>
            <input
              ref={inputRef}
              className="sr-only"
              type="file"
              accept="image/*"
              aria-label="调试识图"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                debugImage(file);
              }}
            />
          </div>
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
    editableKind(provider.kind),
  );
  const [formatOpen, setFormatOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [apiKeyRequired, setApiKeyRequired] = useState(provider.apiKeyRequired);
  const [modelForm, setModelForm] = useState<null | { modelId: string | null }>(null);
  const [probes, setProbes] = useState<
    Record<string, { pending: boolean; ok: boolean; message: string }>
  >({});
  const [catalog, setCatalog] = useState<null | {
    pending: boolean;
    ok: boolean;
    message: string;
  }>(null);
  const hasKey = credentialExists(provider.id);
  const models = Object.entries(provider.models);

  useEffect(() => {
    setBaseURL(provider.baseURL);
    setKind(editableKind(provider.kind));
    setFormatOpen(false);
    setApiKeyRequired(provider.apiKeyRequired);
    setApiKey("");
    setShowKey(false);
    setModelForm(null);
    setProbes({});
    setCatalog(null);
  }, [provider.id]);

  useEffect(() => {
    if (!formatOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".agent-models__format")) return;
      setFormatOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFormatOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [formatOpen]);

  const chooseFormat = (next: Exclude<ProviderKind, "builtin">) => {
    setKind(next);
    setFormatOpen(false);
    const nextKeyRequired = next === "anthropic-messages" ? true : apiKeyRequired;
    setApiKeyRequired(nextKeyRequired);
    updateProvider(provider.id, { kind: next, apiKeyRequired: nextKeyRequired });
    onRefresh();
  };

  const saveConnection = () => {
    updateProvider(provider.id, {
      baseURL,
      kind,
      apiKeyRequired,
    });
    if (apiKey.trim() || showKey) writeCredential(provider.id, apiKey);
    onRefresh();
  };

  const runProbe = (modelId: string) => {
    if (!provider.enabled || probes[modelId]?.pending) return;
    saveConnection();
    setProbes((current) => ({
      ...current,
      [modelId]: {
        pending: true,
        ok: false,
        message: `正在测试 ${provider.name} / ${modelId}`,
      },
    }));
    const latest = readProviderStore().providers.find((item) => item.id === provider.id);
    const target: ProviderConfig = {
      ...(latest ?? provider),
      baseURL,
      kind,
      apiKeyRequired,
      enabled: provider.enabled,
    };
    void testModelConnectivity({
      provider: target,
      modelId,
      apiKey: apiKey.trim() || readCredential(provider.id),
    }).then((result) => {
      const ok = result.success === true;
      const message =
        result.success === false
          ? `${provider.name} / ${modelId} 连接失败：${result.error.message}`
          : `${provider.name} / ${modelId} 连接成功`;
      setProbes((current) => ({
        ...current,
        [modelId]: { pending: false, ok, message },
      }));
    });
  };

  const runDiscover = () => {
    if (!provider.enabled || catalog?.pending) return;
    saveConnection();
    setCatalog({ pending: true, ok: false, message: "正在获取可用模型" });
    const latest = readProviderStore().providers.find((item) => item.id === provider.id);
    const target: ProviderConfig = {
      ...(latest ?? provider),
      baseURL,
      kind,
      apiKeyRequired,
      enabled: provider.enabled,
    };
    void fetchAvailableModels({
      provider: target,
      apiKey: apiKey.trim() || readCredential(provider.id),
    }).then((result) => {
      if (result.success === false) {
        setCatalog({ pending: false, ok: false, message: result.error.message });
        return;
      }
      const merged = mergeDiscoveredModels(provider.id, result.models);
      const listed = merged?.listed ?? result.models.length;
      const added = merged?.added ?? 0;
      onRefresh();
      setCatalog({
        pending: false,
        ok: true,
        message:
          added > 0
            ? `获取到 ${listed} 个模型，新增 ${added} 个`
            : `获取到 ${listed} 个模型，都已在列表中`,
      });
    });
  };

  const saveModel = (values: ModelFormValues): string | null => {
    const editing = modelForm?.modelId;
    if (editing) {
      if (!updateModel(provider.id, editing, values.caps)) return "没有这个模型。";
    } else if (provider.models[values.modelId]) {
      return "已经有这个模型。";
    } else if (!addModel(provider.id, values.modelId, values.caps)) {
      return "模型 ID 无效。";
    }
    setModelForm(null);
    onRefresh();
    return null;
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

      <div className="agent-models__field">
        <span id={`api-format-${provider.id}`}>API 格式</span>
        <div className="agent-models__format">
          <button
            type="button"
            className="agent-models__format-btn"
            aria-labelledby={`api-format-${provider.id}`}
            aria-haspopup="listbox"
            aria-expanded={formatOpen}
            onClick={() => setFormatOpen((open) => !open)}
          >
            {providerKindLabel(kind)}
          </button>
          {formatOpen ? (
            <ul
              className="agent-models__format-menu"
              role="listbox"
              aria-label="API 格式"
            >
              {API_FORMATS.map((item) => (
                <li key={item.kind}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={kind === item.kind}
                    className={kind === item.kind ? "is-active" : undefined}
                    onClick={() => chooseFormat(item.kind)}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

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
        <div className="agent-models__model-add">
          <button
            type="button"
            className="btn"
            disabled={!provider.enabled || catalog?.pending}
            title={provider.enabled ? "从供应商获取可用模型" : "请先启用供应商"}
            onClick={runDiscover}
          >
            {catalog?.pending ? (
              <IconRefresh size={14} className="agent-models__spin" />
            ) : null}
            获取模型
          </button>
          <button
            type="button"
            className="btn agent-models__add-btn"
            onClick={() => setModelForm({ modelId: null })}
          >
            <IconPlus size={14} />
            添加模型
          </button>
        </div>
      </div>
      {catalog ? (
        <p
          className={
            catalog.ok
              ? "agent-models__probe is-ok"
              : catalog.pending
                ? "agent-models__probe"
                : "agent-models__probe is-bad"
          }
        >
          {catalog.message}
        </p>
      ) : null}

      {models.length === 0 ? (
        <div className="agent-models__empty">
          当前没有配置模型，添加模型后可在聊天中使用。
        </div>
      ) : (
        <ul className="agent-models__models">
          {models.map(([modelId, caps]) => {
            const ref = `${provider.id}/${modelId}`;
            const isDefault = defaultModelRef === ref;
            return (
              <li key={modelId} className="agent-models__model">
                <div className="agent-models__model-main">
                  <strong>{modelId}</strong>
                  <small>
                    上下文 {caps.context} · 输出 {caps.output}
                  </small>
                  {probes[modelId] ? (
                    <span
                      className={
                        probes[modelId].pending
                          ? "agent-models__probe"
                          : probes[modelId].ok
                            ? "agent-models__probe is-ok"
                            : "agent-models__probe is-bad"
                      }
                    >
                      {probes[modelId].message}
                    </span>
                  ) : null}
                </div>
                <div className="agent-models__model-actions">
                  <button
                    type="button"
                    className="agent-models__icon-btn"
                    aria-label={`测试模型 ${modelId}`}
                    title={provider.enabled ? "测试模型" : "请先启用供应商"}
                    disabled={!provider.enabled || probes[modelId]?.pending}
                    onClick={() => runProbe(modelId)}
                  >
                    {probes[modelId]?.pending ? (
                      <IconRefresh size={14} className="agent-models__spin" />
                    ) : (
                      <IconUnplug size={14} />
                    )}
                  </button>
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
                    onClick={() => setModelForm({ modelId })}
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
              </li>
            );
          })}
        </ul>
      )}
      {modelForm ? (
        <ModelFormDialog
          title={modelForm.modelId ? "编辑模型" : "添加模型"}
          initialModelId={modelForm.modelId ?? ""}
          initialCaps={modelForm.modelId ? provider.models[modelForm.modelId] : undefined}
          lockModelId={Boolean(modelForm.modelId)}
          onCancel={() => setModelForm(null)}
          onSave={saveModel}
        />
      ) : null}
    </div>
  );
}
