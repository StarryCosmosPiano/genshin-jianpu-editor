import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { history, isolateHistory, redo, undo } from "@codemirror/commands";
import { Fraction } from "./src/common/fraction";
import { Chord, type Score } from "./src/score/score";
import { createInputTriplet } from "./src/score/input-edit";
import { chordArpeggioPitchGroups } from "./src/score/arpeggio";
import {
  analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptions,
  embedSlashScoreOptionsFromScore, parseSlashScore, scoreToSlashScore,
  type SlashScoreOptions,
} from "./src/slashscore";
import { scanSlashTextSyntax } from "./src/slashscore/text-syntax";
import { parseEditableDocument } from "./src/editor/document-parser";
import { slashMetadataSync, synchronizeSlashMetadata } from "./src/editor/slash-metadata-sync";

const base: SlashScoreOptions = {
  ...defaultSlashScoreOptions("keyboard"), beats: 4, beatType: 4,
  symbolDurations: { ".": 16 }, noteDivision: null, spaceDivision: null,
};
const metadata = (text: string) => JSON.parse(/\/\/ @jpeditor (\{[^\r\n]+\})/.exec(text)![1]);
const timeline = (score: Score) => score.parts.map((part) => part.measures.map((measure) =>
  measure.entries.flatMap((entry) => entry instanceof Chord ? [[entry.position.toString(), entry.duration?.toString(),
    entry.rest, entry.notes.some((note) => note.tuplet !== null),
    entry.notes.find((note) => note.tuplet)?.tuplet?.scope ?? null]] : [])));

function editor(source: string, options: SlashScoreOptions) {
  let state = EditorState.create({ doc: source, extensions: [history(), slashMetadataSync(() => ({ format: options.kind, options }))] });
  return {
    text: () => state.doc.toString(),
    edit(from: number, to: number, insert: string) {
      state = state.update({ changes: { from, to, insert }, userEvent: "input.type",
        annotations: isolateHistory.of("full") }).state;
    },
    replace(search: string, value: string) {
      const from = state.doc.toString().indexOf(search);
      assert(from >= 0, `missing source ${search}`);
      this.edit(from, from + search.length, value);
    },
    undo() { assert(undo({ state, dispatch: (transaction) => { state = transaction.state; } })); },
    redo() { assert(redo({ state, dispatch: (transaction) => { state = transaction.state; } })); },
  };
}

const source = "键盘谱\n4/4拍：\nA.B.C./D.../E.../F.../\n";
{
  const current = editor(source, base);
  current.replace("A.B.C.", "[A.B.C.]");
  const typed = current.text();
  assert.equal(metadata(typed).q, "t");
  assert.equal(metadata(typed).s["."], 16);
  assert.equal(metadata(typed).nd, null);
  assert.equal(metadata(typed).an, undefined, "ordinary source tuplets need no second timing override");
  assert.deepEqual(timeline(parseEditableDocument(typed, "keyboard", base)!.score),
    timeline(parseSlashScore(typed, defaultSlashScoreOptions("keyboard", analyzeSlashScore(typed))).score));
  current.undo();
  assert.equal(current.text(), source, "undo restores both brackets and absent footer");
  current.redo();
  assert.equal(current.text(), typed);
}
{
  const options = { ...base, bracketMode: "none" as const, braceMode: "none" as const, angleMode: "none" as const };
  const current = editor(source, options);
  current.replace("A.B.C.", "[A.B.C.]");
  assert.equal(metadata(current.text()).q, "n", "unassigned delimiters must stay unassigned");
  const parsed = parseEditableDocument(current.text(), "keyboard", options)!;
  assert(parsed.slashTimingDiagnostics.some((diagnostic) => /用途|未指定|未设置|配置/.test(diagnostic.message)),
    "unassigned special brackets retain a visible diagnostic");
}
{
  const options = { ...base, bracketMode: "arpeggio" as const, braceMode: "triplet" as const,
    noteDivision: 16 as const, symbolDurations: { "*": 8 as const }, multiDurationSymbols: true };
  const current = editor("键盘谱\n4/4拍：\nA/B/C/D/\n", options);
  current.replace("A/", "[AS]/");
  const stored = metadata(current.text());
  assert.equal(stored.q, "a");
  assert.equal(stored.b, "t");
  assert.deepEqual(stored.s, { "*": 8 });
  assert.equal(stored.nd, 16);
  assert.equal(stored.ms, true);
}
{
  const current = editor(source, base);
  current.replace("A.B.C.", "[A.B.C.");
  assert.equal(/@jpeditor/.test(current.text()), false);
  assert.equal(parseEditableDocument(current.text(), "keyboard", base), null);
  current.replace("C./", "C.]/");
  assert(metadata(current.text()));
  assert(parseEditableDocument(current.text(), "keyboard", base));
  const saved = current.text();
  current.replace("[", "{");
  assert.equal(parseEditableDocument(current.text(), "keyboard", base), null);
  assert.deepEqual(metadata(current.text()), metadata(saved), "mismatched pairs leave metadata unchanged");
}

