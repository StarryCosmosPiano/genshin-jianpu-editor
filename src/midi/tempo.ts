import type { ParsedMidi } from "./types";

export type DetectedTempoMarkKind = "accel" | "rit" | "tempo";

export interface DetectedTempoMark {
  /** Absolute position in quarter-note units. */
  position: number;
  kind: DetectedTempoMarkKind;
  bpm: number | null;
}

interface TempoPoint {
  tick: number;
  bpm: number;
}

interface TempoChange {
  from: TempoPoint;
  to: TempoPoint;
  direction: 1 | -1;
}

function normalizedTempos(parsed: ParsedMidi): TempoPoint[] {
  const byTick = new Map<number, number>();
  for (const event of parsed.tempos) {
    if (!Number.isFinite(event.tick) || !Number.isFinite(event.bpm) || event.tick < 0 || event.bpm <= 0) continue;
    byTick.set(Math.round(event.tick), event.bpm);
  }
  return [...byTick]
    .map(([tick, bpm]) => ({ tick, bpm }))
    .sort((left, right) => left.tick - right.tick);
}

function tempoDirection(from: number, to: number): 1 | -1 | 0 {
  // Tempo curves exported by DAWs often contain tiny floating-point jitter.
  // Ignore changes below both half a BPM and 0.2% of the current tempo.
  const tolerance = Math.max(0.5, Math.abs(from) * 0.002);
  const delta = to - from;
  if (Math.abs(delta) < tolerance) return 0;
  return delta > 0 ? 1 : -1;
}

/**
 * Converts a MIDI tempo map to publication-style annotations.
 *
 * A genuine ramp contains at least two consecutive changes in one direction.
 * The exact size of each step may vary, so both straight and curved DAW tempo
 * ramps are recognized.  MIDI stores tempo as point events: the preceding
 * point is the last fixed tempo, while the first changed point is where the
 * visible accel./rit. instruction belongs. A lone jump remains an ordinary
 * metronome mark.
 */
export function detectMidiTempoMarks(parsed: ParsedMidi): DetectedTempoMark[] {
  const points = normalizedTempos(parsed);
  if (points.length < 2) return [];

  const changes: TempoChange[] = [];
  for (let index = 1; index < points.length; index++) {
    const direction = tempoDirection(points[index - 1].bpm, points[index].bpm);
    if (direction === 0) continue;
    changes.push({ from: points[index - 1], to: points[index], direction });
  }
  if (changes.length === 0) return [];

  const groups: TempoChange[][] = [];
  for (const change of changes) {
    const group = groups[groups.length - 1];
    const previous = group?.[group.length - 1];
    const separatedByStableRegion = previous
      ? change.from.tick - previous.to.tick > parsed.ppq * 2 ||
        change.to.tick - change.from.tick > parsed.ppq * 2
      : false;
    if (!group || previous.direction !== change.direction || separatedByStableRegion) {
      groups.push([change]);
    } else {
      group.push(change);
    }
  }

  const result: DetectedTempoMark[] = [];
  for (const group of groups) {
    const first = group[0];
    const last = group[group.length - 1];
    if (group.length >= 2) {
      result.push({
        // Do not place the instruction on the preceding fixed-tempo beat
        // (frequently tick 0). It begins at the first BPM that actually moves
        // away from that fixed value.
        position: first.to.tick / parsed.ppq,
        kind: first.direction > 0 ? "accel" : "rit",
        bpm: null,
      });
      result.push({
        position: last.to.tick / parsed.ppq,
        kind: "tempo",
        bpm: Math.max(1, Math.round(last.to.bpm)),
      });
    } else {
      result.push({
        position: last.to.tick / parsed.ppq,
        kind: "tempo",
        bpm: Math.max(1, Math.round(last.to.bpm)),
      });
    }
  }

  const unique = result
    .sort((left, right) => left.position - right.position || left.kind.localeCompare(right.kind))
    .filter((mark, index, all) => index === 0 ||
      Math.abs(mark.position - all[index - 1].position) > 1e-8 ||
      mark.kind !== all[index - 1].kind ||
      mark.bpm !== all[index - 1].bpm);

  // A DAW tempo curve often settles with one tiny corrective point immediately
  // after its apparent endpoint (for example 80 -> 78 within a sixteenth
  // note). Printing both concrete metronome marks makes them occupy the same
  // rhythmic column. Treat such an adjacent correction as the final settled
  // value, while keeping genuinely separated tempo changes intact.
  const coalesced: DetectedTempoMark[] = [];
  for (const mark of unique) {
    const previous = coalesced[coalesced.length - 1];
    if (mark.kind === "tempo" &&
        previous?.kind === "tempo" &&
        mark.position - previous.position <= 0.25 + 1e-8) {
      coalesced[coalesced.length - 1] = mark;
    } else {
      coalesced.push(mark);
    }
  }
  return coalesced;
}
