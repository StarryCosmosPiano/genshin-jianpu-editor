import assert from "node:assert/strict";
import { Chord, Score } from "./src/score/score";
import {
  analyzeSlashScore,
  clearSlashDelimiters,
  defaultSlashScoreOptions,
  embedSlashScoreOptionsFromScore,
  parseSlashScore,
  scoreToSlashScore,
  slashScoreDiagnostics,
  type SlashScoreOptions,
} from "./src/slashscore";

const header = "键盘谱\n4/4拍：\n点=16分音符\n方括号=三连音\n圆括号=和弦\n";
const options: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard"),
  voiceCount: 1,
  beats: 4,
  beatType: 4,
  noteDivision: 16,
  spaceDivision: 16,
  symbolDurations: { ".": 16 },
  bracketMode: "triplet",
  parenMode: "chord",
  showExplicitRests: true,
};

// Every fixture supplies four complete beats. This keeps automatic filling of
// an unfinished slash group from hiding a wrong intrinsic container duration.
const source = (firstBeat: string, intrinsic = true): string => header + firstBeat
  + (intrinsic ? "/Q   /W   /E   /\n" : "/Q..../W..../E..../\n");
const errors = (text: string, notation = options): string[] => slashScoreDiagnostics(text, notation)
  .filter((item) => item.severity === "error").map((item) => item.message);
const chords = (score: Score): Chord[] => score.parts[0]!.measures[0]!.entries
  .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest
    && !entry.generatedTimingContinuation)
  .sort((left, right) => left.position.compareTo(right.position));
const firstBeatChords = (score: Score): Chord[] => chords(score)
  .filter((chord) => chord.position.toFloat() < 1 - 1e-8);
const close = (actual: number | undefined, expected: number, message: string): void => {
  assert(actual !== undefined && Math.abs(actual - expected) < 1e-8,
    `${message}: expected ${expected}, got ${actual}`);
};
const state = (score: Score): unknown => score.parts.map((part) => part.measures.map((measure) =>
  measure.entries.filter((entry): entry is Chord => entry instanceof Chord).map((chord) => ({
    at: Number(chord.position.toFloat().toFixed(8)),
    duration: Number(chord.duration?.toFloat().toFixed(8)),
    rest: chord.rest,
    pitches: chord.notes.filter((note) => !note.rest).map((note) => note.pitch).sort((a, b) => a - b),
    tuplet: chord.notes.some((note) => note.tuplet !== null),
  }))));

function parse(firstBeat: string, notation = options): Score {
  const text = source(firstBeat, notation.noteDivision !== null);
  assert.deepEqual(errors(text, notation), [], `${firstBeat}: timing diagnostics`);
  return parseSlashScore(text, notation).score;
}

function assertMembers(score: Score, durations: number[], noteCounts: number[] = durations.map(() => 1)): void {
  const members = firstBeatChords(score).slice(0, durations.length);
  assert.equal(members.length, durations.length, "a bracket member disappeared");
  let position = 0;
  members.forEach((member, index) => {
    close(member.position.toFloat(), position, `member ${index + 1} onset`);
    close(member.duration?.toFloat(), durations[index]!, `member ${index + 1} duration`);
    assert.equal(member.notes.filter((note) => !note.rest).length, noteCounts[index],
      `member ${index + 1} chord pitches`);
    position += durations[index]!;
  });
  close(members.at(-1)!.position.plus(members.at(-1)!.duration!).toFloat(), position, "container end");
}

