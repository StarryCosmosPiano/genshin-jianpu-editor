import { Fraction } from "../common/fraction";
import { Chord, Key, Measure, type Note, type Score } from "../score/score";
import {
  completeInputMeasure, ensureInputMeasure, inputNoteAtCursor, inputTupletAtCursor,
  resizeInputTuplet, tupletWrittenToActual,
  type InputEditResult, type InputNoteSpec, type NotationCursor,
} from "../score/input-edit";
import { resizeScoreNoteSegmentsWithRests } from "../score/note-timing";

export interface InputInsertionResult extends InputEditResult {
  blocked: boolean;
  reason?: "invalid-duration" | "occupied-domain" | "duration-unavailable";
}

const ZERO = new Fraction(0);
const meterLength = (measure: Measure): Fraction => new Fraction(measure.time.beats * 4, measure.time.beatType);

/** Stop a new attack at the next independent onset or fixed tuplet cell.
 * Tied tails are replaceable silence for this purpose; another voice lives
 * in a different Part and must never constrain this cursor. */
export function availableInputDuration(score: Score, cursor: NotationCursor, requested: Fraction): Fraction {
  const part = score.parts[cursor.partIndex];
  const measure = part?.measures[cursor.measureIndex];
  if (!measure) return requested;
  const at = measure.position.plus(cursor.offset);
  let result = requested;
  for (const bar of part.measures) for (const entry of bar.entries) {
    if (!(entry instanceof Chord) || !entry.notes.some(note => note.tuplet
      || (!entry.rest && !note.rest && !note.softDeleted && !note.tiePrev && !note.tieEnd))) continue;
    const distance = bar.position.plus(entry.position).minus(at);
    if (distance.compareTo(ZERO) > 0 && distance.compareTo(result) < 0) result = distance;
  }
  return result;
}

function ordinaryPrecision(value: Fraction): boolean {
  return Number.isFinite(value.toFloat()) && value.timesInt(16).denominator === 1;
}

function directlyWritten(value: Fraction): boolean {
  for (let beams = 0; beams <= 4; beams++) {
    const base = new Fraction(1, 1 << beams);
    if (value.equals(base) || value.equals(base.timesInt(3).divInt(2))) return true;
  }
  return value.equals(2) || value.equals(3) || value.equals(4);
}

function soundDuration(note: Note): Fraction {
  let duration = ZERO;
  const seen = new Set<Note>();
  let current: Note | null = note;
  while (current && !seen.has(current)) {
    seen.add(current); duration = duration.plus(current.chord.duration ?? ZERO); current = current.tieNext;
  }
  return duration;
}

/** Ensure every hand has the same appended bar, preserving the inherited key. */
export function synchronizedInputMeasure(score: Score, index: number): boolean {
  let created = false;
  for (let partIndex = 0; partIndex < score.parts.length; partIndex++) {
    const part = score.parts[partIndex];
    const oldCount = part.measures.length;
    const result = ensureInputMeasure(score, partIndex, index);
    created = result.created || created;
    for (let bar = oldCount; bar < part.measures.length; bar++) {
      const previous = part.measures[bar - 1];
      if (previous) part.measures[bar].key = Object.assign(new Key(), previous.key);
    }
  }
  return created;
}

/** Insert only into a disposable transaction draft. A blocked result requires
 * discarding that draft, including any new bars and partially inserted tone. */
