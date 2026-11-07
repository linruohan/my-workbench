import { describe, expect, it } from "vitest";
import {
  applyGoalSlash,
  BLOCKED_AFTER_CONSECUTIVE_ROUNDS,
  createGoal,
  disarmGoal,
  formatGoalRoundPrompt,
  GOAL_TOOL_BLOCK_THRESHOLD,
  goalPolicyHint,
  parseGoalSlash,
  renderGoalWrapup,
  shouldContinueGoal,
  updateGoal,
  viewGoal,
} from "../src/index.js";

describe("agent goal", () => {
  it("creates and updates with revision checks", () => {
    const created = createGoal("修好登录", 5, 1);
    expect(created.ok).toBe(true);
    if (created.ok === false) return;
    expect(viewGoal(created.goal).goal?.phase).toBe("active");
    const edited = updateGoal(
      created.goal,
      {
        goalId: created.goal.id,
        revision: 1,
        action: "edit",
        objective: "修好登录并补测试",
      },
      2,
    );
    expect(edited.ok).toBe(true);
    if (edited.ok === false) return;
    expect(edited.goal.revision).toBe(2);
    expect(edited.goal.objective).toContain("测试");
    const stale = updateGoal(edited.goal, {
      goalId: edited.goal.id,
      revision: 1,
      action: "complete",
    });
    expect(stale.ok).toBe(false);
    const done = updateGoal(edited.goal, {
      goalId: edited.goal.id,
      revision: 2,
      action: "complete",
    });
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.goal.phase).toBe("completed");
  });

  it("rejects model resume of paused goals and supports continuation helpers", () => {
    const created = createGoal("迁数据库", 3, 1);
    expect(created.ok).toBe(true);
    if (created.ok === false) return;
    expect(shouldContinueGoal(created.goal)).toBe(true);
    const paused = updateGoal(
      created.goal,
      { goalId: created.goal.id, revision: 1, action: "pause" },
      2,
    );
    expect(paused.ok).toBe(true);
    if (paused.ok === false) return;
    expect(shouldContinueGoal(paused.goal)).toBe(false);
    const denied = updateGoal(paused.goal, {
      goalId: paused.goal.id,
      revision: 2,
      action: "resume",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok === false) expect(denied.code).toBe("GOAL_TOOL_RESUME_PAUSED");
    const resumed = updateGoal(
      paused.goal,
      { goalId: paused.goal.id, revision: 2, action: "resume" },
      3,
      { allowPausedResume: true },
    );
    expect(resumed.ok).toBe(true);
    if (resumed.ok === false) return;
    expect(shouldContinueGoal(resumed.goal)).toBe(true);
    expect(formatGoalRoundPrompt(resumed.goal)).toContain("Goal Round");
    expect(renderGoalWrapup("迁数据库")).toContain("goal_complete");
    expect(disarmGoal(resumed.goal).continuationArmed).toBe(false);
  });

  it("enforces blockedAfterConsecutiveRounds on autonomous Goal Rounds", () => {
    const created = createGoal("修掉 flaky 测试", 10, 1);
    expect(created.ok).toBe(true);
    if (created.ok === false) return;
    const early = updateGoal(
      created.goal,
      {
        goalId: created.goal.id,
        revision: 1,
        action: "blocked",
        blockedReason: "缺登录凭证",
      },
      2,
      { enforceBlockThreshold: true },
    );
    expect(early.ok).toBe(false);
    if (early.ok === false) {
      expect(early.code).toBe(GOAL_TOOL_BLOCK_THRESHOLD);
      expect(early.reason).toContain(String(BLOCKED_AFTER_CONSECUTIVE_ROUNDS));
    }
    const matured = {
      ...created.goal,
      roundsStarted: BLOCKED_AFTER_CONSECUTIVE_ROUNDS,
    };
    const blocked = updateGoal(
      matured,
      {
        goalId: matured.id,
        revision: matured.revision,
        action: "blocked",
        blockedReason: "缺登录凭证",
      },
      3,
      { enforceBlockThreshold: true },
    );
    expect(blocked.ok).toBe(true);
    if (blocked.ok) expect(blocked.goal.phase).toBe("blocked");
    const human = updateGoal(
      created.goal,
      {
        goalId: created.goal.id,
        revision: 1,
        action: "blocked",
        blockedReason: "用户叫停",
      },
      4,
    );
    expect(human.ok).toBe(true);
    expect(goalPolicyHint()).toContain(String(BLOCKED_AFTER_CONSECUTIVE_ROUNDS));
  });

  it("parses and applies /goal slash requests", () => {
    expect(parseGoalSlash("")).toEqual({ kind: "status" });
    expect(parseGoalSlash("pause")).toEqual({ kind: "pause" });
    expect(parseGoalSlash("pause after verify")).toEqual({
      kind: "create",
      objective: "pause after verify",
    });
    expect(parseGoalSlash("edit 修好测试")).toEqual({
      kind: "edit",
      objective: "修好测试",
    });
    const created = applyGoalSlash(null, { kind: "create", objective: "修好登录" }, 1);
    expect(created.ok).toBe(true);
    if (created.ok === false) return;
    expect(created.goal?.phase).toBe("active");
    const status = applyGoalSlash(created.goal, { kind: "status" });
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.text).toContain("修好登录");
    const paused = applyGoalSlash(created.goal, { kind: "pause" }, 2);
    expect(paused.ok).toBe(true);
    if (paused.ok === false) return;
    expect(paused.goal?.phase).toBe("paused");
    const resumed = applyGoalSlash(paused.goal, { kind: "resume" }, 3);
    expect(resumed.ok).toBe(true);
    if (resumed.ok === false) return;
    expect(resumed.goal?.continuationArmed).toBe(true);
    const cleared = applyGoalSlash(resumed.goal, { kind: "clear" }, 4);
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.goal).toBeNull();
  });
});
