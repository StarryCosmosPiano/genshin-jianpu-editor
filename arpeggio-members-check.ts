import { readFileSync } from "node:fs";
import { Chord, CrossPartArpeggio, Score } from "./src/score/score";
import { chordArpeggioPitchGroups } from "./src/score/arpeggio";
import { buildTimeline } from "./src/score/timeline";
import { createInputTriplet } from "./src/score/input-edit";
import { Fraction } from "./src/common/fraction";
import { JpwFile } from "./src/jpword/jpwfile";
import { fromJpw } from "./src/score/jpwimport";
import { scoreToJpwabc } from "./src/score/jpscore";
import {
  analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptionsFromScore,
  parseSlashScore, scoreToSlashScore, SLASH_VOICE_SEPARATOR,
  type SlashScoreOptions,
} from "./src/slashscore";

let checks = 0;
function check(value: unknown, message: string): asserts value {
  checks++;
  if (!value) throw new Error(message);
}
const v = SLASH_VOICE_SEPARATOR;
type Member = { part: number; pitch: number };
const membersKey = (members: readonly Member[]): string => members
  .map(member => `${member.part}:${member.pitch}`).sort().join(",");
const group = (part: number, pitches: number[]): Member[] => pitches.map(pitch => ({ part, pitch }));
interface Fixture { name: string; token: string; groups: Member[][]; voiceCount?: number }
const fixtures: Fixture[] = [
  { name: "upper-only nested brace", token: `(XB{${v}G${v}J${v}W})`, groups: [group(0, [67, 71, 74])] },
  { name: "complete cross-part brace", token: `{XB${v}G${v}J${v}W}`, groups: [[...group(1, [50, 55]), ...group(0, [67, 71, 74])]] },
  { name: "partial cross-part brace", token: `(X{B${v}G${v}J}${v}W)`, groups: [[...group(1, [55]), ...group(0, [67, 71])]] },
  { name: "same members in a different source order", token: `(${v}W{${v}JB${v}G}X)`, groups: [[...group(1, [55]), ...group(0, [67, 71])]] },
  { name: "lower-only nested brace", token: `({XB}${v}G${v}J${v}W)`, groups: [group(1, [50, 55])] },
  { name: "two local subsets in one chord", token: `(Z{XCV}{BNA}${v}G)`, groups: [group(1, [50, 52, 53]), group(1, [55, 57, 60])] },
  { name: "independent local braces in different parts", token: `({XB}{${v}G${v}J}${v}W)`, groups: [group(1, [50, 55]), group(0, [67, 71])] },
  { name: "two independent cross-part braces", token: `({X${v}G}{B${v}J}${v}W)`, groups: [[...group(1, [50]), ...group(0, [67])], [...group(1, [55]), ...group(0, [71])]] },
  { name: "simultaneous local and cross-part braces", token: `({X${v}G}B{${v}J${v}W})`, groups: [[...group(1, [50]), ...group(0, [67])], group(0, [71, 74])] },
  { name: "interleaved local subsets", token: `({XV}{CB}${v}G)`, groups: [group(1, [50, 53]), group(1, [52, 55])] },
  { name: "same pitch in different parts", token: `({A${v}A}B)`, groups: [[...group(1, [60]), ...group(0, [60])]] },
  { name: "three voice subset", token: `(X{${v}${v}B${v}G}${v}${v}${v}J)`, voiceCount: 3, groups: [[...group(1, [55]), ...group(0, [67])]] },
];
function optionsFor(text: string, voiceCount = 2): SlashScoreOptions {
  return { ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(text)), voiceCount,
    symbolDurations: { ".": 16 }, noteDivision: null, showExplicitRests: true,
    braceMode: "arpeggio", bracketMode: "triplet", parenMode: "chord", barMode: "grace", angleMode: "subdivide" };
}
function fixtureText(fixture: Fixture): string {
  const voiceCount = fixture.voiceCount ?? 2;
  const rests = `(${Array.from({ length: voiceCount }, (_, part) => `${part === voiceCount - 1 ? "" : v.repeat(part + 1)}0`).join("")})`;
  return `键盘谱\n4/4拍：\n点=16分音符\n花括号=琶音\n圆括号=和弦\n${fixture.token}..../${rests}..../${rests}..../${rests}..../\n`;
}
function arpeggioSignature(score: Score): string {
  const groups: string[] = score.crossPartArpeggios.map(mark =>
    `${mark.measure}@${mark.offset}:${membersKey(mark.pitches)}:${mark.direction}`);
  score.parts.forEach((part, partIndex) => part.measures.forEach(measure => measure.entries.forEach(entry => {
    if (!(entry instanceof Chord)) return;
    for (const pitches of chordArpeggioPitchGroups(entry)) {
      groups.push(`${measure.index}@${entry.position}:${membersKey(group(partIndex, pitches))}:up`);
    }
  })));
  return groups.sort().join("|");
}
function playbackSignature(score: Score): string {
  return buildTimeline(score).notes.map(note =>
    `${note.part}:${note.pitch}@${note.t0.toFixed(8)}..${note.t1.toFixed(8)}`).sort().join("|");
}
function writtenSignature(score: Score): string {
  const cross = score.crossPartArpeggios;
  const local = score.parts.flatMap(part => part.measures.flatMap(measure => measure.entries
    .filter((entry): entry is Chord => entry instanceof Chord && entry.arpeggio)));
  try {
    score.crossPartArpeggios = [];
    for (const chord of local) chord.arpeggio = false;
    return playbackSignature(score);
  } finally {
    score.crossPartArpeggios = cross;
    for (const chord of local) chord.arpeggio = true;
  }
}
const scores: Score[] = [];
for (const fixture of fixtures) {
  const text = fixtureText(fixture);
  const options = optionsFor(text, fixture.voiceCount);
  const parsed = parseSlashScore(text, options);
  check(parsed.summary.diagnostics.every(item => item.severity !== "error"), `${fixture.name}: parse diagnostics`);
  const score = parsed.score;
  scores.push(score);
  const expected = fixture.groups.map(members => `0@0:${membersKey(members)}:up`).sort().join("|");
  check(arpeggioSignature(score) === expected, `${fixture.name}: members changed\n${arpeggioSignature(score)}\n${expected}`);
  const written = writtenSignature(score), playback = playbackSignature(score);
  check(buildTimeline(score).notes.length === text.slice(text.lastIndexOf("圆括号"))
    .split("\n")[1].match(/[A-Z]/g)!.length, `${fixture.name}: a written note was lost or duplicated`);
  let current = score;
  for (const kind of ["keyboard", "number", "keyboard"] as const) {
    for (let save = 0; save < 2; save++) {
      const exported = scoreToSlashScore(current, kind, 16, ".", {
        ...options, durationNotation: { ...options, kind },
      }, options.voiceCount);
      const plain = parseSlashScore(exported, { ...options, kind });
      check(arpeggioSignature(plain.score) === expected, `${fixture.name}: plain ${kind} save ${save} lost groups\n${exported}`);
      const automatic = parseSlashScore(exported, defaultSlashScoreOptions(kind, analyzeSlashScore(exported))).score;
      check(arpeggioSignature(automatic) === expected && writtenSignature(automatic) === written,
        `${fixture.name}: automatic plain ${kind} save ${save} lost member groups or changed timing\n${exported}`);
      const embedded = embedSlashScoreOptionsFromScore(exported, current, { ...options, kind });
      current = parseSlashScore(embedded, defaultSlashScoreOptions(kind, analyzeSlashScore(embedded))).score;
      check(arpeggioSignature(current) === expected, `${fixture.name}: annotated ${kind} save ${save} duplicated/lost groups`);
      check(writtenSignature(current) === written, `${fixture.name}: ${kind} save ${save} changed written notes/times`);
      check(playbackSignature(current) === playback, `${fixture.name}: ${kind} save ${save} changed rolled playback`);
    }
  }
  for (let save = 0; save < 2; save++) {
    const jpw = scoreToJpwabc(current);
    const file = JpwFile.fromString(jpw);
    check(file, `${fixture.name}: JPW parse failed`);
    const reopened = fromJpw(file);
    check(reopened, `${fixture.name}: JPW score failed`);
    current = reopened;
    check(arpeggioSignature(current) === expected, `${fixture.name}: JPW save ${save} lost member groups`);
    check(playbackSignature(current) === playback, `${fixture.name}: JPW save ${save} changed rolled playback`);
  }
}

