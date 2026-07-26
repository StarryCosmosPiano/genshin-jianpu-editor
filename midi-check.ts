import {
  analyzeMidi,
  detectMidiSlashGestures,
  detectMidiTempoMarks,
  midiToScore,
  parseMidi,
  type MidiImportOptions,
} from "./src/midi";
import {
  analyzeSlashScore,
  defaultSlashScoreOptions,
  parseSlashScore,
  scoreToSlashScore,
  SLASH_VOICE_SEPARATOR,
} from "./src/slashscore";
import { scoreToJpwabc } from "./src/score/jpscore";
import { scoreToMidi } from "./src/score/midi";
import { JpwFile } from "./src/jpword/jpwfile";
import { fromJpw } from "./src/score/jpwimport";
import {
  buildTimeline,
  quarterToSeconds,
  tempoBpmAtQuarter,
} from "./src/score/timeline";
import { Chord } from "./src/score/score";
import { writeFile } from "node:fs/promises";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function be32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  for (n >>= 7; n > 0; n >>= 7) out.unshift((n & 0x7f) | 0x80);
  return out;
}

function ev(delta: number, ...data: number[]): number[] {
  return [...vlq(delta), ...data];
}

function track(body: number[]): number[] {
  const data = [...body, ...ev(0, 0xff, 0x2f, 0)];
  return [0x4d, 0x54, 0x72, 0x6b, ...be32(data.length), ...data];
}

function textMeta(type: number, text: string): number[] {
  const data = [...new TextEncoder().encode(text)];
  return ev(0, 0xff, type, ...vlq(data.length), ...data);
}

function rawTextMeta(type: number, data: number[]): number[] {
  return ev(0, 0xff, type, ...vlq(data.length), ...data);
}

function tempoMeta(delta: number, bpm: number): number[] {
  const mpqn = Math.max(1, Math.round(60000000 / bpm));
  return ev(delta, 0xff, 0x51, 3, (mpqn >>> 16) & 255, (mpqn >>> 8) & 255, mpqn & 255);
}

function timeSignatureMeta(delta: number, beats: number, beatType: 2 | 4 | 8 | 16): number[] {
  return ev(delta, 0xff, 0x58, 4, beats, Math.log2(beatType), 24, 8);
}

interface N { start: number; end: number; pitch: number }

function noteTrack(name: string, notes: N[], channel = 0): number[] {
  const events: Array<{ tick: number; order: number; data: number[] }> = [];
  for (const note of notes) {
    events.push({ tick: note.start, order: 1, data: [0x90 | channel, note.pitch, 100] });
    events.push({ tick: note.end, order: 0, data: [0x80 | channel, note.pitch, 0] });
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body = textMeta(0x03, name);
  let prev = 0;
  for (const event of events) {
    body.push(...ev(event.tick - prev, ...event.data));
    prev = event.tick;
  }
  return track(body);
}

function midi(tracks: number[][], ppq = 480): Uint8Array {
  const format = tracks.length > 1 ? 1 : 0;
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, format, 0, tracks.length, (ppq >> 8) & 255, ppq & 255];
  return new Uint8Array([...header, ...tracks.flat()]);
}

function options(quantize: 4 | 8 | 16 | 32 | 64, handMode: "auto" | "single" | "double" = "auto"): MidiImportOptions {
  return { quantize, detectTriplets: true, handMode, splitPitch: 60, fifths: 0, beats: 4, beatType: 4 };
}

