// Minimal modal dialogs (replacing options.fxml / SimpleLayout.fxml).
import type { App } from "./app";
import { isTauriRuntime } from "./fileio";
import {
  DEFAULT_ENGRAVING_STYLE,
  ENGRAVING_STYLE_RANGES,
  normalizeEngravingStyle,
  type EngravingStyle,
  type NumericEngravingStyleKey,
  type RhythmGuideDivision,
  type RhythmGuideMode,
} from "../layout/style";

interface ModalOptions {
  okText?: string;
  cancelText?: string;
  boxClass?: string;
  onCancel?: () => void;
}

function modal(title: string, body: HTMLElement, onOk: () => void, options: ModalOptions = {}): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  if (options.boxClass) box.classList.add(options.boxClass);
  const h = document.createElement("div");
  h.className = "modal-title";
  h.textContent = title;
  const footer = document.createElement("div");
  footer.className = "modal-footer";
  const ok = document.createElement("button");
  ok.textContent = options.okText ?? "确定";
  const cancel = document.createElement("button");
  cancel.textContent = options.cancelText ?? "取消";
  footer.append(cancel, ok);
  box.append(h, body, footer);
  overlay.append(box);
  document.body.append(overlay);

  const close = () => overlay.remove();
  const cancelAndClose = () => {
    options.onCancel?.();
    close();
  };
  cancel.onclick = cancelAndClose;
  overlay.onclick = (e) => {
    if (e.target === overlay) cancelAndClose();
  };
  ok.onclick = () => {
    onOk();
    close();
  };
  (body.querySelector("input,select") as HTMLElement | null)?.focus();
}

function labeled(label: string, el: HTMLElement): HTMLElement {
  const row = document.createElement("label");
  row.className = "modal-row";
  const span = document.createElement("span");
  span.textContent = label;
  row.append(span, el);
  return row;
}

const RATIOS: Record<string, [number, number]> = {
  "16:9": [960, 540],
  "4:3": [720, 540],
  A4: [595, 842],
  A3: [842, 1191],
};

