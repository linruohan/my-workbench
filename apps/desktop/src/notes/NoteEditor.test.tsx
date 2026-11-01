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
  it("renders live mode with source and preview", () => {
    renderWithProviders(
      <NoteEditor note={note} onChange={() => undefined} onDelete={() => undefined} />,
    );
    expect(screen.getByLabelText("Markdown 源码")).toBeInTheDocument();
    expect(screen.getByLabelText("预览")).toHaveTextContent("Hello");
    expect(screen.getByLabelText("预览")).toHaveTextContent("世界");
  });

  it("switches to source-only and preview-only", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NoteEditor note={note} onChange={() => undefined} onDelete={() => undefined} />,
    );
    await user.click(screen.getByRole("button", { name: "源码" }));
    expect(screen.getByLabelText("Markdown 源码")).toBeInTheDocument();
    expect(screen.queryByLabelText("预览")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "预览" }));
    expect(screen.queryByLabelText("Markdown 源码")).not.toBeInTheDocument();
    expect(screen.getByLabelText("预览")).toBeInTheDocument();
  });

  it("emits body changes while typing", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <NoteEditor note={note} onChange={onChange} onDelete={() => undefined} />,
    );
    await user.type(screen.getByLabelText("Markdown 源码"), "!");
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ bodyMd: expect.stringContaining("!") }),
    );
  });

  it("indents the current line with Tab", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <NoteEditor note={note} onChange={onChange} onDelete={() => undefined} />,
    );
    const source = screen.getByLabelText("Markdown 源码");
    source.focus();
    await user.keyboard("{Tab}");
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ bodyMd: expect.stringMatching(/^ {2}/) }),
    );
  });
});
