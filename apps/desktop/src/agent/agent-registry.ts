/**
 * In-process managed subagent registry (light DSH subagent-control).
 */

export type ManagedAgentStatus = "running" | "inactive" | "interrupted";

export type ManagedAgentRecord = {
  id: string;
  parentThreadId: string;
  name: string;
  status: ManagedAgentStatus;
  depth: number;
  controller: AbortController;
  /** Queued follow-ups accepted while running or before resume. */
  inbox: string[];
  resultText: string | null;
  pendingNotice: string | null;
  createdAt: number;
};

export type ManagedAgentView = {
  id: string;
  parentThreadId: string;
  name: string;
  status: ManagedAgentStatus;
  depth: number;
  inbox: number;
  resultText: string | null;
};

const agents = new Map<string, ManagedAgentRecord>();

export function registerManagedAgent(input: {
  id: string;
  parentThreadId: string;
  name: string;
  depth: number;
  controller?: AbortController;
  nowMs?: number;
}): ManagedAgentRecord {
  const existing = agents.get(input.id);
  if (existing) {
    existing.controller.abort();
  }
  const record: ManagedAgentRecord = {
    id: input.id,
    parentThreadId: input.parentThreadId,
    name: input.name,
    status: "running",
    depth: input.depth,
    controller: input.controller ?? new AbortController(),
    inbox: [],
    resultText: null,
    pendingNotice: null,
    createdAt: input.nowMs ?? Date.now(),
  };
  agents.set(record.id, record);
  return record;
}

export function getManagedAgent(id: string): ManagedAgentRecord | null {
  return agents.get(id.trim()) ?? null;
}

export function listManagedAgents(
  parentThreadId: string,
  scope: "children" | "descendants" = "children",
): ManagedAgentView[] {
  const parent = parentThreadId.trim();
  if (!parent) return [];
  if (scope === "children") {
    return [...agents.values()]
      .filter((agent) => agent.parentThreadId === parent)
      .map(viewOf)
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  const out: ManagedAgentView[] = [];
  const walk = (pid: string, depth: number) => {
    for (const agent of agents.values()) {
      if (agent.parentThreadId !== pid) continue;
      out.push({ ...viewOf(agent), depth });
      walk(agent.id, depth + 1);
    }
  };
  walk(parent, 1);
  return out;
}

export function interruptManagedAgent(
  agentId: string,
  callerThreadId: string,
): { ok: true; agent: ManagedAgentView } | { ok: false; reason: string } {
  const agent = agents.get(agentId.trim());
  if (!agent) return { ok: false, reason: "未知子智能体" };
  if (callerThreadId !== agent.parentThreadId) {
    return { ok: false, reason: "只能中断自己的直接子智能体" };
  }
  if (agent.status === "running") {
    agent.controller.abort();
    agent.status = "interrupted";
  }
  return { ok: true, agent: viewOf(agent) };
}

export function sendManagedAgentMessage(
  agentId: string,
  callerThreadId: string,
  text: string,
):
  | { ok: true; messageId: string; agent: ManagedAgentView }
  | { ok: false; reason: string } {
  const body = text.trim();
  if (!body) return { ok: false, reason: "消息不能为空" };
  const agent = agents.get(agentId.trim());
  if (!agent) return { ok: false, reason: "未知子智能体" };
  if (callerThreadId !== agent.parentThreadId && callerThreadId !== agent.id) {
    return { ok: false, reason: "只能向直接子级或自己发消息" };
  }
  if (callerThreadId === agent.id) {
    // Child → parent relay is accepted into parent inbox via a synthetic parent record? Skip; only parent→child.
    return { ok: false, reason: "当前仅支持父级向子级发消息" };
  }
  if (agent.status === "interrupted") {
    return { ok: false, reason: "子智能体已中断，不能再发消息" };
  }
  const messageId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  agent.inbox.push(body);
  return { ok: true, messageId, agent: viewOf(agent) };
}

export function takeManagedAgentInbox(agentId: string): string[] {
  const agent = agents.get(agentId.trim());
  if (!agent || !agent.inbox.length) return [];
  const out = agent.inbox.slice();
  agent.inbox = [];
  return out;
}

export function completeManagedAgent(
  agentId: string,
  resultText: string,
  notice: string,
): void {
  const agent = agents.get(agentId.trim());
  if (!agent) return;
  agent.status = agent.status === "interrupted" ? "interrupted" : "inactive";
  agent.resultText = resultText;
  agent.pendingNotice = notice;
}

export function takePendingAgentNotices(threadId: string): string[] {
  const out: string[] = [];
  for (const agent of agents.values()) {
    if (agent.parentThreadId !== threadId || !agent.pendingNotice) continue;
    out.push(agent.pendingNotice);
    agent.pendingNotice = null;
  }
  return out;
}

export function removeManagedAgent(agentId: string): void {
  const agent = agents.get(agentId.trim());
  if (!agent) return;
  agent.controller.abort();
  agents.delete(agent.id);
}

function viewOf(agent: ManagedAgentRecord): ManagedAgentView {
  return {
    id: agent.id,
    parentThreadId: agent.parentThreadId,
    name: agent.name,
    status: agent.status,
    depth: agent.depth,
    inbox: agent.inbox.length,
    resultText: agent.resultText,
  };
}
