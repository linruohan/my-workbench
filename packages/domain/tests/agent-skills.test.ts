import { describe, expect, it } from "vitest";
import {
  addSkillSourceDir,
  buildAgentSystemPrompt,
  BUILTIN_MODEL_REF,
  dedupeSkillNames,
  discoverSkillsFromSnapshot,
  findSkill,
  formatInvokedSkills,
  formatSkillsForPrompt,
  gateTool,
  invokedSkillsInText,
  listEnabledSkillSummaries,
  parseSkillMarkdown,
  removeSkillSourceDir,
  acceptSkillSlashToken,
  collapseSkillTokenOnDelete,
  enabledSkills,
  setSkillEnabled,
  skillComposerTokens,
  stripSkillPickMarks,
  setSkillSourceDirEnabled,
  skillIdFromDirPath,
  toolsForMode,
  type SkillSourceDir,
} from "../src/index.js";

const now = new Date(2026, 10, 3, 12, 0, 0).getTime();

const source = (path: string, id = "src1"): SkillSourceDir => ({
  id,
  path,
  enabled: true,
  addedAt: now,
});

describe("skill source dirs", () => {
  it("adds, rejects duplicates, toggles, and removes roots", () => {
    const first = addSkillSourceDir([], "D:\\skills", now);
    expect(first.added?.path).toBe("D:\\skills");
    expect(first.roots).toHaveLength(1);

    const dup = addSkillSourceDir(first.roots, "d:/skills", now + 1);
    expect(dup.added).toBeNull();
    expect(dup.reason).toBe("该目录已添加");

    const off = setSkillSourceDirEnabled(first.roots, first.added!.id, false);
    const skill = {
      id: "skill:weekly",
      name: "weekly",
      description: "周报",
      dirPath: "D:\\skills\\weekly",
      sourceDirId: first.added!.id,
      body: "",
    };
    const disabled = setSkillEnabled([], skill.id, false);
    expect(enabledSkills([skill], disabled)).toEqual([]);
    expect(enabledSkills([skill], setSkillEnabled(disabled, skill.id, true))).toEqual([
      skill,
    ]);
    const closed = { ...skill, enabled: false };
    expect(listEnabledSkillSummaries([closed])).toEqual([]);
    expect(invokedSkillsInText([closed], "请用 /weekly")).toEqual([]);
    expect(
      invokedSkillsInText([{ ...skill, enabled: true }], "请用 /weekly"),
    ).toHaveLength(1);
    const pptx = [{ name: "pptx", description: "幻灯片" }];
    const picked = acceptSkillSlashToken("", "pptx");
    expect(skillComposerTokens("/pptx", pptx)).toEqual([]);
    expect(skillComposerTokens(picked, pptx)).toEqual([{ start: 0, end: 5 }]);
    expect(stripSkillPickMarks(picked)).toBe("/pptx ");
    expect(
      collapseSkillTokenOnDelete(picked, picked.length, picked.length, "Backspace", pptx),
    ).toBeNull();
    expect(
      collapseSkillTokenOnDelete(
        picked,
        picked.length - 1,
        picked.length - 1,
        "Backspace",
        pptx,
      ),
    ).toEqual({
      text: "/ ",
      caret: 1,
    });
    expect(collapseSkillTokenOnDelete("/pptx", 5, 5, "Backspace", pptx)).toBeNull();
    expect(off[0]?.enabled).toBe(false);

    expect(removeSkillSourceDir(off, first.added!.id)).toEqual([]);
  });
});

describe("parseSkillMarkdown", () => {
  it("reads Cursor-style frontmatter", () => {
    const parsed = parseSkillMarkdown(
      `---
name: weekly-report
description: 汇总本周任务并起草周报
---

# 周报

先列出完成项。
`,
      "folder",
    );
    expect(parsed).toEqual({
      name: "weekly-report",
      description: "汇总本周任务并起草周报",
      body: "# 周报\n\n先列出完成项。",
    });
  });

  it("falls back to folder name and first heading when meta is missing", () => {
    const parsed = parseSkillMarkdown("# 整理收件箱\n\n把未排期任务排到今天。", "inbox");
    expect(parsed.name).toBe("inbox");
    expect(parsed.description).toBe("整理收件箱");
    expect(parsed.body).toContain("把未排期任务排到今天");
  });
});

