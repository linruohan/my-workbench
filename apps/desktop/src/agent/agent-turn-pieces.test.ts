import { describe, expect, it } from "vitest";
import { agentTurnPieces, parsePlannedCalls } from "./agent-turn-pieces";

const now = new Date(2026, 10, 5, 12).getTime();

describe("agent turn pieces", () => {
  it("parses planned calls and skips blank junk", () => {
    expect(parsePlannedCalls(null)).toEqual([]);
    expect(parsePlannedCalls("{")).toEqual([]);
    expect(
      parsePlannedCalls(
        JSON.stringify([{ id: "1", name: "task_create", args: { title: "写周报" } }]),
      ),
    ).toEqual([{ id: "1", name: "task_create", args: { title: "写周报" } }]);
  });

  it("uses the planned action as the collapsed tool summary", () => {
    const pieces = agentTurnPieces(
      [
        {
          id: "a1",
          threadId: "t",
          role: "assistant",
          content: "创建任务「写周报」",
          toolName: null,
          toolCallId: null,
          toolCallsJson: JSON.stringify([
            { id: "c1", name: "task_create", args: { title: "写周报" } },
          ]),
          createdAt: now,
        },
        {
          id: "t1",
          threadId: "t",
          role: "tool",
          content: "已创建任务「写周报」",
          toolName: "task_create",
          toolCallId: "c1",
          toolCallsJson: null,
          createdAt: now + 1,
        },
      ],
      now,
    );
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({
      kind: "tool",
      label: "任务",
      summary: "创建任务「写周报」",
    });
  });

  it("keeps real assistant prose beside tool rows", () => {
    const pieces = agentTurnPieces(
      [
        {
          id: "a1",
          threadId: "t",
          role: "assistant",
          content: "好的，我来创建。\n创建任务「写周报」",
          toolName: null,
          toolCallId: null,
          toolCallsJson: JSON.stringify([
            { id: "c1", name: "task_create", args: { title: "写周报" } },
          ]),
          createdAt: now,
        },
        {
          id: "t1",
          threadId: "t",
          role: "tool",
          content: "已创建",
          toolName: "task_create",
          toolCallId: "c1",
          toolCallsJson: null,
          createdAt: now + 1,
        },
      ],
      now,
    );
    expect(pieces.map((piece) => piece.kind)).toEqual(["prose", "tool"]);
    expect(pieces[0]?.text).toContain("好的，我来创建。");
  });
});
