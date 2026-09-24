import type { App } from "../editor/app";

/** Keep the CodeMirror host alive while showing the engraving sample beside the score. */
export function openLayoutPreviewPane(
  app: App,
  svg: SVGSVGElement,
  expand: HTMLButtonElement,
): { close: () => void } {
  const workspace = document.getElementById("code-workspace");
  const header = document.getElementById("code-workspace-header");
  const codePane = document.getElementById("code-pane");
  if (!workspace || !header || !codePane) {
    throw new Error("Missing text editor workspace");
  }

  app.setCodePaneSide("left");
  app.setCodePaneCollapsed(false);

  const firstTitle = header.querySelector<HTMLElement>("span");
  const textTab = document.createElement("button");
  textTab.type = "button";
  textTab.className = "code-workspace-tab";
  textTab.setAttribute("aria-controls", "code-pane");
  textTab.textContent = "文本谱";
  const sampleTab = document.createElement("button");
  sampleTab.type = "button";
  sampleTab.className = "code-workspace-tab";
  sampleTab.setAttribute("aria-controls", "layout-preview-pane");
  sampleTab.textContent = "排版样张";
  const tabs = document.createElement("div");
  tabs.className = "code-workspace-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "左侧面板");
  tabs.append(textTab, sampleTab);
  if (firstTitle) firstTitle.replaceWith(tabs);
  else header.prepend(tabs);

  const sample = document.createElement("div");
  sample.id = "layout-preview-pane";
  sample.className = "layout-preview-pane engraving-preview";
  sample.setAttribute("role", "tabpanel");
  const actions = document.createElement("div");
  actions.className = "engraving-preview-actions";
  actions.append(expand);
  sample.append(actions, svg);
  codePane.after(sample);

  const show = (which: "text" | "sample") => {
    codePane.hidden = which !== "text";
    sample.hidden = which !== "sample";
    textTab.setAttribute("role", "tab");
    sampleTab.setAttribute("role", "tab");
    textTab.setAttribute("aria-selected", String(which === "text"));
    sampleTab.setAttribute("aria-selected", String(which === "sample"));
    textTab.classList.toggle("active", which === "text");
    sampleTab.classList.toggle("active", which === "sample");
    const hint = header.querySelector<HTMLElement>(".code-workspace-hint");
    if (hint) hint.hidden = which !== "text";
    const lock = header.querySelector<HTMLElement>("#btn-preview-lock");
    if (lock) lock.hidden = which !== "text";
    if (which === "text") requestAnimationFrame(() => app.view?.requestMeasure());
  };
  textTab.onclick = () => show("text");
  sampleTab.onclick = () => show("sample");
  show("sample");

  return {
    close: () => {
      show("text");
      sample.remove();
      tabs.replaceWith(firstTitle ?? document.createElement("span"));
    },
  };
}
