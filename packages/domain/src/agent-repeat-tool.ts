/**
 * Advisory loop hygiene: remind the model when it repeats the exact same tool call.
 * Inspired by dsh-repeat-tool-reminder; never blocks or rewrites the call.
 */

export type RepeatToolState = {
  tool: string;
  argsKey: string;
  count: number;
};

export const REPEAT_TOOL_THRESHOLDS = [3, 5, 8] as const;
export const REPEAT_TOOL_ARGS_PREVIEW_CHARS = 500;

/** Tools that neither increment nor reset the streak (transparent). */
export const REPEAT_TOOL_EXCLUDE = new Set(["todo_write", "job_output"]);

/** Deep key-sorted JSON for order-independent arg identity. */
export function canonicalToolArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(sortKeys(args));
  } catch {
    try {
      return JSON.stringify(args);
    } catch {
      return "";
    }
  }
}

export function noteRepeatedToolCall(
  prev: RepeatToolState | null,
  tool: string,
  args: Record<string, unknown>,
): { state: RepeatToolState | null; reminder: string | null } {
  const name = tool.trim();
  if (!name || REPEAT_TOOL_EXCLUDE.has(name)) {
    return { state: prev, reminder: null };
  }
  const argsKey = canonicalToolArgs(args);
  const state: RepeatToolState =
    prev && prev.tool === name && prev.argsKey === argsKey
      ? { tool: name, argsKey, count: prev.count + 1 }
      : { tool: name, argsKey, count: 1 };
  return { state, reminder: reminderForRepeat(state, args) };
}

export function reminderForRepeat(
  state: RepeatToolState,
  args: Record<string, unknown>,
): string | null {
  if (!(REPEAT_TOOL_THRESHOLDS as readonly number[]).includes(state.count)) {
    return null;
  }
  if (state.count === 3) {
    return "【重复工具提醒】你已用相同参数连续调用同一工具 3 次。请先分析上一次结果，再决定换方法或结束任务。";
  }
  const preview = previewArgs(args, REPEAT_TOOL_ARGS_PREVIEW_CHARS);
  return `【重复工具提醒】工具 \`${state.tool}\` 已用相同参数连续调用 ${state.count} 次。\n参数预览：${preview}\n请改变方法、收集新证据，或结束任务；不要无进展地重复同一调用。`;
}

function previewArgs(args: Record<string, unknown>, maxChars: number): string {
  const raw = canonicalToolArgs(args) || "{}";
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}…`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = sortKeys(record[key]);
  }
  return out;
}
