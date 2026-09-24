import { MusicCommon, quarterBpmFromUnit, tempoBpmForUnit, type Score, type TempoBeatUnit } from "../score/score";
import { positiveNumberError, showInputDialog } from "../ui/app-dialog";
import "../ui/score-header.css";

export type HeaderTarget = "credits" | "rhythm";
export type HeaderChange =
  | { kind: "credits"; values: { title: string; subtitle: string; composer: string; arranger: string; lyricist: string } }
  | { kind: "rhythm"; values: { fifths: number; beats: number; beatType: number; tempoBpm: number; tempoBeatUnit: TempoBeatUnit } };

export function scoreHeaderValues(score: Score) {
  const first = score.parts[0]?.measures[0];
  return { title: score.title, subtitle: score.subtitle, composer: score.composer, arranger: score.arranger,
    lyricist: score.lyricist, fifths: first?.key.fifths ?? 0, beats: first?.time.beats ?? 4,
    beatType: first?.time.beatType ?? 4, tempoBpm: score.tempoBpm, tempoBeatUnit: score.tempoBeatUnit };
}

export function scoreHeaderTarget(target: EventTarget | null): HeaderTarget | null {
  if (!(target instanceof Element)) return null;
  if (target.closest(".publication-meta")) return "rhythm";
  return target.closest(".publication-title,.publication-subtitle,.publication-credit") ? "credits" : null;
}

/** A visible opening meter directive overrides TXT metadata; later changes stay intact. */
export function replaceOpeningMeterDirective(text: string, firstNoteFrom: number, beats: number, beatType: number): string {
  const header = text.slice(0, firstNoteFrom);
  const matches = [...header.matchAll(/^[ \t]*\d{1,2}[ \t]*\/[ \t]*(?:2|4|8|16)[ \t]*拍[ \t]*[：:][ \t]*\r?$/gm)];
  const last = matches[matches.length - 1];
  if (!last) return text;
  const value = `${beats}/${beatType}拍：${last[0].endsWith("\r") ? "\r" : ""}`;
  return text.slice(0, last.index) + value + text.slice(last.index! + last[0].length);
}

export async function showScoreHeaderEditor(score: Score, target: HeaderTarget): Promise<HeaderChange | null> {
  if (target === "credits") {
    const result = await showInputDialog({ title: "标题与署名", message: "修改会同步到乐谱设置中的“标题与署名”。",
      fields: ([
        ["title", "标题"], ["subtitle", "副标题"], ["lyricist", "作词"], ["composer", "作曲"], ["arranger", "编曲"],
      ] as const).map(([name, label]) => ({ name, label, value: score[name] })) });
    return result ? { kind: "credits", values: { title: result.title.trim() || "未命名", subtitle: result.subtitle.trim(),
      lyricist: result.lyricist.trim(), composer: result.composer.trim(), arranger: result.arranger.trim() } } : null;
  }
  const first = score.parts[0]?.measures[0];
  if (!first) return null;
  const result = await showInputDialog({ title: "调号、拍号与速度", message: "修改乐谱开头的设置，后续单独标记的换调和速度变化保留。",
    fields: [
      { name: "fifths", label: "调号", value: String(first.key.fifths), choices: MusicCommon.keys.map((key, index) => {
        const fifths = index - 7;
        const label = key.startsWith("b") ? `${key.slice(1)}♭` : key.startsWith("#") ? `${key.slice(1)}♯` : key;
        return { value: String(fifths), label: `1=${label} · ${fifths === 0 ? "无升降号" : `${Math.abs(fifths)} 个${fifths > 0 ? "升" : "降"}号`}` };
      }) },
      { name: "beats", label: "每小节拍数", value: String(first.time.beats), inputMode: "numeric",
        validate: value => /^\d+$/.test(value.trim()) && Number(value) >= 1 && Number(value) <= 32 ? null : "每小节拍数须为 1–32 的整数" },
      { name: "beatType", label: "以几分音符为一拍", value: String(first.time.beatType),
        choices: [2, 4, 8, 16].map(value => ({ value: String(value), label: `${value} 分音符` })) },
      { name: "tempo", label: "速度（BPM）", value: String(tempoBpmForUnit(score.tempoBpm, score.tempoBeatUnit)),
        inputMode: "decimal", validate: positiveNumberError },
      { name: "tempoBeatUnit", label: "速度的拍单位", value: score.tempoBeatUnit, choices: [
        { value: "quarter", label: "四分音符" }, { value: "dotted-quarter", label: "附点四分音符" },
        { value: "eighth", label: "八分音符" },
      ] },
    ] });
  if (!result) return null;
  const tempoBeatUnit = result.tempoBeatUnit as TempoBeatUnit;
  return { kind: "rhythm", values: { fifths: Number(result.fifths), beats: Number(result.beats),
    beatType: Number(result.beatType), tempoBpm: quarterBpmFromUnit(Number(result.tempo), tempoBeatUnit), tempoBeatUnit } };
}
