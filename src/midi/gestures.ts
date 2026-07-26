import type { MidiQuantizeDivision, ParsedMidi, ParsedMidiNote } from "./types";

export type MidiSlashGestureKind = "grace" | "arpeggio" | "triplet";

export interface MidiSlashGestureEvent {
  start: number;
  pitches: number[];
  track?: number;
  channel?: number;
}

export interface MidiSlashGesture {
  kind: MidiSlashGestureKind;
  /** Quantized score position, in quarter-note units. */
  anchor: number;
  /** Exclusive end of the gesture's occupied rhythmic span. */
  end: number;
  events: MidiSlashGestureEvent[];
  /** Nominal note value for one triplet member. */
  division?: MidiQuantizeDivision;
}

export interface MidiSlashGestureAnalysis {
  grace: MidiSlashGesture[];
  arpeggio: MidiSlashGesture[];
  triplet: MidiSlashGesture[];
}

interface TimedNote {
  source: ParsedMidiNote;
  start: number;
  end: number;
  pitch: number;
}

interface Onset {
  start: number;
  notes: TimedNote[];
}

const DIVISIONS: MidiQuantizeDivision[] = [4, 8, 16, 32, 64];

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function timedNotes(parsed: ParsedMidi): TimedNote[] {
  return parsed.notes.map((source) => ({
    source,
    start: source.startTick / parsed.ppq,
    end: source.endTick / parsed.ppq,
    pitch: source.pitch,
  }));
}

function onsetGroups(notes: readonly TimedNote[], tolerance = 1 / 192): Onset[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const result: Onset[] = [];
  for (const note of sorted) {
    const last = result[result.length - 1];
    if (last && Math.abs(note.start - last.start) <= tolerance) {
      last.notes.push(note);
      last.start = median(last.notes.map((item) => item.start));
    } else {
      result.push({ start: note.start, notes: [note] });
    }
  }
  return result;
}

function pitches(group: Onset): number[] {
  return [...new Set(group.notes.map((note) => note.pitch))].sort((a, b) => a - b);
}

function gestureEvent(group: Onset): MidiSlashGestureEvent {
  const source = group.notes[0]?.source;
  return {
    start: group.start,
    pitches: pitches(group),
    track: source?.track,
    channel: source?.channel,
  };
}

function roundedGrid(value: number, step: number): number {
  return Math.max(0, Math.round(value / step) * step);
}

function gridError(value: number, step: number): number {
  return Math.abs(value - Math.round(value / step) * step);
}

function noteKey(note: TimedNote): string {
  const source = note.source;
  return `${source.track}:${source.channel}:${source.startTick}:${source.pitch}`;
}

/**
 * Detect a rolled chord conservatively.  A candidate must contain at least
 * three strictly rising, single-note attacks from one track/channel whose
 * gaps are faster than the finest triplet admitted by the selected quantize
 * division, and which mostly overlap in sounding time. Requiring both the
 * sub-triplet speed and overlap avoids turning ordinary fast scales into
 * arpeggios. The importer later collapses the detected attacks onto `anchor`,
 * so changing the quantize selector genuinely recomputes the written chord.
 */
function detectArpeggios(
  notes: readonly TimedNote[],
  division: MidiQuantizeDivision,
  reserved: Set<string>,
): MidiSlashGesture[] {
  const step = 4 / division;
  const finestTripletCell = step * 2 / 3;
  // Stay outside the ±20% triplet acceptance band. A 64th-note roll at
  // 32nd-note quantize is 75% of a 32nd-note triplet cell and is therefore an
  // arpeggio, while a slightly humanized real triplet remains a triplet.
  const maxGap = finestTripletCell * 0.78;
  const byLane = new Map<string, TimedNote[]>();
  for (const note of notes) {
    const key = `${note.source.track}:${note.source.channel}`;
    const lane = byLane.get(key) ?? [];
    lane.push(note);
    byLane.set(key, lane);
  }

  const result: MidiSlashGesture[] = [];
  for (const lane of byLane.values()) {
    const groups = onsetGroups(lane);
    for (let index = 0; index < groups.length;) {
      if (groups[index].notes.length !== 1 || reserved.has(noteKey(groups[index].notes[0]))) {
        index++;
        continue;
      }
      const anchor = roundedGrid(groups[index].start, step);
      const run: Onset[] = [groups[index]];
      let cursor = index + 1;
      while (cursor < groups.length) {
        const previous = run[run.length - 1];
        const next = groups[cursor];
        if (next.notes.length !== 1 || reserved.has(noteKey(next.notes[0]))) break;
        const gap = next.start - previous.start;
        const rising = next.notes[0].pitch > previous.notes[0].pitch;
        const interval = next.notes[0].pitch - previous.notes[0].pitch;
        if (gap <= 1e-8 || gap > maxGap || !rising || interval > 12) break;
        run.push(next);
        cursor++;
      }

      if (run.length < 3) {
        index++;
        continue;
      }
      const intervals = run.slice(1).map((group, itemIndex) =>
        group.notes[0].pitch - run[itemIndex].notes[0].pitch);
      const chordLike = intervals.some((interval) => interval >= 3);
      const overlapPairs = run.slice(0, -1).filter((group, itemIndex) =>
        group.notes[0].end >= run[itemIndex + 1].start - 1 / 384).length;
      const overlapEnough = overlapPairs / (run.length - 1) >= 0.75;
      const firstStillDown = run[0].notes[0].end >= run[run.length - 1].start - 1 / 384;
      const velocities = run.map((group) => group.notes[0].source.velocity);
      const velocitySpread = Math.max(...velocities) - Math.min(...velocities);
      if (!chordLike || !overlapEnough || !firstStillDown || velocitySpread > 48) {
        index++;
        continue;
      }

      for (const group of run) reserved.add(noteKey(group.notes[0]));
      result.push({
        kind: "arpeggio",
        anchor,
        end: anchor + step,
        events: run.map(gestureEvent),
      });
      index = cursor;
    }
  }
  return result.sort((a, b) => a.anchor - b.anchor);
}

