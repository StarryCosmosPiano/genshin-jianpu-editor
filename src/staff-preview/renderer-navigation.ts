import { PlaySpecKind, type Score } from "../score/score";
import type { Fraction } from "../common/fraction";
import type { StaffMeasure } from "./model";

/** Keep named MusicXML navigation targets visible without changing playback. */
export function staffNavigationLabels(score: Score, measure: number): StaffMeasure["labels"] {
  const labels: StaffMeasure["labels"] = [];
  const data = score.playData;
  const targetName = (value: unknown, count: number): string => {
    const name = typeof value === "string" || typeof value === "number" ? String(value) : "";
    return name && (name !== "1" || count > 1) ? ` ${name}` : "";
  };
  for (const [name, position] of data.segno) if (position.mid === measure)
    labels.push({ position: position.offset, partIndex: 0, symbol: "segno", text: targetName(name, data.segno.size).trim() });
  for (const [name, position] of data.coda) if (position.mid === measure)
    labels.push({ position: position.offset, partIndex: 0, symbol: "coda", text: targetName(name, data.coda.size).trim() });
  for (const [position, jump] of data.jumpTo) {
    if (position.mid !== measure) continue;
    const label = { position: position.offset, partIndex: 0, text: "" };
    switch (jump.kind) {
      case PlaySpecKind.Dacapo: label.text = "D.C."; break;
      case PlaySpecKind.DalSegno: label.text = `D.S.${targetName(jump.value, data.segno.size)}`; break;
      case PlaySpecKind.ToCoda: label.text = `To Coda${targetName(jump.value, data.coda.size)}`; break;
      case PlaySpecKind.Fine: label.text = "Fine"; break;
      default: label.text = `未支持的反复导航 ${String(jump.kind)}`;
    }
    labels.push(label);
  }
  return labels;
}

export function staffNavigationDiagnostics(score: Score, measures: Array<{ duration: Fraction }>): string[] {
  const messages: string[] = [];
  const positions = [
    ...[...score.playData.segno].map(([name, position]) => ({ label: `Segno ${name}`, position })),
    ...[...score.playData.coda].map(([name, position]) => ({ label: `Coda ${name}`, position })),
    ...[...score.playData.jumpTo].map(([position, jump]) => ({ label: `反复导航 ${PlaySpecKind[jump.kind] ?? String(jump.kind)}`, position })),
  ];
  for (const { label, position } of positions) {
    const measure = measures[position.mid];
    if (!measure || position.offset.numerator < 0 || position.offset.compareTo(measure.duration) > 0)
      messages.push(`${label} 的位置（第 ${position.mid + 1} 小节，${position.offset.toString()} 拍）超出乐谱，无法绘制。`);
  }
  for (const jump of score.playData.jumpTo.values()) if (![PlaySpecKind.Dacapo, PlaySpecKind.DalSegno, PlaySpecKind.ToCoda, PlaySpecKind.Fine].includes(jump.kind))
    messages.push(`反复导航类型 ${String(jump.kind)} 尚未支持，页面显示原始类型标签。`);
  return messages;
}
