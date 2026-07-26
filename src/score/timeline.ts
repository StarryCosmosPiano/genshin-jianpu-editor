// Shared "score model -> timed note events" flattening, honoring the expanded
// play order (repeats / voltas / D.C. / D.S. / Coda) computed by
// Score.parseRepeatInf() into playData.measures (PlayItem[]). Consumed by both
// the MIDI export (scoreToMidi) and the in-editor player (ScorePlayer), so the
// two stay in lockstep. Times are in quarter-note units.

import { Chord, Note, Score, TempoMarkKind } from "./score";

export const TEMPO = 90; // BPM, shared by MIDI export and playback

/** Mixing options shared by MIDI export and playback. */
export interface PlayOptions {
  /** Per-part linear volume in [0,1]; index = part index. Missing/undefined = 1. */
  partVolumes?: number[];
}

/** Per-part linear gain in [0,1], defaulting to 1 (full) when unset. */
export function partGain(opts: PlayOptions | undefined, part: number): number {
  const v = opts?.partVolumes?.[part];
  if (v === undefined || Number.isNaN(v)) return 1;
  return Math.max(0, Math.min(1, v));
}

export interface TimedNote {
  t0: number; // quarter-note units
  t1: number;
  pitch: number;
  part: number;
  chord: Chord;
}

export interface Anchor {
  t0: number;
  /** All sounding hand/part chords that begin at this instant. */
  chords: Chord[];
  /** Preferred cursor chord (part 0 when present), kept for selection lookup. */
  chord: Chord;
  pass: number; // repeat pass / lyric verse (matches NoteEntry.verse in layout)
}

export interface Timeline {
  notes: TimedNote[];
  anchors: Anchor[]; // melody (part 0) sounding chords, ascending by t0 — for cursor
  duration: number; // total length in quarter notes
  tempo: TempoTimeline;
}

/** One continuous tempo span. BPM changes linearly in quarter-note space. */
export interface TempoSegment {
  startQuarter: number;
  endQuarter: number;
  startBpm: number;
  endBpm: number;
  startSeconds: number;
  endSeconds: number;
}

/** Expanded performance tempo map, including repeats and score jumps. */
export interface TempoTimeline {
  segments: TempoSegment[];
  durationQuarter: number;
  durationSeconds: number;
  initialBpm: number;
  finalBpm: number;
}

/** Measure length in quarter notes, max across parts, with a time-signature fallback. */
function measureLen(score: Score, mid: number): number {
  let len = 0;
  for (const part of score.parts) {
    const m = part.measures[mid];
    if (!m) continue;
    try {
      len = Math.max(len, m.duration.toFloat());
    } catch {
      // no chord in this measure: fall back to the time signature
      len = Math.max(len, (m.time.beats * 4) / m.time.beatType);
    }
  }
  return len;
}

/** Expanded play order as [mid, end) measure ranges with a start offset + pass. */
function playRanges(score: Score): { mid: number; end: number; offset: number; pass: number }[] {
  const items = score.playData.measures;
  if (items.length > 0) {
    return items.map((p) => ({ mid: p.mid, end: p.end, offset: p.offset.toFloat(), pass: p.pass }));
  }
  // No expansion computed: linear single pass over all measures.
  const n = score.parts[0]?.measures.length ?? 0;
  return n > 0 ? [{ mid: 0, end: n, offset: 0, pass: 1 }] : [];
}

interface PerformedTempoMark {
  quarter: number;
  kind: TempoMarkKind;
  bpm: number | null;
  order: number;
}

function safeBpm(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : TEMPO;
}

/**
 * Duration of a span whose BPM is linearly interpolated over notated time.
 *
 * A tempo ramp is linear in score quarters (the same axis used by a MIDI/DAW
 * tempo lane), so real time is the integral of 60 / BPM rather than an average
 * of the endpoint seconds-per-quarter values.
 */
function tempoSpanSeconds(
  quarters: number,
  startBpm: number,
  endBpm: number,
): number {
  if (quarters <= 0) return 0;
  const from = safeBpm(startBpm);
  const to = safeBpm(endBpm);
  const delta = to - from;
  if (Math.abs(delta) < 1e-9) return quarters * 60 / from;
  return quarters * 60 * Math.log(to / from) / delta;
}

