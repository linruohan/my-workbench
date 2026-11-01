import type { MemoryWorkbenchRepository } from "@wb/db/memory";
import {
  builtinProvider,
  buildAgentSystemPrompt,
  buildModelHttpRequest,
  applyRuntimeHeaders,
  emptyOpenAiStream,
  findProvider,
  finishOpenAiStream,
  gateTool,
  parseModelResponse,
  planLocalTurn,
  redactPlan,
  redactSecrets,
  reduceOpenAiStreamEvent,
  takeSseData,
  describeToolResult,
  toolCallSummary,
  type AgentMessage,
  type AgentTurnPlan,
  type PlannedCall,
  type ProviderConfig,
} from "@wb/domain";
import {
  executeAgentTool,
  type AgentRuntimeContext,
  type AgentUiEffect,
} from "./execute";

export type AgentTurnEnv = {
  store: MemoryWorkbenchRepository;
  threadId: string;
  nowMs?: number;
  providers?: ProviderConfig[];
  apiKey?: string | null;
  readApiKey?: (providerId: string) => string | null;
  displayName?: string;
  timer?: { taskId: string | null; startedAt: number | null };
  /** When set, skips the network and uses this plan for the next model turn. */
  plan?: (
    userText: string,
    transcript: AgentMessage[],
  ) => AgentTurnPlan | Promise<AgentTurnPlan>;
  onStep?: () => void;
  onDelta?: (text: string) => void;
  maxRounds?: number;
  signal?: AbortSignal;
};

export async function startAgentTurn(
  env: AgentTurnEnv,
  text: string,
): Promise<{ effects: AgentUiEffect[] }> {
  const thread = requireThread(env);
  const nowMs = env.nowMs ?? Date.now();
  const pending = env.store
    .listAgentApprovals(thread.id)
    .some((item) => item.status === "pending");
  if (pending || thread.queueJson) {
    say(env, "还有待确认的操作，请先批准或拒绝。", nowMs);
    return { effects: [] };
  }
  env.store.appendAgentMessage({
    threadId: thread.id,
    role: "user",
    content: text.trim(),
    nowMs,
  });
  env.onStep?.();
  return continueFromModel(env, 0);
}

export async function settleAgentApproval(
  env: AgentTurnEnv,
  decision: "approved" | "denied",
): Promise<{ effects: AgentUiEffect[] }> {
  const thread = requireThread(env);
  const nowMs = env.nowMs ?? Date.now();
  const queue = readQueue(thread.queueJson);
  const call = queue[0];
  const pending = env.store
    .listAgentApprovals(thread.id)
    .find((item) => item.status === "pending" && item.toolCallId === call?.id);
  if (!call || !pending) return { effects: [] };

  if (decision === "denied" || gateTool(thread.permissionMode, call.name) === "block") {
    env.store.resolveAgentApproval(pending.id, "denied", nowMs);
    sayTool(
      env,
      call,
      decision === "denied"
        ? `已拒绝：${pending.summary}。数据未改动。`
        : `只读会话不能执行：${pending.summary}`,
      nowMs,
    );
    shiftQueue(env, nowMs);
    return drain(env, 0, true);
  }

  env.store.resolveAgentApproval(pending.id, "approved", nowMs);
  const result = executeAgentTool(env.store, call.name, call.args, runtime(env, nowMs));
  sayTool(env, call, toolContent(call.name, result), nowMs);
  shiftQueue(env, nowMs);
  const rest = await drain(env, 0, true);
  return { effects: [...result.effects, ...rest.effects] };
}

/** Re-evaluate the queued call after the permission mode changes. */
export async function resumeAgentQueue(
  env: AgentTurnEnv,
): Promise<{ effects: AgentUiEffect[] }> {
  return drain(env, 0, true);
}

async function continueFromModel(
  env: AgentTurnEnv,
  round: number,
): Promise<{ effects: AgentUiEffect[] }> {
  const maxRounds = env.maxRounds ?? 3;
  const nowMs = env.nowMs ?? Date.now();
  if (round >= maxRounds) {
    say(env, "本回合的工具步骤已达上限。", nowMs);
    return { effects: [] };
  }
  const thread = requireThread(env);
  const transcript = env.store.listAgentMessages(thread.id).slice(-40);
  let plan: AgentTurnPlan;
  try {
    plan = env.plan
      ? await env.plan(latestUserText(transcript), transcript)
      : await requestModel(env, transcript);
  } catch (error) {
    if (isStopped(error)) {
      const partial = error instanceof AgentTurnStopped ? error.partial.trim() : "";
      say(env, partial ? `${partial}\n\n已停止。` : "已停止。", nowMs);
      return { effects: [] };
    }
    const raw = error instanceof Error ? error.message : "模型请求失败";
    say(
      env,
      `模型不可用：${redactSecrets(raw, secretValues(env))}。可改用「本机工作台」。`,
      nowMs,
    );
    return { effects: [] };
  }
  plan = redactPlan(plan, secretValues(env));
  const text =
    plan.text.trim() ||
    plan.calls.map((call) => toolCallSummary(call.name, call.args)).join("\n");
  env.store.appendAgentMessage({
    threadId: thread.id,
    role: "assistant",
    content: text || "好的。",
    toolCallsJson: plan.calls.length ? JSON.stringify(plan.calls) : null,
    nowMs,
  });
  if (!plan.calls.length) {
    env.onStep?.();
    return { effects: [] };
  }
  env.store.updateAgentThread(
    thread.id,
    { queueJson: JSON.stringify(plan.calls) },
    nowMs,
  );
  env.onStep?.();
  return drain(env, round, true);
}

