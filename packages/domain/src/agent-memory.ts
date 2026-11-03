/** Cross-session facts kept on this machine. Not a transcript. */

import { createId } from "./id.js";

export type AgentMemory = {
  id: string;
  text: string;
  createdAt: number;
};

export const MEMORY_TEXT_MAX = 500;
export const MEMORY_COUNT_MAX = 40;

export function addAgentMemory(
  list: readonly AgentMemory[],
  text: string,
  nowMs = Date.now(),
): { memories: AgentMemory[]; added: AgentMemory | null; reason?: string } {
  const trimmed = text.trim().slice(0, MEMORY_TEXT_MAX);
  if (!trimmed) return { memories: [...list], added: null, reason: "记忆不能为空" };
  if (list.some((item) => item.text === trimmed)) {
    return { memories: [...list], added: null, reason: "这条记忆已经有了" };
  }
  if (list.length >= MEMORY_COUNT_MAX) {
    return {
      memories: [...list],
      added: null,
      reason: `最多保留 ${MEMORY_COUNT_MAX} 条记忆`,
    };
  }
  const added: AgentMemory = { id: createId(nowMs), text: trimmed, createdAt: nowMs };
  return { memories: [...list, added], added };
}

export function removeAgentMemory(
  list: readonly AgentMemory[],
  id: string,
): AgentMemory[] {
  return list.filter((item) => item.id !== id);
}

/** Remove by id, or by a case-insensitive substring of the text. */
export function forgetAgentMemory(
  list: readonly AgentMemory[],
  query: string,
): { memories: AgentMemory[]; removed: number } {
  const needle = query.trim();
  if (!needle) return { memories: [...list], removed: 0 };
  const byId = list.filter((item) => item.id === needle);
  if (byId.length) {
    return { memories: list.filter((item) => item.id !== needle), removed: byId.length };
  }
  const folded = needle.toLowerCase();
  const kept = list.filter((item) => !item.text.toLowerCase().includes(folded));
  return { memories: kept, removed: list.length - kept.length };
}

export function formatMemoriesForPrompt(list: readonly AgentMemory[]): string {
  if (list.length === 0) return "";
  const lines = list.map((item) => `- ${item.text}`);
  return ["跨会话记忆（只在本机，可用 memory_forget 删除）：", ...lines].join("\n");
}