const conductor = track([
  ...textMeta(0x03, "Piano Quantize Test"),
  ...ev(0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20), // 120 BPM
  ...ev(0, 0xff, 0x58, 4, 4, 2, 24, 8),
  ...ev(0, 0xff, 0x59, 2, 0, 0),
]);
const right = noteTrack("Right Hand", [
  { start: 0, end: 480, pitch: 72 },
  { start: 480, end: 960, pitch: 74 },
  { start: 960, end: 1440, pitch: 72 },
  { start: 960, end: 1440, pitch: 76 },
  { start: 960, end: 1440, pitch: 79 },
]);
const left = noteTrack("Left Hand", [
  { start: 0, end: 960, pitch: 48 },
  { start: 960, end: 1920, pitch: 43 },
]);
const parsed = parseMidi(midi([conductor, right, left]));
const gbkTitleMidi = midi([track([
  ...rawTextMeta(0x03, [0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xea, 0xcc, 0xe2]), // 中文标题 (GBK)
  ...ev(0, 0x90, 60, 100),
  ...ev(480, 0x80, 60, 0),
])]);
const gbkTitle = parseMidi(gbkTitleMidi);
check(gbkTitle.title === "中文标题", "GBK MIDI title was not decoded as Chinese");
const squareTitleMidi = midi([track([
  ...textMeta(0x03, "□□□□□□"),
  ...ev(0, 0x90, 60, 100),
  ...ev(480, 0x80, 60, 0),
])]);
check(parseMidi(squareTitleMidi).title === "", "square-placeholder MIDI title was not discarded");
await writeFile("dist/midi-import-fixture.mid", midi([conductor, right, left]));
await writeFile("dist/midi-gbk-title.mid", gbkTitleMidi);
await writeFile("dist/midi-square-title.mid", squareTitleMidi);
const analysis = analyzeMidi(parsed);
check(parsed.notes.length === 7, "format-1 notes were not parsed");
check(analysis.tempoBpm === 120 && analysis.beats === 4 && analysis.beatType === 4, "MIDI metadata was lost");
check(analysis.autoHandMode === "double", "named piano tracks were not detected as two hands");
const imported = midiToScore(parsed, {
  ...options(4),
  title: "Piano Quantize Test",
  subtitle: "钢琴双手示例",
  composer: "作曲测试",
  arranger: "编曲测试",
  instrumentName: "中文钢琴",
});
check(imported.score.piano && imported.score.parts.length === 2, "MIDI did not become paired piano score");
check(imported.score.tempoBpm === 120, "initial tempo was not preserved");
const fullKeyboardTxt = scoreToSlashScore(imported.score, "keyboard", 4, ".", {
  sourceMidi: parsed,
  braceMode: "grace",
  bracketMode: "triplet",
}, 2);
const fullKeyboardAnalysis = analyzeSlashScore(fullKeyboardTxt);
const fullKeyboardOptions = defaultSlashScoreOptions("keyboard", fullKeyboardAnalysis);
const fullKeyboardScore = parseSlashScore(fullKeyboardTxt, fullKeyboardOptions).score;
check(fullKeyboardTxt.includes(SLASH_VOICE_SEPARATOR)
  && fullKeyboardAnalysis.voiceCount === 2
  && fullKeyboardScore.piano
  && fullKeyboardScore.parts.length === 2,
"MIDI keyboard-text output merged the two hands instead of retaining full voice layout");
const jpw = scoreToJpwabc(imported.score);
check(jpw.includes(".Voice.RH") && jpw.includes(".Voice.LH") && jpw.includes("Tempo = {120}"), "piano/tempo serialization failed");
check(jpw.includes("SubTitle = {钢琴双手示例}") && jpw.includes("Composer = {作曲测试}") && jpw.includes("Arranger = {编曲测试}"), "publication metadata serialization failed");
check(jpw.includes("Instrument = {中文钢琴}"), "instrument name serialization failed");
const roundTripFile = JpwFile.fromString(jpw);
check(roundTripFile, "generated MIDI jpwabc did not parse");
const roundTrip = fromJpw(roundTripFile);
check(roundTrip?.piano && roundTrip.tempoBpm === 120 && roundTrip.subtitle === "钢琴双手示例" && roundTrip.arranger === "编曲测试" && roundTrip.instrumentName === "中文钢琴", "MIDI jpwabc round-trip failed");
const exported = scoreToMidi(roundTrip);
check(exported.includes(0x07) && exported.includes(0xa1) && exported.includes(0x20), "MIDI export did not use imported tempo");

const compoundTempo = midiToScore(parsed, {
  ...options(8, "single"),
  beats: 12,
  beatType: 8,
  tempoBpm: 90,
  tempoBeatUnit: "dotted-quarter",
});
const compoundJpw = scoreToJpwabc(compoundTempo.score);
check(compoundTempo.score.tempoBpm === 90
  && compoundTempo.score.tempoBeatUnit === "dotted-quarter"
  && compoundJpw.includes("Tempo = {90}")
  && compoundJpw.includes("TempoUnit = {dotted-quarter}"),
"compound-meter tempo beat unit was not serialized without changing quarter-note playback BPM");
const compoundRoundTripFile = JpwFile.fromString(compoundJpw);
check(compoundRoundTripFile, "compound-meter tempo fixture did not parse");
const compoundRoundTrip = fromJpw(compoundRoundTripFile);
check(compoundRoundTrip?.tempoBpm === 90
  && compoundRoundTrip.tempoBeatUnit === "dotted-quarter",
"compound-meter tempo beat unit did not round-trip through jpwabc");

