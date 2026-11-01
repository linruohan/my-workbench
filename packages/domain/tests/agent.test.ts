import { describe, expect, it } from "vitest";
import {
  BUILTIN_MODEL_REF,
  applyRuntimeHeaders,
  buildModelHttpRequest,
  builtinProvider,
  finishOpenAiStream,
  gateTool,
  headersForLog,
  parseModelResponse,
  planLocalTurn,
  agentThreadTitle,
  describeToolArgs,
  describeToolResult,
  relativizeScheduleText,
  toolCallSummary,
  redactSecrets,
  reduceOpenAiStreamEvent,
  takeSseData,
  toolsForMode,
  type AgentMessage,
} from "../src/index.js";

const now = new Date(2026, 10, 1, 8, 0, 0).getTime();

describe("agent permissions", () => {
  it("asks before writes, auto-runs them in session mode, and always asks before delete", () => {
    expect(gateTool("confirm", "task_list_today")).toBe("run");
    expect(gateTool("confirm", "task_create")).toBe("ask");
    expect(gateTool("session_auto", "task_create")).toBe("run");
    expect(gateTool("session_auto", "task_delete")).toBe("ask");
    expect(gateTool("readonly", "task_create")).toBe("block");
    expect(gateTool("readonly", "note_delete")).toBe("block");
    expect(toolsForMode("readonly").some((tool) => tool.name === "task_create")).toBe(
      false,
    );
  });
});

describe("local planner", () => {
  it("plans today, then a task tomorrow with a reminder", () => {
    const plan = planLocalTurn(
      "列出今日，然后创建任务 写周报，排到明天并提前15分钟提醒",
      { nowMs: now, tasks: [], projects: [] },
    );
    expect(plan.calls.map((call) => call.name)).toEqual([
      "task_list_today",
      "task_create",
    ]);
    const create = plan.calls[1]!;
    expect(create.args.title).toBe("写周报");
    expect(create.args.dueWithTime).toBe(new Date(2026, 10, 2, 9, 0, 0).getTime());
    expect(create.args.remindOption).toBe("m15");
    expect(create.args.dueDay).toBeUndefined();
  });

  it("marks delete as a destructive call and does not invent a task", () => {
    const missing = planLocalTurn("删除任务 不存在", {
      nowMs: now,
      tasks: [],
      projects: [],
    });
    expect(missing.calls).toHaveLength(0);
    expect(missing.text).toContain("没有找到");

    const plan = planLocalTurn("删除任务 写周报", {
      nowMs: now,
      tasks: [{ id: "t1", title: "写周报", isDone: false }],
      projects: [],
    });
    expect(plan.calls[0]?.name).toBe("task_delete");
    expect(gateTool("session_auto", plan.calls[0]!.name)).toBe("ask");
  });

  it("understands a polite today question and marking a task done", () => {
    const today = planLocalTurn("请帮我看看今天有什么", {
      nowMs: now,
      tasks: [],
      projects: [],
    });
    expect(today.calls.map((call) => call.name)).toEqual(["task_list_today"]);

    const done = planLocalTurn("把写周报完成", {
      nowMs: now,
      tasks: [{ id: "t1", title: "写周报", isDone: false }],
      projects: [],
    });
    expect(done.calls[0]?.name).toBe("task_complete");
    expect(done.calls[0]?.args.taskId).toBe("t1");

    const created = planLocalTurn("今天写周报", { nowMs: now, tasks: [], projects: [] });
    expect(created.calls[0]?.name).toBe("task_create");
    expect(created.calls[0]?.args.title).toBe("写周报");
  });

  it("names a session from the first clause", () => {
    expect(agentThreadTitle("创建任务 写周报，排到明天并提前15分钟提醒")).toBe(
      "创建任务 写周报",
    );
    expect(agentThreadTitle("今天有什么")).toBe("今天有什么");
  });
});

