import type { MemoryWorkbenchRepository } from "@wb/db/memory";
import {
  DSH_FREE_PROVIDER_ID,
  builtinProvider,
  buildAgentSystemPrompt,
  buildModelHttpRequest,
  applyRuntimeHeaders,
  prepareDshFreeChat,
  settleDshToolCalls,
  buildOcRunPrompt,
  emptyOpenAiStream,
  chatProviderFor,
  findProvider,
  isLocalBuiltin,
  resolveOcApiKey,
  finishOpenAiStream,
  formatHookNotices,
  formatHostToolsForPrompt,
  formatMcpForPrompt,
  formatMemoriesForPrompt,
  formatPluginsForPrompt,
  estimateContextTokens,
  formatActiveSkills,
  formatSessionContext,
  formatTodayForPrompt,
  formatSkillsForPrompt,
  invokedSkillsInText,
  omitInvokedSkillTokens,
  formatSubagentsForPrompt,
  gateTool,
  hooksForEvent,
  listEnabledSkillSummaries,
  modelCanSeeImages,
  modelContextBudget,
  modelTranscript,
  parseModelResponse,
  planLocalTurn,
  redactPlan,
  redactSecrets,
  reduceOpenAiStreamEvent,
  takeSseData,
  describeToolResult,
  toolCallSummary,
  type AgentHook,
  type AgentMemory,
  type AgentMessage,
  type AgentThread,
  type AgentSkill,
  type AgentSubagent,
  type AgentTurnPlan,
  type HostToolSnapshot,
  type McpServer,
  type PlannedCall,
  type ProviderConfig,
} from "@wb/domain";
import {
  executeAgentTool,
  type AgentRuntimeContext,
  type AgentToolResult,
  type AgentUiEffect,
} from "./execute";
import { dshHostPlatform, dshSessionFor } from "./dsh-session";
import { hostFetch } from "./host-fetch";
import { isTauriRuntime } from "../lib/paths";
import { completeViaOpenCode } from "./oc-runtime";

export type AgentTurnEnv = {
  store: MemoryWorkbenchRepository;
  threadId: string;
  nowMs?: number;
  providers?: ProviderConfig[];
  apiKey?: string | null;
  readApiKey?: (providerId: string) => string | null;
  displayName?: string;
  /** Standing user rules from settings. */
  rules?: string;
  /** Enabled skills from Settings → 技能. */
  skills?: AgentSkill[];
  memories?: AgentMemory[];
  onMemories?: (next: AgentMemory[]) => void;
  subagents?: AgentSubagent[];
  hooks?: AgentHook[];
  plugins?: Array<{ name: string; version: string; description: string }>;
  mcpServers?: McpServer[];
  /** Ready and missing host tools. The prompt only includes ready, enabled ones. */
  hostTools?: HostToolSnapshot[];
  runHostTool?: (args: Record<string, unknown>) => Promise<AgentToolResult>;
  /** Picture for this turn when the selected model can see images. */
  imageDataUrl?: string;
  /** Persona for one /agent turn. */
  subagentPrompt?: string;
  workspaceTitle?: string;
  workspacePath?: string;
  gitBranch?: string | null;
  /** Open task, note, or timer, already phrased for the prompt. */
  focus?: string | null;
  toolAllowlist?: readonly string[];
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
  const priorUsers = env.store
    .listAgentMessages(thread.id)
    .filter((message) => message.role === "user").length;
  env.store.appendAgentMessage({
    threadId: thread.id,
    role: "user",
    content: text.trim(),
    nowMs,
  });
  if (priorUsers === 0) {
    const notice = formatHookNotices(hooksForEvent(env.hooks ?? [], "session_start"));
    if (notice) {
      env.store.appendAgentMessage({
        threadId: thread.id,
        role: "system",
        content: notice,
        nowMs,
      });
    }
  }
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
  const result = await executeCall(env, call, nowMs);
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
    if (env.toolAllowlist && !env.toolAllowlist.includes(call.name)) {
      closePending(env, call.id, "denied", nowMs);
      sayTool(env, call, `当前子智能体不能使用 ${call.name}`, nowMs);
      shiftQueue(env, nowMs);
      continue;
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
    const result = await executeCall(env, call, nowMs);
    effects.push(...result.effects);
    let content = toolContent(call.name, result);
    if (result.ok && call.name === "task_complete") {
      const notice = formatHookNotices(hooksForEvent(env.hooks ?? [], "task_completed"));
      if (notice) {
        content = `${content}\n钩子：${notice}`;
        env.store.appendAgentMessage({
          threadId: env.threadId,
          role: "system",
          content: notice,
          nowMs,
        });
      }
    }
    sayTool(env, call, content, nowMs);
    shiftQueue(env, nowMs);
    ranTool = true;
  }
}

