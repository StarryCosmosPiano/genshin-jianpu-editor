import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { analyzeMidi, midiToScore, parseMidi } from "./src/midi";
import { scoreToSlashScore, type SlashScoreKind } from "./src/slashscore";

const input = process.argv[2];
const kind = process.argv[3] as SlashScoreKind | undefined;
const output = process.argv[4];
if (!input || !output || (kind !== "keyboard" && kind !== "number")) {
  throw new Error("usage: slashscore-example <input.mid> <keyboard|number> <output.txt>");
}

const parsed = parseMidi(new Uint8Array(await readFile(input)));
const analysis = analyzeMidi(parsed);
const fileTitle = basename(input, extname(input)).replace(/\s*-\s*总谱.*$/i, "").trim();
if (!parsed.title) parsed.title = fileTitle;
const { score, summary } = midiToScore(parsed, {
  quantize: analysis.recommendedQuantize,
  detectTriplets: true,
  handMode: "auto",
  splitPitch: analysis.splitPitch,
  fifths: analysis.fifths,
  beats: analysis.beats,
  beatType: analysis.beatType,
  tempoBpm: analysis.tempoBpm,
  title: fileTitle || parsed.title,
  instrumentName: "钢琴",
});
const text = scoreToSlashScore(score, kind, analysis.recommendedQuantize);
await writeFile(output, text, "utf8");
console.log(JSON.stringify({
  input,
  output,
  kind,
  notes: analysis.noteCount,
  measures: score.parts[0]?.measures.length ?? 0,
  quantize: analysis.recommendedQuantize,
  handsMerged: summary.handCount,
}, null, 2));