async function drain(
  env: AgentTurnEnv,
  round: number,
  allowFollowUp: boolean,
): Promise<{ effects: AgentUiEffect[] }> {
  const effects: AgentUiEffect[] = [];
  const nowMs = env.nowMs ?? Date.now();
  let ranTool = false;
  while (true) {
    const thread = requireThread(env);
    const queue = readQueue(thread.queueJson);
    const call = queue[0];
    if (!call) {
      if (allowFollowUp && ranTool && !env.plan && remoteEnabled(env)) {
        const next = await continueFromModel(env, round + 1);
        return { effects: [...effects, ...next.effects] };
      }
      return { effects };
    }
    const gate = gateTool(thread.permissionMode, call.name);
    if (gate === "block") {
      closePending(env, call.id, "denied", nowMs);
      sayTool(
        env,
        call,
        `只读会话不能执行：${toolCallSummary(call.name, call.args)}`,
        nowMs,
      );
      shiftQueue(env, nowMs);
      continue;
    }
    if (gate === "ask") {
      const existing = env.store
        .listAgentApprovals(thread.id)
        .find((item) => item.status === "pending" && item.toolCallId === call.id);
      if (!existing) {
        env.store.addAgentApproval({
          threadId: thread.id,
          toolCallId: call.id,
          toolName: call.name,
          argsJson: JSON.stringify(call.args),
          summary: toolCallSummary(call.name, call.args),
          nowMs,
        });
      }
      env.onStep?.();
      return { effects };
    }
    closePending(env, call.id, "approved", nowMs);
    const result = executeAgentTool(env.store, call.name, call.args, runtime(env, nowMs));
    effects.push(...result.effects);
    sayTool(env, call, toolContent(call.name, result), nowMs);
    shiftQueue(env, nowMs);
    ranTool = true;
  }
}

async function requestModel(
  env: AgentTurnEnv,
  transcript: AgentMessage[],
): Promise<AgentTurnPlan> {
  const thread = requireThread(env);
  const providers = env.providers?.length ? env.providers : [builtinProvider()];
  const found = findProvider(providers, thread.modelRef);
  if (!found || !found.provider.enabled) throw new Error("当前模型不可用");
  if (found.provider.kind === "builtin") {
    return planLocalTurn(latestUserText(transcript), {
      nowMs: env.nowMs ?? Date.now(),
      tasks: env.store.listTasks().map((task) => ({
        id: task.id,
        title: task.title,
        isDone: task.isDone,
      })),
      projects: env.store.listProjects().map((project) => ({
        id: project.id,
        title: project.title,
      })),
    });
  }
  const apiKey = env.readApiKey?.(found.provider.id) ?? env.apiKey ?? null;
  if (found.provider.apiKeyRequired && !apiKey) {
    throw new Error("缺少模型密钥，请在设置 · 模型中填写。密钥不会写入会话。");
  }
  const nowMs = env.nowMs ?? Date.now();
  const today = env.store
    .listToday(nowMs)
    .slice(0, 12)
    .map((task) => `· ${task.title}`)
    .join("\n");
  const request = buildModelHttpRequest({
    provider: found.provider,
    modelId: found.modelId,
    system: buildAgentSystemPrompt({
      todaySummary: today,
      focus: null,
      unread: env.store.listNotifications().filter((item) => item.status !== "dismissed")
        .length,
      modelRef: thread.modelRef,
      permissionMode: thread.permissionMode,
    }),
    messages: transcript,
    permissionMode: thread.permissionMode,
  });
  const headers = applyRuntimeHeaders(request, apiKey);
  const stream = found.provider.kind === "openai-chat-completions";
  const body =
    stream && request.body && typeof request.body === "object"
      ? { ...request.body, stream: true }
      : request.body;
  if (env.signal?.aborted) throw new AgentTurnStopped("");
  const response = await fetch(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: env.signal,
  });
  const secrets = apiKey ? [apiKey] : [];
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(
      `模型返回 ${response.status}：${redactSecrets(raw, secrets).slice(0, 400)}`,
    );
  }
  const type = response.headers.get("content-type") ?? "";
  if (stream && type.includes("text/event-stream") && response.body) {
    return readOpenAiStream(response.body, secrets, env.onDelta, env.signal);
  }
  const raw = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("模型响应不是 JSON");
  }
  return redactPlan(parseModelResponse(found.provider.kind, payload), secrets);
}