const pickupMeterParsed = parseMidi(midi([
  track([
    ...tempoMeta(0, 66),
    ...timeSignatureMeta(0, 6, 16),
    ...timeSignatureMeta(720, 4, 4),
  ]),
  noteTrack("Pickup meter", [
    { start: 0, end: 240, pitch: 60 },
    { start: 240, end: 480, pitch: 62 },
    { start: 480, end: 720, pitch: 64 },
    { start: 720, end: 2640, pitch: 65 },
  ]),
]));
const pickupMeterScore = midiToScore(pickupMeterParsed, {
  ...options(32, "single"),
  beats: 6,
  beatType: 16,
  tempoBpm: 66,
}).score;
const pickupMeterFirst = pickupMeterScore.parts[0].measures[0];
const pickupMeterFull = pickupMeterScore.parts[0].measures[1];
check(pickupMeterFirst.pickup && pickupMeterFirst.displayNumber === null &&
      pickupMeterFirst.time.beats === 4 && pickupMeterFirst.time.beatType === 4,
  "temporary 6/16 MIDI pickup meter was not normalized to the governing 4/4");
check(pickupMeterFull.displayNumber === 1 && !pickupMeterFull.timeChange,
  "the first full measure after a pickup repeated its governing time signature");
const pickupMeterText = scoreToJpwabc(pickupMeterScore);
check(pickupMeterText.includes("KeyAndMeters = {1=C,4/4}") &&
      (pickupMeterText.match(/4\/4/g) ?? []).length === 1,
  "pickup serialization did not keep one 4/4 header without an inline duplicate");
const pickupMeterFile = JpwFile.fromString(pickupMeterText);
const pickupMeterRoundTrip = pickupMeterFile ? fromJpw(pickupMeterFile) : null;
check(pickupMeterRoundTrip?.parts[0].measures[0].pickup &&
      pickupMeterRoundTrip.parts[0].measures[0].displayNumber === null &&
      pickupMeterRoundTrip.parts[0].measures[1].displayNumber === 1,
  "pickup identity and numbering were lost after jpwabc round-trip");

const tempoRampConductor = track([
  ...tempoMeta(0, 90),
  ...tempoMeta(960, 90), // two fixed-tempo beats before the curve
  ...tempoMeta(240, 100),
  ...tempoMeta(240, 110),
  ...tempoMeta(240, 120),
  ...tempoMeta(240, 120), // explicit settled point
  ...tempoMeta(240, 110),
  ...tempoMeta(240, 100),
  ...tempoMeta(240, 90),
]);
const tempoRampParsed = parseMidi(midi([
  tempoRampConductor,
  noteTrack("Tempo ramp", [{ start: 0, end: 2880, pitch: 60 }]),
]));
const tempoRampScore = midiToScore(tempoRampParsed, options(16, "single")).score;
const absoluteTempoPosition = (mark: (typeof tempoRampScore.tempoMarks)[number]): number =>
  tempoRampScore.parts[0].measures[mark.measure].position.toFloat() + mark.offset.toFloat();
const accelMark = tempoRampScore.tempoMarks.find((mark) => mark.kind === "accel");
const ritMark = tempoRampScore.tempoMarks.find((mark) => mark.kind === "rit");
check(accelMark && Math.abs(absoluteTempoPosition(accelMark) - 2.5) < 1e-8,
  "monotonic MIDI acceleration did not produce accel.");
check(ritMark && Math.abs(absoluteTempoPosition(ritMark) - 4.5) < 1e-8,
  "monotonic MIDI deceleration did not produce rit.");
check(tempoRampScore.tempoMarks
  .filter((mark) => mark.kind === "accel" || mark.kind === "rit")
  .every((mark) => absoluteTempoPosition(mark) > 0),
"tempo ramp instruction was incorrectly attached to the opening fixed-tempo beat");
check(tempoRampScore.tempoMarks.some((mark) => mark.kind === "tempo" && mark.bpm === 120) &&
      tempoRampScore.tempoMarks.some((mark) => mark.kind === "tempo" && mark.bpm === 90),
  "settled tempos after MIDI ramps were not retained");
const tempoRampText = scoreToJpwabc(tempoRampScore);
check(tempoRampText.includes("TempoMarks = {"), "tempo annotations were not serialized");
const tempoRampFile = JpwFile.fromString(tempoRampText);
const tempoRampRoundTrip = tempoRampFile ? fromJpw(tempoRampFile) : null;
check(tempoRampRoundTrip?.tempoMarks.length === tempoRampScore.tempoMarks.length,
  "tempo annotations did not round-trip through jpwabc");

