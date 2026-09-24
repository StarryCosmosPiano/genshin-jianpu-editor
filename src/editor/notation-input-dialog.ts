import { MusicCommon } from "../score/score";
import { FloatingWindow } from "../ui/floating-window";
import "../ui/floating-window.css";
import "../ui/notation-dialog.css";

function keyLabel(value: string): string {
  if (value.startsWith("b")) return `${value.slice(1)}♭`;
  if (value.startsWith("#")) return `${value.slice(1)}♯`;
  return value;
}

interface DialogShell {
  pane: HTMLElement;
  content: HTMLElement;
  footer: HTMLElement;
  finish: () => void;
}

let activeDialog: { focus: () => void } | null = null;

/** A short-lived, focus-contained score dialog with the same drag/resize behavior as other app windows. */
function openNotationDialog(
  titleText: string,
  kind: string,
  onCancel: () => void,
  options: { width: number; height: number; minWidth: number; minHeight: number },
): DialogShell | null {
  if (activeDialog) {
    activeDialog.focus();
    return null;
  }
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const layer = document.createElement("div");
  layer.className = "notation-dialog-layer";
  const pane = document.createElement("section");
  pane.className = `notation-dialog inspector-floating ${kind}`;
  pane.setAttribute("role", "dialog");
  pane.setAttribute("aria-modal", "true");
  pane.tabIndex = -1;
  const header = document.createElement("header");
  header.className = "inspector-header notation-dialog-header";
  header.title = "拖动标题栏移动窗口";
  const title = document.createElement("h2");
  title.className = "inspector-title";
  title.id = `notation-${kind}-title`;
  title.textContent = titleText;
  pane.setAttribute("aria-labelledby", title.id);
  const actions = document.createElement("div");
  actions.className = "inspector-header-actions";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "inspector-reset";
  reset.setAttribute("aria-label", "重置窗口位置和大小");
  reset.title = "重置窗口位置和大小";
  reset.textContent = "↺";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "inspector-close";
  close.setAttribute("aria-label", "关闭窗口");
  close.textContent = "×";
  actions.append(reset, close);
  header.append(title, actions);
  const content = document.createElement("div");
  content.className = "notation-dialog-content";
  const footer = document.createElement("footer");
  footer.className = "notation-dialog-footer";
  const grip = document.createElement("button");
  grip.type = "button";
  grip.className = "inspector-resize-grip";
  grip.setAttribute("aria-label", "调整窗口大小，使用方向键调整宽度和高度");
  grip.title = "拖动调整大小；方向键精细调整";
  grip.textContent = "◢";
  pane.append(header, content, footer, grip);
  layer.append(pane);
  const backgrounds = [...document.body.children].filter((node): node is HTMLElement => node instanceof HTMLElement)
    .map((node) => ({ node, inert: node.inert }));
  for (const { node } of backgrounds) node.inert = true;
  document.body.append(layer);
  const floating = new FloatingWindow(pane, kind, header, grip, reset,
    { ...options, centered: true, persist: false });
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    document.removeEventListener("editor:document-replaced", onCancel);
    floating.destroy();
    layer.remove();
    for (const { node, inert } of backgrounds) node.inert = inert;
    activeDialog = null;
    if (opener?.isConnected && !opener.closest("[inert]")) opener.focus({ preventScroll: true });
  };
  activeDialog = { focus: () => pane.focus({ preventScroll: true }) };
  document.addEventListener("editor:document-replaced", onCancel);
  close.onclick = onCancel;
  layer.addEventListener("pointerdown", (event) => { if (event.target === layer) onCancel(); });
  layer.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Tab") {
      const elements = [...pane.querySelectorAll<HTMLElement>("button,input,select,[tabindex='0']")]
        .filter((node) => !node.hasAttribute("disabled") && node.getClientRects().length > 0);
      const index = elements.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0 || !event.shiftKey && index === elements.length - 1) {
        event.preventDefault();
        (event.shiftKey ? elements[elements.length - 1] : elements[0])?.focus();
      }
    }
    event.stopPropagation();
  });
  return { pane, content, footer, finish };
}

export interface KeyCircleDialogOptions { title?: string; hint?: string }

