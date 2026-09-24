/** A filled staff brace with tapered ends and a narrow centre cusp.
 * Coordinates are local SVG units, so the same outline serves the score and
 * the engraving-settings preview without stretching a font glyph vertically.
 */
export type BracePathSegment = { op: "M" | "C" | "Z"; pts: number[] };

export function staffBraceSegments(width: number, height: number, strokeWidth: number): BracePathSegment[] {
  const w = Math.max(0.1, width);
  const h = Math.max(0.1, height);
  // The thickness control moves only the inner contour. The outer width and
  // tapered tips stay fixed, even for the broadest user-selected weight.
  const inner = Math.min(w * 0.68, Math.max(w * 0.07, strokeWidth * 0.8));
  return [
    { op: "M", pts: [w, 0] },
    { op: "C", pts: [w * 0.54, h * 0.04, w * 0.22, h * 0.15, w * 0.3, h * 0.25] },
    { op: "C", pts: [w * 0.38, h * 0.37, w * 0.54, h * 0.42, 0, h * 0.5] },
    { op: "C", pts: [w * 0.66, h * 0.45, w * 0.3 + inner, h * 0.36, w * 0.3 + inner, h * 0.25] },
    { op: "C", pts: [w * 0.3 + inner, h * 0.16, w * 0.67, h * 0.07, w, 0] },
    { op: "Z", pts: [] },
    { op: "M", pts: [w, h] },
    { op: "C", pts: [w * 0.54, h * 0.96, w * 0.22, h * 0.85, w * 0.3, h * 0.75] },
    { op: "C", pts: [w * 0.38, h * 0.63, w * 0.54, h * 0.58, 0, h * 0.5] },
    { op: "C", pts: [w * 0.66, h * 0.55, w * 0.3 + inner, h * 0.64, w * 0.3 + inner, h * 0.75] },
    { op: "C", pts: [w * 0.3 + inner, h * 0.84, w * 0.67, h * 0.93, w, h] },
    { op: "Z", pts: [] },
  ];
}

export function staffBracePathD(width: number, height: number, strokeWidth: number): string {
  return staffBraceSegments(width, height, strokeWidth)
    .map((segment) => segment.op === "Z" ? "Z" : `${segment.op}${segment.pts.join(" ")}`)
    .join(" ");
}
