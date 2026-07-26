import { Fraction } from "../common/fraction";
import {
  AccidentalStat,
  BarStyle,
  Chord,
  Key,
  Measure,
  MusicCommon,
  Note,
  normalizeOpeningPickup,
  Part,
  Score,
  TempoMark,
  Time,
  Tuplet,
} from "../score/score";
import type {
  MidiAnalysis,
  MidiDurationCounts,
  MidiImportOptions,
  MidiImportResult,
  MidiQuantizeDivision,
  MidiTrackAssignment,
  ParsedMidi,
  ParsedMidiNote,
} from "./types";
import {
  detectMidiSlashGestures,
  type MidiSlashGesture,
  type MidiSlashGestureAnalysis,
} from "./gestures";
import { detectMidiTempoMarks } from "./tempo";

const DIVISIONS: MidiQuantizeDivision[] = [4, 8, 16, 32, 64];
const RECOMMENDATION_MIN_SHARE = 0.02;
const STEP_PC = [0, 2, 4, 5, 7, 9, 11];
const STEP_NAME = "CDEFGAB";

interface WorkNote {
  source: ParsedMidiNote;
  start: number;
  end: number;
  pitch: number;
}

interface TripletMark {
  id: number;
  division: MidiQuantizeDivision;
  index: 0 | 1 | 2;
  anchor: number;
  cell: number;
}

interface OnsetGroup {
  start: number;
  notes: WorkNote[];
  triplet?: Omit<TripletMark, "index">;
  tripletIndex?: 0 | 1 | 2;
}

interface QuantizedNote {
  start: number;
  end: number;
  pitch: number;
  triplet: TripletMark | null;
}

interface QuantizedChord {
  start: number;
  end: number;
  sourceEnds: number[];
  pitches: number[];
  triplet: TripletMark | null;
}

interface HandEvents {
  events: QuantizedChord[];
  tripletGroups: number;
  simplifiedOverlaps: number;
}

interface MeasureBound {
  start: number;
  end: number;
  beats: number;
  beatType: number;
  timeChange: boolean;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function workNotes(parsed: ParsedMidi): WorkNote[] {
  return parsed.notes.map((n) => ({
    source: n,
    start: n.startTick / parsed.ppq,
    end: n.endTick / parsed.ppq,
    pitch: n.pitch,
  }));
}

function isDetectedGraceNote(note: WorkNote, gestures: MidiSlashGestureAnalysis): boolean {
  const tolerance = 1 / 192 + 1e-8;
  for (const gesture of gestures.grace) {
    for (const event of gesture.events.slice(0, -1)) {
      if (event.track !== undefined && event.track !== note.source.track) continue;
      if (event.channel !== undefined && event.channel !== note.source.channel) continue;
      if (Math.abs(event.start - note.start) > tolerance) continue;
      if (event.pitches.includes(note.pitch)) return true;
    }
  }
  return false;
}

function snapDetectedArpeggios(
  notes: readonly WorkNote[],
  gestures: MidiSlashGestureAnalysis,
): WorkNote[] {
  const tolerance = 1 / 192 + 1e-8;
  return notes.map((note) => {
    for (const gesture of gestures.arpeggio) {
      const matched = gesture.events.some((event) => {
        if (event.track !== undefined && event.track !== note.source.track) return false;
        if (event.channel !== undefined && event.channel !== note.source.channel) return false;
        return Math.abs(event.start - note.start) <= tolerance && event.pitches.includes(note.pitch);
      });
      if (!matched) continue;
      return {
        ...note,
        start: gesture.anchor,
        end: Math.max(note.end, gesture.anchor + 1 / 384),
      };
    }
    return note;
  });
}

function onsetGroups(notes: WorkNote[], tolerance = 1 / 64): OnsetGroup[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const groups: OnsetGroup[] = [];
  for (const note of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(note.start - last.start) <= tolerance) {
      last.notes.push(note);
      last.start = median(last.notes.map((n) => n.start));
    } else {
      groups.push({ start: note.start, notes: [note] });
    }
  }
  return groups;
}

function nearestGridError(value: number, step: number): number {
  return Math.abs(value - Math.round(value / step) * step);
}