const linearPlaybackFile = JpwFile.fromString(`.Title
KeyAndMeters = {1=C,4/4}
Tempo = {72}
TempoMarks = {1@0=rit;1@2=tempo:65;1@2=accel;2@2=tempo:87}
.Voice
1--- |1--- |]
`);
const linearPlaybackScore = linearPlaybackFile ? fromJpw(linearPlaybackFile) : null;
check(linearPlaybackScore, "linear playback tempo fixture did not parse");
const linearPlaybackTimeline = buildTimeline(linearPlaybackScore);
check(Math.abs(tempoBpmAtQuarter(linearPlaybackTimeline.tempo, 0) - 72) < 1e-8 &&
      Math.abs(tempoBpmAtQuarter(linearPlaybackTimeline.tempo, 1) - 68.5) < 1e-8 &&
      Math.abs(tempoBpmAtQuarter(linearPlaybackTimeline.tempo, 2) - 65) < 1e-8,
  "rit. did not interpolate linearly from 72 to 65 BPM");
check(Math.abs(tempoBpmAtQuarter(linearPlaybackTimeline.tempo, 4) - 76) < 1e-8 &&
      Math.abs(tempoBpmAtQuarter(linearPlaybackTimeline.tempo, 6) - 87) < 1e-8,
  "accel. did not interpolate linearly from 65 to 87 BPM");
const expectedRitSeconds = 2 * 60 * Math.log(65 / 72) / (65 - 72);
check(Math.abs(quarterToSeconds(linearPlaybackTimeline.tempo, 2) - expectedRitSeconds) < 1e-9,
  "rit. playback clock did not integrate the linear BPM curve");
const linearPlaybackMidi = parseMidi(scoreToMidi(linearPlaybackScore));
const midpointTempo = linearPlaybackMidi.tempos.find((event) =>
  event.tick === linearPlaybackMidi.ppq * 4);
check(midpointTempo && Math.abs(midpointTempo.bpm - 76) < 0.02 &&
      linearPlaybackMidi.tempos.length > 20,
  "MIDI/native playback tempo track did not retain the sampled linear accel./rit. curve");

const settlingCorrectionParsed = parseMidi(midi([
  track([
    ...tempoMeta(0, 70),
    ...tempoMeta(480, 75),
    ...tempoMeta(480, 80),
    ...tempoMeta(60, 78),
  ]),
  noteTrack("Tempo correction", [{ start: 0, end: 1920, pitch: 60 }]),
]));
const settlingCorrectionMarks = detectMidiTempoMarks(settlingCorrectionParsed);
check(settlingCorrectionMarks.filter((mark) => mark.kind === "tempo").length === 1 &&
      settlingCorrectionMarks.find((mark) => mark.kind === "tempo")?.bpm === 78,
  "a short DAW tempo-curve settling correction produced two overlapping metronome marks");

const violin = noteTrack("Violin", [
  { start: 0, end: 480, pitch: 79 },
  { start: 480, end: 960, pitch: 81 },
  { start: 960, end: 1440, pitch: 83 },
]);
const ensembleParsed = parseMidi(midi([conductor, right, left, violin]));
await writeFile("dist/midi-ensemble-fixture.mid", midi([conductor, right, left, violin]));
const ensembleImported = midiToScore(ensembleParsed, {
  ...options(4),
  title: "多轨总谱测试",
  scoreMode: "ensemble",
  trackAssignments: [
    { track: 1, instrumentName: "钢琴", voice: 1 },
    { track: 2, instrumentName: "钢琴", voice: 2 },
    { track: 3, instrumentName: "小提琴", voice: 1 },
  ],
});
check(ensembleImported.score.ensemble && !ensembleImported.score.piano, "multi-track MIDI did not enter full-score mode");
check(ensembleImported.summary.layoutMode === "ensemble" && ensembleImported.summary.instrumentCount === 2 && ensembleImported.summary.partCount === 3,
  "full-score MIDI summary has the wrong instrument/voice counts");
check(ensembleImported.score.parts.map((part) => `${part.instrumentName}:${part.voiceIndex}`).join("|") === "钢琴:1|钢琴:2|小提琴:1",
  "track assignments did not preserve instrument and vertical voice order");
