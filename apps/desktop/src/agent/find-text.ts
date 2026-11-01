/** Case-insensitive, non-overlapping hits. The query is trimmed. */

export function literalHitCount(text: string, query: string): number {
  return splitHits(text, query).reduce((count, part) => count + (part.hit ? 1 : 0), 0);
}

export function splitHits(
  text: string,
  query: string,
): Array<{ text: string; hit: boolean }> {
  const needle = query.trim();
  if (!needle) return [{ text, hit: false }];
  const hay = text.toLowerCase();
  const folded = needle.toLowerCase();
  const parts: Array<{ text: string; hit: boolean }> = [];
  let from = 0;
  while (from < text.length) {
    const at = hay.indexOf(folded, from);
    if (at < 0) {
      parts.push({ text: text.slice(from), hit: false });
      break;
    }
    if (at > from) parts.push({ text: text.slice(from, at), hit: false });
    parts.push({ text: text.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
  }
  return parts.filter((part) => part.text.length > 0);
}

export function htmlTextHitCount(html: string, query: string): number {
  if (!query.trim()) return 0;
  let count = 0;
  visitHtmlText(html, (text) => {
    count += literalHitCount(text, query);
    return text;
  });
  return count;
}

/** Wrap hits in text nodes. Tag markup is left untouched. */
export function markHtmlHits(
  html: string,
  query: string,
  indexBase: number,
  active: number,
): string {
  if (!query.trim()) return html;
  let next = indexBase;
  return visitHtmlText(html, (text) =>
    splitHits(text, query)
      .map((part) => {
        if (!part.hit) return part.text;
        const index = next;
        next += 1;
        const current = index === active ? " is-current" : "";
        return `<mark class="agent__hit${current}" data-find-hit="${index}">${part.text}</mark>`;
      })
      .join(""),
  );
}

function visitHtmlText(html: string, mapText: (text: string) => string): string {
  let out = "";
  let index = 0;
  while (index < html.length) {
    if (html.charCodeAt(index) === 60) {
      const end = html.indexOf(">", index);
      if (end < 0) {
        out += html.slice(index);
        break;
      }
      out += html.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const end = html.indexOf("<", index);
    out += mapText(html.slice(index, end < 0 ? undefined : end));
    if (end < 0) break;
    index = end;
  }
  return out;
}
