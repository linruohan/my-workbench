/**
 * Session compact: keep the live turn, replace older model context with a summary.
 * The transcript on screen stays intact until a manual /compact writes a boundary.
 */

import type { AgentMessage } from "./agent.js";

/** Same divisor ZCode uses when a provider usage anchor is absent. */
export const ESTIMATED_TOKEN_CHAR_DIVISOR = 3;

export const COMPACT_MARKER = "【上下文已压缩】";

/** Placeholder left when an old tool result is dropped from the model view. */
export const CLEARED_TOOL_RESULT = "[较早的工具结果已清空]";

/** Middle marker after pressure pruning oversized tool results (model view only). */
export const PRUNED_TOOL_RESULT_MARK = "\n\n[... 工具结果中段已修剪 ...]\n\n";

export const MICROCOMPACT_KEEP_RECENT = 4;
const MICROCOMPACT_MIN_CHARS = 240;

/** Align with DSH tool-result-pruner defaults (chars, not tokens). */
export const TOOL_RESULT_PRUNE_THRESHOLD_CHARS = 8192;
export const TOOL_RESULT_PRUNE_HEAD_CHARS = 4096;
export const TOOL_RESULT_PRUNE_TAIL_CHARS = 1024;

/** Tokens reserved for the reply and a small safety margin, same as the turn loop. */
export function modelContextBudget(
  contextLimit: number | undefined,
  outputLimit: number | undefined,
): number {
  return Math.max(1024, (contextLimit ?? 8192) - (outputLimit ?? 2048) - 512);
}

export function estimateTextTokens(text: string): number {
  const chars = text.trim().length;
  if (!chars) return 0;
  return Math.max(1, Math.ceil(chars / ESTIMATED_TOKEN_CHAR_DIVISOR));
}

export function estimateTranscriptTokens(
  messages: AgentMessage[],
  budgetTokens: number,
): number {
  return tokenSum(modelTranscript(messages, budgetTokens));
}

/** System prompt plus the compacted transcript, matching one model request. */
export function estimateContextTokens(
  system: string,
  messages: AgentMessage[],
  budgetTokens: number,
): number {
  return estimateTextTokens(system) + estimateTranscriptTokens(messages, budgetTokens);
}

/**
 * Deterministic head/tail slice for one oversized tool result.
 * Idempotent when the middle mark is already present.
 */
export function pruneToolResultText(
  content: string,
  options?: {
    thresholdChars?: number;
    headChars?: number;
    tailChars?: number;
  },
): string {
  const threshold = options?.thresholdChars ?? TOOL_RESULT_PRUNE_THRESHOLD_CHARS;
  const headChars = options?.headChars ?? TOOL_RESULT_PRUNE_HEAD_CHARS;
  const tailChars = options?.tailChars ?? TOOL_RESULT_PRUNE_TAIL_CHARS;
  if (content.length <= threshold) return content;
  if (content.includes(PRUNED_TOOL_RESULT_MARK.trim())) return content;
  if (content.startsWith(CLEARED_TOOL_RESULT)) return content;
  const head = content.slice(0, Math.max(0, headChars));
  const tail = content.slice(Math.max(0, content.length - Math.max(0, tailChars)));
  return `${head}${PRUNED_TOOL_RESULT_MARK}${tail}`;
}

/** Apply pressure pruning to every tool message over the char threshold. */
export function pruneOversizedToolResults(
  messages: AgentMessage[],
  options?: {
    thresholdChars?: number;
    headChars?: number;
    tailChars?: number;
  },
): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    const next = pruneToolResultText(message.content, options);
    return next === message.content ? message : { ...message, content: next };
  });
}

/**
 * Shorten tool results older than the most recent few.
 * The on-screen transcript is unchanged; only the model view is shortened.
 */
export function microcompactToolResults(
  messages: AgentMessage[],
  keepRecent = MICROCOMPACT_KEEP_RECENT,
): AgentMessage[] {
  const toolIndexes: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === "tool") toolIndexes.push(index);
  });
  const keep = Math.max(0, keepRecent);
  if (toolIndexes.length <= keep) return messages;
  const clear = new Set(toolIndexes.slice(0, toolIndexes.length - keep));
  return messages.map((message, index) => {
    if (!clear.has(index)) return message;
    if (message.content.length < MICROCOMPACT_MIN_CHARS) return message;
    if (message.content.startsWith(CLEARED_TOOL_RESULT)) return message;
    const name = message.toolName ? ` ${message.toolName}` : "";
    return { ...message, content: `${CLEARED_TOOL_RESULT}${name}` };
  });
}

export function isCompactMarker(message: AgentMessage): boolean {
  return message.role === "system" && message.content.startsWith(COMPACT_MARKER);
}

