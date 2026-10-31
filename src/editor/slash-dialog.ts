import {
  formatTempoBpm,
  MusicCommon,
  quarterBpmFromUnit,
  tempoBpmForUnit,
  type TempoBeatUnit,
} from "../score/score";
import {
  analyzeSlashScore,
  defaultSlashScoreOptions,
  inferSlashMeter,
  parseSlashScore,
  rewriteSlashDurationDirectives,
  type SlashBraceMode,
  type SlashDurationDivision,
  type SlashGroupMode,
  type SlashScoreAnalysis,
  type SlashScoreKind,
  type SlashScoreOptions,
} from "../slashscore";
import { fileStem } from "./file-format";
import { openInspector } from "../ui/inspector";
import { retainDetailsScroll } from "../ui/details-scroll-retention";
import { SlashScorePreview } from "./slash-score-preview";
import { blockImportBackground } from "../ui/import-dialog";
import { reencodeSourceTimedRows } from "../slashscore/add-slashes";

const DIVISIONS: SlashDurationDivision[] = [4, 8, 16, 32, 64];

function option(value: string, text: string, selected = false): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = text;
  item.selected = selected;
  return item;
}

function row(label: string, control: HTMLElement): HTMLLabelElement {
  const item = document.createElement("label");
  item.className = "modal-row";
  const caption = document.createElement("span");
  caption.textContent = label;
  item.append(caption, control);
  return item;
}

function divisionSelect(value: SlashDurationDivision | null): HTMLSelectElement {
  const select = document.createElement("select");
  select.append(option("", "留空（不作为时值）", value === null));
  for (const division of DIVISIONS) select.append(option(String(division), `${division} 分音符`, value === division));
  // Preserve a generated fine value without adding it to new MIDI/grid choices.
  if (value === 128) select.append(option("128", "128 分音符", true));
  return select;
}

function selectedDivision(select: HTMLSelectElement): SlashDurationDivision | null {
  const value = parseInt(select.value, 10);
  return value === 128 || DIVISIONS.includes(value as SlashDurationDivision) ? value as SlashDurationDivision : null;
}

function groupModeSelect(value: SlashGroupMode): HTMLSelectElement {
  const select = document.createElement("select");
  if (value === "subdivide") {
    // Keep old documents round-trippable without exposing subdivision as a
    // new choice. New documents use implicit compact notation instead.
    const legacy = option("subdivide", "旧版细分（兼容读取）", true);
    legacy.hidden = true;
    select.append(legacy);
  }
  select.append(
    option("none", "留空（不指定特殊功能）", value === "none"),
    option("chord", "和弦：括号内音符同时发声", value === "chord"),
    option("grace", "倚音：括号内音符作为装饰音，不增加小节拍长", value === "grace"),
    option("arpeggio", "琶音：括号内三个及以上音作为滚奏和弦", value === "arpeggio"),
    option("triplet", "三连音：括号内三个时值按 3:2 压缩", value === "triplet"),
    option("trill", "颤音：括号内音符仅作装饰，不增加小节拍长", value === "trill"),
  );
  return select;
}

interface SymbolRow {
  glyph: HTMLInputElement;
  division: HTMLSelectElement;
  wrap: HTMLLabelElement;
}

type SlashDialogPurpose = "import" | "settings";

export interface SlashScoreImportResult {
  text: string;
  options: SlashScoreOptions;
}

function activeSymbolRows(rows: SymbolRow[], multiple: boolean): SymbolRow[] {
  return multiple ? rows : rows.slice(0, 1);
}

function collectMappings(
  rows: SymbolRow[],
  multiple: boolean,
): Record<string, SlashDurationDivision> {
  const mappings: Record<string, SlashDurationDivision> = {};
  for (const item of activeSymbolRows(rows, multiple)) {
    const glyph = Array.from(item.glyph.value)[0];
    const division = selectedDivision(item.division);
    if (glyph && glyph !== " " && division) mappings[glyph] = division;
  }
  return mappings;
}

function mappedSpaceDivision(
  rows: SymbolRow[],
  multiple: boolean,
  fallback: HTMLSelectElement,
): SlashDurationDivision | null {
  for (const item of activeSymbolRows(rows, multiple)) {
    if (item.glyph.value !== "" && item.glyph.value !== " ") continue;
    const division = selectedDivision(item.division);
    if (division) return division;
  }
  return selectedDivision(fallback);
}