/** Mark non-overlapping, complete local 3:2 groups. Binary wins on close calls. */
function markTriplets(groups: OnsetGroup[], maxDivision: MidiQuantizeDivision): number {
  let nextId = 1;
  let count = 0;
  const allowed = DIVISIONS.filter((d) => d <= maxDivision);
  for (let i = 0; i + 2 < groups.length;) {
    let best: { division: MidiQuantizeDivision; anchor: number; cell: number; error: number } | null = null;
    for (const division of allowed) {
      const nominal = 4 / division;
      const cell = nominal * 2 / 3;
      const anchor = Math.round(groups[i].start / nominal) * nominal;
      const expected = [anchor, anchor + cell, anchor + 2 * cell];
      const errors = expected.map((x, k) => Math.abs(groups[i + k].start - x));
      const rms = Math.sqrt(errors.reduce((s, x) => s + x * x, 0) / 3);
      if (rms > cell * 0.2) continue;
      const binaryStep = 4 / maxDivision;
      const binaryRms = Math.sqrt(
        [0, 1, 2].reduce((s, k) => s + nearestGridError(groups[i + k].start, binaryStep) ** 2, 0) / 3,
      );
      if (binaryRms <= 1e-9 || rms > binaryRms * 0.65) continue;
      if (!best || rms < best.error) best = { division, anchor, cell, error: rms };
    }
    if (!best) {
      i++;
      continue;
    }
    const mark = { id: nextId++, division: best.division, anchor: best.anchor, cell: best.cell };
    for (let k = 0; k < 3; k++) {
      groups[i + k].triplet = mark;
      groups[i + k].tripletIndex = k as 0 | 1 | 2;
    }
    count++;
    i += 3;
  }
  return count;
}

function classifyDuration(duration: number): { division: MidiQuantizeDivision; triplet: boolean } {
  if (duration >= 1) return { division: 4, triplet: false };
  let best: { division: MidiQuantizeDivision; triplet: boolean; error: number; rank: number } | null = null;
  for (const division of DIVISIONS) {
    const base = 4 / division;
    const variants = [
      { value: base, triplet: false, rank: 0 },
      { value: base * 1.5, triplet: false, rank: 1 },
      { value: base * 2 / 3, triplet: true, rank: 2 },
    ];
    for (const variant of variants) {
      const error = Math.abs(duration - variant.value) / variant.value;
      if (!best || error < best.error - 1e-9 || (Math.abs(error - best.error) < 1e-9 && variant.rank < best.rank)) {
        best = { division, triplet: variant.triplet, error, rank: variant.rank };
      }
    }
  }
  return { division: best?.division ?? 64, triplet: best?.triplet ?? false };
}

function pitchClassCost(parsed: ParsedMidi, fifths: number): number {
  const tonic = ((7 * fifths) % 12 + 12) % 12;
  const scale = new Set([0, 2, 4, 5, 7, 9, 11].map((x) => (x + tonic) % 12));
  let cost = Math.abs(fifths) * 0.001;
  for (const note of parsed.notes) {
    if (!scale.has(note.pitch % 12)) cost += (note.endTick - note.startTick) / parsed.ppq;
  }
  return cost;
}

function inferFifths(parsed: ParsedMidi): number {
  const first = parsed.keySignatures[0];
  if (first) return clamp(first.fifths, -7, 7);
  let best = 0;
  let bestCost = Infinity;
  for (let fifths = -7; fifths <= 7; fifths++) {
    const cost = pitchClassCost(parsed, fifths);
    if (cost < bestCost) { bestCost = cost; best = fifths; }
  }
  return best;
}

function namedHands(parsed: ParsedMidi): { right: Set<number>; left: Set<number> } {
  const right = new Set<number>();
  const left = new Set<number>();
  for (const track of parsed.tracks) {
    if (/(?:\brh\b|right|treble|右手)/i.test(track.name)) right.add(track.index);
    if (/(?:\blh\b|left|bass|左手)/i.test(track.name)) left.add(track.index);
  }
  return { right, left };
}

function trackMedians(parsed: ParsedMidi): Array<{ track: number; count: number; pitch: number }> {
  return parsed.tracks
    .map((track) => {
      const pitches = parsed.notes.filter((n) => n.track === track.index).map((n) => n.pitch);
      return { track: track.index, count: pitches.length, pitch: median(pitches) };
    })
    .filter((x) => x.count > 0)
    .sort((a, b) => a.pitch - b.pitch);
}

