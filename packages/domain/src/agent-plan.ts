import { addLocalDays, formatLocalDay, parseLocalDay } from "./date.js";
import { createId } from "./id.js";
import { parseQuickCapture } from "./quick-capture.js";
import type { ReminderOptionId } from "./types.js";
import type { AgentTurnPlan, PlannedCall } from "./agent.js";

export interface PlannerContext {
  nowMs: number;
  tasks: Array<{ id: string; title: string; isDone: boolean }>;
  projects: Array<{ id: string; title: string }>;
}

const HELP = [
  "我可以帮你管理本机工作台。例如：",
  "· 今天有什么",
  "· 创建任务 写周报，排到明天并提前15分钟提醒",
  "· 完成 写周报",
  "· 新建笔记 会议纪要",
  "· 打开今日",
  "· 记住 周五写周报",
].join("\n");

export function planLocalTurn(input: string, ctx: PlannerContext): AgentTurnPlan {
  const text = input.trim();
  if (!text) return { text: "请告诉我你想做什么。", calls: [] };
  const parts = text
    .split(/(?:[，,]\s*)?(?:然后|接着)\s*/)
    .map((part) => part.replace(/[，,\s]+$/g, "").trim())
    .filter(Boolean)
    .slice(0, 6);
  if (parts.length > 1) {
    const plans = parts.map((part) => planClause(part, ctx));
    return {
      text: plans
        .map((plan) => plan.text)
        .filter(Boolean)
        .join("\n"),
      calls: plans.flatMap((plan) => plan.calls),
    };
  }
  return planClause(text, ctx);
}