describe("model protocol", () => {
  const secret = "sk-live-secret-value";
  const messages: AgentMessage[] = [
    {
      id: "m1",
      threadId: "t",
      role: "user",
      content: "列出今日",
      toolName: null,
      toolCallId: null,
      toolCallsJson: null,
      createdAt: now,
    },
  ];

  it("keeps the API key out of the request body and out of logs", () => {
    const provider = {
      ...builtinProvider(),
      id: "openai-compatible:local",
      name: "Ollama",
      kind: "openai-chat-completions" as const,
      baseURL: "http://127.0.0.1:11434/v1",
      apiKeyRequired: false,
    };
    const request = buildModelHttpRequest({
      provider,
      modelId: "local",
      system: "system",
      messages,
      permissionMode: "confirm",
    });
    expect(request.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(JSON.stringify(request)).not.toContain(secret);
    const headers = applyRuntimeHeaders(request, secret);
    expect(headers.authorization).toBe(`Bearer ${secret}`);
    expect(JSON.stringify(headersForLog(headers, [secret]))).not.toContain(secret);
    expect(redactSecrets(`error ${secret}`, [secret])).toBe("error [redacted]");
  });

  it("parses OpenAI and Anthropic tool calls", () => {
    const openai = parseModelResponse("openai-chat-completions", {
      choices: [
        {
          message: {
            content: "好的",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "task_create",
                  arguments: JSON.stringify({ title: "写周报" }),
                },
              },
            ],
          },
        },
      ],
    });
    expect(openai.text).toBe("好的");
    expect(openai.calls[0]).toMatchObject({ id: "call_1", name: "task_create" });

    const anthropic = parseModelResponse("anthropic-messages", {
      content: [
        { type: "text", text: "安排明天" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "task_schedule",
          input: { title: "写周报", dueDay: "2026-11-02" },
        },
      ],
    });
    expect(anthropic.calls[0]?.name).toBe("task_schedule");
    expect(anthropic.calls[0]?.args.dueDay).toBe("2026-11-02");
  });

  it("assembles streamed OpenAI tool calls", () => {
    const chunk = [
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "好" } }],
      })}`,
      "",
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_9",
                  function: { name: "task_list_today", arguments: "{}" },
                },
              ],
            },
          },
        ],
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const taken = takeSseData(chunk);
    let acc = {
      text: "",
      calls: [] as Array<{ id: string; name: string; argsText: string }>,
    };
    for (const event of taken.data) acc = reduceOpenAiStreamEvent(acc, event);
    const plan = finishOpenAiStream(acc);
    expect(plan.text).toBe("好");
    expect(plan.calls[0]?.name).toBe("task_list_today");
    expect(BUILTIN_MODEL_REF.endsWith("/local")).toBe(true);
  });

  it("omits write tools from a readonly OpenAI request", () => {
    const request = buildModelHttpRequest({
      provider: {
        ...builtinProvider(),
        id: "custom:acme",
        kind: "anthropic-messages",
        baseURL: "https://api.example.com",
        apiKeyRequired: true,
      },
      modelId: "local",
      system: "system",
      messages,
      permissionMode: "readonly",
    });
    expect(request.url).toBe("https://api.example.com/v1/messages");
    expect(request.secretHeaderNames).toEqual(["x-api-key"]);
    const body = JSON.stringify(request.body);
    expect(body).not.toContain("task_create");
    expect(body).toContain("task_list_today");
  });
});

describe("tool replies", () => {
  it("renders a today list as readable lines", () => {
    const text = describeToolResult(
      "task_list_today",
      {
        tasks: [
          {
            title: "写周报",
            dueWithTime: new Date(2026, 10, 2, 9, 0, 0).getTime(),
            remindAt: new Date(2026, 10, 2, 8, 45, 0).getTime(),
          },
        ],
      },
      "今日有 1 项",
    );
    expect(text).toContain("今日有 1 项");
    expect(text).toContain("· 写周报 · 2026-11-02 09:00");
    expect(text).toContain("提醒 2026-11-02 08:45");
    expect(text).not.toContain("{");
    const shown = relativizeScheduleText(text, new Date(2026, 10, 1, 12).getTime());
    expect(shown).toContain("· 写周报 · 明天 09:00");
    expect(shown).toContain("提醒 明天 08:45");
  });

  it("describes a planned write without internal ids", () => {
    const now = new Date(2026, 10, 1, 12).getTime();
    const due = new Date(2026, 10, 2, 9, 0, 0).getTime();
    const summary = toolCallSummary("task_create", {
      title: "写周报",
      dueWithTime: due,
      remindOption: "m15",
      taskId: "hidden",
    });
    expect(summary).toContain("创建任务「写周报」");
    expect(summary).toContain("2026-11-02 09:00");
    expect(summary).toContain("提前 15 分钟提醒");
    expect(summary).not.toContain("指定时刻");
    const args = describeToolArgs(
      {
        title: "写周报",
        taskId: "hidden",
        dueWithTime: due,
        remindOption: "m15",
        view: "today",
      },
      now,
    );
    expect(args).toContain("标题：写周报");
    expect(args).toContain("计划：明天 09:00");
    expect(args).toContain("提醒：提前 15 分钟");
    expect(args).not.toContain("hidden");
  });
});