function inferHands(parsed: ParsedMidi): { mode: "single" | "double"; split: number } {
  const names = namedHands(parsed);
  const medians = trackMedians(parsed);
  if (names.right.size > 0 && names.left.size > 0) {
    const lp = median(parsed.notes.filter((n) => names.left.has(n.track)).map((n) => n.pitch));
    const rp = median(parsed.notes.filter((n) => names.right.has(n.track)).map((n) => n.pitch));
    return { mode: "double", split: Math.round(clamp((lp + rp) / 2, 48, 72)) };
  }
  if ((names.right.size > 0 || names.left.size > 0) && medians.length === 1) {
    return { mode: "single", split: 60 };
  }
  const total = parsed.notes.length;
  if (medians.length >= 2) {
    const lo = medians[0];
    const hi = medians[medians.length - 1];
    if (lo.count / total >= 0.05 && hi.count / total >= 0.05 && hi.pitch - lo.pitch >= 7) {
      return { mode: "double", split: Math.round(clamp((lo.pitch + hi.pitch) / 2, 48, 72)) };
    }
  }

  const pitches = parsed.notes.map((n) => n.pitch);
  let c0 = Math.min(...pitches), c1 = Math.max(...pitches);
  let a: number[] = [], b: number[] = [];
  for (let iter = 0; iter < 12; iter++) {
    a = []; b = [];
    for (const p of pitches) (Math.abs(p - c0) <= Math.abs(p - c1) ? a : b).push(p);
    if (a.length) c0 = a.reduce((s, x) => s + x, 0) / a.length;
    if (b.length) c1 = b.reduce((s, x) => s + x, 0) / b.length;
  }
  if (c0 > c1) [c0, c1, a, b] = [c1, c0, b, a];
  const split = Math.round(clamp((c0 + c1) / 2, 48, 72));
  const groups = onsetGroups(workNotes(parsed));
  const bothSides = groups.filter((g) => g.notes.some((n) => n.pitch < split) && g.notes.some((n) => n.pitch >= split)).length;
  const double = c1 - c0 >= 12 && a.length / total >= 0.15 && b.length / total >= 0.15 && bothSides / groups.length >= 0.05;
  return { mode: double ? "double" : "single", split: double ? split : 60 };
}

export function analyzeMidi(parsed: ParsedMidi): MidiAnalysis {
  const notes = workNotes(parsed);
  const groups = onsetGroups(notes);
  markTriplets(groups, 64);
  const tripletSources = new Set<ParsedMidiNote>();
  for (const group of groups) if (group.triplet) for (const note of group.notes) tripletSources.add(note.source);
  const counts: MidiDurationCounts = { 4: 0, 8: 0, 16: 0, 32: 0, 64: 0 };
  let tripletNoteCount = 0;
  for (const note of notes) {
    const classified = classifyDuration(note.end - note.start);
    counts[classified.division]++;
    if (tripletSources.has(note.source) || classified.triplet) tripletNoteCount++;
  }
  let recommended: MidiQuantizeDivision = 4;
  for (const division of DIVISIONS) {
    if (counts[division] / notes.length > RECOMMENDATION_MIN_SHARE) {
      recommended = division;
    }
  }
  let suspectedGraceDivision: MidiQuantizeDivision | null = null;
  let suspectedGraceCount = 0;
  const finestPresent = [...DIVISIONS].reverse().find((division) => counts[division] > 0);
  const finestCount = finestPresent ? counts[finestPresent] : 0;
  if (finestPresent !== undefined && finestPresent > 4 &&
    finestCount <= 3 && finestCount / notes.length <= RECOMMENDATION_MIN_SHARE) {
    suspectedGraceDivision = finestPresent;
    suspectedGraceCount = finestCount;
  }
  const hand = inferHands(parsed);
  const gestures = detectMidiSlashGestures(parsed, recommended);
  const time = parsed.timeSignatures[0];
  const tempo = parsed.tempos[0];
  return {
    noteCount: notes.length,
    durationQuarterNotes: parsed.endTick / parsed.ppq,
    durationCounts: counts,
    tripletNoteCount,
    graceGroupCount: gestures.grace.length,
    arpeggioGroupCount: gestures.arpeggio.length,
    recommendedQuantize: recommended,
    suspectedGraceDivision,
    suspectedGraceCount,
    autoHandMode: hand.mode,
    splitPitch: hand.split,
    tempoBpm: Math.round(tempo?.bpm ?? 90),
    beats: time?.beats ?? 4,
    beatType: [2, 4, 8, 16].includes(time?.beatType ?? 4) ? (time?.beatType ?? 4) : 4,
    fifths: inferFifths(parsed),
    tempoChangeCount: Math.max(0, parsed.tempos.length - 1),
    keyChangeCount: Math.max(0, parsed.keySignatures.length - 1),
  };
}

