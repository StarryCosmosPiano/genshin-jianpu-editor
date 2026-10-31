import { analyzeAddSlashes, convertAddSlashes, type AddSlashesOptions } from "../slashscore/add-slashes";
import type { SlashDurationDivision, SlashScoreKind, SlashScoreOptions } from "../slashscore";
import { FloatingWindow } from "../ui/floating-window";
import { fileStem } from "./file-format";
import { SlashScorePreview } from "./slash-score-preview";
import { blockImportBackground } from "../ui/import-dialog";
import "../ui/floating-window.css";
import "../ui/app-dialog.css";
import "./add-slashes-dialog.css";

const DIVISIONS: SlashDurationDivision[] = [4, 8, 16, 32, 64];
let activeDialog: (() => void) | null = null;

function field(caption: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "app-dialog-field";
  const text = document.createElement("span");
  text.textContent = caption;
  label.append(text, control);
  return label;
}

function choice(value: string, caption: string): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = caption;
  return item;
}

function divisionControl(value: SlashDurationDivision | null, own = false): HTMLSelectElement {
  const control = document.createElement("select");
  control.append(choice("", own ? "无自身时值" : "未指定"));
  for (const division of DIVISIONS) {
    control.append(choice(String(division), `${division} 分 · ${4 / division} 拍`));
  }
  // Keep an existing generated fine value when the settings are reopened.
  if (value === 128) control.append(choice("128", "128 分 · 0.03125 拍"));
  control.value = value === null ? "" : String(value);
  return control;
}

function divisionValue(control: HTMLSelectElement): SlashDurationDivision | null {
  const number = Number(control.value);
  return number === 128 || DIVISIONS.includes(number as SlashDurationDivision) ? number as SlashDurationDivision : null;
}