export function insertInputNoteWithDuration(score: Score, cursor: NotationCursor,
  spec: InputNoteSpec, requestedDuration: Fraction): InputInsertionResult {
  const originalMeasure = score.parts[cursor.partIndex]?.measures[cursor.measureIndex];
  const rejected = (reason: InputInsertionResult["reason"], result?: InputEditResult): InputInsertionResult => ({
    ...(result ?? { changed: false, measure: originalMeasure ?? new Measure(cursor.measureIndex),
      chord: null, note: null, createdMeasure: false, splitRests: 0 }),
    changed: false, blocked: true, reason,
  });
  if (!score.parts[cursor.partIndex] || cursor.measureIndex < 0 || cursor.offset.compareTo(ZERO) < 0
    || !Number.isFinite(requestedDuration.toFloat()) || requestedDuration.compareTo(ZERO) <= 0)
    return rejected("invalid-duration");
  let created = synchronizedInputMeasure(score, cursor.measureIndex);
  const measure = score.parts[cursor.partIndex].measures[cursor.measureIndex];
  if (cursor.offset.compareTo(meterLength(measure)) >= 0) return rejected("occupied-domain");
  const at = measure.position.plus(cursor.offset);
  const existing = measure.entries.find((entry): entry is Chord => entry instanceof Chord
    && entry.position.equals(cursor.offset) && !entry.rest && entry.notes.some(note => !note.rest));
  const tuplet = inputTupletAtCursor(score, cursor);
  let effectiveDuration = requestedDuration;
  if (!existing && !tuplet) {
    effectiveDuration = availableInputDuration(score, cursor, requestedDuration);
    // JPW ordinary values stop at 64ths. Reject finer/non-binary gaps before
    // touching their contents; the transaction shell preserves the source.
    if (!ordinaryPrecision(effectiveDuration) || !ordinaryPrecision(cursor.offset))
      return rejected("duration-unavailable");
  }
  const requiredEnd = at.plus(effectiveDuration);
  // An irregular binary gap (e.g. 7/16 of a beat) needs tied written pieces.
  // Start with a valid 64th and let the existing normalizer spell its span.
  const seedDuration = !existing && !tuplet && !directlyWritten(effectiveDuration)
    ? new Fraction(1, 16) : effectiveDuration;
  const result = inputNoteAtCursor(score, cursor, spec, seedDuration);
  if (!result.changed || !result.note || !result.chord || !result.chord.duration)
    return rejected("duration-unavailable", result);
  // Adding a tone to an occupied column deliberately retains its shared value.
  // A fixed 3:2 rest/member also owns its intrinsic written value.
  if (existing || result.fixedTupletCell) return { ...result, createdMeasure: created || result.createdMeasure, blocked: false };
  const note = result.note;
  if (tuplet && !note.tuplet) return rejected("occupied-domain", result);
  if (note.tuplet) {
    const wanted = tupletWrittenToActual(requestedDuration, note.tuplet);
    for (let guard = 0; guard < 1024; guard++) {
      const delta = wanted.minus(soundDuration(note));
      if (delta.equals(ZERO)) return { ...result, createdMeasure: created || result.createdMeasure, blocked: false };
      const resized = resizeInputTuplet(score, note, delta);
      if (!resized.changed) return rejected("duration-unavailable", result);
    }
    return rejected("duration-unavailable", result);
  }
  if (soundDuration(note).compareTo(effectiveDuration) < 0) {
    const part = score.parts[cursor.partIndex];
    for (let guard = 0; guard < 1024; guard++) {
      const last = part.measures[part.measures.length - 1];
      if (last.position.plus(meterLength(last)).compareTo(requiredEnd) >= 0) break;
      created = synchronizedInputMeasure(score, part.measures.length) || created;
    }
    const last = part.measures[part.measures.length - 1];
    if (last.position.plus(meterLength(last)).compareTo(requiredEnd) < 0) return rejected("duration-unavailable", result);
    // TXT can contain implicit silence; expose it in the draft before asking
    // the existing rest-consuming normalizer to produce the full tied span.
    for (const bar of part.measures) if (bar.position.compareTo(requiredEnd) < 0
      && bar.position.plus(meterLength(bar)).compareTo(at) > 0)
      completeInputMeasure(score, { partIndex: cursor.partIndex, measureIndex: bar.index }, true);
    const resized = resizeScoreNoteSegmentsWithRests(score,
      [{ partIndex: cursor.partIndex, note, grace: false }], effectiveDuration.minus(soundDuration(note)));
    if (!resized.changed || resized.blocked) return rejected("duration-unavailable", result);
  }
  if (!soundDuration(note).equals(effectiveDuration)) return rejected("duration-unavailable", result);
  if (created) score.parseRepeatInf();
  return { ...result, createdMeasure: created || result.createdMeasure, blocked: false };
}
