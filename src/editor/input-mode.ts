import { Fraction } from "../common/fraction";
import { Chord, Key, MusicCommon, Note, Score } from "../score/score";
import {
  type InputLane,
  type InputNoteSpec,
  type NotationCursor,
} from "../score/input-edit";
import { noteTimingStep, type NoteTimingDivision } from "../score/note-timing";

export type ScoreInteractionMode = "select" | "input";

export interface InputCursorSnapshot {
  partIndex: number;
  measureIndex: number;
  offset: string;
  division: NoteTimingDivision;
  lane: InputLane;
  focusPitch: number | null;
  verticalIndex?: number;
}

const ZERO = new Fraction(0);
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11] as const;

function meterLength(score: Score, partIndex: number, measureIndex: number): Fraction {
  const part = score.parts[partIndex] ?? score.parts[0];
  const measure = part?.measures[measureIndex]
    ?? part?.measures[Math.max(0, part.measures.length - 1)]
    ?? score.parts[0]?.measures[Math.max(0, (score.parts[0]?.measures.length ?? 1) - 1)];
  return measure
    ? new Fraction(measure.time.beats * 4, measure.time.beatType)
    : new Fraction(4);
}

export function scoreInputTailMeasure(score: Score): number {
  return Math.max(0, ...score.parts.map((part) => part.measures.length - 1));
}

export function inputChordAt(
  score: Score,
  cursor: Pick<NotationCursor, "partIndex" | "measureIndex" | "offset">,
): Chord | null {
  const measure = score.parts[cursor.partIndex]?.measures[cursor.measureIndex];
  if (!measure) return null;
  return measure.entries.find((entry): entry is Chord =>
    entry instanceof Chord
    && !entry.generatedTimingContinuation
    && entry.position.equals(cursor.offset)) ?? null;
}

export function inputNoteClosestToPitch(chord: Chord | null, pitch: number | null): Note | null {
  const notes = chord?.notes.filter((note) => !note.rest) ?? [];
  if (notes.length === 0) return null;
  if (pitch === null) return [...notes].sort((left, right) => left.pitch - right.pitch)[0];
  return [...notes].sort((left, right) =>
    Math.abs(left.pitch - pitch) - Math.abs(right.pitch - pitch)
    || left.pitch - right.pitch)[0];
}

/** Resolve the key that is active at an exact score position. */
export function inputKeyAt(
  score: Score,
  partIndex: number,
  measureIndex: number,
  offset: Fraction,
): Key {
  const measure = score.parts[partIndex]?.measures[measureIndex]
    ?? score.parts[0]?.measures[measureIndex];
  let fifths = measure?.key.fifths ?? 0;
  const marks = score.keyMarks
    .filter((mark) => mark.measure < measureIndex
      || (mark.measure === measureIndex && mark.offset.compareTo(offset) <= 0))
    .sort((left, right) => left.measure - right.measure
      || left.offset.compareTo(right.offset));
  if (marks.length > 0) fifths = marks[marks.length - 1].fifths;
  return Object.assign(new Key(), { fifths });
}

/** Build a new numbered-notation pitch at the local tonic and octave. */
export function inputDegreeSpec(
  score: Score,
  cursor: Pick<NotationCursor, "partIndex" | "measureIndex" | "offset">,
  degree: 1 | 2 | 3 | 4 | 5 | 6 | 7,
  octave = 0,
): InputNoteSpec {
  const key = inputKeyAt(score, cursor.partIndex, cursor.measureIndex, cursor.offset);
  return {
    pitch: MusicCommon.getBasePitchOfKey(key) + MAJOR_SCALE[degree - 1] + octave * 12,
    number: String(degree),
    jpOctave: octave,
    jpAlter: " ",
  };
}

/** Session-only notation cursor. It is deliberately never serialized. */
export class ScoreInputSession {
  mode: ScoreInteractionMode = "select";
  cursor: NotationCursor | null = null;
  focusPitch: number | null = null;

  get enabled(): boolean {
    return this.mode === "input";
  }

  setEnabled(score: Score, enabled: boolean, division: NoteTimingDivision, entry?: InputCursorSnapshot | null): void {
    this.mode = enabled ? "input" : "select";
    if (!enabled || entry === null) {
      this.cursor = null;
      this.focusPitch = null;
      return;
    }
    if (entry) {
      this.restore(score, { ...entry, division });
      return;
    }
    if (!this.cursor) {
      this.cursor = {
        partIndex: 0,
        measureIndex: 0,
        offset: ZERO,
        division,
        lane: "rest",
        verticalIndex: 0,
      };
    }
    this.cursor.division = division;
    this.normalize(score);
  }

  setCursor(
    score: Score,
    cursor: Omit<NotationCursor, "division"> & { division?: NoteTimingDivision },
    focusPitch: number | null = null,
  ): void {
    this.mode = "input";
    this.cursor = {
      ...cursor,
      offset: new Fraction(cursor.offset.numerator, cursor.offset.denominator),
      division: cursor.division ?? this.cursor?.division ?? 16,
    };
    this.focusPitch = focusPitch;
    this.normalize(score);
  }

