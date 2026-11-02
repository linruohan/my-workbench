import type { AgentMessage } from "./agent.js";

export type AgentTurnEdit = { userMessageId: string; text: string };

/**
 * The latest user line can be edited when nothing after it called a tool.
 * A reply is optional, so a just-sent line can come back to the composer.
 */
export function agentEditPlan(messages: readonly AgentMessage[]): AgentTurnEdit | null {
  const turn = latestUserTurn(messages);
  if (!turn || !turn.editable) return null;
  return { userMessageId: turn.user.id, text: turn.text };
}

/**
 * The latest user line can be sent again when the reply after it did not call tools.
 * Tool calls may already have written tasks or notes, so those turns stay put.
 */
export function agentRetryPlan(messages: readonly AgentMessage[]): AgentTurnEdit | null {
  const turn = latestUserTurn(messages);
  if (!turn || !turn.editable || turn.tail.length === 0) return null;
  return { userMessageId: turn.user.id, text: turn.text };
}

function latestUserTurn(messages: readonly AgentMessage[]): {
  user: AgentMessage;
  text: string;
  tail: readonly AgentMessage[];
  editable: boolean;
} | null {
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
  return {
    user,
    text,
    tail,
    editable: !tail.some((message) => message.role === "tool" || message.toolCallsJson),
  };
}
