/**
 * Lightweight session goals (DSH get_goal / create_goal / update_goal contract).
 * Continuation wake lives in the desktop host (goal-round driver); this module
 * owns state, prompts, and compare-and-set updates.
 */

import { createId } from "./id.js";

export type AgentGoalPhase = "active" | "paused" | "blocked" | "completed";

export type AgentGoal = {
  id: string;
  revision: number;
  objective: string;
  phase: AgentGoalPhase;
  maxRounds: number;
  roundsStarted: number;
  blockedReason: string | null;
  /** Whether follow-up continuation is armed (active goals default true). */
  continuationArmed: boolean;
  updatedAt: number;
};

export type AgentGoalView = {
  id: string;
  revision: number;
  objective: string;
  phase: AgentGoalPhase;
  roundsStarted: number;
  maxRounds: number;
  blockedReason: string | null;
  continuationArmed: boolean;
};

export function viewGoal(goal: AgentGoal | null): { goal: AgentGoalView | null } {
  if (!goal) return { goal: null };
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxRounds: goal.maxRounds,
      blockedReason: goal.blockedReason,
      continuationArmed: goal.continuationArmed,
    },
  };
}

export function createGoal(
  objective: string,
  maxRounds: number | undefined,
  nowMs = Date.now(),
): { ok: true; goal: AgentGoal } | { ok: false; reason: string } {
  const text = objective.trim();
  if (!text) return { ok: false, reason: "objective 不能为空" };
  if (text.length > 2000) return { ok: false, reason: "objective 过长" };
  let rounds = 20;
  if (typeof maxRounds === "number" && Number.isFinite(maxRounds)) {
    rounds = Math.floor(maxRounds);
  }
  if (rounds < 1 || rounds > 200)
    return { ok: false, reason: "max_goal_rounds 须在 1–200" };
  return {
    ok: true,
    goal: {
      id: createId(nowMs),
      revision: 1,
      objective: text,
      phase: "active",
      maxRounds: rounds,
      roundsStarted: 0,
      blockedReason: null,
      continuationArmed: true,
      updatedAt: nowMs,
    },
  };
}

export type GoalUpdateAction = "edit" | "pause" | "resume" | "complete" | "blocked";

/** Minimum goal rounds before an autonomous Goal Round may self-report blocked (DSH). */
export const BLOCKED_AFTER_CONSECUTIVE_ROUNDS = 3;
export const GOAL_TOOL_BLOCK_THRESHOLD = "GOAL_TOOL_BLOCK_THRESHOLD";
export const GOAL_TOOL_RESUME_PAUSED = "GOAL_TOOL_RESUME_PAUSED";

export type GoalUpdateOptions = {
  /** User-facing `/goal resume` may rearm a durable paused goal. */
  allowPausedResume?: boolean;
  /**
   * When true (autonomous Goal Round), `blocked` is rejected until
   * `roundsStarted >= blockedAfterConsecutiveRounds`. Direct human turns omit this.
   */
  enforceBlockThreshold?: boolean;
  blockedAfterConsecutiveRounds?: number;
};

export function resolveBlockedAfterConsecutiveRounds(value?: number): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
    return value;
  }
  return BLOCKED_AFTER_CONSECUTIVE_ROUNDS;
}

