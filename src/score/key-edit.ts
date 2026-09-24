import { Fraction } from "../common/fraction";
import { Chord, KeyMark, MusicCommon, Note, Score } from "./score";

function anchorCompare(
  left: { measure: number; offset: Fraction },
  right: { measure: number; offset: Fraction },
): number {
  return left.measure - right.measure || left.offset.compareTo(right.offset);
}

function absolutePosition(note: Note): { measure: number; offset: Fraction } {
  return {
    measure: note.chord.measure.index,
    offset: note.chord.position,
  };
}

function tieRoot(note: Note): Note {
  let current = note;
  const seen = new Set<Note>();
  while (current.tiePrev && !seen.has(current.tiePrev)) {
    seen.add(current);
    current = current.tiePrev;
  }
  return current;
}

function inRange(
  position: { measure: number; offset: Fraction },
  start: { measure: number; offset: Fraction },
  end: { measure: number; offset: Fraction } | null,
): boolean {
  if (anchorCompare(position, start) < 0) return false;
  return end === null || anchorCompare(position, end) < 0;
}

/**
 * Apply a local key change while preserving the visible numbered degree.
 *
 * `number`, `jpOctave` and `jpAlter` are intentionally untouched. Only the
 * sounding MIDI pitch is moved, and only until the next precise KeyMark. A
 * tie whose root attack predates the anchor is left untouched so a sustained
 * note is not silently re-tuned in the middle of its chain.
 */
export function applyKeyChangeKeepingDegrees(
  score: Score,
  partIndex: number,
  measureIndex: number,
  offset: Fraction,
  fifths: number,
): boolean {
  const part = score.parts[partIndex];
  if (!part || measureIndex < 0 || measureIndex >= part.measures.length) return false;
  if (fifths < -7 || fifths > 7 || !Number.isInteger(fifths)) return false;
  if (offset.compareTo(new Fraction(0)) < 0) return false;

  const start = { measure: measureIndex, offset };
  const sorted = [...score.keyMarks]
    .filter((mark) => mark.measure >= 0 && mark.offset.compareTo(new Fraction(0)) >= 0)
    .sort(anchorCompare);
  const existing = sorted.find((mark) =>
    mark.measure === measureIndex && mark.offset.equals(offset));
  const previousMarks = [...sorted]
    .filter((mark) => anchorCompare(mark, start) < 0);
  const previous = previousMarks.length > 0 ? previousMarks[previousMarks.length - 1] : undefined;
  const oldFifths = existing?.fifths ?? previous?.fifths ?? part.measures[measureIndex].key.fifths;
  const oldTonic = MusicCommon.getBasePitchOfKey({ fifths: oldFifths, name: "" } as { fifths: number; name: string });
  const newTonic = MusicCommon.getBasePitchOfKey({ fifths, name: "" } as { fifths: number; name: string });
  const delta = newTonic - oldTonic;
  const next = sorted.find((mark) => anchorCompare(mark, start) > 0) ?? null;

  if (existing) existing.fifths = fifths;
  else score.keyMarks.push(new KeyMark(measureIndex, offset, fifths));
  score.keyMarks.sort(anchorCompare);

  // An exact beat-zero key can be reflected in the legacy Measure cache. A
  // mid-measure mark must not change the measure's opening key.
  if (offset.equals(new Fraction(0))) {
    for (const scorePart of score.parts) {
      const measure = scorePart.measures[measureIndex];
      if (!measure) continue;
      measure.key.fifths = fifths;
      measure.keyChange = measureIndex > 0;
    }
  }
  if (delta === 0) return true;

  for (const scorePart of score.parts) {
    for (const measure of scorePart.measures) {
      for (const entry of measure.entries) {
        if (!(entry instanceof Chord)) continue;
        for (const note of [...entry.notes, ...entry.graceNotes]) {
          if (note.rest || note.softDeleted) continue;
          const position = absolutePosition(note);
          if (!inRange(position, start, next)) continue;
          const root = tieRoot(note);
          if (anchorCompare(absolutePosition(root), start) < 0) continue;
          note.pitch += delta;
        }
      }
    }
  }
  return true;
}
