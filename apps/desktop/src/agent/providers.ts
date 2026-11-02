import {
  BUILTIN_MODEL_REF,
  BUILTIN_PROVIDER_ID,
  builtinProvider,
  createId,
  type ModelCaps,
  type ProviderConfig,
  type ProviderKind,
} from "@wb/domain";

const KEY = "wb.providers.v1";

export type ProviderStore = {
  providers: ProviderConfig[];
  defaultModelRef: string;
};

export type ProviderTemplate = {
  id: string;
  name: string;
  group: "本机" | "常用" | "其他";
  kind: Exclude<ProviderKind, "builtin">;
  baseURL: string;
  modelId: string;
  apiKeyRequired: boolean;
  docsUrl?: string;
};

/** Starter templates inspired by ZCode's provider directory (no OAuth plans). */
export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: "ollama",
    name: "Ollama",
    group: "本机",
    kind: "openai-chat-completions",
    baseURL: "http://127.0.0.1:11434/v1",
    modelId: "llama3.1",
    apiKeyRequired: false,
  },
  {
    id: "openai",
    name: "OpenAI",
    group: "常用",
    kind: "openai-chat-completions",
    baseURL: "https://api.openai.com/v1",
    modelId: "gpt-4.1",
    apiKeyRequired: true,
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    group: "常用",
    kind: "openai-chat-completions",
    baseURL: "https://api.deepseek.com/v1",
    modelId: "deepseek-chat",
    apiKeyRequired: true,
    docsUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "zhipu",
    name: "智谱",
    group: "常用",
    kind: "openai-chat-completions",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    modelId: "glm-4.5",
    apiKeyRequired: true,
    docsUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    group: "其他",
    kind: "anthropic-messages",
    baseURL: "https://api.anthropic.com",
    modelId: "claude-sonnet-4-5",
    apiKeyRequired: true,
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "custom",
    name: "自定义端点",
    group: "其他",
    kind: "openai-chat-completions",
    baseURL: "https://api.example.com/v1",
    modelId: "my-model",
    apiKeyRequired: true,
  },
];

export function readProviderStore(): ProviderStore {
  const fallback: ProviderStore = {
    providers: [builtinProvider()],
    defaultModelRef: BUILTIN_MODEL_REF,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ProviderStore>;
    const providers = Array.isArray(parsed.providers)
      ? parsed.providers.filter(isProvider)
      : [];
    if (!providers.some((item) => item.id === BUILTIN_PROVIDER_ID)) {
      providers.unshift(builtinProvider());
    }
    const defaultModelRef =
      typeof parsed.defaultModelRef === "string" && parsed.defaultModelRef.includes("/")
        ? parsed.defaultModelRef
        : BUILTIN_MODEL_REF;
    return { providers, defaultModelRef };
  } catch {
    return fallback;
  }
}

export function writeProviderStore(store: ProviderStore): void {
  const providers = store.providers.map(stripSecrets);
  if (!providers.some((item) => item.id === BUILTIN_PROVIDER_ID)) {
    providers.unshift(builtinProvider());
  }
  localStorage.setItem(
    KEY,
    JSON.stringify({ providers, defaultModelRef: store.defaultModelRef }),
  );
}

export function addProvider(input: {
  name: string;
  kind: Exclude<ProviderKind, "builtin">;
  baseURL: string;
  modelId: string;
  apiKeyRequired: boolean;
}): ProviderConfig {
  const store = readProviderStore();
  const modelId = input.modelId.trim();
  const models: ProviderConfig["models"] = {};
  if (modelId && !modelId.includes("/")) {
    models[modelId] = { context: 8192, output: 2048 };
  }
  const provider: ProviderConfig = {
    id: `custom:${createId()}`,
    name: input.name.trim() || "新供应商",
    kind: input.kind,
    baseURL: input.baseURL.trim().replace(/\/+$/, ""),
    apiKeyRequired: input.apiKeyRequired,
    enabled: true,
    models,
  };
  store.providers.push(provider);
  writeProviderStore(store);
  return provider;
}

export function addProviderFromTemplate(templateId: string): ProviderConfig | null {
  const template = PROVIDER_TEMPLATES.find((item) => item.id === templateId);
  if (!template) return null;
  return addProvider({
    name: template.name,
    kind: template.kind,
    baseURL: template.baseURL,
    modelId: template.modelId,
    apiKeyRequired: template.apiKeyRequired,
  });
}

export function updateProvider(
  id: string,
  patch: {
    name?: string;
    baseURL?: string;
    apiKeyRequired?: boolean;
    kind?: Exclude<ProviderKind, "builtin">;
    enabled?: boolean;
  },
): boolean {
  if (id === BUILTIN_PROVIDER_ID) return false;
  const store = readProviderStore();
  const provider = store.providers.find((item) => item.id === id);
  if (!provider || provider.kind === "builtin") return false;
  if (patch.name != null) {
    const name = patch.name.trim();
    if (name) provider.name = name;
  }
  if (patch.baseURL != null) provider.baseURL = patch.baseURL.trim().replace(/\/+$/, "");
  if (patch.apiKeyRequired != null) provider.apiKeyRequired = patch.apiKeyRequired;
  if (patch.kind != null) provider.kind = patch.kind;
  if (patch.enabled != null) provider.enabled = patch.enabled;
  writeProviderStore(store);
  return true;
}

