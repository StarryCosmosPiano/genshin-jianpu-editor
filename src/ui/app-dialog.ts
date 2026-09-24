import { FloatingWindow } from "./floating-window";
import "./floating-window.css";
import "./app-dialog.css";

export interface DialogField {
  name: string;
  label: string;
  value?: string;
  multiline?: boolean;
  inputMode?: "text" | "decimal" | "numeric";
  choices?: ReadonlyArray<{ value: string; label: string }>;
  validate?: (value: string) => string | null;
}

interface DialogConfig {
  title: string;
  message?: string;
  fields?: readonly DialogField[];
  actions: ReadonlyArray<{ value: string; label: string; primary?: boolean }>;
  dismiss: string | null;
}

interface DialogResult { action: string | null; values: Record<string, string> }
let active: { focus: () => void; cancel: () => void } | null = null;

/** One app-owned prompt at a time; the underlying document cannot change by accident. */
function openDialog(config: DialogConfig): Promise<DialogResult> {
  if (active) {
    active.focus();
    return Promise.resolve({ action: config.dismiss, values: {} });
  }
  return new Promise((resolve) => {
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : document.getElementById("score-pane");
    const layer = document.createElement("div");
    layer.className = "app-dialog-layer";
    const pane = document.createElement("form");
    pane.className = "app-dialog inspector-floating";
    pane.setAttribute("role", "dialog");
    pane.setAttribute("aria-modal", "true");
    pane.setAttribute("aria-labelledby", "app-dialog-title");
    pane.tabIndex = -1;
    const header = document.createElement("header");
    header.className = "inspector-header";
    const title = document.createElement("h2");
    title.id = "app-dialog-title";
    title.className = "inspector-title";
    title.textContent = config.title;
    header.title = "拖动标题栏移动窗口";
    const controls = document.createElement("div");
    controls.className = "inspector-header-actions";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "inspector-reset";
    reset.setAttribute("aria-label", "重置窗口位置和大小");
    reset.textContent = "↺";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "inspector-close";
    close.setAttribute("aria-label", "关闭提示窗口");
    close.textContent = "×";
    controls.append(reset, close);
    header.append(title, controls);
    const content = document.createElement("div");
    content.className = "app-dialog-content";
    if (config.message) {
      const message = document.createElement("p");
      message.id = "app-dialog-message";
      message.textContent = config.message;
      pane.setAttribute("aria-describedby", message.id);
      content.append(message);
    }
    const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
    for (const field of config.fields ?? []) {
      const label = document.createElement("label");
      label.className = "app-dialog-field";
      const caption = document.createElement("span");
      caption.textContent = field.label;
      const input = field.choices ? document.createElement("select")
        : field.multiline ? document.createElement("textarea") : document.createElement("input");
      if (input instanceof HTMLSelectElement) {
        for (const choice of field.choices ?? []) {
          const option = document.createElement("option");
          option.value = choice.value;
          option.textContent = choice.label;
          input.append(option);
        }
      } else input.inputMode = field.inputMode ?? "text";
      input.name = field.name;
      input.value = field.value ?? "";
      input.autocomplete = "off";
      inputs.set(field.name, input);
      label.append(caption, input);
      content.append(label);
    }
    const error = document.createElement("p");
    error.className = "app-dialog-error";
    error.id = "app-dialog-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    content.append(error);
    const footer = document.createElement("footer");
    footer.className = "app-dialog-footer";
    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "inspector-resize-grip";
    grip.setAttribute("aria-label", "调整窗口大小，使用方向键调整宽度和高度");
    grip.textContent = "◢";
    pane.append(header, content, footer, grip);
    layer.append(pane);

    // Match the old prompt's editing isolation without blocking the browser.
    const backgrounds = [...document.body.children].filter((node): node is HTMLElement => node instanceof HTMLElement)
      .map((node) => ({ node, inert: node.inert }));
    for (const { node } of backgrounds) node.inert = true;
    document.body.append(layer);
    const fieldCount = config.fields?.length ?? 0;
    const height = fieldCount > 2 ? Math.min(700, 160 + fieldCount * 82)
      : config.fields?.some((field) => field.multiline) ? 380
        : fieldCount > 1 ? 360 : fieldCount ? 300 : 240;
    const floating = new FloatingWindow(pane, "prompt", header, grip, reset,
      { width: 500, height, minWidth: 300, minHeight: 210, centered: true, persist: false });
    const focusInput = (): void => {
      const input = inputs.values().next().value;
      (input ?? footer.querySelector<HTMLButtonElement>(".primary") ?? close).focus({ preventScroll: true });
    };
    let settled = false;
    const finish = (action: string | null): void => {
      if (settled) return;
      const values = Object.fromEntries([...inputs].map(([key, input]) => [key, input.value]));
      if (config.actions.find((item) => item.value === action)?.primary) {
        for (const field of config.fields ?? []) {
          const message = field.validate?.(values[field.name]);
          if (!message) continue;
          error.textContent = message;
          error.hidden = false;
          const input = inputs.get(field.name)!;
          input.setAttribute("aria-invalid", "true");
          input.setAttribute("aria-describedby", error.id);
          input.focus();
          return;
        }
      }
      settled = true;
      document.removeEventListener("editor:document-replaced", cancel);
      floating.destroy();
      layer.remove();
      for (const { node, inert } of backgrounds) node.inert = inert;
      active = null;
      if (opener?.isConnected && !opener.closest("[inert]")) opener.focus({ preventScroll: true });
      resolve({ action, values });
    };
    const cancel = (): void => finish(config.dismiss);
    active = { focus: focusInput, cancel };
    document.addEventListener("editor:document-replaced", cancel);
    for (const action of config.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.dataset.action = action.value;
      if (action.primary) button.className = "primary";
      button.onclick = () => finish(action.value);
      footer.append(button);
    }
    close.onclick = cancel;
    layer.addEventListener("pointerdown", (event) => { if (event.target === layer) cancel(); });
    pane.addEventListener("input", () => {
      error.hidden = true;
      inputs.forEach((input) => input.removeAttribute("aria-invalid"));
    });
    pane.onsubmit = (event) => {
      event.preventDefault();
      const primary = config.actions.find((action) => action.primary);
      if (primary) finish(primary.value);
    };
    layer.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        cancel();
      } else if (event.key === "Enter" && !event.isComposing
        && !(event.target instanceof HTMLTextAreaElement && !event.ctrlKey && !event.metaKey)) {
        event.preventDefault();
        if (!event.repeat) {
          if (event.target instanceof HTMLButtonElement) event.target.click();
          else {
            const primary = config.actions.find((action) => action.primary);
            if (primary) finish(primary.value);
          }
        }
      } else if (event.key === "Tab") {
        const elements = [...pane.querySelectorAll<HTMLElement>("button,input,select,textarea,[tabindex='0']")]
          .filter((node) => !node.hasAttribute("disabled") && node.getClientRects().length > 0);
        const index = elements.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey && index <= 0 || !event.shiftKey && index === elements.length - 1) {
          event.preventDefault();
          (event.shiftKey ? elements[elements.length - 1] : elements[0])?.focus();
        }
      }
      event.stopPropagation();
    });
    focusInput();
    const first = inputs.values().next().value;
    if (first instanceof HTMLInputElement || first instanceof HTMLTextAreaElement) first.select();
  });
}

