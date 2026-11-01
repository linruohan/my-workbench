const KEY = "wb.credentials.v1";

function readMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, string>): void {
  localStorage.setItem(KEY, JSON.stringify(map));
}

export function readCredential(providerId: string): string | null {
  return readMap()[providerId] ?? null;
}

export function credentialExists(providerId: string): boolean {
  return Boolean(readMap()[providerId]);
}

export function writeCredential(providerId: string, apiKey: string): void {
  const next = readMap();
  const trimmed = apiKey.trim();
  if (!trimmed) {
    delete next[providerId];
  } else {
    next[providerId] = trimmed;
  }
  writeMap(next);
}

export function deleteCredential(providerId: string): void {
  const next = readMap();
  delete next[providerId];
  writeMap(next);
}