export function updateGoal(
  current: AgentGoal | null,
  input: {
    goalId: string;
    revision: number;
    action: string;
    objective?: string;
    maxRounds?: number;
    blockedReason?: string;
  },
  nowMs = Date.now(),
  options?: GoalUpdateOptions,
): { ok: true; goal: AgentGoal } | { ok: false; reason: string; code?: string } {
  if (!current) return { ok: false, reason: "当前没有 goal" };
  if (current.id !== input.goalId.trim()) {
    return { ok: false, reason: "goal_id 不匹配" };
  }
  if (current.revision !== input.revision) {
    return {
      ok: false,
      reason: `revision 不匹配（当前 ${current.revision}）`,
    };
  }
  const action = input.action.trim().toLowerCase() as GoalUpdateAction;
  if (!["edit", "pause", "resume", "complete", "blocked"].includes(action)) {
    return { ok: false, reason: "action 须为 edit|pause|resume|complete|blocked" };
  }
  const next: AgentGoal = {
    ...current,
    revision: current.revision + 1,
    updatedAt: nowMs,
  };
  if (action === "edit") {
    const objective = input.objective?.trim() ?? "";
    const hasObjective = objective.length > 0;
    let hasRounds = false;
    if (typeof input.maxRounds === "number" && Number.isFinite(input.maxRounds)) {
      const rounds = Math.floor(input.maxRounds);
      if (rounds === 0) {
        // omitted per DSH
      } else if (rounds < 1 || rounds > 200) {
        return { ok: false, reason: "max_goal_rounds 须在 1–200" };
      } else {
        next.maxRounds = rounds;
        hasRounds = true;
      }
    }
    if (hasObjective) next.objective = objective.slice(0, 2000);
    if (!hasObjective && !hasRounds) {
      return { ok: false, reason: "edit 至少需要 objective 或 max_goal_rounds" };
    }
    return { ok: true, goal: next };
  }
  if (action === "pause") {
    next.phase = "paused";
    next.continuationArmed = false;
    return { ok: true, goal: next };
  }
  if (action === "resume") {
    if (current.phase === "completed") {
      return { ok: false, reason: "已完成的 goal 不能 resume" };
    }
    if (current.phase === "paused" && !options?.allowPausedResume) {
      return {
        ok: false,
        reason: "paused goal 须由用户恢复，不能用 update_goal resume",
        code: GOAL_TOOL_RESUME_PAUSED,
      };
    }
    if (current.roundsStarted >= current.maxRounds) {
      return { ok: false, reason: "已达 max_goal_rounds，不能 resume" };
    }
    next.phase = "active";
    next.continuationArmed = true;
    next.blockedReason = null;
    return { ok: true, goal: next };
  }
  if (action === "complete") {
    next.phase = "completed";
    next.continuationArmed = false;
    next.blockedReason = null;
    return { ok: true, goal: next };
  }
  // blocked
  const reason = input.blockedReason?.trim() ?? "";
  if (!reason) return { ok: false, reason: "blocked 需要 blocked_reason" };
  if (options?.enforceBlockThreshold) {
    const threshold = resolveBlockedAfterConsecutiveRounds(
      options.blockedAfterConsecutiveRounds,
    );
    if (current.roundsStarted < threshold) {
      return {
        ok: false,
        reason: `blocked 需要至少连续 ${threshold} 个 Goal Round；当前 roundsStarted=${current.roundsStarted}`,
        code: GOAL_TOOL_BLOCK_THRESHOLD,
      };
    }
  }
  next.phase = "blocked";
  next.continuationArmed = false;
  next.blockedReason = reason.slice(0, 500);
  return { ok: true, goal: next };
}

/** Active + armed + under round cap → host may admit another Goal Round. */
export function shouldContinueGoal(goal: AgentGoal | null | undefined): boolean {
  if (!goal) return false;
  return (
    goal.phase === "active" &&
    goal.continuationArmed &&
    goal.roundsStarted < goal.maxRounds
  );
}

/** Disarm process-local continuation without a durable revision bump. */
export function disarmGoal(goal: AgentGoal): AgentGoal {
  if (!goal.continuationArmed) return goal;
  return { ...goal, continuationArmed: false };
}

/** User-facing prompt injected for an automatic Goal Round. */
export function formatGoalRoundPrompt(goal: AgentGoal): string {
  const nextRound = goal.roundsStarted + 1;
  return [
    `【Goal Round ${nextRound}/${goal.maxRounds}】`,
    `继续推进目标（勿重复已完成的步骤；完成后用 update_goal complete，确需停用用 blocked）：`,
    goal.objective,
  ].join("\n");
}

/** Closing instruction after autonomous complete/blocked (DSH wrapup). */
export function renderGoalWrapup(
  objective: string,
  blockedReason?: string | null,
): string {
  const heading = `Objective: ${JSON.stringify(objective)}`;
  if (!blockedReason) {
    return [
      "<goal_complete>",
      heading,
      "Goal 已标记完成，本轮自动续行结束。请向用户写出收尾说明：结果、已完成与如何验证、具体产物；会话里没有的细节不要编造。不要再调用工具。",
      "</goal_complete>",
    ].join("\n");
  }
  return [
    "<goal_blocked>",
    heading,
    `Blocked: ${JSON.stringify(blockedReason)}`,
    "Goal 已标记阻塞，本轮自动续行结束。请向用户说明已完成部分、具体阻塞与需要用户提供什么；不要再调用工具。",
    "</goal_blocked>",
  ].join("\n");
}

export function goalPolicyHint(blockedAfter = BLOCKED_AFTER_CONSECUTIVE_ROUNDS): string {
  const threshold = resolveBlockedAfterConsecutiveRounds(blockedAfter);
  return `create_goal 可从用户直接请求推断长期目标。会话恢复后 active goal 会 disarm：用户要求继续时用 update_goal resume 重新启用。仅在目标真正达成时 complete；同一阻塞条件持续至少 ${threshold} 个连续 Goal Round 后再 blocked，并写明具体条件；难度或仍可推进的工作不算 blocked。`;
}

/** @deprecated Prefer goalPolicyHint() so the threshold stays in sync with enforcement. */
export const GOAL_POLICY_HINT = goalPolicyHint();

