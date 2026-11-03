import { createId } from "./id.js";
import {
  toolsForMode,
  type AgentMessage,
  type AgentPermissionMode,
  type AgentTurnPlan,
  type ModelCaps,
  type PlannedCall,
  type ProviderConfig,
  type ProviderKind,
} from "./agent.js";

export interface ModelHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Header names the host fills with the credential. The request body never contains it. */
  secretHeaderNames: string[];
}

export interface OpenAiStreamAcc {
  text: string;
  calls: Array<{ id: string; name: string; argsText: string }>;
}

export function buildModelHttpRequest(input: {
  provider: ProviderConfig;
  modelId: string;
  system: string;
  messages: AgentMessage[];
  permissionMode: AgentPermissionMode;
  /** When set, only these tool names are offered. */
  toolAllowlist?: readonly string[];
  /** Data URL attached to the latest user message when that model can see images. */
  imageDataUrl?: string;
}): ModelHttpRequest {
  const tools = toolsForMode(input.permissionMode, input.toolAllowlist).map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
  }));
  if (input.provider.kind === "openai-responses") {
    return {
      url: endpoint(input.provider),
      headers: { "content-type": "application/json" },
      secretHeaderNames: ["authorization"],
      body: {
        model: input.modelId,
        instructions: input.system,
        input: responsesInput(input.messages),
        tools: tools.map((spec) => ({
          type: "function",
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters,
        })),
      },
    };
  }
  if (input.provider.kind === "anthropic-messages") {
    return {
      url: endpoint(input.provider),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      secretHeaderNames: ["x-api-key"],
      body: {
        model: input.modelId,
        max_tokens: input.provider.models[input.modelId]?.output ?? 2048,
        system: input.system,
        tools: tools.map((spec) => ({
          name: spec.name,
          description: spec.description,
          input_schema: spec.parameters,
        })),
        messages: anthropicMessages(input.messages, input.imageDataUrl),
      },
    };
  }
  return {
    url: endpoint(input.provider),
    headers: { "content-type": "application/json" },
    secretHeaderNames: ["authorization"],
    body: {
      model: input.modelId,
      messages: [
        { role: "system", content: input.system },
        ...openAiMessages(input.messages, input.imageDataUrl),
      ],
      tools: tools.map((spec) => ({
        type: "function",
        function: {
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters,
        },
      })),
      tool_choice: "auto",
    },
  };
}

const CONNECTIVITY_PROBE_SYSTEM = "You are a connectivity probe.";
const CONNECTIVITY_PROBE_USER = "hi";

/**
 * Smallest request that proves the endpoint, credential, and model id work.
 * Fixed roles and text, one output token, no tools, streaming on.
 * When the model lists reasoning levels, only the lowest mapped level is sent.
 */
export function buildConnectivityProbe(input: {
  provider: ProviderConfig;
  modelId: string;
}): ModelHttpRequest {
  const { provider, modelId } = input;
  if (provider.kind === "builtin") {
    throw new Error("builtin providers have no connectivity probe");
  }
  const reasoning = lowestReasoningField(provider.models[modelId]);
  if (provider.kind === "anthropic-messages") {
    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens: 1,
      stream: true,
      system: [{ type: "text", text: CONNECTIVITY_PROBE_SYSTEM }],
      messages: [
        { role: "user", content: [{ type: "text", text: CONNECTIVITY_PROBE_USER }] },
      ],
    };
    applyReasoningField(body, reasoning);
    return {
      url: endpoint(provider),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      secretHeaderNames: ["x-api-key"],
      body,
    };
  }
  if (provider.kind === "openai-responses") {
    const body: Record<string, unknown> = {
      model: modelId,
      stream: true,
      max_output_tokens: 1,
      input: [
        { role: "system", content: CONNECTIVITY_PROBE_SYSTEM },
        {
          role: "user",
          content: [{ type: "input_text", text: CONNECTIVITY_PROBE_USER }],
        },
      ],
    };
    applyReasoningField(body, reasoning);
    return {
      url: endpoint(provider),
      headers: { "content-type": "application/json" },
      secretHeaderNames: ["authorization"],
      body,
    };
  }
  const body: Record<string, unknown> = {
    model: modelId,
    stream: true,
    messages: [
      { role: "system", content: CONNECTIVITY_PROBE_SYSTEM },
      { role: "user", content: CONNECTIVITY_PROBE_USER },
    ],
    ...chatProbeBudget(provider, modelId),
  };
  applyReasoningField(body, reasoning);
  return {
    url: endpoint(provider),
    headers: { "content-type": "application/json" },
    secretHeaderNames: ["authorization"],
    body,
  };
}

