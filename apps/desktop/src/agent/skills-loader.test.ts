import { describe, expect, it } from "vitest";
import {
  dedupeSkillNames,
  discoverSkillsFromSnapshot,
  findSkill,
  formatSkillsForPrompt,
  type SkillSourceDir,
} from "@wb/domain";
import { executeAgentTool } from "./execute";
import { MemoryWorkbenchRepository } from "@wb/db/memory";

const now = new Date(2026, 10, 3, 12, 0, 0).getTime();

const source: SkillSourceDir = {
  id: "src1",
  path: "D:\\skills",
  enabled: true,
  addedAt: now,
};

describe("agent skill tools", () => {
  it("lists and loads skills from the runtime registry", () => {
    const skills = dedupeSkillNames(
      discoverSkillsFromSnapshot(source, {
        rootSkillMd: null,
        children: [
          {
            name: "weekly",
            path: "D:\\skills\\weekly",
            skillMd: `---
name: weekly-report
description: 起草周报
---
# 步骤
1. 列出本周完成项
`,
          },
        ],
      }),
    );
    const store = new MemoryWorkbenchRepository();
    const thread = store.createAgentThread({ nowMs: now });
    const ctx = {
      nowMs: now,
      threadId: thread.id,
      displayName: "本地用户",
      timer: { taskId: null, startedAt: null },
      skills,
    };

    const listed = executeAgentTool(store, "skill_list", {}, ctx);
    expect(listed.ok).toBe(true);
    expect(listed.summary).toContain("1 个技能");
    expect(listed.data).toMatchObject({
      skills: [{ name: "weekly-report", description: "起草周报" }],
    });

    const loaded = executeAgentTool(store, "skill_load", { name: "weekly-report" }, ctx);
    expect(loaded.ok).toBe(true);
    expect(String((loaded.data as { body: string }).body)).toContain("列出本周完成项");
    expect(findSkill(skills, "weekly-report")?.description).toBe("起草周报");
    expect(formatSkillsForPrompt(skills)).toContain("weekly-report");
  });

  it("returns a clear error when the skill is missing", () => {
    const store = new MemoryWorkbenchRepository();
    const thread = store.createAgentThread({ nowMs: now });
    const result = executeAgentTool(
      store,
      "skill_load",
      { name: "missing" },
      {
        nowMs: now,
        threadId: thread.id,
        displayName: "本地用户",
        timer: { taskId: null, startedAt: null },
        skills: [],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("未找到技能");
  });
});