/** 选项 — page ratio + base font size. */
export function showOptionsDialog(app: App): void {
  const body = document.createElement("div");
  const documentFormat = document.createElement("select");
  for (const [value, text] of [
    ["jpw", "JPW 简谱"],
    ["keyboard", "键盘谱 TXT"],
    ["number", "数字谱 TXT"],
  ] as const) {
    const item = document.createElement("option");
    item.value = value;
    item.textContent = text;
    item.selected = app.documentFormat === value;
    documentFormat.append(item);
  }
  const sel = document.createElement("select");
  for (const k of Object.keys(RATIOS)) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k;
    const expected = [...RATIOS[k]].sort((a, b) => a - b);
    const current = [app.pageW, app.pageH].sort((a, b) => a - b);
    if (expected[0] === current[0] && expected[1] === current[1]) o.selected = true;
    sel.append(o);
  }
  const direction = document.createElement("select");
  const landscape = document.createElement("option");
  landscape.value = "landscape";
  landscape.textContent = "横向";
  landscape.selected = app.pageW >= app.pageH;
  const portrait = document.createElement("option");
  portrait.value = "portrait";
  portrait.textContent = "纵向";
  portrait.selected = app.pageH > app.pageW;
  direction.append(landscape, portrait);
  const fs = document.createElement("input");
  fs.type = "number";
  fs.min = "12";
  fs.max = "72";
  fs.value = String(app.fontSize);
  const titleSz = document.createElement("input");
  titleSz.type = "number";
  titleSz.min = "12";
  titleSz.max = "120";
  titleSz.value = String(app.titleSize);
  const creditSz = document.createElement("input");
  creditSz.type = "number";
  creditSz.min = "12";
  creditSz.max = "120";
  creditSz.value = String(app.creditSize);
  const color = document.createElement("input");
  color.type = "color";
  color.value = "#" + ((app.color >>> 0) & 0xffffff).toString(16).padStart(6, "0");
  const lines = document.createElement("input");
  lines.type = "text";
  lines.placeholder = "例如 4 或 4|3|3（留空=自动）";
  lines.value = app.getLinesPerPage();
  const instrumentName = document.createElement("input");
  instrumentName.type = "text";
  instrumentName.value = app.getInstrumentName();
  body.append(
    labeled("当前谱子类型", documentFormat),
    labeled("谱面比例", sel),
    labeled("页面方向", direction),
  );
  if (app.mode === "jp" && app.painter.score.piano) {
    body.append(labeled("乐器名称", instrumentName));
  }
  body.append(
    labeled("每页行数", lines),
    labeled("基础字号", fs),
    labeled("标题字号", titleSz),
    labeled("词曲信息字号", creditSz),
    labeled("颜色", color),
  );
  // 混排专属：隐藏小节号（仅混排模式下显示该选项）。
  const hideBarNum = document.createElement("input");
  hideBarNum.type = "checkbox";
  hideBarNum.checked = app.mixedHideBarNumber;
  if (app.mode === "mixed") {
    body.append(labeled("隐藏小节号", hideBarNum));
  }
  const voiceCount = document.createElement("input");
  voiceCount.type = "number";
  voiceCount.min = "1";
  voiceCount.max = "9";
  voiceCount.step = "1";
  voiceCount.value = String(app.getSlashVoiceCount());
  const voiceColorInputs: HTMLInputElement[] = [];
  const voiceColorEnabled: HTMLInputElement[] = [];
  const textVoiceColoring = document.createElement("input");
  textVoiceColoring.type = "checkbox";
  textVoiceColoring.checked = app.textVoiceColoring;
  const scoreVoiceColoring = document.createElement("input");
  scoreVoiceColoring.type = "checkbox";
  scoreVoiceColoring.checked = app.scoreVoiceColoring;
  const showVoiceMarkers = document.createElement("input");
  showVoiceMarkers.type = "checkbox";
  showVoiceMarkers.checked = app.showInvisibleVoiceMarkers;
  if (app.documentFormat !== "jpw") {
    const multi = document.createElement("details");
    multi.open = app.getSlashVoiceCount() > 1;
    const summary = document.createElement("summary");
    summary.textContent = "多声部 TXT";
    multi.append(
      summary,
      labeled("声部数量（V1–V9）", voiceCount),
      labeled("文本声部着色", textVoiceColoring),
      labeled("谱面声部着色", scoreVoiceColoring),
      labeled("显示隐形标记（调试）", showVoiceMarkers),
    );
    const voiceColorHint = document.createElement("div");
    voiceColorHint.className = "modal-hint";
    voiceColorHint.textContent =
      "“文本声部着色”是总开关，关闭不会删除下面各声部的颜色配置，重新开启即可恢复。最后一个默认声部始终不着色；其前各声部默认依次为红、黄、绿、紫，默认色不使用蓝色。";
    multi.append(voiceColorHint);
    const colorList = document.createElement("div");
    const refreshColors = () => {
      const count = Math.max(1, Math.min(9, parseInt(voiceCount.value, 10) || 1));
      const textColorsEnabled = textVoiceColoring.checked;
      colorList.replaceChildren();
      colorList.style.opacity = textColorsEnabled ? "1" : "0.55";
      while (voiceColorInputs.length < count) {
        const index = voiceColorInputs.length;
        const configured = app.slashVoiceColors[index] ?? "";
        const input = document.createElement("input");
        input.type = "color";
        input.value = /^#[\da-f]{6}$/i.test(configured) ? configured : "#6b7280";
        const enabled = document.createElement("input");
        enabled.type = "checkbox";
        enabled.checked = /^#[\da-f]{6}$/i.test(configured);
        enabled.addEventListener("change", refreshColors);
        voiceColorInputs.push(input);
        voiceColorEnabled.push(enabled);
      }
      for (let index = 0; index < count; index++) {
        const isDefault = index === count - 1;
        const control = document.createElement("span");
        control.style.cssText = "display:inline-flex;align-items:center;gap:8px";
        const enabledLabel = document.createElement("span");
        enabledLabel.textContent = "启用";
        voiceColorEnabled[index].disabled = isDefault || !textColorsEnabled;
        voiceColorInputs[index].disabled =
          isDefault || !textColorsEnabled || !voiceColorEnabled[index].checked;
        control.append(voiceColorEnabled[index], enabledLabel, voiceColorInputs[index]);
        colorList.append(labeled(
          `V${index + 1}${isDefault ? "（默认，不着色）" : ""} 文本颜色`,
          control,
        ));
      }
    };
    voiceCount.addEventListener("input", refreshColors);
    textVoiceColoring.addEventListener("change", refreshColors);
    refreshColors();
    multi.append(colorList);
    body.append(multi);
  }

  // Playback source and SF2 timbre assignment. The catalog is deliberately
  // not scanned here: it is populated at startup and by the explicit refresh button.
  const playback = document.createElement("details");
  playback.className = "soundfont-options";
  playback.open = app.playbackSoundSource === "sf2";
  const playbackSummary = document.createElement("summary");
  playbackSummary.textContent = "播放音源（SF2）";
  const soundSource = document.createElement("select");
  const defaultSourceOption = document.createElement("option");
  defaultSourceOption.value = "default";
  defaultSourceOption.textContent = "默认音源";
  const sf2SourceOption = document.createElement("option");
  sf2SourceOption.value = "sf2";
  sf2SourceOption.textContent = "SF2 音源";
  soundSource.append(defaultSourceOption, sf2SourceOption);
  soundSource.value = app.playbackSoundSource;

  const soundfontFile = document.createElement("select");
  const soundfontActions = document.createElement("span");
  soundfontActions.className = "soundfont-actions";
  const refreshSoundfonts = document.createElement("button");
  refreshSoundfonts.type = "button";
  refreshSoundfonts.textContent = "刷新音源";
  soundfontActions.append(refreshSoundfonts);
  const openSoundfontFolder = document.createElement("button");
  openSoundfontFolder.type = "button";
  openSoundfontFolder.textContent = "打开音源文件夹";
  if (isTauriRuntime()) soundfontActions.prepend(openSoundfontFolder);

  const soundfontStatus = document.createElement("div");
  soundfontStatus.className = "modal-hint soundfont-status";
  const assignmentList = document.createElement("div");
  assignmentList.className = "soundfont-assignment-list";
  const pendingAssignments = { ...app.soundfontInstrumentByGroup };

  const selectedCatalogEntry = () =>
    app.soundfontCatalog.find((entry) =>
      entry.id === soundfontFile.value && entry.instruments.length > 0);

  const renderAssignments = () => {
    assignmentList.replaceChildren();
    const entry = selectedCatalogEntry();
    if (!entry) {
      const empty = document.createElement("div");
      empty.className = "modal-hint";
      empty.textContent = "没有可分配的 SF2 音色。";
      assignmentList.append(empty);
      return;
    }
    const groups = app.getPlaybackInstrumentGroups();
    for (const group of groups) {
      const timbre = document.createElement("select");
      for (const instrument of entry.instruments) {
        const option = document.createElement("option");
        option.value = instrument;
        option.textContent = instrument;
        timbre.append(option);
      }
      const saved = pendingAssignments[group.key];
      timbre.value = saved && entry.instruments.includes(saved)
        ? saved
        : app.getSoundfontInstrument(group.key, entry.id);
      pendingAssignments[group.key] = timbre.value;
      timbre.addEventListener("change", () => {
        pendingAssignments[group.key] = timbre.value;
      });
      const voiceSuffix = group.parts.length > 1 ? `（${group.parts.length} 个声部）` : "";
      assignmentList.append(labeled(`${group.label}${voiceSuffix}音色`, timbre));
    }
  };

  const populateSoundfontFiles = (preferredId?: string) => {
    soundfontFile.replaceChildren();
    for (const entry of app.soundfontCatalog) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.disabled = entry.instruments.length === 0;
      option.textContent = entry.error
        ? `${entry.fileName}（无法读取）`
        : `${entry.fileName}（${entry.instruments.length} 个音色）`;
      soundfontFile.append(option);
    }
    const playable = app.soundfontCatalog.filter((entry) => entry.instruments.length > 0);
    if (playable.length === 0) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "未找到可用的 .sf2 文件";
      soundfontFile.replaceChildren(empty);
    }
    const selected = playable.find((entry) => entry.id === preferredId)
      ?? playable.find((entry) => entry.id === app.selectedSoundfontId)
      ?? playable[0];
    soundfontFile.value = selected?.id ?? "";
    sf2SourceOption.disabled = playable.length === 0;
    if (sf2SourceOption.disabled && soundSource.value === "sf2") soundSource.value = "default";
    soundfontStatus.textContent = playable.length > 0
      ? `已读取 ${playable.length} 个 SF2 音源；列表只在程序启动或手动刷新时更新。`
      : "未找到可用音源。桌面版可打开音源文件夹放入 .sf2 后手动刷新。";
    renderAssignments();
  };

  const syncSoundfontControls = () => {
    const enabled = soundSource.value === "sf2" && !sf2SourceOption.disabled;
    soundfontFile.disabled = !enabled;
    assignmentList.toggleAttribute("hidden", !enabled);
  };

  soundSource.addEventListener("change", syncSoundfontControls);
  soundfontFile.addEventListener("change", renderAssignments);
  refreshSoundfonts.addEventListener("click", () => {
    const preferredId = soundfontFile.value;
    refreshSoundfonts.disabled = true;
    refreshSoundfonts.textContent = "刷新中…";
    soundfontStatus.textContent = "正在重新读取 SF2 文件和音色…";
    void app.refreshSoundfonts()
      .then(() => {
        populateSoundfontFiles(preferredId);
        syncSoundfontControls();
      })
      .catch((error) => {
        soundfontStatus.textContent =
          "刷新失败：" + (error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        refreshSoundfonts.disabled = false;
        refreshSoundfonts.textContent = "刷新音源";
      });
  });
  openSoundfontFolder.addEventListener("click", () => {
    openSoundfontFolder.disabled = true;
    void app.openSoundfontFolder()
      .then(() => {
        soundfontStatus.textContent = "音源文件夹已打开；放入文件后请点击“刷新音源”。";
      })
      .catch((error) => {
        soundfontStatus.textContent =
          "打开文件夹失败：" + (error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        openSoundfontFolder.disabled = false;
      });
  });

  populateSoundfontFiles(app.selectedSoundfontId);
  syncSoundfontControls();
  playback.append(
    playbackSummary,
    labeled("播放方式", soundSource),
    labeled("SF2 文件", soundfontFile),
    soundfontActions,
    soundfontStatus,
    assignmentList,
  );
  body.append(playback);

  // 播放混音：各声部音量（0–100%，播放/导出 MIDI 时按此写入 CC7；改后需重新播放）。
  const volSliders: HTMLInputElement[] = [];
  if (app.mode === "jp" && app.partCount > 1) {
    const hint = document.createElement("div");
    hint.style.cssText = "margin-top:8px;font-weight:600;opacity:0.8";
    hint.textContent = "声部音量（播放/导出 MIDI）";
    body.append(hint);
    for (let i = 0; i < app.partCount; i++) {
      const s = document.createElement("input");
      s.type = "range";
      s.min = "0";
      s.max = "100";
      s.value = String(Math.round(app.getPartVolume(i) * 100));
      volSliders.push(s);
      body.append(labeled(app.getPartLabel(i), s));
    }
  }
  modal("选项", body, () => {
    if (app.documentFormat !== "jpw") {
      app.setSlashVoiceSettings(
        parseInt(voiceCount.value, 10) || 1,
        voiceColorInputs.map((input, index) =>
          voiceColorEnabled[index]?.checked ? input.value : ""),
        scoreVoiceColoring.checked,
        showVoiceMarkers.checked,
        textVoiceColoring.checked,
      );
    }
    volSliders.forEach((s, i) => app.setPartVolume(i, (parseInt(s.value, 10) || 0) / 100));
    app.setPlaybackSoundSettings(
      soundSource.value === "sf2" ? "sf2" : "default",
      soundfontFile.value,
      pendingAssignments,
    );
    const [ratioW, ratioH] = RATIOS[sel.value] ?? [app.pageW, app.pageH];
    const short = Math.min(ratioW, ratioH);
    const long = Math.max(ratioW, ratioH);
    const [w, h] = direction.value === "portrait" ? [short, long] : [long, short];
    const fontSize = parseInt(fs.value, 10) || app.fontSize;
    const titleSize = parseInt(titleSz.value, 10) || app.titleSize;
    const creditSize = parseInt(creditSz.value, 10) || app.creditSize;
    const argb = 0xff000000 | (parseInt(color.value.slice(1), 16) & 0xffffff);
    const linesVal = lines.value.trim();
    if (linesVal !== app.getLinesPerPage()) app.setLinesPerPage(linesVal);
    if (app.mode === "jp" && app.painter.score.piano && instrumentName.value.trim() !== app.getInstrumentName()) {
      app.setInstrumentName(instrumentName.value);
    }
    app.applyRenderSettings({ pageW: w, pageH: h, fontSize, titleSize, creditSize, color: argb >>> 0 });
    if (app.mode === "mixed") void app.setMixedHideBarNumber(hideBarNum.checked);
    if (documentFormat.value !== app.documentFormat) {
      void app.changeDocumentFormat(documentFormat.value as "jpw" | "keyboard" | "number");
    }
  }, { boxClass: "options-box" });
}

type NumericStyleKey = NumericEngravingStyleKey;

function renderEngravingPreview(svg: SVGSVGElement, style: EngravingStyle, instrumentName: string, app?: App): void {
  const actual = app?.renderEngravingStylePreview(style);
  if (actual) {
    svg.setAttribute("viewBox", actual.getAttribute("viewBox") ?? "0 0 620 220");
    svg.setAttribute("preserveAspectRatio", "xMidYMin meet");
    svg.dataset.previewSource = "actual-layout";
    svg.innerHTML = actual.innerHTML;
    return;
  }
  const numberSize = 27 * style.numberScale;
  const chordGap = numberSize * style.chordRowGap;
  const dotSize = numberSize * style.octaveDotScale;
  const dotRadius = dotSize * 0.08;
  const dotGap = numberSize * 0.055 * style.octaveDotDistance;
  const dotClearance = numberSize * 0.12 * style.octaveDotClearance;
  const automaticChordGap = Math.max(
    chordGap,
    numberSize * 0.78 + dotGap + dotRadius * 2 + dotClearance,
  );
  const rightY = 68;
  const leftY = rightY + 72 * (style.pianoHandGap / DEFAULT_ENGRAVING_STYLE.pianoHandGap);
  const topChordBaseline = rightY - automaticChordGap * 2;
  // Match the real renderer: an upper octave dot is positioned above the
  // tight top of the owning digit, not merely above its text baseline.
  const highDotRawY = topChordBaseline - numberSize * 0.78 - dotGap - dotRadius;
  const lowDotRawY = leftY + numberSize * 0.1 + dotGap + dotRadius;
  const top = Math.min(20, highDotRawY - dotRadius - numberSize * 0.2);
  const rhythmGuideRawY = leftY + numberSize * 0.72;
  const currentSystemBottomRaw = Math.max(
    leftY + numberSize * 0.22,
    style.rhythmGuideEnabled ? rhythmGuideRawY + numberSize * 0.12 : 0,
  );
  const nextSystemBaselineRaw = currentSystemBottomRaw
    + numberSize * 2 * style.systemGapScale
    + numberSize * 0.78;
  const horizontalPreviewRawY = nextSystemBaselineRaw + numberSize * 1.65;
  const bottom = Math.max(
    lowDotRawY + dotRadius + numberSize * 0.25,
    style.rhythmGuideEnabled ? rhythmGuideRawY + numberSize * 0.12 : 0,
    nextSystemBaselineRaw + numberSize * 0.25,
    horizontalPreviewRawY + numberSize * 0.65,
  );
  const headerReserve = 44;
  const height = bottom - top + 30 + headerReserve;
  const y = (value: number) => value - top + 12 + headerReserve;
  const lineTop = y(rightY - numberSize * 0.85);
  const lineBottom = y(leftY + numberSize * 0.22);
  const braceWidth = 14 * style.braceWidthScale;
  const braceGlyphWidth = Math.max(braceWidth * 0.2, braceWidth - style.braceStrokeWidth);
  const instrumentFontSize = 15 / 1.5;
  const instrumentWidth = Math.min(96, Math.max(20, Array.from(instrumentName).length * instrumentFontSize));
  const lineX = Math.max(82, 8 + instrumentWidth + 8 + braceWidth + 3);
  const braceRight = lineX - 3;
  const braceLeft = braceRight - braceWidth;
  const braceChar = String.fromCharCode(0xe000);
  const braceScaleX = braceGlyphWidth / (28 * 0.08);
  const braceScaleY = (lineBottom - lineTop) / 28;
  const xChord = lineX + 63;
  const xSecond = xChord + 94 * style.noteGapScale;
  const xBar = xSecond + 78 * style.noteGapScale;
  const finalX = 575;
  const secondFinalX = finalX + style.finalBarlineWidth + style.finalBarlineGap;
  const weight = style.numberBold ? "bold" : "normal";
  const highDotY = y(highDotRawY);
  const lowDotY = y(lowDotRawY);
  const rhythmGuideY = y(rhythmGuideRawY);
  // The sample contains sixteenth notes. Auto therefore detects 16; manual
  // shows exactly the user-selected shortest value. The sample meter is 4/4.
  const rhythmMinorDivision = style.rhythmGuideMode === "auto" ? 16 : Math.max(4, style.rhythmGuideDivision);
  const rhythmMajorEvery = rhythmMinorDivision / 4;
  const rhythmStartX = xChord;
  const rhythmEndX = xBar + 70 * style.noteGapScale;
  const rhythmStroke = Math.max(0.8, numberSize * 0.038);
  const rhythmMarkup = style.rhythmGuideEnabled ? `
    <g data-preview-rhythm-guide="true" data-preview-rhythm-mode="${style.rhythmGuideMode}" data-preview-rhythm-division="${rhythmMinorDivision}">
      <line x1="${rhythmStartX}" y1="${rhythmGuideY}" x2="${rhythmEndX}" y2="${rhythmGuideY}" stroke="currentColor" stroke-width="${rhythmStroke}"/>
      ${Array.from({ length: rhythmMinorDivision }, (_, index) => {
        const x = rhythmStartX + (rhythmEndX - rhythmStartX) * index / rhythmMinorDivision;
        const major = index % rhythmMajorEvery === 0;
        const tickHeight = numberSize * (major ? 0.34 : 0.18);
        return `<line data-preview-rhythm-tick="${major ? "major" : "minor"}" x1="${x}" y1="${rhythmGuideY}" x2="${x}" y2="${rhythmGuideY - tickHeight}" stroke="currentColor" stroke-width="${rhythmStroke}"/>`;
      }).join("")}
    </g>` : "";
  const text = (value: string, x: number, baseline: number, size = numberSize, attrs = "") =>
    `<text ${attrs} x="${x}" y="${baseline}" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="${size}" font-weight="${weight}" fill="currentColor">${value}</text>`;
  const nextSystemY = y(nextSystemBaselineRaw);
  const nextSystemMarkup = `
    <g data-preview-next-system="true">
      <text x="${braceLeft - 8}" y="${nextSystemY}" text-anchor="end" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="10" fill="currentColor">下一谱行</text>
      ${text("1", xChord, nextSystemY)}
      ${text("2", xSecond, nextSystemY)}
      <line x1="${xBar}" y1="${nextSystemY - numberSize * 0.82}" x2="${xBar}" y2="${nextSystemY + numberSize * 0.18}" stroke="currentColor" stroke-width="${style.barlineWidth}"/>
      ${text("3", xBar + 70 * style.noteGapScale, nextSystemY)}
    </g>`;
  const targetMeasureCount = Math.max(1, Math.round(style.measuresPerSystem));
  const shownMeasureCount = Math.min(12, targetMeasureCount);
  const horizontalPreviewY = y(horizontalPreviewRawY);
  const previewLeft = 18;
  const previewRight = 602;
  const previewMeasureWidth = (previewRight - previewLeft) / shownMeasureCount;
  const previewPadding = Math.min(10, previewMeasureWidth * 0.13);
  const previewDeltas = [0, 1, 0.5, 0.25];
  const previewWeights = previewDeltas.map((delta, index) => index === 0
    ? 0
    : style.rhythmicSpacingEnabled ? Math.pow(delta, style.rhythmicSpacingExponent) : 1);
  const previewWeightTotal = previewWeights.reduce((sum, value) => sum + value, 0);
  let previewWeight = 0;
  const previewNoteXs = previewWeights.map((value, index) => {
    if (index > 0) previewWeight += value;
    return previewLeft + previewPadding
      + (previewMeasureWidth - previewPadding * 2) * previewWeight / Math.max(1, previewWeightTotal);
  });
  const horizontalLayoutMarkup = `
    <g data-preview-horizontal-layout="true" data-preview-measures="${targetMeasureCount}" data-preview-spacing="${style.rhythmicSpacingEnabled ? "rhythmic" : "equal"}">
      <text x="${previewLeft}" y="${horizontalPreviewY - numberSize * 0.72}" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="11" fill="currentColor">目标 ${targetMeasureCount} 小节 · ${style.rhythmicSpacingEnabled ? `时值比例 ${style.rhythmicSpacingExponent.toFixed(2)}` : "等距兼容"}</text>
      <line x1="${previewLeft}" y1="${horizontalPreviewY}" x2="${previewRight}" y2="${horizontalPreviewY}" stroke="currentColor" stroke-width="0.8" opacity="0.45"/>
      ${Array.from({ length: shownMeasureCount + 1 }, (_, index) => {
        const x = previewLeft + previewMeasureWidth * index;
        return `<line x1="${x}" y1="${horizontalPreviewY - numberSize * 0.46}" x2="${x}" y2="${horizontalPreviewY + numberSize * 0.12}" stroke="currentColor" stroke-width="${index === shownMeasureCount ? style.finalBarlineWidth : style.barlineWidth}" opacity="0.75"/>`;
      }).join("")}
      ${previewNoteXs.map((x, index) => text(String(index + 1), x, horizontalPreviewY - numberSize * 0.08, numberSize * 0.58)).join("")}
    </g>`;
  const escapedInstrument = instrumentName.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!);

  svg.setAttribute("viewBox", `0 0 620 ${height}`);
  svg.innerHTML = `
    <text data-preview-meta="true" x="8" y="30" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="${numberSize * 0.87}" fill="currentColor">1=C  4/4  ♩=90</text>
    <text x="${braceLeft - 8}" y="${(lineTop + lineBottom) / 2 + instrumentFontSize * 0.35}" text-anchor="end" font-family="PingFang SC, Microsoft YaHei, Microsoft YaHei UI, Noto Sans CJK SC, Yu Gothic UI, Meiryo, Malgun Gothic, sans-serif" font-size="${instrumentFontSize}" fill="currentColor">${escapedInstrument}</text>
    <text data-preview-brace="true" x="0" y="0" font-family="Bravura" font-size="28" fill="currentColor" stroke="currentColor" stroke-width="${style.braceStrokeWidth}" stroke-linejoin="round" paint-order="stroke fill" vector-effect="non-scaling-stroke" transform="translate(${braceLeft + style.braceStrokeWidth / 2} ${lineBottom}) scale(${braceScaleX} ${braceScaleY})">${braceChar}</text>
    <line x1="${lineX}" y1="${lineTop}" x2="${lineX}" y2="${lineBottom}" stroke="currentColor" stroke-width="${style.pianoLeftLineWidth}"/>
    ${text("5", xChord, y(topChordBaseline), numberSize, 'data-preview-number="high-owner"')}
    ${text("3", xChord, y(rightY - automaticChordGap))}
    ${text("1", xChord, y(rightY))}
    <circle data-preview-octave="high" cx="${xChord}" cy="${highDotY}" r="${dotRadius}" fill="currentColor"/>
    ${text("2", xSecond, y(rightY))}
    ${text("5", xChord, y(leftY))}
    <circle data-preview-octave="low" cx="${xChord}" cy="${lowDotY}" r="${dotRadius}" fill="currentColor"/>
    ${text("1", xSecond, y(leftY))}
    ${rhythmMarkup}
    ${nextSystemMarkup}
    ${horizontalLayoutMarkup}
    <line x1="${xBar}" y1="${lineTop}" x2="${xBar}" y2="${lineBottom}" stroke="currentColor" stroke-width="${style.barlineWidth * style.pianoConnectorScale}"/>
    ${text("6", xBar + 70 * style.noteGapScale, y(rightY))}
    ${text("3", xBar + 70 * style.noteGapScale, y(leftY))}
    <line x1="${finalX}" y1="${lineTop}" x2="${finalX}" y2="${lineBottom}" stroke="currentColor" stroke-width="${style.finalBarlineWidth * style.pianoConnectorScale}"/>
    <line x1="${secondFinalX}" y1="${lineTop}" x2="${secondFinalX}" y2="${lineBottom}" stroke="currentColor" stroke-width="${style.finalBarlineWidth * style.pianoConnectorScale}"/>
  `;
}