  setDivision(division: NoteTimingDivision): void {
    if (this.cursor) this.cursor.division = division;
  }

  setLane(lane: InputLane): void {
    if (this.cursor) this.cursor.lane = lane;
  }

  moveHorizontal(score: Score, direction: -1 | 1): NotationCursor | null {
    const cursor = this.cursor;
    if (!cursor) return null;
    return this.moveByDuration(score, noteTimingStep(cursor.division).timesInt(direction));
  }

  /** Move by an explicit musical duration while retaining the cursor's visual
   * grid division. Used by dotted grids and Space-to-advance input. */
  moveByDuration(score: Score, duration: Fraction): NotationCursor | null {
    const cursor = this.cursor;
    if (!cursor || duration.equals(ZERO)) return cursor;
    const direction = duration.compareTo(ZERO) > 0 ? 1 : -1;
    let offset = cursor.offset.plus(duration);
    let measureIndex = cursor.measureIndex;
    if (direction > 0) {
      let length = meterLength(score, cursor.partIndex, measureIndex);
      while (offset.compareTo(length) >= 0) {
        // Advancing beyond the final bar must not wrap to its opening and
        // overwrite an earlier note on the next key press. Bar creation is
        // an explicit edit; navigation stays at the last reachable position.
        if (measureIndex >= scoreInputTailMeasure(score)) {
          if (measureIndex === cursor.measureIndex) return cursor;
          offset = length.minus(noteTimingStep(cursor.division));
          if (offset.compareTo(ZERO) < 0) offset = ZERO;
          break;
        }
        offset = offset.minus(length);
        measureIndex++;
        length = meterLength(score, cursor.partIndex, measureIndex);
      }
    } else {
      while (offset.compareTo(ZERO) < 0 && measureIndex > 0) {
        measureIndex--;
        offset = offset.plus(meterLength(score, cursor.partIndex, measureIndex));
      }
      if (offset.compareTo(ZERO) < 0) offset = ZERO;
    }
    cursor.measureIndex = Math.min(scoreInputTailMeasure(score), measureIndex);
    cursor.offset = offset;
    cursor.lane = "rest";
    cursor.verticalIndex = 0;
    this.focusPitch = inputNoteClosestToPitch(inputChordAt(score, cursor), this.focusPitch)?.pitch ?? null;
    return cursor;
  }

  movePart(score: Score, direction: -1 | 1): NotationCursor | null {
    const cursor = this.cursor;
    if (!cursor || score.parts.length === 0) return null;
    cursor.partIndex = Math.max(0, Math.min(score.parts.length - 1, cursor.partIndex + direction));
    cursor.measureIndex = Math.min(cursor.measureIndex, scoreInputTailMeasure(score));
    cursor.lane = "rest";
    cursor.verticalIndex = 0;
    this.focusPitch = inputNoteClosestToPitch(inputChordAt(score, cursor), this.focusPitch)?.pitch ?? null;
    return cursor;
  }

  octaveFocus(score: Score, delta: -1 | 1): Note | null {
    if (!this.cursor) return null;
    const note = inputNoteClosestToPitch(inputChordAt(score, this.cursor), this.focusPitch);
    if (!note) return null;
    note.pitch += delta * 12;
    note.jpOctave += delta;
    note.octave += delta;
    this.focusPitch = note.pitch;
    return note;
  }

  snapshot(): InputCursorSnapshot | null {
    if (!this.cursor) return null;
    return {
      partIndex: this.cursor.partIndex,
      measureIndex: this.cursor.measureIndex,
      offset: this.cursor.offset.toString(),
      division: this.cursor.division,
      lane: this.cursor.lane,
      focusPitch: this.focusPitch,
      verticalIndex: this.cursor.verticalIndex,
    };
  }

  restore(score: Score, snapshot: InputCursorSnapshot | null): void {
    if (!snapshot) return;
    this.cursor = {
      partIndex: snapshot.partIndex,
      measureIndex: snapshot.measureIndex,
      offset: Fraction.fromString(snapshot.offset),
      division: snapshot.division,
      lane: snapshot.lane,
      verticalIndex: snapshot.verticalIndex,
    };
    this.focusPitch = snapshot.focusPitch;
    this.mode = "input";
    this.normalize(score);
  }

  private normalize(score: Score): void {
    if (!this.cursor) return;
    this.cursor.partIndex = Math.max(0, Math.min(
      Math.max(0, score.parts.length - 1),
      this.cursor.partIndex,
    ));
    this.cursor.measureIndex = Math.max(0, Math.min(
      scoreInputTailMeasure(score),
      this.cursor.measureIndex,
    ));
    const length = meterLength(score, this.cursor.partIndex, this.cursor.measureIndex);
    if (this.cursor.offset.compareTo(ZERO) < 0) this.cursor.offset = ZERO;
    if (this.cursor.offset.compareTo(length) >= 0) {
      this.cursor.offset = length.minus(noteTimingStep(this.cursor.division));
      if (this.cursor.offset.compareTo(ZERO) < 0) this.cursor.offset = ZERO;
    }
  }
}