const ensembleText = scoreToJpwabc(ensembleImported.score);
check(ensembleText.includes(".Voice.钢琴.V1") && ensembleText.includes(".Voice.钢琴.V2") && ensembleText.includes(".Voice.小提琴.V1"),
  "full-score voice section names were not serialized");
const ensembleFile = JpwFile.fromString(ensembleText);
const ensembleRoundTrip = ensembleFile ? fromJpw(ensembleFile) : null;
check(ensembleRoundTrip?.ensemble && ensembleRoundTrip.parts.length === 3,
  "full-score jpwabc did not round-trip");
const ensembleMidi = scoreToMidi(ensembleRoundTrip);
check(((ensembleMidi[10] << 8) | ensembleMidi[11]) === 4, "full-score MIDI export must contain tempo plus three voice tracks");
const exportedEnsembleParsed = parseMidi(ensembleMidi);
check(exportedEnsembleParsed.tracks.some((track) => track.name === "钢琴 声部 1") &&
      exportedEnsembleParsed.tracks.some((track) => track.name === "小提琴"),
  "full-score MIDI export lost instrument/voice track names");

const tripletParsed = parseMidi(midi([noteTrack("Triplet", [
  { start: 0, end: 160, pitch: 60 },
  { start: 160, end: 320, pitch: 62 },
  { start: 320, end: 480, pitch: 64 },
])]));
const tripletAnalysis = analyzeMidi(tripletParsed);
check(tripletAnalysis.recommendedQuantize === 8, "eighth-note triplets chose the wrong base division");
const tripletResult = midiToScore(tripletParsed, options(8, "single"));
check(tripletResult.summary.tripletGroups === 1, "triplet group was not detected");
const tripletText = scoreToJpwabc(tripletResult.score);
check(tripletText.includes("{(3}"), "triplet syntax was not emitted");
const tripletFile = JpwFile.fromString(tripletText);
const tripletRoundTrip = tripletFile ? fromJpw(tripletFile) : null;
check(tripletRoundTrip?.parts[0].measures.length === 1, "triplet jpwabc did not round-trip");
const tripletChords = tripletRoundTrip.parts[0].measures[0].entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest);
check(tripletChords.length === 3 && tripletChords.every((chord) =>
  Math.abs((chord.duration?.toFloat() ?? 0) - 1 / 3) < 1e-9),
"triplet members did not keep three equal one-third-quarter durations after JPW round-trip");
const tripletTimeline = buildTimeline(tripletRoundTrip);
check(tripletTimeline.notes.length === 3 &&
  tripletTimeline.notes.every((note, index) => Math.abs(note.t0 - index / 3) < 1e-9),
"triplet playback attacks are not evenly spaced");

const rolledBytes = midi([noteTrack("Rolled chord", [
  { start: 0, end: 480, pitch: 60 },
  { start: 20, end: 500, pitch: 64 },
  { start: 40, end: 520, pitch: 67 },
])]);
await writeFile("dist/midi-gesture-fixture.mid", rolledBytes);
const rolledParsed = parseMidi(rolledBytes);
const rolledGestures = detectMidiSlashGestures(rolledParsed, 16);
check(rolledGestures.arpeggio.length === 1, "overlapping rising rolled chord was not detected as an arpeggio");
check(analyzeMidi(rolledParsed).arpeggioGroupCount === 1, "MIDI analysis did not report the arpeggio group");
const rolledScore = midiToScore(rolledParsed, options(16, "single")).score;
const rolledChord = rolledScore.parts[0].measures
  .flatMap((measure) => measure.entries)
  .find((entry): entry is Chord => entry instanceof Chord && entry.arpeggio);
check(rolledChord?.notes.length === 3, "detected MIDI arpeggio was not attached to its numbered chord");
const rolledJpw = scoreToJpwabc(rolledScore);
check(rolledJpw.includes("Arpeggios = {"), "arpeggio mark was not serialized");
const rolledJpwFile = JpwFile.fromString(rolledJpw);
const rolledRoundTrip = rolledJpwFile ? fromJpw(rolledJpwFile) : null;
check(rolledRoundTrip?.parts[0].measures.some((measure) =>
  measure.entries.some((entry) => entry instanceof Chord && entry.arpeggio)),
"arpeggio mark did not round-trip through jpwabc");
const rolledSlash = scoreToSlashScore(rolledScore, "number", 16, ".", {
  sourceMidi: rolledParsed,
  braceMode: "arpeggio",
  bracketMode: "triplet",
});
check(/\{[^}]*1[^}]*3[^}]*5[^}]*\}/.test(rolledSlash), "detected rolled chord was not written with the assigned braces");