// Braces keep their member identity inside rhythmic containers as well.
for (const token of [`[(X{B${v}G${v}J}${v}W)..${v}A..${v}S..]`,
  `[{X${v}G}..${v}A..${v}S..]`]) {
  const text = `键盘谱\n4/4拍：\n点=16分音符\n${token}/(${v}00)..../(${v}00)..../(${v}00)..../\n`;
  const options = optionsFor(text);
  const score = parseSlashScore(text, options).score;
  check(score.crossPartArpeggios.length === 1, "a rhythmic container lost its nested arpeggio");
  const before = arpeggioSignature(score), written = writtenSignature(score);
  const output = scoreToSlashScore(score, "keyboard", 16, ".", { ...options, durationNotation: options }, 2);
  const saved = embedSlashScoreOptionsFromScore(output, score, options);
  const after = parseSlashScore(saved, defaultSlashScoreOptions("keyboard", analyzeSlashScore(saved))).score;
  check(arpeggioSignature(after) === before && writtenSignature(after) === written,
    `a rhythmic-container arpeggio failed save/reopen\n${output}`);
}

// A voice-owned long triplet is displayed in per-beat slices. Its consumed
// source atom must carry local member groups through that restoration path.
const longText = `键盘谱\n4/4拍：\n点=16分音符\n(N{${v}D${v}G}).${v}A.${v}N.(${v}D${v}G)./.${v}A.${v}N.${v}A./(${v}D${v}G).${v}A.${v}N.(${v}D${v}G)./.${v}A.${v}N../\n`;
const longOptions = optionsFor(longText);
let longScore = parseSlashScore(longText, longOptions).score;
check(createInputTriplet(longScore, { partIndex: 1, measureIndex: 0, offset: new Fraction(0) },
  new Fraction(1, 4)).changed, "could not create the long voice-owned triplet fixture");
