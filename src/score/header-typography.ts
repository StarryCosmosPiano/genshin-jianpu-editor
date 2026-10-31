/** Document-owned, unscaled point sizes. Missing entries inherit renderer defaults. */
export const HEADER_TEXT_FIELDS = ["title", "subtitle", "lyricist", "composer", "arranger"] as const;
export type HeaderTextField = typeof HEADER_TEXT_FIELDS[number];
export type HeaderTypography = Partial<Record<HeaderTextField, number>>;

export function normalizeHeaderTypography(value: unknown): HeaderTypography | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: HeaderTypography = {};
  for (const field of HEADER_TEXT_FIELDS) {
    const size = (value as Record<string, unknown>)[field];
    if (typeof size === "number" && Number.isFinite(size) && size >= 8 && size <= 144) result[field] = size;
  }
  return Object.keys(result).length ? result : undefined;
}

export function parseHeaderTypography(text: string | null | undefined): HeaderTypography | undefined {
  if (!text) return undefined;
  try { return normalizeHeaderTypography(JSON.parse(text)); } catch { return undefined; }
}

/** Apply the content scale exactly once; fallbackPt is also unscaled. */
export function headerFontSize(field: HeaderTextField, typography: HeaderTypography | undefined,
  fallbackPt: number, contentScale: number): number {
  return (typography?.[field] ?? fallbackPt) * contentScale;
}