const partialRolledBytes = midi([
  noteTrack("Rolled subset", [
    { start: 0, end: 480, pitch: 45 },
    { start: 20, end: 500, pitch: 48 },
    { start: 40, end: 520, pitch: 52 },
    { start: 60, end: 540, pitch: 55 },
  ]),
  noteTrack("Simultaneous main", [
    { start: 0, end: 480, pitch: 60 },
  ]),
]);
const partialRolledParsed = parseMidi(partialRolledBytes);
check(detectMidiSlashGestures(partialRolledParsed, 16).arpeggio.length === 1,
  "partial rolled MIDI fixture was not recognized");
const partialRolledScore = midiToScore(partialRolledParsed, options(16, "single")).score;
const partialRolledSlash = scoreToSlashScore(partialRolledScore, "keyboard", 16, ".", {
  sourceMidi: partialRolledParsed,
  braceMode: "arpeggio",
  bracketMode: "triplet",
});
check(partialRolledSlash.includes("{,NZCB}A") && !partialRolledSlash.includes("A{,NZCB}"),
  "a partial arpeggio was not serialized before its simultaneous main pitch");

const subTripletRollParsed = parseMidi(midi([noteTrack("Sub-triplet roll", [
  { start: 0, end: 480, pitch: 60 },
  { start: 30, end: 510, pitch: 64 },
  { start: 60, end: 540, pitch: 67 },
])]));
check(detectMidiSlashGestures(subTripletRollParsed, 32).arpeggio.length === 1,
  "a rising overlapping roll faster than the selected 32nd-note triplet was not classified as arpeggio");
check(detectMidiSlashGestures(subTripletRollParsed, 64).arpeggio.length === 0,
  "gesture classification was not recomputed after changing to 64th-note quantize");
const subTripletRollScore = midiToScore(subTripletRollParsed, options(32, "single")).score;
const subTripletRollChord = subTripletRollScore.parts[0].measures
  .flatMap((measure) => measure.entries)
  .find((entry): entry is Chord => entry instanceof Chord && entry.arpeggio);
check(subTripletRollChord?.notes.length === 3,
  "sub-triplet MIDI attacks were not collapsed into one written arpeggio chord");
const subTripletPlayback = buildTimeline(subTripletRollScore).notes
  .filter((note) => note.chord === subTripletRollChord)
  .sort((left, right) => left.pitch - right.pitch);
check(subTripletPlayback.length === 3 &&
      subTripletPlayback[0].t0 < subTripletPlayback[1].t0 &&
      subTripletPlayback[1].t0 < subTripletPlayback[2].t0,
  "written arpeggio did not play from low to high with distinct attacks");

const finestTripletParsed = parseMidi(midi([noteTrack("32nd triplet", [
  { start: 0, end: 40, pitch: 60 },
  { start: 40, end: 80, pitch: 62 },
  { start: 80, end: 120, pitch: 64 },
])]));
const finestTripletGestures = detectMidiSlashGestures(finestTripletParsed, 32);
check(finestTripletGestures.triplet.length === 1 && finestTripletGestures.arpeggio.length === 0,
  "a valid 32nd-note triplet was incorrectly promoted to arpeggio");
check(midiToScore(finestTripletParsed, options(32, "single")).summary.tripletGroups === 1,
  "32nd-note quantize did not retain its fastest legal triplet");

const staccatoParsed = parseMidi(midi([noteTrack("Staccato source", [
  { start: 0, end: 20, pitch: 60 },
  { start: 480, end: 500, pitch: 62 },
])]));
const staccatoScore = midiToScore(staccatoParsed, options(16, "single")).score;
const staccatoSlash = scoreToSlashScore(staccatoScore, "number", 16, ".", {
  sourceMidi: staccatoParsed,
  braceMode: "grace",
  bracketMode: "triplet",
});
check(/1\.{4}\//.test(staccatoSlash),
  "slash export retained the short MIDI note-off instead of its default onset-to-onset sustain");

const longTailParsed = parseMidi(midi([noteTrack("Long release", [
  { start: 0, end: 720, pitch: 60 },
  { start: 960, end: 1440, pitch: 64 },
])]));
const longTailScore = midiToScore(longTailParsed, options(8, "single")).score;
const longTailSlash = scoreToSlashScore(longTailScore, "number", 8, ".", {
  sourceMidi: longTailParsed,
  braceMode: "grace",
  bracketMode: "triplet",
});
const longTailScoreText = longTailSlash.split(/\r?\n/).filter((line) =>
  !line.trimStart().startsWith("//") && line.includes("/")).join("");
