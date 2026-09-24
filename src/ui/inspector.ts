import "./floating-window.css";
import { FloatingWindow } from "./floating-window";

/** A single floating inspector shared by score and engraving settings. */
export interface InspectorConfig {
  id: string;
  title: string;
  body: HTMLElement;
  isDirty: () => boolean;
  onApply: () => boolean | Promise<boolean>;
  onDiscard?: () => void | Promise<void>;
  onClosed?: (applied: boolean) => void;
  applyText?: string;
  initialFocus?: HTMLElement | null;
}

let current: InspectorConfig | null = null;
let origin: HTMLElement | null = null;
let pendingClose: Promise<boolean> | null = null;
let resolvePendingClose: ((allowed: boolean) => void) | null = null;
let pendingPrompt: HTMLElement | null = null;
let openSequence = 0;
let floatingWindow: FloatingWindow | null = null;

function finishPendingClose(allowed: boolean): void {
  pendingPrompt?.remove();
  pendingPrompt = null;
  const resolve = resolvePendingClose;
  resolvePendingClose = null;
  pendingClose = null;
  resolve?.(allowed);
}

function host(): HTMLElement {
  const pane = document.getElementById("inspector-pane");
  if (!pane) throw new Error("Missing #inspector-pane");
  return pane;
}

function settle(applied: boolean, restoreFocus: boolean): void {
  const previous = current;
  current = null;
  const pane = host();
  floatingWindow?.destroy();
  floatingWindow = null;
  pane.replaceChildren();
  pane.hidden = true;
  pane.removeAttribute("data-inspector-id");
  pane.removeAttribute("role");
  pane.removeAttribute("aria-modal");
  pane.removeAttribute("aria-labelledby");
  pane.onkeydown = null;
  document.querySelectorAll<HTMLElement>("[data-inspector-trigger]").forEach((trigger) => {
    trigger.setAttribute("aria-expanded", "false");
  });
  previous?.onClosed?.(applied);
  if (restoreFocus && origin?.isConnected) origin.focus();
  origin = null;
  finishPendingClose(true);
}

async function discard(restoreFocus: boolean): Promise<void> {
  await current?.onDiscard?.();
  settle(false, restoreFocus);
}

export function activeInspectorId(): string | null {
  return current?.id ?? null;
}

/** Close without prompting after the caller has already resolved any draft. */
export function closeInspector(): void {
  if (!current) return;
  ++openSequence;
  void discard(true);
}

if (typeof document !== "undefined") document.addEventListener("editor:document-replaced", closeInspector);

/** Ask in the pane when leaving a dirty draft; false means keep editing. */
export function requestCloseInspector(): Promise<boolean> {
  if (!current) return Promise.resolve(true);
  if (pendingClose) return pendingClose;
  if (!current.isDirty()) {
    return discard(true).then(() => true);
  }

  const pane = host();
  const footer = pane.querySelector<HTMLElement>(".inspector-footer")!;
  const prompt = document.createElement("div");
  prompt.className = "inspector-dirty-prompt";
  prompt.setAttribute("role", "alertdialog");
  const message = document.createElement("p");
  message.textContent = "有尚未应用的修改。";
  const actions = document.createElement("div");
  actions.className = "inspector-actions";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.textContent = "应用";
  const discardButton = document.createElement("button");
  discardButton.type = "button";
  discardButton.textContent = "放弃修改";
  const stay = document.createElement("button");
  stay.type = "button";
  stay.textContent = "继续编辑";
  actions.append(apply, discardButton, stay);
  prompt.append(message, actions);
  footer.append(prompt);
  pendingPrompt = prompt;

  pendingClose = new Promise<boolean>((resolve) => {
    resolvePendingClose = resolve;
    apply.onclick = async () => {
      apply.disabled = discardButton.disabled = stay.disabled = true;
      try {
        if (await current?.onApply()) {
          settle(true, true);
        }
      } finally {
        apply.disabled = discardButton.disabled = stay.disabled = false;
      }
    };
    discardButton.onclick = async () => {
      apply.disabled = discardButton.disabled = stay.disabled = true;
      try {
        await discard(true);
      } finally {
        apply.disabled = discardButton.disabled = stay.disabled = false;
      }
    };
    stay.onclick = () => finishPendingClose(false);
    stay.focus();
  });
  return pendingClose;
}

/** Mount a panel, resolving the old draft before switching. */
export async function openInspector(config: InspectorConfig): Promise<boolean> {
  const sequence = ++openSequence;
  const requestedOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (current && !(await requestCloseInspector())) return false;
  if (sequence !== openSequence) return false;
  const pane = host();
  origin = requestedOrigin;
  current = config;
  pane.classList.add("inspector-pane", "inspector-floating");
  pane.dataset.inspectorId = config.id;
  pane.setAttribute("role", "dialog");
  pane.setAttribute("aria-modal", "false");
  pane.tabIndex = -1;
  const header = document.createElement("header");
  header.className = "inspector-header";
  const headingGroup = document.createElement("div");
  headingGroup.className = "inspector-heading-group";
  const heading = document.createElement("h2");
  heading.className = "inspector-title";
  heading.id = "inspector-window-title";
  heading.textContent = config.title;
  pane.setAttribute("aria-labelledby", heading.id);
  const hint = document.createElement("p");
  hint.className = "inspector-drag-hint";
  hint.textContent = "拖动标题栏移动，拖动右下角调整大小";
  headingGroup.append(heading, hint);
  const headerActions = document.createElement("div");
  headerActions.className = "inspector-header-actions";
  const reset = document.createElement("button");
  reset.className = "inspector-reset";
  reset.type = "button";
  reset.setAttribute("aria-label", "重置窗口位置和大小");
  reset.title = "重置窗口位置和大小";
  reset.textContent = "↺";
  const close = document.createElement("button");
  close.className = "inspector-close";
  close.type = "button";
  close.setAttribute("aria-label", `关闭${config.title}面板`);
  close.textContent = "×";
  close.onclick = () => { void requestCloseInspector(); };
  headerActions.append(reset, close);
  header.append(headingGroup, headerActions);
  const content = document.createElement("div");
  content.className = "inspector-content";
  content.append(config.body);
  const footer = document.createElement("footer");
  footer.className = "inspector-footer";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消";
  cancel.onclick = () => { void discard(true); };
  const apply = document.createElement("button");
  apply.type = "button";
  apply.textContent = config.applyText ?? "应用";
  apply.onclick = async () => {
    apply.disabled = true;
    try {
      if (await config.onApply()) settle(true, true);
    } finally {
      apply.disabled = false;
    }
  };
  footer.append(cancel, apply);
  const grip = document.createElement("button");
  grip.type = "button";
  grip.className = "inspector-resize-grip";
  grip.setAttribute("aria-label", "调整窗口大小，使用方向键调整宽度和高度");
  grip.title = "拖动调整大小；方向键精细调整";
  grip.textContent = "◢";
  pane.replaceChildren(header, content, footer, grip);
  pane.hidden = false;
  floatingWindow = new FloatingWindow(pane, config.id, header, grip, reset);
  pane.onkeydown = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    void requestCloseInspector();
  };
  document.querySelectorAll<HTMLElement>("[data-inspector-trigger]").forEach((trigger) => {
    trigger.setAttribute("aria-expanded", trigger.dataset.inspectorTrigger === config.id ? "true" : "false");
  });
  (config.initialFocus?.isConnected ? config.initialFocus : content.querySelector<HTMLElement>("input,select,button"))?.focus();
  return true;
}
