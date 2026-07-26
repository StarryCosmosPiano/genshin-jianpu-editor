// Ported from mp/score/midi.kt (ToMidi). Builds a Standard MIDI File (format 1)
// in pure TS: a tempo meta track + one track per part, note on/off per chord.
// Note timing comes from buildTimeline (shared with the in-editor player), so the
// exported MIDI honors the expanded play order (repeats / voltas / D.C. / D.S.).

import { Score } from "./score";
import {
  buildTimeline,
  partGain,
  PlayOptions,
  TempoTimeline,
  TimedNote,
} from "./timeline";

const PPQ = 960;

interface Ev {
  tick: number;
  data: number[];
  order: number; // tie-break: note-off (0) before note-on (1) at same tick
}

function varLen(n: number): number[] {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
}

function trackChunk(events: Ev[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let prev = 0;
  for (const e of events) {
    body.push(...varLen(e.tick - prev));
    body.push(...e.data);
    prev = e.tick;
  }
  body.push(...varLen(0), 0xff, 0x2f, 0x00); // end of track
  const len = body.length;
  return [0x4d, 0x54, 0x72, 0x6b, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...body];
}

function tempoData(bpm: number): number[] {
  const safe = Number.isFinite(bpm) && bpm > 0 ? bpm : 90;
  const mpqn = Math.max(1, Math.min(0xffffff, Math.round(60000000 / safe)));
  return [0xff, 0x51, 0x03, (mpqn >> 16) & 0xff, (mpqn >> 8) & 0xff, mpqn & 0xff];
}

function tempoTrack(tempo: TempoTimeline): number[] {
  // SMF has point tempo events rather than a ramp primitive. Sample each
  // linear segment at a 1/64-note grid; this is fine enough for native
  // playback while keeping even long scores compact.
  const bpmByTick = new Map<number, number>();
  const add = (quarter: number, bpm: number): void => {
    bpmByTick.set(Math.max(0, Math.round(quarter * PPQ)), bpm);
  };
  add(0, tempo.initialBpm);
  for (const segment of tempo.segments) {
    add(segment.startQuarter, segment.startBpm);
    if (Math.abs(segment.endBpm - segment.startBpm) < 1e-9) continue;
    const length = segment.endQuarter - segment.startQuarter;
    const idealSteps = Math.max(1, Math.ceil(length * 16));
    const steps = Math.min(16384, idealSteps);
    for (let index = 1; index <= steps; index++) {
      const ratio = index / steps;
      add(
        segment.startQuarter + length * ratio,
        segment.startBpm + (segment.endBpm - segment.startBpm) * ratio,
      );
    }
  }
  const events = [...bpmByTick]
    .sort(([left], [right]) => left - right)
    .map(([tick, bpm]): Ev => ({
      tick,
      order: 0,
      data: tempoData(bpm),
    }));
  return trackChunk(events);
}

function partTrack(notes: TimedNote[], partIdx: number, trackName: string, opts?: PlayOptions): number[] {
  const channel = partIdx & 0x0f;
  const events: Ev[] = [];
  const nameBytes = [...new TextEncoder().encode(trackName)];
  if (nameBytes.length > 0) {
    events.push({ tick: 0, order: -1, data: [0xff, 0x03, ...varLen(nameBytes.length), ...nameBytes] });
  }
  // Channel Volume (CC7) at tick 0 sets this part's level in the GM synth.
  const vol = Math.round(partGain(opts, partIdx) * 127);
  events.push({ tick: 0, order: 0, data: [0xb0 | channel, 0x07, vol & 0x7f] });
  for (const n of notes) {
    if (n.part !== partIdx) continue;
    const start = Math.round(n.t0 * PPQ);
    const end = Math.round(n.t1 * PPQ);
    events.push({ tick: start, order: 1, data: [0x90 | channel, n.pitch & 0x7f, 100] });
    events.push({ tick: end, order: 0, data: [0x80 | channel, n.pitch & 0x7f, 0] });
  }
  return trackChunk(events);
}

export function scoreToMidi(score: Score, opts?: PlayOptions): Uint8Array {
  const { notes, tempo } = buildTimeline(score);
  const ntracks = 1 + score.parts.length;
  const header = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, // MThd, len 6
    0, 1, // format 1
    (ntracks >> 8) & 0xff, ntracks & 0xff,
    (PPQ >> 8) & 0xff, PPQ & 0xff, // division (ticks per quarter)
  ];
  const out: number[] = [...header, ...tempoTrack(tempo)];
  for (let i = 0; i < score.parts.length; i++) {
    const part = score.parts[i];
    const trackName = part.instrumentName
      ? `${part.instrumentName}${score.parts.filter((item) => item.instrumentName === part.instrumentName).length > 1 ? ` 声部 ${part.voiceIndex}` : ""}`
      : part.hand === "right" ? "Right Hand" : part.hand === "left" ? "Left Hand" : `声部 ${i + 1}`;
    out.push(...partTrack(notes, i, trackName, opts));
  }
  return new Uint8Array(out);
}