function splitHands(parsed: ParsedMidi, notes: WorkNote[], mode: "single" | "double", splitPitch: number): WorkNote[][] {
  if (mode === "single") return [notes];
  const names = namedHands(parsed);
  const medians = trackMedians(parsed);
  const trackSide = new Map<number, 0 | 1>(); // 0=right, 1=left
  if (names.right.size > 0 || names.left.size > 0) {
    for (const track of names.right) trackSide.set(track, 0);
    for (const track of names.left) trackSide.set(track, 1);
  } else if (medians.length >= 2 && medians[medians.length - 1].pitch - medians[0].pitch >= 7) {
    for (const item of medians) trackSide.set(item.track, item.pitch >= splitPitch ? 0 : 1);
  }
  const right: WorkNote[] = [];
  const left: WorkNote[] = [];
  let lastRight = splitPitch + 5;
  let lastLeft = splitPitch - 5;
  for (const note of [...notes].sort((a, b) => a.start - b.start || b.pitch - a.pitch)) {
    const fixed = trackSide.get(note.source.track);
    let side = fixed;
    if (side === undefined) {
      if (Math.abs(note.pitch - splitPitch) <= 3) {
        side = Math.abs(note.pitch - lastRight) <= Math.abs(note.pitch - lastLeft) ? 0 : 1;
      } else {
        side = note.pitch >= splitPitch ? 0 : 1;
      }
    }
    if (side === 0) { right.push(note); lastRight = note.pitch; }
    else { left.push(note); lastLeft = note.pitch; }
  }
  return [right, left];
}

function quantizeHand(notes: WorkNote[], division: MidiQuantizeDivision, detectTriplets: boolean): HandEvents {
  const groups = onsetGroups(notes);
  const tripletGroups = detectTriplets ? markTriplets(groups, division) : 0;
  const step = 4 / division;
  const snap = (value: number, grid: number, origin = 0): number =>
    origin + Math.round((value - origin) / grid) * grid;
  const quantized: QuantizedNote[] = [];
  for (const group of groups) {
    for (const note of group.notes) {
      let start: number, end: number, triplet: TripletMark | null = null;
      if (group.triplet && group.tripletIndex !== undefined) {
        start = group.triplet.anchor + group.tripletIndex * group.triplet.cell;
        // Current JPW tuplets are a three-token 3:2 group. Keep each member to
        // one triplet cell so serialization never needs a mixed '_' + '-' duration.
        end = start + group.triplet.cell;
        triplet = { ...group.triplet, index: group.tripletIndex };
      } else {
        // Quantize the attack and the release independently.  In particular,
        // the right-hand end of a MIDI note must land on a rhythm grid line;
        // it is not inferred later from the next attack.
        start = snap(note.start, step);
        end = snap(note.end, step);
        if (end <= start) end = start + step;
      }
      quantized.push({ start: Math.max(0, start), end, pitch: note.pitch, triplet });
    }
  }

  quantized.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  const chords: QuantizedChord[] = [];
  let simplifiedOverlaps = 0;
  for (const note of quantized) {
    const last = chords[chords.length - 1];
    if (last && Math.abs(last.start - note.start) < 1e-8) {
      if (!last.pitches.includes(note.pitch)) last.pitches.push(note.pitch);
      last.sourceEnds.push(note.end);
      // Taking the median of individually quantized chord-tone releases can
      // itself produce a half-grid value (for example 1 and 1.25 -> 1.125).
      // Re-snap the common tail so the finished vertical chord remains on the
      // selected binary/triplet grid.
      const commonGrid = last.triplet?.cell ?? step;
      const commonOrigin = last.triplet?.anchor ?? 0;
      const common = snap(median(last.sourceEnds), commonGrid, commonOrigin);
      if (Math.abs(note.end - last.end) > 1e-8) simplifiedOverlaps++;
      last.end = Math.max(last.start + commonGrid, common);
      if (!last.triplet && note.triplet) last.triplet = note.triplet;
    } else {
      chords.push({ start: note.start, end: note.end, sourceEnds: [note.end], pitches: [note.pitch], triplet: note.triplet });
    }
  }
  for (let i = 0; i + 1 < chords.length; i++) {
    if (chords[i].end > chords[i + 1].start + 1e-8) {
      chords[i].end = chords[i + 1].start;
      simplifiedOverlaps++;
    }
    if (chords[i].end <= chords[i].start) chords[i].end = chords[i].start + step;
  }
  for (const chord of chords) chord.pitches.sort((a, b) => b - a);
  return { events: chords, tripletGroups, simplifiedOverlaps };
}

function buildMeasureBounds(parsed: ParsedMidi, options: MidiImportOptions, end: number, warnings: string[]): MeasureBound[] {
  const changes = parsed.timeSignatures
    .filter((x) => x.tick > 0 && [2, 4, 8, 16].includes(x.beatType))
    .map((x) => ({ at: x.tick / parsed.ppq, beats: x.beats, beatType: x.beatType }));
  const out: MeasureBound[] = [];
  let start = 0;
  let beats = options.beats;
  let beatType = options.beatType;
  let ci = 0;
  while (start < end - 1e-8 || out.length === 0) {
    let changed = out.length === 0;
    while (ci < changes.length && changes[ci].at <= start + 1e-6) {
      beats = changes[ci].beats;
      beatType = changes[ci].beatType;
      changed = true;
      ci++;
    }
    const length = beats * 4 / beatType;
    const finish = start + length;
    if (ci < changes.length && changes[ci].at < finish - 1e-6) {
      warnings.push(`拍号变化位于小节中间，已移动到下一小节：${changes[ci].beats}/${changes[ci].beatType}`);
      changes[ci].at = finish;
    }
    out.push({ start, end: finish, beats, beatType, timeChange: changed });
    start = finish;
  }
  return out;
}

