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
  formatTodosForPrompt,
  formatGoalForPrompt,
  renderGoalWrapup,
  formatWorkspaceToolsHint,
  findSubagent,
  invokedSkillsInText,
  omitInvokedSkillTokens,
  formatSubagentsForPrompt,
  gateTool,
  hooksForEvent,
  isWorkspaceToolName,
  parseAskUserMode,
  parseAskUserQuestions,
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
  type AgentGoal,
  type AgentHook,
  type AgentMemory,
  type AgentMessage,
  type AgentThread,
  type AgentSkill,
  type AgentSubagent,
  type AgentTodoItem,
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
import {
  completeManagedAgent,
  getManagedAgent,
  interruptManagedAgent,
  listManagedAgents,
  registerManagedAgent,
  removeManagedAgent,
  sendManagedAgentMessage,
  takeManagedAgentInbox,
  takePendingAgentNotices,
} from "./agent-registry";
import { takePendingImageDataUrls } from "./image-attachments";
import { takePendingJobNotices } from "./job-watch";
import { isTauriRuntime } from "../lib/paths";
import { completeViaOpenCode } from "./oc-runtime";
import { runWorkspaceTool } from "./workspace-tools";

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
  /** Session todos from todo_write. */
  todos?: AgentTodoItem[];
  onTodos?: (next: AgentTodoItem[]) => void;
  /** Session goal (lightweight DSH goal_*). */
  goal?: AgentGoal | null;
  onGoal?: (next: AgentGoal | null) => void;
  /** Session working directory under the workspace root. */
  cwd?: string | null;
  onCwd?: (next: string) => void;
  /** Picture for this turn when the selected model can see images. */
  imageDataUrl?: string;
  /** Called when read_image attaches a workspace picture for the next model request. */
  onImage?: (dataUrl: string) => void;
  /** Nested subagent depth (0 = top-level). */
  subagentDepth?: number;
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

  if (call.name === "ask_user_question") {
    if (decision === "denied") {
      env.store.resolveAgentApproval(pending.id, "denied", nowMs);
      sayTool(env, call, "用户跳过了提问。", nowMs);
      shiftQueue(env, nowMs);
      return drain(env, 0, true);
    }
    return { effects: [] };
  }

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
  const result = await executeCallWithTimeout(env, call, nowMs);
  sayTool(env, call, toolContent(call.name, result), nowMs);
  shiftQueue(env, nowMs);
  const rest = await drain(env, 0, true);
  return { effects: [...result.effects, ...rest.effects] };
}

/** Submit answers for a pending ask_user_question and continue the queue. */
export async function settleAgentQuestion(
  env: AgentTurnEnv,
  answers: Record<string, string | string[]>,
): Promise<{ effects: AgentUiEffect[] }> {
  const thread = requireThread(env);
  const nowMs = env.nowMs ?? Date.now();
  const queue = readQueue(thread.queueJson);
  const call = queue[0];
  const pending = env.store
    .listAgentApprovals(thread.id)
    .find((item) => item.status === "pending" && item.toolCallId === call?.id);
  if (!call || !pending || call.name !== "ask_user_question") return { effects: [] };
  const parsed = parseAskUserQuestions(call.args);
  if (parsed.ok === false) {
    env.store.resolveAgentApproval(pending.id, "denied", nowMs);
    sayTool(env, call, parsed.reason, nowMs);
    shiftQueue(env, nowMs);
    return drain(env, 0, true);
  }
  const normalized: Record<string, string | string[]> = {};
  for (const question of parsed.questions) {
    const raw = answers[question.id];
    if (question.multiSelect) {
      const list = Array.isArray(raw)
        ? raw
            .map(String)
            .map((item) => item.trim())
            .filter(Boolean)
        : typeof raw === "string" && raw.trim()
          ? [raw.trim()]
          : [];
      if (!list.length) {
        return { effects: [] };
      }
      normalized[question.id] = list;
    } else {
      const text = Array.isArray(raw) ? raw[0] : raw;
      if (typeof text !== "string" || !text.trim()) return { effects: [] };
      normalized[question.id] = text.trim();
    }
  }
  env.store.resolveAgentApproval(pending.id, "approved", nowMs);
  sayTool(
    env,
    call,
    toolContent(call.name, {
      summary: `已收到 ${parsed.questions.length} 个回答`,
      data: { answers: normalized },
    }),
    nowMs,
  );
  shiftQueue(env, nowMs);
  return drain(env, 0, true);
}

