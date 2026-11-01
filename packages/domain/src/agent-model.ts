import { createId } from "./id.js";
import {
  toolsForMode,
  type AgentMessage,
  type AgentPermissionMode,
  type AgentTurnPlan,
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
}): ModelHttpRequest {
  const tools = toolsForMode(input.permissionMode).map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
  }));
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
        messages: anthropicMessages(input.messages),
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
        ...openAiMessages(input.messages),
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

function endpoint(provider: ProviderConfig): string {
  const base = provider.baseURL.replace(/\/+$/, "");
  if (provider.kind === "anthropic-messages") {
    if (base.endsWith("/messages")) return base;
    if (base.endsWith("/v1")) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

function openAiMessages(messages: AgentMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
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
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

function anthropicMessages(messages: AgentMessage[]): unknown[] {
  const out: Array<{ role: string; content: unknown }> = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role === "system" || message.role === "tool") continue;
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
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
