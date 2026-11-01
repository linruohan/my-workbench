const KEY = "wb.agent.history.v1";
const MAX = 50;

/** Newest input first. Consecutive duplicates and key-like text are skipped. */
export function pushInputHistory(history: string[], text: string, max = MAX): string[] {
  const next = text.trim();
  if (!next || looksLikeSecret(next)) return history;
  if (history[0] === next) return history;
  return [next, ...history].slice(0, max);
}

export function readInputHistory(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  } catch {
    return [];
  }
}

export function rememberInput(text: string): string[] {
  const saved = pushInputHistory(readInputHistory(), text);
  localStorage.setItem(KEY, JSON.stringify(saved));
  return saved;
}

function looksLikeSecret(text: string): boolean {
  return /sk-[A-Za-z0-9_-]{8,}/.test(text) || /\bapi[_-]?key\b/i.test(text);
}