function performedTempoMarks(score: Score): PerformedTempoMark[] {
  const byMeasure = new Map<number, Array<{
    kind: TempoMarkKind;
    bpm: number | null;
    offset: number;
    sourceOrder: number;
  }>>();
  score.tempoMarks.forEach((mark, sourceOrder) => {
    if (mark.softDeleted) return;
    const offset = mark.offset.toFloat();
    if (!Number.isFinite(offset) || offset < 0) return;
    const list = byMeasure.get(mark.measure) ?? [];
    list.push({ kind: mark.kind, bpm: mark.bpm, offset, sourceOrder });
    byMeasure.set(mark.measure, list);
  });

  const result: PerformedTempoMark[] = [];
  let performanceQuarter = 0;
  let order = 0;
  for (const range of playRanges(score)) {
    for (let mid = range.mid; mid < range.end; mid++) {
      const startOffset = mid === range.mid ? range.offset : 0;
      const length = measureLen(score, mid);
      for (const mark of byMeasure.get(mid) ?? []) {
        if (mark.offset + 1e-9 < startOffset || mark.offset > length + 1e-9) continue;
        result.push({
          quarter: performanceQuarter + Math.max(0, Math.min(length, mark.offset) - startOffset),
          kind: mark.kind,
          bpm: mark.bpm,
          order: order++ * 100000 + mark.sourceOrder,
        });
      }
      performanceQuarter += Math.max(0, length - startOffset);
    }
  }
  return result.sort((left, right) =>
    left.quarter - right.quarter || left.order - right.order);
}

/**
 * Builds the playback tempo curve represented by accel./rit. followed by a
 * concrete metronome mark. Without a following concrete tempo, an instruction
 * remains visual only because it has no numeric endpoint.
 */
export function buildTempoTimeline(score: Score, durationQuarter: number): TempoTimeline {
  const duration = Math.max(0, durationQuarter);
  const initialBpm = safeBpm(score.tempoBpm);
  const drafts: Array<{
    startQuarter: number;
    endQuarter: number;
    startBpm: number;
    endBpm: number;
  }> = [];
  let cursor = 0;
  let currentBpm = initialBpm;
  let pendingRamp = false;

  const append = (endQuarter: number, endBpm = currentBpm): void => {
    const end = Math.max(cursor, Math.min(duration, endQuarter));
    if (end > cursor + 1e-10) {
      drafts.push({
        startQuarter: cursor,
        endQuarter: end,
        startBpm: currentBpm,
        endBpm: safeBpm(endBpm),
      });
    }
    cursor = end;
  };

  for (const mark of performedTempoMarks(score)) {
    const quarter = Math.max(0, Math.min(duration, mark.quarter));
    if (quarter + 1e-9 < cursor) continue;
    if (mark.kind === "accel" || mark.kind === "rit") {
      // A second instruction before a concrete target supersedes the first;
      // the unresolved region keeps its preceding fixed tempo.
      append(quarter);
      pendingRamp = true;
      continue;
    }

    const target = mark.bpm === null ? null : safeBpm(mark.bpm);
    if (target === null) continue;
    if (pendingRamp && quarter > cursor + 1e-10) {
      append(quarter, target);
    } else {
      append(quarter);
    }
    currentBpm = target;
    pendingRamp = false;
  }
  append(duration);

  const segments: TempoSegment[] = [];
  let seconds = 0;
  for (const draft of drafts) {
    const elapsed = tempoSpanSeconds(
      draft.endQuarter - draft.startQuarter,
      draft.startBpm,
      draft.endBpm,
    );
    segments.push({
      ...draft,
      startSeconds: seconds,
      endSeconds: seconds + elapsed,
    });
    seconds += elapsed;
  }
  return {
    segments,
    durationQuarter: duration,
    durationSeconds: seconds,
    initialBpm,
    finalBpm: currentBpm,
  };
}

/** Maps a score-quarter position onto the real playback clock. */
export function quarterToSeconds(tempo: TempoTimeline, quarter: number): number {
  const target = Math.max(0, quarter);
  for (const segment of tempo.segments) {
    if (target <= segment.endQuarter + 1e-10) {
      const elapsedQuarter = Math.max(
        0,
        Math.min(target, segment.endQuarter) - segment.startQuarter,
      );
      const spanQuarter = segment.endQuarter - segment.startQuarter;
      const ratio = spanQuarter > 0 ? elapsedQuarter / spanQuarter : 0;
      const bpm = segment.startBpm + (segment.endBpm - segment.startBpm) * ratio;
      return segment.startSeconds + tempoSpanSeconds(
        elapsedQuarter,
        segment.startBpm,
        bpm,
      );
    }
  }
  return tempo.durationSeconds +
    Math.max(0, target - tempo.durationQuarter) * 60 / safeBpm(tempo.finalBpm);
}

/** Instantaneous quarter-note BPM, useful for MIDI tempo-lane sampling. */
export function tempoBpmAtQuarter(tempo: TempoTimeline, quarter: number): number {
  const target = Math.max(0, quarter);
  for (const segment of tempo.segments) {
    if (target + 1e-10 < segment.endQuarter) {
      const span = segment.endQuarter - segment.startQuarter;
      const ratio = span > 0
        ? Math.max(0, Math.min(1, (target - segment.startQuarter) / span))
        : 0;
      return segment.startBpm + (segment.endBpm - segment.startBpm) * ratio;
    }
  }
  return tempo.finalBpm;
}