function composeSystemPrompt(
  env: AgentTurnEnv,
  transcript: AgentMessage[],
  budget: number,
  thread: AgentThread,
): string {
  const nowMs = env.nowMs ?? Date.now();
  const projectTitle = new Map(
    env.store.listProjects().map((project) => [project.id, project.title]),
  );
  const today = formatTodayForPrompt(
    env.store.listToday(nowMs).map((task) => ({
      title: task.title,
      dueDay: task.dueDay,
      dueWithTime: task.dueWithTime,
      remindAt: task.remindAt,
      timeEstimate: task.timeEstimate,
      projectTitle: projectTitle.get(task.projectId),
    })),
    nowMs,
  );
  const visible = modelTranscript(transcript, budget);
  const sessionHooks = formatHookNotices(hooksForEvent(env.hooks ?? [], "session_start"));
  return buildAgentSystemPrompt({
    todaySummary: today,
    focus: env.focus ?? null,
    unread: env.store.listNotifications().filter((item) => item.status !== "dismissed")
      .length,
    modelRef: thread.modelRef,
    permissionMode: thread.permissionMode,
    rules: env.rules,
    contextPrompt: formatSessionContext({
      nowMs,
      workspaceTitle: env.workspaceTitle,
      workspacePath: env.workspacePath,
      gitBranch: env.gitBranch,
    }),
    skillsPrompt: [
      formatSkillsForPrompt(listEnabledSkillSummaries(env.skills ?? [])),
      formatActiveSkills(env.skills ?? [], visible),
    ]
      .filter(Boolean)
      .join("\n\n"),
    memoriesPrompt: formatMemoriesForPrompt(memoryPort(env).list()),
    subagentsPrompt: formatSubagentsForPrompt(env.subagents ?? []),
    pluginsPrompt: formatPluginsForPrompt(env.plugins ?? []),
    mcpPrompt: formatMcpForPrompt(env.mcpServers ?? []),
    hostToolsPrompt: formatHostToolsForPrompt(env.hostTools ?? []),
    subagentPrompt: env.subagentPrompt,
    hooksPrompt: sessionHooks ? `会话开始时宿主还记下：\n${sessionHooks}` : "",
  });
}

/** Same token estimate the next model request would send. */
export function previewAgentContext(
  env: AgentTurnEnv,
  transcript: AgentMessage[],
): { used: number; budget: number; includesSystem: boolean } | null {
  const thread = env.store.getAgentThread(env.threadId);
  if (!thread) return null;
  const providers = env.providers?.length ? env.providers : [builtinProvider()];
  const found = findProvider(providers, thread.modelRef);
  const caps = found?.provider.models[found.modelId];
  const budget = modelContextBudget(caps?.context, caps?.output);
  const includesSystem = !(found && isLocalBuiltin(found.provider, found.modelId));
  const system = includesSystem
    ? composeSystemPrompt(env, transcript, budget, thread)
    : "";
  return {
    used: estimateContextTokens(system, transcript, budget),
    budget,
    includesSystem,
  };
}

