import assert from "node:assert/strict";
import { Fraction } from "./src/common/fraction";
import { Chord, Part, Score, Tuplet } from "./src/score/score";
import { createInputTriplet, ensureInputMeasure, inputNoteAtCursor } from "./src/score/input-edit";
import { buildTimeline } from "./src/score/timeline";
import {
  analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptionsFromScore,
  parseSlashScore, scoreToSlashScore, type SlashScoreOptions,
} from "./src/slashscore";

// Run: npx esbuild triplet-overlap-dotted-check.ts --bundle --platform=node
//   --format=esm --outfile=triplet-overlap-dotted-check.mjs; node triplet-overlap-dotted-check.mjs
// The JSON report is deliberately written even when cases fail.
import fs from "node:fs";
import path from "node:path";

type Kind = "keyboard" | "number";
type Source = { part: number; at: Fraction; duration: Fraction; pitch: number };
type Task = { part: number; at: Fraction; span: Fraction; source?: "rest" };
type Case = { family: string; relation: string; kind: Kind; sources: Source[]; tasks: Task[];
  order: string; division?: number };
type Failure = { id: string; phase: string; case: unknown; reason: string; before?: string; after?: string;
  expected?: unknown; actual?: unknown };
const f = (n: number, d = 1) => new Fraction(n, d);
const frac = (x: Fraction) => x.toString();
const seed = (kind: Kind) => `${kind === "keyboard" ? "键盘谱" : "数字谱"}\n4/4拍：\n点=16分音符\n`;
const options = (kind: Kind, text: string, division = 16): SlashScoreOptions => ({
  ...defaultSlashScoreOptions(kind, analyzeSlashScore(text)), voiceCount: 2,
  beats: 4, beatType: 4, symbolDurations: { ".": division },
  spaceDivision: null, noteDivision: null, showExplicitRests: true,
  braceMode: "chord", parenMode: "chord", bracketMode: "triplet",
});
const save = (score: Score, kind: Kind, division = 16): string => {
  const opt = options(kind, seed(kind), division);
  return embedSlashScoreOptionsFromScore(scoreToSlashScore(score, kind, division, ".",
    { ...opt, durationNotation: opt, preserveExplicitRestMeasures: [0] }, 2), score, opt);
};
const reopen = (text: string, kind: Kind) => {
  const result = parseSlashScore(text, defaultSlashScoreOptions(kind, analyzeSlashScore(text)));
  return { score: result.score, errors: result.summary.diagnostics.filter((d) => d.severity === "error") };
};
const round = (x: number) => Math.round(x * 1e9) / 1e9;
function snapshot(score: Score) {
  const play = buildTimeline(score);
  const notes = play.notes.map((n) => ({ part: n.part, pitch: n.pitch,
    start: round(n.t0), end: round(n.t1) }))
    .sort((a, b) => a.part - b.part || a.start - b.start || a.pitch - b.pitch || a.end - b.end);
  const tuplets = score.parts.map((part) => {
    const chords = part.measures[0]?.entries.filter((e): e is Chord => e instanceof Chord) ?? [];
    return [...new Set(chords.flatMap((c) => c.notes.map((n) => n.tuplet)
      .filter((t): t is Tuplet => t !== null)))].map((t) => ({
      start: frac(t.actualStart ?? t.first.chord.position),
      end: frac(t.actualEnd ?? t.last.chord.position.plus(t.last.chord.duration ?? f(0))),
      members: t.memberChords().map((c) => ({ at: frac(c.position),
        end: frac(c.position.plus(c.duration ?? f(0))),
        pitches: c.notes.filter((n) => !n.rest).map((n) => n.pitch).sort((a, b) => a - b) })),
    })).sort((a, b) => Fraction.fromString(a.start).compareTo(Fraction.fromString(b.start)));
  });
  const coverage = score.parts.map((part) => {
    const chords = (part.measures[0]?.entries.filter((e): e is Chord => e instanceof Chord) ?? [])
      .sort((a, b) => a.position.compareTo(b.position));
    let cursor = f(0);
    const gaps: string[] = [], overlaps: string[] = [];
    for (const chord of chords) {
      const end = chord.position.plus(chord.duration ?? f(0));
      if (end.compareTo(chord.position) <= 0) continue;
      if (chord.position.compareTo(cursor) > 0) gaps.push(`${cursor}-${chord.position}`);
      if (chord.position.compareTo(cursor) < 0) overlaps.push(`${chord.position}-${cursor}`);
      if (end.compareTo(cursor) > 0) cursor = end;
    }
    if (cursor.compareTo(f(4)) < 0) gaps.push(`${cursor}-4`);
    if (cursor.compareTo(f(4)) > 0) overlaps.push(`4-${cursor}`);
    return { gaps, overlaps, end: frac(cursor) };
  });
  return { duration: round(play.duration), notes, tuplets, coverage };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fixture(c: Case): Score {
  const score = new Score();
  for (let part = 0; part < 2; part++) {
    score.parts.push(new Part());
    score.parts[part]!.voiceIndex = part + 1;
    ensureInputMeasure(score, part, 0);
  }
  for (const s of c.sources) {
    const edit = inputNoteAtCursor(score,
      { partIndex: s.part, measureIndex: 0, offset: s.at, division: c.division ?? 16, lane: "rest" },
      { pitch: s.pitch, number: s.part === 0 ? "1" : "5" }, s.duration);
    assert(edit.changed, `source insertion refused V${s.part + 1} ${s.at}/${s.duration}`);
  }
  return score;
}
function validSource(score: Score, c: Case): boolean {
  const snap = snapshot(score);
  if (snap.duration !== 4 || snap.tuplets.some((t) => t.length)) return false;
  if (snap.notes.length !== c.sources.length) return false;
  return c.sources.every((s) => snap.notes.some((n) => n.part === s.part && n.pitch === s.pitch
    && n.start === round(s.at.toFloat()) && n.end === round(s.at.plus(s.duration).toFloat())));
}
function expectedRange(score: Score, task: Task): boolean {
  const tuples = snapshot(score).tuplets[task.part]!;
  const target = tuples.find((t) => t.start === frac(task.at)
    && t.end === frac(task.at.plus(task.span)));
  const unit = task.span.divInt(3);
  return !!target && target.members.length === 3 && target.members.every((m, i) =>
    m.at === frac(task.at.plus(unit.timesInt(i)))
    && m.end === frac(task.at.plus(unit.timesInt(i + 1))));
}
function fillMembers(score: Score, tasks: Task[]): string | null {
  for (const task of tasks) for (const index of task.source === "rest" ? [0, 1, 2] : [1, 2]) {
    const offset = task.at.plus(task.span.divInt(3).timesInt(index));
    const pitch = task.part === 0 ? 60 + index * 2 : 67 + index * 2;
    const edit = inputNoteAtCursor(score,
      { partIndex: task.part, measureIndex: 0, offset, division: 16, lane: "rest" },
      { pitch, number: String(index + (task.part === 0 ? 1 : 5)) }, task.span.divInt(3));
    if (!edit.changed || !edit.note?.tuplet) return `member fill refused V${task.part + 1} at ${offset}`;
  }
  return null;
}
const reportDir = path.join("artifacts", "triplet-fix-20261006");
const failures: Failure[] = [];
const counts: Record<string, number> = {};
const skipped: Record<string, number> = {};
const coverage: Record<string, number> = {};
let total = 0;
function record(phase: string) { counts[phase] = (counts[phase] ?? 0) + 1; }
function skip(reason: string) { skipped[reason] = (skipped[reason] ?? 0) + 1; }
function run(c: Case) {
  const id = `${c.family}-${++total}`;
  const label = { ...c, sources: c.sources.map((s) => ({ ...s, at: frac(s.at), duration: frac(s.duration) })),
    tasks: c.tasks.map((t) => ({ ...t, at: frac(t.at), span: frac(t.span) })) };
  let before = "", after = "";
  const fail = (phase: string, reason: string, expected?: unknown, actual?: unknown) => {
    failures.push({ id, phase, case: label, reason, before, after, expected, actual });
    record(phase);
  };
  try {
    let score = fixture(c);
    if (!validSource(score, c)) { skip("built-source"); return; }
    // A note inserted across its own beat can become tied segments. Creating
    // from the first segment is a different operation, so omit that candidate.
    if (c.tasks.some((task) => {
      if (task.source === "rest") return false;
      const chord = score.parts[task.part]!.measures[0]!.entries.find((e) =>
        e instanceof Chord && !e.rest && e.position.equals(task.at)) as Chord | undefined;
      const source = c.sources.find((s) => s.part === task.part && s.at.equals(task.at));
      return !chord || !source || !chord.duration?.equals(source.duration);
    })) { skip("split-source"); return; }
    before = save(score, c.kind, c.division);
    const control = reopen(before, c.kind);
    if (control.errors.length || !validSource(control.score, c)
      || !same(snapshot(score), snapshot(control.score))) {
      skip("no-op-control"); return;
    }
    score = control.score;
    if (c.tasks.some((task) => {
      if (task.source === "rest") return false;
      const chord = score.parts[task.part]!.measures[0]!.entries.find((e) =>
        e instanceof Chord && !e.rest && e.position.equals(task.at)) as Chord | undefined;
      const source = c.sources.find((s) => s.part === task.part && s.at.equals(task.at));
      return !chord || !source || !chord.duration?.equals(source.duration);
    })) { skip("split-after-control"); return; }
    for (const task of c.tasks) {
      const key = `${c.family}/${c.kind}/${task.span}/${c.relation}/${task.part + 1}`;
      coverage[key] = (coverage[key] ?? 0) + 1;
    }
    for (const [step, task] of c.tasks.entries()) {
      const edit = createInputTriplet(score,
        { partIndex: task.part, measureIndex: 0, offset: task.at },
        task.span.compareTo(f(1, 4)) < 0 ? task.span : f(1, 4), task.span);
      if (!edit.changed) { fail("create-rejected", `step ${step + 1}: ${edit.reason}`); return; }
      if (!expectedRange(score, task)) {
        fail("wrong-created-range", `step ${step + 1}`, task, snapshot(score)); return;
      }
      const expected = snapshot(score);
      after = save(score, c.kind, c.division);
      const read = reopen(after, c.kind);
      const actual = snapshot(read.score);
      if (read.errors.length || !same(expected, actual)) {
        fail(read.errors.length ? "parse-error" : "semantic-drift", `step ${step + 1}`,
          expected, { diagnostics: read.errors, snapshot: actual }); return;
      }
      score = read.score;
      before = after;
    }
    const fillError = fillMembers(score, c.tasks);
    if (fillError) { fail("fill-rejected", fillError); return; }
    for (let cycle = 1; cycle <= 3; cycle++) {
      const expected = snapshot(score);
      after = save(score, c.kind, c.division);
      const read = reopen(after, c.kind);
      const actual = snapshot(read.score);
      if (read.errors.length || !same(expected, actual)) {
        fail(read.errors.length ? "parse-error" : "semantic-drift", `filled cycle ${cycle}`,
          expected, { diagnostics: read.errors, snapshot: actual }); return;
      }
      score = read.score;
      before = after;
    }
    record("pass");
  } catch (error) { fail("exception", String(error)); }
}

const starts = [f(0), f(1, 8), f(1, 4), f(1, 2), f(3, 4), f(1), f(3, 2), f(2), f(5, 2), f(3)];
const spans = [f(1, 8), f(1, 4), f(1, 2), f(1), f(2), f(4)];
const candidates = spans.flatMap((duration) => starts.filter((at) => at.plus(duration).compareTo(f(4)) <= 0)
  .map((at) => ({ at, duration })));
function relation(a: { at: Fraction; duration: Fraction }, b: { at: Fraction; duration: Fraction }): string {
  const ae = a.at.plus(a.duration), be = b.at.plus(b.duration);
  if (a.at.equals(b.at)) return a.duration.equals(b.duration) ? "same" : "contain";
  if (a.at.compareTo(b.at) <= 0 && ae.compareTo(be) >= 0
    || b.at.compareTo(a.at) <= 0 && be.compareTo(ae) >= 0) return "contain";
  if (ae.compareTo(b.at) > 0 && be.compareTo(a.at) > 0) return "partial";
  const gap = a.at.compareTo(b.at) < 0 ? b.at.minus(ae) : a.at.minus(be);
  return gap.equals(f(1, 2)) ? "gap-half" : gap.equals(f(1)) ? "gap-one" : "other";
}
const selected: Array<[typeof candidates[number], typeof candidates[number], string]> = [];
const perRelation: Record<string, number> = {};
for (const a of candidates) for (const b of candidates) {
  const rel = relation(a, b);
  if (rel === "other" || (perRelation[rel] ?? 0) >= 28) continue;
  // Favor boundary-crossing and unequal values while retaining short examples.
  selected.push([a, b, rel]); perRelation[rel] = (perRelation[rel] ?? 0) + 1;
}
// Balance the greedy shortest reproductions with every source span on both
// voices, including whole-note and 32nd-note source cells.
for (const left of spans) for (const right of spans) {
  const pair = candidates.filter((a) => a.duration.equals(left)).flatMap((a) =>
    candidates.filter((b) => b.duration.equals(right)).map((b) => [a, b] as const))
    .find(([a, b]) => relation(a, b) !== "other" &&
      !selected.some(([x, y]) => x.at.equals(a.at) && x.duration.equals(a.duration)
        && y.at.equals(b.at) && y.duration.equals(b.duration)));
  if (pair) selected.push([pair[0], pair[1], relation(pair[0], pair[1])]);
}
// Exercise both spatial directions: V1 begins first and V2 begins first.
for (const [a, b, rel] of selected.filter((item) => item[2] === "partial").slice(0, 12)) {
  if (!selected.some(([x, y]) => x.at.equals(b.at) && x.duration.equals(b.duration)
    && y.at.equals(a.at) && y.duration.equals(a.duration))) selected.push([b, a, rel]);
}
for (const kind of ["keyboard", "number"] as const) for (const [a, b, rel] of selected)
  for (const reverse of [false, true]) {
    const tasks = [{ part: 0, at: a.at, span: a.duration }, { part: 1, at: b.at, span: b.duration }];
    if (reverse) tasks.reverse();
    run({ family: "dual", relation: rel, kind, order: reverse ? "BA" : "AB",
      division: a.at.denominator === 8 || b.at.denominator === 8
        || a.duration.equals(f(1, 8)) || b.duration.equals(f(1, 8)) ? 32 : 16,
      sources: [{ part: 0, at: a.at, duration: a.duration, pitch: 60 },
        { part: 1, at: b.at, duration: b.duration, pitch: 67 }], tasks });
  }

// Rest-start creation can legitimately cross an ordinary slash boundary even
// when a source note at that offset would first be split into tied beat cells.
const restPairs = candidates.filter((a) => a.duration.compareTo(f(1, 2)) >= 0)
  .flatMap((a) => candidates.filter((b) => b.duration.compareTo(f(1, 2)) >= 0
    && (a.at.toFloat() % 1 !== 0 || b.at.toFloat() % 1 !== 0))
    .map((b) => [a, b] as const))
  .filter(([a, b]) => relation(a, b) !== "other").slice(0, 72);
restPairs.push(
  [{ at: f(1, 4), duration: f(1, 2) }, { at: f(0), duration: f(1, 2) }],
  [{ at: f(1, 2), duration: f(1) }, { at: f(0), duration: f(1) }],
  [{ at: f(3, 4), duration: f(1, 2) }, { at: f(1, 2), duration: f(1, 2) }],
);
for (const kind of ["keyboard", "number"] as const) for (const [a, b] of restPairs)
  for (const reverse of [false, true]) {
    const tasks: Task[] = [{ part: 0, at: a.at, span: a.duration, source: "rest" },
      { part: 1, at: b.at, span: b.duration, source: "rest" }];
    if (reverse) tasks.reverse();
    run({ family: "dual-rest", relation: relation(a, b), kind,
      order: reverse ? "BA" : "AB", division: a.at.denominator === 8 || b.at.denominator === 8 ? 32 : 16,
      sources: [], tasks });
  }

for (const kind of ["keyboard", "number"] as const) for (const span of spans)
  for (const at of [f(0), f(1, 2), f(1)]) {
    if (at.plus(span).compareTo(f(4)) > 0) continue;
    for (const part of [0, 1]) run({ family: "rest-span", relation: "single", kind,
      order: "single", division: span.equals(f(1, 8)) ? 32 : 16,
      sources: [], tasks: [{ part, at, span, source: "rest" }] });
  }

// A dotted source is converted over its undotted base span; its remaining tail
// is ordinary silence. Also exercise an ordinary dotted note in the other voice.
const dots = [f(3, 16), f(3, 8), f(3, 4), f(3, 2), f(3)];
for (const kind of ["keyboard", "number"] as const) for (const dot of dots)
  for (const at of [f(0), f(1, 2), f(1), f(2)]) {
    if (at.plus(dot).compareTo(f(4)) > 0) continue;
    const base = dot.timesInt(2).divInt(3);
    for (const dottedPart of [0, 1]) {
      const other = dottedPart === 0 ? 1 : 0;
      run({ family: "dotted", relation: "parallel-dotted", kind, order: "single",
        division: dot.equals(f(3, 16)) ? 64 : dot.equals(f(3, 8)) ? 32 : 16,
        sources: [{ part: dottedPart, at, duration: dot, pitch: dottedPart ? 67 : 60 },
          { part: other, at: f(0), duration: f(1), pitch: other ? 67 : 60 }],
        tasks: [{ part: dottedPart, at, span: base }] });
      if (at.equals(f(0))) run({ family: "dotted", relation: "ordinary-dotted", kind, order: "single",
        division: dot.equals(f(3, 16)) ? 64 : dot.equals(f(3, 8)) ? 32 : 16,
        sources: [{ part: other, at: f(0), duration: dot, pitch: other ? 67 : 60 },
          { part: dottedPart, at: f(0), duration: base, pitch: dottedPart ? 67 : 60 }],
        tasks: [{ part: dottedPart, at: f(0), span: base }] });
    }
  }

// A true crossing is intentionally refused; this guard should never depend on
// what the other voice is doing.
for (const kind of ["keyboard", "number"] as const) {
  const score = fixture({ family: "cross", relation: "cross-measure", kind, order: "single",
    sources: [{ part: 0, at: f(0), duration: f(1), pitch: 60 },
      { part: 1, at: f(0), duration: f(1), pitch: 67 }], tasks: [] });
  const edit = createInputTriplet(score, { partIndex: 0, measureIndex: 0, offset: f(3) }, f(2), f(2));
  if (edit.changed || edit.reason !== "cross-measure") failures.push({ id: `cross-${kind}`,
    phase: "cross-measure-guard", case: { kind }, reason: String(edit.reason) });
}
fs.mkdirSync(reportDir, { recursive: true });
const report = { total, counts, skipped, coverage, relationCounts: perRelation, failures };
fs.writeFileSync(path.join(reportDir, "overlap-dotted-results.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ total, counts, skipped, failures: failures.length }));
if (failures.length) process.exitCode = 1;
