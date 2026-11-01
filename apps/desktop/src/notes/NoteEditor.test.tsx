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
    expect(screen.getByLabelText("编辑第 1 段")).toHaveTextContent("1 Hello");
    expect(screen.getByLabelText("编辑第 3 段")).toHaveTextContent("世界");
    expect(screen.getByLabelText("编辑空行（第 4 段）")).toBeInTheDocument();
  });

  it("switches a rendered block into source when clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NoteEditor note={note} onChange={() => undefined} onDelete={() => undefined} />,
    );
    await user.click(screen.getByLabelText("编辑第 3 段"));
    expect(screen.getByLabelText("Markdown 源码")).toHaveValue("世界");
  });

  it("emits body changes while typing in the active block", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <NoteEditor note={note} onChange={onChange} onDelete={() => undefined} />,
    );
    await user.click(screen.getByLabelText("编辑第 1 段"));
    await user.type(screen.getByLabelText("Markdown 源码"), "!");
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ bodyMd: expect.stringContaining("!") }),
    );
  });
});
