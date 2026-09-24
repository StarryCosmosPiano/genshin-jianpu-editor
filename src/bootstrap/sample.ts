import avidMidiUrl from "../../examples/Avid - 86 -不存在的战区.mid?url";
import { analyzeMidi, midiToScore, parseMidi } from "../midi";
import { JpwFile } from "../jpword/jpwfile";
import { fromJpw } from "../score/jpwimport";
import type { Score } from "../score/score";
import { analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptionsFromScore, scoreToSlashScore, type SlashScoreOptions } from "../slashscore";

const AVID_FALLBACK = `// ************** JPW-ABC File Ver 1.0 (for JP-Word v5.50m) **************
.Title
Title = Avid - 86—不存在的战区—
SubTitle = {86—Eighty Six— ED}
Composer = {泽野弘之(Hiroyuki Sawano)}
Arranger = {星宇StarryCosmos}
Lyricist = {cAnON.}
Instrument = {钢琴}
KeyAndMeters = {1=C,4/4}
Tempo = {73}
.Voice.RH
[1'3'5']_ 6'_ 3'_ 1'_ 6_ 1'_ 5_ 1'_ |[1'3'5']_ 6'_ 3'_ 1'_ 6_ 1'_ 5_ 1'_ |$(true)
[2'4'6']_ 7'_ 4'_ 2'_ 7_ 2'_ 6_ 2'_ |[1'3'5']- 5- |]$(true,0,0,true)
.Voice.LH
[1,3,5,]--- |[6,,1,3,]--- |$(true)
[4,6,1]--- |[1,3,5,]--- |]$(true,0,0,true)
`;

/** Build the default editable document from the bundled MIDI, with an offline fallback. */
function keyboardSample(score: Score): { text: string; options: SlashScoreOptions } {
  const voiceCount = Math.max(1, Math.min(9, score.parts.length));
  const text = scoreToSlashScore(score, "keyboard", 16, ".", { braceMode: "arpeggio", bracketMode: "triplet", showExplicitRests: true }, voiceCount);
  const options: SlashScoreOptions = {
    ...defaultSlashScoreOptions("keyboard", analyzeSlashScore(text)),
    kind: "keyboard", voiceCount, instrumentName: score.instrumentName || "钢琴",
    title: score.title, subtitle: score.subtitle, composer: score.composer,
    arranger: score.arranger, lyricist: score.lyricist,
    tempoBpm: score.tempoBpm, tempoBeatUnit: score.tempoBeatUnit,
    showExplicitRests: true,
  };
  return { text: embedSlashScoreOptionsFromScore(text, score, options), options };
}

export async function loadBuiltInSample(): Promise<{ text: string; options: SlashScoreOptions }> {
  try {
    const response = await fetch(avidMidiUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = parseMidi(new Uint8Array(await response.arrayBuffer()));
    const analysis = analyzeMidi(parsed);
    const imported = midiToScore(parsed, {
      quantize: analysis.recommendedQuantize,
      detectTriplets: true,
      handMode: "auto",
      splitPitch: analysis.splitPitch,
      fifths: analysis.fifths,
      beats: analysis.beats,
      beatType: analysis.beatType,
      tempoBpm: analysis.tempoBpm,
      tempoBeatUnit: "quarter",
      title: "Avid - 86—不存在的战区—",
      subtitle: "86—Eighty Six— ED",
      composer: "泽野弘之(Hiroyuki Sawano)",
      arranger: "星宇StarryCosmos",
      lyricist: "cAnON.",
      instrumentName: "钢琴",
      scoreMode: "hands",
      outputFormat: "jpw",
    });
    return keyboardSample(imported.score);
  } catch (error) {
    console.warn("默认 Avid MIDI 导入失败，改用内置简谱片段", error);
    const file = JpwFile.fromString(AVID_FALLBACK);
    const score = file && fromJpw(file);
    if (!score) throw new Error("内置示例无法解析");
    return keyboardSample(score);
  }
}