/** One SSE `data:` payload from a connectivity probe. */
export function readConnectivityProbeEvent(
  kind: ProviderKind,
  data: string,
): "pending" | "finish" | { error: string } {
  if (!data) return "pending";
  if (data === "[DONE]") return "finish";
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return "pending";
  }
  const record = asRecord(json);
  if (!record) return "pending";
  const failure = probeErrorMessage(record);
  if (failure) return { error: failure };
  if (kind === "anthropic-messages") {
    if (record.type === "message_stop") return "finish";
    const delta = asRecord(record.delta);
    if (
      record.type === "message_delta" &&
      typeof delta?.stop_reason === "string" &&
      delta.stop_reason
    ) {
      return "finish";
    }
    return "pending";
  }
  if (kind === "openai-responses") {
    if (record.type === "response.completed" || record.type === "response.incomplete")
      return "finish";
    if (record.type === "response.failed") {
      const nested = asRecord(asRecord(record.response)?.error);
      const message = typeof nested?.message === "string" ? nested.message.trim() : "";
      return { error: message || "连接失败" };
    }
    return "pending";
  }
  const choice = asRecord(asArray(record.choices)?.[0]);
  if (choice && typeof choice.finish_reason === "string" && choice.finish_reason)
    return "finish";
  return "pending";
}

/** Null when a non-stream JSON body is an accepted completion. */
export function connectivityProbeJsonError(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) return "模型响应不是 JSON";
  return probeErrorMessage(record);
}

export function applyRuntimeHeaders(
  request: ModelHttpRequest,
  apiKey: string | null,
): Record<string, string> {
  const headers = { ...request.headers };
  if (!apiKey) return headers;
  if (request.secretHeaderNames.includes("authorization")) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  if (request.secretHeaderNames.includes("x-api-key")) {
    headers["x-api-key"] = apiKey;
  }
  return headers;
}

export function parseModelResponse(kind: ProviderKind, payload: unknown): AgentTurnPlan {
  if (kind === "anthropic-messages") return parseAnthropic(payload);
  if (kind === "openai-responses") return parseResponses(payload);
  return parseOpenAi(payload);
}

export function emptyOpenAiStream(): OpenAiStreamAcc {
  return { text: "", calls: [] };
}

export function takeSseData(buffer: string): { data: string[]; rest: string } {
  const parts = buffer.split(/\n\n/);
  const rest = parts.pop() ?? "";
  const data: string[] = [];
  for (const part of parts) {
    const lines = part
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (lines.length) data.push(lines.join("\n"));
  }
  return { data, rest };
}

export function reduceOpenAiStreamEvent(
  acc: OpenAiStreamAcc,
  data: string,
): OpenAiStreamAcc {
  if (!data || data === "[DONE]") return acc;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return acc;
  }
  const delta = asRecord(asRecord(asArray(asRecord(json)?.choices)?.[0])?.delta);
  if (!delta) return acc;
  const calls = acc.calls.map((call) => ({ ...call }));
  const text = acc.text + (typeof delta.content === "string" ? delta.content : "");
  if (Array.isArray(delta.tool_calls)) {
    for (const raw of delta.tool_calls) {
      const tc = asRecord(raw);
      if (!tc) continue;
      const index = typeof tc.index === "number" ? tc.index : 0;
      while (calls.length <= index) calls.push({ id: "", name: "", argsText: "" });
      const slot = calls[index]!;
      if (typeof tc.id === "string") slot.id = tc.id;
      const fn = asRecord(tc.function);
      if (typeof fn?.name === "string") slot.name += fn.name;
      if (typeof fn?.arguments === "string") slot.argsText += fn.arguments;
    }
  }
  return { text, calls };
}

