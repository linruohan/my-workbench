import { useState } from "react";
import { BUILTIN_PROVIDER_ID, type ProviderKind } from "@wb/domain";
import { credentialExists, deleteCredential, writeCredential } from "./credentials";
import {
  addProvider,
  modelChoices,
  readProviderStore,
  removeProvider,
  setDefaultModel,
} from "./providers";

export function ModelsPane() {
  const [version, setVersion] = useState(0);
  const store = readProviderStore();
  void version;
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Exclude<ProviderKind, "builtin">>(
    "openai-chat-completions",
  );
  const [baseURL, setBaseURL] = useState("http://127.0.0.1:11434/v1");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyRequired, setApiKeyRequired] = useState(false);

  const refresh = () => setVersion((value) => value + 1);

  return (
    <section className="settings__pane">
      <header className="settings__pane-head">
        <h1 className="settings__title">模型</h1>
        <span className="settings__pill">密钥只在本机</span>
      </header>
      <p className="agent-models__lead">
        模型配置保存在本机。API 密钥单独存放，不会写入会话、工具参数或快照。
      </p>

      <div className="settings__card">
        <label className="settings__row">
          <div>
            <div className="settings__row-title">默认模型</div>
            <div className="settings__row-desc">
              新建会话时使用。已有会话可在 Agent 面板里单独切换。
            </div>
          </div>
          <select
            className="settings__input"
            aria-label="默认模型"
            value={store.defaultModelRef}
            onChange={(event) => {
              setDefaultModel(event.target.value);
              refresh();
            }}
          >
            {modelChoices(store).map((choice) => (
              <option key={choice.ref} value={choice.ref}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <h2 className="settings__subtitle">已配置</h2>
      <div className="settings__card">
        {store.providers.map((provider) => {
          const modelIdLabel = Object.keys(provider.models)[0] ?? "";
          return (
            <div key={provider.id} className="settings__row">
              <div>
                <div className="settings__row-title">{provider.name}</div>
                <div className="settings__row-desc">
                  {provider.kind === "builtin"
                    ? "离线理解常用指令"
                    : `${provider.kind} · ${provider.baseURL || "未填写地址"} · ${modelIdLabel}`}
                  {provider.kind !== "builtin" && credentialExists(provider.id)
                    ? " · 密钥已保存"
                    : ""}
                </div>
              </div>
              {provider.id === BUILTIN_PROVIDER_ID ? (
                <span className="settings__pill">内置</span>
              ) : (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    removeProvider(provider.id);
                    deleteCredential(provider.id);
                    refresh();
                  }}
                >
                  移除
                </button>
              )}
            </div>
          );
        })}
      </div>

      <h2 className="settings__subtitle">添加端点</h2>
      <form
        className="settings__card agent-models__form"
        onSubmit={(event) => {
          event.preventDefault();
          const provider = addProvider({
            name,
            kind,
            baseURL,
            modelId,
            apiKeyRequired,
          });
          if (apiKey.trim()) writeCredential(provider.id, apiKey);
          setName("");
          setModelId("");
          setApiKey("");
          refresh();
        }}
      >
        <label>
          名称
          <input
            className="settings__input"
            aria-label="模型名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ollama"
          />
        </label>
        <label>
          协议
          <select
            className="settings__input"
            aria-label="模型协议"
            value={kind}
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
        <label>
          Base URL
          <input
            className="settings__input"
            aria-label="模型 Base URL"
            value={baseURL}
            onChange={(event) => setBaseURL(event.target.value)}
          />
        </label>
        <label>
          模型 ID
          <input
            className="settings__input"
            aria-label="模型 ID"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder="llama3.1"
            required
          />
        </label>
        <label>
          API 密钥
          <input
            className="settings__input"
            aria-label="模型 API 密钥"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={apiKeyRequired ? "必填，仅保存在本机" : "可选"}
          />
        </label>
        <label className="agent-models__check">
          <input
            type="checkbox"
            checked={apiKeyRequired}
            onChange={(event) => setApiKeyRequired(event.target.checked)}
          />
          调用前必须有密钥
        </label>
        <button type="submit" className="primary">
          添加
        </button>
      </form>
    </section>
  );
}