/** Configure and validate a keyboard/number slash score before it replaces the current editor text. */
export function showSlashScoreImportDialog(
  text: string,
  analysis: SlashScoreAnalysis,
  fileName: string,
  seed?: Partial<SlashScoreOptions>,
  purpose: SlashDialogPurpose = "import",
): Promise<SlashScoreImportResult | null> {
  return new Promise((resolve) => {
    const defaults = defaultSlashScoreOptions(analysis.detectedKind, analysis);
    const initial: SlashScoreOptions = {
      ...defaults,
      ...seed,
      symbolDurations: seed?.symbolDurations
        ? { ...seed.symbolDurations }
        : { ...defaults.symbolDurations },
    };
    if (!initial.title || initial.title === "未命名") initial.title = analysis.title || fileStem(fileName) || "未命名";
    const sourceOptions = structuredClone(initial);
    const rewritesDurations = purpose === "import" && sourceOptions.sourceTimedRows === true;
    const requiresSymbolMapping = purpose === "import" && !rewritesDurations && analysis.requiresSymbolMapping === true;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const box = document.createElement("div");
    box.className = "modal-box slash-import-box";
    const heading = document.createElement("div");
    heading.className = "modal-title";
    heading.textContent = purpose === "settings"
      ? "乐谱设置"
      : fileName.startsWith("新建") ? "创建斜杠谱" : "导入键盘谱 / 数字谱";

    const info = document.createElement("div");
    info.className = "midi-import-info";
    info.textContent = purpose === "settings"
      ? `正在设置当前${initial.kind === "keyboard" ? "键盘谱" : "数字谱"} · ${analysis.measureCount} 小节；应用后会立即重新解析、排版并用于播放。`
      : `识别为${analysis.detectedKind === "keyboard" ? "键盘谱" : "数字谱"} · ${analysis.measureCount} 小节 · ` +
        `${analysis.commentCount} 行说明作为注释保留 · 忽略 ${analysis.ignoredTagCount} 个 line/end 标签` +
        (analysis.continuous ? " · 未发现小节换行，将按下方拍号自动分割" : "");

    const kind = document.createElement("select");
    kind.append(
      option("keyboard", "键盘谱（A–Z）", initial.kind === "keyboard"),
      option("number", "数字谱（1–7、+/- 八度）", initial.kind === "number"),
    );
    const kindHint = document.createElement("div");
    kindHint.className = "modal-hint";
    kindHint.textContent = "文本同时含键盘谱和数字谱时，两种正文都会原样保留；当前只解析这里选择的谱型，另一种谱行不参与小节、休止、播放和右侧排版。";
    const keyboardKeyLabels = document.createElement("input");
    keyboardKeyLabels.type = "checkbox";
    keyboardKeyLabels.checked = initial.keyboardKeyLabels ?? false;
    const keyboardKeyLabelsHint = document.createElement("small");
    keyboardKeyLabelsHint.textContent = "只替换右侧谱面的 1–7 为 A–Z 键位；音高、延音、播放和导出保持不变。超出 Z–U 三排范围时用上下加点表示额外八度。";
    const keyboardKeyLabelsRow = row("谱面显示键盘按键", keyboardKeyLabels);
    keyboardKeyLabelsRow.append(keyboardKeyLabelsHint);
    keyboardKeyLabelsRow.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:12px;row-gap:3px";
    keyboardKeyLabels.style.cssText = "width:18px;min-width:18px;height:18px;justify-self:end;margin:0";
    keyboardKeyLabelsHint.style.cssText = "grid-column:1/-1;display:block;min-width:0;max-width:none;text-align:left;color:var(--muted);line-height:1.5";
    const keyboardTieAsZero = document.createElement("input");
    keyboardTieAsZero.type = "checkbox";
    keyboardTieAsZero.checked = initial.keyboardTieAsZero ?? false;
    const keyboardTieAsZeroRow = row("延音用 0 替代", keyboardTieAsZero);
    keyboardTieAsZeroRow.style.paddingLeft = "28px";
    keyboardTieAsZeroRow.title = "只替换延音线后面的续音字母，不会把它变成休止符";
    const keyboardHideTieLabels = document.createElement("input");
    keyboardHideTieLabels.type = "checkbox";
    keyboardHideTieLabels.checked = initial.keyboardHideTieLabels ?? false;
    const keyboardHideTieLabelsRow = row("隐藏延音字母", keyboardHideTieLabels);
    keyboardHideTieLabelsRow.style.paddingLeft = "28px";
    keyboardHideTieLabelsRow.title = "保留延音线与节奏标记但隐藏续音字母；与“延音用 0 替代”同时开启时优先隐藏";
    const voiceCount = document.createElement("input");
    voiceCount.type = "number";
    voiceCount.min = "1";
    voiceCount.max = "9";
    voiceCount.step = "1";
    voiceCount.value = String(initial.voiceCount);
    const instrumentName = document.createElement("input");
    instrumentName.type = "text";
    instrumentName.value = initial.instrumentName?.trim() || "钢琴";
    const title = document.createElement("input");
    title.type = "text";
    title.value = initial.title;
    const tempo = document.createElement("input");
    tempo.type = "number";
    tempo.min = "0.1";
    tempo.max = "1998";
    tempo.step = "0.1";

    const key = document.createElement("select");
    for (let fifths = -7; fifths <= 7; fifths++) {
      const rawName = MusicCommon.keys[fifths + 7];
      const displayName = rawName.startsWith("#") || rawName.startsWith("b")
        ? `${rawName.slice(1)}${rawName[0]}`
        : rawName;
      key.append(option(String(fifths), `1=${displayName}`, fifths === initial.fifths));
    }
    const beats = document.createElement("input");
    beats.type = "number";
    beats.dataset.slashImport = "beats";
    beats.min = "1";
    beats.max = "32";
    beats.value = String(initial.beats);
    const beatType = document.createElement("select");
    beatType.dataset.slashImport = "beat-type";
    for (const value of [2, 4, 8, 16]) beatType.append(option(String(value), String(value), value === initial.beatType));
    const meter = document.createElement("span");
    meter.className = "midi-meter-control";
    meter.append(beats, document.createTextNode(" / "), beatType);
    const tempoUnit = document.createElement("select");
    tempoUnit.append(
      option("dotted-quarter", "附点四分音符"),
      option("eighth", "八分音符"),
    );
    const tempoUnitRow = row("速度音符", tempoUnit);
    let displayedTempoUnit: TempoBeatUnit = initial.tempoBeatUnit ?? "quarter";
    let quarterTempo = initial.tempoBpm;
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
      const isEighthMeter = parseInt(beatType.value, 10) === 8;
      tempoUnitRow.hidden = !isEighthMeter;
      tempoUnitRow.style.display = isEighthMeter ? "" : "none";
      if (!isEighthMeter) {
        setDisplayedTempoUnit("quarter");
      } else if (displayedTempoUnit === "quarter") {
        const count = parseInt(beats.value, 10) || 0;
        setDisplayedTempoUnit(count >= 6 && count % 3 === 0
          ? "dotted-quarter"
          : "eighth");
      }
    };
    tempo.addEventListener("input", () => {
      const entered = parseFloat(tempo.value);
      if (Number.isFinite(entered)) {
        quarterTempo = quarterBpmFromUnit(entered, displayedTempoUnit);
      }
    });
    tempoUnit.addEventListener("change", () => {
      setDisplayedTempoUnit(tempoUnit.value as TempoBeatUnit);
    });

    const mappingDetails = document.createElement("details");
    mappingDetails.open = true;
    const mappingSummary = document.createElement("summary");
    mappingSummary.textContent = "时值符号对应（可全部自定义）";
    const mappingHint = document.createElement("div");
    mappingHint.className = "modal-hint";
    mappingHint.textContent = rewritesDurations
      ? "这里选择导入后的符号写法，音长按第一步确认的时值保持不变。例如原来的 + 是八分音符，改用三十二分音符的 . 后，一个 + 会换成四个点。目标符号须能表达原谱最短时值；可切换右侧“文本谱”查看结果。"
      : "符号每出现一次就给相邻音符增加所选时值；例如“.”设为8分、“=”设为16分时，两个“=”会和一个“.”产生相同音长。符号栏留空但选择了时值时，代表把普通空格当作该时值；选择“不作为时值”才会忽略。";

    const symbols = [...new Set([...Object.keys(initial.symbolDurations), ...analysis.observedSymbols])];
    while (symbols.length < 5) symbols.push("");
    const useMultipleSymbols = document.createElement("input");
    useMultipleSymbols.type = "checkbox";
    useMultipleSymbols.dataset.slashImport = "multiple-symbols";
    useMultipleSymbols.checked = initial.multiDurationSymbols ?? false;
    const symbolGrid = document.createElement("div");
    symbolGrid.className = "slash-symbol-grid";
    const symbolRows: SymbolRow[] = symbols.map((symbol, index) => {
      const glyph = document.createElement("input");
      glyph.type = "text";
      glyph.maxLength = 2;
      glyph.placeholder = "留空";
      glyph.value = symbol;
      glyph.setAttribute("aria-label", `时值符号 ${index + 1}`);
      const division = divisionSelect(symbol ? initial.symbolDurations[symbol] ?? null : null);
      const wrap = document.createElement("label");
      wrap.className = "slash-symbol-row";
      const caption = document.createElement("span");
      caption.textContent = `符号 ${index + 1}`;
      wrap.append(caption, glyph, division);
      symbolGrid.append(wrap);
      return { glyph, division, wrap };
    });
    const spaceDivision = divisionSelect(initial.spaceDivision);
    spaceDivision.name = "spaceDivision";
    const spaceHint = document.createElement("small");
    spaceHint.textContent = "设置后，行首空格并入第一个音，音符之间和行尾空格并入前一个音；不会单独生成休止。未设置时空格只是排版。";
    const spaceWrap = document.createElement("span");
    spaceWrap.className = "slash-space-control";
    spaceWrap.append(spaceDivision, spaceHint);
    const noteDivision = divisionSelect(initial.noteDivision);
    noteDivision.name = "noteDivision";
    const noteHint = document.createElement("small");
      noteHint.textContent = "设置后，每个单音、和弦括号或三连音括号整体先占一次所选时值，再叠加紧随其后的空格和时值符号。三连音内部按各成员的相对时值分配整组时长；例如设为16分音符时，[QWE]整组占一个16分音符。";
    const noteWrap = document.createElement("span");
    noteWrap.className = "slash-space-control";
    noteWrap.append(noteDivision, noteHint);
    const emptyGroupsAsRests = document.createElement("input");
    emptyGroupsAsRests.type = "checkbox";
    emptyGroupsAsRests.checked = initial.emptyGroupsAsRests ?? false;
    const emptyGroupHint = document.createElement("small");
    emptyGroupHint.textContent = "开启后，完全没有新起音的整拍写成“/ - /”；关闭时继续使用当前时值符号填满。";
    const emptyGroupWrap = document.createElement("span");
    emptyGroupWrap.className = "slash-space-control";
    emptyGroupWrap.append(emptyGroupsAsRests, emptyGroupHint);
    const showExplicitRests = document.createElement("input");
    showExplicitRests.type = "checkbox";
    showExplicitRests.checked = initial.showExplicitRests ?? true;
    const explicitRestsHint = document.createElement("small");
    explicitRestsHint.textContent = "关闭后内部空拍由前一个音延长填充，开头静默仍保留休止符。";
    const explicitRestsWrap = document.createElement("span");
    explicitRestsWrap.className = "slash-space-control";
    explicitRestsWrap.append(showExplicitRests, explicitRestsHint);
    mappingDetails.append(
      mappingSummary,
      mappingHint,
      row("使用多种符号", useMultipleSymbols),
      symbolGrid,
      row("音符自身时值", noteWrap),
      row("空格时值", spaceWrap),
      row("空拍使用 / - /", emptyGroupWrap),
      row("保留 0 休止符", explicitRestsWrap),
    );

    const braceMode = groupModeSelect(initial.braceMode ?? "arpeggio");
    const bracketMode = groupModeSelect(initial.bracketMode ?? "triplet");
    const barMode = groupModeSelect(initial.barMode ?? "none");
    // Angle brackets now use the compact (stuck-together) notation implicitly;
    // the legacy `subdivide` value is still accepted by the parser but is not
    // offered as a new setting.
    const angleMode = groupModeSelect(initial.angleMode ?? "grace");
    const parenMode = groupModeSelect(initial.parenMode ?? "chord");
    const bracketFields = [
      { id: "brace", label: "花括号 {}", control: braceMode },
      { id: "bracket", label: "方括号 []", control: bracketMode },
      { id: "bar", label: "竖线括号 | |", control: barMode },
      { id: "angle", label: "尖括号 <>", control: angleMode },
      { id: "paren", label: "圆括号 ()", control: parenMode },
    ] as const;
    for (const field of bracketFields) field.control.dataset.slashImport = field.id;
    const bracketWarning = document.createElement("div");
    bracketWarning.className = "midi-import-warning slash-bracket-warning";
    bracketWarning.dataset.slashImport = "bracket-warning";
    bracketWarning.setAttribute("role", "status");
    const ordering = document.createElement("select");
    ordering.append(
      option("pitch-asc", "音高正序（低音到高音）", (initial.ordering ?? "pitch-asc") === "pitch-asc"),
      option("pitch-desc", "音高逆序（高音到低音）", initial.ordering === "pitch-desc"),
      option("voice-asc", "声部正序（V1 到默认声部）", initial.ordering === "voice-asc"),
      option("voice-desc", "声部逆序（默认声部到 V1）", initial.ordering === "voice-desc"),
    );
    const orderingRow = row("和弦书写顺序", ordering);

    const meterHint = document.createElement("div");
    meterHint.className = "slash-meter-hint";
    meterHint.dataset.slashImport = "meter-hint";
    const warning = document.createElement("div");
    warning.className = "midi-import-warning";
    warning.hidden = true;
    // Import may seed an inferred meter. Editing an existing document must
    // preserve its stored meter unless the user explicitly changes it.
    let meterTouched = purpose === "settings" || seed?.beats !== undefined || initial.sourceTimedRows === true;

    const currentMappings = () => collectMappings(symbolRows, useMultipleSymbols.checked);
    const currentSpaceDivision = () => mappedSpaceDivision(
      symbolRows,
      useMultipleSymbols.checked,
      spaceDivision,
    );
    const updateSymbolRows = () => {
      symbolRows.forEach((item, index) => {
        const enabled = useMultipleSymbols.checked || index === 0;
        item.wrap.hidden = !enabled;
        item.wrap.style.display = enabled ? "" : "none";
        item.glyph.disabled = !enabled;
        item.division.disabled = !enabled;
      });
    };
    const updateRecommendation = () => {
      const suggestion = inferSlashMeter(
        text,
        currentMappings(),
        currentSpaceDivision(),
        braceMode.value as SlashBraceMode,
        selectedDivision(noteDivision),
        bracketMode.value as SlashGroupMode,
        kind.value as SlashScoreKind,
        {
          barMode: barMode.value as SlashGroupMode,
          angleMode: angleMode.value as SlashGroupMode,
          parenMode: parenMode.value as SlashGroupMode,
        },
      );
      // The initial analysis compares competing timing interpretations. Do
      // not turn its uncertain candidate into apparently certain evidence by
      // running that candidate through the meter estimator a second time.
      const requiresMeterInput = !meterTouched
        ? analysis.requiresMeterInput === true || suggestion.requiresInput === true
        : suggestion.requiresInput ?? analysis.requiresMeterInput ?? false;
      meterHint.textContent = initial.sourceTimedRows
        ? rewritesDurations ? "按第一步确认的音长换写目标符号；右侧预览显示最终导入结果。"
          : "按原文符号累计时值，保留音符与符号写法；右侧谱面随设置更新。"
        : requiresMeterInput ? "未能可靠识别拍号，请手动填写拍号后再导入；可先核对音符自身、空格和实际时值符号。"
        : `${analysis.timingInferred ? "已按音符和空格时值识别，优先常用拍号" : "按当前时值推荐"}：${suggestion.beats}/${suggestion.beatType}；` +
        `典型每小节 ${suggestion.groupsPerMeasure} 个斜杠拍组，每组约 ${suggestion.groupQuarterNotes.toFixed(3)} 个四分音符。` +
        (selectedDivision(noteDivision) ? " 若分段按音符与空格自身时值明显超过一拍，会自动把每个 / 分段识别为整小节。" : "");
      if (!meterTouched) {
        beats.value = requiresMeterInput ? "" : String(suggestion.beats);
        beats.placeholder = requiresMeterInput ? "请填写" : "";
        beatType.value = String(suggestion.beatType);
        updateTempoUnit();
      }
      const detectedBrackets = bracketFields.filter(field => analysis.observedDelimiters?.includes(field.id));
      const unassignedBrackets = detectedBrackets.filter(field => field.control.value === "none");
      bracketWarning.hidden = detectedBrackets.length === 0;
      bracketWarning.textContent = detectedBrackets.length
        ? `检测到${detectedBrackets.map(field => field.label).join("、")}，请核对下方对应括号用途。` +
          (unassignedBrackets.length
            ? `${unassignedBrackets.map(field => field.label).join("、")}尚未指定用途；如需三连音、琶音或其他作用，请手动填写。`
            : "当前用途将用于导入，可按原谱说明修改。")
        : "";
      const unmapped = rewritesDurations ? [] : analysis.observedSymbols.filter((symbol) => !(symbol in currentMappings()));
      warning.hidden = unmapped.length === 0;
      warning.textContent = unmapped.length ? `⚠ 未映射符号 ${unmapped.join("、")} ` +
        (initial.sourceTimedRows || requiresSymbolMapping ? "须指定时值后导入。" : "将作为注释忽略。") : "";
    };
    beats.oninput = () => {
      meterTouched = true;
      updateTempoUnit();
    };
    beatType.onchange = () => {
      meterTouched = true;
      updateTempoUnit();
    };
    for (const item of symbolRows) {
      item.glyph.oninput = updateRecommendation;
      item.division.onchange = updateRecommendation;
    }
    useMultipleSymbols.onchange = () => {
      updateSymbolRows();
      updateRecommendation();
    };
    spaceDivision.onchange = updateRecommendation;
    noteDivision.onchange = updateRecommendation;
    braceMode.onchange = updateRecommendation;
    bracketMode.onchange = updateRecommendation;
    barMode.onchange = updateRecommendation;
    angleMode.onchange = updateRecommendation;
    parenMode.onchange = updateRecommendation;
    const updateKindControls = () => {
      const visible = kind.value === "keyboard";
      keyboardKeyLabelsRow.hidden = !visible;
      keyboardKeyLabelsRow.style.display = visible ? "grid" : "none";
      const tieOptionsVisible = visible && keyboardKeyLabels.checked;
      keyboardTieAsZeroRow.hidden = !tieOptionsVisible;
      keyboardTieAsZeroRow.style.display = tieOptionsVisible ? "" : "none";
      keyboardHideTieLabelsRow.hidden = !tieOptionsVisible;
      keyboardHideTieLabelsRow.style.display = tieOptionsVisible ? "" : "none";
    };
    keyboardKeyLabels.onchange = updateKindControls;
    kind.onchange = () => {
      updateKindControls();
      updateRecommendation();
    };

    const metadata = document.createElement("details");
    const metadataSummary = document.createElement("summary");
    metadataSummary.textContent = "标题与署名（可选）";
    const subtitle = document.createElement("input");
    subtitle.type = "text";
    subtitle.value = initial.subtitle;
    subtitle.placeholder = "可留空";
    const composer = document.createElement("input");
    composer.type = "text";
    composer.value = initial.composer;
    composer.placeholder = "可留空";
    const arranger = document.createElement("input");
    arranger.type = "text";
    arranger.value = initial.arranger;
    arranger.placeholder = "可留空";
    const lyricist = document.createElement("input");
    lyricist.type = "text";
    lyricist.value = initial.lyricist;
    lyricist.placeholder = "可留空";
    metadata.append(
      metadataSummary,
      row("标题", title),
      row("副标题", subtitle),
      row("作曲", composer),
      row("编曲", arranger),
      row("作词", lyricist),
    );

    const singleStaffHint = document.createElement("div");
    singleStaffHint.className = "modal-hint";
    const updateVoiceHint = () => {
      const count = clampInt(voiceCount.value, 1, 9, initial.voiceCount);
      singleStaffHint.textContent = count === 1
        ? "导入后为单个简谱谱表；同拍音自动组成纵向和弦，低音在下、高音在上。其他文字作为注释保留。"
        : `导入后按 V1–V${count} 从上到下显示；没有隐形标记的音属于默认 V${count}，各声部会独立补休止并延续到自己的下一次起音。`;
    };
    voiceCount.addEventListener("input", updateVoiceHint);
    const error = document.createElement("div");
    error.className = "midi-import-warning";
    error.dataset.slashImport = "error";
    error.dataset.slashImport = "error";
    error.hidden = true;

    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    const confirm = document.createElement("button");
    const updateConfirmLabel = () => {
      if (purpose === "settings") {
        confirm.textContent = "应用到当前乐谱";
        return;
      }
      const count = clampInt(voiceCount.value, 1, 9, initial.voiceCount);
      confirm.textContent = count === 1 ? "导入为单行简谱" : `导入为 ${count} 声部简谱`;
    };
    voiceCount.addEventListener("input", updateConfirmLabel);
    updateConfirmLabel();
    footer.append(cancel, confirm);
    box.append(
      heading,
      info,
      row("谱子类型", kind),
      kindHint,
      keyboardKeyLabelsRow,
      keyboardTieAsZeroRow,
      keyboardHideTieLabelsRow,
      orderingRow,
      row("声部数量（1–9）", voiceCount),
      row("多声部乐器名称", instrumentName),
      row("速度（BPM）", tempo),
      row("调号", key),
      row(analysis.continuous ? "拍号（必填，用于分小节）" : "拍号（可修改）", meter),
      tempoUnitRow,
      meterHint,
      mappingDetails,
      bracketWarning,
      row("花括号 {}", braceMode),
      row("方括号 []", bracketMode),
      row("竖线括号 | |", barMode),
      row("尖括号 <>", angleMode),
      row("圆括号 ()", parenMode),
      warning,
      metadata,
      singleStaffHint,
      error,
      footer,
    );
    const preview = purpose === "import" ? new SlashScorePreview() : null;
    const importControls = document.createElement("div");
    let releaseBackground: (() => void) | null = null;
    if (purpose === "import") {
      box.classList.add("slash-import-preview-box");
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-label", heading.textContent ?? "导入乐谱");
      importControls.className = "slash-import-preview-controls";
      const body = document.createElement("div");
      body.className = "slash-import-preview-body";
      // Keep existing controls/classes intact; only the import modal gains a
      // separate score pane. The settings inspector keeps its existing layout.
      for (const item of Array.from(box.children)) {
        if (item !== heading && item !== footer) importControls.append(item);
      }
      body.append(importControls, preview!.element);
      box.insertBefore(body, footer);
      overlay.append(box);
      document.body.append(overlay);
      releaseBackground = blockImportBackground(overlay);
    }
    const releaseImportScroll = purpose === "import" ? retainDetailsScroll(importControls, importControls) : null;

    const readOptions = (): SlashScoreOptions => ({
      headerTypography: initial.headerTypography,
      // These semantic fields have no controls, but must survive a fresh
      // import/settings apply when the accepted options replace the footer.
      annotations: structuredClone(initial.annotations ?? []),
      noteTimingEdits: structuredClone(initial.noteTimingEdits ?? []),
      kind: kind.value as SlashScoreKind,
      keyboardKeyLabels: kind.value === "keyboard" && keyboardKeyLabels.checked,
      keyboardTieAsZero: keyboardTieAsZero.checked,
      keyboardHideTieLabels: keyboardHideTieLabels.checked,
      voiceCount: clampInt(voiceCount.value, 1, 9, analysis.voiceCount),
      instrumentName: instrumentName.value.trim() || "钢琴",
      title: title.value.trim() || fileStem(fileName) || "未命名",
      subtitle: subtitle.value.trim(),
      composer: composer.value.trim(),
      arranger: arranger.value.trim(),
      lyricist: lyricist.value.trim(),
      tempoBpm: Math.max(
        0.1,
        Math.min(
          999,
          Math.round(quarterBpmFromUnit(
            parseFloat(tempo.value) || tempoBpmForUnit(analysis.tempoBpm, displayedTempoUnit),
            displayedTempoUnit,
          ) * 10) / 10,
        ),
      ),
      tempoBeatUnit: displayedTempoUnit,
      fifths: clampInt(key.value, -7, 7, analysis.fifths),
      beats: clampInt(beats.value, 1, 32, analysis.meter.beats),
      beatType: [2, 4, 8, 16].includes(parseInt(beatType.value, 10)) ? parseInt(beatType.value, 10) : 4,
      symbolDurations: currentMappings(),
      multiDurationSymbols: useMultipleSymbols.checked,
      spaceDivision: currentSpaceDivision(),
      noteDivision: selectedDivision(noteDivision),
      sourceTimedRows: initial.sourceTimedRows,
      adjacentAsChord: initial.adjacentAsChord,
      wholeMeasureGroups: initial.wholeMeasureGroups || analysis.wholeMeasureGroups
        ? true
        : undefined,
      emptyGroupsAsRests: emptyGroupsAsRests.checked,
      showExplicitRests: showExplicitRests.checked,
      braceMode: braceMode.value as SlashBraceMode,
      bracketMode: bracketMode.value as SlashGroupMode,
      barMode: barMode.value as SlashGroupMode,
      angleMode: angleMode.value as SlashGroupMode,
      parenMode: parenMode.value as SlashGroupMode,
      ordering: ordering.value as NonNullable<SlashScoreOptions["ordering"]>,
      tempoMarks: initial.tempoMarks?.map((mark) => ({ ...mark })) ?? [],
      keyChanges: initial.keyChanges?.map((change) => ({ ...change })) ?? [],
    });

    const prepareDraft = (): SlashScoreImportResult => {
      const enteredBeats = Number(beats.value);
      const enteredBeatType = Number(beatType.value);
      if (!beats.value.trim() || !Number.isInteger(enteredBeats) || enteredBeats < 1 || enteredBeats > 32
        || ![2, 4, 8, 16].includes(enteredBeatType)) {
        throw new Error("请手动填写有效拍号（拍数为 1–32 的整数）。");
      }
      const options = readOptions();
      if (requiresSymbolMapping) {
        const unmapped = analysis.observedSymbols.filter(symbol => !(symbol in options.symbolDurations));
        if (unmapped.length) throw new Error(`请为时值符号 ${unmapped.join("、")} 分别填写时值；多种符号请开启“使用多种符号”。`);
      }
      if (!rewritesDurations) return { text, options };
      const result = reencodeSourceTimedRows(text, sourceOptions, options);
      if (!result.canImport) throw new Error(result.errors[0] || "当前符号不能准确表达原谱时值，请调整符号时值。");
      const hasDurationInstructions = /^\s*(?:点|两个点|符号\s*[（(].*?[）)]|空格|音符(?:自身时值)?|音自身时值|[^\sA-Za-z0-9\u3400-\u9fff])\s*[=＝：:]/im.test(text);
      const output = result.text !== text && hasDurationInstructions
        ? rewriteSlashDurationDirectives(result.text, result.options)
        : result.text;
      return { text: output, options: result.options };
    };
    const updatePreview = (): void => {
      if (!preview) return;
      try {
        const draft = prepareDraft();
        error.hidden = true;
        confirm.disabled = false;
        preview.set(draft.text, draft.options);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        error.hidden = false;
        error.textContent = message;
        confirm.disabled = true;
        preview.showError(message, text);
      }
    };

    let dirty = false;
    const markDirty = () => {
      dirty = true;
    };
    const settingsBody = document.createElement("div");
    settingsBody.className = "slash-settings-body";
    if (purpose === "settings") {
      const section = (name: string, initiallyOpen = false): HTMLDetailsElement => {
        const details = document.createElement("details");
        details.className = "inspector-section";
        details.open = initiallyOpen;
        const summary = document.createElement("summary");
        summary.textContent = name;
        details.append(summary);
        settingsBody.append(details);
        return details;
      };
      settingsBody.append(info);
      const notation = section("谱型与声部", true);
      notation.append(
        row("谱子类型", kind), kindHint,
        keyboardKeyLabelsRow, keyboardTieAsZeroRow, keyboardHideTieLabelsRow,
        orderingRow, row("声部数量（1–9）", voiceCount),
        row("多声部乐器名称", instrumentName), singleStaffHint,
      );
      const rhythm = section("调号、拍号与速度", true);
      rhythm.append(
        row("调号", key),
        row(analysis.continuous ? "拍号（必填，用于分小节）" : "拍号（可修改）", meter),
        row("速度（BPM）", tempo), tempoUnitRow, meterHint,
      );
      const notationRules = section("时值与括号规则");
      notationRules.append(
        mappingDetails,
        bracketWarning,
        row("花括号 {}", braceMode), row("方括号 []", bracketMode),
        row("竖线括号 | |", barMode), row("尖括号 <>", angleMode),
        row("圆括号 ()", parenMode), warning,
      );
      metadata.open = false;
      metadata.classList.add("inspector-section");
      settingsBody.append(metadata, error);
      settingsBody.addEventListener("input", markDirty);
      settingsBody.addEventListener("change", markDirty);
    } else {
      box.addEventListener("input", markDirty);
      box.addEventListener("change", markDirty);
      box.addEventListener("input", updatePreview);
      box.addEventListener("change", updatePreview);
    }

    const onImportKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(null);
    };
    const close = (value: SlashScoreImportResult | null) => {
      releaseImportScroll?.();
      preview?.destroy();
      document.removeEventListener("keydown", onImportKeyDown, true);
      overlay.remove();
      releaseBackground?.();
      resolve(value);
    };
    const validatedDraft = (): SlashScoreImportResult | null => {
      try {
        const draft = prepareDraft();
        parseSlashScore(draft.text, draft.options);
        error.hidden = true;
        return draft;
      } catch (reason) {
        error.hidden = false;
        error.textContent = reason instanceof Error ? reason.message : String(reason);
        error.scrollIntoView({ block: "nearest" });
        return null;
      }
    };
    const applyAndClose = () => {
      const value = validatedDraft();
      if (value) close(value);
    };
    updateTempoUnit();
    updateKindControls();
    updateSymbolRows();
    updateRecommendation();
    // Import suggestions initialize the form once. Later changes recompute
    // the hint without replacing a meter the user is reviewing or editing.
    meterTouched = true;
    updateVoiceHint();
    updatePreview();
    if (purpose === "settings") {
      let appliedOptions: SlashScoreOptions | null = null;
      let releaseSettingsScroll: (() => void) | null = null;
      const onHeaderChanged = (event: Event): void => {
        if (!settingsBody.isConnected) return;
        const changes = (event as CustomEvent<Partial<SlashScoreOptions>>).detail;
        if (!changes || typeof changes !== "object") return;
        if ("headerTypography" in changes) initial.headerTypography = changes.headerTypography;
        for (const [field, input] of [
          ["title", title], ["subtitle", subtitle], ["composer", composer],
          ["arranger", arranger], ["lyricist", lyricist],
        ] as const) {
          if (changes[field] === undefined) continue;
          initial[field] = changes[field];
          input.value = changes[field];
        }
        if (changes.fifths !== undefined) {
          initial.fifths = changes.fifths;
          key.value = String(changes.fifths);
        }
        if (changes.beats !== undefined) {
          initial.beats = changes.beats;
          beats.value = String(changes.beats);
        }
        if (changes.beatType !== undefined) {
          initial.beatType = changes.beatType;
          beatType.value = String(changes.beatType);
        }
        if (changes.tempoBpm !== undefined) {
          initial.tempoBpm = changes.tempoBpm;
          quarterTempo = changes.tempoBpm;
        }
        if (changes.tempoBeatUnit !== undefined) {
          initial.tempoBeatUnit = changes.tempoBeatUnit;
          displayedTempoUnit = changes.tempoBeatUnit;
        }
        if (changes.tempoBpm !== undefined || changes.tempoBeatUnit !== undefined) {
          tempo.value = formatTempoBpm(tempoBpmForUnit(quarterTempo, displayedTempoUnit));
          if (displayedTempoUnit !== "quarter") tempoUnit.value = displayedTempoUnit;
        }
        if (changes.tempoMarks !== undefined) {
          initial.tempoMarks = changes.tempoMarks.map((mark) => ({ ...mark }));
        }
        if (changes.keyChanges !== undefined) {
          initial.keyChanges = changes.keyChanges.map((change) => ({ ...change }));
        }
        updateTempoUnit();
      };
      document.addEventListener("editor:header-changed", onHeaderChanged);
      void openInspector({
        id: "score",
        title: "乐谱",
        body: settingsBody,
        isDirty: () => dirty,
        onApply: () => {
          // Applying an untouched inspector is a close operation. Avoid
          // materializing timing overlays or rewriting the saved document.
          if (!dirty) {
            appliedOptions = null;
            return true;
          }
          appliedOptions = validatedDraft()?.options ?? null;
          return appliedOptions !== null;
        },
        onClosed: (applied) => {
          releaseSettingsScroll?.();
          document.removeEventListener("editor:header-changed", onHeaderChanged);
          resolve(applied && appliedOptions ? { text, options: appliedOptions } : null);
        },
        applyText: "应用到当前乐谱",
        initialFocus: kind,
      }).then((opened) => {
        if (!opened) {
          document.removeEventListener("editor:header-changed", onHeaderChanged);
          resolve(null);
          return;
        }
        const content = settingsBody.closest<HTMLElement>(".inspector-content");
        if (content) releaseSettingsScroll = retainDetailsScroll(settingsBody, content);
      });
      return;
    }
    cancel.onclick = () => close(null);
    document.addEventListener("keydown", onImportKeyDown, true);
    confirm.onclick = applyAndClose;
    kind.focus();
  });
}