export function finishOpenAiStream(acc: OpenAiStreamAcc): AgentTurnPlan {
  return {
    text: acc.text,
    calls: acc.calls
      .filter((call) => call.name)
      .map((call) => ({
        id: call.id || createId(),
        name: call.name,
        args: parseArgs(call.argsText),
      })),
  };
}

/** Zhipu chat models reject the OpenAI completion budget and think by default. */
function chatProbeBudget(
  provider: ProviderConfig,
  modelId: string,
): Record<string, unknown> {
  const zhipu = /bigmodel\.cn/i.test(provider.baseURL) || /^glm[-.]/i.test(modelId);
  if (!zhipu) return { max_completion_tokens: 1 };
  return { max_tokens: 16, thinking: { type: "disabled" } };
}

function lowestReasoningField(
  caps: ModelCaps | undefined,
): { field: string; value: string } | null {
  const level = caps?.reasoningLevels?.map((item) => item.trim()).find(Boolean);
  const map = caps?.reasoningMap?.trim();
  if (!level || !map) return null;
  for (const line of map.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() !== level) continue;
    const spec = trimmed.slice(eq + 1).trim();
    const colon = spec.indexOf(":");
    if (colon <= 0) continue;
    const field = spec.slice(0, colon).trim();
    const value = spec.slice(colon + 1).trim();
    if (!field || !value || !/^[A-Za-z0-9_.-]+$/.test(field)) continue;
    return { field, value };
  }
  return null;
}

function applyReasoningField(
  body: Record<string, unknown>,
  reasoning: { field: string; value: string } | null,
): void {
  if (!reasoning) return;
  body[reasoning.field] = reasoning.value;
}

function probeErrorMessage(record: Record<string, unknown>): string | null {
  if (record.type === "error" || record.error) {
    if (typeof record.error === "string" && record.error.trim())
      return record.error.trim();
    const error = asRecord(record.error);
    if (typeof error?.message === "string" && error.message.trim())
      return error.message.trim();
    if (record.type === "error" || error) return "连接失败";
  }
  return null;
}

function endpoint(provider: ProviderConfig): string {
  const base = provider.baseURL.replace(/\/+$/, "");
  if (provider.kind === "anthropic-messages") {
    if (base.endsWith("/messages")) return base;
    if (base.endsWith("/v1")) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  if (provider.kind === "openai-responses") {
    if (base.endsWith("/responses")) return base;
    return `${base}/responses`;
  }
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

function responsesInput(messages: AgentMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "tool") {
      out.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      });
      continue;
    }
    if (message.content) out.push({ role: "assistant", content: message.content });
    for (const call of readCalls(message.toolCallsJson)) {
      out.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.args),
      });
    }
  }
  return out;
}

function chatImage(dataUrl: string | undefined): string | null {
  if (!dataUrl?.startsWith("data:image/")) return null;
  if (dataUrl.length > 7_000_000) return null;
  return dataUrl;
}

function lastUserIndex(messages: readonly AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

function openAiMessages(messages: AgentMessage[], imageDataUrl?: string): unknown[] {
  const image = chatImage(imageDataUrl);
  const imageAt = image ? lastUserIndex(messages) : -1;
  const out: unknown[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role === "system") continue;
    if (message.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      });
      continue;
    }
    if (message.role === "assistant") {
      const calls = readCalls(message.toolCallsJson);
      if (calls.length) {
        out.push({
          role: "assistant",
          content: message.content || null,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        });
        continue;
      }
    }
    if (i === imageAt && image) {
      out.push({
        role: "user",
        content: [
          { type: "text", text: message.content || "请看这张图片" },
          { type: "image_url", image_url: { url: image } },
        ],
      });
      continue;
    }
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

function anthropicImage(dataUrl: string): { mediaType: string; data: string } | null {
  const matched = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(
    dataUrl,
  );
  const mediaType = matched?.[1];
  const data = matched?.[2]?.replace(/\s/g, "");
  if (!mediaType || !data) return null;
  return { mediaType, data };
}