const failures: string[] = [];
let checks = 0;
function check(name: string, run: () => void): void {
  checks++;
  try { run(); }
  catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

check("one intrinsic sixteenth for the complete triplet", () => {
  const score = parse("[QWE]ASD");
  assertMembers(score, [1 / 12, 1 / 12, 1 / 12]);
  assert.equal(firstBeatChords(score).length, 6);
  close(firstBeatChords(score)[3]!.position.toFloat(), 1 / 4, "next ordinary note onset");
});

check("ordinary notes retain the same intrinsic unit", () => {
  const score = parse("QWEA");
  assertMembers(score, [1 / 4, 1 / 4, 1 / 4, 1 / 4]);
});

for (const suffix of [".", " "]) {
  check(`outside ${suffix === "." ? "duration symbol" : "space"} extends the complete bracket`, () => {
    const score = parse(`[QWE]${suffix}AS`);
    assertMembers(score, [1 / 6, 1 / 6, 1 / 6]);
    close(firstBeatChords(score)[3]!.position.toFloat(), 1 / 2, "next ordinary note onset");
  });
}

check("mixed outside extensions accumulate on the complete bracket", () => {
  const score = parse("[QWE]. A");
  assertMembers(score, [1 / 4, 1 / 4, 1 / 4]);
  close(firstBeatChords(score)[3]!.position.toFloat(), 3 / 4, "next ordinary note onset");
});

check("inside explicit values remain relative member weights", () => {
  const score = parse("[Q.WE]ASD");
  assertMembers(score, [1 / 8, 1 / 16, 1 / 16]);
  close(firstBeatChords(score)[3]!.position.toFloat(), 1 / 4, "weighted container end");
});

check("three members include a simultaneous chord", () => {
  const score = parse("[SJ(BW)]ASD");
  assertMembers(score, [1 / 12, 1 / 12, 1 / 12], [1, 1, 2]);
  assert.equal(firstBeatChords(score).length, 6);
});

check("four written positions share one intrinsic container unit", () => {
  const score = parse("[DHQ(VW)]ASD");
  assertMembers(score, [1 / 16, 1 / 16, 1 / 16, 1 / 16], [1, 1, 1, 2]);
  assert.equal(firstBeatChords(score).length, 7, "fourth written position was lost or merged");
  close(firstBeatChords(score)[4]!.position.toFloat(), 1 / 4, "four-position container end");
});

const legacyOptions: SlashScoreOptions = { ...options, noteDivision: null, spaceDivision: null };
check("legacy marker-only bracket keeps its original three-to-two timing", () => {
  const score = parse("[Q.W.E.]..", legacyOptions);
  assertMembers(score, [1 / 6, 1 / 6, 1 / 6]);
  // In the legacy model outer dots create an ordinary tied continuation of
  // the final member, rather than rescaling the bracket's three members.
  const continuation = score.parts[0]!.measures[0]!.entries.find((entry) =>
    entry instanceof Chord && entry.generatedTimingContinuation) as Chord | undefined;
  assert(continuation, "legacy trailing continuation disappeared");
  close(continuation.position.toFloat(), 1 / 2, "legacy continuation onset");
  close(continuation.duration?.toFloat(), 1 / 2, "legacy continuation duration");
});

for (const first of ["[QWE]ASD", "[Q.WE]ASD", "[SJ(BW)]ASD", "[DHQ(VW)]ASD", "[QWE].AS"]) {
  check(`metadata round trip ${first}`, () => {
    let score = parse(first);
    const expected = state(score);
    for (let cycle = 0; cycle < 2; cycle++) {
      const text = embedSlashScoreOptionsFromScore(scoreToSlashScore(score, "keyboard", 16, ".", {
        ...options, durationNotation: options, preserveExplicitRestMeasures: [0],
      }, 1), score, options);
      const reopenedOptions = defaultSlashScoreOptions("keyboard", analyzeSlashScore(text));
      assert.equal(reopenedOptions.noteDivision, 16, "intrinsic unit was not saved");
      assert.deepEqual(errors(text, reopenedOptions), [], `cycle ${cycle}: ${text}`);
      score = parseSlashScore(text, reopenedOptions).score;
      assert.deepEqual(state(score), expected, `cycle ${cycle}: ${text}`);
    }
  });
}

check("persisted explicit tuplet timing takes precedence over the intrinsic default", () => {
  // Persisted members are the original written 3:2 values. Their explicit
  // half-beat span remains authoritative even with an intrinsic sixteenth.
  const explicitOptions: SlashScoreOptions = { ...options, annotations: [{
    type: "triplet", part: 0, voice: 1, measure: 0, offset: 0,
    scope: "voice", end: 0.5, members: [0.25, 0.25, 0.25],
    memberRests: [false, false, false], restoreUnit: 0.5,
  }] };
  const originalText = source("[QWE]A.");
  assert.deepEqual(errors(originalText, explicitOptions), []);
  const original = parseSlashScore(originalText, explicitOptions).score;
  assertMembers(original, [1 / 6, 1 / 6, 1 / 6]);
  const expected = state(original);
  const text = embedSlashScoreOptionsFromScore(scoreToSlashScore(original, "keyboard", 16, ".", {
    ...options, durationNotation: options, preserveExplicitRestMeasures: [0],
  }, 1), original, options);
  const savedOptions = defaultSlashScoreOptions("keyboard", analyzeSlashScore(text));
  assert.equal(savedOptions.noteDivision, 16);
  assert(savedOptions.annotations?.some((annotation) => annotation.type === "triplet"
    && annotation.members && annotation.end === 0.5), "explicit original tuplet timing was not persisted");
  assert.deepEqual(errors(text, savedOptions), []);
  const restored = parseSlashScore(text, savedOptions).score;
  assertMembers(restored, [1 / 6, 1 / 6, 1 / 6]);
  assert.deepEqual(state(restored), expected, text);
});

check("sample beat diagnosis uses the complete bracket intrinsic duration", () => {
  assert.deepEqual(errors(source("Q  [DHQ(VW)]")), []);
  assert(errors(source("Q [DHQ(VW)]")).some((message) => message.includes("只有")),
    "a missing space must produce a short-beat diagnostic");
  assert(errors(source("Q   [DHQ(VW)]")).some((message) => message.includes("超过")),
    "an extra space must produce an overfull-beat diagnostic");
});

check("shorter imported group uses explicit timing when the intrinsic unit becomes coarser", () => {
  const savedNotation: SlashScoreOptions = { ...options, spaceDivision: null,
    symbolDurations: { ".": 32 } };
  const originalNotation: SlashScoreOptions = { ...savedNotation, noteDivision: 32 };
  let score = parseSlashScore("[WER]0....../A......./S......./D......./", originalNotation).score;
  const expected = state(score);
  for (let cycle = 0; cycle < 2; cycle++) {
    const text = embedSlashScoreOptionsFromScore(scoreToSlashScore(score, "keyboard", 32, ".", {
      durationNotation: savedNotation, showExplicitRests: true,
    }, 1), score, savedNotation);
    const reopened = defaultSlashScoreOptions("keyboard", analyzeSlashScore(text));
    assert(reopened.annotations?.some((annotation) => annotation.type === "triplet"
      && annotation.scope === "all" && annotation.end === 1 / 8), "short-group metadata was lost");
    assert.deepEqual(errors(text, reopened), []);
    score = parseSlashScore(text, reopened).score;
    assert.deepEqual(state(score), expected, text);
  }
});

check("external tied continuation retains its original all-voice bracket timing", () => {
  const originalNotation: SlashScoreOptions = { ...options, spaceDivision: null, annotations: [{
    type: "triplet", part: 0, voice: 1, measure: 0, offset: 0,
    scope: "all", end: 1 / 2, members: [1 / 4, 1 / 4, 1 / 4],
  }] };
  let score = parseSlashScore("[WER]../A.../S.../D.../", originalNotation).score;
  const expected = state(score);
  const ties = (value: Score): unknown => value.parts.map((part) => part.measures.map((measure) =>
    measure.entries.filter((entry): entry is Chord => entry instanceof Chord).map((chord) =>
      chord.notes.map((note) => [Boolean(note.tiePrev), Boolean(note.tieNext)]))));
  const expectedTies = ties(score);
  assert(chords(score).some((chord) => chord.notes.some((note) => note.tieNext)), "fixture has no external tie");
  for (let cycle = 0; cycle < 2; cycle++) {
    const text = embedSlashScoreOptionsFromScore(scoreToSlashScore(score, "keyboard", 16, ".", {
      durationNotation: options, showExplicitRests: true,
    }, 1), score, options);
    const reopened = defaultSlashScoreOptions("keyboard", analyzeSlashScore(text));
    assert(reopened.annotations?.some((annotation) => annotation.type === "triplet"
      && annotation.scope === "all" && annotation.end === 1 / 2), "external-tail timing was lost");
    assert.deepEqual(errors(text, reopened), []);
    score = parseSlashScore(text, reopened).score;
    assert.deepEqual(state(score), expected, text);
    assert.deepEqual(ties(score), expectedTies, text);
  }
});

check("clearing an intrinsic triplet restores its ordinary written member values", () => {
  // Leave room for the ordinary 3:2 expansion before removing the bracket.
  const next: SlashScoreOptions = { ...options, bracketMode: "none", noteDivision: 32,
    symbolDurations: { ".": 32 } };
  const cleared = clearSlashDelimiters(source("[QWE]"), options, next);
  assert.equal(cleared.removed, 1);
  assert(!cleared.text.includes("[QWE]"));
  const restored = firstBeatChords(parseSlashScore(cleared.text, cleared.options).score);
  assert.equal(restored.length, 3);
  const firstOnset = restored[0]!.position.toFloat();
  restored.forEach((chord, index) => {
    close(chord.position.toFloat() - firstOnset, index / 8, "ordinary cleared onset");
    close(chord.duration?.toFloat(), 1 / 8, "ordinary cleared duration");
    assert(chord.notes.every((note) => !note.tuplet), "cleared member still owns a tuplet");
  });
});

check("clearing rejects an intrinsic unit coarser than the restored member", () => {
  const text = source("[QWE]");
  const next: SlashScoreOptions = { ...options, bracketMode: "none" };
  const before = JSON.stringify({ text, options, next });
  assert.throws(() => clearSlashDelimiters(text, options, next), /比音符自身时值更短/);
  assert.equal(JSON.stringify({ text, options, next }), before, "rejected clearing mutated the document");
});

check("explicit single-voice suffix advances the complete intrinsic bracket", () => {
  const score = parse("[\u2063Q\u2063W\u2063E].AS");
  assertMembers(score, [1 / 6, 1 / 6, 1 / 6]);
  close(firstBeatChords(score)[3]!.position.toFloat(), 1 / 2, "explicit single-voice next onset");
});

check("explicit parallel-voice suffix only lengthens its owning bracket", () => {
  const notation: SlashScoreOptions = { ...options, voiceCount: 2 };
  const text = source("[\u2063Q\u2063W\u2063E].ASDF");
  assert.deepEqual(errors(text, notation), []);
  const score = parseSlashScore(text, notation).score;
  assertMembers(score, [1 / 6, 1 / 6, 1 / 6]);
  const lower = score.parts[1]!.measures[0]!.entries
    .filter((entry): entry is Chord => entry instanceof Chord && !entry.rest
      && entry.position.toFloat() < 1 - 1e-8);
  assert.deepEqual(lower.map((chord) => chord.position.toFloat()), [0, 1 / 4, 1 / 2, 3 / 4]);
});

check("leading internal glyph weights the first member within the same bracket budget", () => {
  assertMembers(parse("[.QWE]ASD"), [1 / 8, 1 / 16, 1 / 16]);
});

check("empty brackets leave their following duration glyph on the ordinary timeline", () => {
  for (const empty of ["[]", "[.]"]) {
    const score = parse(`${empty}.QWE`);
    const sounding = firstBeatChords(score);
    assert.equal(sounding.length, 3);
    sounding.forEach((chord, index) => {
      close(chord.position.toFloat(), (index + 1) / 4, "ordinary note after empty bracket");
      close(chord.duration?.toFloat(), 1 / 4, "ordinary note value after empty bracket");
    });
  }
});

check("two explicit parallel brackets match their own voice timing metadata", () => {
  const notation: SlashScoreOptions = { ...options, voiceCount: 2, annotations: [
    { type: "triplet", part: 0, voice: 1, measure: 0, offset: 0, scope: "voice",
      end: 1 / 2, members: [1 / 4, 1 / 4, 1 / 4] },
    { type: "triplet", part: 1, voice: 2, measure: 0, offset: 0, scope: "voice",
      end: 1, members: [1 / 2, 1 / 2, 1 / 2] },
  ] };
  const text = source("[\u2063Q\u2063W\u2063E][\u2063\u2063A.\u2063\u2063S.\u2063\u2063D.]");
  assert.deepEqual(errors(text, notation), []);
  const score = parseSlashScore(text, notation).score;
  for (let voice = 0; voice < 2; voice++) {
    const members = score.parts[voice]!.measures[0]!.entries
      .filter((entry): entry is Chord => entry instanceof Chord
        && entry.notes.some((note) => note.tuplet !== null));
    assert.equal(members.length, 3);
    members.forEach((chord, index) => {
      close(chord.position.toFloat(), index * (voice + 1) / 6, "metadata voice member onset");
      close(chord.duration?.toFloat(), (voice + 1) / 6, "metadata voice member duration");
    });
  }
});

if (failures.length > 0) throw new Error(`triplet-intrinsic-check: ${failures.length}/${checks} failed\n${failures.join("\n\n")}`);
console.log(`triplet-intrinsic-check: ok (${checks} checks)`);
