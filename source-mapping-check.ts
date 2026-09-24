import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { buildSlashSourceNotes } from "./src/editor/note-selection";
import { MusicCommon } from "./src/score/score";
import {
  analyzeSlashScore,
  defaultSlashScoreOptions,
  parseSlashScore,
  slashPitchSources,
  type SlashScoreOptions,
} from "./src/slashscore";

const z = "\u2063";
function check(text: string, override: Partial<SlashScoreOptions> = {}) {
  const defaults = defaultSlashScoreOptions("keyboard", analyzeSlashScore(text));
  const options = { ...defaults, ...override };
  const score = parseSlashScore(text, options).score;
  const mapped = buildSlashSourceNotes(text, options, score);
  assert(mapped.every((source) => text.slice(source.from, source.to).length > 0
    && (source.chord.notes.includes(source.note) || source.chord.graceNotes.includes(source.note))));
  assert(mapped.every((source, index) => index === 0 || source.from >= mapped[index - 1].from));
  return { mapped, score, options };
}

const repeated = `键盘谱\n4/4拍：\n点=16分音符\nA.A.A.A./A.A.A.A./\n`;
const repeatedCase = check(repeated);
assert.equal(repeatedCase.mapped.length, slashPitchSources(repeated, repeatedCase.options).length);
assert.equal(new Set(repeatedCase.mapped.map((source) => source.chord)).size,
  repeatedCase.mapped.length, "each written repeated attack must select its own chord");
assert(repeatedCase.mapped.every((source) => source.note.pitch === repeatedCase.mapped[0].note.pitch));

const partialArpeggio = `键盘谱\n4/4拍：\n方括号=琶音\n[F#GQR](,ZZ)/-/-/-/\n`;
const arpeggioCase = check(partialArpeggio);
assert.equal(arpeggioCase.mapped.length, 6);
assert(arpeggioCase.mapped.every((source) => source.chord === arpeggioCase.mapped[0].chord
  && source.chord.arpeggio), "rolled and simultaneous source pitches must select the merged chord");
assert.deepEqual(arpeggioCase.mapped.map((source) => source.note.pitch).sort((a, b) => a - b),
  [36, 48, 65, 68, 72, 77]);

const keyChange = `键盘谱\n4/4拍：\n点=16分音符\nA../S../D../F../\n`;
const keyChangeCase = check(keyChange, {
  keyChanges: [{ measure: 0, offset: 2, fifths: 2 }],
});
assert.equal(keyChangeCase.mapped.length, 4);
const writtenPitches = slashPitchSources(keyChange, keyChangeCase.options).map((source) => source.pitch);
const tonic = (fifths: number) => MusicCommon.getBasePitch(MusicCommon.keys[fifths + 7]);
const changedBy = tonic(2) - tonic(0);
assert.notEqual(changedBy, 0);
assert.deepEqual(keyChangeCase.mapped.map((source) => source.note.pitch),
  writtenPitches.map((pitch, index) => pitch + (index >= 2 ? changedBy : 0)),
  "mapped note identity must follow the local key mark at beat 3");

const voiceTriplet = `键盘谱\n4/4拍：\n. = 16分音符\n[(${z}AE)${z}B(${z}CF)G.].../..../..../..../\n`;
assert.equal(check(voiceTriplet, {
  voiceCount: 2,
  symbolDurations: { ".": 16 },
  annotations: [
    { type: "triplet", part: 0, voice: 1, measure: 0, offset: 0,
      end: 0.25, members: [0.125, 0.125, 0.125], scope: "voice" },
    { type: "triplet", part: 1, voice: 2, measure: 0, offset: 0,
      end: 0.5, members: [0.25, 0.25, 0.25], scope: "voice" },
  ],
}).mapped.length, 6);

// The many repeated pitch shapes exercise used-candidate skipping.  The source
// is the same 20-note measure used by notation-performance-check.mjs.
const longRow = ["V", "B", "N", "M"]
  .map((bass) => `(${bass}${z}G).${z}A.${z}S.${z}D./`).join("");
const longText = `键盘谱\n4/4拍：\n点=16分音符\n${Array(256).fill(longRow).join("\n")}\n`;
const longOptions = {
  ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(longText)),
  voiceCount: 2,
  symbolDurations: { ".": 16 },
};
const longScore = parseSlashScore(longText, longOptions).score;
const start = performance.now();
const mapped = buildSlashSourceNotes(longText, longOptions, longScore);
const elapsed = performance.now() - start;
assert.equal(mapped.length, 256 * 20);
assert.equal(mapped.at(-1)?.from, longText.lastIndexOf("D."));
console.log(JSON.stringify({ sourceNotes: mapped.length, sourceMappingMs: +elapsed.toFixed(1) }));