async function requestModel(
  env: AgentTurnEnv,
  transcript: AgentMessage[],
): Promise<AgentTurnPlan> {
  const thread = requireThread(env);
  const providers = env.providers?.length ? env.providers : [builtinProvider()];
  const found = findProvider(providers, thread.modelRef);
  if (!found || !found.provider.enabled) throw new Error("当前模型不可用");
  const provider = chatProviderFor(found.provider, found.modelId);
  const userText = latestUserText(transcript);
  if (isLocalBuiltin(found.provider, found.modelId)) {
    const invoked = invokedSkillsInText(env.skills ?? [], userText);
    if (invoked.length > 0) {
      const request = omitInvokedSkillTokens(env.skills ?? [], userText);
      const bodies = invoked
        .map((skill) => `「${skill.name}」\n${skill.body.trim()}`.trim())
        .join("\n\n");
      return {
        text: request
          ? `已载入技能。\n\n${bodies}\n\n要求：${request}`
          : `已载入技能。\n\n${bodies}`,
        calls: [],
      };
    }
    return planLocalTurn(userText, {
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
  const caps = provider.models[found.modelId];
  const budget = modelContextBudget(caps?.context, caps?.output);
  const visible = modelTranscript(transcript, budget);
  const system = composeSystemPrompt(env, transcript, budget, thread);
  const ocModel = Boolean(found.provider.models[found.modelId]?.endpoint);
  let apiKey = env.readApiKey?.(provider.id) ?? env.apiKey ?? null;
  if (found.provider.kind === "builtin" && ocModel) {
    if (isTauriRuntime()) {
      const text = await completeViaOpenCode(
        found.modelId,
        buildOcRunPrompt({
          system,
          messages: visible.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        }),
      );
      return { text, calls: [] };
    }
    apiKey = resolveOcApiKey(apiKey);
  }
  if (provider.apiKeyRequired && !apiKey) {
    throw new Error("缺少模型密钥，请在设置 · 模型中填写。密钥不会写入会话。");
  }
  const request = buildModelHttpRequest({
    provider,
    modelId: found.modelId,
    system,
    messages: visible,
    permissionMode: thread.permissionMode,
    toolAllowlist: env.toolAllowlist,
    imageDataUrl: modelCanSeeImages(provider.kind, caps) ? env.imageDataUrl : undefined,
  });
  const dsh = found.provider.id === DSH_FREE_PROVIDER_ID;
  const stream = provider.kind === "openai-chat-completions";
  const body =
    stream && request.body && typeof request.body === "object"
      ? { ...request.body, stream: true }
      : request.body;
  let url = request.url;
  let headers = applyRuntimeHeaders(request, dsh ? null : apiKey);
  let outbound: unknown = body;
  let aliases = new Map<string, string>();
  if (dsh && body && typeof body === "object") {
    const prepared = prepareDshFreeChat({
      body: body as Record<string, unknown>,
      session: dshSessionFor(thread.id),
      directory: env.workspacePath,
      platform: dshHostPlatform(),
    });
    url = prepared.url;
    headers = prepared.headers;
    outbound = prepared.body;
    aliases = prepared.aliases;
  }
  const adopt = (plan: AgentTurnPlan): AgentTurnPlan =>
    dsh ? { ...plan, calls: settleDshToolCalls(plan.calls, aliases) } : plan;
  if (env.signal?.aborted) throw new AgentTurnStopped("");
  const response = await hostFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(outbound),
    signal: env.signal,
    timeoutMs: 120_000,
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
    return adopt(await readOpenAiStream(response.body, secrets, env.onDelta, env.signal));
  }
  const raw = await response.text();
  if (dsh && /^\s*data:/m.test(raw)) {
    const text = raw.endsWith("\n\n") ? raw : `${raw}\n\n`;
    const sse = new Response(text).body;
    if (!sse) throw new Error("模型响应不是 JSON");
    return adopt(await readOpenAiStream(sse, secrets, env.onDelta, env.signal));
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("模型响应不是 JSON");
  }
  return adopt(redactPlan(parseModelResponse(provider.kind, payload), secrets));
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
  return Boolean(found && !isLocalBuiltin(found.provider, found.modelId));
}

const memoryBoxes = new WeakMap<AgentTurnEnv, AgentMemory[]>();

function memoryPort(env: AgentTurnEnv): {
  list: () => AgentMemory[];
  replace: (next: AgentMemory[]) => void;
} {
  if (!memoryBoxes.has(env)) memoryBoxes.set(env, [...(env.memories ?? [])]);
  return {
    list: () => memoryBoxes.get(env) ?? [],
    replace: (next) => {
      memoryBoxes.set(env, next);
      env.onMemories?.(next);
    },
  };
}

function runtime(env: AgentTurnEnv, nowMs: number): AgentRuntimeContext {
  return {
    nowMs,
    threadId: env.threadId,
    displayName: env.displayName ?? "",
    timer: env.timer ?? { taskId: null, startedAt: null },
    skills: env.skills ?? [],
    memories: memoryPort(env),
    subagents: env.subagents ?? [],
    hooks: env.hooks ?? [],
    plugins: env.plugins ?? [],
    mcpServers: env.mcpServers ?? [],
    hostTools: env.hostTools ?? [],
    toolAllowlist: env.toolAllowlist,
  };
}

async function executeCall(
  env: AgentTurnEnv,
  call: PlannedCall,
  nowMs: number,
): Promise<AgentToolResult> {
  if (call.name !== "host_tool_run") {
    return executeAgentTool(env.store, call.name, call.args, runtime(env, nowMs));
  }
  if (!env.runHostTool) {
    return {
      ok: false,
      summary: "当前环境不能运行本机工具",
      data: { error: "当前环境不能运行本机工具" },
      effects: [],
    };
  }
  try {
    return await env.runHostTool(call.args);
  } catch (error) {
    const message = error instanceof Error ? error.message : "工具执行失败";
    return { ok: false, summary: message, data: { error: message }, effects: [] };
  }
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