/** Draft controls remain user-owned after the import's first committed meter. */
export function showAddSlashesDialog(
  text: string,
  fileName: string,
  purpose: "import" | "manual" = "import",
  kindHint?: SlashScoreKind,
): Promise<{ text: string; options: SlashScoreOptions } | null> {
  if (activeDialog) {
    activeDialog();
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const initial = analyzeAddSlashes(text, { kind: kindHint });
    const layer = document.createElement("div");
    layer.className = "app-dialog-layer add-slashes-layer";
    const pane = document.createElement("form");
    pane.className = "app-dialog inspector-floating add-slashes-dialog";
    pane.setAttribute("role", "dialog");
    pane.setAttribute("aria-modal", "true");
    pane.setAttribute("aria-labelledby", "add-slashes-title");
    pane.tabIndex = -1;
    const header = document.createElement("header");
    header.className = "inspector-header";
    header.title = "拖动标题栏移动窗口";
    const heading = document.createElement("h2");
    heading.className = "inspector-title";
    heading.id = "add-slashes-title";
    heading.textContent = "添加斜杠";
    const actions = document.createElement("div");
    actions.className = "inspector-header-actions";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "inspector-reset";
    reset.textContent = "↺";
    reset.setAttribute("aria-label", "重置添加斜杠窗口位置和大小");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "inspector-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "关闭添加斜杠窗口");
    actions.append(reset, close);
    header.append(heading, actions);
    const content = document.createElement("div");
    content.className = "app-dialog-content add-slashes-workspace";
    const controls = document.createElement("div");
    controls.className = "add-slashes-controls";
    const scorePreview = new SlashScorePreview();
    const previewPane = document.createElement("section");
    previewPane.className = "add-slashes-score";
    previewPane.setAttribute("aria-label", "添加斜杠真实谱面预览");
    scorePreview.element.dataset.addSlashes = "score-preview";
    previewPane.append(scorePreview.element);
    content.append(controls, previewPane);
    const meterGuide = document.createElement("div");
    meterGuide.className = "add-slashes-meter-guide";
    meterGuide.dataset.addSlashes = "meter-guide";
    const meterGuideTitle = document.createElement("strong");
    meterGuideTitle.textContent = "先填写拍号";
    const meterGuideText = document.createElement("p");
    meterGuideText.textContent = "拍号不确定？先设置下方原文符号的时值，再点击“分析拍号”，选择合适的候选。";
    meterGuide.append(meterGuideTitle, meterGuideText);
    controls.append(meterGuide);
    const intro = document.createElement("p");
    intro.className = "add-slashes-intro";
    intro.textContent = "首次填写拍号会分析原文中各符号的时值，之后可以自行修改。时值中的 1 拍指四分音符。首行不足一小节时，在开头补休止填满小节。速度和说明文字作为注释保留。";
    controls.append(intro);

    const settings = document.createElement("div");
    settings.className = "add-slashes-settings";
    const title = document.createElement("input");
    title.value = fileStem(fileName) || "未命名";
    title.setAttribute("aria-label", "补斜杠乐谱标题");
    const beats = document.createElement("input");
    beats.type = "number";
    beats.min = "1";
    beats.max = "32";
    beats.step = "1";
    beats.placeholder = "先填拍数";
    beats.dataset.addSlashes = "beats";
    beats.setAttribute("aria-label", "拍号分子，留空表示未知");
    const beatType = document.createElement("select");
    for (const value of [2, 4, 8, 16]) beatType.append(choice(String(value), String(value)));
    beatType.value = "4";
    beatType.dataset.addSlashes = "beat-type";
    beatType.setAttribute("aria-label", "拍号分母");
    const meter = document.createElement("span");
    meter.className = "add-slashes-meter";
    meter.append(beats, document.createTextNode(" / "), beatType);
    const kind = document.createElement("select");
    kind.append(choice("keyboard", "键盘谱（A–Z）"), choice("number", "数字谱（1–7）"));
    kind.value = initial.kind;
    kind.setAttribute("aria-label", "添加斜杠谱型");
    settings.append(field("标题", title), field("拍号（可留空）", meter), field("谱型", kind));
    controls.append(settings);

    const timing = document.createElement("div");
    timing.className = "add-slashes-timing";
    const symbols = new Map<string, HTMLSelectElement>();
    const symbolFields = document.createElement("div");
    symbolFields.className = "add-slashes-timing";
    symbolFields.style.padding = "0";
    const own = divisionControl(null, true);
    own.dataset.addSlashes = "note-division";
    own.setAttribute("aria-label", "音符或和弦自身时值");
    const adjacent = document.createElement("input");
    adjacent.type = "checkbox";
    adjacent.checked = true;
    adjacent.dataset.addSlashes = "adjacent-chord";
    adjacent.setAttribute("aria-label", "连续音符合为和弦");
    const chordLabel = document.createElement("label");
    chordLabel.className = "add-slashes-chord";
    chordLabel.append(adjacent, document.createTextNode("连续音符合为和弦"));
    timing.append(symbolFields, field("音符 / 和弦自身时值", own));
    const numberDurations = document.createElement("input");
    numberDurations.type = "checkbox";
    numberDurations.checked = false;
    numberDurations.dataset.addSlashes = "number-durations";
    numberDurations.setAttribute("aria-label", "将数字谱加减号用作时值，不用作八度");
    const numberDurationLabel = document.createElement("label");
    numberDurationLabel.className = "add-slashes-chord";
    numberDurationLabel.append(numberDurations, document.createTextNode("将 + / - 用作时值（不用作八度）"));
    controls.append(timing, chordLabel, numberDurationLabel);
    const note = document.createElement("p");
    note.className = "add-slashes-note";
    note.textContent = "无括号时优先将相连字母视为和弦且无自身时值；有括号时可核对有 / 无自身时值的方案。导入时首次填写拍号会分析一次，此后修改设置只更新预览；采纳其他方案须点击对应按钮。";
    controls.append(note);
    const analyze = document.createElement("button");
    analyze.type = "button";
    analyze.className = "add-slashes-analyze";
    analyze.dataset.addSlashes = "analyze";
    analyze.textContent = "按拍号分析时值方案";
    const analyzeMeter = document.createElement("button");
    analyzeMeter.type = "button";
    analyzeMeter.className = "add-slashes-analyze";
    analyzeMeter.dataset.addSlashes = "analyze-meter";
    analyzeMeter.textContent = "分析拍号";
    const analysisActions = document.createElement("div");
    analysisActions.className = "add-slashes-analysis-actions";
    analysisActions.append(analyze, analyzeMeter);
    const proposals = document.createElement("div");
    proposals.className = "add-slashes-candidates";
    proposals.dataset.addSlashes = "duration-candidates";
    const meterCandidates = document.createElement("div");
    meterCandidates.className = "add-slashes-candidates";
    meterCandidates.dataset.addSlashes = "meter-candidates";
    const initialPlan = document.createElement("p");
    initialPlan.className = "add-slashes-note";
    initialPlan.dataset.addSlashes = "initial-plan";
    initialPlan.hidden = true;
    controls.append(analysisActions, initialPlan, proposals, meterCandidates);

    const preview = document.createElement("div");
    preview.className = "add-slashes-text";
    const source = document.createElement("textarea");
    source.value = text;
    source.spellcheck = false;
    source.setAttribute("aria-label", "添加斜杠原文");
    source.dataset.addSlashes = "source";
    source.placeholder = "粘贴没有斜杠的键盘谱，例如：AB+CD-E=F=";
    const output = document.createElement("textarea");
    output.readOnly = true;
    output.spellcheck = false;
    output.setAttribute("aria-label", "补斜杠结果预览");
    output.dataset.addSlashes = "preview";
    const resultDetails = document.createElement("details");
    resultDetails.className = "add-slashes-detail";
    const resultSummary = document.createElement("summary");
    resultSummary.textContent = "查看补斜杠后的文本";
    resultDetails.append(resultSummary, field("结果文本", output));
    preview.append(field("原文（可修改）", source), resultDetails);
    const status = document.createElement("p");
    status.className = "add-slashes-status";
    status.setAttribute("role", "status");
    status.dataset.addSlashes = "status";
    const errors = document.createElement("p");
    errors.className = "app-dialog-error";
    errors.setAttribute("role", "alert");
    errors.dataset.addSlashes = "errors";
    const warnings = document.createElement("p");
    warnings.className = "add-slashes-warning";
    const detail = document.createElement("details");
    detail.className = "add-slashes-detail";
    const summary = document.createElement("summary");
    summary.textContent = "各原文谱行的时值核对";
    const totals = document.createElement("table");
    totals.setAttribute("aria-label", "原文谱行拍长");
    detail.append(summary, totals);
    controls.append(preview, status, errors, warnings, detail);
    const footer = document.createElement("footer");
    footer.className = "app-dialog-footer";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    const confirm = document.createElement("button");
    confirm.type = "submit";
    confirm.className = "primary";
    confirm.textContent = "确认补斜杠";
    confirm.dataset.addSlashes = "confirm";
    footer.append(cancel, confirm);
    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "inspector-resize-grip";
    grip.textContent = "◢";
    grip.setAttribute("aria-label", "调整添加斜杠窗口大小，方向键可调整");
    pane.append(header, content, footer, grip);
    layer.append(pane);

    const syncSymbols = (observed: string[]): void => {
      const actual = new Set(observed);
      for (const [symbol, input] of symbols) {
        if (actual.has(symbol)) continue;
        input.closest("label")?.remove();
        symbols.delete(symbol);
      }
      for (const symbol of actual) {
        if (symbols.has(symbol)) continue;
        const division = divisionControl(null);
        division.setAttribute("aria-label", `符号 ${symbol} 的时值`);
        division.dataset.addSlashesSymbol = symbol;
        const wrap = field(`符号 ${symbol}`, division);
        wrap.classList.add("add-slashes-symbol");
        symbols.set(symbol, division);
        symbolFields.append(wrap);
      }
    };
    syncSymbols(initial.observedSymbols);
    const draft = (): AddSlashesOptions => ({
      kind: kind.value === "number" ? "number" : "keyboard",
      beats: beats.value.trim() === "" ? null : Number(beats.value),
      beatType: Number(beatType.value),
      symbolDurations: Object.fromEntries([...symbols].flatMap(([symbol, input]) => {
        const value = divisionValue(input);
        return value === null ? [] : [[symbol, value]];
      })),
      noteDivision: divisionValue(own),
      adjacentAsChord: adjacent.checked,
      numberPlusMinusAsDurations: numberDurations.checked,
    });
    const applyProposal = (proposal: { symbolDurations: Record<string, SlashDurationDivision>; noteDivision: SlashDurationDivision | null; adjacentAsChord: boolean }): void => {
      for (const [symbol, input] of symbols) input.value = proposal.symbolDurations[symbol] ? String(proposal.symbolDurations[symbol]) : "";
      own.value = proposal.noteDivision === null ? "" : String(proposal.noteDivision);
      adjacent.checked = proposal.adjacentAsChord;
    };
    let latest = convertAddSlashes(source.value, draft());
    let settled = false;
    let importAnalysisUsed = purpose !== "import";
    let timingTouched = false;
    let meterAnalysisRequested = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = (): void => {
      if (settled) return;
      clearTimeout(refreshTimer);
      const values = draft();
      numberDurationLabel.hidden = kind.value !== "number";
      const analysis = analyzeAddSlashes(source.value, values);
      syncSymbols(analysis.observedSymbols);
      latest = convertAddSlashes(source.value, draft());
      output.value = latest.text;
      const meterKnown = beats.value.trim() !== "";
      const validMeter = !meterKnown || Number.isInteger(Number(beats.value)) && Number(beats.value) >= 1 && Number(beats.value) <= 32;
      const messages = [...new Set([...analysis.errors, ...latest.errors])];
      if (!validMeter) messages.unshift("拍号分子须为 1–32 的整数；不确定时请留空。");
      errors.textContent = messages.join("\n");
      errors.hidden = messages.length === 0;
      warnings.textContent = [...new Set([...analysis.warnings, ...latest.warnings])].join("\n");
      warnings.hidden = !warnings.textContent;
      analyze.disabled = !meterKnown || !validMeter || !source.value.trim();
      analyzeMeter.disabled = !source.value.trim();
      confirm.disabled = !validMeter || messages.length > 0 || !latest.canImport || !meterKnown;
      if (!confirm.disabled) scorePreview.set(latest.text, { ...latest.options, title: title.value.trim() || "未命名" });
      else scorePreview.clear(!meterKnown ? "填写拍号与符号时值后，在这里预览真实谱面。" : "请先补全左侧设置，谱面会随设置更新。", latest.text);
      status.textContent = !meterKnown
        ? "尚未选择拍号。请先填写拍号，或设置原文符号时值后点击“分析拍号”。"
        : latest.canImport && messages.length === 0 ? `已按 ${beats.value}/${beatType.value} 添加斜杠，可核对预览后确认。`
          : "当前设置不能完整转换，请按提示补全或修改。";
      meterCandidates.replaceChildren();
      if (meterAnalysisRequested) {
        // Meter candidates use only the user's current timing, never substitute
        // a guessed symbol mapping or replace the current meter on analysis.
        const meterAnalysis = analyzeAddSlashes(source.value, { ...draft(), beats: null });
        const unknown = meterAnalysis.observedSymbols.filter((symbol) => !divisionValue(symbols.get(symbol)!));
        const candidates = unknown.length || meterAnalysis.errors.length ? [] : meterAnalysis.meterCandidates;
        for (const candidate of candidates.slice(0, 8)) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = `${candidate.beats}/${candidate.beatType}`;
          button.title = candidate.reasons.join("；");
          button.dataset.addSlashesMeter = `${candidate.beats}/${candidate.beatType}`;
          button.onclick = () => {
            importAnalysisUsed = true;
            beats.value = String(candidate.beats);
            beatType.value = String(candidate.beatType);
            proposals.replaceChildren();
            refresh();
          };
          meterCandidates.append(button);
        }
        if (!candidates.length) {
          const hint = document.createElement("span");
          hint.className = "add-slashes-note";
          hint.dataset.addSlashes = "meter-analysis-hint";
          hint.textContent = unknown.length
            ? `请先指定原文符号 ${unknown.join("、")} 的时值，再分析拍号。`
            : meterAnalysis.errors.length
              ? "请先补全符号和音符自身时值、修正原文提示，再分析拍号。"
              : "尚无可靠候选拍号，请核对当前时值与原文谱行，或手动填写拍号。";
          meterCandidates.append(hint);
        }
      }
      totals.replaceChildren();
      const tableHeader = document.createElement("tr");
      for (const caption of ["原文行", "四分音符拍长", "音符 / 和弦数"]) {
        const cell = document.createElement("th");
        cell.textContent = caption;
        tableHeader.append(cell);
      }
      totals.append(tableHeader);
      for (const line of latest.lineStats) {
        const row = document.createElement("tr");
        for (const value of [line.line, line.quarterNotes, line.attacks]) {
          const cell = document.createElement("td");
          cell.textContent = String(value);
          row.append(cell);
        }
        totals.append(row);
      }
    };
    analyzeMeter.onclick = () => {
      meterAnalysisRequested = true;
      refresh();
    };
    analyze.onclick = () => {
      refresh();
      if (analyze.disabled) return;
      const analysis = analyzeAddSlashes(source.value, draft());
      proposals.replaceChildren();
      for (const [index, candidate] of analysis.durationCandidates.slice(0, 6).entries()) {
        const button = document.createElement("button");
        button.type = "button";
        const mapping = Object.entries(candidate.symbolDurations).map(([symbol, division]) => `${symbol}=${4 / division} 拍`).join("，");
        button.textContent = `采用方案 ${index + 1}：${mapping}；自身${candidate.noteDivision === null ? "无时值" : ` ${4 / candidate.noteDivision} 拍`}；连续音${candidate.adjacentAsChord ? "为和弦" : "逐音"}`;
        if (candidate.reasons.length) button.textContent += `\n${candidate.reasons.slice(0, 2).join("；")}`;
        button.title = candidate.reasons.join("；");
        button.dataset.addSlashesProposal = candidate.id;
        button.onclick = () => {
          importAnalysisUsed = true;
          applyProposal(candidate);
          proposals.replaceChildren();
          refresh();
        };
        proposals.append(button);
      }
      if (!analysis.durationCandidates.length) {
        const hint = document.createElement("span");
        hint.className = "add-slashes-note";
        hint.textContent = "未找到符合拍号的可靠方案，请手动核对时值与谱行。";
        proposals.append(hint);
      }
    };
    const analyzeInitialMeter = (): void => {
      if (importAnalysisUsed || timingTouched) return;
      const number = Number(beats.value);
      if (!beats.value.trim() || !Number.isInteger(number) || number < 1 || number > 32) return;
      importAnalysisUsed = true;
      const analysis = analyzeAddSlashes(source.value, draft());
      syncSymbols(analysis.observedSymbols);
      const candidate = analysis.durationCandidates[0];
      if (candidate) {
        applyProposal(candidate);
        initialPlan.textContent = `已按首次填写的 ${beats.value}/${beatType.value} 推断时值，可继续修改。${candidate.reasons.slice(0, 2).join(" ")}`;
        initialPlan.hidden = false;
      }
    };
    content.addEventListener("input", (event) => {
      const target = event.target;
      if (target === own || target === adjacent || target === numberDurations
        || target instanceof HTMLElement && target.hasAttribute("data-add-slashes-symbol")) timingTouched = true;
      proposals.replaceChildren();
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (target === beats || target === beatType) analyzeInitialMeter();
        refresh();
      }, target === source ? 160 : target === beats ? 500 : 0);
    });
    content.addEventListener("change", (event) => {
      if (event.target === own || event.target === adjacent || event.target === numberDurations
        || event.target instanceof HTMLElement && event.target.hasAttribute("data-add-slashes-symbol")) timingTouched = true;
      if (event.target === beats || event.target === beatType) analyzeInitialMeter();
      proposals.replaceChildren();
      refresh();
    });

    document.body.append(layer);
    const releaseBackground = blockImportBackground(layer);
    const floating = new FloatingWindow(pane, "add-slashes", header, grip, reset,
      { width: 1160, height: 820, minWidth: 340, minHeight: 320, centered: true, persist: false });
    const finish = (apply: boolean): void => {
      if (settled) return;
      if (apply) {
        refresh();
        if (confirm.disabled) return;
      }
      settled = true;
      clearTimeout(refreshTimer);
      document.removeEventListener("editor:document-replaced", dismiss);
      floating.destroy();
      scorePreview.destroy();
      layer.remove();
      releaseBackground();
      activeDialog = null;
      resolve(apply ? { text: latest.text, options: { ...latest.options, title: title.value.trim() || "未命名" } } : null);
    };
    const dismiss = (): void => finish(false);
    activeDialog = () => pane.focus({ preventScroll: true });
    document.addEventListener("editor:document-replaced", dismiss);
    close.onclick = dismiss;
    cancel.onclick = dismiss;
    pane.onsubmit = (event) => { event.preventDefault(); finish(true); };
    layer.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        dismiss();
      } else if (event.key === "Tab") {
        const elements = [...pane.querySelectorAll<HTMLElement>("button,input,select,textarea")]
          .filter((node) => !node.hasAttribute("disabled") && node.getClientRects().length > 0);
        const index = elements.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey && index <= 0 || !event.shiftKey && index === elements.length - 1) {
          event.preventDefault();
          (event.shiftKey ? elements[elements.length - 1] : elements[0])?.focus();
        }
      }
      event.stopPropagation();
    });
    // No meter means no absolute duration guesses. The original symbols alone
    // create blank controls until a meter or a user-chosen mapping is supplied.
    refresh();
    (purpose === "manual" && !text.trim() ? source : beats).focus({ preventScroll: true });
  });
}