function planClause(raw: string, ctx: PlannerContext): AgentTurnPlan {
  const text = raw.replace(/^(?:(?:请|帮我|给我|麻烦你?)\s*)+/, "").trim();
  if (/^(帮助|你能做什么|help|\?|？)$/i.test(text)) {
    return { text: HELP, calls: [] };
  }
  const remember = /^(?:记住|记一下|请记住)\s*[:：]?\s*(.+)$/.exec(text);
  if (remember?.[1]?.trim()) {
    return {
      text: "准备记下这条。",
      calls: [call("memory_save", { text: remember[1].trim() })],
    };
  }
  const forget = /^(?:忘记|忘掉|删除记忆)\s*[:：]?\s*(.+)$/.exec(text);
  if (forget?.[1]?.trim()) {
    return {
      text: "准备删除匹配的记忆。",
      calls: [call("memory_forget", { text: forget[1].trim() })],
    };
  }
  if (/^(?:有哪些记忆|我的记忆|记忆列表)$/.test(text)) {
    return { text: "正在查看记忆。", calls: [call("memory_list", {})] };
  }
  if (/^(?:有哪些技能|技能列表)$/.test(text)) {
    return { text: "正在查看技能。", calls: [call("skill_list", {})] };
  }
  if (/^(?:有哪些插件|插件列表)$/.test(text)) {
    return { text: "正在查看插件。", calls: [call("plugin_list", {})] };
  }
  if (/^(晨报|今日简报|今天简报)$/.test(text)) {
    return {
      text: "正在整理今日简报。",
      calls: [call("task_list_today", {}), call("notification_list", {})],
    };
  }
  if (isTodayQuery(text)) {
    return { text: "正在查看今日任务。", calls: [call("task_list_today", {})] };
  }
  if (/^(列出任务|全部任务|未完成任务|list tasks)$/i.test(text)) {
    return { text: "正在查看未完成任务。", calls: [call("task_list", {})] };
  }
  if (/^(项目列表|有哪些项目|列出项目)$/.test(text)) {
    return { text: "正在查看项目。", calls: [call("project_list", {})] };
  }
  if (/^(通知|未读通知|通知列表)$/.test(text)) {
    return { text: "正在查看通知。", calls: [call("notification_list", {})] };
  }

  const open = /^(?:打开|前往|切到)\s*(.+)$/.exec(text);
  if (open) {
    const view = viewName(open[1]!.trim());
    if (view) {
      return { text: `正在打开${open[1]!.trim()}。`, calls: [call("ui_open", { view })] };
    }
  }

  const remove = /^(?:删除|删掉|移除)(?:任务)?[:：\s]+(.+)$/.exec(text);
  if (remove) return taskVerb("task_delete", remove[1]!, ctx, "删除");

  const reopen = /^(?:重新打开|取消完成|恢复)(?:任务)?[:：\s]+(.+)$/.exec(text);
  if (reopen) return taskVerb("task_reopen", reopen[1]!, ctx, "重新打开");

  const done = /^(?:完成|做完|勾选)(?:任务)?[:：\s]*(.+)$/.exec(text);
  if (done?.[1]?.trim()) return taskVerb("task_complete", done[1]!, ctx, "完成");

  const doneTail = /^(?:把|将)\s*(.+?)\s*(?:标为|标记为|设为)?完成$/.exec(text);
  if (doneTail?.[1]?.trim()) return taskVerb("task_complete", doneTail[1]!, ctx, "完成");

  const backlog = /^(?:把|将)\s*(.+?)\s*(?:放进|移到|丢到)待办$/.exec(text);
  if (backlog) return taskVerb("task_move_backlog", backlog[1]!, ctx, "移入待办");

  const schedule = /^(?:把|将)\s*(.+?)\s*(?:排到|安排到|改到|移到)\s*(.+)$/.exec(text);
  if (schedule) {
    const found = findOne(ctx.tasks, schedule[1]!);
    if ("error" in found) return { text: found.error, calls: [] };
    const when = parseWhen(schedule[2]!, ctx.nowMs);
    const task = ctx.tasks.find((item) => item.id === found.id);
    return {
      text: `准备调整「${task?.title ?? "任务"}」的计划。`,
      calls: [
        call("task_schedule", {
          taskId: found.id,
          title: task?.title,
          ...whenArgs(when),
        }),
      ],
    };
  }

  const remind =
    /^(?:给|为)?\s*(.+?)\s*(?:设置提醒|设提醒|加上提醒)(?:\s*提前\s*(\d+)\s*分钟)?$/.exec(
      text,
    );
  if (remind) {
    const found = findOne(ctx.tasks, remind[1]!);
    if ("error" in found) return { text: found.error, calls: [] };
    const option = minutesToOption(remind[2] ? Number(remind[2]) : 15);
    const task = ctx.tasks.find((item) => item.id === found.id);
    return {
      text: `准备为「${task?.title ?? "任务"}」设置提醒。`,
      calls: [
        call("task_set_reminder", {
          taskId: found.id,
          title: task?.title,
          remindOption: option,
        }),
      ],
    };
  }

  const note = /^(?:新建|创建|写)(?:一条)?笔记[:：\s]+([\s\S]+)$/.exec(text);
  if (note) {
    const [titleLine, ...rest] = note[1]!.trim().split(/\n/);
    const title = cleanTitle(titleLine ?? "") || "未命名笔记";
    return {
      text: `准备创建笔记「${title}」。`,
      calls: [
        call("note_create", {
          title,
          bodyMd: rest.join("\n").trim(),
        }),
      ],
    };
  }

  const search = /^(?:搜索|查找|检索)\s*(笔记|知识库)?\s*[:：]?\s*(.+)$/.exec(text);
  if (search && search[2]!.trim()) {
    const query = search[2]!.trim();
    const name = search[1] ? "note_search" : "search";
    return { text: `正在搜索「${query}」。`, calls: [call(name, { query })] };
  }

  const created =
    /^(?:请)?(?:帮我)?(?:新建|创建|添加|加一个|建一个|建)(?:一个)?任务[:：\s]+([\s\S]+)$/.exec(
      text,
    );
  if (created) return planCreate(created[1]!, ctx);

  if (/[？?]$/.test(text)) return { text: HELP, calls: [] };

  const casual = parseQuickCapture(text, { nowMs: ctx.nowMs });
  if (casual.summary.length > 0 && casual.title) return planCreate(text, ctx);

  return { text: HELP, calls: [] };
}

function planCreate(phrase: string, ctx: PlannerContext): AgentTurnPlan {
  const when = parseWhen(phrase, ctx.nowMs);
  const title = cleanTitle(parseQuickCapture(phrase, { nowMs: ctx.nowMs }).title);
  if (!title) return { text: "请写出任务标题。", calls: [] };
  const project = projectFromPhrase(phrase, ctx.projects);
  return {
    text: `准备创建任务「${title}」。`,
    calls: [
      call("task_create", {
        title,
        ...(project ? { projectTitle: project } : {}),
        ...whenArgs(when),
      }),
    ],
  };
}

function taskVerb(
  name: string,
  query: string,
  ctx: PlannerContext,
  verb: string,
): AgentTurnPlan {
  const found = findOne(ctx.tasks, query);
  if ("error" in found) return { text: found.error, calls: [] };
  const task = ctx.tasks.find((item) => item.id === found.id);
  return {
    text: `准备${verb}「${task?.title ?? "任务"}」。`,
    calls: [call(name, { taskId: found.id, title: task?.title })],
  };
}

