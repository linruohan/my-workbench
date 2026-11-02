/**
 * GitHub Flavored Markdown snippets inspired by
 * https://github.com/praveenpuglia/github_markdown_snippets
 *
 * Type the HTML-like trigger, then press Tab to expand.
 */

export type MdSnippetRange = { start: number; end: number };

export type MdSnippetExpand = {
  text: string;
  /** Tab-stop ranges in order (1..n, then final ${0}). */
  stops: MdSnippetRange[];
};

export type MdSnippetDefinition = {
  trigger: string;
  template: string;
};

/** Same triggers / bodies as the Sublime package (leading CDATA newlines stripped). */
export const GITHUB_MD_SNIPPETS: MdSnippetDefinition[] = [
  { trigger: "h1", template: "# ${1:Heading 1}\n${0}" },
  { trigger: "h2", template: "## ${1:Heading 2}\n${0}" },
  { trigger: "h3", template: "### ${1:Heading 3}\n${0}" },
  { trigger: "h4", template: "#### ${1:Heading 4}\n${0}" },
  { trigger: "h5", template: "##### ${1:Heading 5}\n${0}" },
  { trigger: "h6", template: "###### ${1:Heading 6}\n${0}" },
  { trigger: "b", template: "**${1:Bold Text}** ${0}" },
  { trigger: "i", template: "*${1:Italic Text}* ${0}" },
  { trigger: "bq", template: "> ${1:Put a nice, beautiful}\n> ${2:quote here...}\n${0}" },
  { trigger: "strike", template: "~~${1:Strike Through}~~ ${0}" },
  { trigger: "hr", template: "---\n${0}" },
  { trigger: "code", template: "`${1:Inline Code Snippet}` ${0}" },
  { trigger: "pre", template: "```${1:language}\n${2:Multi-line Code}\n```\n${0}" },
  { trigger: "a", template: "[${1:Link Title}](${2:Link Source}) ${0}" },
  { trigger: "img", template: "![${1:Image Title}](${2:Image Source}) ${0}" },
  {
    trigger: "ol",
    template: "1. ${1:First Item}\n2. ${2:Second Item}\n3. ${3:Third Item}\n${0}",
  },
  { trigger: "ul", template: "- ${1:I}\n- ${2:Love}\n- ${3:Markdown}\n${0}" },
  {
    trigger: "table",
    template:
      "| ${1:Column 1} | ${2:Column 2} |\n| ------------- | ------------- |\n| ${3:Cell 1-1} | ${4:Cell 1-2} |\n| ${5:Cell 2-1} | ${6:Cell 2-2} |\n${0}",
  },
];

const TRIGGER_RE = /([A-Za-z][A-Za-z0-9]*)$/;
const PLACEHOLDER_RE = /\$\{(\d+)(?::([^}]*))?\}/g;

const SNIPPETS_BY_LENGTH = [...GITHUB_MD_SNIPPETS].sort(
  (a, b) => b.trigger.length - a.trigger.length,
);

/** Build body text and tab-stop ranges from a `${n:default}` template. */
export function materializeSnippetTemplate(template: string): MdSnippetExpand {
  const byIndex = new Map<number, MdSnippetRange>();
  let body = "";
  let last = 0;
  PLACEHOLDER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_RE.exec(template))) {
    const full = match[0];
    const index = Number(match[1]);
    const placeholder = match[2] ?? "";
    body += template.slice(last, match.index);
    const start = body.length;
    body += placeholder;
    const end = body.length;
    // First occurrence wins (these snippets have no mirrors).
    if (!byIndex.has(index)) byIndex.set(index, { start, end });
    last = match.index + full.length;
  }
  body += template.slice(last);

  const indices = [...byIndex.keys()].sort((a, b) => {
    if (a === 0) return 1;
    if (b === 0) return -1;
    return a - b;
  });
  const stops = indices.map((i) => byIndex.get(i)!);
  if (stops.length === 0) {
    stops.push({ start: body.length, end: body.length });
  }
  return { text: body, stops };
}

function findTriggerAtCaret(
  text: string,
  caret: number,
): { trigger: string; start: number; end: number } | null {
  if (caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const match = TRIGGER_RE.exec(before);
  if (!match?.[1]) return null;
  const word = match[1];
  const start = caret - word.length;
  if (start > 0 && /[A-Za-z0-9_]/.test(text.charAt(start - 1))) return null;
  for (const snippet of SNIPPETS_BY_LENGTH) {
    if (word === snippet.trigger) {
      return { trigger: snippet.trigger, start, end: caret };
    }
  }
  return null;
}

/**
 * Expand a GitHub MD snippet at the caret when the preceding word is a tab trigger.
 * Returns null when nothing matches (caller should fall back to indent).
 */
export function expandGithubMdSnippet(
  text: string,
  caret: number,
): (MdSnippetExpand & { replaceStart: number; replaceEnd: number }) | null {
  const hit = findTriggerAtCaret(text, caret);
  if (!hit) return null;
  const def = SNIPPETS_BY_LENGTH.find((s) => s.trigger === hit.trigger);
  if (!def) return null;
  const materialized = materializeSnippetTemplate(def.template);
  const next = text.slice(0, hit.start) + materialized.text + text.slice(hit.end);
  const shift = hit.start;
  return {
    text: next,
    replaceStart: hit.start,
    replaceEnd: hit.end,
    stops: materialized.stops.map((stop) => ({
      start: stop.start + shift,
      end: stop.end + shift,
    })),
  };
}

/**
 * Shift snippet tab stops after a single-range edit at `editStart` with length delta
 * (`newLen - oldLen` for the replaced slice).
 */
export function adjustSnippetStops(
  stops: MdSnippetRange[],
  editStart: number,
  oldSpan: number,
  newSpan: number,
): MdSnippetRange[] {
  const delta = newSpan - oldSpan;
  const editEnd = editStart + oldSpan;
  return stops.map((stop) => {
    if (stop.end <= editStart) return stop;
    if (stop.start >= editEnd) {
      return { start: stop.start + delta, end: stop.end + delta };
    }
    // Edit overlaps this stop — grow/shrink the end with the typed text.
    return {
      start: stop.start,
      end: Math.max(stop.start, stop.end + delta),
    };
  });
}