export function formatGoalForPrompt(
  goal: AgentGoal | null,
  blockedAfter = BLOCKED_AFTER_CONSECUTIVE_ROUNDS,
): string {
  const hint = goalPolicyHint(blockedAfter);
  if (!goal) return hint;
  return [
    hint,
    "当前会话 goal：",
    `- id ${goal.id} rev ${goal.revision}`,
    `- ${goal.phase} · ${goal.objective}`,
    `- rounds ${goal.roundsStarted}/${goal.maxRounds}`,
    `- continuation ${goal.continuationArmed ? "armed" : "disarmed"}`,
    goal.blockedReason ? `- blocker: ${goal.blockedReason}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Human-facing `/goal` status (no branded ids). */
export function formatGoalStatus(goal: AgentGoal | null): string {
  if (!goal) {
    return [
      "当前没有 goal。",
      "用法：",
      "/goal <目标> — 创建",
      "/goal edit <目标> — 编辑",
      "/goal pause | resume | clear",
    ].join("\n");
  }
  const lines = [
    `目标：${goal.objective}`,
    `状态：${goal.phase} · 续行 ${goal.continuationArmed ? "已启用" : "已停用"}`,
    `Round：${goal.roundsStarted}/${goal.maxRounds}`,
  ];
  if (goal.blockedReason) lines.push(`阻塞：${goal.blockedReason}`);
  const next: string[] = [];
  if (goal.phase === "active") next.push("pause", "edit <目标>", "clear");
  if (goal.phase === "paused" || (goal.phase === "active" && !goal.continuationArmed)) {
    next.push("resume");
  }
  if (goal.phase === "blocked") next.push("resume", "clear");
  if (goal.phase === "completed") next.push("<新目标> 可替换", "clear");
  if (next.length) lines.push(`下一步：/goal ${next.join(" · /goal ")}`);
  return lines.join("\n");
}

export type GoalSlashRequest =
  | { kind: "status" }
  | { kind: "create"; objective: string }
  | { kind: "edit"; objective: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" };

/**
 * Parse `/goal` args. Control words only match when they fill the whole suffix;
 * any other non-empty text is an objective (DSH command-goal).
 */
export function parseGoalSlash(args: string): GoalSlashRequest {
  const text = args.trim();
  if (!text) return { kind: "status" };
  const folded = text.toLowerCase();
  if (folded === "pause") return { kind: "pause" };
  if (folded === "resume") return { kind: "resume" };
  if (folded === "clear") return { kind: "clear" };
  const edit = /^(?:edit)\s+([\s\S]+)$/i.exec(text);
  if (edit?.[1]?.trim()) return { kind: "edit", objective: edit[1].trim() };
  if (/^edit$/i.test(text)) return { kind: "status" };
  return { kind: "create", objective: text };
}

/** Apply a `/goal` request; returns UI text and optional next goal state. */
export function applyGoalSlash(
  current: AgentGoal | null,
  request: GoalSlashRequest,
  nowMs = Date.now(),
): { ok: true; text: string; goal: AgentGoal | null } | { ok: false; text: string } {
  if (request.kind === "status") {
    return { ok: true, text: formatGoalStatus(current), goal: current };
  }
  if (request.kind === "create") {
    if (current && current.phase !== "completed") {
      return {
        ok: false,
        text: "已有未完成 goal。先 /goal pause、/goal clear，或 /goal edit <目标>。",
      };
    }
    const created = createGoal(request.objective, undefined, nowMs);
    if (created.ok === false) return { ok: false, text: created.reason };
    return {
      ok: true,
      text: `已创建 goal 并启用续行。\n${formatGoalStatus(created.goal)}`,
      goal: created.goal,
    };
  }
  if (request.kind === "edit") {
    if (!current || current.phase === "completed") {
      return { ok: false, text: "没有可编辑的 goal。用 /goal <目标> 创建。" };
    }
    const edited = updateGoal(
      current,
      {
        goalId: current.id,
        revision: current.revision,
        action: "edit",
        objective: request.objective,
      },
      nowMs,
    );
    if (edited.ok === false) return { ok: false, text: edited.reason };
    return {
      ok: true,
      text: `已更新目标。\n${formatGoalStatus(edited.goal)}`,
      goal: edited.goal,
    };
  }
  if (request.kind === "pause") {
    if (!current || current.phase !== "active") {
      return { ok: false, text: "只能暂停 active goal。" };
    }
    const paused = updateGoal(
      current,
      { goalId: current.id, revision: current.revision, action: "pause" },
      nowMs,
    );
    if (paused.ok === false) return { ok: false, text: paused.reason };
    return {
      ok: true,
      text: `已暂停。\n${formatGoalStatus(paused.goal)}`,
      goal: paused.goal,
    };
  }
  if (request.kind === "resume") {
    if (!current) return { ok: false, text: "当前没有 goal。" };
    if (current.phase === "completed") {
      return { ok: false, text: "已完成的 goal 不能 resume。" };
    }
    const resumed = updateGoal(
      current,
      { goalId: current.id, revision: current.revision, action: "resume" },
      nowMs,
      { allowPausedResume: true },
    );
    if (resumed.ok === false) return { ok: false, text: resumed.reason };
    return {
      ok: true,
      text: `已恢复续行。\n${formatGoalStatus(resumed.goal)}`,
      goal: resumed.goal,
    };
  }
  // clear
  if (!current) return { ok: false, text: "当前没有 goal。" };
  return { ok: true, text: "已清除 goal。", goal: null };
}
