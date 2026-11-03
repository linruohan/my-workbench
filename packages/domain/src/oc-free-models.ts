import { BUILTIN_PROVIDER_ID, type ModelCaps, type ProviderConfig } from "./agent.js";

/** Public catalog OpenCode itself reads. The free set changes without an app update. */
export const OC_FREE_MODELS_URL = "https://models.dev/api.json";

export const LOCAL_BUILTIN_MODEL_ID = "local";

const DEFAULT_OC_ENDPOINT = "https://opencode.ai/inference/openai/v1";

export interface OcFreeModel {
  id: string;
  name: string;
  context: number;
  output: number;
  image: boolean;
  /** OpenAI-compatible base URL, without `/chat/completions`. */
  endpoint: string;
}

/**
 * Free means every price dimension is zero. A name containing "free" is not enough,
 * and a missing price is not free. Deprecated models and models that cannot emit
 * text are left out. Same rule as OC Ferry's provider filter.
 */
export function selectOcFreeModels(payload: unknown): OcFreeModel[] {
  const root = asRecord(payload);
  if (!root) return [];
  const ferry = Array.isArray(root.all) ? root.all : null;
  if (ferry) {
    const provider = ferry.map(asRecord).find((item) => item?.id === "opencode");
    if (!provider) return [];
    return listModels(asRecord(provider.models), DEFAULT_OC_ENDPOINT);
  }
  const opencode = asRecord(root.opencode);
  if (!opencode) return [];
  const fallback =
    typeof opencode.api === "string" && opencode.api.trim()
      ? opencode.api.trim()
      : DEFAULT_OC_ENDPOINT;
  return listModels(asRecord(opencode.models), fallback);
}

/** Keep the offline local model and replace the previous free catalog. */
export function mergeBuiltinModels(
  models: Record<string, ModelCaps>,
  found: readonly OcFreeModel[],
): Record<string, ModelCaps> {
  const local = models[LOCAL_BUILTIN_MODEL_ID] ?? { context: 8192, output: 2048 };
  const next: Record<string, ModelCaps> = {
    [LOCAL_BUILTIN_MODEL_ID]: {
      context: local.context,
      output: local.output,
    },
  };
  for (const model of found) {
    if (model.id === LOCAL_BUILTIN_MODEL_ID) continue;
    next[model.id] = {
      context: model.context,
      output: model.output,
      title: model.name,
      endpoint: model.endpoint,
      ...(model.image ? { inputs: ["image"] as const } : {}),
    };
  }
  return next;
}

/** Builtin models with a catalog endpoint talk to that OpenAI-compatible API. */
export function chatProviderFor(
  provider: ProviderConfig,
  modelId: string,
): ProviderConfig {
  const endpoint = provider.models[modelId]?.endpoint?.trim();
  if (provider.kind !== "builtin" || !endpoint) return provider;
  return {
    ...provider,
    kind: "openai-chat-completions",
    baseURL: endpoint,
    apiKeyRequired: true,
  };
}

export function isLocalBuiltin(provider: ProviderConfig, modelId: string): boolean {
  return (
    provider.kind === "builtin" &&
    provider.id === BUILTIN_PROVIDER_ID &&
    !provider.models[modelId]?.endpoint
  );
}

function listModels(
  models: Record<string, unknown> | null,
  fallbackEndpoint: string,
): OcFreeModel[] {
  if (!models) return [];
  const found: OcFreeModel[] = [];
  for (const [id, value] of Object.entries(models)) {
    const model = asRecord(value);
    if (!model || !usableId(id) || model.status === "deprecated") continue;
    if (!zeroCost(model.cost) || !allowsText(model)) continue;
    const endpoint = httpBase(endpointOf(model, fallbackEndpoint));
    if (!endpoint) continue;
    const limit = asRecord(model.limit);
    found.push({
      id,
      name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : id,
      context: positive(limit?.context, 8192),
      output: positive(limit?.output, 2048),
      image: acceptsImage(model),
      endpoint,
    });
  }
  found.sort((a, b) => a.id.localeCompare(b.id));
  return found;
}

function usableId(id: string): boolean {
  return id.length > 0 && !id.includes("/") && !/[\u0000-\u001f]/.test(id);
}

function zeroCost(cost: unknown): boolean {
  const price = asRecord(cost);
  if (!price || price.input !== 0 || price.output !== 0) return false;
  const cache = asRecord(price.cache);
  const read = price.cache_read ?? cache?.read ?? 0;
  const write = price.cache_write ?? cache?.write ?? 0;
  return read === 0 && write === 0;
}

function allowsText(model: Record<string, unknown>): boolean {
  const capabilities = asRecord(model.capabilities);
  const outputCaps = asRecord(capabilities?.output);
  if (outputCaps?.text === false) return false;
  const modalities = asRecord(model.modalities);
  const output = modalities?.output;
  if (Array.isArray(output) && !output.includes("text")) return false;
  return true;
}

function acceptsImage(model: Record<string, unknown>): boolean {
  const capabilities = asRecord(model.capabilities);
  const inputCaps = asRecord(capabilities?.input);
  if (inputCaps?.image === true) return true;
  const modalities = asRecord(model.modalities);
  return Array.isArray(modalities?.input) && modalities.input.includes("image");
}

function endpointOf(model: Record<string, unknown>, fallback: string): string {
  const provider = asRecord(model.provider);
  const api = typeof provider?.api === "string" ? provider.api.trim() : "";
  return api || fallback;
}

function httpBase(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
