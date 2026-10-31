import type { App } from "../editor/app";
import type { NoteTimingDivision } from "../score/note-timing";
import type { ScoreCommand, ScoreMarkKind, ScoreSelectionMode, ScoreSurface, ScoreTouchCandidate } from "../editor/score-commands";
import { getWorkspaceMode, getWorkspaceModePreference, initializeWorkspaceMode, isTouchWorkspace, setWorkspaceModePreference, type WorkspaceModePreference } from "./device-mode";
import { registerTouchScoreSurface, touchScoreSurface } from "./touch-score-bridge";
import { wireTouchGestures } from "./touch-gestures";
import type { TouchPoint } from "./touch-gesture-state";
import { requestCloseInspector } from "../ui/inspector";
import { keyboardNoteForKey } from "../editor/keyboard-note";
import { EditorView } from "@codemirror/view";
import "./mobile-workspace.css";

type PanelTab = "notes" | "edit" | "marks";
type KeyboardLayout = "number" | "lyre" | "letters";
type MobileScoreView = ScoreSurface | "compare" | "text";
const DIVISIONS: NoteTimingDivision[] = [1, 2, 4, 8, 16, 32, 64];
const MODE_LABELS = { auto: "自动", phone: "手机", tablet: "平板", desktop: "桌面" };
let handledButtonTap: { id: number; x: number; y: number; time: number } | null = null;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}
function button(text: string, label: string, action: () => void, className = ""): HTMLButtonElement {
  const node = element("button", className, text);
  node.type = "button"; node.title = label; node.setAttribute("aria-label", label);
  node.addEventListener("click", action);
  // Native compatibility clicks can be absent after a canceled multi-touch
  // sequence. Resolve a complete pointer tap directly, with movement/cancel
  // guards so scrolling a panel can never activate its buttons.
  let start: { id: number; x: number; y: number; moved: boolean } | null = null;
  node.addEventListener("pointerdown", event => {
    if (!isTouchWorkspace() || !["touch", "pen"].includes(event.pointerType) || node.disabled) return;
    start = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  });
  node.addEventListener("pointermove", event => {
    if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 9) start.moved = true;
  });
  node.addEventListener("pointercancel", () => { start = null; });
  node.addEventListener("pointerup", event => {
    const tap = start; start = null;
    if (!tap || tap.id !== event.pointerId || tap.moved || node.disabled) return;
    event.preventDefault();
    handledButtonTap = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() };
    action();
  });
  return node;
}
function activeEditorField(): boolean {
  const target = document.activeElement;
  return target instanceof HTMLElement && !!target.closest("textarea, input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=color]), [contenteditable=true]");
}