check((longTailScoreText.match(/1/g) ?? []).length === 1,
  "a split MIDI release tail was serialized as an extra note-on in the slash score");

const scaleParsed = parseMidi(midi([noteTrack("Fast scale", [
  { start: 0, end: 120, pitch: 60 },
  { start: 120, end: 240, pitch: 62 },
  { start: 240, end: 360, pitch: 64 },
])]));
check(detectMidiSlashGestures(scaleParsed, 16).arpeggio.length === 0,
  "ordinary non-overlapping scale was misclassified as an arpeggio");

const graceParsed = parseMidi(midi([noteTrack("Grace", [
  { start: 210, end: 240, pitch: 62 },
  { start: 240, end: 720, pitch: 64 },
])]));
const graceGestures = detectMidiSlashGestures(graceParsed, 32);
check(graceGestures.grace.length === 1, "short off-grid attack before a main note was not detected as grace");
const graceScore = midiToScore(graceParsed, options(32, "single")).score;
const graceMain = graceScore.parts[0].measures
  .flatMap((measure) => measure.entries)
  .find((entry): entry is Chord => entry instanceof Chord && entry.graceNotes.length > 0);
check(graceMain?.graceNotes.length === 1 && graceMain.graceNotes[0].pitch === 62,
  "detected MIDI grace note was not attached to its main note");
const graceJpw = scoreToJpwabc(graceScore);
check(/\{[^}]*2[^}]*\}3/.test(graceJpw), "grace-note prefix was not serialized");
const graceJpwFile = JpwFile.fromString(graceJpw);
const graceRoundTrip = graceJpwFile ? fromJpw(graceJpwFile) : null;
const graceRoundTripMain = graceRoundTrip?.parts[0].measures
  .flatMap((measure) => measure.entries)
  .find((entry): entry is Chord => entry instanceof Chord && entry.graceNotes.length > 0);
check(graceRoundTripMain?.graceNotes.length === 1,
  "grace note did not round-trip through jpwabc");
check(buildTimeline(graceScore).notes.length === 2,
  "attached grace note was omitted from playback");
const graceSlash = scoreToSlashScore(graceScore, "number", 32, ".", {
  sourceMidi: graceParsed,
  braceMode: "grace",
  bracketMode: "triplet",
});
check(/\{2\}3/.test(graceSlash), "detected grace note was not written before its main note");

const tripletSlash = scoreToSlashScore(tripletResult.score, "number", 16, ".", {
  sourceMidi: tripletParsed,
  braceMode: "grace",
  bracketMode: "triplet",
});
check(/\[[^\]]+\]/.test(tripletSlash), "detected MIDI triplet was not written with the assigned square brackets");
const tripletSlashAnalysis = analyzeSlashScore(tripletSlash);
const parsedTripletSlash = parseSlashScore(
  tripletSlash,
  defaultSlashScoreOptions("number", tripletSlashAnalysis),
);
const tripletSlashTimeline = buildTimeline(parsedTripletSlash.score);
check(tripletSlashTimeline.notes.slice(0, 3).every((note, index) =>
  Math.abs(note.t0 - index / 3) < 1e-8),
"square-bracket triplet did not round-trip to three evenly spaced attacks");

const many: N[] = [];
for (let i = 0; i < 200; i++) many.push({ start: i * 480, end: i * 480 + 480, pitch: 60 + (i % 5) });
many.push({ start: 200 * 480, end: 200 * 480 + 30, pitch: 72 });
const rareAnalysis = analyzeMidi(parseMidi(midi([noteTrack("Rare grace", many)])));
check(rareAnalysis.suspectedGraceDivision === 64 && rareAnalysis.suspectedGraceCount === 1, "rare 64th note was not flagged");
check(rareAnalysis.recommendedQuantize === 4, "a sub-2% shortest value incorrectly entered the recommendation");