/** Timed ask_user_question expired — continue without answers. */
export async function settleAgentQuestionTimeout(
  env: AgentTurnEnv,
): Promise<{ effects: AgentUiEffect[] }> {
  const thread = requireThread(env);
  const nowMs = env.nowMs ?? Date.now();
  const queue = readQueue(thread.queueJson);
  const call = queue[0];
  const pending = env.store
    .listAgentApprovals(thread.id)
    .find((item) => item.status === "pending" && item.toolCallId === call?.id);
  if (!call || !pending || call.name !== "ask_user_question") return { effects: [] };
  const mode = parseAskUserMode(call.args);
  if (mode.mode !== "timed") return { effects: [] };
  env.store.resolveAgentApproval(pending.id, "approved", nowMs);
  sayTool(
    env,
    call,
    toolContent(call.name, {
      summary: "提问已超时，用户尚未回答；可继续并在需要时再次询问。",
      data: { timedOut: true, answers: {} },
    }),
    nowMs,
  );
  shiftQueue(env, nowMs);
  return drain(env, 0, true);
}

/** Read timed-ask settings from pending ask_user_question args. */
export function askUserTimedConfig(args: Record<string, unknown> | null | undefined): {
  timed: boolean;
  timeoutSec: number;
} {
  if (!args) return { timed: false, timeoutSec: 120 };
  const mode = parseAskUserMode(args);
  return { timed: mode.mode === "timed", timeoutSec: mode.timeoutSec };
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
  deliverJobNotices(env, nowMs);
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
    bumpGoalRound(env, nowMs);
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
  try {
    while (true) {
      if (env.signal?.aborted) throw new AgentTurnStopped("");
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
      const result = await executeCallWithTimeout(env, call, nowMs);
      effects.push(...result.effects);
      let content = toolContent(call.name, result);
      if (result.ok && call.name === "task_complete") {
        const notice = formatHookNotices(
          hooksForEvent(env.hooks ?? [], "task_completed"),
        );
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
      if (result.ok && call.name === "update_goal") {
        const goal = goalPort(env).get();
        if (goal && (goal.phase === "completed" || goal.phase === "blocked")) {
          env.store.appendAgentMessage({
            threadId: env.threadId,
            role: "system",
            content: renderGoalWrapup(goal.objective, goal.blockedReason),
            nowMs,
          });
        }
      }
      shiftQueue(env, nowMs);
      ranTool = true;
    }
  } catch (error) {
    if (isStopped(error)) {
      say(env, "已停止。", nowMs);
      return { effects };
    }
    throw error;
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
      formatGoalForPrompt(env.goal ?? null),
    ]
      .filter(Boolean)
      .join("\n\n"),
    memoriesPrompt: formatMemoriesForPrompt(memoryPort(env).list()),
    subagentsPrompt: formatSubagentsForPrompt(env.subagents ?? []),
    pluginsPrompt: formatPluginsForPrompt(env.plugins ?? []),
    mcpPrompt: formatMcpForPrompt(env.mcpServers ?? []),
    hostToolsPrompt: formatHostToolsForPrompt(env.hostTools ?? []),
    workspaceToolsPrompt: [
      formatWorkspaceToolsHint(Boolean(env.workspacePath?.trim())),
      cwdPort(env).get() ? `会话 cwd：${cwdPort(env).get()}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    todosPrompt: formatTodosForPrompt(todoPort(env).list()),
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
  const canSee = modelCanSeeImages(provider.kind, caps);
  const pendingImages = canSee ? takePendingImageDataUrls(thread.id) : [];
  if (canSee && env.imageDataUrl) pendingImages.push(env.imageDataUrl);
  env.imageDataUrl = undefined;
  const request = buildModelHttpRequest({
    provider,
    modelId: found.modelId,
    system,
    messages: visible,
    permissionMode: thread.permissionMode,
    toolAllowlist: env.toolAllowlist,
    workspaceBound: Boolean(env.workspacePath?.trim()),
    imageDataUrls: canSee ? pendingImages : undefined,
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
const todoBoxes = new WeakMap<AgentTurnEnv, AgentTodoItem[]>();
const goalBoxes = new WeakMap<AgentTurnEnv, AgentGoal | null>();
const cwdBoxes = new WeakMap<AgentTurnEnv, string>();

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

function todoPort(env: AgentTurnEnv): {
  list: () => AgentTodoItem[];
  replace: (next: AgentTodoItem[]) => void;
} {
  if (!todoBoxes.has(env)) todoBoxes.set(env, [...(env.todos ?? [])]);
  return {
    list: () => todoBoxes.get(env) ?? [],
    replace: (next) => {
      todoBoxes.set(env, next);
      env.onTodos?.(next);
    },
  };
}

function goalPort(env: AgentTurnEnv): {
  get: () => AgentGoal | null;
  set: (next: AgentGoal | null) => void;
} {
  if (!goalBoxes.has(env)) goalBoxes.set(env, env.goal ?? null);
  return {
    get: () => goalBoxes.get(env) ?? null,
    set: (next) => {
      goalBoxes.set(env, next);
      env.goal = next;
      env.onGoal?.(next);
    },
  };
}

/** Count a completed top-level model round against the session goal. */
function bumpGoalRound(env: AgentTurnEnv, nowMs: number): void {
  if ((env.subagentDepth ?? 0) > 0) return;
  const goals = goalPort(env);
  const goal = goals.get();
  if (!goal || goal.phase !== "active" || !goal.continuationArmed) return;
  const next: AgentGoal = {
    ...goal,
    roundsStarted: goal.roundsStarted + 1,
    revision: goal.revision + 1,
    updatedAt: nowMs,
  };
  if (next.roundsStarted >= next.maxRounds) {
    next.phase = "blocked";
    next.continuationArmed = false;
    next.blockedReason = "reached max_goal_rounds";
  }
  goals.set(next);
}

/** Declared cooperative budgets (DSH call-timeout-policy style). */
const TOOL_TIMEOUT_MS: Record<string, number> = {
  web_fetch: 60_000,
  web_search: 60_000,
  bash: 180_000,
  shell: 180_000,
  pwsh: 180_000,
  office_to_pdf: 180_000,
  grep: 60_000,
  glob: 60_000,
  subagent: 300_000,
  job_output: 120_000,
};

async function executeCallWithTimeout(
  env: AgentTurnEnv,
  call: PlannedCall,
  nowMs: number,
): Promise<AgentToolResult> {
  if (env.signal?.aborted) throw new AgentTurnStopped("");
  const budget = TOOL_TIMEOUT_MS[call.name];
  const run = () => executeCall(env, call, nowMs);
  if (!budget && !env.signal) return run();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortListeners: Array<{ signal: AbortSignal; fn: () => void }> = [];
  try {
    const racers: Promise<AgentToolResult>[] = [run()];
    if (budget) {
      racers.push(
        new Promise<AgentToolResult>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`tool call timed out after ${budget}ms`));
          }, budget);
        }),
      );
    }
    if (env.signal) {
      racers.push(
        new Promise<AgentToolResult>((_, reject) => {
          const signal = env.signal!;
          if (signal.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          const fn = () =>
            reject(new DOMException("The operation was aborted.", "AbortError"));
          signal.addEventListener("abort", fn, { once: true });
          abortListeners.push({ signal, fn });
        }),
      );
    }
    return await Promise.race(racers);
  } catch (error) {
    if (isStopped(error)) throw new AgentTurnStopped("");
    const message = error instanceof Error ? error.message : "工具超时";
    if (/timed out after \d+ms/.test(message)) {
      return {
        ok: false,
        summary: message,
        data: { error: message, code: "TOOL_TIMEOUT" },
        effects: [],
      };
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    for (const { signal, fn } of abortListeners) {
      signal.removeEventListener("abort", fn);
    }
  }
}

function deliverJobNotices(env: AgentTurnEnv, nowMs: number): void {
  const notices = [
    ...takePendingJobNotices(env.threadId),
    ...takePendingAgentNotices(env.threadId),
  ];
  for (const notice of notices) {
    env.store.appendAgentMessage({
      threadId: env.threadId,
      role: "system",
      content: notice,
      nowMs,
    });
  }
  if (notices.length) env.onStep?.();
}

function cwdPort(env: AgentTurnEnv): {
  get: () => string | null;
  set: (next: string) => void;
} {
  if (!cwdBoxes.has(env)) {
    const initial = env.cwd?.trim() || env.workspacePath?.trim() || "";
    if (initial) cwdBoxes.set(env, initial);
  }
  return {
    get: () => cwdBoxes.get(env) ?? env.cwd?.trim() ?? env.workspacePath?.trim() ?? null,
    set: (next) => {
      cwdBoxes.set(env, next);
      env.onCwd?.(next);
    },
  };
}

function runtime(env: AgentTurnEnv, nowMs: number): AgentRuntimeContext {
  const goals = goalPort(env);
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
    goal: goals.get(),
    onGoal: goals.set,
  };
}

async function executeCall(
  env: AgentTurnEnv,
  call: PlannedCall,
  nowMs: number,
): Promise<AgentToolResult> {
  if (call.name === "subagent") {
    return runSubagentDelegation(env, call.args, nowMs);
  }
  if (
    call.name === "list_agents" ||
    call.name === "send_message" ||
    call.name === "interrupt_agent"
  ) {
    return runSubagentControl(env, call.name, call.args, nowMs);
  }
  if (call.name === "load_workspace_dependencies") {
    return loadWorkspaceDependencies();
  }
  if (isWorkspaceToolName(call.name)) {
    try {
      const todos = todoPort(env);
      const cwd = cwdPort(env);
      return await runWorkspaceTool(call.name, call.args, {
        rootPath: env.workspacePath,
        cwd: cwd.get(),
        onCwd: cwd.set,
        hostTools: env.hostTools,
        todos: todos.list(),
        onTodos: todos.replace,
        readApiKey: env.readApiKey,
        threadId: env.threadId,
        signal: env.signal,
        onImage: (dataUrl) => {
          env.imageDataUrl = dataUrl;
          env.onImage?.(dataUrl);
        },
      });
    } catch (error) {
      if (isStopped(error)) throw error;
      const message = error instanceof Error ? error.message : "工具执行失败";
      return { ok: false, summary: message, data: { error: message }, effects: [] };
    }
  }
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

async function loadWorkspaceDependencies(): Promise<AgentToolResult> {
  if (!isTauriRuntime()) {
    return {
      ok: true,
      summary: "当前环境无本机运行时探测",
      data: { node: null, python: null, pnpm: null, source: "browser" },
      effects: [],
    };
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const hit = await invoke<{
      node: { path: string; version: string | null } | null;
      python: { path: string; version: string | null } | null;
      pnpm: { path: string; version: string | null } | null;
      source: string;
    }>("agent_workspace_runtime_paths");
    const parts = [
      hit.node ? `node ${hit.node.version ?? ""}`.trim() : null,
      hit.python ? `python ${hit.python.version ?? ""}`.trim() : null,
      hit.pnpm ? `pnpm ${hit.pnpm.version ?? ""}`.trim() : null,
    ].filter(Boolean);
    return {
      ok: true,
      summary: parts.length
        ? `已探测：${parts.join(" · ")}`
        : "未探测到 Node/Python/pnpm",
      data: hit,
      effects: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "探测失败";
    return { ok: false, summary: message, data: { error: message }, effects: [] };
  }
}

async function runSubagentControl(
  env: AgentTurnEnv,
  name: string,
  args: Record<string, unknown>,
  nowMs: number,
): Promise<AgentToolResult> {
  if (name === "list_agents") {
    const scopeRaw = typeof args.scope === "string" ? args.scope.trim() : "children";
    const scope = scopeRaw === "descendants" ? "descendants" : "children";
    const agents = listManagedAgents(env.threadId, scope);
    return {
      ok: true,
      summary: agents.length ? `有 ${agents.length} 个子智能体` : "没有托管子智能体",
      data: { agents, scope },
      effects: [],
    };
  }
  if (name === "interrupt_agent") {
    const agentId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
    if (!agentId) {
      return {
        ok: false,
        summary: "请提供 agent_id",
        data: { error: "请提供 agent_id" },
        effects: [],
      };
    }
    const result = interruptManagedAgent(agentId, env.threadId);
    if (result.ok === false) {
      return {
        ok: false,
        summary: result.reason,
        data: { error: result.reason },
        effects: [],
      };
    }
    return {
      ok: true,
      summary: `已请求中断 ${agentId}`,
      data: { agent: result.agent },
      effects: [],
    };
  }
  // send_message
  const agentId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
  const message =
    (typeof args.message === "string" && args.message.trim()) ||
    (typeof args.text === "string" && args.text.trim()) ||
    "";
  if (!agentId) {
    return {
      ok: false,
      summary: "请提供 agent_id",
      data: { error: "请提供 agent_id" },
      effects: [],
    };
  }
  const sent = sendManagedAgentMessage(agentId, env.threadId, message);
  if (sent.ok === false) {
    return { ok: false, summary: sent.reason, data: { error: sent.reason }, effects: [] };
  }
  const record = getManagedAgent(agentId);
  if (record && record.status === "inactive") {
    const parent = requireThread(env);
    const child = env.store.getAgentThread(agentId);
    if (child) {
      const controller = new AbortController();
      record.controller = controller;
      record.status = "running";
      const nested: AgentTurnEnv = {
        ...env,
        threadId: agentId,
        subagentDepth: (env.subagentDepth ?? 0) + 1,
        signal: controller.signal,
        nowMs,
      };
      void (async () => {
        try {
          const followUps = takeManagedAgentInbox(agentId);
          for (const follow of followUps.length ? followUps : [message]) {
            await startAgentTurn(nested, follow);
          }
          for (let guard = 0; guard < 10; guard += 1) {
            if (controller.signal.aborted) break;
            const more = takeManagedAgentInbox(agentId);
            if (more.length) {
              for (const follow of more) await startAgentTurn(nested, follow);
              continue;
            }
            const thread = env.store.getAgentThread(agentId);
            if (!thread?.queueJson) break;
            const pending = env.store
              .listAgentApprovals(agentId)
              .find((item) => item.status === "pending");
            if (pending) await settleAgentApproval(nested, "denied");
            else await resumeAgentQueue(nested);
          }
          const messages = env.store.listAgentMessages(agentId);
          const lastAssistant = [...messages]
            .reverse()
            .find((item) => item.role === "assistant");
          const text = lastAssistant?.content?.trim() || "（子智能体无文字答复）";
          completeManagedAgent(
            agentId,
            text,
            `subagent ${record.name} (${agentId}) finished after message.\n${text.slice(0, 1200)}`,
          );
        } catch (error) {
          const err = error instanceof Error ? error.message : "子智能体失败";
          completeManagedAgent(
            agentId,
            err,
            `subagent ${record.name} (${agentId}) failed: ${err}`,
          );
        }
      })();
      void parent;
    }
  }
  return {
    ok: true,
    summary: `已受理消息 ${sent.messageId}`,
    data: { messageId: sent.messageId, agent: sent.agent },
    effects: [],
  };
}

async function runSubagentDelegation(
  env: AgentTurnEnv,
  args: Record<string, unknown>,
  nowMs: number,
): Promise<AgentToolResult> {
  const depth = env.subagentDepth ?? 0;
  if (depth >= 2) {
    return {
      ok: false,
      summary: "子智能体嵌套过深",
      data: { error: "子智能体嵌套过深" },
      effects: [],
    };
  }
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const task =
    (typeof args.task === "string" && args.task.trim()) ||
    (typeof args.prompt === "string" && args.prompt.trim()) ||
    "";
  if (!name) {
    return {
      ok: false,
      summary: "请提供 name",
      data: { error: "请提供 name" },
      effects: [],
    };
  }
  if (!task) {
    return {
      ok: false,
      summary: "请提供 task",
      data: { error: "请提供 task" },
      effects: [],
    };
  }
  const agent = findSubagent(env.subagents ?? [], name);
  if (!agent) {
    return {
      ok: false,
      summary: `未找到子智能体「${name}」`,
      data: { error: `未找到子智能体「${name}」` },
      effects: [],
    };
  }
  const parent = requireThread(env);
  const wait = args.wait === true;
  const child = env.store.createAgentThread({
    workspaceId: parent.workspaceId,
    title: `subagent:${agent.name}`,
    modelRef: parent.modelRef,
    permissionMode: parent.permissionMode === "readonly" ? "readonly" : "session_auto",
  });
  const controller = new AbortController();
  if (env.signal) {
    if (env.signal.aborted) controller.abort();
    else {
      env.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  registerManagedAgent({
    id: child.id,
    parentThreadId: parent.id,
    name: agent.name,
    depth: depth + 1,
    controller,
    nowMs,
  });
  const nestedBase: AgentTurnEnv = {
    ...env,
    threadId: child.id,
    subagentDepth: depth + 1,
    subagentPrompt: `你正在作为子智能体「${agent.name}」回答。\n${agent.prompt}`,
    toolAllowlist: agent.toolNames.length ? agent.toolNames : undefined,
    maxRounds: Math.min(env.maxRounds ?? 3, 4),
    signal: controller.signal,
    nowMs,
  };

  const runChild = async (): Promise<string> => {
    await startAgentTurn(nestedBase, task);
    for (let guard = 0; guard < 12; guard += 1) {
      if (controller.signal.aborted) break;
      const followUps = takeManagedAgentInbox(child.id);
      if (followUps.length) {
        for (const follow of followUps) {
          await startAgentTurn({ ...nestedBase, nowMs: Date.now() }, follow);
        }
        continue;
      }
      const thread = env.store.getAgentThread(child.id);
      if (!thread?.queueJson) break;
      const pending = env.store
        .listAgentApprovals(child.id)
        .find((item) => item.status === "pending");
      if (pending) {
        await settleAgentApproval(nestedBase, "denied");
      } else {
        await resumeAgentQueue(nestedBase);
      }
    }
    const messages = env.store.listAgentMessages(child.id);
    const lastAssistant = [...messages]
      .reverse()
      .find((message) => message.role === "assistant");
    return lastAssistant?.content?.trim() || "（子智能体无文字答复）";
  };

  if (wait) {
    try {
      const text = await runChild();
      completeManagedAgent(
        child.id,
        text,
        `subagent ${agent.name} (${child.id}) finished.\n${text.slice(0, 1200)}`,
      );
      removeManagedAgent(child.id);
      env.store.deleteAgentThread(child.id);
      return {
        ok: true,
        summary: `子智能体 ${agent.name} 已完成`,
        data: { name: agent.name, agentId: child.id, text },
        effects: [],
      };
    } catch (error) {
      removeManagedAgent(child.id);
      env.store.deleteAgentThread(child.id);
      const message = error instanceof Error ? error.message : "子智能体失败";
      return { ok: false, summary: message, data: { error: message }, effects: [] };
    }
  }

  void runChild()
    .then((text) => {
      const record = getManagedAgent(child.id);
      const interrupted = record?.status === "interrupted" || controller.signal.aborted;
      completeManagedAgent(
        child.id,
        text,
        interrupted
          ? `subagent ${agent.name} (${child.id}) interrupted.\n${text.slice(0, 800)}`
          : `subagent ${agent.name} (${child.id}) finished.\n${text.slice(0, 1200)}`,
      );
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : "子智能体失败";
      completeManagedAgent(
        child.id,
        message,
        `subagent ${agent.name} (${child.id}) failed: ${message}`,
      );
    });

  return {
    ok: true,
    summary: `started subagent ${child.id}`,
    data: { agentId: child.id, name: agent.name, status: "running" },
    effects: [],
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
