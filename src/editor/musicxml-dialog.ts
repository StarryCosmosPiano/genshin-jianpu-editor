import {
  Chord,
  formatTempoBpm,
  MusicCommon,
  quarterBpmFromUnit,
  tempoBpmForUnit,
  type Score,
  type TempoBeatUnit,
} from "../score/score";
import { Fraction } from "../common/fraction";
import { scorePartBaseName, scorePartTrackName } from "../score/part-label";
import type {
  MidiOutputFormat,
  MidiQuantizeDivision,
  MidiSlashGroupMode,
  MidiSlashOrdering,
} from "../midi";

export type MusicXmlOutputFormat = MidiOutputFormat | "mixed";

export interface MusicXmlImportOptions {
  outputFormat: MusicXmlOutputFormat;
  textDivision: MidiQuantizeDivision;
  title: string;
  subtitle: string;
  composer: string;
  arranger: string;
  lyricist: string;
  instrumentNames: string[];
  fifths: number;
  beats: number;
  beatType: number;
  tempoBpm: number;
  tempoBeatUnit: TempoBeatUnit;
  keyboardKeyLabels: boolean;
  keyboardTieAsZero: boolean;
  keyboardHideTieLabels: boolean;
  slashBraceMode: MidiSlashGroupMode;
  slashBracketMode: MidiSlashGroupMode;
  slashOrdering: MidiSlashOrdering;
}

function row(label: string, control: HTMLElement): HTMLLabelElement {
  const el = document.createElement("label");
  el.className = "modal-row";
  const text = document.createElement("span");
  text.textContent = label;
  el.append(text, control);
  return el;
}

function option(value: string, text: string, selected = false): HTMLOptionElement {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = text;
  el.selected = selected;
  return el;
}

function slashGroupSelect(value: MidiSlashGroupMode): HTMLSelectElement {
  const select = document.createElement("select");
  select.append(
    option("none", "留空（不使用此括号）", value === "none"),
    option("grace", "倚音（装饰音不占拍长）", value === "grace"),
    option("arpeggio", "琶音", value === "arpeggio"),
    option("triplet", "三连音（3:2 均分）", value === "triplet"),
    option("subdivide", "普通细分（最低时值÷2）", value === "subdivide"),
  );
  return select;
}

function inferredTextDivision(score: Score): MidiQuantizeDivision {
  let shortest = Number.POSITIVE_INFINITY;
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const entry of measure.entries) {
        if (!entry.duration || entry.duration.compareTo(new Fraction(0)) <= 0) continue;
        let quarters = entry.duration.toFloat();
        if (entry instanceof Chord && entry.notes.some((note) =>
          note.tuplet !== null || note.tupletBegin || note.tupletEnd)) {
          quarters *= 1.5;
        }
        shortest = Math.min(shortest, quarters);
      }
    }
  }
  if (!Number.isFinite(shortest) || shortest >= 1) return 4;
  if (shortest >= 0.5) return 8;
  if (shortest >= 0.25) return 16;
  if (shortest >= 0.125) return 32;
  return 64;
}

function noteCount(score: Score): number {
  let result = 0;
  for (const part of score.parts) {
    for (const measure of part.measures) {
      for (const entry of measure.entries) {
        if (!(entry instanceof Chord)) continue;
        result += entry.notes.filter((note) => !note.rest && !note.softDeleted).length;
        result += entry.graceNotes.filter((note) => !note.rest && !note.softDeleted).length;
      }
    }
  }
  return result;
}

