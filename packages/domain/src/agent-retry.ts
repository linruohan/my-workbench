import type { AgentMessage } from "./agent.js";

/**
 * The latest user line can be sent again when the reply after it did not call tools.
 * Tool calls may already have written tasks or notes, so those turns stay put.
 */
export function agentRetryPlan(
  messages: readonly AgentMessage[],
): { userMessageId: string; text: string } | null {
  let lastUser = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") lastUser = index;
  }
  if (lastUser < 0) return null;
  const user = messages[lastUser];
  if (!user) return null;
  const text = user.content.trim();
  if (!text) return null;
  const tail = messages.slice(lastUser + 1);
  if (tail.length === 0) return null;
  if (tail.some((message) => message.role === "tool" || message.toolCallsJson))
    return null;
  return { userMessageId: user.id, text };
}