class AgentTurnStopped extends Error {
  partial: string;
  constructor(partial: string) {
    super("已停止");
    this.name = "AgentTurnStopped";
    this.partial = partial;
  }
}

function isStopped(error: unknown): boolean {
  return (
    error instanceof AgentTurnStopped ||
    (error instanceof Error && error.name === "AbortError")
  );
}

async function readOpenAiStream(
  body: ReadableStream<Uint8Array>,
  secrets: string[],
  onDelta?: (text: string) => void,
  signal?: AbortSignal,
): Promise<AgentTurnPlan> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let acc = emptyOpenAiStream();
  try {
    while (true) {
      if (signal?.aborted) throw new AgentTurnStopped(acc.text);
      const step = await reader.read();
      if (step.done) break;
      carry += decoder.decode(step.value, { stream: true });
      const taken = takeSseData(carry);
      carry = taken.rest;
      for (const event of taken.data) {
        acc = reduceOpenAiStreamEvent(acc, event);
        if (acc.text) onDelta?.(acc.text);
      }
    }
  } catch (error) {
    if (isStopped(error)) throw new AgentTurnStopped(acc.text);
    throw error;
  }
  return redactPlan(finishOpenAiStream(acc), secrets);
}

function remoteEnabled(env: AgentTurnEnv): boolean {
  const thread = env.store.getAgentThread(env.threadId);
  if (!thread) return false;
  const providers = env.providers?.length ? env.providers : [builtinProvider()];
  const found = findProvider(providers, thread.modelRef);
  return Boolean(found && found.provider.kind !== "builtin");
}

function runtime(env: AgentTurnEnv, nowMs: number): AgentRuntimeContext {
  return {
    nowMs,
    threadId: env.threadId,
    displayName: env.displayName ?? "",
    timer: env.timer ?? { taskId: null, startedAt: null },
  };
}

function say(env: AgentTurnEnv, content: string, nowMs: number): void {
  env.store.appendAgentMessage({
    threadId: env.threadId,
    role: "assistant",
    content,
    nowMs,
  });
  env.onStep?.();
}

function sayTool(
  env: AgentTurnEnv,
  call: PlannedCall,
  content: string,
  nowMs: number,
): void {
  env.store.appendAgentMessage({
    threadId: env.threadId,
    role: "tool",
    content,
    toolName: call.name,
    toolCallId: call.id,
    nowMs,
  });
  env.onStep?.();
}

function toolContent(name: string, result: { summary: string; data: unknown }): string {
  return describeToolResult(name, result.data, result.summary);
}

function shiftQueue(env: AgentTurnEnv, nowMs: number): void {
  const thread = requireThread(env);
  const queue = readQueue(thread.queueJson);
  queue.shift();
  env.store.updateAgentThread(
    thread.id,
    { queueJson: queue.length ? JSON.stringify(queue) : null },
    nowMs,
  );
  env.onStep?.();
}

function closePending(
  env: AgentTurnEnv,
  toolCallId: string,
  status: "approved" | "denied",
  nowMs: number,
): void {
  const pending = env.store
    .listAgentApprovals(env.threadId)
    .find((item) => item.status === "pending" && item.toolCallId === toolCallId);
  if (pending) env.store.resolveAgentApproval(pending.id, status, nowMs);
}

function readQueue(json: string | null): PlannedCall[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const call = item as Partial<PlannedCall>;
      if (typeof call.id !== "string" || typeof call.name !== "string") return [];
      const args =
        call.args && typeof call.args === "object" && !Array.isArray(call.args)
          ? call.args
          : {};
      return [{ id: call.id, name: call.name, args }];
    });
  } catch {
    return [];
  }
}

function latestUserText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return messages[i]!.content;
  }
  return "";
}

function secretValues(env: AgentTurnEnv): string[] {
  const values = new Set<string>();
  if (env.apiKey) values.add(env.apiKey);
  const thread = env.store.getAgentThread(env.threadId);
  const providerId = thread?.modelRef.slice(0, thread.modelRef.lastIndexOf("/"));
  if (providerId && env.readApiKey) {
    const key = env.readApiKey(providerId);
    if (key) values.add(key);
  }
  return [...values];
}

function requireThread(env: AgentTurnEnv) {
  const thread = env.store.getAgentThread(env.threadId);
  if (!thread) throw new Error("会话不存在");
  return thread;
}