/** MusicXML analyze-first import dialog. Resolves null when cancelled. */
export function showMusicXmlImportDialog(
  score: Score,
  fileName: string,
  defaultMixed: boolean,
): Promise<MusicXmlImportOptions | null> {
  return new Promise((resolve) => {
    const firstMeasure = score.parts[0]?.measures[0];
    const recommendedDivision = inferredTextDivision(score);
    const count = noteCount(score);
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const box = document.createElement("div");
    box.className = "modal-box midi-import-box";
    const heading = document.createElement("div");
    heading.className = "modal-title";
    heading.textContent = "MusicXML 导入";

    const info = document.createElement("div");
    info.className = "midi-import-info";
    const title = score.title.trim()
      || fileName.replace(/\.(?:xml|musicxml)$/i, "")
      || "未命名 MusicXML";
    const measureCount = Math.max(0, ...score.parts.map((part) => part.measures.length));
    const structure = score.piano
      ? "钢琴双谱表"
      : score.parts.length > 1 ? `${score.parts.length} 声部总谱` : "单谱表";
    info.textContent = `${title} · ${structure} · ${measureCount} 小节 · ${count} 音符 · `
      + `${firstMeasure?.time.beats ?? 4}/${firstMeasure?.time.beatType ?? 4} · `
      + `${formatTempoBpm(score.tempoBpm)} BPM`;

    const format = document.createElement("select");
    format.append(
      option("jpw", "JPW 简谱（完整排版）", !defaultMixed),
      option("keyboard", "键盘谱文本（完整排版）"),
      option("number", "数字谱文本（完整排版）"),
      option("mixed", "保留 MusicXML 五线谱混排", defaultMixed),
    );

    const division = document.createElement("select");
    for (const value of [4, 8, 16, 32, 64] as MidiQuantizeDivision[]) {
      division.append(option(
        String(value),
        `${value} 分音符${value === recommendedDivision ? "（推荐）" : ""}`,
        value === recommendedDivision,
      ));
    }
    const divisionRow = row("文本谱最短时值", division);
    divisionRow.title = "MusicXML 原始时值不会重新量化；此项只控制键盘谱/数字谱的文本细分";

    const keyboardKeyLabels = document.createElement("input");
    keyboardKeyLabels.type = "checkbox";
    const keyboardKeyLabelsRow = row("谱面显示键盘按键", keyboardKeyLabels);
    const keyboardTieAsZero = document.createElement("input");
    keyboardTieAsZero.type = "checkbox";
    const keyboardTieAsZeroRow = row("延音用 0 替代", keyboardTieAsZero);
    keyboardTieAsZeroRow.style.paddingLeft = "28px";
    const keyboardHideTieLabels = document.createElement("input");
    keyboardHideTieLabels.type = "checkbox";
    const keyboardHideTieLabelsRow = row("隐藏延音字母", keyboardHideTieLabels);
    keyboardHideTieLabelsRow.style.paddingLeft = "28px";

    const ordering = document.createElement("select");
    ordering.append(
      option("pitch-asc", "音高正序（低音到高音）", true),
      option("pitch-desc", "音高逆序（高音到低音）"),
      option("voice-asc", "声部正序（V1 到 VN）"),
      option("voice-desc", "声部逆序（VN 到 V1）"),
    );
    const orderingRow = row("文本谱和弦书写顺序", ordering);

    const braceMode = slashGroupSelect("grace");
    const bracketMode = slashGroupSelect("triplet");
    const groups = document.createElement("details");
    const groupsSummary = document.createElement("summary");
    groupsSummary.textContent = "键盘谱 / 数字谱括号用途";
    groups.append(
      groupsSummary,
      row("花括号 {}", braceMode),
      row("方括号 []", bracketMode),
    );

    const controls = document.createElement("div");
    controls.append(
      row("导入后格式", format),
      divisionRow,
      keyboardKeyLabelsRow,
      keyboardTieAsZeroRow,
      keyboardHideTieLabelsRow,
      orderingRow,
    );

    const instrumentInputs = score.parts.map((part, index) => {
      const input = document.createElement("input");
      input.type = "text";
      input.value = scorePartBaseName(score, part, index);
      return input;
    });
    const instruments = document.createElement("details");
    instruments.open = score.parts.length > 1;
    const instrumentsSummary = document.createElement("summary");
    instrumentsSummary.textContent = "乐器与声部";
    instruments.append(instrumentsSummary);
    instrumentInputs.forEach((input, index) => {
      instruments.append(row(scorePartTrackName(score, score.parts[index], index), input));
    });

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.value = title;
    const subtitle = document.createElement("input");
    subtitle.type = "text";
    subtitle.value = score.subtitle;
    subtitle.placeholder = "可留空";
    const composer = document.createElement("input");
    composer.type = "text";
    composer.value = score.composer;
    composer.placeholder = "可留空";
    const arranger = document.createElement("input");
    arranger.type = "text";
    arranger.value = score.arranger;
    arranger.placeholder = "可留空";
    const lyricist = document.createElement("input");
    lyricist.type = "text";
    lyricist.value = score.lyricist;
    lyricist.placeholder = "可留空";
    const metadata = document.createElement("details");
    metadata.open = true;
    const metadataSummary = document.createElement("summary");
    metadataSummary.textContent = "标题与署名（可选）";
    metadata.append(
      metadataSummary,
      row("标题", titleInput),
      row("副标题", subtitle),
      row("作曲", composer),
      row("编曲", arranger),
      row("作词", lyricist),
    );

    const key = document.createElement("select");
    for (let fifths = -7; fifths <= 7; fifths++) {
      key.append(option(
        String(fifths),
        `1=${MusicCommon.keys[fifths + 7]}`,
        fifths === (firstMeasure?.key.fifths ?? 0),
      ));
    }
    const beats = document.createElement("input");
    beats.type = "number";
    beats.min = "1";
    beats.max = "32";
    beats.value = String(firstMeasure?.time.beats ?? 4);
    const beatType = document.createElement("select");
    for (const value of [2, 4, 8, 16]) {
      beatType.append(option(
        String(value),
        String(value),
        value === (firstMeasure?.time.beatType ?? 4),
      ));
    }
    const meter = document.createElement("span");
    meter.className = "midi-meter-control";
    meter.append(beats, document.createTextNode(" / "), beatType);
    const tempo = document.createElement("input");
    tempo.type = "number";
    tempo.min = "0.1";
    tempo.max = "1998";
    tempo.step = "0.1";
    const tempoUnit = document.createElement("select");
    tempoUnit.append(
      option("dotted-quarter", "附点四分音符"),
      option("eighth", "八分音符"),
    );
    const tempoUnitRow = row("速度音符", tempoUnit);
    let displayedTempoUnit: TempoBeatUnit = score.tempoBeatUnit;
    let quarterTempo = score.tempoBpm;
    tempo.value = formatTempoBpm(tempoBpmForUnit(quarterTempo, displayedTempoUnit));
    const setDisplayedTempoUnit = (unit: TempoBeatUnit): void => {
      const entered = parseFloat(tempo.value);
      if (Number.isFinite(entered)) {
        quarterTempo = quarterBpmFromUnit(entered, displayedTempoUnit);
      }
      displayedTempoUnit = unit;
      tempo.value = formatTempoBpm(tempoBpmForUnit(quarterTempo, unit));
      if (unit !== "quarter") tempoUnit.value = unit;
    };
    const updateTempoUnit = (): void => {
      const eighthMeter = parseInt(beatType.value, 10) === 8;
      tempoUnitRow.hidden = !eighthMeter;
      tempoUnitRow.style.display = eighthMeter ? "" : "none";
      if (eighthMeter) {
        const countBeats = parseInt(beats.value, 10) || 0;
        setDisplayedTempoUnit(countBeats >= 6 && countBeats % 3 === 0
          ? "dotted-quarter"
          : "eighth");
      } else {
        setDisplayedTempoUnit("quarter");
      }
    };
    tempo.addEventListener("input", () => {
      const entered = parseFloat(tempo.value);
      if (Number.isFinite(entered)) {
        quarterTempo = quarterBpmFromUnit(entered, displayedTempoUnit);
      }
    });
    tempoUnit.addEventListener("change", () =>
      setDisplayedTempoUnit(tempoUnit.value as TempoBeatUnit));
    beatType.addEventListener("change", updateTempoUnit);
    beats.addEventListener("change", updateTempoUnit);
    const advanced = document.createElement("details");
    const advancedSummary = document.createElement("summary");
    advancedSummary.textContent = "调号、拍号与速度";
    advanced.append(
      advancedSummary,
      row("调号", key),
      row("拍号", meter),
      tempoUnitRow,
      row("速度（BPM）", tempo),
    );

    const hint = document.createElement("div");
    hint.className = "modal-hint";
    const updateVisibility = (): void => {
      const textOutput = format.value === "keyboard" || format.value === "number";
      const keyboardOutput = format.value === "keyboard";
      divisionRow.hidden = !textOutput;
      divisionRow.style.display = textOutput ? "" : "none";
      orderingRow.hidden = !textOutput;
      orderingRow.style.display = textOutput ? "" : "none";
      groups.hidden = !textOutput;
      keyboardKeyLabelsRow.hidden = !keyboardOutput;
      keyboardKeyLabelsRow.style.display = keyboardOutput ? "" : "none";
      const tieOptions = keyboardOutput && keyboardKeyLabels.checked;
      keyboardTieAsZeroRow.hidden = !tieOptions;
      keyboardTieAsZeroRow.style.display = tieOptions ? "" : "none";
      keyboardHideTieLabelsRow.hidden = !tieOptions;
      keyboardHideTieLabelsRow.style.display = tieOptions ? "" : "none";
      const mixed = format.value === "mixed";
      metadata.style.opacity = mixed ? "0.5" : "1";
      advanced.style.opacity = mixed ? "0.5" : "1";
      instruments.style.opacity = mixed ? "0.5" : "1";
      hint.textContent = mixed
        ? "混排模式保留原 MusicXML 的五线谱内容与布局；标题、乐器、调号和速度修改只用于转换后的简谱/文本谱。"
        : "MusicXML 的音高、和弦、休止、连音、三连音和原始时值会保留；确认后才会替换当前谱面。";
    };
    format.addEventListener("change", updateVisibility);
    keyboardKeyLabels.addEventListener("change", updateVisibility);

    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    const confirm = document.createElement("button");
    confirm.textContent = "导入并转为简谱";
    footer.append(cancel, confirm);
    box.append(
      heading,
      info,
      controls,
      groups,
      instruments,
      metadata,
      advanced,
      hint,
      footer,
    );
    overlay.append(box);
    document.body.append(overlay);

    const close = (value: MusicXmlImportOptions | null): void => {
      overlay.remove();
      resolve(value);
    };
    cancel.onclick = () => close(null);
    overlay.onclick = (event) => {
      if (event.target === overlay) close(null);
    };
    confirm.onclick = () => {
      close({
        outputFormat: format.value as MusicXmlOutputFormat,
        textDivision: parseInt(division.value, 10) as MidiQuantizeDivision,
        title: titleInput.value.trim(),
        subtitle: subtitle.value.trim(),
        composer: composer.value.trim(),
        arranger: arranger.value.trim(),
        lyricist: lyricist.value.trim(),
        instrumentNames: instrumentInputs.map((input, index) =>
          input.value.trim() || `乐器 ${index + 1}`),
        fifths: parseInt(key.value, 10),
        beats: Math.max(1, Math.min(32, parseInt(beats.value, 10) || 4)),
        beatType: parseInt(beatType.value, 10),
        tempoBpm: Math.max(
          0.1,
          Math.min(
            999,
            Math.round(quarterBpmFromUnit(
              parseFloat(tempo.value)
                || tempoBpmForUnit(score.tempoBpm, displayedTempoUnit),
              displayedTempoUnit,
            ) * 10) / 10,
          ),
        ),
        tempoBeatUnit: displayedTempoUnit,
        keyboardKeyLabels: format.value === "keyboard" && keyboardKeyLabels.checked,
        keyboardTieAsZero: keyboardTieAsZero.checked,
        keyboardHideTieLabels: keyboardHideTieLabels.checked,
        slashBraceMode: braceMode.value as MidiSlashGroupMode,
        slashBracketMode: bracketMode.value as MidiSlashGroupMode,
        slashOrdering: ordering.value as MidiSlashOrdering,
      });
    };
    updateTempoUnit();
    updateVisibility();
    format.focus();
  });
}

/** Visible, non-destructive import error prompt used by every file importer. */
export function showImportFailureDialog(kind: string, error: unknown): void {
  document.querySelector(".import-failure-overlay")?.remove();
  const message = error instanceof Error ? error.message : String(error);
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay import-failure-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-modal", "true");
  const heading = document.createElement("div");
  heading.className = "modal-title";
  heading.textContent = "导入失败";
  const body = document.createElement("div");
  body.className = "midi-import-warning";
  body.textContent = `${kind} 导入失败：${message || "文件格式无效或内容不完整"}`;
  const hint = document.createElement("div");
  hint.className = "modal-hint";
  hint.textContent = "当前正在编辑的乐谱没有被替换。请检查文件格式后重试。";
  const footer = document.createElement("div");
  footer.className = "modal-footer";
  const close = document.createElement("button");
  close.textContent = "确定";
  footer.append(close);
  box.append(heading, body, hint, footer);
  overlay.append(box);
  document.body.append(overlay);
  const dismiss = (): void => overlay.remove();
  close.onclick = dismiss;
  overlay.onclick = (event) => {
    if (event.target === overlay) dismiss();
  };
  close.focus();
}