/** Responsive presentation over the same editor commands and Score session. */
export function wireMobileWorkspace(app: App): void {
  if (document.getElementById("mobile-workspace-bar")) return;
  const root = document.getElementById("app")!;
  const scorePane = app.scorePane;
  const staffPane = document.getElementById("staff-pane")!;
  let tab: PanelTab = "notes";
  let collapsed = false;
  let compactViewport = false;
  let beforeCompactCollapsed = false;
  let marquee = false;
  let octave = 0;
  let staffOctave = 4;
  let staffAccidental: -1 | 0 | 1 | undefined;
  let keyboardLayout: KeyboardLayout = "number";
  try { const saved = localStorage.getItem("jpeditor:touch-keyboard:v1"); if (saved === "lyre" || saved === "letters") keyboardLayout = saved; } catch { /* Optional preference. */ }
  let cursorKey = "";
  let commandQueue = Promise.resolve();
  let queueCount = 0;
  let virtualized: boolean | null = null;
  let wasTouchWorkspace: boolean | null = null;
  let desktopCodeCollapsed = app.codePaneCollapsed;
  let sheet: HTMLElement | null = null;
  let closeSheet: (() => void) | null = null;
  let viewportHeight = window.innerHeight;
  let viewportWidth = window.innerWidth;
  let resizeFrame = 0;
  let visibleSize = { width: 0, height: 0 };
  const scoreView = (): ScoreSurface | "compare" => (document.getElementById("staff-view-select") as HTMLSelectElement).value as ScoreSurface | "compare";
  const notationVisible = (): boolean => app.codePaneCollapsed && scoreView() !== "compare";
  document.addEventListener("click", event => {
    const tap = handledButtonTap;
    if (!tap || event.detail === 0 || performance.now() - tap.time > 800) return;
    const pointer = event as PointerEvent;
    if (pointer.pointerId === tap.id || (!pointer.pointerType && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < 8)) {
      event.preventDefault(); event.stopImmediatePropagation(); handledButtonTap = null;
    }
  }, { capture: true });

  const commandButtons: Array<{ button: HTMLButtonElement; command: ScoreCommand; needsInput: boolean }> = [];
  const modeButtons = new Map<string, HTMLButtonElement>();
  const selectionButtons = new Map<string, HTMLButtonElement>();
  const status = element("div", "mobile-feedback");
  status.id = "mobile-feedback"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  const feedback = (message: string): void => {
    status.textContent = message;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => { status.textContent = ""; }, 3500);
  };
  const command = (intent: ScoreCommand): void => {
    if (queueCount >= 64) return;
    const sourceView = app.codePaneCollapsed ? scoreView() : "text";
    queueCount++;
    commandQueue = commandQueue.then(async () => {
      try {
        // A queued tap belongs to the surface on which it was made. Switching
        // to preview/text must never apply it to a different input surface.
        if (intent.type !== "undo" && intent.type !== "redo"
          && (!notationVisible() || sourceView !== scoreView())) return;
        if (!(await app.executeScoreCommand(intent))) update();
      } catch (error) { feedback(error instanceof Error ? error.message : String(error)); }
      finally {
        queueCount--; update();
        if (isTouchWorkspace() && app.codePaneCollapsed) requestAnimationFrame(() => app.revealScoreEditorTarget());
      }
    });
  };
  const commandButton = (text: string, label: string, intent: ScoreCommand, needsInput = true, className = ""): HTMLButtonElement => {
    const node = button(text, label, () => command(intent), className);
    node.dataset.scoreCommand = intent.type;
    commandButtons.push({ button: node, command: intent, needsInput });
    return node;
  };
  const existingAction = (id: string): void => { closeSheet?.(); document.getElementById(id)?.click(); };
  const focusScore = (): void => { (app.getActiveScoreSurface() === "staff" ? staffPane : scorePane).focus({ preventScroll: true }); };
  const chooseView = async (view: MobileScoreView): Promise<void> => {
    closeSheet?.();
    if (!(await requestCloseInspector())) { update(); return; }
    marquee = false;
    if (view === "text") {
      app.setInteractionMode("view");
      app.setCodePaneCollapsed(false);
      update();
      app.view.focus();
    } else {
      if (view === "compare" || !app.codePaneCollapsed) app.setInteractionMode("view");
      app.setCodePaneCollapsed(true);
      document.dispatchEvent(new CustomEvent("workspace:score-view", { detail: view }));
      update(); focusScore();
    }
  };

  const showSheet = (title: string, content: HTMLElement): void => {
    closeSheet?.();
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer = element("div", "mobile-sheet-layer");
    const pane = element("section", "mobile-sheet");
    pane.setAttribute("role", "dialog"); pane.setAttribute("aria-modal", "true"); pane.setAttribute("aria-label", title);
    const head = element("header", "mobile-sheet-header");
    head.append(element("h2", "", title));
    const close = (): void => {
      layer.remove(); document.removeEventListener("keydown", keydown, true);
      if (sheet === layer) { sheet = null; closeSheet = null; }
      syncModalInert();
      if (origin?.isConnected) origin.focus({ preventScroll: true });
    };
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      if (event.key !== "Tab") return;
      const items = [...pane.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex='0']")];
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    head.append(button("关闭", "关闭面板", close));
    content.classList.add("mobile-sheet-content");
    pane.append(head, content); layer.append(pane); document.body.append(layer);
    layer.addEventListener("click", event => { if (event.target === layer) close(); });
    document.addEventListener("keydown", keydown, true);
    sheet = layer; closeSheet = close;
    syncModalInert();
    pane.querySelector<HTMLElement>("button,select,input")?.focus({ preventScroll: true });
  };
  const modeChooser = (): HTMLElement => {
    const field = element("label", "mobile-sheet-field");
    field.append(element("span", "", "工作区模式"));
    const select = element("select"); select.setAttribute("aria-label", "工作区模式");
    for (const value of ["auto", "phone", "tablet", "desktop"] as const) {
      const option = element("option", "", MODE_LABELS[value]); option.value = value; select.append(option);
    }
    select.value = getWorkspaceModePreference();
    select.addEventListener("change", () => { setWorkspaceModePreference(select.value as WorkspaceModePreference); });
    field.append(select); return field;
  };
  const showModes = (): void => {
    const content = element("div", "mobile-sheet-list"); content.append(modeChooser());
    content.append(element("p", "mobile-sheet-help", "自动模式随窗口空间调整。连接键盘或鼠标后，当前工作区保持不变。"));
    showSheet("工作区", content);
  };
  const desktopMode = document.getElementById("btn-workspace-mode");
  desktopMode?.addEventListener("click", showModes);

  const bar = element("header", "mobile-workspace-bar"); bar.id = "mobile-workspace-bar";
  const identity = element("div", "mobile-document-info"); identity.id = "mobile-document-info";
  const title = element("span", "mobile-document-name"); title.id = "mobile-document-name";
  identity.append(title);
  const fileButton = button("☷", "文件", () => showFiles()); fileButton.id = "mobile-file-menu";
  const undo = commandButton("↶", "撤销", { type: "undo" }, false); undo.id = "mobile-undo";
  const redo = commandButton("↷", "重做", { type: "redo" }, false); redo.id = "mobile-redo";
  const play = button("▶", "播放或停止", () => existingAction("btn-play")); play.id = "mobile-play";
  const more = button("⋯", "更多设置", () => showMore()); more.id = "mobile-more";
  bar.append(fileButton, identity, undo, redo, play, more);
  const modes = element("div", "mobile-mode-bar"); modes.id = "mobile-mode-bar";
  const modeGroup = element("div", "mobile-mode-group"); modeGroup.setAttribute("role", "group"); modeGroup.setAttribute("aria-label", "谱面操作模式");
  for (const [value, label] of [["view", "浏览"], ["select", "选择"], ["input", "打谱"]] as const) {
    const node = button(label, `${label}模式`, () => {
      void (async () => {
        if (!(await requestCloseInspector())) return;
        marquee = false;
        if (value === "input") { collapsed = false; tab = "notes"; }
        command({ type: "set-mode", mode: value });
      })();
    });
    node.dataset.mobileMode = value; modeButtons.set(value, node); modeGroup.append(node);
  }
  const surfaceSelect = element("select", "mobile-surface-select"); surfaceSelect.id = "mobile-surface-select";
  surfaceSelect.setAttribute("aria-label", "乐谱视图");
  for (const [value, label] of [["jianpu", "简谱"], ["staff", "五线谱"], ["compare", "对照"], ["text", "文本谱"]]) {
    const option = element("option", "", label); option.value = value; surfaceSelect.append(option);
  }
  surfaceSelect.addEventListener("change", () => { void chooseView(surfaceSelect.value as MobileScoreView); });
  const viewTools = button("适宽", "缩放与页面", () => showViewTools(), "mobile-view-tools"); viewTools.id = "mobile-view-tools";
  const viewLabel = element("span", "mobile-view-label");
  modes.append(modeGroup, viewLabel, surfaceSelect, viewTools);
  const previewActions = element("div", "mobile-preview-actions"); previewActions.id = "mobile-preview-actions";
  previewActions.append(button("打开简谱", "打开简谱进行编辑", () => { void chooseView("jianpu"); }),
    button("打开五线谱", "打开五线谱进行编辑", () => { void chooseView("staff"); }));
  const desktopHeader = document.getElementById("app-header")!;
  desktopHeader.after(bar, modes, previewActions);

  const dock = element("section", "mobile-command-dock"); dock.id = "mobile-command-dock";
  dock.setAttribute("aria-label", "触屏打谱操作盘");
  const dockHead = element("div", "mobile-dock-header");
  const tabs = element("div", "mobile-dock-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "打谱工具分类");
  const tabButtons = new Map<PanelTab, HTMLButtonElement>();
  for (const [value, label] of [["notes", "音符"], ["edit", "编辑"], ["marks", "记号"]] as const) {
    const node = button(label, `${label}工具`, () => { tab = value; collapsed = false; update(); });
    node.setAttribute("role", "tab"); node.id = `mobile-tab-${value}`; node.setAttribute("aria-controls", `mobile-panel-${value}`);
    tabButtons.set(value, node); tabs.append(node);
  }
  const fold = button("⌄", "收起操作盘", () => { collapsed = !collapsed; update(); }, "mobile-dock-fold"); fold.id = "mobile-dock-fold";
  const keyboardSwitch = button("数字", "切换输入键盘", () => showKeyboardLayouts(), "mobile-keyboard-switch"); keyboardSwitch.id = "mobile-keyboard-switch";
  dockHead.append(tabs, keyboardSwitch, fold);
  const selectionTools = element("div", "mobile-selection-tools"); selectionTools.setAttribute("role", "group"); selectionTools.setAttribute("aria-label", "选择方式");
  for (const [value, label] of [["single", "单选"], ["multiple", "多选"], ["range", "范围"], ["marquee", "框选"]] as const) {
    const node = button(label, value === "range" ? "先点起点，再点终点选择范围" : `${label}音符`, () => {
      marquee = value === "marquee";
      if (marquee) {
        command({ type: "set-mode", mode: "select" });
        feedback("在谱面拖出选框；双指仍可缩放。完成后可切回单选。");
      } else if (value !== "marquee") command({ type: "set-selection-mode", mode: value });
      update();
    });
    node.dataset.selectionTool = value; selectionButtons.set(value, node); selectionTools.append(node);
  }
  const selectionCount = element("span", "mobile-selection-count"); selectionCount.id = "mobile-selection-count";
  selectionTools.append(selectionCount, commandButton("清除", "清除选区", { type: "clear-selection" }, false));
  const dockContent = element("div", "mobile-dock-content");
  const panels = new Map<PanelTab, HTMLElement>();
  for (const value of ["notes", "edit", "marks"] as const) {
    const panel = element("div", `mobile-command-panel mobile-${value}-panel`); panel.id = `mobile-panel-${value}`;
    panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", `mobile-tab-${value}`);
    panels.set(value, panel); dockContent.append(panel);
  }
  const notes = panels.get("notes")!;
  const timing = element("div", "mobile-timing-row");
  const duration = button("时值", "设置书写时值", () => showTiming("pending")); duration.id = "mobile-duration";
  const dot = commandButton("附点", "书写附点", { type: "toggle-dot", target: "pending" }); dot.id = "mobile-dot";
  const grid = button("刻度", "设置光标移动刻度", () => showTiming("grid")); grid.id = "mobile-grid";
  timing.append(duration, dot, grid);
  const register = element("div", "mobile-register-row");
  const octaveLabel = element("label", "mobile-octave-label"); octaveLabel.append(element("span", "", "音区"));
  const octaveSelect = element("select"); octaveSelect.id = "mobile-octave"; octaveSelect.setAttribute("aria-label", "输入音区");
  for (let value = -3; value <= 3; value++) {
    const option = element("option", "", value === 0 ? "中音" : value === -1 ? "低音" : value === 1 ? "高音" : `${value < 0 ? "低" : "高"}${Math.abs(value)}个八度`);
    option.value = String(value); octaveSelect.append(option);
  }
  octaveSelect.value = "0"; octaveSelect.addEventListener("change", () => { octave = Number(octaveSelect.value); });
  octaveLabel.append(octaveSelect);
  const staffOctaveLabel = element("label", "mobile-octave-label"); staffOctaveLabel.append(element("span", "", "八度"));
  const staffOctaveSelect = element("select"); staffOctaveSelect.id = "mobile-staff-octave"; staffOctaveSelect.setAttribute("aria-label", "五线谱输入八度");
  for (let value = 0; value <= 8; value++) {
    const option = element("option", "", value === 4 ? "4 · 中央C" : `${value} · C${value}`);
    option.value = String(value); staffOctaveSelect.append(option);
  }
  staffOctaveSelect.value = "4";
  staffOctaveSelect.addEventListener("change", () => { staffOctave = Number(staffOctaveSelect.value); updateStaffKeyLabels(); });
  staffOctaveLabel.append(staffOctaveSelect);
  const rest = commandButton("0 休止", "写入休止符", { type: "input-degree", degree: 0 }); rest.id = "mobile-rest";
  const autoAdvance = button("自动前进", "输入后自动前进", () => command({ type: "set-auto-advance", enabled: !app.getScoreEditorState().autoAdvance })); autoAdvance.id = "mobile-auto-advance";
  register.append(octaveLabel, staffOctaveLabel, rest, autoAdvance);
  const accidentalRow = element("div", "mobile-staff-accidentals"); accidentalRow.setAttribute("role", "group"); accidentalRow.setAttribute("aria-label", "五线谱输入变音");
  const accidentalButtons = new Map<number | undefined, HTMLButtonElement>();
  for (const [alter, text, label] of [[undefined, "随调号", "按当前调号输入"], [-1, "♭ 降", "输入降音"], [0, "♮ 本位", "输入本位音"], [1, "♯ 升", "输入升音"]] as const) {
    const node = button(text, label, () => { staffAccidental = alter; update(); });
    node.dataset.staffAccidental = alter === undefined ? "key" : String(alter);
    accidentalButtons.set(alter, node); accidentalRow.append(node);
  }
  const digits = element("div", "mobile-number-keyboard"); digits.setAttribute("role", "group"); digits.setAttribute("aria-label", "数字简谱键盘");
  for (const degree of [1, 2, 3, 4, 5, 6, 7] as const) {
    const node = button(String(degree), `输入音级 ${degree}`, () => command({ type: "input-degree", degree, octave }), "mobile-degree-key");
    node.dataset.mobileDegree = String(degree); digits.append(node);
    commandButtons.push({ button: node, command: { type: "input-degree", degree }, needsInput: true });
  }
  const lyre = element("div", "mobile-lyre-keyboard"); lyre.setAttribute("role", "group"); lyre.setAttribute("aria-label", "原琴21键键盘");
  for (const row of ["QWERTYU", "ASDFGHJ", "ZXCVBNM"]) for (const letter of row) {
    const mapped = keyboardNoteForKey(letter)!;
    const intent: ScoreCommand = { type: "input-degree", degree: mapped.degree, octave: mapped.octave };
    const node = commandButton(letter, `${letter}，${mapped.octave < 0 ? "低音" : mapped.octave > 0 ? "高音" : "中音"}${mapped.degree}`, intent, true, "mobile-lyre-key");
    node.dataset.lyreKey = letter; node.dataset.octave = String(mapped.octave); lyre.append(node);
  }
  const letters = element("div", "mobile-letter-keyboard"); letters.setAttribute("role", "group"); letters.setAttribute("aria-label", "音名键盘");
  for (const letter of ["C", "D", "E", "F", "G", "A", "B"] as const) {
    const node = button(letter, `输入音名 ${letter}`, () => command({ type: "input-letter", letter,
      octave: scoreView() === "staff" ? staffOctave : octave + 4,
      accidental: scoreView() === "staff" ? staffAccidental : undefined }), "mobile-letter-key");
    node.dataset.inputLetter = letter; letters.append(node);
    commandButtons.push({ button: node, command: { type: "input-letter", letter }, needsInput: true });
  }
  function updateStaffKeyLabels(): void {
    const staff = scoreView() === "staff";
    const alter = staffAccidental === -1 ? "♭" : staffAccidental === 0 ? "♮" : staffAccidental === 1 ? "♯" : "";
    for (const node of letters.querySelectorAll<HTMLButtonElement>("button")) {
      const label = `${node.dataset.inputLetter}${staff ? `${alter}${staffOctave}` : ""}`;
      node.textContent = label; node.setAttribute("aria-label", `输入音名 ${label}`);
    }
  }
  const staffInputHelp = element("p", "mobile-staff-input-help", "先选时值，点谱面定位，再按音名输入；也可确认谱面上的预览音。C4 是中央 C。");
  const navigation = element("div", "mobile-note-navigation");
  navigation.append(commandButton("←", "向前移动光标", { type: "move-cursor", direction: "left" }),
    commandButton("下方＋", "准备下方和弦音", { type: "prepare-chord", side: "below" }),
    commandButton("前进", "按书写时值前进", { type: "advance" }),
    commandButton("上方＋", "准备上方和弦音", { type: "prepare-chord", side: "above" }),
    commandButton("→", "向后移动光标", { type: "move-cursor", direction: "right" }),
    commandButton("⌫", "删除当前音符", { type: "delete" }));
  const chordDone = commandButton("完成和弦", "完成和弦并恢复连续输入", { type: "finish-chord" }); chordDone.id = "mobile-finish-chord";
  const preciseNavigation = element("div", "mobile-precise-navigation");
  preciseNavigation.append(commandButton("下层", "移动到下方和弦层", { type: "move-cursor", direction: "down" }),
    commandButton("确认输入", "按当前光标音高确认输入", { type: "confirm-input" }),
    commandButton("上层", "移动到上方和弦层", { type: "move-cursor", direction: "up" }),
    button("定位…", "跳到声部、小节或首尾", () => showPosition()));
  const startInput = commandButton("从开头输入", "从第一小节开始输入", { type: "start-input", at: "start" }, false, "mobile-start-input");
  notes.append(startInput, timing, register, accidentalRow, digits, lyre, letters, staffInputHelp, navigation, preciseNavigation, chordDone);

  const edit = panels.get("edit")!;
  const editingTools = element("div", "mobile-edit-grid");
  for (const [text, label, intent] of [
    ["低八度", "降低八度", { type: "pitch", movement: "octave", delta: -1 }],
    ["高八度", "升高八度", { type: "pitch", movement: "octave", delta: 1 }],
    ["降半音", "降低半音", { type: "pitch", movement: "semitone", delta: -1 }],
    ["升半音", "升高半音", { type: "pitch", movement: "semitone", delta: 1 }],
    ["下一级", "降低一个音级", { type: "pitch", movement: "diatonic", delta: -1 }],
    ["上一级", "升高一个音级", { type: "pitch", movement: "diatonic", delta: 1 }],
    ["提前", "向前移动音符起点", { type: "move-note", direction: "earlier" }],
    ["延后", "向后移动音符起点", { type: "move-note", direction: "later" }],
    ["缩短", "缩短音符时值", { type: "resize-note", delta: -1 }],
    ["延长", "延长音符时值", { type: "resize-note", delta: 1 }],
    ["上移声部", "移到上一声部", { type: "move-note", direction: "part-up" }],
    ["下移声部", "移到下一声部", { type: "move-note", direction: "part-down" }],
  ] as Array<[string, string, ScoreCommand]>) editingTools.append(commandButton(text, label, intent));
  const selectionDuration = button("设置选中音时值", "设置选中音的真实时值", () => showTiming("selection")); selectionDuration.id = "mobile-selection-duration";
  const partLabel = element("label", "mobile-part-label"); partLabel.append(element("span", "", "当前声部"));
  const partSelect = element("select"); partSelect.id = "mobile-part"; partSelect.setAttribute("aria-label", "当前声部");
  partSelect.addEventListener("change", () => command({ type: "select-part", partIndex: Number(partSelect.value) })); partLabel.append(partSelect);
  const partActions = element("div", "mobile-part-actions"); partActions.append(partLabel,
    button("分配声部", "把选中音分配到声部", () => showVoices()));
  const measures = element("div", "mobile-measure-actions"); measures.append(
    commandButton("前插小节", "在当前小节前插入小节", { type: "insert-measure", side: "before" }),
    commandButton("后插小节", "在当前小节后插入小节", { type: "insert-measure", side: "after" }),
    commandButton("删除小节", "删除当前选中小节", { type: "delete-measures" }),
    commandButton("删除音符", "删除当前音符", { type: "delete" }));
  edit.append(editingTools, selectionDuration, partActions, measures);

  const marks = panels.get("marks")!;
  const markGrid = element("div", "mobile-mark-grid");
  for (const [kind, label] of [
    ["triplet", "三连音"], ["slur", "连音线"], ["grace", "倚音"], ["fermata", "延长记号"],
    ["upper-mordent", "上波音"], ["lower-mordent", "下波音"], ["trill", "颤音"], ["arpeggio", "琶音"],
    ["cross-arpeggio", "跨行琶音"], ["tempo", "速度"], ["accel", "渐快"], ["rit", "渐慢"],
    ["key", "调号"], ["meter", "拍号"], ["text", "文字"],
  ] as Array<[ScoreMarkKind, string]>) markGrid.append(commandButton(label, `添加${label}`, { type: "add-mark", kind }));
  const objects = element("div", "mobile-object-list"); objects.id = "mobile-object-list";
  const objectActions = element("div", "mobile-object-actions"); objectActions.append(
    commandButton("编辑记号", "编辑选中的记号", { type: "edit-object" }),
    commandButton("删除记号", "删除选中的记号", { type: "delete-object" }));
  marks.append(markGrid, objects, objectActions);
  const enterInput = commandButton("进入打谱后可修改", "进入打谱模式", { type: "start-input", at: "selection" }, false, "mobile-enter-input");
  enterInput.id = "mobile-enter-input";
  const position = element("div", "mobile-position"); position.id = "mobile-position"; position.setAttribute("aria-live", "polite");
  dock.append(dockHead, selectionTools, enterInput, dockContent, position);
  root.insertBefore(dock, document.getElementById("score-input-keypad"));
  root.append(status);

  const codeHeader = document.getElementById("code-workspace-header")!;
  const closeText = button("返回乐谱", "关闭文本谱", () => { void chooseView(scoreView()); }, "mobile-close-text");
  closeText.id = "mobile-close-text"; codeHeader.append(closeText);

  function showTiming(target: "pending" | "selection" | "grid"): void {
    const state = app.getScoreEditorState();
    const content = element("div", "mobile-timing-sheet");
    const choices = element("div", "mobile-duration-choices");
    if (target !== "selection") choices.append(button("自动", "自动跟随", () => {
      command(target === "grid" ? { type: "set-grid", division: null } : { type: "set-duration", division: null, target }); closeSheet?.();
    }));
    for (const division of DIVISIONS) {
      const node = button(division === 1 ? "全音符" : `${division}分音符`, `${division === 1 ? "全" : division + "分"}音符`, () => {
        command(target === "grid" ? { type: "set-grid", division } : { type: "set-duration", division, target }); closeSheet?.();
      });
      node.disabled = !state.availableDivisions.includes(division);
      if (node.disabled) node.title = "当前位置不能使用该时值";
      choices.append(node);
    }
    content.append(choices, button("切换附点", "切换附点", () => {
      command({ type: "toggle-dot", target }); closeSheet?.();
    }));
    showSheet(target === "grid" ? "光标刻度" : target === "selection" ? "选中音时值" : "书写时值", content);
  }
  function showVoices(): void {
    const content = element("div", "mobile-sheet-list");
    const state = app.getScoreEditorState();
    for (let voice = 1; voice <= Math.max(2, state.voiceCount); voice++) content.append(button(`声部 ${voice}`, `分配到声部 ${voice}`, () => {
      command({ type: "assign-voice", voice }); closeSheet?.();
    }));
    showSheet("分配声部", content);
  }
  function showKeyboardLayouts(): void {
    const content = element("div", "mobile-sheet-list");
    for (const [layout, label] of [["number", "数字简谱 1–7"], ["lyre", "原琴21键 QWERTYU / ASDFGHJ / ZXCVBNM"], ["letters", "音名 C–B"]] as const) {
      const node = button(label, label, () => {
        keyboardLayout = layout;
        try { localStorage.setItem("jpeditor:touch-keyboard:v1", layout); } catch { /* Apply this session. */ }
        closeSheet?.(); update();
      });
      node.setAttribute("aria-pressed", String(keyboardLayout === layout)); content.append(node);
    }
    showSheet("输入键盘", content);
  }
  function showPosition(): void {
    const state = app.getScoreEditorState();
    const content = element("div", "mobile-sheet-list");
    const row = element("label", "mobile-sheet-field"); row.append(element("span", "", "小节"));
    const measure = element("input"); measure.type = "number"; measure.min = "1"; measure.step = "1";
    measure.value = String((state.cursor?.measureIndex ?? 0) + 1); measure.setAttribute("aria-label", "跳转小节号"); row.append(measure);
    const partRow = element("label", "mobile-sheet-field"); partRow.append(element("span", "", "声部"));
    const part = element("select"); part.setAttribute("aria-label", "跳转声部");
    for (const choice of state.parts) { const option = element("option", "", choice.label); option.value = String(choice.index); part.append(option); }
    part.value = String(state.cursor?.partIndex ?? 0); partRow.append(part);
    content.append(row, partRow, button("定位", "定位到指定小节", () => {
      if (!measure.reportValidity()) return;
      const value = Number(measure.value);
      if (!Number.isInteger(value) || value < 1) return;
      command({ type: "set-position", position: { partIndex: Number(part.value), measureIndex: value - 1, offset: "0",
        midi: state.cursor?.midi, step: state.cursor?.step, octave: state.cursor?.octave } }); closeSheet?.();
    }), button("乐谱开头", "从乐谱开头输入", () => { command({ type: "start-input", at: "start" }); closeSheet?.(); }),
    button("乐谱末尾", "从乐谱末尾继续输入", () => { command({ type: "start-input", at: "end" }); closeSheet?.(); }));
    showSheet("定位", content);
  }
  function showFiles(): void {
    const content = element("div", "mobile-sheet-list");
    for (const [id, label] of [["btn-create", "新建乐谱"], ["btn-open", "打开乐谱或 MIDI"], ["btn-save", "保存"],
      ["btn-saveas", "另存为"], ["btn-export", "导出 / 分享"], ["btn-add-slashes", "添加斜杠"]]) content.append(button(label, label, () => existingAction(id)));
    const fileFeatures = app as App & { showMobileDrafts?: () => void | Promise<void>; openRecognitionFile?: (source: "files" | "photos" | "camera") => void | Promise<void> };
    if (fileFeatures.showMobileDrafts) content.append(button("恢复本机草稿", "恢复本机草稿", () => { closeSheet?.(); void fileFeatures.showMobileDrafts?.(); }));
    if (fileFeatures.openRecognitionFile) for (const [source, label] of [["files", "识别图片 / PDF"], ["photos", "从相册识谱"], ["camera", "拍照识谱"]] as const)
      content.append(button(label, label, () => { closeSheet?.(); void fileFeatures.openRecognitionFile?.(source); }));
    showSheet("文件", content);
  }
  function showMore(): void {
    const content = element("div", "mobile-sheet-list");
    content.append(button(app.codePaneCollapsed ? "打开文本谱" : "返回乐谱", "切换文本谱", () => {
      void chooseView(app.codePaneCollapsed ? "text" : scoreView());
    }));
    for (const [id, label] of [["btn-midi-input", "MIDI 输入设备…"], ["btn-score-settings", "乐谱设置"], ["btn-layout-style", "排版设置"],
      ["btn-options", "应用设置"], ["btn-help", "帮助与记谱法"]]) content.append(button(label, label, () => existingAction(id)));
    content.append(modeChooser());
    showSheet("更多", content);
  }
  function showViewTools(): void {
    const content = element("div", "mobile-view-sheet");
    const zoomRow = element("div", "mobile-view-sheet-row");
    const zoomValue = element("output", "", `${Math.round(app.workspaceSummary().zoom * 100)}%`);
    const refresh = (): void => { zoomValue.textContent = `${Math.round(app.workspaceSummary().zoom * 100)}%`; };
    const reveal = (): void => { requestAnimationFrame(() => app.revealScoreEditorTarget()); };
    zoomRow.append(button("−", "缩小谱面", () => { app.zoomBy(1 / 1.2); refresh(); reveal(); }), zoomValue,
      button("＋", "放大谱面", () => { app.zoomBy(1.2); refresh(); reveal(); }), button("适宽", "适合谱面宽度", () => { app.resetZoom(); refresh(); reveal(); }));
    const pages = element("div", "mobile-view-sheet-row");
    const pageValue = element("output", "", `${app.workspaceSummary().page} / ${Math.max(1, app.workspaceSummary().pages)}`);
    pages.append(button("上一页", "上一页", () => { app.prevPage(); pageValue.textContent = `${app.workspaceSummary().page} / ${app.workspaceSummary().pages}`; }), pageValue,
      button("下一页", "下一页", () => { app.nextPage(); pageValue.textContent = `${app.workspaceSummary().page} / ${app.workspaceSummary().pages}`; }));
    content.append(zoomRow, pages, button("恢复播放跟随", "恢复当前谱面播放跟随", () => { existingAction("staff-resume-follow"); closeSheet?.(); }));
    showSheet("页面与缩放", content);
  }

  registerTouchScoreSurface("jianpu", {
    activate: () => { scorePane.focus({ preventScroll: true }); },
    zoom: () => app.zoom,
    setZoom: value => app.setZoom(value),
    pageAt: point => {
      let best: HTMLElement | null = null, distance = Infinity;
      for (const page of scorePane.querySelectorAll<HTMLElement>(".score-page-wrap")) {
        const rect = page.getBoundingClientRect();
        const delta = point.y < rect.top ? rect.top - point.y : point.y > rect.bottom ? point.y - rect.bottom : 0;
        if (delta < distance) { distance = delta; best = page; }
      }
      return best;
    },
    candidates: point => app.getTouchScoreCandidates(point.x, point.y),
    tap: (point, selection, candidate) => { app.touchScoreAtPoint(point.x, point.y, { selection, candidate }); },
    marquee: (rect, additive) => app.selectTouchScoreRect(rect, { additive }),
    context: point => {
      app.touchScoreAtPoint(point.x, point.y, { selection: app.getScoreEditorState().selectionMode });
      document.dispatchEvent(new CustomEvent("workspace:touch-actions", { detail: { surface: "jianpu", point } }));
    },
  });
  const showCandidates = (surface: ScoreSurface, point: TouchPoint, candidates: ScoreTouchCandidate[], selection: ScoreSelectionMode, context = false): void => {
    const content = element("div", "mobile-sheet-list mobile-candidate-list");
    content.append(element("p", "mobile-sheet-help", "这里有几个相邻目标，请选择要操作的音符或记号。"));
    for (const candidate of candidates.slice(0, 16)) {
      content.append(button(candidate.label, candidate.label, () => {
        closeSheet?.(); touchScoreSurface(surface)?.tap(point, selection, candidate);
        if (context) { tab = "edit"; collapsed = false; update(); }
      }));
    }
    showSheet("选择目标", content);
  };
  const touchAction = (surface: ScoreSurface, point: TouchPoint, context = false): void => {
    if (!notationVisible()) return;
    const state = app.getScoreEditorState();
    if (state.mode === "view") return;
    const adapter = touchScoreSurface(surface);
    if (!adapter) return;
    const candidates = adapter.candidates(point);
    const nearby = candidates.filter(item => item.distance <= Math.min(22, (candidates[0]?.distance ?? 0) + 8));
    if (nearby.length > 1) { showCandidates(surface, point, nearby, state.selectionMode, context); return; }
    if (context) adapter.context(point);
    else adapter.tap(point, state.selectionMode, candidates[0]);
  };
  for (const [id, container] of [["jianpu", scorePane], ["staff", staffPane]] as const) wireTouchGestures(container, {
    enabled: isTouchWorkspace,
    interactionMode: () => notationVisible() ? app.interactionMode : "view",
    surface: () => touchScoreSurface(id),
    tool: () => notationVisible() && marquee && app.interactionMode !== "view" ? "marquee" : "pan",
    tap: point => touchAction(id, point),
    context: point => touchAction(id, point, true),
    marquee: rect => { if (notationVisible()) touchScoreSurface(id)?.marquee(rect, app.getScoreEditorState().selectionMode === "multiple"); },
  });
  document.addEventListener("workspace:touch-actions", () => { if (notationVisible()) { tab = "edit"; collapsed = false; update(); } });

  function updateViewport(): void {
    resizeFrame = 0;
    const touch = isTouchWorkspace();
    const vv = window.visualViewport;
    if (Math.abs(window.innerWidth - viewportWidth) > 80) { viewportWidth = window.innerWidth; viewportHeight = window.innerHeight; }
    if (!activeEditorField()) viewportHeight = Math.max(viewportHeight, window.innerHeight);
    const height = vv && Math.abs(vv.scale - 1) < .02 ? vv.height : window.innerHeight;
    const keyboard = touch && activeEditorField() && height < viewportHeight - 140;
    const layoutHeight = keyboard ? viewportHeight : window.innerHeight;
    const html = document.documentElement;
    html.dataset.mobileDock = layoutHeight < 500 && window.innerWidth >= 600 ? "right" : "bottom";
    html.dataset.mobileKeyboard = String(keyboard);
    html.style.setProperty("--workspace-viewport-height", `${height}px`);
    html.style.setProperty("--workspace-viewport-top", `${vv && Math.abs(vv.scale - 1) < .02 ? vv.offsetTop : 0}px`);
    const nextCompact = touch && layoutHeight < 500 && window.innerWidth < 600;
    if (nextCompact !== compactViewport) {
      if (nextCompact) { beforeCompactCollapsed = collapsed; collapsed = true; }
      else collapsed = beforeCompactCollapsed;
      compactViewport = nextCompact;
      update();
    }
    if (keyboard) {
      const field = document.activeElement;
      const bounds = field?.getBoundingClientRect();
      if (!field?.closest("#code-pane") && bounds && (bounds.bottom > height + (vv?.offsetTop ?? 0) || bounds.top < (vv?.offsetTop ?? 0))) field?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    const changed = Math.abs(visibleSize.width - window.innerWidth) > 1 || Math.abs(visibleSize.height - height) > 1;
    visibleSize = { width: window.innerWidth, height };
    if (changed && touch && app.codePaneCollapsed) requestAnimationFrame(() => app.revealScoreEditorTarget());
    else if (changed && touch && app.view?.hasFocus) requestAnimationFrame(() => {
      if (app.view?.hasFocus) app.view.dispatch({ effects: EditorView.scrollIntoView(app.view.state.selection.main.head, { y: "nearest", yMargin: 12 }) });
    });
  }
  const scheduleViewport = (): void => { if (!resizeFrame) resizeFrame = requestAnimationFrame(updateViewport); };

  function update(): void {
    const touch = isTouchWorkspace();
    if (wasTouchWorkspace !== touch) {
      const previousTouch = wasTouchWorkspace; wasTouchWorkspace = touch;
      if (touch) { desktopCodeCollapsed = app.codePaneCollapsed; app.setCodePaneCollapsed(true); }
      else if (previousTouch !== null) app.setCodePaneCollapsed(desktopCodeCollapsed);
    }
    const view = scoreView();
    const textView = !app.codePaneCollapsed;
    const compare = !textView && view === "compare";
    const staff = view === "staff";
    if (touch && !notationVisible() && app.interactionMode !== "view") {
      marquee = false; app.setInteractionMode("view");
    }
    const state = app.getScoreEditorState();
    const html = document.documentElement;
    html.dataset.mobileInteraction = state.mode;
    html.dataset.mobileText = String(textView);
    html.dataset.mobilePreview = String(compare);
    html.dataset.mobileSurface = textView ? "text" : view;
    html.dataset.mobileDockCollapsed = String(collapsed);
    if (virtualized !== touch) { virtualized = touch; app.setTouchPageVirtualization(touch); }
    bar.hidden = modes.hidden = !touch;
    dock.hidden = !touch || textView || compare;
    previewActions.hidden = !touch || !compare;
    modeGroup.hidden = textView || compare;
    viewLabel.hidden = !textView && !compare;
    viewLabel.textContent = textView ? "文本编辑" : "对照 · 仅预览";
    viewTools.hidden = textView;
    undo.hidden = redo.hidden = compare;
    title.textContent = app.workspaceSummary().documentName;
    for (const [mode, node] of modeButtons) node.setAttribute("aria-pressed", String(state.mode === mode));
    for (const [value, node] of selectionButtons) node.setAttribute("aria-pressed", String(value === "marquee" ? marquee : !marquee && state.selectionMode === value));
    for (const [value, node] of tabButtons) { node.setAttribute("aria-selected", String(value === tab)); node.tabIndex = value === tab ? 0 : -1; }
    for (const [value, panel] of panels) panel.hidden = value !== tab || collapsed;
    selectionTools.hidden = state.mode === "view" || collapsed;
    dockContent.hidden = collapsed || state.mode === "view";
    enterInput.hidden = state.mode === "input" || state.mode === "view" || collapsed;
    selectionCount.textContent = state.selection.count ? `已选 ${state.selection.count}` : "";
    fold.textContent = collapsed ? "⌃" : "⌄";
    fold.setAttribute("aria-expanded", String(!collapsed)); fold.setAttribute("aria-label", collapsed ? "展开操作盘" : "收起操作盘");
    duration.textContent = `时值 ${state.duration.automatic ? "自动·" : ""}${state.duration.division === 1 ? "全" : "1/" + state.duration.division}`;
    grid.textContent = `刻度 ${state.grid.automatic ? "自动" : state.grid.division === 1 ? "全" : "1/" + state.grid.division}${state.grid.dotted ? "·" : ""}`;
    dot.setAttribute("aria-pressed", String(state.duration.dotted));
    dot.disabled = state.mode !== "input" || !state.duration.canDot;
    autoAdvance.setAttribute("aria-pressed", String(state.autoAdvance));
    chordDone.hidden = !state.chordSide;
    keyboardSwitch.hidden = staff || tab !== "notes" || collapsed;
    keyboardSwitch.textContent = keyboardLayout === "number" ? "数字" : keyboardLayout === "lyre" ? "21键" : "音名";
    digits.hidden = staff || keyboardLayout !== "number";
    lyre.hidden = staff || keyboardLayout !== "lyre";
    letters.hidden = !staff && keyboardLayout !== "letters";
    octaveLabel.hidden = staff;
    staffOctaveLabel.hidden = accidentalRow.hidden = staffInputHelp.hidden = !staff;
    staffOctaveSelect.disabled = state.mode !== "input";
    rest.textContent = staff ? "休止符" : "0 休止";
    for (const [alter, node] of accidentalButtons) {
      node.setAttribute("aria-pressed", String(alter === staffAccidental));
      node.disabled = state.mode !== "input";
    }
    notes.dataset.keyboardLayout = staff ? "staff" : keyboardLayout;
    dock.setAttribute("aria-label", staff ? "五线谱触屏打谱操作盘" : "简谱触屏打谱操作盘");
    const nextCursorKey = state.cursor ? `${view}/${state.cursor.partIndex}/${state.cursor.measureIndex}/${state.cursor.offset}/${state.cursor.jpOctave}/${state.cursor.octave}` : "";
    if (nextCursorKey !== cursorKey) {
      cursorKey = nextCursorKey;
      if (state.cursor) {
        octave = Math.max(-3, Math.min(3, state.cursor.jpOctave));
        if (staff) staffOctave = Math.max(0, Math.min(8, state.cursor.octave ?? 4));
      }
      octaveSelect.value = String(octave);
      staffOctaveSelect.value = String(staffOctave);
    }
    updateStaffKeyLabels();
    const partsKey = state.parts.map(part => `${part.index}:${part.label}`).join("|");
    if (partSelect.dataset.parts !== partsKey) {
      partSelect.dataset.parts = partsKey;
      partSelect.replaceChildren(...state.parts.map(part => { const option = element("option", "", part.label); option.value = String(part.index); return option; }));
    }
    if (state.cursor) partSelect.value = String(state.cursor.partIndex);
    partSelect.disabled = state.mode !== "input";
    selectionDuration.disabled = state.mode !== "input" || !state.selection.noteCount;
    for (const item of commandButtons) {
      const availability = state.actions[item.command.type === "add-mark" ? `add-mark:${item.command.kind}` : item.command.type];
      const disabled = compare || item.needsInput && (state.mode !== "input" || !state.ready) || availability?.enabled === false;
      item.button.disabled = disabled;
      if (availability?.reason) item.button.title = availability.reason;
    }
    dot.disabled = state.mode !== "input" || !state.duration.canDot;
    const objectsKey = state.objects.map(object => `${object.ref.revision}:${object.ref.id}:${object.label}:${object.selected}`).join("|");
    if (objects.dataset.objects !== objectsKey) {
      objects.dataset.objects = objectsKey;
      objects.replaceChildren();
      if (state.objects.length) objects.append(element("p", "mobile-object-heading", "当前位置的记号"));
      for (const object of state.objects.slice(0, 24)) {
        const node = button(object.label, `选择${object.label}`, () => command({ type: "select-object", ref: object.ref }));
        node.setAttribute("aria-pressed", String(object.selected)); objects.append(node);
      }
    }
    position.textContent = [app.workspaceSummary().position, state.mode === "input" && !state.cursor ? "请点谱面定位，或从开头输入" : "", !state.ready ? state.reason : ""].filter(Boolean).join(" · ");
    startInput.hidden = state.mode !== "input" || !!state.cursor;
    const originalSelect = document.getElementById("staff-view-select") as HTMLSelectElement;
    surfaceSelect.value = textView ? "text" : originalSelect.value;
    for (const option of surfaceSelect.options) option.disabled = originalSelect.querySelector<HTMLOptionElement>(`option[value="${option.value}"]`)?.disabled ?? false;
    const originalPlay = document.getElementById("btn-play");
    const playing = originalPlay?.classList.contains("playback-active") ?? false;
    play.textContent = playing ? "■" : "▶"; play.setAttribute("aria-pressed", String(playing));
    play.title = originalPlay?.title || (playing ? "停止" : "播放");
    viewTools.textContent = `${Math.round(app.workspaceSummary().zoom * 100)}%`;
    if (desktopMode) desktopMode.title = `工作区：${MODE_LABELS[getWorkspaceModePreference()]}`;
    html.dataset.mobileLayout = getWorkspaceMode();
    scheduleViewport();
  }
  let updateFrame = 0;
  const scheduleUpdate = (): void => { if (!updateFrame) updateFrame = requestAnimationFrame(() => { updateFrame = 0; update(); }); };
  document.addEventListener("editor:workspace-change", scheduleUpdate);
  document.addEventListener("editor:status", event => {
    const message = (event as CustomEvent<string>).detail;
    // Count and position are already persistent in the dock. Keep routine
    // selection hints from covering the touch keys after every note tap.
    if (isTouchWorkspace() && !message.startsWith("已选择")) feedback(message);
  });
  document.addEventListener("staff:navigation-change", scheduleUpdate);
  document.addEventListener("workspace:mode-change", () => { closeSheet?.(); syncModalInert(); update(); });
  document.addEventListener("editor:document-replaced", () => { closeSheet?.(); marquee = false; cursorKey = ""; scheduleUpdate(); });
  document.addEventListener("focusin", scheduleViewport);
  document.addEventListener("focusout", scheduleViewport);
  window.addEventListener("resize", scheduleViewport);
  window.visualViewport?.addEventListener("resize", scheduleViewport);
  window.visualViewport?.addEventListener("scroll", scheduleViewport);
  new MutationObserver(scheduleUpdate).observe(document.getElementById("btn-play")!, { attributes: true, attributeFilter: ["class", "title"] });
  let ownsModalInert = false;
  function syncModalInert(): void {
    const layers = [...document.body.children].filter(node => node instanceof HTMLElement
      && node.matches(".modal-overlay, .app-dialog-layer, .notation-dialog-layer, .mobile-sheet-layer, .mobile-file-layer, .mobile-file-task-layer"));
    if (isTouchWorkspace() && layers.length > 0) {
      if (!root.inert) { root.inert = true; ownsModalInert = true; }
    } else if (ownsModalInert) {
      root.inert = false; ownsModalInert = false;
    }
    if (isTouchWorkspace()) for (const layer of layers) {
      const dialog = layer.querySelector<HTMLElement>("[role=dialog], .modal-box");
      if (dialog) { dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); }
    }
  }
  new MutationObserver(syncModalInert).observe(document.body, { childList: true });
  // Accessible tab navigation also works with an attached hardware keyboard.
  tabs.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const values: PanelTab[] = ["notes", "edit", "marks"];
    tab = event.key === "Home" ? "notes" : event.key === "End" ? "marks"
      : values[(values.indexOf(tab) + (event.key === "ArrowLeft" ? 2 : 1)) % 3];
    collapsed = false; update(); tabButtons.get(tab)?.focus();
  });
  initializeWorkspaceMode();
  update();
}