function spelling(pitch: number, fifths: number): { step: string; alter: number; octave: number } {
  let best: { step: number; alter: number; octave: number; cost: number } | null = null;
  for (let si = 0; si < 7; si++) {
    const defaultAlter = MusicCommon.getAlter(STEP_NAME[si], fifths);
    for (let alter = -1; alter <= 1; alter++) {
      const pc = ((STEP_PC[si] + alter) % 12 + 12) % 12;
      if (pc !== pitch % 12) continue;
      const octave = Math.floor((pitch - STEP_PC[si] - alter) / 12) - 1;
      const cost = (alter === defaultAlter ? 0 : 4) + Math.abs(alter) + (fifths >= 0 && alter < 0 ? 0.2 : 0) + (fifths < 0 && alter > 0 ? 0.2 : 0);
      if (!best || cost < best.cost) best = { step: si, alter, octave, cost };
    }
  }
  const found = best ?? { step: 0, alter: 0, octave: Math.floor(pitch / 12) - 1, cost: 0 };
  return { step: STEP_NAME[found.step], alter: found.alter, octave: found.octave };
}

function durationShape(duration: number, triplet: TripletMark | null): { beats: number; beams: number; dot: number; fraction: Fraction } {
  if (triplet) {
    let beams = Math.log2(triplet.division / 4);
    let cells = Math.max(1, Math.round(duration / triplet.cell));
    while (beams > 0 && cells % 2 === 0) { cells /= 2; beams--; }
    return { beats: cells, beams, dot: 0, fraction: new Fraction(cells * 2, 3 * (1 << beams)) };
  }
  let beams = 4;
  let cells = Math.max(1, Math.round(duration * (1 << beams)));
  while (beams > 0 && cells % 2 === 0) { cells /= 2; beams--; }
  if (cells === 3 && beams > 0) {
    return { beats: 1, beams: beams - 1, dot: 1, fraction: new Fraction(3, 2 * (1 << (beams - 1))) };
  }
  return { beats: cells, beams, dot: 0, fraction: new Fraction(cells, 1 << beams) };
}

/** Split binary-grid durations into tokens accepted by the JPW grammar (no mixed '_' and '-'). */
function splitNormalDuration(duration: number): number[] {
  const pieces: number[] = [];
  let left = Math.round(duration * 16) / 16;
  if (left >= 1) {
    const wholeQuarters = Math.floor(left + 1e-8);
    pieces.push(wholeQuarters);
    left -= wholeQuarters;
  }
  const candidates = [0.75, 0.5, 0.375, 0.25, 0.1875, 0.125, 0.09375, 0.0625];
  for (const candidate of candidates) {
    while (left >= candidate - 1e-8) {
      pieces.push(candidate);
      left -= candidate;
    }
  }
  if (pieces.length === 0) pieces.push(1 / 16);
  return pieces;
}

function addChord(measure: Measure, start: number, duration: number, pitches: number[], fifths: number, triplet: TripletMark | null): Chord {
  const chord = new Chord(measure);
  const shape = durationShape(duration, triplet);
  chord.position = new Fraction(Math.round(start * 48), 48);
  chord.duration = shape.fraction;
  chord.beats = shape.beats;
  chord.beams = shape.beams;
  chord.dot = shape.dot;
  chord.voice = 1;
  chord.rest = pitches.length === 0;
  if (pitches.length === 0) {
    const note = new Note(chord);
    note.rest = true;
    note.number = "0";
    chord.add(note);
  } else {
    for (const pitch of pitches) {
      const note = new Note(chord);
      const sp = spelling(pitch, fifths);
      note.pitch = pitch;
      note.step = sp.step;
      note.alter = sp.alter;
      note.octave = sp.octave;
      chord.add(note);
    }
  }
  measure.add(chord);
  return chord;
}

function linkTiedChords(left: Chord, right: Chord): void {
  for (const next of right.notes) {
    if (next.rest) continue;
    const previous = left.notes.find((note) => !note.rest && note.pitch === next.pitch);
    if (!previous) continue;
    previous.tieStart = true;
    previous.tieNext = next;
    next.tieEnd = true;
    next.tiePrev = previous;
  }
}

