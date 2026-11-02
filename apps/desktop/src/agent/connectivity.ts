import {
  applyRuntimeHeaders,
  buildConnectivityProbe,
  connectivityProbeJsonError,
  readConnectivityProbeEvent,
  redactSecrets,
  takeSseData,
  type ProviderConfig,
} from "@wb/domain";

const PROBE_TIMEOUT_MS = 60_000;

export type ModelConnectivityResult =
  | { success: true }
  | { success: false; error: { message: string } };

export async function testModelConnectivity(input: {
  provider: ProviderConfig;
  modelId: string;
  apiKey: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ModelConnectivityResult> {
  const { provider, modelId } = input;
  if (provider.kind === "builtin") {
    return fail("本机模型不需要测试连接");
  }
  if (!provider.enabled) return fail("请先启用供应商");
  if (!provider.models[modelId]) return fail("该模型当前不可用，无法测试连接");
  if (!provider.baseURL.trim()) return fail("未配置 endpoint");
  if (provider.apiKeyRequired && !input.apiKey?.trim()) return fail("缺少模型密钥");

  let request;
  try {
    request = buildConnectivityProbe({ provider, modelId });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "连接失败");
  }
  const headers = applyRuntimeHeaders(request, input.apiKey);
  const secrets = input.apiKey ? [input.apiKey] : [];
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") return fail("测试超时");
    return fail("网络错误");
  }

  if (!response.ok) {
    const raw = redactSecrets(await response.text(), secrets).slice(0, 400);
    return fail(httpFailure(response.status, raw));
  }

  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream") && response.body) {
    return readProbeStream(provider.kind, response.body, secrets);
  }
  const raw = await response.text();
  if (/^\s*(?:data:|event:)/.test(raw)) {
    return (
      finishFromEvents(provider.kind, takeSseData(`${raw}\n\n`).data, secrets) ??
      fail("连接测试在结束前中断")
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return fail("模型响应不是 JSON");
  }
  const message = connectivityProbeJsonError(payload);
  if (message) return fail(redactSecrets(message, secrets));
  return { success: true };
}

function fail(message: string): ModelConnectivityResult {
  return { success: false, error: { message } };
}

function httpFailure(status: number, body: string): string {
  if (status === 401 || status === 403) return "认证失败";
  if (status === 404) return /model/i.test(body) ? "模型未找到" : "未配置 endpoint";
  if (status === 429) return "请求频率限制";
  if (status >= 500) return "服务端错误";
  const detail = body.trim();
  return detail ? `连接失败：${detail}` : "连接失败";
}

async function readProbeStream(
  kind: ProviderConfig["kind"],
  body: ReadableStream<Uint8Array>,
  secrets: string[],
): Promise<ModelConnectivityResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      carry += decoder.decode(step.value, { stream: true });
      const taken = takeSseData(carry);
      carry = taken.rest;
      const result = finishFromEvents(kind, taken.data, secrets);
      if (result) return result;
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") return fail("测试超时");
    return fail("网络错误");
  }
  const tail = carry.trim() ? takeSseData(`${carry}\n\n`).data : [];
  return finishFromEvents(kind, tail, secrets) ?? fail("连接测试在结束前中断");
}

function finishFromEvents(
  kind: ProviderConfig["kind"],
  events: string[],
  secrets: string[],
): ModelConnectivityResult | null {
  let finished = false;
  for (const event of events) {
    const step = readConnectivityProbeEvent(kind, event);
    if (step === "pending") continue;
    if (step === "finish") {
      finished = true;
      continue;
    }
    return fail(redactSecrets(step.error, secrets));
  }
  return finished ? { success: true } : null;
}
