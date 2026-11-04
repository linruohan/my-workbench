import { describe, expect, it } from "vitest";
import {
  dshModelCaps,
  isDshSessionId,
  mintDshSessionId,
  prepareDshFreeChat,
  selectDshFreeModels,
  settleDshToolCalls,
} from "../src/dsh-free";

describe("DSH free models", () => {
  it("keeps chat free-lane ids and drops paid or non-chat models", () => {
    const found = selectDshFreeModels({
      data: [
        { id: "deepseek-v4.1-flash-free" },
        { id: "gpt-5" },
        { id: "muse-spark-1.3-contributor-free" },
        { id: "union-alpha" },
        { id: "big-pickle" },
        "glm-5.3-flash-free",
        { id: "deepseek-v4.1-flash-free" },
      ],
    });
    expect(found.map((model) => model.id)).toEqual([
      "deepseek-v4.1-flash-free",
      "big-pickle",
      "glm-5.3-flash-free",
    ]);
    expect(found[0]).toMatchObject({
      name: "DeepSeek V4.1 Flash",
      context: 1_048_576,
      output: 384_000,
      image: true,
    });
    expect(dshModelCaps(found)["big-pickle"]).toMatchObject({
      title: "Big Pickle",
      inputs: ["image"],
    });
  });

  it("mints a session id the free lane accepts", () => {
    const first = mintDshSessionId(1_700_000_000_000);
    const second = mintDshSessionId(1_700_000_000_000);
    expect(isDshSessionId(first)).toBe(true);
    expect(isDshSessionId(second)).toBe(true);
    expect(first).not.toBe(second);
    expect(isDshSessionId("ses_000000000000abcdefghijklmn")).toBe(false);
  });

  it("adds the official tools, environment, and session headers", () => {
    const session = mintDshSessionId();
    const prepared = prepareDshFreeChat({
      session,
      directory: "D:\\work",
      platform: "win32",
      body: {
        model: "deepseek-v4.1-flash-free",
        stream: true,
        messages: [
          { role: "system", content: "你是工作台助手" },
          { role: "user", content: "hi" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "read",
              description: "ours",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "none",
      },
    });
    expect(prepared.url).toBe("https://opencode.ai/inference/v1/chat/completions");
    expect(prepared.headers).toMatchObject({
      authorization: "Bearer public",
      "user-agent": "opencode/latest/2.0.26/cli",
      "x-opencode-session": session,
      "x-opencode-session-id": session,
      "x-session-affinity": session,
      "x-session-id": session,
    });
    expect(prepared.headers).not.toHaveProperty("x-opencode-request");
    expect(prepared.body.tool_choice).toBeUndefined();
    const tools = prepared.body.tools as Array<{
      function: { name: string; description: string };
    }>;
    expect(tools.map((tool) => tool.function.name)).toEqual([
      "read_client",
      "read",
      "shell",
    ]);
    expect(tools[1]?.function.description.startsWith("Read the contents")).toBe(true);
    const system =
      (prepared.body.messages as Array<{ content: string }>)[0]?.content ?? "";
    expect(system).toContain("你是工作台助手");
    expect(system).toContain("Working directory: D:\\work");
    expect(system).toContain("Platform: win32");
    expect(system).toContain("Do not call the `read` or `shell` tools");
    expect(prepared.aliases.get("read_client")).toBe("read");
    expect(
      settleDshToolCalls(
        [
          { id: "1", name: "read", args: {} },
          { id: "2", name: "read_client", args: { path: "a" } },
          { id: "3", name: "task_list_today", args: {} },
        ],
        prepared.aliases,
      ).map((call) => call.name),
    ).toEqual(["read", "task_list_today"]);
  });
});