function addSegment(measure: Measure, start: number, duration: number, pitches: number[], fifths: number, triplet: TripletMark | null): Chord[] {
  if (triplet) return [addChord(measure, start, duration, pitches, fifths, triplet)];
  const pieces = splitNormalDuration(duration);
  const chords: Chord[] = [];
  let position = start;
  for (const piece of pieces) {
    chords.push(addChord(measure, position, piece, pitches, fifths, null));
    position += piece;
  }
  if (pitches.length > 0 && chords.length > 1) {
    for (let index = 1; index < chords.length; index++) {
      linkTiedChords(chords[index - 1], chords[index]);
    }
  }
  return chords;
}

interface PositionedChord {
  chord: Chord;
  partIndex: number;
  start: number;
  pitches: number[];
}

function positionedChords(score: Score): PositionedChord[] {
  const result: PositionedChord[] = [];
  score.parts.forEach((part, partIndex) => {
    for (const measure of part.measures) {
      const measureStart = measure.position.toFloat();
      for (const entry of measure.entries) {
        if (!(entry instanceof Chord) || entry.rest) continue;
        result.push({
          chord: entry,
          partIndex,
          start: measureStart + entry.position.toFloat(),
          pitches: entry.notes.filter((note) => !note.rest).map((note) => note.pitch),
        });
      }
    }
  });
  return result;
}

function gestureTarget(
  score: Score,
  chords: readonly PositionedChord[],
  gesture: MidiSlashGesture,
  expectedPitches: readonly number[],
): Chord | null {
  const track = gesture.events.find((event) => event.track !== undefined)?.track;
  const candidates = chords.filter((item) => {
    if (Math.abs(item.start - gesture.anchor) > 1 / 96) return false;
    const sourceTrack = score.parts[item.partIndex]?.sourceTrack;
    if (track !== undefined && sourceTrack !== null && sourceTrack !== track) return false;
    return expectedPitches.some((pitch) => item.pitches.includes(pitch));
  });
  candidates.sort((left, right) => {
    const leftMatches = expectedPitches.filter((pitch) => left.pitches.includes(pitch)).length;
    const rightMatches = expectedPitches.filter((pitch) => right.pitches.includes(pitch)).length;
    return rightMatches - leftMatches ||
      Math.abs(left.start - gesture.anchor) - Math.abs(right.start - gesture.anchor) ||
      left.partIndex - right.partIndex;
  });
  return candidates[0]?.chord ?? null;
}

function decorativeNote(chord: Chord, pitch: number): Note {
  const note = new Note(chord);
  const fifths = chord.measure.key.fifths;
  const spelled = spelling(pitch, fifths);
  note.pitch = pitch;
  note.step = spelled.step;
  note.alter = spelled.alter;
  note.octave = spelled.octave;
  note.init(fifths, new AccidentalStat(fifths));
  return note;
}

function applyMidiOrnaments(score: Score, gestures: MidiSlashGestureAnalysis): void {
  const chords = positionedChords(score);
  for (const gesture of gestures.arpeggio) {
    const expected = [...new Set(gesture.events.flatMap((event) => event.pitches))];
    const chord = gestureTarget(score, chords, gesture, expected);
    if (chord && expected.length >= 3) chord.arpeggio = true;
  }
  for (const gesture of gestures.grace) {
    const main = gesture.events[gesture.events.length - 1];
    if (!main) continue;
    const chord = gestureTarget(score, chords, gesture, main.pitches);
    if (!chord) continue;
    chord.graceNotes = gesture.events
      .slice(0, -1)
      .flatMap((event) => event.pitches.map((pitch) => decorativeNote(chord, pitch)));
  }
}

function applyMidiTempoMarks(
  score: Score,
  parsed: ParsedMidi,
  bounds: readonly MeasureBound[],
): number {
  for (const item of detectMidiTempoMarks(parsed)) {
    let index = bounds.findIndex((bound) => item.position < bound.end - 1e-8);
    if (index < 0) index = Math.max(0, bounds.length - 1);
    const bound = bounds[index];
    if (!bound) continue;
    const mark = new TempoMark();
    mark.measure = index;
    mark.offset = new Fraction(Math.round(Math.max(0, item.position - bound.start) * 192), 192);
    mark.kind = item.kind;
    mark.bpm = item.bpm;
    score.tempoMarks.push(mark);
  }
  return score.tempoMarks.length;
}