/** Live global controls for numbered-notation engraving geometry. */
export function showEngravingStyleDialog(app: App): void {
  const original = normalizeEngravingStyle(app.engravingStyle);
  const instrumentName = app.painter.score.instrumentName.trim() || "钢琴";
  const body = document.createElement("div");
  body.className = "engraving-dialog-body";

  const hint = document.createElement("div");
  hint.className = "modal-hint engraving-hint";
  hint.textContent = "拖动时只更新这里的独立样张，不会改动当前谱面或总谱；点击“应用到整个软件”后才会保存并重新排版所有简谱。";
  const preview = document.createElement("div");
  preview.className = "engraving-preview";
  const previewSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  previewSvg.setAttribute("aria-label", "全局简谱排版独立实时预览");
  preview.append(previewSvg);

  const controls = document.createElement("div");
  controls.className = "engraving-controls";
  const numericInputs = new Map<NumericStyleKey, HTMLInputElement>();
  const outputs = new Map<NumericStyleKey, HTMLOutputElement>();
  const formatters = new Map<NumericStyleKey, (value: number) => string>();

  const section = (title: string): HTMLDivElement => {
    const el = document.createElement("div");
    el.className = "engraving-section";
    const h = document.createElement("div");
    h.className = "engraving-section-title";
    h.textContent = title;
    el.append(h);
    controls.append(el);
    return el;
  };
  const addRange = (
    target: HTMLElement,
    labelText: string,
    key: NumericStyleKey,
    min: number,
    max: number,
    step: number,
    format: (value: number) => string,
  ): void => {
    const row = document.createElement("label");
    row.className = "engraving-control";
    const label = document.createElement("span");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "range";
    input.name = key;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(original[key]);
    const output = document.createElement("output");
    output.textContent = format(original[key]);
    input.setAttribute("aria-label", labelText);
    numericInputs.set(key, input);
    outputs.set(key, output);
    formatters.set(key, format);
    row.append(label, input, output);
    target.append(row);
  };
  const addStyleRange = (
    target: HTMLElement,
    labelText: string,
    key: NumericStyleKey,
    format: (value: number) => string,
  ): void => {
    const [min, max, step] = ENGRAVING_STYLE_RANGES[key];
    addRange(target, labelText, key, min, max, step, format);
  };

  const numberSection = section("数字、和弦与点");
  addStyleRange(numberSection, "数字大小", "numberScale", (v) => `${v.toFixed(2)}×`);
  const bold = document.createElement("input");
  bold.type = "checkbox";
  bold.name = "numberBold";
  bold.checked = original.numberBold;
  numberSection.append(labeled("数字加粗", bold));
  addStyleRange(numberSection, "和弦最小间距", "chordRowGap", (v) => `${v.toFixed(2)}×`);
  addStyleRange(numberSection, "八度点大小", "octaveDotScale", (v) => `${v.toFixed(2)}×`);
  addStyleRange(numberSection, "八度点贴音距离", "octaveDotDistance", (v) => `${v.toFixed(2)}×`);
  addStyleRange(numberSection, "八度点与相邻音留白", "octaveDotClearance", (v) => `${v.toFixed(2)}×`);
  addStyleRange(numberSection, "升降号大小", "accidentalScale", (v) => `${v.toFixed(2)}×`);
  addStyleRange(numberSection, "升降号与数字间距", "accidentalGapScale", (v) => `${v.toFixed(2)}×`);
  const tieContinuationGray = document.createElement("input");
  tieContinuationGray.type = "checkbox";
  tieContinuationGray.name = "tieContinuationGray";
  tieContinuationGray.checked = original.tieContinuationGray;
  numberSection.append(labeled("延音线续音变灰", tieContinuationGray));
  addStyleRange(numberSection, "数字横向间距", "noteGapScale", (v) => `${v.toFixed(2)}×`);

  const pageSection = section("页面与谱行");
  addStyleRange(pageSection, "谱行上下间距", "systemGapScale", (v) => `${v.toFixed(2)}×`);
  addStyleRange(pageSection, "每行目标小节数", "measuresPerSystem", (v) => `${Math.round(v)} 小节`);
  const rhythmicSpacingEnabled = document.createElement("input");
  rhythmicSpacingEnabled.type = "checkbox";
  rhythmicSpacingEnabled.name = "rhythmicSpacingEnabled";
  rhythmicSpacingEnabled.checked = original.rhythmicSpacingEnabled;
  pageSection.append(labeled("按时值分配音符间距", rhythmicSpacingEnabled));
  addStyleRange(pageSection, "时值间距强度", "rhythmicSpacingExponent", (v) => v.toFixed(2));
  const justifyLastSystem = document.createElement("input");
  justifyLastSystem.type = "checkbox";
  justifyLastSystem.name = "justifyLastSystem";
  justifyLastSystem.checked = original.justifyLastSystem;
  pageSection.append(labeled("末行铺满左右边界", justifyLastSystem));
  const systemGapHint = document.createElement("div");
  systemGapHint.className = "modal-hint";
  systemGapHint.textContent = "该间距会参与自动分页；调小时，下一页能放下的谱行会自动回填到上一页。";
  pageSection.append(systemGapHint);

  const rhythmSection = section("节奏刻度线");
  const rhythmGuideEnabled = document.createElement("input");
  rhythmGuideEnabled.type = "checkbox";
  rhythmGuideEnabled.name = "rhythmGuideEnabled";
  rhythmGuideEnabled.checked = original.rhythmGuideEnabled;
  rhythmSection.append(labeled("显示节奏刻度线（默认开启）", rhythmGuideEnabled));
  const rhythmGuideMode = document.createElement("select");
  rhythmGuideMode.name = "rhythmGuideMode";
  rhythmGuideMode.setAttribute("aria-label", "刻度模式");
  for (const [value, text] of [["auto", "自动（读取谱面）"], ["manual", "手动"]] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    rhythmGuideMode.append(option);
  }
  rhythmGuideMode.value = original.rhythmGuideMode;
  rhythmSection.append(labeled("刻度模式", rhythmGuideMode));
  const rhythmGuideDivision = document.createElement("select");
  rhythmGuideDivision.name = "rhythmGuideDivision";
  rhythmGuideDivision.setAttribute("aria-label", "手动最短时值");
  for (const division of [4, 8, 16, 32, 64] as const) {
    const option = document.createElement("option");
    option.value = String(division);
    option.textContent = `${division} 分音符`;
    rhythmGuideDivision.append(option);
  }
  rhythmGuideDivision.value = String(original.rhythmGuideDivision);
  rhythmGuideDivision.disabled = original.rhythmGuideMode !== "manual";
  rhythmSection.append(labeled("手动最短时值", rhythmGuideDivision));
  const rhythmHint = document.createElement("div");
  rhythmHint.className = "modal-hint";
  rhythmHint.textContent = "长刻度始终落在拍号的每一拍。自动模式按各小节实际最短时值补短刻度；手动模式固定使用指定的 4 / 8 / 16 / 32 / 64 分网格。";
  rhythmSection.append(rhythmHint);

  const headerSection = section("标题与谱首信息");
  headerSection.classList.add("engraving-section-wide");
  addStyleRange(headerSection, "标题字号", "publicationTitleScale", (v) => `${v.toFixed(2)}×`);
  addStyleRange(headerSection, "标题水平位置", "publicationTitleX", (v) => `${Math.round(v * 100)}%`);
  addStyleRange(headerSection, "标题垂直微调", "publicationTitleYOffset", (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} 行`);
  addStyleRange(headerSection, "副标题字号", "publicationSubtitleScale", (v) => `${v.toFixed(2)}×`);
  addStyleRange(headerSection, "副标题水平位置", "publicationSubtitleX", (v) => `${Math.round(v * 100)}%`);
  addStyleRange(headerSection, "副标题垂直微调", "publicationSubtitleYOffset", (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} 行`);
  addStyleRange(headerSection, "调号拍号速度字号", "publicationMetaScale", (v) => `${v.toFixed(2)}×`);
  addStyleRange(headerSection, "调号拍号速度水平位置", "publicationMetaX", (v) => `${Math.round(v * 100)}%`);
  addStyleRange(headerSection, "调号拍号速度垂直位置", "publicationMetaYOffset", (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} 行`);
  addStyleRange(headerSection, "第一谱行与调拍速度距离", "publicationFirstSystemGap", (v) => `${v.toFixed(2)} 行`);
  addStyleRange(headerSection, "作词作曲字号", "publicationCreditScale", (v) => `${v.toFixed(2)}×`);
  addStyleRange(headerSection, "作词作曲水平位置", "publicationCreditX", (v) => `${Math.round(v * 100)}%`);
  addStyleRange(headerSection, "作词作曲垂直微调", "publicationCreditYOffset", (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} 行`);

  const pianoSection = section("钢琴双手系统（仅双行谱）");
  pianoSection.classList.add("engraving-section-double");
  addStyleRange(pianoSection, "左右手行距", "pianoHandGap", (v) => `${v.toFixed(2)}×`);
  addStyleRange(pianoSection, "花括号宽度", "braceWidthScale", (v) => `${v.toFixed(2)}×`);
  addStyleRange(pianoSection, "花括号粗细", "braceStrokeWidth", (v) => `${v.toFixed(1)} px`);
  addStyleRange(pianoSection, "左侧竖线粗细", "pianoLeftLineWidth", (v) => `${v.toFixed(1)} px`);
  addStyleRange(pianoSection, "上下连接线粗细", "pianoConnectorScale", (v) => `${v.toFixed(2)}×`);

  const barSection = section("小节线与终止线");
  addStyleRange(barSection, "普通小节线", "barlineWidth", (v) => `${v.toFixed(1)} px`);
  addStyleRange(barSection, "双实线粗细", "finalBarlineWidth", (v) => `${v.toFixed(1)} px`);
  addStyleRange(barSection, "双实线间距", "finalBarlineGap", (v) => `${v.toFixed(1)} px`);

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "engraving-reset";
  reset.textContent = "恢复默认参数";
  body.append(hint, preview, controls, reset);

  const readStyle = (): EngravingStyle => {
    const value = {
      ...DEFAULT_ENGRAVING_STYLE,
      numberBold: bold.checked,
      tieContinuationGray: tieContinuationGray.checked,
      rhythmicSpacingEnabled: rhythmicSpacingEnabled.checked,
      justifyLastSystem: justifyLastSystem.checked,
      rhythmGuideEnabled: rhythmGuideEnabled.checked,
      rhythmGuideMode: rhythmGuideMode.value as RhythmGuideMode,
      rhythmGuideDivision: parseInt(rhythmGuideDivision.value, 10) as RhythmGuideDivision,
    } as EngravingStyle;
    for (const [key, input] of numericInputs) value[key] = parseFloat(input.value);
    return normalizeEngravingStyle(value);
  };
  const writeStyle = (style: EngravingStyle): void => {
    bold.checked = style.numberBold;
    tieContinuationGray.checked = style.tieContinuationGray;
    rhythmicSpacingEnabled.checked = style.rhythmicSpacingEnabled;
    justifyLastSystem.checked = style.justifyLastSystem;
    rhythmGuideEnabled.checked = style.rhythmGuideEnabled;
    rhythmGuideMode.value = style.rhythmGuideMode;
    rhythmGuideDivision.value = String(style.rhythmGuideDivision);
    rhythmGuideDivision.disabled = style.rhythmGuideMode !== "manual";
    for (const [key, input] of numericInputs) input.value = String(style[key]);
  };
  const updateOutputs = (style: EngravingStyle): void => {
    for (const [key, output] of outputs) {
      output.textContent = formatters.get(key)!(style[key]);
    }
  };

  const refresh = (): void => {
    const style = readStyle();
    const spacingExponent = numericInputs.get("rhythmicSpacingExponent");
    if (spacingExponent) spacingExponent.disabled = !style.rhythmicSpacingEnabled;
    rhythmGuideDivision.disabled = style.rhythmGuideMode !== "manual";
    updateOutputs(style);
    renderEngravingPreview(previewSvg, style, instrumentName, app);
  };
  for (const input of numericInputs.values()) input.addEventListener("input", refresh);
  bold.addEventListener("change", refresh);
  tieContinuationGray.addEventListener("change", refresh);
  rhythmGuideEnabled.addEventListener("change", refresh);
  rhythmGuideMode.addEventListener("change", refresh);
  rhythmGuideDivision.addEventListener("change", refresh);
  reset.onclick = () => {
    writeStyle(normalizeEngravingStyle(DEFAULT_ENGRAVING_STYLE));
    refresh();
  };
  renderEngravingPreview(previewSvg, original, instrumentName, app);

  modal("全局排版样式", body, () => {
    app.setEngravingStyle(readStyle(), true);
  }, {
    okText: "应用到整个软件",
    boxClass: "engraving-box",
  });
}