describe("discoverSkillsFromSnapshot", () => {
  it("picks a skill at the root and in child folders", () => {
    const skills = discoverSkillsFromSnapshot(source("D:\\skills"), {
      rootSkillMd: `---
name: root-pack
description: 根目录技能
---
正文
`,
      children: [
        {
          name: "weekly",
          path: "D:\\skills\\weekly",
          skillMd: `---
name: weekly
description: 周报流程
---
步骤
`,
        },
        { name: "empty", path: "D:\\skills\\empty", skillMd: null },
      ],
    });
    expect(skills.map((item) => item.name).sort()).toEqual(["root-pack", "weekly"]);
    expect(skills.every((item) => item.sourceDirId === "src1")).toBe(true);
    expect(skillIdFromDirPath("D:\\skills\\weekly")).toBe(
      skills.find((item) => item.name === "weekly")?.id,
    );
  });

  it("skips disabled source dirs", () => {
    const disabled = { ...source("D:\\skills"), enabled: false };
    expect(
      discoverSkillsFromSnapshot(disabled, {
        rootSkillMd: "---\nname: x\ndescription: y\n---\n",
        children: [],
      }),
    ).toEqual([]);
  });

  it("dedupes colliding names and finds by name", () => {
    const skills = dedupeSkillNames([
      {
        id: "a",
        name: "pack",
        description: "一",
        dirPath: "D:\\a",
        sourceDirId: "1",
        body: "a",
      },
      {
        id: "b",
        name: "pack",
        description: "二",
        dirPath: "D:\\b",
        sourceDirId: "1",
        body: "b",
      },
    ]);
    expect(skills.map((item) => item.name)).toEqual(["pack", "pack-2"]);
    expect(findSkill(skills, "pack-2")?.body).toBe("b");
  });
});

describe("skills in agent surface", () => {
  it("formats prompt lines and wires skill tools as read-only", () => {
    const block = formatSkillsForPrompt([
      {
        id: "skill:x",
        name: "weekly",
        description: "周报",
        dirPath: "D:\\skills\\weekly",
      },
    ]);
    expect(block).toContain("skill_load");
    expect(block).toContain("- /weekly：周报");

    const prompt = buildAgentSystemPrompt({
      todaySummary: "",
      focus: null,
      unread: 0,
      modelRef: BUILTIN_MODEL_REF,
      permissionMode: "confirm",
      skillsPrompt: block,
    });
    expect(prompt).toContain("- /weekly：周报");
    expect(
      formatInvokedSkills(
        [
          {
            id: "skill:x",
            name: "weekly",
            description: "周报",
            dirPath: "D:\\skills\\weekly",
            sourceDirId: "1",
            body: "先列本周完成项。",
          },
        ],
        "请用 /weekly 写一下",
      ),
    ).toContain("先列本周完成项。");
    const named = [
      {
        id: "skill:preview",
        name: "preview",
        description: "预览",
        dirPath: "D:\\skills\\preview",
        sourceDirId: "1",
        body: "先看差异。",
      },
    ];
    expect(invokedSkillsInText(named, "请看 /review")).toEqual([]);
    expect(invokedSkillsInText(named, "请看 /preview").map((item) => item.name)).toEqual([
      "preview",
    ]);

    expect(gateTool("readonly", "skill_list")).toBe("run");
    expect(gateTool("readonly", "skill_load")).toBe("run");
    expect(toolsForMode("readonly").some((tool) => tool.name === "skill_load")).toBe(
      true,
    );
  });
});
