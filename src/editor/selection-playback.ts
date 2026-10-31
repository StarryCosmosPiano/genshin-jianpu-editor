import type { Note, Score } from "../score/score";
import { buildTimeline, quarterToSeconds } from "../score/timeline";
import type { InputAuditionNote } from "./player";

/** Exact score time decides whether a selection may be auditioned; performed
 * offsets decide how it sounds. A roll must not fail the same-onset check. */
export function selectionAudition(score: Score, selection: readonly Note[]): InputAuditionNote[] {
  const selected = new Set(selection.filter(note => !note.rest && !note.softDeleted));
  if (selected.size === 0 || selection.some(note =>
    !note.absoluteTick.equals(selection[0].absoluteTick))) return [];
  const timeline = buildTimeline(score, { writtenOrder: true });
  const events = timeline.notes.flatMap(event => {
    const source = event.sourceSegments.find(segment => selected.has(segment.note));
    if (!source) return [];
    return [{ ...event, t0: Math.max(event.t0, source.t0) }];
  });
  if (events.length === 0) return [];
  const start = quarterToSeconds(timeline.tempo,
    events.reduce((begin, event) => Math.min(begin, event.t0), Number.POSITIVE_INFINITY));
  return events.map(event => ({
    pitch: event.pitch,
    part: event.part,
    offsetSeconds: quarterToSeconds(timeline.tempo, event.t0) - start,
    durationSeconds: Math.max(0.05, quarterToSeconds(timeline.tempo, event.t1)
      - quarterToSeconds(timeline.tempo, event.t0)),
  }));
}
