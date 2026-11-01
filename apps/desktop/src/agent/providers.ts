import {
  BUILTIN_MODEL_REF,
  BUILTIN_PROVIDER_ID,
  builtinProvider,
  createId,
  type ProviderConfig,
  type ProviderKind,
} from "@wb/domain";

const KEY = "wb.providers.v1";

export type ProviderStore = {
  providers: ProviderConfig[];
  defaultModelRef: string;
};

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
  const provider: ProviderConfig = {
    id: `custom:${createId()}`,
    name: input.name.trim() || "自定义模型",
    kind: input.kind,
    baseURL: input.baseURL.trim().replace(/\/+$/, ""),
    apiKeyRequired: input.apiKeyRequired,
    enabled: true,
    models: { [modelId || "default"]: { context: 8192, output: 2048 } },
  };
  store.providers.push(provider);
  writeProviderStore(store);
  return provider;
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
      item.kind === "anthropic-messages") &&
    typeof item.baseURL === "string" &&
    typeof item.enabled === "boolean" &&
    !!item.models &&
    typeof item.models === "object"
  );
}