export function setProviderEnabled(id: string, enabled: boolean): boolean {
  if (id === BUILTIN_PROVIDER_ID) return false;
  return updateProvider(id, { enabled });
}

export function removeProvider(id: string): void {
  if (id === BUILTIN_PROVIDER_ID) return;
  const store = readProviderStore();
  store.providers = store.providers.filter((item) => item.id !== id);
  if (!store.providers.some((item) => store.defaultModelRef.startsWith(`${item.id}/`))) {
    store.defaultModelRef = BUILTIN_MODEL_REF;
  }
  writeProviderStore(store);
}

export function addModel(
  providerId: string,
  modelId: string,
  caps: Partial<ModelCaps> = {},
): string | null {
  const id = modelId.trim();
  if (!id || id.includes("/") || providerId === BUILTIN_PROVIDER_ID) return null;
  const store = readProviderStore();
  const provider = store.providers.find((item) => item.id === providerId);
  if (!provider || provider.kind === "builtin") return null;
  if (!provider.models[id]) {
    provider.models = {
      ...provider.models,
      [id]: modelCapsFrom(caps),
    };
  }
  writeProviderStore(store);
  return `${provider.id}/${id}`;
}

export function updateModel(
  providerId: string,
  modelId: string,
  patch: Partial<ModelCaps>,
): boolean {
  if (providerId === BUILTIN_PROVIDER_ID) return false;
  const store = readProviderStore();
  const provider = store.providers.find((item) => item.id === providerId);
  if (!provider || provider.kind === "builtin") return false;
  const current = provider.models[modelId];
  if (!current) return false;
  provider.models = {
    ...provider.models,
    [modelId]: modelCapsFrom({ ...current, ...patch }),
  };
  writeProviderStore(store);
  return true;
}

function modelCapsFrom(caps: Partial<ModelCaps>): ModelCaps {
  const next: ModelCaps = {
    context: positiveInt(caps.context, 8192),
    output: positiveInt(caps.output, 2048),
  };
  if (caps.smart) next.smart = true;
  if (caps.inputs?.length) next.inputs = [...caps.inputs];
  if (caps.abilities?.length) next.abilities = [...caps.abilities];
  const levels = caps.reasoningLevels?.map((level) => level.trim()).filter(Boolean);
  if (levels?.length) next.reasoningLevels = levels;
  const map = caps.reasoningMap?.trim();
  if (map) next.reasoningMap = map;
  return next;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

export function removeModel(providerId: string, modelId: string): boolean {
  if (providerId === BUILTIN_PROVIDER_ID) return false;
  const store = readProviderStore();
  const provider = store.providers.find((item) => item.id === providerId);
  if (!provider || provider.kind === "builtin") return false;
  if (!(modelId in provider.models)) return false;
  if (Object.keys(provider.models).length <= 1) return false;
  const next = { ...provider.models };
  delete next[modelId];
  provider.models = next;
  const ref = `${providerId}/${modelId}`;
  if (store.defaultModelRef === ref) {
    const first = Object.keys(next)[0];
    store.defaultModelRef = first ? `${providerId}/${first}` : BUILTIN_MODEL_REF;
  }
  writeProviderStore(store);
  return true;
}

export const API_FORMATS: Array<{
  kind: Exclude<ProviderKind, "builtin">;
  label: string;
}> = [
  { kind: "anthropic-messages", label: "Anthropic Messages (/v1/messages)" },
  { kind: "openai-chat-completions", label: "Chat Completions (/chat/completions)" },
  { kind: "openai-responses", label: "Responses (/responses)" },
];

export function providerKindLabel(kind: ProviderKind): string {
  if (kind === "builtin") return "本机";
  return API_FORMATS.find((item) => item.kind === kind)?.label ?? API_FORMATS[1]!.label;
}

export type ModelGroup = {
  id: string;
  name: string;
  kind: ProviderKind;
  models: Array<{ id: string; ref: string }>;
};

export function modelGroups(store: ProviderStore = readProviderStore()): ModelGroup[] {
  return store.providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      models: Object.keys(provider.models).map((id) => ({
        id,
        ref: `${provider.id}/${id}`,
      })),
    }));
}

export function setDefaultModel(modelRef: string): void {
  const store = readProviderStore();
  store.defaultModelRef = modelRef;
  writeProviderStore(store);
}

export function modelChoices(store: ProviderStore = readProviderStore()): Array<{
  ref: string;
  label: string;
}> {
  const choices: Array<{ ref: string; label: string }> = [];
  for (const provider of store.providers) {
    if (!provider.enabled) continue;
    for (const modelId of Object.keys(provider.models)) {
      choices.push({
        ref: `${provider.id}/${modelId}`,
        label:
          provider.kind === "builtin" ? provider.name : `${provider.name} · ${modelId}`,
      });
    }
  }
  return choices;
}

function stripSecrets(provider: ProviderConfig): ProviderConfig {
  const copy = { ...provider };
  delete (copy as { apiKey?: unknown }).apiKey;
  return copy;
}

function isProvider(value: unknown): value is ProviderConfig {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ProviderConfig>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    (item.kind === "builtin" ||
      item.kind === "openai-chat-completions" ||
      item.kind === "openai-responses" ||
      item.kind === "anthropic-messages") &&
    typeof item.baseURL === "string" &&
    typeof item.enabled === "boolean" &&
    !!item.models &&
    typeof item.models === "object"
  );
}
