/**
 * 性能 Profiling 基线（默认跳过，显式运行）：
 *
 *   WB_PERF=1 npx vitest run tests/perf-baseline.test.ts   （packages/db 下）
 *
 * 只输出耗时基线，不做硬阈值断言（机器差异大，阈值容易 flaky）。
 * 覆盖三组热路径：1000 任务、200+ 消息会话（流式追加 + 模型视图压缩）、
 * 长笔记连续输入 + 快照序列化/增量汇出。
 */
import { describe, expect, it } from "vitest";
import { modelContextBudget, planCompact, type AgentMessage } from "@wb/domain";
import { MemoryWorkbenchRepository } from "../src/memory-repository.js";

const enabled = process.env.WB_PERF === "1";

function ms(start: number): number {
  return Math.round((performance.now() - start) * 100) / 100;
}

function report(label: string, rows: Record<string, number | string>): void {
  const line = Object.entries(rows)
    .map(([key, value]) => `${key}=${value}`)
    .join(" · ");
  console.info(`[perf] ${label}: ${line}`);
}

describe.skipIf(!enabled)("perf baseline", () => {
  it("1000 tasks: seed, list, edit, snapshot, incremental collect", () => {
    const store = new MemoryWorkbenchRepository();
    const seedStart = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      store.createTask({ title: `任务 ${i}`, notes: "备注".repeat(40) });
    }
    const seedMs = ms(seedStart);

    const listStart = performance.now();
    const tasks = store.listTasks();
    const listMs = ms(listStart);
    expect(tasks.length).toBe(1000);

    const editStart = performance.now();
    for (let i = 0; i < 100; i += 1) {
      store.updateTask(tasks[i]!.id, { notes: `更新 ${i}` });
    }
    const editMs = ms(editStart);

    const exportStart = performance.now();
    const snapshot = store.exportSnapshot();
    const exportMs = ms(exportStart);

    store.updateTask(tasks[0]!.id, { notes: "单次编辑" });
    const collectStart = performance.now();
    const changes = store.collectPendingChanges();
    const collectMs = ms(collectStart);
    const bytes =
      (changes?.upserts ?? []).reduce((sum, row) => sum + row.data.length, 0) +
      (changes?.replaced.length ?? 0);
    expect(changes?.replaced).toContain("task");

    report("1000 任务", {
      建任务1000: `${seedMs}ms`,
      listTasks: `${listMs}ms`,
      编辑100次: `${editMs}ms`,
      全量快照序列化: `${exportMs}ms(${Math.round(snapshot.length / 1024)}KB)`,
      单次编辑增量汇出: `${collectMs}ms(~${bytes}B)`,
    });
    store.markPersisted();
  });

  it("240-message thread: append, model view compact, snapshot, collect", () => {
    const store = new MemoryWorkbenchRepository();
    const thread = store.createAgentThread({});
    const calls = JSON.stringify([{ id: "c1", name: "task_list", args: {} }]);
    const appendStart = performance.now();
    for (let i = 0; i < 240; i += 1) {
      if (i % 20 === 19) {
        store.appendAgentMessage({
          threadId: thread.id,
          role: "assistant",
          content: "",
          toolCallsJson: calls,
          nowMs: i + 1,
        });
        store.appendAgentMessage({
          threadId: thread.id,
          role: "tool",
          content: "工具结果".repeat(30),
          toolName: "task_list",
          toolCallId: "c1",
          nowMs: i + 2,
        });
      } else {
        store.appendAgentMessage({
          threadId: thread.id,
          role: i % 2 === 0 ? "user" : "assistant",
          content: "消息内容".repeat(20),
          nowMs: i + 1,
        });
      }
    }
    const appendMs = ms(appendStart);
    const messages: AgentMessage[] = store.listAgentMessages(thread.id);
    expect(messages.length).toBeGreaterThan(240);

    const budget = modelContextBudget(128_000, 8192);
    const compactStart = performance.now();
    const plan = planCompact(messages, budget);
    const compactMs = ms(compactStart);
    expect(plan.needed).toBe(false);

    const exportStart = performance.now();
    const snapshot = store.exportSnapshot();
    const exportMs = ms(exportStart);

    // 先落盘一次，再单追加一条，测流式路径的增量汇出
    store.markPersisted();
    store.appendAgentMessage({
      threadId: thread.id,
      role: "user",
      content: "流式中的一次追加",
    });
    const collectStart = performance.now();
    const changes = store.collectPendingChanges();
    const collectMs = ms(collectStart);
    const rows = (changes?.upserts ?? []).filter((row) => row.kind === "agent_message");
    expect(rows).toHaveLength(1);

    report("200+ 消息会话", {
      追加约250条: `${appendMs}ms`,
      planCompact: `${compactMs}ms`,
      全量快照序列化: `${exportMs}ms(${Math.round(snapshot.length / 1024)}KB)`,
      流式单条增量汇出: `${collectMs}ms`,
    });
    store.markPersisted();
  });

  it("long note input: repeated updateNote + snapshot export", () => {
    const store = new MemoryWorkbenchRepository();
    const base = "段落内容。".repeat(5000); // ≈25k 字
    const note = store.createNote({ title: "长笔记", bodyMd: base });
    const typeStart = performance.now();
    let body = base;
    for (let i = 0; i < 100; i += 1) {
      body += ` 新输入 ${i}`;
      store.updateNote(note.id, { bodyMd: body });
    }
    const typeMs = ms(typeStart);

    const exportStart = performance.now();
    const snapshot = store.exportSnapshot();
    const exportMs = ms(exportStart);
    expect(snapshot.length).toBeGreaterThan(25_000);

    const listStart = performance.now();
    store.listNotes();
    const listMs = ms(listStart);

    report("长笔记输入", {
      "连续输入100次(约25k字)": `${typeMs}ms`,
      listNotes: `${listMs}ms`,
      全量快照序列化: `${exportMs}ms(${Math.round(snapshot.length / 1024)}KB)`,
    });
    store.markPersisted();
  });
});
