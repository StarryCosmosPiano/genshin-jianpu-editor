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
  type SlashBraceMode,
  type SlashDurationDivision,
  type SlashGroupMode,
  type SlashScoreAnalysis,
  type SlashScoreKind,
  type SlashScoreOptions,
} from "../slashscore";

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
  return select;
}

function selectedDivision(select: HTMLSelectElement): SlashDurationDivision | null {
  const value = parseInt(select.value, 10);
  return DIVISIONS.includes(value as SlashDurationDivision) ? value as SlashDurationDivision : null;
}

function groupModeSelect(value: SlashGroupMode): HTMLSelectElement {
  const select = document.createElement("select");
  select.append(
    option("none", "留空（不指定特殊功能）", value === "none"),
    option("grace", "倚音：装饰音借用后方间隔，不增加小节拍长", value === "grace"),
    option("arpeggio", "琶音：括号内三个及以上音作为滚奏和弦", value === "arpeggio"),
    option("triplet", "三连音：括号内三个时值按 3:2 压缩", value === "triplet"),
    option("subdivide", "细分：最低时值÷2，并计入小节拍长", value === "subdivide"),
  );
  return select;
}

function fileStem(path: string): string {
  const leaf = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const stem = leaf.replace(/\.(?:txt|keyscore|numscore|kps|nps)$/i, "");
  try { return decodeURIComponent(stem); } catch { return stem; }
}

interface SymbolRow {
  glyph: HTMLInputElement;
  division: HTMLSelectElement;
  wrap: HTMLLabelElement;
}

type SlashDialogPurpose = "import" | "settings";

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
): Promise<SlashScoreOptions | null> {
  return new Promise((resolve) => {
    const defaults = defaultSlashScoreOptions(analysis.detectedKind, analysis);
    const initial: SlashScoreOptions = {
      ...defaults,
      ...seed,
      symbolDurations: { ...defaults.symbolDurations, ...seed?.symbolDurations },
    };
    if (!initial.title || initial.title === "未命名") initial.title = analysis.title || fileStem(fileName) || "未命名";

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
      key.append(option(String(fifths), `1=${MusicCommon.keys[fifths + 7]}`, fifths === initial.fifths));
    }
    const beats = document.createElement("input");
    beats.type = "number";
    beats.min = "1";
    beats.max = "32";
    beats.value = String(initial.beats);
    const beatType = document.createElement("select");
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
    mappingHint.textContent = "符号每出现一次就给相邻音符增加所选时值；例如“.”设为8分、“=”设为16分时，两个“=”会和一个“.”产生相同音长。符号栏留空但选择了时值时，代表把普通空格当作该时值；选择“不作为时值”才会忽略。";

    const symbols = [...new Set([...Object.keys(initial.symbolDurations), ...analysis.observedSymbols])];
    if (symbols.length === 0) symbols.push(".");
    while (symbols.length < 5) symbols.push("");
    const useMultipleSymbols = document.createElement("input");
    useMultipleSymbols.type = "checkbox";
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
    noteHint.textContent = "设置后，每个单音或括号和弦先具有一次所选基础时值，再叠加相邻空格和时值符号；括号里的多个键仍只算一个同时发声的和弦。";
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
    mappingDetails.append(
      mappingSummary,
      mappingHint,
      row("使用多种符号", useMultipleSymbols),
      symbolGrid,
      row("音符自身时值", noteWrap),
      row("空格时值", spaceWrap),
      row("空拍使用 / - /", emptyGroupWrap),
    );

    const braceMode = groupModeSelect(initial.braceMode);
    const bracketMode = groupModeSelect(initial.bracketMode ?? "triplet");
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
    const warning = document.createElement("div");
    warning.className = "midi-import-warning";
    warning.hidden = true;
    // Import may seed an inferred meter. Editing an existing document must
    // preserve its stored meter unless the user explicitly changes it.
    let meterTouched = purpose === "settings";

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
      );
      meterHint.textContent = `按当前符号推荐：${suggestion.beats}/${suggestion.beatType}；` +
        `典型每小节 ${suggestion.groupsPerMeasure} 个斜杠拍组，每组约 ${suggestion.groupQuarterNotes.toFixed(3)} 个四分音符。` +
        (selectedDivision(noteDivision) ? " 若分段按音符与空格自身时值明显超过一拍，会自动把每个 / 分段识别为整小节。" : "");
      if (!meterTouched) {
        beats.value = String(suggestion.beats);
        beatType.value = String(suggestion.beatType);
        updateTempoUnit();
      }
      const unmapped = analysis.observedSymbols.filter((symbol) => !(symbol in currentMappings()));
      warning.hidden = unmapped.length === 0;
      warning.textContent = unmapped.length ? `⚠ 未映射符号 ${unmapped.join("、")} 将作为注释忽略。` : "";
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
    kind.onchange = updateRecommendation;

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
      orderingRow,
      row("声部数量（1–9）", voiceCount),
      row("多声部乐器名称", instrumentName),
      row("速度（BPM）", tempo),
      row("调号", key),
      row(analysis.continuous ? "拍号（必填，用于分小节）" : "拍号（可修改）", meter),
      tempoUnitRow,
      meterHint,
      mappingDetails,
      row("花括号 {}", braceMode),
      row("方括号 []", bracketMode),
      warning,
      metadata,
      singleStaffHint,
      error,
      footer,
    );
    overlay.append(box);
    document.body.append(overlay);

    const readOptions = (): SlashScoreOptions => ({
      kind: kind.value as SlashScoreKind,
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
      emptyGroupsAsRests: emptyGroupsAsRests.checked,
      braceMode: braceMode.value as SlashBraceMode,
      bracketMode: bracketMode.value as SlashGroupMode,
      ordering: ordering.value as NonNullable<SlashScoreOptions["ordering"]>,
      tempoMarks: initial.tempoMarks?.map((mark) => ({ ...mark })) ?? [],
    });

    const close = (value: SlashScoreOptions | null) => { overlay.remove(); resolve(value); };
    cancel.onclick = () => close(null);
    overlay.onclick = (event) => { if (event.target === overlay) close(null); };
    confirm.onclick = () => {
      const value = readOptions();
      try {
        parseSlashScore(text, value);
        close(value);
      } catch (reason) {
        error.hidden = false;
        error.textContent = reason instanceof Error ? reason.message : String(reason);
      }
    };
    updateTempoUnit();
    updateSymbolRows();
    updateRecommendation();
    updateVoiceHint();
    kind.focus();
  });
}

/** Reuse the complete import configuration as an editor for the current slash-score document. */
export function showSlashScoreSettingsDialog(
  text: string,
  current: SlashScoreOptions,
): Promise<SlashScoreOptions | null> {
  const analysis = analyzeSlashScore(text);
  return showSlashScoreImportDialog(
    text,
    { ...analysis, detectedKind: current.kind },
    `${current.title.trim() || "当前乐谱"}.txt`,
    current,
    "settings",
  );
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