function call(name: string, args: Record<string, unknown>): PlannedCall {
  return { id: createId(), name, args };
}

function findOne(
  tasks: PlannerContext["tasks"],
  query: string,
): { id: string } | { error: string } {
  const q = query.trim();
  const open = tasks.filter((task) => !task.isDone);
  const pool = open.length > 0 ? open : tasks;
  const exact = pool.filter((task) => task.title === q);
  if (exact.length === 1) return { id: exact[0]!.id };
  if (exact.length > 1) {
    return { error: `有 ${exact.length} 条同名任务「${q}」，请说得更具体。` };
  }
  const fuzzy = pool.filter(
    (task) => task.title.includes(q) || (q.length >= 2 && q.includes(task.title)),
  );
  if (fuzzy.length === 1) return { id: fuzzy[0]!.id };
  if (fuzzy.length > 1) {
    return {
      error: `匹配到多条任务：${fuzzy.map((task) => task.title).join("、")}`,
    };
  }
  return { error: `没有找到任务「${q}」。` };
}

interface WhenFields {
  dueDay: string | null;
  dueWithTime: number | null;
  remindOption: ReminderOptionId;
  deadlineDay: string | null;
}

function parseWhen(phrase: string, nowMs: number): WhenFields {
  const parsed = parseQuickCapture(phrase, { nowMs });
  let dueDay = parsed.dueDay;
  let dueWithTime = parsed.dueWithTime;
  let remindOption = parsed.remindOption;
  if (remindOption === "none" && /提醒/.test(phrase)) remindOption = "m15";
  if (/后天/.test(phrase) && dueDay == null && dueWithTime == null) {
    dueDay = addLocalDays(formatLocalDay(nowMs), 2);
  }
  if (remindOption !== "none" && dueWithTime == null) {
    const day = dueDay ?? formatLocalDay(nowMs);
    const at = new Date(parseLocalDay(day));
    at.setHours(9, 0, 0, 0);
    dueWithTime = at.getTime();
    dueDay = null;
  }
  return {
    dueDay,
    dueWithTime,
    remindOption,
    deadlineDay: parsed.deadlineDay,
  };
}

function whenArgs(when: WhenFields): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (when.dueWithTime != null) args.dueWithTime = when.dueWithTime;
  else if (when.dueDay) args.dueDay = when.dueDay;
  if (when.remindOption !== "none") args.remindOption = when.remindOption;
  if (when.deadlineDay) args.deadlineDay = when.deadlineDay;
  return args;
}

function cleanTitle(title: string): string {
  return title
    .replace(/[，,、]/g, " ")
    .replace(
      /(排到|安排到|改到|并且|并设|设置提醒|设提醒|提前\s*\d+\s*分钟|并提醒)/g,
      " ",
    )
    .replace(/(^|\s)提醒(?=\s|$)/g, " ")
    .replace(/(^|\s)并(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[:：\s]+|[:：\s]+$/g, "")
    .trim();
}

function projectFromPhrase(
  phrase: string,
  projects: PlannerContext["projects"],
): string | null {
  const match = /#([^\s#]+)/.exec(phrase);
  if (!match) return null;
  return projects.find((project) => project.title === match[1])?.title ?? match[1]!;
}

function minutesToOption(minutes: number): ReminderOptionId {
  if (minutes >= 60) return "h1";
  if (minutes >= 30) return "m30";
  if (minutes >= 15) return "m15";
  if (minutes >= 10) return "m10";
  if (minutes >= 5) return "m5";
  return "at_start";
}

function isTodayQuery(text: string): boolean {
  if (/^list today$/i.test(text)) return true;
  const compact = text.replace(/\s+/g, "");
  return /^(?:列出|看看|查看|看下|看)?(?:一下)?(?:今日|今天)(?:的)?(?:有哪些安排|有什么安排|有哪些任务|有什么任务|有什么|有哪些|要做什么|的任务|的安排|任务|安排|计划)?$/.test(
    compact,
  );
}

function viewName(label: string): string | null {
  const map: Record<string, string> = {
    今日: "today",
    今天: "today",
    计划: "planner",
    时间表: "planner",
    知识库: "knowledge",
    笔记: "knowledge",
    定时任务: "timed",
    通知: "notifications",
    任务: "projects",
    today: "today",
    planner: "planner",
    schedule: "planner",
    knowledge: "knowledge",
  };
  return map[label] ?? null;
}
