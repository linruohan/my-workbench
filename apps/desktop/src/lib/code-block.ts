import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("zsh", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("c++", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("cs", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("golang", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("kt", kotlin);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("svg", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

const LANG_LABELS: Record<string, string> = {
  bash: "Shell",
  sh: "Shell",
  shell: "Shell",
  zsh: "Shell",
  javascript: "JavaScript",
  js: "JavaScript",
  jsx: "JavaScript",
  typescript: "TypeScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  python: "Python",
  py: "Python",
  rust: "Rust",
  rs: "Rust",
  go: "Go",
  golang: "Go",
  java: "Java",
  kotlin: "Kotlin",
  kt: "Kotlin",
  c: "C",
  cpp: "C++",
  "c++": "C++",
  csharp: "C#",
  cs: "C#",
  css: "CSS",
  html: "HTML",
  xml: "XML",
  svg: "SVG",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  sql: "SQL",
  markdown: "Markdown",
  md: "Markdown",
  diff: "Diff",
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function normalizeLang(info: string): string {
  return (info.split(/\s+/)[0] ?? "").trim().toLowerCase();
}

export function languageLabel(lang: string): string {
  if (!lang) return "Plain Text";
  return LANG_LABELS[lang] ?? lang;
}

/** Fence body for display: drop a single trailing newline markdown-it usually keeps. */
export function normalizeFenceContent(code: string): string {
  return code.replace(/\n$/, "");
}

export function highlightCode(code: string, lang: string): string {
  const source = normalizeFenceContent(code);
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // fall through
    }
  }
  try {
    return hljs.highlightAuto(source).value;
  } catch {
    return escapeHtml(source);
  }
}

function lineCount(code: string): number {
  const trimmed = normalizeFenceContent(code);
  if (!trimmed) return 1;
  return trimmed.split("\n").length;
}

function lineNumberHtml(count: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    lines.push(`<span class="md-code__num">${i}</span>`);
  }
  // Spans are already display:block — do not join with "\n" or <pre> doubles the gaps.
  return lines.join("");
}

/** macOS-style fenced code block with language label, line numbers, and highlight.js. */
export function renderCodeBlock(code: string, info: string): string {
  const lang = normalizeLang(info);
  const label = languageLabel(lang);
  const highlighted = highlightCode(code, lang);
  const nums = lineNumberHtml(lineCount(code));
  const langClass = lang ? ` language-${escapeHtml(lang)}` : "";
  const source = escapeHtml(normalizeFenceContent(code));
  return [
    `<div class="md-code" data-code="${source}">`,
    `<div class="md-code__chrome">`,
    `<span class="md-code__dots" aria-hidden="true"><i></i><i></i><i></i></span>`,
    `<span class="md-code__lang">${escapeHtml(label)}</span>`,
    `<button type="button" class="md-code__copy">复制</button>`,
    `</div>`,
    `<div class="md-code__main">`,
    `<pre class="md-code__gutter" aria-hidden="true">${nums}</pre>`,
    `<pre class="md-code__pre"><code class="hljs${langClass}">${highlighted}</code></pre>`,
    `</div>`,
    `</div>\n`,
  ].join("");
}