const longGroups = arpeggioSignature(longScore), longWritten = writtenSignature(longScore);
const slicedOptions = { ...longOptions, wholeMeasureGroups: false };
for (let save = 0; save < 2; save++) {
  const text = scoreToSlashScore(longScore, "keyboard", 16, ".", {
    ...slicedOptions, durationNotation: slicedOptions,
  }, 2);
  const saved = embedSlashScoreOptionsFromScore(text, longScore, slicedOptions);
  check(saved.includes('"beatSlices":true'), "long arpeggio fixture did not exercise beat-sliced restoration");
  const parsed = parseSlashScore(saved, defaultSlashScoreOptions("keyboard", analyzeSlashScore(saved)));
  check(parsed.summary.diagnostics.every(item => item.severity !== "error"), "long arpeggio introduced timing diagnostics");
  longScore = parsed.score;
  check(arpeggioSignature(longScore) === longGroups && writtenSignature(longScore) === longWritten,
    `long triplet save ${save} lost the local arpeggio or altered note timing\n${saved}\n${longGroups} -> ${arpeggioSignature(longScore)}\n${longWritten} -> ${writtenSignature(longScore)}`);
}

// Assigned delimiter names win over keywords in their explanatory suffixes.
for (const [declared, expected] of [
  ["无特殊功能", "none"], ["和弦", "chord"], ["细分", "subdivide"],
  ["倚音", "grace"], ["琶音", "arpeggio"], ["三连音", "triplet"], ["颤音", "trill"],
] as const) {
  for (const opening of ["（", "("]) {
    const line = `键盘谱\n4/4拍：\n花括号 = ${declared}${opening}说明可含和弦、琶音或三连音词语）\nA..../0..../0..../0..../\n`;
    check(analyzeSlashScore(line).suggestedBraceMode === expected, `${declared}: the explanation overrode the assigned mode`);
  }
}
const legacyModeText = "键盘谱\n4/4拍：\n花括号表示琶音\nA..../0..../0..../0..../\n";
check(analyzeSlashScore(legacyModeText).suggestedBraceMode === "arpeggio", "a legacy delimiter description without assignment stopped working");

// A configured non-arpeggio delimiter must retain its original chord semantics.
const remappedText = `键盘谱\n4/4拍：\n点=16分音符\n花括号=和弦\n方括号=琶音\n(XB[${v}G${v}J${v}W])..../(${v}00)..../(${v}00)..../(${v}00)..../\n`;
const remappedOptions = { ...optionsFor(remappedText), braceMode: "chord" as const, bracketMode: "arpeggio" as const };
const remappedScore = parseSlashScore(remappedText, remappedOptions).score;
check(arpeggioSignature(remappedScore) === arpeggioSignature(scores[0]), "arpeggio membership was hardcoded to curly braces");

