import {
  describeToolResult,
  relativizeScheduleText,
  toolCallSummary,
  toolResultLabel,
  toolResultPreview,
  type AgentMessage,
  type PlannedCall,
} from "@wb/domain";

export type AgentTurnPiece = {
  id: string;
  kind: "prose" | "tool";
  /** Short category chip, e.g. 任务 / 笔记. */
  label: string;
  /** One-line action summary for the collapsed tool row. */
  summary: string;
  text: string;
};

export function parsePlannedCalls(json: string | null | undefined): PlannedCall[] {
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
          ? (call.args as Record<string, unknown>)
          : {};
      return [{ id: call.id, name: call.name, args }];
    });
  } catch {
    return [];
  }
}

/** Split an agent turn into prose and collapsible tool rows. */
export function agentTurnPieces(
  messages: AgentMessage[],
  nowMs: number,
): AgentTurnPiece[] {
  const callById = new Map<string, PlannedCall>();
  const plannedSummaries = new Set<string>();
  for (const message of messages) {
    for (const call of parsePlannedCalls(message.toolCallsJson)) {
      callById.set(call.id, call);
      plannedSummaries.add(toolCallSummary(call.name, call.args));
    }
  }

  const pieces: AgentTurnPiece[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const text = displayToolText(message, nowMs);
      if (!text) continue;
      const call = message.toolCallId ? callById.get(message.toolCallId) : undefined;
      const summary = call
        ? toolCallSummary(call.name, call.args)
        : toolResultPreview(text) || toolResultLabel(message.toolName ?? "") || "工具";
      pieces.push({
        id: message.id,
        kind: "tool",
        label: toolResultLabel(message.toolName ?? "") || "工具",
        summary,
        text,
      });
      continue;
    }
    if (message.role !== "assistant") continue;
    const text = relativizeScheduleText(message.content, nowMs).trim();
    if (!text) continue;
    if (message.toolCallsJson && isOnlyPlannedSummaries(text, plannedSummaries)) {
      // Tool rows already carry the action line; skip the duplicate prose.
      continue;
    }
    const last = pieces[pieces.length - 1];
    if (last?.kind === "prose") last.text = `${last.text}\n\n${text}`;
    else pieces.push({ id: message.id, kind: "prose", label: "", summary: "", text });
  }
  return pieces;
}

function isOnlyPlannedSummaries(text: string, planned: ReadonlySet<string>): boolean {
  if (!planned.size) return false;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => planned.has(line));
}

function displayToolText(message: AgentMessage, nowMs: number): string {
  let text = message.content;
  const splitAt = text.indexOf("\n");
  if (splitAt >= 0) {
    const summary = text.slice(0, splitAt);
    const rest = text.slice(splitAt + 1).trim();
    if (rest.startsWith("{")) {
      try {
        text = describeToolResult(message.toolName ?? "", JSON.parse(rest), summary);
      } catch {
        text = message.content;
      }
    }
  }
  return relativizeScheduleText(text, nowMs).replace(/^· /gm, "- ");
}