/** Choose one of all 15 spelled numbered-notation keys. */
export function showKeyCircleDialog(
  currentFifths: number,
  options: KeyCircleDialogOptions = {},
): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    let shell: DialogShell;
    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      shell.finish();
      resolve(value);
    };
    const opened = openNotationDialog(options.title ?? "选择调号 · 五度圈", "key-circle-dialog",
      () => finish(null), { width: 470, height: 560, minWidth: 290, minHeight: 340 });
    if (!opened) { resolve(null); return; }
    shell = opened;
    const hint = document.createElement("p");
    hint.className = "notation-dialog-hint";
    hint.textContent = options.hint ?? "选择后从打谱光标所在位置开始换调，简谱数字级数保持不变。";
    const circle = document.createElement("div");
    circle.className = "key-circle-wheel";
    circle.setAttribute("role", "group");
    circle.setAttribute("aria-label", "五度圈调号");
    const center = document.createElement("div");
    center.className = "key-circle-center";
    const centerCaption = document.createElement("span");
    centerCaption.textContent = "当前调";
    const centerKey = document.createElement("strong");
    centerKey.textContent = `1=${keyLabel(MusicCommon.keys[currentFifths + 7] ?? "C")}`;
    center.append(centerCaption, centerKey);
    circle.append(center);
    const buttons: HTMLButtonElement[] = [];
    const addKey = (fifths: number, parent: HTMLElement, position?: number): void => {
      const name = MusicCommon.keys[fifths + 7];
      const countText = fifths === 0 ? "0 升降" : `${Math.abs(fifths)} ${fifths > 0 ? "升" : "降"}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "key-circle-option";
      button.dataset.fifths = String(fifths);
      button.setAttribute("aria-label", `${keyLabel(name)}，${fifths === 0 ? "无升降号" : `${Math.abs(fifths)} 个${fifths > 0 ? "升号" : "降号"}`}${fifths === currentFifths ? "，当前调" : ""}`);
      button.setAttribute("aria-pressed", String(fifths === currentFifths));
      button.classList.toggle("active", fifths === currentFifths);
      if (position !== undefined) {
        const angle = position * Math.PI / 6;
        button.style.left = `${50 + Math.sin(angle) * 39}%`;
        button.style.top = `${50 - Math.cos(angle) * 39}%`;
      }
      const label = document.createElement("strong");
      label.textContent = keyLabel(name);
      const count = document.createElement("small");
      count.textContent = countText;
      button.append(label, count);
      button.addEventListener("click", () => finish(fifths));
      parent.append(button);
      buttons.push(button);
    };
    // The usual 12 clock positions start with C at twelve o'clock.
    [0, 1, 2, 3, 4, 5, 6, 7, -4, -3, -2, -1].forEach((fifths, index) => addKey(fifths, circle, index));
    const enharmonic = document.createElement("div");
    enharmonic.className = "key-circle-enharmonic";
    const enharmonicLabel = document.createElement("span");
    enharmonicLabel.textContent = "同音异名";
    const alternates = document.createElement("div");
    alternates.className = "key-circle-alternates";
    [-7, -6, -5].forEach((fifths) => addKey(fifths, alternates));
    enharmonic.append(enharmonicLabel, alternates);
    circle.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
      if (!step) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      buttons[(index + step + buttons.length) % buttons.length].focus();
    });
    // Alternates participate in the same arrow-key sequence.
    alternates.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
      if (!step) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      buttons[(index + step + buttons.length) % buttons.length].focus();
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.onclick = () => finish(null);
    shell.content.append(hint, circle, enharmonic);
    shell.footer.append(cancel);
    buttons.find((button) => button.dataset.fifths === String(currentFifths))?.focus({ preventScroll: true });
  });
}

export interface TimeSignatureChoice {
  beats: number;
  beatType: 2 | 4 | 8 | 16;
}

const COMMON_METERS: readonly TimeSignatureChoice[] = [
  { beats: 2, beatType: 4 }, { beats: 3, beatType: 4 }, { beats: 4, beatType: 4 },
  { beats: 5, beatType: 4 }, { beats: 6, beatType: 4 }, { beats: 2, beatType: 2 },
  { beats: 3, beatType: 8 }, { beats: 6, beatType: 8 }, { beats: 9, beatType: 8 },
  { beats: 12, beatType: 8 }, { beats: 6, beatType: 16 },
];

/** Choose the meter that begins at the cursor measure. */
export function showTimeSignatureDialog(
  currentBeats: number,
  currentBeatType: number,
): Promise<TimeSignatureChoice | null> {
  return new Promise((resolve) => {
    let settled = false;
    let shell: DialogShell;
    const finish = (value: TimeSignatureChoice | null): void => {
      if (settled) return;
      settled = true;
      shell.finish();
      resolve(value);
    };
    const opened = openNotationDialog("更换拍号", "time-signature-dialog", () => finish(null),
      { width: 440, height: 390, minWidth: 290, minHeight: 285 });
    if (!opened) { resolve(null); return; }
    shell = opened;
    const presets = document.createElement("div");
    presets.className = "notation-time-presets";
    const beats = document.createElement("input");
    beats.type = "number";
    beats.min = "1";
    beats.max = "32";
    beats.value = String(currentBeats);
    const beatType = document.createElement("select");
    for (const value of [2, 4, 8, 16] as const) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = String(value);
      option.selected = value === currentBeatType;
      beatType.append(option);
    }
    for (const meter of COMMON_METERS) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${meter.beats}/${meter.beatType}`;
      button.classList.toggle("active", meter.beats === currentBeats && meter.beatType === currentBeatType);
      button.addEventListener("click", () => {
        beats.value = String(meter.beats);
        beatType.value = String(meter.beatType);
        presets.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
      });
      presets.append(button);
    }
    const custom = document.createElement("label");
    custom.className = "notation-time-custom";
    const customLabel = document.createElement("span");
    customLabel.textContent = "自定义拍号";
    const slash = document.createElement("b");
    slash.textContent = "/";
    const controls = document.createElement("span");
    controls.className = "notation-time-controls";
    controls.append(beats, slash, beatType);
    custom.append(customLabel, controls);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.onclick = () => finish(null);
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "primary";
    apply.textContent = "应用";
    apply.onclick = () => {
      const numerator = Math.max(1, Math.min(32, parseInt(beats.value, 10) || currentBeats));
      const denominator = parseInt(beatType.value, 10) as TimeSignatureChoice["beatType"];
      finish({ beats: numerator, beatType: denominator });
    };
    shell.content.append(presets, custom);
    shell.footer.append(cancel, apply);
    shell.pane.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing || event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      apply.click();
    });
    beats.focus({ preventScroll: true });
    beats.select();
  });
}
