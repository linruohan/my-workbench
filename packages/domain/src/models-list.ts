import type { ProviderConfig } from "./agent.js";

export interface AvailableModel {
  id: string;
  context?: number;
  output?: number;
  image?: boolean;
}

/** OpenAI-compatible and Anthropic model indexes live at `{base}/models`. */
export function modelsListUrl(
  provider: Pick<ProviderConfig, "kind" | "baseURL">,
): string {
  let base = provider.baseURL.trim().replace(/\/+$/, "");
  base = base.replace(/\/(?:chat\/completions|responses|messages)$/, "");
  if (
    provider.kind === "anthropic-messages" &&
    !base.endsWith("/models") &&
    !/\/v\d+$/.test(base)
  ) {
    base = `${base}/v1`;
  }
  if (base.endsWith("/models")) return base;
  return `${base}/models`;
}

export function parseAvailableModels(payload: unknown): AvailableModel[] {
  const record = asRecord(payload);
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.models)
        ? record.models
        : [];
  const seen = new Set<string>();
  const models: AvailableModel[] = [];
  for (const item of raw) {
    const model = readModel(item);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function readModel(item: unknown): AvailableModel | null {
  if (typeof item === "string") return cleanId(item) ? { id: item.trim() } : null;
  const record = asRecord(item);
  if (!record) return null;
  const id = cleanId(record.id) ?? cleanId(record.name) ?? cleanId(record.model);
  if (!id) return null;
  const context = firstPositive(
    record.context_window,
    record.context_length,
    record.max_model_len,
    record.max_context_tokens,
  );
  const output = firstPositive(record.max_output_tokens, record.max_completion_tokens);
  const image = supportsImage(record);
  return {
    id,
    ...(context ? { context } : {}),
    ...(output ? { output } : {}),
    ...(image ? { image: true } : {}),
  };
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.includes("/") || /[\u0000-\u001f\u007f]/.test(id)) return null;
  return id;
}

function firstPositive(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(number) && number > 0) return Math.floor(number);
  }
  return undefined;
}

function supportsImage(record: Record<string, unknown>): boolean {
  const buckets = [record.input_modalities, record.modalities, record.architecture];
  for (const bucket of buckets) {
    if (
      Array.isArray(bucket) &&
      bucket.some((item) => item === "image" || item === "vision")
    ) {
      return true;
    }
    const nested = asRecord(bucket);
    const input = nested?.input_modalities ?? nested?.input;
    if (
      Array.isArray(input) &&
      input.some((item) => item === "image" || item === "vision")
    ) {
      return true;
    }
  }
  return record.vision === true || record.supports_image === true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
