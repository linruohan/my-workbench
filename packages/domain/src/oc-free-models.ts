import { BUILTIN_PROVIDER_ID, type ModelCaps, type ProviderConfig } from "./agent.js";

/** Public catalog OpenCode itself reads. The free set changes without an app update. */
export const OC_FREE_MODELS_URL = "https://models.dev/api.json";

export const LOCAL_BUILTIN_MODEL_ID = "local";

const DEFAULT_OC_ENDPOINT = "https://opencode.ai/inference/openai/v1";

/** OpenCode's own default provider key. A saved key replaces it. */
export const OC_DEFAULT_API_KEY = "public";

const OC_PROMPT_LIMIT = 20_000;

export function resolveOcApiKey(stored: string | null | undefined): string {
  const key = stored?.trim();
  return key || OC_DEFAULT_API_KEY;
}

/** One prompt for `opencode run`. Keeps the tail when the transcript is long. */
export function buildOcRunPrompt(input: {
  system: string;
  messages: ReadonlyArray<{ role: string; content: string }>;
}): string {
  const lines: string[] = [];
  const system = input.system.trim();
  if (system) lines.push(system);
  for (const message of input.messages) {
    const content = message.content.trim();
    if (!content) continue;
    const role =
      message.role === "assistant" || message.role === "tool" ? message.role : "user";
    lines.push(`${role}: ${content}`);
  }
  const text = lines.join("\n\n").trim();
  if (text.length <= OC_PROMPT_LIMIT) return text;
  return text.slice(text.length - OC_PROMPT_LIMIT);
}

/**
 * Read `opencode run --format json`. A text part wins. Otherwise surface the
 * error line OpenCode printed.
 */
export function readOcRunOutput(
  stdout: string,
): { ok: true; text: string } | { ok: false; message: string } {
  let text = "";
  let error = "";
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(row);
    if (!record) continue;
    if (record.type === "error") {
      const nested = asRecord(record.error);
      const message = typeof nested?.message === "string" ? nested.message.trim() : "";
      if (message) error = message;
    }
    if (record.type === "text") {
      const part = asRecord(record.part);
      const chunk =
        typeof part?.text === "string"
          ? part.text
          : typeof record.text === "string"
            ? record.text
            : "";
      text += chunk;
    }
  }
  const reply = text.trim();
  if (reply) return { ok: true, text: reply };
  if (error) return { ok: false, message: error };
  return { ok: false, message: "OpenCode 没有返回内容" };
}

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
  if (
    Array.isArray(root.data) &&
    root.data.some((item) => typeof asRecord(item)?.providerID === "string")
  ) {
    const models: Record<string, unknown> = {};
    for (const item of root.data) {
      const model = asRecord(item);
      if (!model) continue;
      const provider =
        typeof model.providerID === "string" ? model.providerID : "opencode";
      if (provider !== "opencode") continue;
      const id = typeof model.id === "string" ? model.id : "";
      if (!id) continue;
      models[id] = model;
    }
    return listModels(models, DEFAULT_OC_ENDPOINT);
  }
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
  if (Array.isArray(cost))
    return cost.length > 0 && cost.every((item) => zeroPrice(item));
  return zeroPrice(cost);
}

function zeroPrice(cost: unknown): boolean {
  const price = asRecord(cost);
  if (!price || price.input !== 0 || price.output !== 0) return false;
  const cache = asRecord(price.cache);
  const read = price.cache_read ?? cache?.read ?? 0;
  const write = price.cache_write ?? cache?.write ?? 0;
  return read === 0 && write === 0;
}

function allowsText(model: Record<string, unknown>): boolean {
  const capabilities = asRecord(model.capabilities);
  const outputCaps = capabilities?.output;
  if (outputCaps === false) return false;
  if (Array.isArray(outputCaps)) {
    if (!outputCaps.includes("text")) return false;
  } else if (asRecord(outputCaps)?.text === false) {
    return false;
  }
  const modalities = asRecord(model.modalities);
  const output = modalities?.output;
  if (Array.isArray(output) && !output.includes("text")) return false;
  return true;
}

function acceptsImage(model: Record<string, unknown>): boolean {
  const capabilities = asRecord(model.capabilities);
  const inputCaps = capabilities?.input;
  if (Array.isArray(inputCaps) && inputCaps.includes("image")) return true;
  if (asRecord(inputCaps)?.image === true) return true;
  const modalities = asRecord(model.modalities);
  return Array.isArray(modalities?.input) && modalities.input.includes("image");
}

function endpointOf(model: Record<string, unknown>, fallback: string): string {
  const settings = asRecord(model.settings);
  const base = typeof settings?.baseURL === "string" ? settings.baseURL.trim() : "";
  if (base) return base;
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
