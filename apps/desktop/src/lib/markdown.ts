import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true,
});

/** Render note Markdown to safe HTML for the preview pane. */
export function renderMarkdown(source: string): string {
  return md.render(source || "");
}