export function buildTimeline(score: Score): Timeline {
  const notes: TimedNote[] = [];
  const anchorMap = new Map<string, Anchor & { primaryPart: number }>();
  let pos = 0; // running timeline position in quarter notes

  for (const range of playRanges(score)) {
    // A repeated range is a fresh performance pass. Ties may merge notes
    // inside that pass, but must never inherit a sounding note from the end of
    // the previous pass.
    const tiedNotes = new Map<Note, TimedNote>();
    for (let mid = range.mid; mid < range.end; mid++) {
      const startOffset = mid === range.mid ? range.offset : 0;
      for (let pi = 0; pi < score.parts.length; pi++) {
        const m = score.parts[pi].measures[mid];
        if (!m) continue;
        for (const ent of m.entries) {
          if (!(ent instanceof Chord)) continue;
          const cp = ent.position.toFloat();
          if (cp < startOffset) continue; // clipped by a mid-measure jump entry
          const t0 = pos + (cp - startOffset);
          const t1 = t0 + (ent.duration?.toFloat() ?? 0);
          if (ent.rest) continue;
          let mainAttack = t0;
          const graceNotes = ent.graceNotes.filter((note) => !note.softDeleted);
          if (graceNotes.length > 0) {
            const graceUnit = Math.max(
              1 / 64,
              Math.min(1 / 8, (t1 - t0) * 0.22 / graceNotes.length),
            );
            const graceSpan = graceUnit * graceNotes.length;
            let graceStart = t0 - graceSpan;
            if (graceStart < pos) {
              graceStart = t0;
              mainAttack = Math.min(t1 - 1 / 128, t0 + graceSpan);
            }
            graceNotes.forEach((note, index) => {
              const noteStart = graceStart + index * graceUnit;
              notes.push({
                t0: noteStart,
                t1: noteStart + graceUnit,
                pitch: note.pitch,
                part: pi,
                chord: ent,
              });
            });
          }
          const arpeggioDelay = new Map<Note, number>();
          const soundingNotes = ent.notes.filter((note) =>
            !note.rest && !note.softDeleted);
          if (soundingNotes.length === 0) continue;
          const anchorKey = `${t0.toFixed(9)}|${range.pass}`;
          const existing = anchorMap.get(anchorKey);
          if (existing) {
            if (!existing.chords.includes(ent)) existing.chords.push(ent);
            if (pi < existing.primaryPart) {
              existing.chord = ent;
              existing.primaryPart = pi;
            }
          } else {
            anchorMap.set(anchorKey, {
              t0,
              chords: [ent],
              chord: ent,
              pass: range.pass,
              primaryPart: pi,
            });
          }
          const pitchRange = ent.arpeggioPitches?.length
            ? new Set(ent.arpeggioPitches)
            : null;
          const rolledNotes = pitchRange
            ? soundingNotes.filter((note) => pitchRange.has(note.pitch))
            : soundingNotes;
          if (ent.arpeggio && rolledNotes.length > 1) {
            const ordered = [...rolledNotes].sort((left, right) =>
              left.pitch - right.pitch);
            const rollSpan = Math.max(0, Math.min(1 / 8, (t1 - mainAttack) * 0.2));
            // For a partial arpeggio, strike the notes outside the wave on the
            // beat first, then begin the rolled subset on the next roll step.
            const leadingStep = rolledNotes.length < soundingNotes.length ? 1 : 0;
            const rollUnit = rollSpan / (ordered.length - 1 + leadingStep);
            ordered.forEach((note, index) => {
              arpeggioDelay.set(note, (index + leadingStep) * rollUnit);
            });
          }
          for (const nt of soundingNotes) {
            const tied = nt.tieEnd && nt.tiePrev ? tiedNotes.get(nt.tiePrev) : undefined;
            if (tied) {
              tied.t1 = Math.max(tied.t1, t1);
              tiedNotes.set(nt, tied);
              continue;
            }
            const attack = mainAttack + (arpeggioDelay.get(nt) ?? 0);
            const timed = {
              t0: attack,
              t1: Math.max(attack + 1 / 128, t1),
              pitch: nt.pitch,
              part: pi,
              chord: ent,
            };
            notes.push(timed);
            tiedNotes.set(nt, timed);
          }
        }
      }
      pos += measureLen(score, mid) - startOffset;
    }
  }

  const anchors: Anchor[] = [...anchorMap.values()]
    .sort((a, b) => a.t0 - b.t0)
    .map((a) => ({ t0: a.t0, chords: a.chords, chord: a.chord, pass: a.pass }));
  return {
    notes,
    anchors,
    duration: pos,
    tempo: buildTempoTimeline(score, pos),
  };
}
