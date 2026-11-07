import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Note } from "@wb/domain";
import { renderWithProviders } from "../test/render";
import { NoteEditor } from "./NoteEditor";

const note: Note = {
  id: "n1",
  projectId: null,
  title: "草稿",
  bodyMd: "# Hello\n\n世界",
  createdAt: 1,
  updatedAt: 1,
};

afterEach(() => {
  cleanup();
});

describe("NoteEditor", () => {
  it("renders typora-like preview blocks by default", () => {
    renderWithProviders(
      <NoteEditor note={note} onChange={() => undefined} onDelete={() => undefined} />,
    );
    expect(screen.getByLabelText("Markdown 编辑器")).toBeInTheDocument();
    expect(screen.queryByLabelText("Markdown 源码")).not.toBeInTheDocument();
    expect(screen.getByLabelText("编辑第 1 行")).toHaveTextContent("Hello");
    expect(screen.getByLabelText("编辑第 3 行")).toHaveTextContent("世界");
    expect(screen.getByLabelText("编辑空行（第 4 行）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "#" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("toggles the line-number gutter from the toolbar", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NoteEditor note={note} onChange={() => undefined} onDelete={() => undefined} />,
    );
    expect(document.querySelector(".md-live__gutter")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "#" }));
    expect(screen.getByRole("button", { name: "#" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(document.querySelector(".md-live__gutter")).toBeNull();
  });

  it("switches a rendered block into source when clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NoteEditor note={note} onChange={() => undefined} onDelete={() => undefined} />,
    );
    await user.click(screen.getByLabelText("编辑第 3 行"));
    expect(screen.getByLabelText("Markdown 源码")).toHaveValue("世界");
  });

  it("emits body changes while typing in the active block", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <NoteEditor note={note} onChange={onChange} onDelete={() => undefined} />,
    );
    await user.click(screen.getByLabelText("编辑第 1 行"));
    await user.type(screen.getByLabelText("Markdown 源码"), "!");
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ bodyMd: expect.stringContaining("!") }),
    );
  });

  it("merges the next block when Shift+ArrowDown crosses a boundary", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NoteEditor note={note} onChange={() => undefined} onDelete={() => undefined} />,
    );
    await user.click(screen.getByLabelText("编辑第 1 行"));
    const area = screen.getByLabelText("Markdown 源码") as HTMLTextAreaElement;
    area.setSelectionRange(area.value.length, area.value.length);
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    const merged = screen.getByLabelText("Markdown 源码") as HTMLTextAreaElement;
    expect(merged.value).toContain("\n");
    expect(merged.selectionStart).not.toBe(merged.selectionEnd);
    expect(merged.value.slice(merged.selectionStart, merged.selectionEnd)).toContain(
      "\n",
    );
  });

  it("selects the whole document with Ctrl/Meta+A", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NoteEditor note={note} onChange={() => undefined} onDelete={() => undefined} />,
    );
    await user.click(screen.getByLabelText("编辑第 3 行"));
    const area = screen.getByLabelText("Markdown 源码") as HTMLTextAreaElement;
    area.focus();
    await user.keyboard("{Control>}a{/Control}");
    const selected = screen.getByLabelText("Markdown 源码") as HTMLTextAreaElement;
    expect(selected.value).toContain("Hello");
    expect(selected.value).toContain("世界");
    expect(selected.value.includes("\n")).toBe(true);
    expect(selected.selectionStart).toBe(0);
    expect(selected.selectionEnd).toBe(selected.value.length);
  });

  it("does not emit body changes when a merge only expands the selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    // 无标题行，编号同步不会改写正文；只剩打开时的规范化会触发一次 onChange。
    const plain: Note = { ...note, id: "n2", bodyMd: "甲\n\n乙" };
    renderWithProviders(
      <NoteEditor note={plain} onChange={onChange} onDelete={() => undefined} />,
    );
    // 打开时会做一次延迟的大纲编号/规范化同步，等它完成后再清零。
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    onChange.mockClear();
    await user.click(screen.getByLabelText("编辑第 1 行"));
    const area = screen.getByLabelText("Markdown 源码") as HTMLTextAreaElement;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(screen.getByLabelText("Markdown 源码")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("extends the selection to the document end with Ctrl+Shift+End", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NoteEditor note={note} onChange={() => undefined} onDelete={() => undefined} />,
    );
    await user.click(screen.getByLabelText("编辑第 3 行"));
    const area = screen.getByLabelText("Markdown 源码") as HTMLTextAreaElement;
    area.focus();
    area.setSelectionRange(0, 0);
    await user.keyboard("{Control>}{Shift>}{End}{/Shift}{/Control}");
    const selected = screen.getByLabelText("Markdown 源码") as HTMLTextAreaElement;
    expect(selected.value).toContain("世界");
    expect(selected.selectionEnd).toBe(selected.value.length);
  });
});