function makePart(
  bounds: MeasureBound[],
  hand: "right" | "left" | null,
  events: QuantizedChord[],
  fifths: number,
  metadata?: { instrumentName: string; voiceIndex: number; sourceTrack: number },
): Part {
  const part = new Part();
  part.hand = hand;
  if (metadata) {
    part.instrumentName = metadata.instrumentName;
    part.voiceIndex = metadata.voiceIndex;
    part.sourceTrack = metadata.sourceTrack;
  }
  const tuplets = new Map<number, Chord[]>();
  // The same QuantizedChord object is visited once for every measure it
  // overlaps. Remember its last notated fragment so a release beyond a
  // barline becomes one adjacent tie chain instead of a new attack.
  const eventLastChord = new Map<QuantizedChord, Chord>();
  for (let mi = 0; mi < bounds.length; mi++) {
    const bound = bounds[mi];
    const measure = new Measure(mi);
    measure.position = new Fraction(Math.round(bound.start * 48), 48);
    measure.time = new Time(bound.beats, bound.beatType);
    measure.timeChange = mi > 0 && bound.timeChange;
    measure.key = new Key();
    measure.key.fifths = fifths;
    if (mi === bounds.length - 1) measure.barline = BarStyle.LIGHT_HEAVY;
    let cursor = bound.start;
    const overlapping = events.filter((e) => e.end > bound.start + 1e-8 && e.start < bound.end - 1e-8);
    for (const event of overlapping) {
      const start = Math.max(bound.start, event.start);
      const end = Math.min(bound.end, event.end);
      if (start > cursor + 1e-8) addSegment(measure, cursor - bound.start, start - cursor, [], fifths, null);
      const eventChords = addSegment(measure, start - bound.start, end - start, event.pitches, fifths, event.triplet);
      const previous = eventLastChord.get(event);
      if (previous && eventChords[0]) linkTiedChords(previous, eventChords[0]);
      if (eventChords.length > 0) eventLastChord.set(event, eventChords[eventChords.length - 1]);
      if (event.triplet) {
        const list = tuplets.get(event.triplet.id) ?? [];
        list.push(...eventChords);
        tuplets.set(event.triplet.id, list);
      }
      cursor = Math.max(cursor, end);
    }
    if (cursor < bound.end - 1e-8) addSegment(measure, cursor - bound.start, bound.end - cursor, [], fifths, null);
    measure.init({ keepChords: true, primaryVoice: true });
    part.measures.push(measure);
  }
  for (const chords of tuplets.values()) {
    if (chords.length !== 3) continue;
    const first = chords[0].notes[0], last = chords[2].notes[0];
    first.tupletBegin = true;
    last.tupletEnd = true;
    const tuplet = new Tuplet(first, last);
    first.tuplet = tuplet;
    last.tuplet = tuplet;
  }
  return part;
}

function normalizedTrackAssignments(parsed: ParsedMidi, options: MidiImportOptions): MidiTrackAssignment[] {
  const soundingTracks = parsed.tracks.filter((track) => track.noteCount > 0);
  // Explicit ensemble assignments may deliberately include an empty row.
  // Slash-score vc:N uses this to keep enabled voices visible as full rests.
  const available = new Set(
    (options.trackAssignments?.length ? parsed.tracks : soundingTracks)
      .map((track) => track.index),
  );
  const requested = options.trackAssignments?.length
    ? options.trackAssignments
    : soundingTracks.map((track, index) => ({
      track: track.index,
      instrumentName: track.name.trim() || `乐器 ${index + 1}`,
      voice: 1,
    }));
  const used = new Set<number>();
  const clean: MidiTrackAssignment[] = [];
  for (const item of requested) {
    if (!available.has(item.track) || used.has(item.track)) continue;
    used.add(item.track);
    clean.push({
      track: item.track,
      instrumentName: item.instrumentName.trim() || `乐器 ${clean.length + 1}`,
      voice: Math.max(1, Math.round(item.voice) || 1),
    });
  }
  const groupOrder = new Map<string, number>();
  for (const item of clean) if (!groupOrder.has(item.instrumentName)) groupOrder.set(item.instrumentName, groupOrder.size);
  const medians = new Map(trackMedians(parsed).map((item) => [item.track, item.pitch]));
  clean.sort((a, b) =>
    groupOrder.get(a.instrumentName)! - groupOrder.get(b.instrumentName)! ||
    a.voice - b.voice ||
    (medians.get(b.track) ?? 0) - (medians.get(a.track) ?? 0) ||
    a.track - b.track,
  );
  const nextVoice = new Map<string, number>();
  for (const item of clean) {
    const voice = (nextVoice.get(item.instrumentName) ?? 0) + 1;
    nextVoice.set(item.instrumentName, voice);
    item.voice = voice;
  }
  return clean;
}

