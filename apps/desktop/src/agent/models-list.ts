import {
  connectivityProbeJsonError,
  modelsListUrl,
  parseAvailableModels,
  redactSecrets,
  type AvailableModel,
  type ProviderConfig,
} from "@wb/domain";
import { describeTransportError, hostFetch } from "./host-fetch";

const LIST_TIMEOUT_MS = 30_000;

export type ModelsListResult =
  | { success: true; models: AvailableModel[] }
  | { success: false; error: { message: string } };

export async function fetchAvailableModels(input: {
  provider: ProviderConfig;
  apiKey: string | null;
  fetchImpl?: (
    url: string,
    init?: RequestInit & { timeoutMs?: number },
  ) => Promise<Response>;
  timeoutMs?: number;
}): Promise<ModelsListResult> {
  const { provider } = input;
  if (provider.kind === "builtin") return fail("本机模型不需要获取");
  if (!provider.enabled) return fail("请先启用供应商");
  if (!provider.baseURL.trim()) return fail("未配置 endpoint");
  if (provider.apiKeyRequired && !input.apiKey?.trim()) return fail("缺少模型密钥");

  const headers: Record<string, string> = { accept: "application/json" };
  if (input.apiKey) {
    if (provider.kind === "anthropic-messages") {
      headers["x-api-key"] = input.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.authorization = `Bearer ${input.apiKey}`;
    }
  }
  const secrets = input.apiKey ? [input.apiKey] : [];
  const timeoutMs = input.timeoutMs ?? LIST_TIMEOUT_MS;
  let response: Response;
  try {
    response = await (input.fetchImpl ?? hostFetch)(modelsListUrl(provider), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      timeoutMs,
    });
  } catch (error) {
    return fail(describeTransportError(error, "获取超时"));
  }

  const raw = redactSecrets(await response.text(), secrets);
  if (!response.ok) return fail(httpFailure(response.status, raw.slice(0, 400)));
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return fail("模型列表不是 JSON");
  }
  const models = parseAvailableModels(payload);
  if (models.length > 0) return { success: true, models };
  const message = connectivityProbeJsonError(payload);
  if (message && message !== "模型响应不是 JSON")
    return fail(redactSecrets(message, secrets));
  return fail("没有获取到可用模型");
}

function fail(message: string): ModelsListResult {
  return { success: false, error: { message } };
}

function httpFailure(status: number, body: string): string {
  if (status === 401 || status === 403) return "认证失败";
  if (status === 404) return "未配置 endpoint";
  if (status === 429) return "请求频率限制";
  if (status >= 500) return "服务端错误";
  const detail = body.trim();
  return detail ? `获取失败：${detail}` : "获取失败";
}