export function estimateMessageTokens(message: AgentMessage): number {
  const chars =
    message.content.length +
    (message.toolName?.length ?? 0) +
    (message.toolCallsJson?.length ?? 0);
  return Math.max(1, Math.ceil(chars / ESTIMATED_TOKEN_CHAR_DIVISOR));
}

export function compactMarkerText(summary: string, dropped: number): string {
  return `${COMPACT_MARKER}\n已把更早的 ${dropped} 条移出模型上下文。界面里仍能往上翻。\n${summary}`;
}

export type CompactPlan = {
  needed: boolean;
  summary: string;
  dropped: number;
  messages: AgentMessage[];
};

/**
 * 调整裁剪边界，保证保留的模型视图上下文完整：
 * 视图不能从孤儿工具结果开始（其调用方 assistant 工具调用已被裁掉），
 * 否则 OpenAI / Responses 等接口会因 tool 消息没有对应 tool_calls 而拒绝请求。
 * 连续的工具结果随边界一起移出；最多推进到最后一条 user 消息（活轮次不会被丢）。
 */
export function safeCutIndex(messages: AgentMessage[], start: number): number {
  let index = Math.max(0, Math.min(start, messages.length));
  while (index < messages.length && messages[index].role === "tool") {
    index += 1;
  }
  return index;
}

/** Messages the model should see, compacted when they exceed `budgetTokens`. */
export function planCompact(messages: AgentMessage[], budgetTokens: number): CompactPlan {
  // Pressure prune oversized tool bodies first; hard-clear only when still over budget later.
  const projected = microcompactToolResults(
    pruneOversizedToolResults(projectForModel(messages)),
  );
  const budget = Math.max(1, budgetTokens);
  const lastUser = lastIndex(projected, (message) => message.role === "user");
  if (lastUser <= 0) {
    return { needed: false, summary: "", dropped: 0, messages: projected };
  }
  let start = lastUser;
  let used = tokenSum(projected.slice(start));
  while (start > 0) {
    const prev = projected[start - 1]!;
    const next = used + estimateMessageTokens(prev);
    if (next > budget) break;
    start -= 1;
    used = next;
  }
  if (start === 0) {
    return { needed: false, summary: "", dropped: 0, messages: projected };
  }
  const cut = safeCutIndex(projected, start);
  const dropped = projected.slice(0, cut);
  const summary = summarizeDropped(dropped);
  const marker: AgentMessage = {
    id: "compact-projection",
    threadId: projected[0]?.threadId ?? "",
    role: "user",
    content: compactMarkerText(summary, dropped.length),
    toolName: null,
    toolCallId: null,
    toolCallsJson: null,
    createdAt: dropped[0]?.createdAt ?? 0,
  };
  return {
    needed: true,
    summary,
    dropped: dropped.length,
    messages: [marker, ...projected.slice(cut)],
  };
}

export function modelTranscript(
  messages: AgentMessage[],
  budgetTokens: number,
): AgentMessage[] {
  return planCompact(messages, budgetTokens).messages;
}

/** Manual /compact: summarize everything before the latest user turn. */
export function manualCompactPlan(
  messages: AgentMessage[],
): { summary: string; dropped: number } | null {
  const body = sliceAfterLatestCompact(messages).filter(
    (message) => !isCompactMarker(message) && message.role !== "system",
  );
  const lastUser = lastIndex(body, (message) => message.role === "user");
  if (lastUser <= 0) return null;
  const dropped = body.slice(0, lastUser);
  return { summary: summarizeDropped(dropped), dropped: dropped.length };
}

function projectForModel(messages: AgentMessage[]): AgentMessage[] {
  return sliceAfterLatestCompact(messages)
    .filter((message) => message.role !== "system" || isCompactMarker(message))
    .map((message) =>
      isCompactMarker(message) ? { ...message, role: "user" as const } : message,
    );
}

function sliceAfterLatestCompact(messages: AgentMessage[]): AgentMessage[] {
  let index = -1;
  messages.forEach((message, i) => {
    if (isCompactMarker(message)) index = i;
  });
  if (index < 0) return messages;
  return messages.slice(index);
}

function summarizeDropped(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (lines.length >= 12) break;
    if (message.role === "user") {
      const text = oneLine(message.content, 80);
      if (text) lines.push(`用户：${text}`);
      continue;
    }
    if (message.role === "tool" && message.toolName) {
      lines.push(`工具 ${message.toolName}`);
      continue;
    }
    if (message.role === "assistant" && message.content.trim()) {
      lines.push(`助手：${oneLine(message.content, 100)}`);
    }
  }
  return lines.length ? lines.join("\n") : "（更早的对话没有可摘录的文字）";
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

function tokenSum(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function lastIndex(
  messages: AgentMessage[],
  pred: (message: AgentMessage) => boolean,
): number {
  let found = -1;
  messages.forEach((message, index) => {
    if (pred(message)) found = index;
  });
  return found;
}