/**
 * Detect short acciaccatura-like attacks immediately before an on-grid main
 * note.  The short notes must be substantially shorter than the target and
 * are excluded from arpeggio candidates first.
 */
function detectGraceGroups(
  notes: readonly TimedNote[],
  division: MidiQuantizeDivision,
  reserved: Set<string>,
): MidiSlashGesture[] {
  const step = 4 / division;
  const maxShort = Math.min(0.125, step * 0.5);
  const byLane = new Map<string, TimedNote[]>();
  for (const note of notes) {
    const key = `${note.source.track}:${note.source.channel}`;
    const lane = byLane.get(key) ?? [];
    lane.push(note);
    byLane.set(key, lane);
  }

  const result: MidiSlashGesture[] = [];
  for (const lane of byLane.values()) {
    const groups = onsetGroups(lane);
    for (let mainIndex = 1; mainIndex < groups.length; mainIndex++) {
      const main = groups[mainIndex];
      const mainDuration = median(main.notes.map((note) => note.end - note.start));
      if (mainDuration < maxShort * 1.8 || gridError(main.start, step) > step * 0.22) continue;

      const grace: Onset[] = [];
      for (let cursor = mainIndex - 1; cursor >= 0 && grace.length < 3; cursor--) {
        const candidate = groups[cursor];
        if (candidate.notes.some((note) => reserved.has(noteKey(note)))) break;
        const duration = Math.max(...candidate.notes.map((note) => note.end - note.start));
        const nextStart = grace[0]?.start ?? main.start;
        if (duration > maxShort + 1e-8 || nextStart - candidate.start > maxShort * 1.6 + 1e-8) break;
        grace.unshift(candidate);
      }
      if (grace.length === 0) continue;
      const graceDuration = median(grace.flatMap((group) => group.notes.map((note) => note.end - note.start)));
      if (mainDuration < graceDuration * 2) continue;

      for (const group of grace) for (const note of group.notes) reserved.add(noteKey(note));
      result.push({
        kind: "grace",
        anchor: roundedGrid(main.start, step),
        end: roundedGrid(main.start, step),
        events: [
          ...grace.map(gestureEvent),
          gestureEvent(main),
        ],
      });
      mainIndex += grace.length;
    }
  }
  return result.sort((a, b) => a.anchor - b.anchor);
}

/** Detect complete local 3:2 groups using the same binary-vs-triplet test as quantization. */
function detectTriplets(
  notes: readonly TimedNote[],
  maxDivision: MidiQuantizeDivision,
  reserved: Set<string>,
): MidiSlashGesture[] {
  const groups = onsetGroups(notes).filter((group) =>
    group.notes.some((note) => !reserved.has(noteKey(note))));
  const allowed = DIVISIONS.filter((division) => division <= maxDivision);
  const result: MidiSlashGesture[] = [];
  for (let index = 0; index + 2 < groups.length;) {
    let best: { division: MidiQuantizeDivision; anchor: number; cell: number; error: number } | null = null;
    for (const division of allowed) {
      const nominal = 4 / division;
      const cell = nominal * 2 / 3;
      const anchor = roundedGrid(groups[index].start, nominal);
      const expected = [anchor, anchor + cell, anchor + 2 * cell];
      const errors = expected.map((value, offset) => Math.abs(groups[index + offset].start - value));
      const rms = Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / 3);
      if (rms > cell * 0.2) continue;
      const binaryStep = 4 / maxDivision;
      const binaryRms = Math.sqrt(
        [0, 1, 2].reduce((sum, offset) => sum + gridError(groups[index + offset].start, binaryStep) ** 2, 0) / 3,
      );
      if (binaryRms <= 1e-9 || rms > binaryRms * 0.65) continue;
      if (!best || rms < best.error) best = { division, anchor, cell, error: rms };
    }
    if (!best) {
      index++;
      continue;
    }
    result.push({
      kind: "triplet",
      anchor: best.anchor,
      end: best.anchor + best.cell * 3,
      division: best.division,
      events: [0, 1, 2].map((offset) => ({
        ...gestureEvent(groups[index + offset]),
        start: best!.anchor + offset * best!.cell,
      })),
    });
    index += 3;
  }
  return result;
}

export function detectMidiSlashGestures(
  parsed: ParsedMidi,
  division: MidiQuantizeDivision,
): MidiSlashGestureAnalysis {
  const notes = timedNotes(parsed);
  const reserved = new Set<string>();
  const arpeggio = detectArpeggios(notes, division, reserved);
  const grace = detectGraceGroups(notes, division, reserved);
  const triplet = detectTriplets(notes, division, reserved);
  return { grace, arpeggio, triplet };
}
