/** @ mentions in the composer: skills and subagents. */

export type MentionCandidate = {
  kind: "skill" | "subagent";
  name: string;
  summary: string;
};

export function mentionQuery(draft: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(draft);
  if (!match) return null;
  return match[1] ?? "";
}

export function mentionSuggestions(
  draft: string,
  candidates: readonly MentionCandidate[],
): MentionCandidate[] {
  const query = mentionQuery(draft);
  if (query == null) return [];
  const folded = query.toLowerCase();
  return candidates
    .filter((item) => !folded || item.name.toLowerCase().includes(folded))
    .slice(0, 8);
}

export function applyMention(draft: string, name: string): string {
  return draft.replace(/(?:^|\s)@[^\s@]*$/, (chunk) => {
    const lead = chunk.startsWith(" ") || chunk.startsWith("\n") ? chunk[0]! : "";
    return `${lead}@${name} `;
  });
}
