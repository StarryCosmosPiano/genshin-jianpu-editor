import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analyzeMidi, midiToScore, parseMidi, type ParsedMidi } from "./src/midi";
import { Chord, type Score } from "./src/score/score";
import { buildTimeline } from "./src/score/timeline";
import { parseEditableDocument } from "./src/editor/document-parser";
import {
  analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptionsFromScore,
  normalizeNotationAnnotations, parseSlashScore, scoreToSlashScore,
  type SlashScoreKind, type SlashScoreOptions,
} from "./src/slashscore";

interface SourceNote { part: number; start: number; end: number; pitch: number }
interface Sound { part: number; start: number; end: number; pitch: number }
const EPSILON = 1e-8;
const marker = "\u2063";
let checks = 0;
const failures: string[] = [];
function check(name: string, action: () => void): void {
  try { action(); checks++; }
  catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
function fixture(notes: SourceNote[]): ParsedMidi {
  return { format: 1, ppq: 960, trackCount: 3, title: "音值组合回归",
    tracks: [{ index: 0, name: "Conductor", noteCount: 0 },
      { index: 1, name: "Right Hand", noteCount: notes.filter(n => n.part === 0).length },
      { index: 2, name: "Left Hand", noteCount: notes.filter(n => n.part === 1).length }],
    notes: notes.map(note => ({ startTick: Math.round(note.start * 960),
      endTick: Math.round(note.end * 960), pitch: note.pitch, velocity: 100,
      channel: note.part, track: note.part + 1 })),
    tempos: [{ tick: 0, bpm: 114 }], timeSignatures: [{ tick: 0, beats: 4, beatType: 4 }],
    keySignatures: [{ tick: 0, fifths: 0, minor: false }], ignoredEvents: 0,
    endTick: Math.ceil(Math.max(...notes.map(n => n.end)) / 4) * 4 * 960 };
}
const modes = { braceMode: "arpeggio", bracketMode: "triplet", barMode: "none",
  angleMode: "grace", parenMode: "chord", ordering: "pitch-asc" } as const;
function settings(text: string, kind: SlashScoreKind, rests: boolean): SlashScoreOptions {
  return { ...defaultSlashScoreOptions(kind, analyzeSlashScore(text)), ...modes,
    voiceCount: 2, showExplicitRests: rests };
}
function sounds(score: Score): Sound[] {
  return buildTimeline(score).notes.map(note => ({ start: note.t0, end: note.t1,
    part: note.part, pitch: note.pitch }))
    .sort((a, b) => a.start - b.start || a.part - b.part || a.pitch - b.pitch);
}
function sameSounds(actual: Sound[], expected: Sound[], label: string, releases = true): void {
  const sorted = (input: Sound[]) => [...input].sort((a, b) => a.start - b.start || a.part - b.part || a.pitch - b.pitch);
  const left = sorted(actual), right = sorted(expected);
  assert.equal(left.length, right.length, `${label}: attack count`);
  right.forEach((wanted, index) => {
    const found = left[index]!;
    assert.equal(found.pitch, wanted.pitch, `${label}: pitch at ${wanted.start}`);
    assert.equal(found.part, wanted.part, `${label}: voice at ${wanted.start}`);
    assert(Math.abs(found.start - wanted.start) < EPSILON, `${label}: onset ${found.start} != ${wanted.start}`);
    if (releases) assert(Math.abs(found.end - wanted.end) < EPSILON,
      `${label}: release ${found.end} != ${wanted.end} for ${wanted.pitch} at ${wanted.start}`);
  });
}
function chordAt(score: Score, part: number, start: number): Chord {
  const chord = score.parts[part].measures.flatMap(measure => measure.entries)
    .find((entry): entry is Chord => entry instanceof Chord && !entry.rest
      && Math.abs(entry.measure.position.plus(entry.position).toFloat() - start) < EPSILON);
  assert(chord, `missing written chord in voice ${part} at ${start}`);
  return chord;
}
function shape(score: Score, part: number, start: number, duration: number,
  beams: number, beats: number, tuplet: boolean, continuation: boolean): void {
  const chord = chordAt(score, part, start);
  assert(Math.abs((chord.duration?.toFloat() ?? 0) - duration) < EPSILON, `duration at ${start}`);
  assert.equal(chord.beams, beams, `beams at ${start}`);
  assert.equal(chord.beats, beats, `written value at ${start}`);
  assert.equal(chord.dot, 0, `dots at ${start}`);
  assert.equal(chord.notes.some(note => note.tuplet !== null), tuplet, `3:2 ownership at ${start}`);
  assert.equal(chord.transparentContinuation, continuation, `continuation at ${start}`);
  if (continuation) assert(chord.notes.every(note => note.tieEnd && note.tiePrev), `connected tie at ${start}`);
}
function readableValues(score: Score): void {
  score.parts.forEach((part, partIndex) => part.measures.forEach(measure => {
    for (const chord of measure.entries) {
      if (!(chord instanceof Chord) || !chord.duration) continue;
      const tuplet = chord.notes.find(note => note.tuplet !== null)?.tuplet;
      const written = chord.beats / 2 ** chord.beams * (chord.dot ? 2 - 2 ** -chord.dot : 1);
      const actual = tuplet ? written * tuplet.ratioDenominator / tuplet.ratioNumerator : written;
      assert(Math.abs(actual - chord.duration.toFloat()) < EPSILON,
        `voice ${partIndex} measure ${measure.index + 1} offset ${chord.position}: visible ${actual} != real ${chord.duration}`);
    }
  }));
}
function importText(midi: ParsedMidi, kind: SlashScoreKind, rests: boolean) {
  const score = midiToScore(midi, { outputFormat: kind, quantize: 16, detectTriplets: true,
    handMode: "auto", splitPitch: analyzeMidi(midi).splitPitch, scoreMode: "hands",
    fifths: 0, beats: 4, beatType: 4, tempoBpm: 114 }).score;
  const raw = scoreToSlashScore(score, kind, 16, ".", { sourceMidi: midi, ...modes,
    showExplicitRests: rests }, 2);
  const options = settings(raw, kind, rests);
  const text = embedSlashScoreOptionsFromScore(raw, score, options);
  const editable = parseEditableDocument(text, kind, options);
  assert(editable, "real editor import must parse");
  assert.equal(editable.slashTimingDiagnostics.length, 0, "import diagnostics");
  return { score: editable.score, text, kind, rests };
}
function roundTrips(state: ReturnType<typeof importText>, inspect: (score: Score) => void): void {
  const oracle = sounds(state.score);
  for (const serialize of [false, true]) {
    let current = state.score, kind = state.kind, text = state.text;
    for (let pass = 0; pass < 2; pass++) {
      if (serialize) {
        kind = kind === "keyboard" ? "number" : "keyboard";
        text = scoreToSlashScore(current, kind, 16, ".", { ...modes,
          showExplicitRests: state.rests }, 2);
      }
      const options = settings(text, kind, state.rests);
      text = embedSlashScoreOptionsFromScore(text, current, options);
      const parsed = parseSlashScore(text, settings(text, kind, state.rests));
      assert.equal(parsed.summary.diagnostics.length, 0, `pass ${pass}: diagnostics`);
      sameSounds(sounds(parsed.score), oracle, `${serialize ? "conversion" : "save"} ${pass}`);
      readableValues(parsed.score);
      inspect(parsed.score);
      current = parsed.score;
    }
  }
}
const cases: Array<{ name: string; notes: SourceNote[]; inspect(score: Score): void }> = [
  { name: "half note tied into the first shared triplet cell", notes: [
    { part: 0, start: 0, end: 7 / 3, pitch: 67 },
    { part: 0, start: 0, end: 7 / 3, pitch: 71 },
    { part: 0, start: 0, end: 7 / 3, pitch: 79 },
    { part: 0, start: 7 / 3, end: 8 / 3, pitch: 60 },
    { part: 0, start: 8 / 3, end: 3, pitch: 62 },
    { part: 0, start: 3, end: 4, pitch: 67 },
    { part: 1, start: 0, end: 2, pitch: 48 },
    { part: 1, start: 2, end: 4, pitch: 55 },
  ], inspect(score) {
    shape(score, 0, 0, 2, 0, 2, false, false);
    shape(score, 0, 2, 1 / 3, 1, 1, true, true);
    shape(score, 0, 7 / 3, 1 / 3, 1, 1, true, false);
    shape(score, 0, 8 / 3, 1 / 3, 1, 1, true, false);
    shape(score, 1, 2, 2, 0, 2, false, false);
  } },
  { name: "eighth tied to a two-cell triplet continuation", notes: [
    { part: 0, start: 0, end: 2, pitch: 72 },
    { part: 0, start: 2, end: 7 / 3, pitch: 57 },
    { part: 0, start: 7 / 3, end: 8 / 3, pitch: 59 },
    { part: 0, start: 8 / 3, end: 3, pitch: 60 },
    { part: 0, start: 3, end: 4, pitch: 64 },
    { part: 1, start: 0, end: 1.5, pitch: 48 },
    { part: 1, start: 1.5, end: 8 / 3, pitch: 50 },
    { part: 1, start: 1.5, end: 8 / 3, pitch: 55 },
    { part: 1, start: 8 / 3, end: 3, pitch: 53 },
    { part: 1, start: 3, end: 4, pitch: 48 },
  ], inspect(score) {
    shape(score, 1, 1.5, .5, 1, 1, false, false);
    shape(score, 1, 2, 2 / 3, 0, 1, true, true);
    shape(score, 1, 8 / 3, 1 / 3, 1, 1, true, false);
  } },
  { name: "triplet last member sustains across one full measure", notes: [
    { part: 0, start: 0, end: 8, pitch: 72 },
    { part: 0, start: 8, end: 12, pitch: 74 },
    { part: 1, start: 0, end: 1 / 3, pitch: 48 },
    { part: 1, start: 1 / 3, end: 2 / 3, pitch: 52 },
    { part: 1, start: 2 / 3, end: 8, pitch: 55 },
    { part: 1, start: 8, end: 12, pitch: 55 },
  ], inspect(score) {
    shape(score, 1, 2 / 3, 1 / 3, 1, 1, true, false);
    const whole = chordAt(score, 1, 4);
    shape(score, 1, 4, 4, 0, 4, false, true);
    assert.equal(whole.measure.entries.filter(entry => entry instanceof Chord && !entry.rest).length, 1);
    shape(score, 1, 8, 4, 0, 4, false, false);
  } },
];
for (const kind of ["keyboard", "number"] as const) for (const rests of [true, false]) {
  for (const example of cases) {
    check(`${kind} rests=${rests}: ${example.name}`, () => {
      const state = importText(fixture(example.notes), kind, rests);
      sameSounds(sounds(state.score), example.notes, "original fixture", rests);
      example.inspect(state.score);
      readableValues(state.score);
      roundTrips(state, example.inspect);
    });
  }
}
check("partial triplet repeated pitch is a real attack without continuation metadata", () => {
  const text = `(Z${marker}A)..../[${marker}A....${marker}S..]/${marker}D..../${marker}F..../`;
  const parsed = parseSlashScore(text, { ...settings(text, "keyboard", true),
    beats: 4, beatType: 4, symbolDurations: { ".": 16 } });
  assert.equal(parsed.summary.diagnostics.length, 0);
  const a = sounds(parsed.score).filter(note => note.part === 0 && note.pitch === 60);
  assert.deepEqual(a.map(note => note.start), [0, 1]);
});
check("completed single-member tuplet retains its ordinary outside tie", () => {
  const text = "[1...].0./0..../0..../0..../";
  const options: SlashScoreOptions = { ...settings(text, "number", true), voiceCount: 1,
    beats: 4, beatType: 4, symbolDurations: { ".": 16 }, noteDivision: null };
  const parsed = parseSlashScore(text, options);
  assert.equal(parsed.summary.diagnostics.length, 0);
  const root = chordAt(parsed.score, 0, 0);
  assert.equal(root.duration?.toFloat(), .5);
  assert(root.notes.every(note => note.tuplet !== null));
  assert(root.notes.every(note => note.tieNext?.chord.duration?.toFloat() === .25
    && note.tieNext.tuplet === null));
  readableValues(parsed.score);
});
check("explicit dotted triplets keep their spelling in both 6/8 voices", () => {
  const text = `[(Z${marker}A)...(X${marker}S)...(C${marker}D)...]/(V${marker}F)....../`;
  const options: SlashScoreOptions = { ...settings(text, "keyboard", true),
    beats: 6, beatType: 8, symbolDurations: { ".": 16 }, noteDivision: null };
  const parsed = parseSlashScore(text, options);
  assert.equal(parsed.summary.diagnostics.length, 0);
  for (const part of [0, 1]) for (const start of [0, .5, 1]) {
    const chord = chordAt(parsed.score, part, start);
    assert.equal(chord.duration?.toFloat(), .5);
    assert.equal(chord.beams, 1);
    assert.equal(chord.dot, 1);
    assert(chord.notes.every(note => note.tuplet !== null));
  }
  readableValues(parsed.score);
});
check("triplet continuation metadata is absent unless explicitly valid", () => {
  const base = { type: "triplet", part: 0, voice: 1, measure: 0, offset: 0,
    scope: "all", end: 1, members: [.5, .5, .5] };
  for (const value of [undefined, [], [true], [false, "yes", false]]) {
    const result = normalizeNotationAnnotations([{ ...base, memberContinuations: value }])[0];
    assert(result?.type === "triplet");
    assert.equal(result.memberContinuations, undefined);
  }
});
for (const test of [
  { name: "same-voice adjacent first member", previous: `(Z${marker}A)....`,
    members: `${marker}A..${marker}S..${marker}D..`, flags: [true, false, false],
    expected: [[60, 0, 4 / 3], [62, 4 / 3, 5 / 3], [64, 5 / 3, 2]] },
  { name: "same-voice adjacent middle member", previous: `(Z${marker}A)....`,
    members: `${marker}S..${marker}S..${marker}D..`, flags: [false, true, false],
    expected: [[60, 0, 1], [62, 1, 5 / 3], [64, 5 / 3, 2]] },
  { name: "different pitch cannot continue", previous: `(Z${marker}A)....`,
    members: `${marker}S..${marker}D..${marker}F..`, flags: [true, false, false],
    expected: [[60, 0, 1], [62, 1, 4 / 3], [64, 4 / 3, 5 / 3], [65, 5 / 3, 2]] },
  { name: "rest breaks the continuation", previous: `(Z${marker}A)..${marker}0..`,
    members: `${marker}A..${marker}S..${marker}D..`, flags: [true, false, false],
    expected: [[60, 0, .5], [60, 1, 4 / 3], [62, 4 / 3, 5 / 3], [64, 5 / 3, 2]] },
  { name: "other voice cannot supply the continued pitch", previous: `(A${marker}S)....`,
    members: `${marker}A..${marker}S..${marker}D..`, flags: [true, false, false],
    expected: [[62, 0, 1], [60, 1, 4 / 3], [62, 4 / 3, 5 / 3], [64, 5 / 3, 2]] },
] as const) {
  check(`metadata: ${test.name}`, () => {
    const text = `${test.previous}/[${test.members}]/${marker}G..../${marker}H..../`;
    const options: SlashScoreOptions = { ...settings(text, "keyboard", true), beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, annotations: [{ type: "triplet", part: 0, voice: 1,
        measure: 0, offset: 1, end: 2, scope: "all", members: [.5, .5, .5],
        memberContinuations: [...test.flags] }] };
    const parsed = parseSlashScore(text, options);
    assert.equal(parsed.summary.diagnostics.length, 0);
    const actual = sounds(parsed.score).filter(note => note.part === 0 && note.start < 2 - EPSILON);
    sameSounds(actual, test.expected.map(([pitch, start, end]) => ({ pitch, start, end, part: 0 })), test.name);
    readableValues(parsed.score);
  });
}

if (process.argv[2]) {
  const midi = parseMidi(new Uint8Array(await readFile(process.argv[2])));
  assert.equal(midi.ppq, 480, "regression sample PPQ");
  assert.equal(midi.notes.length, 1579, "regression sample source note count");
  const focus = (score: Score) => {
    shape(score, 0, 32, 2, 0, 2, false, false);
    shape(score, 0, 34, 1 / 3, 1, 1, true, true);
    shape(score, 1, 377.5, .5, 1, 1, false, false);
    shape(score, 1, 378, 2 / 3, 0, 1, true, true);
    shape(score, 1, 378 + 2 / 3, 1 / 3, 1, 1, true, false);
    shape(score, 1, 446 + 2 / 3, 1 / 3, 1, 1, true, false);
    shape(score, 1, 447, 1, 0, 1, false, true);
    shape(score, 1, 448, 4, 0, 4, false, true);
    assert.equal(chordAt(score, 1, 448).measure.entries.filter(entry => entry instanceof Chord && !entry.rest).length, 1);
  };
  for (const kind of ["keyboard", "number"] as const) for (const rests of [true, false]) {
    check(`provided MIDI ${kind} rests=${rests}: all 1579 attacks, spelling, save and conversion`, () => {
      const state = importText(midi, kind, rests);
      assert.equal(sounds(state.score).length, 1579);
      const rawAttacks = midi.notes.map(note => ({ part: note.track === 2 ? 0 : 1,
        pitch: note.pitch, start: note.startTick / midi.ppq, end: note.endTick / midi.ppq }));
      // Ordinary attacks still follow the selected 16th quantization. The
      // exact triplet-window oracle is separately asserted above; compare
      // all source pitch/voice occurrences without claiming raw timing is
      // lossless outside that chosen grid.
      const occurrence = (notes: Sound[]) => notes.map(n => `${n.part}:${n.pitch}`).sort();
      assert.deepEqual(occurrence(sounds(state.score)), occurrence(rawAttacks));
      focus(state.score);
      readableValues(state.score);
      roundTrips(state, focus);
    });
  }
}
if (failures.length) { failures.forEach(message => console.error(message)); throw new Error(`${failures.length} rhythm spelling checks failed`); }
console.log(`midi-rhythm-spelling-check: ${checks} checks passed`);
