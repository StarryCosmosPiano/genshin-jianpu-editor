import type { Note } from "../score/score";
import type { NoteTimingDivision } from "../score/note-timing";
import type { JpwSourceNote } from "./note-selection";
import type { InputCursorSnapshot } from "./input-mode";

/** Resolve only a concrete pitch under the active caret, never a nearby bar. */
export function sourceAtActiveEnd(
  sources: readonly JpwSourceNote[], head: number, anchor: number,
): JpwSourceNote | null {
  const position = head > anchor ? head - 1 : head;
  return sources.find((source) => source.from <= position && position < source.to)
    ?? (head === anchor ? sources.find((source) => source.to === head) : null)
    ?? null;
}

/** Visual continuation chords retain their own beat instead of the attack's. */
export function inputEntryFromNote(
  source: JpwSourceNote, visual: Note, division: NoteTimingDivision,
): InputCursorSnapshot {
  const chord = visual.chord;
  const tones = chord.notes.filter((note) => !note.rest).sort((a, b) => a.pitch - b.pitch);
  return {
    partIndex: source.partIndex,
    measureIndex: chord.measure.index,
    offset: chord.position.toString(),
    division,
    lane: "rest",
    focusPitch: visual.rest ? null : visual.pitch,
    verticalIndex: Math.max(0, tones.indexOf(visual)),
  };
}
