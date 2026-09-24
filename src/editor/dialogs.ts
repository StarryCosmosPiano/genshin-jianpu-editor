// Minimal modal dialogs (replacing options.fxml / SimpleLayout.fxml).
import type { App, PageRenderSettings } from "./app";
import { openInspector } from "../ui/inspector";
import { retainDetailsScroll } from "../ui/details-scroll-retention";
import { getThemePreference, setThemePreference, type ThemePreference } from "../ui/theme";
import { openLayoutPreviewPane } from "../ui/layout-preview-pane";
import { showShortcutSettingsDialog } from "../ui/shortcut-settings";
import { showUnsavedSettingsDialog } from "../ui/app-dialog";
import { staffBracePathD } from "../layout/brace";
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
  backdropAction?: () => "apply" | "cancel" | "stay" | Promise<"apply" | "cancel" | "stay">;
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

  const releaseScroll = body.querySelector("details") ? retainDetailsScroll(body, box) : null;
  const close = () => { releaseScroll?.(); overlay.remove(); };
  const cancelAndClose = () => {
    options.onCancel?.();
    close();
  };
  cancel.onclick = cancelAndClose;
  let confirming = false;
  overlay.onclick = async (e) => {
    if (e.target !== overlay || confirming) return;
    confirming = true;
    try {
      const action = await (options.backdropAction?.() ?? "cancel");
      if (!overlay.isConnected) return;
      if (action === "apply") {
        onOk();
        close();
      } else if (action === "cancel") cancelAndClose();
    } finally { confirming = false; }
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

/** Application settings. Page and engraving controls live in the layout inspector. */
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
  const codePaneSide = document.createElement("select");
  const codeLeft = document.createElement("option");
  codeLeft.value = "left";
  codeLeft.textContent = "左侧";
  codeLeft.selected = app.codePaneSide === "left";
  const codeRight = document.createElement("option");
  codeRight.value = "right";
  codeRight.textContent = "右侧";
  codeRight.selected = app.codePaneSide === "right";
  codePaneSide.append(codeLeft, codeRight);
  const appearance = document.createElement("select");
  for (const [value, label] of [["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    appearance.append(option);
  }
  appearance.value = getThemePreference();
  const beatPosition = document.createElement("select");
  for (const [value, label] of [["fraction", "分数"], ["decimal", "小数"]] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    beatPosition.append(option);
  }
  beatPosition.value = app.beatPositionFormat;
  const connectBarlines = document.createElement("input");
  connectBarlines.type = "checkbox";
  connectBarlines.checked = app.engravingStyle.connectBarlines;
  const showTextOnStartup = document.createElement("input");
  showTextOnStartup.type = "checkbox";
  showTextOnStartup.checked = app.showTextOnStartup;
  const restoreLastFileOnStartup = document.createElement("input");
  restoreLastFileOnStartup.type = "checkbox";
  restoreLastFileOnStartup.checked = app.restoreLastFileOnStartup;
  const shortcuts = document.createElement("button");
  shortcuts.type = "button";
  shortcuts.textContent = "设置快捷键…";
  shortcuts.onclick = () => showShortcutSettingsDialog();
  const startup = document.createElement("details");
  startup.open = true;
  const startupTitle = document.createElement("summary");
  startupTitle.textContent = "启动";
  startup.append(
    startupTitle,
    labeled("启动时显示文本编辑器", showTextOnStartup),
    labeled("启动时恢复上次文件", restoreLastFileOnStartup),
  );
  body.append(
    labeled("当前谱子类型", documentFormat),
    labeled("文本编辑器位置", codePaneSide),
    labeled("外观", appearance),
    labeled("拍数位置显示", beatPosition),
    labeled("连接跨行小节线", connectBarlines),
    labeled("快捷键", shortcuts),
    startup,
  );
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
  let dirty = false;
  const markDirty = () => {
    dirty = true;
  };
  body.addEventListener("input", markDirty);
  body.addEventListener("change", markDirty);
  modal("设置", body, () => {
    if (app.documentFormat !== "jpw") {
      const count = parseInt(voiceCount.value, 10) || 1;
      const colors = voiceColorInputs.map((input, index) =>
        voiceColorEnabled[index]?.checked ? input.value : "");
      const nextColors = app.slashVoiceColors.map((fallback, index) => {
        const value = colors[index];
        return value === "" || (typeof value === "string" && /^#[\da-f]{6}$/i.test(value))
          ? value : fallback;
      });
      if (count !== app.getSlashVoiceCount()
          || JSON.stringify(nextColors) !== JSON.stringify(app.slashVoiceColors)
          || scoreVoiceColoring.checked !== app.scoreVoiceColoring
          || showVoiceMarkers.checked !== app.showInvisibleVoiceMarkers
          || textVoiceColoring.checked !== app.textVoiceColoring) {
        app.setSlashVoiceSettings(
          count, colors, scoreVoiceColoring.checked,
          showVoiceMarkers.checked, textVoiceColoring.checked,
        );
      }
    }
    volSliders.forEach((s, i) => app.setPartVolume(i, (parseInt(s.value, 10) || 0) / 100));
    const playbackSource = soundSource.value === "sf2" ? "sf2" : "default";
    if (playbackSource !== app.playbackSoundSource
        || (playbackSource === "sf2" && soundfontFile.value !== app.selectedSoundfontId)
        || JSON.stringify(pendingAssignments) !== JSON.stringify(app.soundfontInstrumentByGroup)) {
      app.setPlaybackSoundSettings(playbackSource, soundfontFile.value, pendingAssignments);
    }
    app.setCodePaneSide(codePaneSide.value === "right" ? "right" : "left");
    setThemePreference(appearance.value as ThemePreference);
    const beatFormat = beatPosition.value === "decimal" ? "decimal" : "fraction";
    if (beatFormat !== app.beatPositionFormat) app.setBeatPositionFormat(beatFormat);
    if (connectBarlines.checked !== app.engravingStyle.connectBarlines) {
      app.setBarlineConnectionsEnabled(connectBarlines.checked);
    }
    app.setStartupPreferences(showTextOnStartup.checked, restoreLastFileOnStartup.checked);
    if (documentFormat.value !== app.documentFormat) {
      void app.changeDocumentFormat(documentFormat.value as "jpw" | "keyboard" | "number");
    }
  }, {
    boxClass: "options-box",
    backdropAction: () => {
      if (!dirty) return "cancel";
      return showUnsavedSettingsDialog();
    },
  });
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
  const instrumentFontSize = 15 / 1.5;
  const instrumentWidth = Math.min(96, Math.max(20, Array.from(instrumentName).length * instrumentFontSize));
  const lineX = Math.max(82, 8 + instrumentWidth + 8 + braceWidth + 3);
  const braceRight = lineX - 3;
  const braceLeft = braceRight - braceWidth;
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
    <path data-preview-brace="true" d="${staffBracePathD(braceWidth, lineBottom - lineTop, style.braceStrokeWidth)}" transform="translate(${braceLeft} ${lineTop})" fill="currentColor"/>
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
  const originalRender: PageRenderSettings = {
    pageW: app.pageW,
    pageH: app.pageH,
    fontSize: app.fontSize,
    titleSize: app.titleSize,
    creditSize: app.creditSize,
    color: app.color,
  };
  const instrumentName = app.painter.score.instrumentName.trim() || "钢琴";
  const body = document.createElement("div");
  body.className = "engraving-dialog-body";

  const hint = document.createElement("div");
  hint.className = "modal-hint engraving-hint";
  hint.textContent = "调整后会在当前谱面实时预览；应用后保存为全局排版参数，取消则恢复原样。";
  const expandPreview = document.createElement("button");
  expandPreview.type = "button";
  expandPreview.className = "engraving-preview-expand";
  expandPreview.textContent = "放大查看样张";
  const previewSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  previewSvg.setAttribute("aria-label", "钢琴双行排版样张");

  const workspace = document.createElement("div");
  workspace.className = "engraving-workspace";
  const controls = document.createElement("div");
  controls.className = "engraving-controls";
  const numericInputs = new Map<NumericStyleKey, HTMLInputElement>();
  const numericTouched = new Set<NumericStyleKey>();
  const outputs = new Map<NumericStyleKey, HTMLOutputElement>();
  const formatters = new Map<NumericStyleKey, (value: number) => string>();

  const section = (title: string): HTMLDetailsElement => {
    const el = document.createElement("details");
    el.className = "engraving-section";
    el.open = controls.childElementCount === 0;
    const summary = document.createElement("summary");
    summary.className = "engraving-section-title";
    summary.textContent = title;
    el.append(summary);
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
    // The publication-gap default is 0.88, between the shared 0.05 ticks.
    // Let the slider represent that value exactly when resetting the form.
    const existing = original[key];
    // Keep an older out-of-range value visible and adjustable until the user
    // deliberately moves the slider into its current range.
    addRange(target, labelText, key, Math.min(min, existing), Math.max(max, existing),
      key === "publicationFirstSystemGap" ? 0.01 : step, format);
  };

  const paperSection = section("纸张与字号");
  const pagePreset = document.createElement("select");
  pagePreset.name = "pagePreset";
  pagePreset.setAttribute("aria-label", "纸张比例");
  const originalDimensions = [originalRender.pageW, originalRender.pageH].sort((a, b) => a - b);
  const originalPreset = Object.entries(RATIOS).find(([, dimensions]) => {
    const sorted = [...dimensions].sort((a, b) => a - b);
    return sorted[0] === originalDimensions[0] && sorted[1] === originalDimensions[1];
  })?.[0] ?? "custom";
  if (originalPreset === "custom") {
    const custom = document.createElement("option");
    custom.value = "custom";
    custom.textContent = `自定义（${originalRender.pageW} × ${originalRender.pageH}）`;
    pagePreset.append(custom);
  }
  for (const preset of Object.keys(RATIOS)) {
    const option = document.createElement("option");
    option.value = preset;
    option.textContent = preset;
    pagePreset.append(option);
  }
  pagePreset.value = originalPreset;
  const pageDirection = document.createElement("select");
  pageDirection.name = "pageDirection";
  pageDirection.setAttribute("aria-label", "页面方向");
  for (const [value, label] of [["portrait", "纵向"], ["landscape", "横向"]] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    pageDirection.append(option);
  }
  pageDirection.value = originalRender.pageW >= originalRender.pageH ? "landscape" : "portrait";
  const pageSizeHint = document.createElement("div");
  pageSizeHint.className = "modal-hint";
  const sizeInput = (name: string, value: number, max: number): HTMLInputElement => {
    const input = document.createElement("input");
    input.type = "number";
    input.name = name;
    input.min = "12";
    input.max = String(max);
    input.step = "any";
    input.value = String(value);
    return input;
  };
  const baseFontSize = sizeInput("fontSize", originalRender.fontSize, 72);
  const titleFontSize = sizeInput("titleSize", originalRender.titleSize, 120);
  const creditFontSize = sizeInput("creditSize", originalRender.creditSize, 120);
  const inkColor = document.createElement("input");
  inkColor.type = "color";
  inkColor.name = "inkColor";
  inkColor.value = "#" + ((originalRender.color >>> 0) & 0xffffff).toString(16).padStart(6, "0");
  const linesPerPage = document.createElement("input");
  linesPerPage.type = "text";
  linesPerPage.name = "linesPerPage";
  linesPerPage.placeholder = "例如 4 或 4|3|3（留空=自动）";
  linesPerPage.value = app.getLinesPerPage();
  linesPerPage.disabled = app.documentFormat !== "jpw";
  const originalLinesPerPage = linesPerPage.value;
  const hideBarNum = document.createElement("input");
  hideBarNum.type = "checkbox";
  hideBarNum.name = "hideBarNumber";
  hideBarNum.checked = app.mixedHideBarNumber;
  const originalHideBarNum = hideBarNum.checked;
  const instrumentNameInput = document.createElement("input");
  instrumentNameInput.type = "text";
  instrumentNameInput.name = "instrumentName";
  instrumentNameInput.value = app.getInstrumentName();
  const originalInstrumentName = instrumentNameInput.value;
  const renderTouched = new Set<"fontSize" | "titleSize" | "creditSize">();
  paperSection.append(
    labeled("纸张比例", pagePreset),
    labeled("页面方向", pageDirection),
    pageSizeHint,
    labeled("简谱基础字号", baseFontSize),
    labeled("标题字号", titleFontSize),
    labeled("署名字号", creditFontSize),
    labeled("谱面颜色", inkColor),
    labeled("每页行数", linesPerPage),
  );
  if (app.mode === "mixed") paperSection.append(labeled("隐藏小节号", hideBarNum));
  if (app.mode === "jp" && app.painter.score.piano) {
    paperSection.append(labeled("乐器名称", instrumentNameInput));
  }

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
  for (const division of [1, 2, 4, 8, 16, 32, 64] as const) {
    const option = document.createElement("option");
    option.value = String(division);
    option.textContent = division === 1 ? "全音符" : `${division} 分音符`;
    rhythmGuideDivision.append(option);
  }
  rhythmGuideDivision.value = String(original.rhythmGuideDivision);
  rhythmGuideDivision.disabled = original.rhythmGuideMode !== "manual";
  rhythmSection.append(labeled("手动最短时值", rhythmGuideDivision));
  const rhythmGuideDotted = document.createElement("input");
  rhythmGuideDotted.type = "checkbox";
  rhythmGuideDotted.name = "rhythmGuideDotted";
  rhythmGuideDotted.checked = original.rhythmGuideDotted;
  rhythmSection.append(labeled("突出附点时值", rhythmGuideDotted));
  const rhythmHint = document.createElement("div");
  rhythmHint.className = "modal-hint";
  rhythmHint.textContent = "长刻度始终落在拍号的每一拍。自动模式按各小节实际最短时值补短刻度；手动模式固定使用指定的全音符至 64 分音符网格。顶部快速刻度与这里保持同步。";
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
  workspace.append(controls);
  body.append(hint, workspace, reset);

  const readStyle = (): EngravingStyle => {
    const value = {
      ...original,
      numberBold: bold.checked,
      tieContinuationGray: tieContinuationGray.checked,
      rhythmicSpacingEnabled: rhythmicSpacingEnabled.checked,
      justifyLastSystem: justifyLastSystem.checked,
      rhythmGuideEnabled: rhythmGuideEnabled.checked,
      rhythmGuideMode: rhythmGuideMode.value as RhythmGuideMode,
      rhythmGuideDivision: parseInt(rhythmGuideDivision.value, 10) as RhythmGuideDivision,
      rhythmGuideDotted: rhythmGuideDotted.checked,
    } as EngravingStyle;
    for (const [key, input] of numericInputs) {
      value[key] = numericTouched.has(key) ? parseFloat(input.value) : original[key];
    }
    return normalizeEngravingStyle(value);
  };
  const readRender = (): PageRenderSettings => {
    const dimensions = pagePreset.value === "custom"
      ? [originalRender.pageW, originalRender.pageH]
      : RATIOS[pagePreset.value] ?? [originalRender.pageW, originalRender.pageH];
    const short = Math.min(...dimensions);
    const long = Math.max(...dimensions);
    const numeric = (key: "fontSize" | "titleSize" | "creditSize", input: HTMLInputElement): number => {
      const fallback = originalRender[key];
      if (!renderTouched.has(key)) return fallback;
      const value = Number(input.value);
      return input.value && Number.isFinite(value)
        ? Math.max(Number(input.min), Math.min(Number(input.max), value))
        : fallback;
    };
    return {
      ...originalRender,
      pageW: pageDirection.value === "landscape" ? long : short,
      pageH: pageDirection.value === "landscape" ? short : long,
      fontSize: numeric("fontSize", baseFontSize),
      titleSize: numeric("titleSize", titleFontSize),
      creditSize: numeric("creditSize", creditFontSize),
      color: (0xff000000 | (parseInt(inkColor.value.slice(1), 16) & 0xffffff)) >>> 0,
    };
  };
  const writeRender = (render: PageRenderSettings): void => {
    const sorted = [render.pageW, render.pageH].sort((a, b) => a - b);
    pagePreset.value = Object.entries(RATIOS).find(([, dimensions]) => {
      const preset = [...dimensions].sort((a, b) => a - b);
      return preset[0] === sorted[0] && preset[1] === sorted[1];
    })?.[0] ?? "custom";
    pageDirection.value = render.pageW >= render.pageH ? "landscape" : "portrait";
    baseFontSize.value = String(render.fontSize);
    titleFontSize.value = String(render.titleSize);
    creditFontSize.value = String(render.creditSize);
    inkColor.value = "#" + ((render.color >>> 0) & 0xffffff).toString(16).padStart(6, "0");
    renderTouched.add("fontSize");
    renderTouched.add("titleSize");
    renderTouched.add("creditSize");
  };
  const writeStyle = (style: EngravingStyle): void => {
    bold.checked = style.numberBold;
    tieContinuationGray.checked = style.tieContinuationGray;
    rhythmicSpacingEnabled.checked = style.rhythmicSpacingEnabled;
    justifyLastSystem.checked = style.justifyLastSystem;
    rhythmGuideEnabled.checked = style.rhythmGuideEnabled;
    rhythmGuideMode.value = style.rhythmGuideMode;
    rhythmGuideDivision.value = String(style.rhythmGuideDivision);
    rhythmGuideDotted.checked = style.rhythmGuideDotted;
    rhythmGuideDivision.disabled = style.rhythmGuideMode !== "manual";
    for (const [key, input] of numericInputs) {
      numericTouched.add(key);
      input.value = String(style[key]);
    }
  };
  const updateOutputs = (style: EngravingStyle): void => {
    for (const [key, output] of outputs) {
      output.textContent = formatters.get(key)!(style[key]);
    }
  };

  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let previewPane: { close: () => void } | null = null;
  let viewerOverlay: HTMLDivElement | null = null;
  let largePreviewSvg: SVGSVGElement | null = null;
  const syncLargePreview = (): void => {
    if (!largePreviewSvg) return;
    largePreviewSvg.setAttribute("viewBox", previewSvg.getAttribute("viewBox") ?? "0 0 620 220");
    largePreviewSvg.setAttribute("preserveAspectRatio", "xMidYMin meet");
    largePreviewSvg.dataset.previewSource = previewSvg.dataset.previewSource ?? "sample";
    largePreviewSvg.innerHTML = previewSvg.innerHTML;
  };
  const closeLargePreview = (restoreFocus: boolean): void => {
    viewerOverlay?.remove();
    viewerOverlay = null;
    largePreviewSvg = null;
    if (restoreFocus && expandPreview.isConnected) expandPreview.focus();
  };
  expandPreview.onclick = () => {
    if (viewerOverlay) return;
    renderEngravingPreview(previewSvg, readStyle(), instrumentName, app);
    const overlay = document.createElement("div");
    overlay.className = "engraving-preview-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    const titleId = "engraving-preview-viewer-title";
    overlay.setAttribute("aria-labelledby", titleId);
    const viewer = document.createElement("div");
    viewer.className = "engraving-preview-viewer";
    const header = document.createElement("div");
    header.className = "engraving-preview-viewer-header";
    const title = document.createElement("h2");
    title.id = titleId;
    title.textContent = "钢琴双行排版样张";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "engraving-preview-viewer-close";
    close.textContent = "关闭";
    close.onclick = () => closeLargePreview(true);
    header.append(title, close);
    const zoomControls = document.createElement("div");
    zoomControls.className = "engraving-preview-zoom";
    const zoomOut = document.createElement("button");
    zoomOut.type = "button";
    zoomOut.textContent = "−";
    zoomOut.setAttribute("aria-label", "缩小样张");
    const zoomLabel = document.createElement("output");
    const zoomIn = document.createElement("button");
    zoomIn.type = "button";
    zoomIn.textContent = "+";
    zoomIn.setAttribute("aria-label", "放大样张");
    zoomControls.append(zoomOut, zoomLabel, zoomIn);
    const scroll = document.createElement("div");
    scroll.className = "engraving-preview-viewer-scroll";
    const largeSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    largeSvg.classList.add("engraving-preview-large-svg");
    largeSvg.setAttribute("aria-label", "放大的钢琴双行排版样张");
    largePreviewSvg = largeSvg;
    syncLargePreview();
    let zoom = 100;
    const updateZoom = (): void => {
      largeSvg.style.width = `${zoom}%`;
      zoomLabel.textContent = `${zoom}%`;
      zoomOut.disabled = zoom <= 100;
      zoomIn.disabled = zoom >= 200;
    };
    zoomOut.onclick = () => { zoom = Math.max(100, zoom - 25); updateZoom(); };
    zoomIn.onclick = () => { zoom = Math.min(200, zoom + 25); updateZoom(); };
    updateZoom();
    scroll.append(largeSvg);
    viewer.append(header, zoomControls, scroll);
    overlay.append(viewer);
    overlay.onclick = (event) => {
      if (event.target === overlay) closeLargePreview(true);
    };
    overlay.onkeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeLargePreview(true);
      } else if (event.key === "Tab") {
        const buttons = [close, zoomOut, zoomIn].filter((button) => !button.disabled);
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    viewerOverlay = overlay;
    document.body.append(overlay);
    close.focus();
  };
  const clearPreviewTimer = (): void => {
    if (previewTimer !== null) clearTimeout(previewTimer);
    previewTimer = null;
  };
  const schedulePreview = (): void => {
    clearPreviewTimer();
    previewTimer = setTimeout(() => {
      previewTimer = null;
      app.setEngravingPreview(readStyle(), readRender());
      renderEngravingPreview(previewSvg, readStyle(), instrumentNameInput.value.trim() || instrumentName, app);
      syncLargePreview();
    }, 200);
  };
  const refresh = (): void => {
    const style = readStyle();
    const render = readRender();
    const spacingExponent = numericInputs.get("rhythmicSpacingExponent");
    if (spacingExponent) spacingExponent.disabled = !style.rhythmicSpacingEnabled;
    rhythmGuideDivision.disabled = style.rhythmGuideMode !== "manual";
    updateOutputs(style);
    pageSizeHint.textContent = `页面尺寸：${render.pageW} × ${render.pageH}`;
    renderEngravingPreview(previewSvg, style, instrumentNameInput.value.trim() || instrumentName, app);
    syncLargePreview();
    schedulePreview();
  };
  for (const [key, input] of numericInputs) input.addEventListener("input", () => {
    numericTouched.add(key);
    refresh();
  });
  bold.addEventListener("change", refresh);
  tieContinuationGray.addEventListener("change", refresh);
  rhythmicSpacingEnabled.addEventListener("change", refresh);
  justifyLastSystem.addEventListener("change", refresh);
  rhythmGuideEnabled.addEventListener("change", refresh);
  rhythmGuideMode.addEventListener("change", refresh);
  rhythmGuideDivision.addEventListener("change", refresh);
  rhythmGuideDotted.addEventListener("change", refresh);
  pagePreset.addEventListener("change", refresh);
  pageDirection.addEventListener("change", refresh);
  inkColor.addEventListener("input", refresh);
  instrumentNameInput.addEventListener("input", refresh);
  for (const [key, input] of [
    ["fontSize", baseFontSize],
    ["titleSize", titleFontSize],
    ["creditSize", creditFontSize],
  ] as const) input.addEventListener("input", () => {
    renderTouched.add(key);
    refresh();
  });
  reset.onclick = () => {
    writeStyle(normalizeEngravingStyle(DEFAULT_ENGRAVING_STYLE));
    writeRender({ ...originalRender, pageW: 595, pageH: 842, fontSize: 28, titleSize: 48, creditSize: 36 });
    linesPerPage.value = "";
    hideBarNum.checked = false;
    refresh();
  };
  pageSizeHint.textContent = `页面尺寸：${originalRender.pageW} × ${originalRender.pageH}`;
  let releaseScroll: (() => void) | null = null;
  void openInspector({
    id: "layout",
    title: "排版",
    body,
    isDirty: () => JSON.stringify(readStyle()) !== JSON.stringify(original)
      || JSON.stringify(readRender()) !== JSON.stringify(originalRender)
      || linesPerPage.value.trim() !== originalLinesPerPage
      || (app.mode === "mixed" && hideBarNum.checked !== originalHideBarNum)
      || (app.mode === "jp" && app.painter.score.piano
        && instrumentNameInput.value.trim() !== originalInstrumentName),
    onApply: () => {
      clearPreviewTimer();
      app.setEngravingStyle(readStyle(), true, readRender());
      if (linesPerPage.value.trim() !== app.getLinesPerPage()) {
        app.setLinesPerPage(linesPerPage.value.trim());
      }
      if (app.mode === "jp" && app.painter.score.piano
          && instrumentNameInput.value.trim() !== app.getInstrumentName()) {
        app.setInstrumentName(instrumentNameInput.value);
      }
      if (app.mode === "mixed" && hideBarNum.checked !== app.mixedHideBarNumber) {
        void app.setMixedHideBarNumber(hideBarNum.checked);
      }
      return true;
    },
    onDiscard: () => {
      clearPreviewTimer();
      app.setEngravingPreview(null);
    },
    onClosed: () => {
      releaseScroll?.();
      releaseScroll = null;
      closeLargePreview(false);
      previewPane?.close();
      previewPane = null;
    },
    applyText: "应用到全部简谱",
  }).then((opened) => {
    if (!opened) return;
    const content = body.closest<HTMLElement>(".inspector-content");
    if (content) releaseScroll = retainDetailsScroll(body, content);
    previewPane = openLayoutPreviewPane(app, previewSvg, expandPreview);
    renderEngravingPreview(previewSvg, readStyle(), instrumentName, app);
  });
}
