import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  analyzeMidi,
  importedMidiSlashGestures,
  midiToScore,
  parseMidi,
  type MidiImportOptions,
  type ParsedMidi,
} from "./src/midi";
import { parseEditableDocument } from "./src/editor/document-parser";
import { buildTimeline } from "./src/score/timeline";
import {
  analyzeSlashScore,
  defaultSlashScoreOptions,
  embedSlashScoreOptionsFromScore,
  parseSlashScore,
  scoreToSlashScore,
  slashScoreDiagnostics,
  type SlashScoreKind,
  type SlashScoreOptions,
} from "./src/slashscore";

interface SourceNote {
  part: 0 | 1;
  start: number;
  end: number;
  pitch: number;
}

interface Attack {
  part: number;
  start: number;
  pitch: number;
}

const EPSILON = 1e-8;
const marker = "\u2063";
const failures: string[] = [];
let checks = 0;

function check(name: string, action: () => void): void {
  try {
    action();
    checks++;
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fixture(notes: SourceNote[], title: string): ParsedMidi {
  const ppq = 960;
  return {
    format: 1, ppq, trackCount: 3, title,
    tracks: [
      { index: 0, name: "Conductor", noteCount: 0 },
      { index: 1, name: "Right Hand", noteCount: notes.filter(note => note.part === 0).length },
      { index: 2, name: "Left Hand", noteCount: notes.filter(note => note.part === 1).length },
    ],
    notes: notes.map(note => ({
      startTick: Math.round(note.start * ppq),
      endTick: Math.round(note.end * ppq),
      pitch: note.pitch, velocity: 100, channel: note.part, track: note.part + 1,
    })),
    tempos: [{ tick: 0, bpm: 114 }],
    timeSignatures: [{ tick: 0, beats: 4, beatType: 4 }],
    keySignatures: [{ tick: 0, fifths: 0, minor: false }],
    ignoredEvents: 0, endTick: Math.ceil(Math.max(...notes.map(note => note.end)) / 4) * 4 * ppq,
  };
}

function sortedAttacks(notes: Attack[]): Attack[] {
  return [...notes].sort((left, right) => left.start - right.start
    || left.part - right.part || left.pitch - right.pitch);
}

function assertAttacks(actual: Attack[], expected: Attack[], label: string): void {
  const left = sortedAttacks(actual), right = sortedAttacks(expected);
  assert.equal(left.length, right.length, `${label}: duplicate or missing note attacks`);
  for (let index = 0; index < right.length; index++) {
    const actualNote = left[index]!, expectedNote = right[index]!;
    assert.equal(actualNote.part, expectedNote.part, `${label}: wrong voice at ${expectedNote.start}`);
    assert.equal(actualNote.pitch, expectedNote.pitch, `${label}: wrong pitch at ${expectedNote.start}`);
    assert(Math.abs(actualNote.start - expectedNote.start) < EPSILON,
      `${label}: ${expectedNote.pitch} starts at ${actualNote.start}, expected ${expectedNote.start}`);
  }
}

function importText(
  parsed: ParsedMidi,
  kind: SlashScoreKind,
  showExplicitRests = true,
  overrides: Partial<MidiImportOptions> = {},
) {
  const analysis = analyzeMidi(parsed);
  const importOptions: MidiImportOptions = {
    outputFormat: kind,
    quantize: 16, detectTriplets: true, handMode: "auto", splitPitch: analysis.splitPitch,
    fifths: 0, beats: 4, beatType: 4, tempoBpm: 114, scoreMode: "hands",
    ...overrides,
  };
  const imported = midiToScore(parsed, importOptions);
  const score = imported.score;
  const modes = {
    braceMode: "arpeggio", bracketMode: "triplet", barMode: "none",
    angleMode: "grace", parenMode: "chord", ordering: "pitch-asc",
  } as const;
  const division = Math.min(64, importOptions.quantize) as 4 | 8 | 16 | 32 | 64;
  const raw = scoreToSlashScore(score, kind, division, ".", {
    sourceMidi: parsed, ...modes, showExplicitRests,
  }, score.parts.length);
  const slashOptions: SlashScoreOptions = {
    ...defaultSlashScoreOptions(kind, analyzeSlashScore(raw)),
    ...modes,
    voiceCount: score.parts.length, showExplicitRests,
    instrumentName: score.instrumentName.trim() || score.parts[0]?.instrumentName.trim() || "钢琴",
    title: score.title, subtitle: score.subtitle, composer: score.composer,
    arranger: score.arranger, lyricist: score.lyricist,
    tempoBpm: score.tempoBpm, tempoBeatUnit: score.tempoBeatUnit,
    fifths: importOptions.fifths, beats: importOptions.beats, beatType: importOptions.beatType,
    tempoMarks: score.tempoMarks.map(mark => ({
      measure: mark.measure, offset: mark.offset.toFloat(), kind: mark.kind, bpm: mark.bpm,
    })),
  };
  // This is App._applyImportedSlash followed by the real editable document
  // boundary. Testing raw generated text alone misses metadata interactions.
  const embedded = embedSlashScoreOptionsFromScore(raw, score, slashOptions);
  const editable = parseEditableDocument(embedded, kind, slashOptions);
  assert(editable && editable.slashOptions, "imported editable document must parse");
  const replay = parseSlashScore(embedded, editable.slashOptions);
  const reopenedOptions = defaultSlashScoreOptions(kind, analyzeSlashScore(embedded));
  const reopened = parseSlashScore(embedded, reopenedOptions);
  return { importedScore: score, raw, embedded, slashOptions, editable, replay, reopened };
}

const cases: Array<{
  name: string;
  notes: SourceNote[];
  from: number;
  to: number;
  sustains?: SourceNote[];
}> = [
  {
    name: "triplet above a dotted eighth and sixteenth",
    from: 3, to: 4,
    notes: [
      { part: 0, start: 0, end: 3, pitch: 60 },
      { part: 1, start: 0, end: 3, pitch: 48 },
      { part: 0, start: 3, end: 10 / 3, pitch: 67 },
      { part: 0, start: 10 / 3, end: 11 / 3, pitch: 72 },
      { part: 0, start: 11 / 3, end: 4, pitch: 74 },
      { part: 1, start: 3, end: 3.75, pitch: 53 },
      { part: 1, start: 3.75, end: 4, pitch: 62 },
    ],
  },
  {
    name: "three triplet attacks split across the hands",
    from: 2, to: 3,
    notes: [
      { part: 0, start: 0, end: 2, pitch: 72 },
      { part: 1, start: 0, end: 2, pitch: 48 },
      { part: 1, start: 2, end: 7 / 3, pitch: 55 },
      { part: 0, start: 7 / 3, end: 8 / 3, pitch: 60 },
      { part: 0, start: 8 / 3, end: 3, pitch: 62 },
      { part: 0, start: 3, end: 4, pitch: 67 },
      { part: 1, start: 3, end: 4, pitch: 50 },
    ],
  },
  {
    name: "previous lower chord sustains into a triplet beat",
    from: 1.5, to: 3,
    notes: [
      { part: 0, start: 0, end: 1.5, pitch: 60 },
      { part: 0, start: 1.5, end: 2, pitch: 62 },
      { part: 1, start: 0, end: 1.5, pitch: 48 },
      { part: 1, start: 1.5, end: 8 / 3, pitch: 50 },
      { part: 1, start: 1.5, end: 8 / 3, pitch: 55 },
      { part: 0, start: 2, end: 7 / 3, pitch: 57 },
      { part: 0, start: 7 / 3, end: 8 / 3, pitch: 59 },
      { part: 0, start: 8 / 3, end: 3, pitch: 60 },
      { part: 1, start: 8 / 3, end: 3, pitch: 53 },
      { part: 0, start: 3, end: 4, pitch: 62 },
      { part: 1, start: 3, end: 4, pitch: 55 },
    ],
    sustains: [
      { part: 1, start: 1.5, end: 8 / 3, pitch: 50 },
      { part: 1, start: 1.5, end: 8 / 3, pitch: 55 },
    ],
  },
  {
    name: "default lower voice triplet below an upper rest",
    from: 1, to: 2,
    notes: [
      { part: 0, start: 0, end: 1, pitch: 60 },
      { part: 1, start: 0, end: 1, pitch: 48 },
      { part: 1, start: 1, end: 4 / 3, pitch: 53 },
      { part: 1, start: 4 / 3, end: 5 / 3, pitch: 48 },
      { part: 1, start: 5 / 3, end: 2, pitch: 50 },
      { part: 1, start: 2, end: 4, pitch: 55 },
    ],
  },
];

for (const item of cases) for (const kind of ["keyboard", "number"] as const) {
  for (const explicitRests of [true, false]) {
    const label = `${item.name}; ${kind}; explicit rests=${explicitRests}`;
    check(label, () => {
      const converted = importText(fixture(item.notes, item.name), kind, explicitRests);
      assert.deepEqual(converted.editable.slashTimingDiagnostics.filter(d => d.severity === "error"), [], label);
      assert.equal(converted.replay.summary.clippedGroups, 0, `${label}: parser truncated a beat`);
      assert.deepEqual(converted.reopened.summary.diagnostics.filter(d => d.severity === "error"), [], `${label}: reopen`);
      const expected = item.notes.filter(note => note.start >= item.from - EPSILON && note.start < item.to - EPSILON);
      for (const [phase, score] of [["UI import", converted.editable.score], ["TXT reopen", converted.reopened.score]] as const) {
        const timeline = buildTimeline(score);
        const actual = timeline.notes.filter(note => note.t0 >= item.from - EPSILON && note.t0 < item.to - EPSILON)
          .map(note => ({ part: note.part, start: note.t0, pitch: note.pitch }));
        assertAttacks(actual, expected, `${label}: ${phase}`);
        for (const sustain of item.sustains ?? []) {
          const actualSustain = timeline.notes.find(note => note.part === sustain.part
            && note.pitch === sustain.pitch && Math.abs(note.t0 - sustain.start) < EPSILON);
          assert(actualSustain && Math.abs(actualSustain.t1 - sustain.end) < EPSILON,
            `${label}: ${phase}: held ${sustain.pitch} must last until ${sustain.end}`);
        }
        if (explicitRests && item === cases[1]) {
          const preceding = timeline.notes.find(note => note.part === 0 && note.pitch === 72
            && Math.abs(note.t0) < EPSILON);
          assert(preceding && Math.abs(preceding.t1 - 2) < EPSILON,
            `${label}: ${phase}: the upper rest in the cross-hand tuplet must stop the preceding 72 at 2`);
        }
      }
    });
  }
}

// The same source file can be imported with triplet recognition disabled.
// Its ordinary quantized attacks must not be filtered against a separate,
// freshly detected triplet clock during text export.
for (const kind of ["keyboard", "number"] as const) {
  for (const quantize of [16, 32, 64] as const) {
    for (const detectTriplets of [false, true]) {
      const label = `triplet toggle=${detectTriplets}; ${kind}; quantize=${quantize}`;
      check(label, () => {
        const item = cases[1]!;
        const converted = importText(fixture(item.notes, item.name), kind, true, {
          quantize, detectTriplets,
        });
        assert.deepEqual(converted.editable.slashTimingDiagnostics.filter(d => d.severity === "error"), [], label);
        assert.equal(converted.replay.summary.clippedGroups, 0, label);
        const expected = buildTimeline(converted.importedScore).notes
          .filter(note => note.t0 >= item.from - EPSILON && note.t0 < item.to - EPSILON)
          .map(note => ({ part: note.part, start: note.t0, pitch: note.pitch }));
        assert.equal(expected.length, 3, `${label}: reference score has three source attacks`);
        for (const [phase, score] of [["UI import", converted.editable.score], ["TXT reopen", converted.reopened.score]] as const) {
          const actual = buildTimeline(score).notes
            .filter(note => note.t0 >= item.from - EPSILON && note.t0 < item.to - EPSILON)
            .map(note => ({ part: note.part, start: note.t0, pitch: note.pitch }));
          assertAttacks(actual, expected, `${label}: ${phase}`);
        }
        if (!detectTriplets) {
          assert(!converted.raw.includes("["), `${label}: disabled recognition must not restore triplet brackets`);
        }
      });
    }
  }
}

// Collapsing both hands to one voice leaves four distinct rhythmic attack
// columns inside the beat (0, 1/3, 2/3, 3/4). A one-voice serializer must
// preserve that union, including the fourth attack, through its text grammar.
for (const kind of ["keyboard", "number"] as const) {
  check(`single voice with straight/triplet overlap: ${kind}`, () => {
    const item = cases[0]!;
    const converted = importText(fixture(item.notes, item.name), kind, true, {
      handMode: "single",
    });
    assert.equal(converted.editable.score.parts.length, 1);
    assert.deepEqual(converted.editable.slashTimingDiagnostics.filter(d => d.severity === "error"), []);
    assert.equal(converted.replay.summary.clippedGroups, 0);
    const expected = item.notes
      .filter(note => note.start >= item.from - EPSILON && note.start < item.to - EPSILON)
      .map(note => ({ part: 0, start: note.start, pitch: note.pitch }));
    for (const [phase, score] of [["UI import", converted.editable.score], ["TXT reopen", converted.reopened.score]] as const) {
      const actual = buildTimeline(score).notes
        .filter(note => note.t0 >= item.from - EPSILON && note.t0 < item.to - EPSILON)
        .map(note => ({ part: note.part, start: note.t0, pitch: note.pitch }));
      assertAttacks(actual, expected, `${kind}: ${phase}: single voice overlap`);
    }
  });
}

// At the supported 64th-note import grid, a straight attack can fall one
// 192nd-note interval after a triplet member. The generated spelling must
// represent its half-cell nominal value without an unsupported directive.
for (const kind of ["keyboard", "number"] as const) {
  check(`single voice finest-grid straight/triplet overlap: ${kind}`, () => {
    const item = cases[0]!;
    const notes = item.notes.map(note => ({
      ...note,
      start: note.start === 3.75 ? 3.6875 : note.start,
      end: note.end === 3.75 ? 3.6875 : note.end,
    }));
    const converted = importText(fixture(notes, item.name), kind, true, {
      quantize: 64, handMode: "single",
    });
    const rawAnalysis = analyzeSlashScore(converted.raw);
    assert.equal(rawAnalysis.suggestedMappings["="], 128, "readable fine-duration directive must be retained");
    assert.equal(converted.editable.slashOptions!.symbolDurations["="], 128, "UI metadata must preserve the fine value");
    const reopenedAnalysis = analyzeSlashScore(converted.embedded);
    assert.equal(reopenedAnalysis.suggestedMappings["="], 128, "TXT reopen must preserve the fine value");
    const rawParsed = parseSlashScore(converted.raw, defaultSlashScoreOptions(kind, rawAnalysis));
    assert.deepEqual(rawParsed.summary.diagnostics.filter(d => d.severity === "error"), []);
    assert.equal(rawParsed.summary.clippedGroups, 0);
    assert.deepEqual(converted.editable.slashTimingDiagnostics.filter(d => d.severity === "error"), []);
    assert.equal(converted.replay.summary.clippedGroups, 0);
    assert.deepEqual(converted.reopened.summary.diagnostics.filter(d => d.severity === "error"), []);
    const expected = notes
      .filter(note => note.start >= item.from - EPSILON && note.start < item.to - EPSILON)
      .map(note => ({ part: 0, start: note.start, pitch: note.pitch }));
    for (const [phase, score] of [["raw TXT", rawParsed.score], ["UI import", converted.editable.score], ["TXT reopen", converted.reopened.score]] as const) {
      const timeline = buildTimeline(score);
      const actual = timeline.notes
        .filter(note => note.t0 >= item.from - EPSILON && note.t0 < item.to - EPSILON)
        .map(note => ({ part: note.part, start: note.t0, pitch: note.pitch }));
      assertAttacks(actual, expected, `${kind}: ${phase}: finest-grid single voice overlap`);
      const last = timeline.notes.find(note => note.pitch === 62 && Math.abs(note.t0 - 3.6875) < EPSILON);
      assert(last && Math.abs(last.t1 - 4) < EPSILON,
        `${kind}: ${phase}: final attack must retain the remainder of the beat`);
    }
  });
}

// The humanized middle member of a quarter-note triplet can also resemble
// the middle of a finer global group formed by another hand. The actual
// locally adopted clock must win over that overlapping global candidate.
for (const kind of ["keyboard", "number"] as const) {
  check(`local tuplet wins over conflicting global source; ${kind}`, () => {
    const parsed = fixture([
      { part: 0, start: 0, end: 331 / 480, pitch: 72 },
      { part: 0, start: 331 / 480, end: 4 / 3, pitch: 74 },
      { part: 0, start: 4 / 3, end: 2, pitch: 76 },
      { part: 1, start: 5 / 8, end: 17 / 24, pitch: 48 },
      { part: 1, start: 19 / 24, end: 7 / 8, pitch: 50 },
    ], "conflicting local and global tuplets");
    const converted = importText(parsed, kind, true, { quantize: 32, handMode: "double" });
    const accepted = importedMidiSlashGestures(converted.importedScore, parsed);
    assert(accepted, "the imported score must retain its adopted gesture decisions");
    assert.equal(accepted.triplet.length, 1, "reject the competing finer global group");
    assert.equal(accepted.triplet[0]!.division, 4);
    // Independent oracle: RH keeps the quarter-triplet; LH uses the ordinary
    // 32nd grid after its competing global candidate has been rejected.
    const expected = [
      { part: 0, pitch: 72, start: 0, end: 2 / 3 },
      { part: 0, pitch: 74, start: 2 / 3, end: 4 / 3 },
      { part: 0, pitch: 76, start: 4 / 3, end: 2 },
      { part: 1, pitch: 48, start: 5 / 8, end: 3 / 4 },
      { part: 1, pitch: 50, start: 3 / 4, end: 7 / 8 },
    ];
    for (const [phase, score] of [
      ["MIDI quantization", converted.importedScore],
      ["UI import", converted.editable.score],
      ["TXT reopen", converted.reopened.score],
    ] as const) {
      const timeline = buildTimeline(score);
      assertAttacks(timeline.notes.map(note => ({
        part: note.part, pitch: note.pitch, start: note.t0,
      })), expected, `${kind}: ${phase}: conflicting local/global clocks`);
      // MIDI quantization owns release placement. The existing TXT source
      // exporter extends a final staccato over trailing rests; that separate
      // baseline limitation is outside this attack-clock regression.
      if (phase === "MIDI quantization") {
        for (const note of expected) {
          const actual = timeline.notes.find(item => item.part === note.part && item.pitch === note.pitch);
          assert(actual && Math.abs(actual.t1 - note.end) < EPSILON,
            `${kind}: ${phase}: ${note.pitch} must release at ${note.end}, got ${actual?.t1}`);
        }
      }
    }
  });
}

function timingErrors(group: string): string[] {
  const text = `键盘谱\n4/4拍：\n. = 16分音符\n方括号 = 三连音\nQ..../${group}/Q..../Q..../\n`;
  const options = defaultSlashScoreOptions("keyboard", analyzeSlashScore(text));
  options.voiceCount = 2;
  return slashScoreDiagnostics(text, options).filter(d => d.severity === "error").map(d => d.message);
}

check("diagnostic: genuine short and long ordinary beats", () => {
  assert.match(timingErrors("[A.B.C.].")[0] ?? "", /只有/);
  assert.match(timingErrors("[A.B.C.]...")[0] ?? "", /超过/);
});
check("diagnostic: a parallel tuplet cannot hide ordinary overfill", () => {
  const overlay = `[${marker}G..${marker}Q..${marker}W..]`;
  assert.deepEqual(timingErrors(`${overlay}V...S.`), []);
  assert.match(timingErrors(`${overlay}V...S..`)[0] ?? "", /超过/);
});
check("diagnostic: legal cross-beat voice tuplets stay legal", () => {
  const overlay = `[${marker}G....${marker}Q....${marker}W....]`;
  assert.deepEqual(timingErrors(`${overlay}V....`), []);
  assert.match(timingErrors(`${overlay}V.....`)[0] ?? "", /超过/);
});

// Optional real MIDI: pass its path as the first CLI argument. The checked
// windows reproduce the user's four failing beats, the nearby held chord,
// and per-hand tuplets absent from the global gesture detector. Each must
// retain its source attacks through both the UI import and TXT reopen.
if (process.argv[2]) {
  const parsed = parseMidi(new Uint8Array(await readFile(process.argv[2])));
  for (const kind of ["keyboard", "number"] as const) {
    check(`attached MIDI full import: ${kind}`, () => {
      const converted = importText(parsed, kind);
      assert.deepEqual(converted.editable.slashTimingDiagnostics.filter(d => d.severity === "error"), []);
      assert.equal(converted.replay.summary.clippedGroups, 0);
      assert.deepEqual(converted.reopened.summary.diagnostics.filter(d => d.severity === "error"), []);
      for (const score of [converted.editable.score, converted.reopened.score]) {
        const timeline = buildTimeline(score);
        const preceding = timeline.notes.find(note => note.part === 0 && note.pitch === 79
          && Math.abs(note.t0 - 32) < EPSILON);
        assert(preceding && Math.abs(preceding.t1 - 34) < EPSILON,
          `attached MIDI ${kind}: the preceding upper G5 must stop at 34, got ${preceding?.t1}`);
        for (const [start, end] of [[31, 31.8], [34, 35], [271, 272], [339, 340], [378, 380], [445, 446]]) {
          const expected = parsed.notes.filter(note => note.startTick / parsed.ppq >= start - EPSILON
            && note.startTick / parsed.ppq < end - EPSILON)
            .map(note => ({ part: note.track - 1, start: note.startTick / parsed.ppq, pitch: note.pitch }));
          const actual = timeline.notes.filter(note => note.t0 >= start - EPSILON && note.t0 < end - EPSILON)
            .map(note => ({ part: note.part, start: note.t0, pitch: note.pitch }));
          assertAttacks(actual, expected, `attached MIDI ${kind} @ ${start}..${end}`);
        }
      }
    });
  }
}

if (failures.length) {
  console.error(failures.join("\n\n"));
  throw new Error(`midi-triplet-import-check: ${failures.length} failed, ${checks} passed`);
}
console.log(`midi-triplet-import-check: ${checks} checks passed`);
