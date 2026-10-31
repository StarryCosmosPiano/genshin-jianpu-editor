import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analyzeMidi, midiToScore, parseMidi, type ParsedMidi } from "./src/midi";
import { parseEditableDocument } from "./src/editor/document-parser";
import { buildTimeline } from "./src/score/timeline";
import {
  analyzeSlashScore,
  defaultSlashScoreOptions,
  embedSlashScoreOptionsFromScore,
  parseSlashScore,
  scoreToSlashScore,
  type SlashScoreKind,
} from "./src/slashscore";
import type { Score } from "./src/score/score";

type Sound = { part: number; pitch: number; start: number; end: number };
const modes = { braceMode: "arpeggio", bracketMode: "triplet", barMode: "none",
  angleMode: "grace", parenMode: "chord", ordering: "pitch-asc" } as const;
const failures: string[] = [];
let checks = 0;
function check(name: string, action: () => void): void {
  try { action(); checks++; }
  catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
function fixture(notes: Sound[]): ParsedMidi {
  const ppq = 960;
  return { format: 1, ppq, trackCount: 3, title: "Leading silence regression",
    tracks: [{ index: 0, name: "Conductor", noteCount: 0 },
      { index: 1, name: "Right Hand", noteCount: notes.filter(n => n.part === 0).length },
      { index: 2, name: "Left Hand", noteCount: notes.filter(n => n.part === 1).length }],
    notes: notes.map(n => ({ startTick: Math.round(n.start * ppq), endTick: Math.round(n.end * ppq),
      pitch: n.pitch, track: n.part + 1, channel: n.part, velocity: 90 })),
    tempos: [{ tick: 0, bpm: 114 }], timeSignatures: [{ tick: 0, beats: 4, beatType: 4 }],
    keySignatures: [{ tick: 0, fifths: 0, minor: false }], ignoredEvents: 0,
    endTick: Math.ceil(Math.max(...notes.map(n => n.end)) / 4) * 4 * ppq };
}
function sounds(score: Score): Sound[] {
  return buildTimeline(score).notes.map(n => ({ part: n.part, pitch: n.pitch, start: n.t0, end: n.t1 }));
}
function sameSounds(actual: Sound[], expected: Sound[], context: string): void {
  const sorted = (notes: Sound[]) => [...notes].sort((a, b) => a.start - b.start || a.part - b.part || a.pitch - b.pitch);
  const left = sorted(actual), right = sorted(expected);
  assert.equal(left.length, right.length, `${context}: note attack count`);
  right.forEach((wanted, index) => {
    const got = left[index]!;
    assert.equal(got.part, wanted.part, `${context}: voice at ${wanted.start}`);
    assert.equal(got.pitch, wanted.pitch, `${context}: pitch at ${wanted.start}`);
    assert(Math.abs(got.start - wanted.start) < 1e-8,
      `${context}: onset ${got.start} != ${wanted.start}`);
    assert(Math.abs(got.end - wanted.end) < 1e-8,
      `${context}: release ${got.end} != ${wanted.end}`);
  });
}
function importAndReopen(midi: ParsedMidi, kind: SlashScoreKind, rests: boolean, division: 8 | 16 | 32 | 64) {
  const score = midiToScore(midi, { outputFormat: kind, quantize: division, detectTriplets: true,
    handMode: "auto", splitPitch: analyzeMidi(midi).splitPitch, scoreMode: "hands",
    fifths: 0, beats: 4, beatType: 4, tempoBpm: 114 }).score;
  const raw = scoreToSlashScore(score, kind, division, ".", { ...modes, sourceMidi: midi, showExplicitRests: rests }, 2);
  const options = { ...defaultSlashScoreOptions(kind, analyzeSlashScore(raw)), ...modes,
    voiceCount: 2, showExplicitRests: rests };
  const text = embedSlashScoreOptionsFromScore(raw, score, options);
  const editable = parseEditableDocument(text, kind, options);
  assert(editable, "editor import boundary must parse");
  assert.equal(editable.slashTimingDiagnostics.length, 0, "import diagnostics");
  return { score: editable.score, text, options };
}
const mainNotes: Sound[] = [
  { part: 0, pitch: 79, start: 1.5, end: 2 },
  { part: 0, pitch: 79, start: 2, end: 2.5 },
  { part: 0, pitch: 77, start: 2.5, end: 8 },
  { part: 1, pitch: 48, start: 4.5, end: 5 },
  { part: 1, pitch: 55, start: 5, end: 8 },
];
const fixtures: Array<{ name: string; notes: Sound[] }> = [
  { name: "1.5-beat opening silence, repeated G5 and delayed lower voice", notes: mainNotes },
  { name: "half-beat opening silence", notes: mainNotes.map(n => ({ ...n,
    start: n.start === 1.5 ? 0.5 : n.start })) },
  { name: "a complete silent opening measure before the partial rest", notes: mainNotes.map(n => ({ ...n,
    start: n.start + 4, end: n.end + 4 })) },
  { name: "lower voice enters after a sustained upper voice", notes: [
    { part: 0, pitch: 79, start: 0, end: 8 },
    { part: 1, pitch: 48, start: 5.5, end: 6 },
    { part: 1, pitch: 55, start: 6, end: 8 },
  ] },
];
for (const { name, notes } of fixtures) for (const kind of ["keyboard", "number"] as const) {
  for (const rests of [true, false]) check(`${name}, ${kind}, rests=${rests}`, () => {
    const imported = importAndReopen(fixture(notes), kind, rests, 16);
    sameSounds(sounds(imported.score), notes, "MIDI import");
    let current = imported.score;
    for (let pass = 0; pass < 2; pass++) {
      const raw = scoreToSlashScore(current, kind, 16, ".", { ...modes, showExplicitRests: rests }, 2);
      const options = { ...defaultSlashScoreOptions(kind, analyzeSlashScore(raw)), ...modes,
        voiceCount: 2, showExplicitRests: rests };
      const text = embedSlashScoreOptionsFromScore(raw, current, options);
      const reopened = parseSlashScore(text, options);
      assert.equal(reopened.summary.diagnostics.length, 0, `save ${pass}: diagnostics`);
      sameSounds(sounds(reopened.score), notes, `save ${pass}`);
      current = reopened.score;
    }
  });
}
for (const division of [8, 32, 64] as const) for (const kind of ["keyboard", "number"] as const) {
  for (const rests of [true, false]) check(`alternate quantize ${division}, ${kind}, rests=${rests}`, () => {
    sameSounds(sounds(importAndReopen(fixture(mainNotes), kind, rests, division).score), mainNotes, "alternate quantize");
  });
}
for (const kind of ["keyboard", "number"] as const) for (const rests of [true, false]) {
  check(`existing explicit prefix duration and cross-group continuation, ${kind}, rests=${rests}`, () => {
    const marker = "\u2063";
    const pitch = kind === "keyboard" ? "T" : "+5";
    const next = kind === "keyboard" ? "R" : "+4";
    const text = `..${marker}${pitch}../..${marker}${next}../${marker}${pitch}..${marker}${pitch}../${marker}${next}..../`;
    const options = { ...defaultSlashScoreOptions(kind, analyzeSlashScore(text)), ...modes,
      beats: 4, beatType: 4 as const, symbolDurations: { ".": 16 as const },
      noteDivision: null, voiceCount: 2, showExplicitRests: rests };
    const parsed = parseSlashScore(text, options);
    assert.equal(parsed.summary.diagnostics.length, 0, "prefix diagnostics");
    sameSounds(sounds(parsed.score), [
      { part: 0, pitch: 79, start: 0, end: 1.5 },
      { part: 0, pitch: 77, start: 1.5, end: 2 },
      { part: 0, pitch: 79, start: 2, end: 2.5 },
      { part: 0, pitch: 79, start: 2.5, end: 3 },
      { part: 0, pitch: 77, start: 3, end: 4 },
    ], "existing prefix syntax");
  });
}
if (process.argv[2]) {
  const midi = parseMidi(await readFile(process.argv[2]));
  assert.equal(midi.ppq, 480, "provided accompaniment PPQ");
  const opening = midi.notes.filter(n => n.startTick < midi.ppq * 8).map(n => ({
    part: n.track === 2 ? 0 : 1, pitch: n.pitch, start: n.startTick / midi.ppq, end: n.endTick / midi.ppq }));
  const firstG5 = opening.filter(n => n.part === 0 && n.pitch === 79);
  assert.deepEqual(firstG5.map(n => [n.start, n.end]), [[1.5, 2], [2, 2.5]], "provided opening MIDI oracle");
  for (const kind of ["keyboard", "number"] as const) for (const rests of [true, false]) {
    check(`provided accompaniment opening ${kind}, rests=${rests}`, () => {
      const imported = importAndReopen(midi, kind, rests, 16);
      sameSounds(sounds(imported.score).filter(n => n.start < 8), opening, "provided opening");
    });
  }
}
console.log(JSON.stringify({ checks, failed: failures.length, failures }, null, 2));
assert.equal(failures.length, 0, "leading MIDI silence regression failures");