const thresholdNotes: N[] = [];
let thresholdTick = 0;
for (const [count, duration] of [[200, 480], [865, 240], [929, 120], [20, 60]] as const) {
  for (let index = 0; index < count; index++) {
    thresholdNotes.push({
      start: thresholdTick,
      end: thresholdTick + duration,
      pitch: 60 + (index % 7),
    });
    thresholdTick += duration;
  }
}
const thresholdAnalysis = analyzeMidi(parseMidi(midi([noteTrack("Two percent threshold", thresholdNotes)])));
check(thresholdAnalysis.noteCount === 2014 &&
  thresholdAnalysis.durationCounts[4] === 200 &&
  thresholdAnalysis.durationCounts[8] === 865 &&
  thresholdAnalysis.durationCounts[16] === 929 &&
  thresholdAnalysis.durationCounts[32] === 20,
"recommendation threshold fixture did not retain the requested duration histogram");
check(thresholdAnalysis.recommendedQuantize === 16,
  "a 32nd-note value below 2% incorrectly overrode the 16th-note recommendation");

const meterConductor = track([
  ...ev(0, 0xff, 0x58, 4, 4, 2, 24, 8),
  ...ev(1920, 0xff, 0x58, 4, 3, 2, 24, 8),
]);
const meterNotes: N[] = [];
for (let i = 0; i < 7; i++) meterNotes.push({ start: i * 480, end: (i + 1) * 480, pitch: 60 + (i % 3) });
const meterScore = midiToScore(parseMidi(midi([meterConductor, noteTrack("Meter", meterNotes)])), options(4, "single")).score;
const meterText = scoreToJpwabc(meterScore);
check(meterText.includes("3/4"), "mid-score time signature was not serialized");
const meterFile = JpwFile.fromString(meterText);
const meterRoundTrip = meterFile ? fromJpw(meterFile) : null;
check(meterRoundTrip?.parts[0].measures[1].time.beats === 3, "inline time signature did not round-trip");

const oddDuration = parseMidi(midi([noteTrack("Odd duration", [{ start: 0, end: 150, pitch: 60 }])]));
const oddText = scoreToJpwabc(midiToScore(oddDuration, options(64, "single")).score);
check(JpwFile.fromString(oddText), "a grid duration requiring multiple JPW tokens did not parse");

const splitChordTail = midiToScore(parseMidi(midi([noteTrack("Chord tail grid", [
  { start: 0, end: 500, pitch: 60 },
  { start: 0, end: 620, pitch: 64 },
])])), options(16, "single")).score;
const splitChordTimeline = buildTimeline(splitChordTail);
check(splitChordTimeline.notes.length === 2 &&
  splitChordTimeline.notes.every((note) => Math.abs(note.t1 - 1.25) < 1e-8),
"median chord release escaped the selected 16th-note grid");

const crossBarTail = midiToScore(parseMidi(midi([noteTrack("Cross bar tail", [
  { start: 0, end: 2060, pitch: 60 },
])])), options(16, "single")).score;
const crossBarChords = crossBarTail.parts[0].measures
  .flatMap((measure) => measure.entries)
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest);
check(crossBarChords.length === 2 &&
  crossBarChords[0].notes.every((note) => note.tieStart && note.tieNext?.chord === crossBarChords[1]) &&
  crossBarChords[1].notes.every((note) => note.tieEnd && note.tiePrev?.chord === crossBarChords[0]),
"MIDI release crossing a barline was not converted to an adjacent semantic tie");
const crossBarTimeline = buildTimeline(crossBarTail);
check(crossBarTimeline.notes.length === 1 && Math.abs(crossBarTimeline.notes[0].t1 - 4.25) < 1e-8,
  "cross-bar MIDI release was retriggered or did not end on the nearest 16th grid line");
const crossBarText = scoreToJpwabc(crossBarTail);
const crossBarFile = JpwFile.fromString(crossBarText);
const crossBarRoundTrip = crossBarFile ? fromJpw(crossBarFile) : null;
const crossBarRoundTripTimeline = crossBarRoundTrip ? buildTimeline(crossBarRoundTrip) : null;
check(crossBarRoundTripTimeline?.notes.length === 1 &&
  Math.abs(crossBarRoundTripTimeline.notes[0].t1 - 4.25) < 1e-8,
"cross-bar release tie was lost after jpwabc serialization");

let badRejected = false;
try { parseMidi(new Uint8Array([0, 1, 2, 3])); } catch { badRejected = true; }
check(badRejected, "malformed MIDI did not fail safely");

console.log(JSON.stringify({
  notes: parsed.notes.length,
  hands: imported.summary.handCount,
  tempo: imported.score.tempoBpm,
  tripletGroups: tripletResult.summary.tripletGroups,
  rareGrace: rareAnalysis.suspectedGraceCount,
  recommended: rareAnalysis.recommendedQuantize,
  ensembleParts: ensembleImported.summary.partCount,
  ensembleInstruments: ensembleImported.summary.instrumentCount,
}, null, 2));