// Lightweight structural layout checks. Browser QA independently measures the
// real SVG glyph boxes; this shim only makes the geometry pipeline executable.
class SvgElement {
  isConnected = true;
  textContent = "";
  style: Record<string, string> = {};
  children: SvgElement[] = [];
  attrs = new Map<string, string>();
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  appendChild<T extends SvgElement>(child: T): T { this.children.push(child); return child; }
  getComputedTextLength(): number { return this.textContent.length * 14; }
  getContext(): { font: string; measureText: (text: string) => Record<string, number> } {
    return { font: "", measureText: text => ({ width: text.length * 14,
      actualBoundingBoxAscent: 22, actualBoundingBoxDescent: 6,
      fontBoundingBoxAscent: 22, fontBoundingBoxDescent: 6 }) };
  }
  getBBox(): { x: number; y: number; width: number; height: number } {
    const d = this.attrs.get("d");
    if (d) {
      const numbers = (d.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) ?? []).map(Number);
      const xs = numbers.filter((_, index) => index % 2 === 0);
      const ys = numbers.filter((_, index) => index % 2 === 1);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    }
    return { x: 0, y: -22, width: this.getComputedTextLength(), height: 28 };
  }
}
(globalThis as { document?: unknown }).document = {
  body: new SvgElement(), getElementById: () => null,
  createElement: () => new SvgElement(), createElementNS: () => new SvgElement(),
};
const layout = await import("./src/layout/layout");
const { MetaData } = await import("./src/smufl/smufl");
const metadata = MetaData.fromJson(JSON.parse(readFileSync("public/redist/bravura_metadata.json", "utf8")));
let geometryCases = 0;
for (const rhythmicSpacingEnabled of [true, false]) for (const connectBarlines of [true, false]) {
  for (const [fixtureIndex, score] of scores.entries()) {
    const fixture = fixtures[fixtureIndex];
    const painter = new layout.Layout(28);
    painter.options.smuflMeta = metadata;
    painter.options.applyEngravingStyle({ rhythmicSpacingEnabled, connectBarlines });
    painter.fromScore(score, null, 960, 900);
    const waves: Array<{ path: InstanceType<typeof layout.GraphicPath>; page: InstanceType<typeof layout.Group> }> = [];
    const lines: Array<{ path: InstanceType<typeof layout.GraphicLine>; page: InstanceType<typeof layout.Group> }> = [];
    const entries = new Set<InstanceType<typeof layout.NoteEntry>>();
    for (const page of painter.pages) {
      const visit = (item: InstanceType<typeof layout.PageItem>): void => {
        if (item instanceof layout.GraphicPath && (item.classes.has("jianpu-arpeggio")
          || item.classes.has("jianpu-cross-part-arpeggio"))) waves.push({ path: item, page });
        if (item instanceof layout.GraphicLine && (item.classes.has("piano-system-left")
          || item.classes.has("ensemble-system-left") || item.parent?.data instanceof layout.Barline)) lines.push({ path: item, page });
        if (item.data instanceof layout.NoteEntry) entries.add(item.data);
        for (const child of item.children) visit(child);
      };
      visit(page);
    }
    check(waves.length === fixture.groups.length,
      `${fixture.name}: layout wave count ${waves.length} != ${fixture.groups.length}`);
    for (const { path, page } of waves) {
      const position = path.pos(page);
      const xs = path.segs.flatMap(segment => segment.pts.filter((_, index) => index % 2 === 0)).map(x => x + position.x);
      const ys = path.segs.flatMap(segment => segment.pts.filter((_, index) => index % 2 === 1)).map(y => y + position.y);
      const box = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
      for (const line of lines.filter(line => line.page === page)) {
        const at = line.path.pos(page);
        if (at.y + line.path.height < box.top || at.y > box.bottom) continue;
        check(at.x + line.path.strokeWidth / 2 < box.left - path.strokeWidth / 2
          || at.x - line.path.strokeWidth / 2 > box.right + path.strokeWidth / 2,
        `${fixture.name}: arpeggio collides with a barline (${rhythmicSpacingEnabled}/${connectBarlines})`);
      }
      if (fixtureIndex === 2 && path.data instanceof CrossPartArpeggio) {
        const unselected = [...entries].flatMap(entry => entry.syncSourceMeasure === 0
          && entry.syncTick.toFloat() === 0 ? entry.numbers.flatMap((number, index) => {
            const pitch = entry.chord.notes[index]?.pitch;
            return pitch === 50 || pitch === 74 ? [{ pitch, number }] : [];
          }) : []);
        check(unselected.length === 2, "partial cross layout lost the two unselected notes");
        for (const { pitch, number } of unselected) {
          const at = number.pos(page);
          check(pitch === 74 ? box.top > at.y + number.bound.bottom : box.bottom < at.y + number.bound.top,
            `partial cross-part wave includes unselected ${pitch === 74 ? "W" : "X"}`);
        }
      }
    }
    geometryCases++;
  }
}
console.log(JSON.stringify({ checks, fixtures: fixtures.length, geometryCases, result: "arpeggio members, independent groups, round trips and barline clearance passed" }, null, 2));