export async function showInputDialog(options: {
  title: string; message?: string; fields: readonly DialogField[]; confirmText?: string;
}): Promise<Record<string, string> | null> {
  const result = await openDialog({ ...options, dismiss: null,
    actions: [{ value: "cancel", label: "取消" }, { value: "apply", label: options.confirmText ?? "确定", primary: true }] });
  return result.action === "apply" ? result.values : null;
}

export async function showTextInput(options: {
  title: string; label: string; value?: string; message?: string; multiline?: boolean;
  inputMode?: DialogField["inputMode"]; validate?: DialogField["validate"];
}): Promise<string | null> {
  const result = await showInputDialog({ title: options.title, message: options.message,
    fields: [{ ...options, name: "value" }] });
  return result?.value ?? null;
}

export async function showConfirmDialog(options: {
  title: string; message: string; confirmText?: string; cancelText?: string;
}): Promise<boolean> {
  const result = await openDialog({ ...options, dismiss: null, actions: [
    { value: "cancel", label: options.cancelText ?? "取消" },
    { value: "apply", label: options.confirmText ?? "确定", primary: true },
  ] });
  return result.action === "apply";
}

export async function showUnsavedSettingsDialog(): Promise<"apply" | "cancel" | "stay"> {
  const result = await openDialog({ title: "设置尚未保存", message: "要应用这些修改，还是放弃并关闭设置？", dismiss: "stay",
    actions: [{ value: "stay", label: "继续编辑" }, { value: "cancel", label: "放弃修改" },
      { value: "apply", label: "应用并关闭", primary: true }] });
  return result.action === "apply" ? "apply" : result.action === "cancel" ? "cancel" : "stay";
}

export async function showMessageDialog(title: string, message: string): Promise<void> {
  await openDialog({ title, message, dismiss: null, actions: [{ value: "close", label: "知道了", primary: true }] });
}

export const positiveNumberError = (value: string): string | null =>
  value.trim() && Number.isFinite(Number(value)) && Number(value) > 0 ? null : "请输入大于 0 的有效数值";
