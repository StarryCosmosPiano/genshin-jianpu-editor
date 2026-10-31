import "./mobile-file.css";

export interface FileProgress {
  completed: number;
  total: number;
  message: string;
}

export function throwIfFileTaskAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
}

/** Yield between pages so touch input and cancellation remain responsive. */
export async function yieldFileTask(signal?: AbortSignal): Promise<void> {
  throwIfFileTaskAborted(signal);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  throwIfFileTaskAborted(signal);
}

export interface FileSheet {
  element: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  message: HTMLElement;
  close: () => void;
  onDismiss: (callback: () => void) => void;
}

/** Small shared sheet for file handoff, draft recovery and cancellable work. */
export function createFileSheet(title: string): FileSheet {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const layer = document.createElement("div");
  layer.className = "mobile-file-layer";
  const pane = document.createElement("section");
  pane.className = "mobile-file-sheet";
  pane.setAttribute("role", "dialog");
  pane.setAttribute("aria-modal", "true");
  pane.setAttribute("aria-label", title);
  pane.tabIndex = -1;
  const heading = document.createElement("h2");
  heading.textContent = title;
  const body = document.createElement("div");
  body.className = "mobile-file-body";
  const message = document.createElement("p");
  message.className = "mobile-file-message";
  message.setAttribute("role", "status");
  const footer = document.createElement("footer");
  footer.className = "mobile-file-actions";
  pane.append(heading, body, message, footer);
  layer.append(pane);
  const backgrounds = [...document.body.children]
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .map(node => ({ node, inert: node.inert }));
  backgrounds.forEach(({ node }) => { node.inert = true; });
  document.body.append(layer);
  let dismiss = () => {};
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    layer.remove();
    backgrounds.forEach(({ node, inert }) => { if (node.isConnected) node.inert = inert; });
    if (opener?.isConnected && !opener.closest("[inert]")) opener.focus({ preventScroll: true });
  };
  layer.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault(); dismiss();
    } else if (event.key === "Tab") {
      const focusable = [...pane.querySelectorAll<HTMLElement>("button,a[href],input,select,textarea,[tabindex='0']")]
        .filter(node => !node.hasAttribute("disabled") && !node.hidden && node.getClientRects().length > 0);
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      if (!focusable.length) { event.preventDefault(); pane.focus(); }
      else if (event.shiftKey && index <= 0 || !event.shiftKey && (index < 0 || index === focusable.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
      }
    }
    event.stopPropagation();
  });
  pane.focus({ preventScroll: true });
  return { element: pane, body, footer, message, close, onDismiss: callback => { dismiss = callback; } };
}

export function fileAction(label: string, action: () => void, primary = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (primary) button.className = "primary";
  button.addEventListener("click", action);
  return button;
}

export interface FileTask {
  signal: AbortSignal;
  update: (progress: FileProgress) => void;
  close: () => void;
}

export function createFileTask(title: string): FileTask {
  const sheet = createFileSheet(title);
  const controller = new AbortController();
  const progress = document.createElement("progress");
  progress.setAttribute("aria-label", title);
  sheet.body.append(progress);
  const cancel = fileAction("取消", () => {
    controller.abort();
    cancel.disabled = true;
    sheet.message.textContent = "正在取消，当前步骤结束后停止。";
  });
  sheet.footer.append(cancel);
  sheet.onDismiss(() => cancel.click());
  return {
    signal: controller.signal,
    update: value => {
      if (controller.signal.aborted) return;
      progress.max = Math.max(1, value.total);
      progress.value = Math.max(0, Math.min(value.completed, value.total));
      sheet.message.textContent = value.message;
    },
    close: sheet.close,
  };
}

export async function withFileTask<T>(title: string, run: (task: FileTask) => Promise<T>): Promise<T> {
  const task = createFileTask(title);
  try { return await run(task); }
  finally { task.close(); }
}
