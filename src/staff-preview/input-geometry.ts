import { Fraction } from "../common/fraction";
import type { StaffInputPosition, StaffInputSpan } from "./types";

const LETTERS = "CDEFGAB";
const NATURAL = [0, 2, 4, 5, 7, 9, 11];

/** One authoritative snap set for pointer, ghost marker, and arrow navigation. */
export function staffSnapAnchors(span: StaffInputSpan): Array<{ tick: number; x: number }> {
  const ordinary = span.gridAnchors.filter(anchor => !anchor.muted && !span.tupletGroups.some(group =>
    anchor.tick >= group.startTick - 1e-8 && anchor.tick < group.endTick - 1e-8));
  const sorted = [...ordinary, ...span.tupletGroups.flatMap(group => group.anchors)].sort((a, b) => a.tick - b.tick);
  return sorted.filter((anchor, index) => index === 0 || Math.abs(anchor.tick - sorted[index - 1].tick) > 1e-8);
}

export function staffNextInputAnchor(span: StaffInputSpan, offset: string, direction: -1 | 1): { tick: number; x: number } | null {
  const tick = Fraction.fromString(offset).toFloat();
  const anchors = staffSnapAnchors(span);
  return direction > 0 ? anchors.find(anchor => anchor.tick > tick + 1e-8) ?? null
    : [...anchors].reverse().find(anchor => anchor.tick < tick - 1e-8) ?? null;
}

export function staffPitchAtY(span: StaffInputSpan, y: number, tick: number): Pick<StaffInputPosition, "midi" | "step" | "octave"> {
  const bottomDegree = span.clef === "bass" ? 18 : 30; // G2 / E4
  const degree = bottomDegree + Math.round((span.bottomLineY - y) / (span.lineSpacing / 2));
  const octave = Math.floor(degree / 7);
  const letter = ((degree % 7) + 7) % 7;
  const step = LETTERS[letter];
  const fifths = [...span.keyChanges].reverse().find(mark => mark.tick <= tick + 1e-8)?.fifths ?? span.fifths;
  const alteration = fifths > 0 ? "FCGDAEB".slice(0, Math.min(7, fifths)).includes(step) ? 1 : 0
    : "BEADGCF".slice(0, Math.min(7, -fifths)).includes(step) ? -1 : 0;
  return { midi: Math.max(0, Math.min(127, (octave + 1) * 12 + NATURAL[letter] + alteration)), step, octave };
}

export function staffInputAtPoint(spans: readonly StaffInputSpan[], x: number, y: number): { position: StaffInputPosition; span: StaffInputSpan; x: number; y: number } | null {
  const span = spans.filter(item => x >= item.xStart - 8 && x <= item.xEnd + 8 && y >= item.yTop && y <= item.yBottom)
    .sort((a, b) => Math.abs(y - (a.bottomLineY - a.lineSpacing * 2)) - Math.abs(y - (b.bottomLineY - b.lineSpacing * 2)))[0];
  if (!span) return null;
  const grid = staffSnapAnchors(span);
  if (!grid.length) return null;
  const anchor = grid.reduce((best, item) => Math.abs(item.x - x) < Math.abs(best.x - x) ? item : best, grid[0]);
  const pitch = staffPitchAtY(span, y, anchor.tick);
  const degree = pitch.octave * 7 + LETTERS.indexOf(pitch.step);
  const snappedY = span.bottomLineY - (degree - (span.clef === "bass" ? 18 : 30)) * span.lineSpacing / 2;
  return { position: { partIndex: span.partIndex, measureIndex: span.measureIndex,
    offset: new Fraction(Math.round(anchor.tick * 192), 192).toString(), gridDivision: span.division, ...pitch }, span, x: anchor.x, y: snappedY };
}

export function staffCursorPoint(span: StaffInputSpan, offset: string, midi: number | null,
  spelling?: { step?: string; octave?: number }): { x: number; y: number } {
  const tick = Fraction.fromString(offset).toFloat();
  const anchors = staffSnapAnchors(span);
  // Selection may start N on an engraved onset between ordinary ruler ticks.
  // Keep that initial cursor on the actual note column; arrows still use the snap set.
  const anchor = span.anchors.find(item => Math.abs(item.tick - tick) < 1e-8)
    ?? anchors.reduce((best, item) => Math.abs(item.tick - tick) < Math.abs(best.tick - tick) ? item : best, anchors[0]);
  let y = span.bottomLineY - 2 * span.lineSpacing;
  if (spelling?.step && LETTERS.includes(spelling.step) && spelling.octave !== undefined) {
    const degree = spelling.octave * 7 + LETTERS.indexOf(spelling.step);
    y = span.bottomLineY - (degree - (span.clef === "bass" ? 18 : 30)) * span.lineSpacing / 2;
  } else if (midi !== null) {
    // Resolve the closest displayed diatonic position under the local key.
    let best = Infinity;
    for (let degree = 0; degree < 75; degree++) {
      const candidateY = span.bottomLineY - (degree - (span.clef === "bass" ? 18 : 30)) * span.lineSpacing / 2;
      const pitch = staffPitchAtY(span, candidateY, tick);
      const distance = Math.abs(pitch.midi - midi);
      if (distance < best) { best = distance; y = candidateY; }
    }
  }
  return { x: anchor?.x ?? span.xStart, y };
}
