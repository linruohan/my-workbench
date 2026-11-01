/** Soft pastel chip colors for task tags (bg + border + text). */
export const TAG_PALETTE = [
  { bg: "#f5e6d3", border: "#e0b88a", text: "#6b4f2e" }, // peach
  { bg: "#e4e9f7", border: "#a9b6df", text: "#3d4a78" }, // lavender
  { bg: "#ddeee6", border: "#8fc4ad", text: "#2f5c48" }, // mint
  { bg: "#f7e4ea", border: "#d9a0b4", text: "#6e3b4e" }, // rose
  { bg: "#e8f0d9", border: "#b3c98a", text: "#455a28" }, // olive
  { bg: "#e3eef6", border: "#93b9d4", text: "#2f5570" }, // sky
  { bg: "#f6ebd8", border: "#d8bc7a", text: "#6a5320" }, // sand
  { bg: "#ebe4f5", border: "#b5a0d9", text: "#4d3a70" }, // violet
] as const;

export type TagChipColors = {
  background: string;
  border: string;
  text: string;
};

function hashSeed(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Persistable accent used when creating a tag (palette index hex bg). */
export function pickTagColor(seed: string): string {
  const idx = hashSeed(seed) % TAG_PALETTE.length;
  return TAG_PALETTE[idx]!.bg;
}

function findPaletteByBg(color: string): (typeof TAG_PALETTE)[number] | null {
  const key = color.trim().toLowerCase();
  return TAG_PALETTE.find((p) => p.bg.toLowerCase() === key) ?? null;
}

/** Resolve chip colors from stored tag.color or title seed. */
export function resolveTagChipColors(
  tag: { title: string; color: string | null },
): TagChipColors {
  if (tag.color) {
    const fromPalette = findPaletteByBg(tag.color);
    if (fromPalette) {
      return {
        background: fromPalette.bg,
        border: fromPalette.border,
        text: fromPalette.text,
      };
    }
    if (/^#[0-9a-fA-F]{3,8}$/.test(tag.color.trim())) {
      return {
        background: tag.color,
        border: tag.color,
        text: "var(--wb-text)",
      };
    }
  }
  const idx = hashSeed(tag.title) % TAG_PALETTE.length;
  const p = TAG_PALETTE[idx]!;
  return { background: p.bg, border: p.border, text: p.text };
}

/** Ensure legacy tags without color get a stable palette color. */
export function ensureTagColor(
  tag: { title: string; color: string | null },
): string {
  if (tag.color && findPaletteByBg(tag.color)) return tag.color;
  if (tag.color && /^#[0-9a-fA-F]{3,8}$/.test(tag.color.trim())) {
    return tag.color.trim();
  }
  return pickTagColor(tag.title);
}