/** Reuse the complete import configuration as an editor for the current slash-score document. */
export async function showSlashScoreSettingsDialog(
  text: string,
  current: SlashScoreOptions,
): Promise<SlashScoreOptions | null> {
  const analysis = analyzeSlashScore(text);
  const result = await showSlashScoreImportDialog(
    text,
    { ...analysis, detectedKind: current.kind },
    `${current.title.trim() || "当前乐谱"}.txt`,
    current,
    "settings",
  );
  return result?.options ?? null;
}

export function showCreateScoreDialog(): Promise<"jpw" | SlashScoreKind | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const box = document.createElement("div");
    box.className = "modal-box create-score-box";
    const heading = document.createElement("div");
    heading.className = "modal-title";
    heading.textContent = "创建谱子";
    const hint = document.createElement("div");
    hint.className = "modal-hint";
    hint.textContent = "选择编辑格式。键盘谱和数字谱都会实时转换为单行简谱预览。";
    const choices = document.createElement("div");
    choices.className = "create-score-choices";
    const add = (value: "jpw" | SlashScoreKind, title: string, detail: string) => {
      const button = document.createElement("button");
      const strong = document.createElement("strong");
      strong.textContent = title;
      const small = document.createElement("small");
      small.textContent = detail;
      button.append(strong, small);
      button.onclick = () => close(value);
      choices.append(button);
    };
    add("jpw", "JPW 简谱", ".jpwabc 原生格式，支持完整排版语法");
    add("keyboard", "键盘谱", "A–Z 键位、斜杠拍组、括号和弦");
    add("number", "数字谱", "1–7 数字、+/- 八度、斜杠拍组");
    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    footer.append(cancel);
    box.append(heading, hint, choices, footer);
    overlay.append(box);
    document.body.append(overlay);
    const close = (value: "jpw" | SlashScoreKind | null) => { overlay.remove(); resolve(value); };
    cancel.onclick = () => close(null);
    overlay.onclick = (event) => { if (event.target === overlay) close(null); };
  });
}

function clampInt(value: string, min: number, max: number, fallback: number): number {
  const parsed = parseInt(value, 10);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}