function anthropicMessages(messages: AgentMessage[], imageDataUrl?: string): unknown[] {
  const image = chatImage(imageDataUrl);
  const parsed = image ? anthropicImage(image) : null;
  const imageAt = parsed ? lastUserIndex(messages) : -1;
  const out: Array<{ role: string; content: unknown }> = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role === "system" || message.role === "tool") continue;
    if (message.role === "user") {
      if (i === imageAt && parsed) {
        out.push({
          role: "user",
          content: [
            { type: "text", text: message.content || "请看这张图片" },
            {
              type: "image",
              source: { type: "base64", media_type: parsed.mediaType, data: parsed.data },
            },
          ],
        });
      } else {
        out.push({ role: "user", content: message.content });
      }
      continue;
    }
    const calls = readCalls(message.toolCallsJson);
    const blocks: unknown[] = [];
    if (message.content) blocks.push({ type: "text", text: message.content });
    for (const call of calls) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.args,
      });
    }
    if (!blocks.length) blocks.push({ type: "text", text: "" });
    out.push({ role: "assistant", content: blocks });
    if (!calls.length) continue;
    const results: unknown[] = [];
    while (messages[i + 1]?.role === "tool") {
      i += 1;
      const tool = messages[i]!;
      results.push({
        type: "tool_result",
        tool_use_id: tool.toolCallId,
        content: tool.content,
      });
    }
    if (results.length) out.push({ role: "user", content: results });
  }
  return out;
}

function parseOpenAi(payload: unknown): AgentTurnPlan {
  const message = asRecord(asRecord(asArray(asRecord(payload)?.choices)?.[0])?.message);
  const text = typeof message?.content === "string" ? message.content : "";
  const calls: PlannedCall[] = [];
  if (Array.isArray(message?.tool_calls)) {
    for (const raw of message.tool_calls) {
      const tc = asRecord(raw);
      const fn = asRecord(tc?.function);
      const name = typeof fn?.name === "string" ? fn.name : "";
      if (!name) continue;
      calls.push({
        id: typeof tc?.id === "string" ? tc.id : createId(),
        name,
        args: parseArgs(fn?.arguments),
      });
    }
  }
  return { text, calls };
}

function parseResponses(payload: unknown): AgentTurnPlan {
  const output = asArray(asRecord(payload)?.output) ?? [];
  let text = "";
  const calls: PlannedCall[] = [];
  for (const raw of output) {
    const item = asRecord(raw);
    if (!item) continue;
    if (item.type === "message") {
      if (typeof item.content === "string") text += item.content;
      for (const part of asArray(item.content) ?? []) {
        const block = asRecord(part);
        if (block?.type === "output_text" && typeof block.text === "string")
          text += block.text;
      }
    }
    if (item.type === "function_call" && typeof item.name === "string") {
      const id =
        typeof item.call_id === "string"
          ? item.call_id
          : typeof item.id === "string"
            ? item.id
            : createId();
      calls.push({ id, name: item.name, args: parseArgs(item.arguments) });
    }
  }
  return { text, calls };
}

function parseAnthropic(payload: unknown): AgentTurnPlan {
  const blocks = asArray(asRecord(payload)?.content) ?? [];
  let text = "";
  const calls: PlannedCall[] = [];
  for (const raw of blocks) {
    const block = asRecord(raw);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    if (block.type === "tool_use" && typeof block.name === "string") {
      calls.push({
        id: typeof block.id === "string" ? block.id : createId(),
        name: block.name,
        args: asRecord(block.input) ?? {},
      });
    }
  }
  return { text, calls };
}

function readCalls(json: string | null): PlannedCall[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      const record = asRecord(item);
      if (!record || typeof record.name !== "string" || typeof record.id !== "string") {
        return [];
      }
      return [
        {
          id: record.id,
          name: record.name,
          args: asRecord(record.args) ?? {},
        },
      ];
    });
  } catch {
    return [];
  }
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