const z = "\u2063";
const complexSource = `键盘谱\n4/4拍：\n点=16分音符\n方括号=三连音\n(V${z}G).${z}W.N.(A${z}W)./.(V${z}W).A.${z}W./B.${z}Q.U.(M${z}J)./.(B${z}Q).M.${z}J./\n`;
const complexOptions = { ...base, voiceCount: 2 };
const complexScore = parseSlashScore(complexSource, complexOptions).score;
assert(createInputTriplet(complexScore, { partIndex: 1, measureIndex: 0, offset: new Fraction(0) }, new Fraction(1, 4)).changed);
assert(createInputTriplet(complexScore, { partIndex: 0, measureIndex: 0, offset: new Fraction(2) }, new Fraction(1, 4)).changed);
const complexText = embedSlashScoreOptionsFromScore(scoreToSlashScore(complexScore, "keyboard", 16, ".",
  { ...complexOptions, durationNotation: complexOptions }, 2), complexScore, complexOptions);
{
  const options = defaultSlashScoreOptions("keyboard", analyzeSlashScore(complexText));
  const current = editor(complexText, options);
  const container = scanSlashTextSyntax(current.text(), options).containers.find((item) => item.mode === "triplet")!;
  const pitch = /[A-Z]/.exec(current.text().slice(container.bodyFrom, container.bodyTo))!;
  const position = container.bodyFrom + pitch.index;
  current.edit(position, position + 1, pitch[0] === "V" ? "B" : "V");
  assert.deepEqual(metadata(current.text()).an, metadata(complexText).an, "pitch edits preserve exact stored tuplets");
  assert.deepEqual(timeline(parseEditableDocument(current.text(), "keyboard", options)!.score), timeline(complexScore));
  current.undo();
  assert.equal(current.text(), complexText);
  current.redo();
  assert.deepEqual(timeline(parseEditableDocument(current.text(), "keyboard", options)!.score), timeline(complexScore));
}
{
  const options = defaultSlashScoreOptions("keyboard", analyzeSlashScore(complexText));
  const current = editor(complexText, options);
  const container = scanSlashTextSyntax(current.text(), options).containers.find((item) => item.mode === "triplet")!;
  current.edit(container.from, container.bodyFrom, "");
  assert.equal(parseEditableDocument(current.text(), "keyboard", options), null);
  assert.deepEqual(metadata(current.text()).an, metadata(complexText).an);
  const openLength = container.bodyFrom - container.from;
  current.edit(container.bodyTo - openLength, container.to - openLength, "");
  assert(metadata(current.text()).an.length < metadata(complexText).an.length, "deleted bracket annotation is removed");
  assert(parseEditableDocument(current.text(), "keyboard", options));
  current.undo();
  assert.equal(parseEditableDocument(current.text(), "keyboard", options), null);
  current.undo();
  assert.equal(current.text(), complexText);
  current.redo();
  current.redo();
  assert(metadata(current.text()).an.length < metadata(complexText).an.length);
}
{
  const options = { ...base, noteTimingEdits: [{ part: 0, chord: 3, move: "1/8", duration: "0" }] };
  const saved = embedSlashScoreOptions(source.replace("A.B.C.", "[A.B.C.]"), options);
  const before = parseEditableDocument(saved, "keyboard", options)!;
  const current = editor(saved, options);
  current.replace("D...", "S...");
  assert.deepEqual(metadata(current.text()).ne, metadata(saved).ne);
  assert.deepEqual(timeline(parseEditableDocument(current.text(), "keyboard", options)!.score), timeline(before.score));
  current.undo();
  assert.equal(current.text(), saved);
}
{
  const options = { ...base, voiceCount: 2 };
  const current = editor(source, options);
  current.replace("A.B.C.", `{${z}A B}...`);
  const annotations = metadata(current.text()).an;
  assert(annotations.some((annotation: { type: string }) => annotation.type === "cross-arpeggio"));
  current.replace(`{${z}A B}`, `(${z}A B)`);
  assert(!(metadata(current.text()).an ?? []).some((annotation: { type: string }) => annotation.type === "cross-arpeggio"));
}
{
  const text = source.replace(/\n/g, "\r\n") + "// annotation draft [ ( {\r\n";
  const next = text.replace("A.B.C.", "(A.B.C.)");
  const synchronized = synchronizeSlashMetadata(text, next, base, (position) => position)!;
  assert(synchronized.startsWith(next), "music and comments retain exact spelling and CRLF");
  assert(scanSlashTextSyntax(synchronized, base).complete);
}
{
  const current = editor("键盘谱\n4/4拍：\n", base);
  current.edit(current.text().length, current.text().length, "[A.B.C.]/D.../E.../F.../\n");
  assert(metadata(current.text()), "first complete source in an empty document gets a footer");
}
{
  const options: SlashScoreOptions = { ...base, kind: "number" };
  const score = parseSlashScore("数字谱\n0..../0..../1..../2..../\n", options).score;
  for (const offset of [0, 1]) assert(createInputTriplet(score,
    { partIndex: 0, measureIndex: 0, offset: new Fraction(offset) }, new Fraction(1, 4)).changed);
  const saved = embedSlashScoreOptionsFromScore(scoreToSlashScore(score, "number", 16, ".",
    { ...options, durationNotation: options }, 1), score, options);
  const current = editor(saved, options);
  const before = metadata(saved).an.filter((item: { type: string }) => item.type === "triplet");
  assert.equal(before.length, 2);
  current.replace("[000]", "000");
  const remaining = metadata(current.text()).an.filter((item: { type: string }) => item.type === "triplet");
  assert.equal(remaining.length, 1, "only the deleted silent triplet loses its annotation");
  assert.equal(remaining[0].offset, 1);
  current.undo();
  assert.equal(current.text(), saved);
}
{
  const current = editor(complexText, complexOptions);
  current.edit(0, 0, "// 标题说明\n");
  assert.equal(current.text(), "// 标题说明\n" + complexText, "header edits do not rewrite any timing metadata");
}
{
  for (const spelling of ["v", "'V", "#V", "bV", "♭V"]) {
    const options = defaultSlashScoreOptions("keyboard", analyzeSlashScore(complexText));
    const current = editor(complexText, options);
    const container = scanSlashTextSyntax(complexText, options).containers.find((item) => item.mode === "triplet")!;
    const position = complexText.indexOf("V", container.bodyFrom);
    assert(position < container.bodyTo);
    current.edit(position, position + 1, spelling);
    assert.deepEqual(metadata(current.text()).an, metadata(complexText).an, `pitch spelling ${spelling} retains explicit timing`);
    assert.deepEqual(timeline(parseEditableDocument(current.text(), "keyboard", options)!.score), timeline(complexScore));
  }
}
{
  const options = { ...base, voiceCount: 2 };
  const raw = `键盘谱\n4/4拍：\n({X${z}G}{B${z}J}{CV})..../0..../0..../0..../\n`;
  const score = parseSlashScore(raw, options).score;
  assert.equal(score.crossPartArpeggios.length, 2);
  score.crossPartArpeggios.find((mark) => mark.pitches.some((pitch) => pitch.pitch === 50))!.direction = "down";
  const saved = embedSlashScoreOptionsFromScore(raw, score, options);
  const current = editor(saved, options);
  const first = current.text().indexOf(`{X${z}G}`) + 1;
  current.edit(first, first + 1, "Z");
  const changed = current.text();
  const groups = () => parseEditableDocument(current.text(), "keyboard", options)!.score.crossPartArpeggios;
  assert.equal(groups().find((mark) => mark.pitches.some((pitch) => pitch.pitch === 48))!.direction, "down",
    "editing a downward arpeggio pitch retains the direction of its own source container");
  assert.equal(groups().find((mark) => mark.pitches.some((pitch) => pitch.pitch === 55))!.direction, "up",
    "independent arpeggios at the same onset do not borrow another group's direction");
  assert.deepEqual(timeline(parseEditableDocument(current.text(), "keyboard", options)!.score), timeline(score));
  current.undo();
  assert.equal(current.text(), saved);
  current.redo();
  assert.equal(current.text(), changed);
  assert.equal(groups().find((mark) => mark.pitches.some((pitch) => pitch.pitch === 48))!.direction, "down");
  const second = current.text().indexOf(`{B${z}J}`) + 1;
  current.edit(second, second + 1, "N");
  assert.equal(groups().find((mark) => mark.pitches.some((pitch) => pitch.pitch === 57))!.direction, "up");
  assert.equal(groups().find((mark) => mark.pitches.some((pitch) => pitch.pitch === 48))!.direction, "down");
  current.replace("{CV}", "{DV}");
  const localScore = parseEditableDocument(current.text(), "keyboard", options)!.score;
  const local = localScore.parts[1].measures[0].entries.find((entry): entry is Chord => entry instanceof Chord)!;
  assert.deepEqual(chordArpeggioPitchGroups(local).map((group) => [...group].sort((a, b) => a - b)), [[53, 64]],
    "ordinary local arpeggios retain their exact source members independently of directional cross-part groups");
}
console.log("slash-metadata-sync-check: ok (typing, custom rules, drafts, exact timing, cleanup, undo/redo)");