export function midiToScore(parsed: ParsedMidi, options: MidiImportOptions): MidiImportResult {
  const analysis = analyzeMidi(parsed);
  const detectedGestures = detectMidiSlashGestures(parsed, options.quantize);
  const gestures: MidiSlashGestureAnalysis = {
    ...detectedGestures,
    triplet: options.detectTriplets ? detectedGestures.triplet : [],
  };
  const ensembleMode = options.scoreMode === "ensemble";
  const resolvedMode = options.handMode === "auto" ? analysis.autoHandMode : options.handMode;
  const sourceNotes = snapDetectedArpeggios(
    workNotes(parsed).filter((note) => !isDetectedGraceNote(note, gestures)),
    gestures,
  );
  const assignments = ensembleMode ? normalizedTrackAssignments(parsed, options) : [];
  if (ensembleMode && assignments.length === 0) throw new Error("总谱导入至少需要选择一条含音符的 MIDI 轨道");
  const streams = ensembleMode
    ? assignments.map((assignment) => sourceNotes.filter((note) => note.source.track === assignment.track))
    : splitHands(parsed, sourceNotes, resolvedMode, options.splitPitch);
  const quantized = streams.map((notes) => quantizeHand(notes, options.quantize, options.detectTriplets));
  const end = Math.max(
    options.beats * 4 / options.beatType,
    ...quantized.flatMap((part) => part.events.map((event) => event.end)),
  );
  const warnings: string[] = [];
  if (analysis.keyChangeCount > 0) warnings.push(`忽略了 ${analysis.keyChangeCount} 次中途调号变化`);
  if (ensembleMode) {
    const assigned = new Set(assignments.map((item) => item.track));
    const omitted = parsed.tracks.filter((track) => track.noteCount > 0 && !assigned.has(track.index));
    if (omitted.length > 0) warnings.push(`未导入 ${omitted.length} 条未分配的含音符轨道`);
  }
  const bounds = buildMeasureBounds(parsed, options, end, warnings);
  const score = new Score();
  score.title = options.title?.trim() || parsed.title || "MIDI 导入";
  score.subtitle = options.subtitle?.trim() ?? "";
  score.composer = options.composer?.trim() ?? "";
  score.arranger = options.arranger?.trim() ?? "";
  score.lyricist = options.lyricist?.trim() ?? "";
  score.instrumentName = options.instrumentName?.trim() ?? "";
  score.tempoBpm = Math.max(
    0.1,
    Math.round((options.tempoBpm ?? analysis.tempoBpm) * 10) / 10,
  );
  score.tempoBeatUnit = options.tempoBeatUnit ?? "quarter";
  if (ensembleMode) {
    score.ensemble = true;
    score.instrumentName = "";
    for (let i = 0; i < assignments.length; i++) {
      const assignment = assignments[i];
      score.parts.push(makePart(bounds, null, quantized[i].events, options.fifths, {
        instrumentName: assignment.instrumentName,
        voiceIndex: assignment.voice,
        sourceTrack: assignment.track,
      }));
    }
  } else if (resolvedMode === "double") {
    score.piano = true;
    if (!score.instrumentName) score.instrumentName = "钢琴";
    score.parts.push(makePart(bounds, "right", quantized[0].events, options.fifths));
    score.parts.push(makePart(bounds, "left", quantized[1].events, options.fifths));
  } else {
    score.parts.push(makePart(bounds, null, quantized[0].events, options.fifths));
  }
  normalizeOpeningPickup(score);
  applyMidiOrnaments(score, gestures);
  const tempoMarkCount = applyMidiTempoMarks(score, parsed, bounds);
  if (analysis.tempoChangeCount > 0) {
    warnings.push(tempoMarkCount > 0
      ? `已保留 ${tempoMarkCount} 个渐快、渐慢或稳定速度标记`
      : `检测到 ${analysis.tempoChangeCount} 次速度变化，但没有形成可读的速度标记`);
  }
  score.parseRepeatInf();
  const layoutMode = ensembleMode ? "ensemble" : resolvedMode === "double" ? "piano" : "single";
  const instrumentCount = ensembleMode
    ? new Set(score.parts.map((part) => part.instrumentName)).size
    : 1;
  return {
    score,
    summary: {
      handCount: !ensembleMode && resolvedMode === "double" ? 2 : 1,
      layoutMode,
      partCount: score.parts.length,
      instrumentCount,
      quantize: options.quantize,
      tripletGroups: quantized.reduce((s, x) => s + x.tripletGroups, 0),
      graceGroups: gestures.grace.length,
      arpeggioGroups: gestures.arpeggio.length,
      suspectedGraceCount: analysis.suspectedGraceCount,
      simplifiedOverlaps: quantized.reduce((s, x) => s + x.simplifiedOverlaps, 0),
      ignoredEvents: parsed.ignoredEvents,
      warnings,
    },
  };
}
