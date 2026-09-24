import type { App } from "../editor/app";
import { showEngravingStyleDialog, showOptionsDialog } from "../editor/dialogs";
import { showExportDialog } from "../editor/export";
import { showHelpDialog } from "../editor/help";
import { isTauriRuntime } from "../editor/fileio";
import { showCreateScoreDialog } from "../editor/slash-dialog";
import { activeInspectorId, requestCloseInspector } from "../ui/inspector";
import type { NoteTimingDivision } from "../score/note-timing";
import { wireDragDrop } from "./drag-drop";
import { wireZoomControls } from "./zoom";

function button(id: string): HTMLButtonElement | null {
  return document.getElementById(id) as HTMLButtonElement | null;
}

function on(id: string, listener: () => void): void {
  button(id)?.addEventListener("click", listener);
}

function wireMenus(): void {
  const pairs: Array<[HTMLButtonElement, HTMLElement]> = [];
  for (const [triggerId, menuId] of [
    ["btn-file-menu", "file-menu"],
  ]) {
    const trigger = button(triggerId);
    const menu = document.getElementById(menuId);
    if (trigger && menu) pairs.push([trigger, menu]);
  }
  const close = (restoreFocus = false): void => {
    for (const [trigger, menu] of pairs) {
      const wasOpen = !menu.hidden;
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      if (restoreFocus && wasOpen) trigger.focus();
    }
  };
  for (const [trigger, menu] of pairs) {
    trigger.addEventListener("click", () => {
      const opening = menu.hidden;
      close();
      menu.hidden = !opening;
      trigger.setAttribute("aria-expanded", String(opening));
      if (opening) menu.querySelector<HTMLElement>('button:not([hidden]):not(:disabled)')?.focus();
    });
    menu.addEventListener("click", (event) => {
      // Embedded form controls keep their native popup and keyboard handling.
      // Only executing a menu action dismisses the containing menu.
      if ((event.target as Element).closest("button")) close();
    });
    menu.addEventListener("keydown", (event) => {
      if ((event.target as Element).closest("select, input, textarea")) return;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = Array.from(menu.querySelectorAll<HTMLElement>('button:not([hidden]):not(:disabled), select:not([hidden])'));
      if (!items.length) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "Home" ? 0
        : event.key === "End" ? items.length - 1
          : event.key === "ArrowDown" ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
      items[next].focus();
    });
  }
  document.addEventListener("pointerdown", (event) => {
    if (!pairs.some(([trigger, menu]) => trigger.contains(event.target as Node) || menu.contains(event.target as Node))) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && pairs.some(([, menu]) => !menu.hidden)) {
      event.preventDefault();
      close(true);
    }
  });
}

function wireCodePane(app: App): void {
  const divider = button("code-pane-toggle");
  if (!divider) return;
  let dragStart: { x: number; width: number; side: "left" | "right" } | null = null;
  let moved = false;
  let pendingWidth: number | null = null;
  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || app.codePaneCollapsed || matchMedia("(max-width: 760px)").matches) return;
    const pane = document.getElementById("code-workspace");
    if (!pane) return;
    dragStart = { x: event.clientX, width: pane.getBoundingClientRect().width, side: app.codePaneSide };
    moved = false;
    divider.setPointerCapture(event.pointerId);
  });
  divider.addEventListener("pointermove", (event) => {
    if (!dragStart) return;
    const delta = (event.clientX - dragStart.x) * (dragStart.side === "left" ? 1 : -1);
    if (Math.abs(delta) > 4) moved = true;
    if (!moved) return;
    event.preventDefault();
    const bodyWidth = document.getElementById("body")?.getBoundingClientRect().width ?? window.innerWidth;
    pendingWidth = Math.round(Math.max(230, Math.min(bodyWidth * 0.6, dragStart.width + delta)));
    document.getElementById("body")?.style.setProperty("--code-pane-width", `${pendingWidth}px`);
  });
  const finishDrag = (): void => {
    if (moved && pendingWidth !== null) app.setCodePaneWidth(pendingWidth);
    dragStart = null;
    pendingWidth = null;
  };
  divider.addEventListener("pointerup", finishDrag);
  divider.addEventListener("pointercancel", finishDrag);
  divider.addEventListener("click", (event) => {
    if (moved) {
      moved = false;
      event.preventDefault();
      return;
    }
    app.setCodePaneCollapsed(!app.codePaneCollapsed);
  });
}

function wireWorkspaceSummary(app: App): void {
  const name = document.getElementById("workspace-document-name");
  const format = document.getElementById("workspace-document-format");
  const position = document.getElementById("workspace-position");
  const pageCount = document.getElementById("workspace-page-count");
  const select = button("btn-select-mode");
  const input = button("btn-input-mode");
  const update = (): void => {
    const summary = app.workspaceSummary();
    if (name) name.textContent = summary.documentName || "未命名乐谱";
    if (format) format.textContent = summary.format || "";
    if (position) position.textContent = [
      summary.position,
      summary.diagnostics > 0 ? `${summary.diagnostics} 处时值待检查` : "",
    ].filter(Boolean).join(" · ");
    if (pageCount) pageCount.textContent = `${summary.page} / ${Math.max(1, summary.pages)}`;
    select?.setAttribute("aria-pressed", String(!summary.inputEnabled));
    select?.classList.toggle("active", !summary.inputEnabled);
    input?.setAttribute("aria-pressed", String(summary.inputEnabled));
    input?.classList.toggle("active", summary.inputEnabled);
    button("btn-prev")?.toggleAttribute("disabled", summary.page <= 1);
    button("btn-next")?.toggleAttribute("disabled", summary.page >= summary.pages);
  };
  document.addEventListener("editor:workspace-change", update);
  update();

  // Page visibility follows scrolling without polling page geometry. Only
  // page-container mutations refresh the observer's index map.
  if (typeof IntersectionObserver !== "undefined") {
    const scorePane = app.scorePane;
    const pageIndexes = new Map<Element, number>();
    const pageRatios = new Map<Element, number>();
    let navigationTarget: number | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const settleNavigation = (): void => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => { navigationTarget = null; }, 180);
    };
    document.addEventListener("editor:page-navigation", (event) => {
      navigationTarget = (event as CustomEvent<{ page: number }>).detail.page;
      settleNavigation();
    });
    scorePane.addEventListener("scroll", () => { if (navigationTarget !== null) settleNavigation(); }, { passive: true });
    const cancelNavigation = (): void => { clearTimeout(settleTimer); navigationTarget = null; };
    scorePane.addEventListener("wheel", cancelNavigation, { passive: true });
    scorePane.addEventListener("pointerdown", cancelNavigation, { passive: true });
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) pageRatios.set(entry.target, entry.intersectionRatio);
      if (navigationTarget !== null) return;
      let visibleIndex = -1;
      let visibleRatio = 0;
      for (const [page, ratio] of pageRatios) {
        if (ratio > visibleRatio) {
          visibleRatio = ratio;
          visibleIndex = pageIndexes.get(page) ?? -1;
        }
      }
      if (visibleIndex >= 0 && visibleIndex !== app.pageIndex) {
        app.pageIndex = visibleIndex;
        update();
      }
    }, { root: scorePane, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });
    const attachPages = (): void => {
      const current = new Set<Element>();
      Array.from(scorePane.children).forEach((child, index) => {
        if (!child.classList.contains("score-page-wrap")) return;
        current.add(child);
        pageIndexes.set(child, index);
        if (!pageRatios.has(child)) {
          pageRatios.set(child, 0);
          observer.observe(child);
        }
      });
      for (const page of pageIndexes.keys()) {
        if (current.has(page)) continue;
        observer.unobserve(page);
        pageIndexes.delete(page);
        pageRatios.delete(page);
      }
      update();
    };
    new MutationObserver(attachPages).observe(scorePane, { childList: true });
    attachPages();
  }
}

function wireRhythmControls(app: App, scorePane: HTMLElement): void {
  const divisions: NoteTimingDivision[] = [1, 2, 4, 8, 16, 32, 64];
  const focusScore = (): void => scorePane.focus({ preventScroll: true });
  document.querySelectorAll<HTMLButtonElement>("#rhythm-grid-control button[data-rhythm-division]")
    .forEach((item) => item.addEventListener("click", () => {
      const division = Number(item.dataset.rhythmDivision) as NoteTimingDivision;
      if (!divisions.includes(division)) return;
      app.setRhythmEditDivision(item.classList.contains("active") ? null : division);
      focusScore();
    }));
  document.querySelectorAll<HTMLButtonElement>("#rhythm-grid-control button[data-input-duration-division]")
    .forEach((item) => item.addEventListener("click", () => {
      const division = Number(item.dataset.inputDurationDivision) as NoteTimingDivision;
      if (!divisions.includes(division)) return;
      app.setInputDurationDivision(item.classList.contains("active") ? null : division);
      focusScore();
    }));
  on("rhythm-grid-dot-toggle", () => { app.toggleTimingDot("grid"); focusScore(); });
  on("input-duration-dot-toggle", () => { app.toggleTimingDot("duration"); focusScore(); });
  on("rhythm-grid-auto", () => { app.setRhythmEditDivision(null); focusScore(); });
  on("input-duration-auto", () => { app.setInputDurationDivision(null); focusScore(); });
  app.syncRhythmGridToolbar();
}

export async function wireWorkspace(app: App, scorePane: HTMLElement): Promise<void> {
  wireMenus();
  wireCodePane(app);
  wireWorkspaceSummary(app);
  wireRhythmControls(app, scorePane);
  wireZoomControls(app, scorePane);

  on("btn-save", () => void app.saveFile());
  on("btn-saveas", () => void app.saveFileAs());
  on("btn-export", () => showExportDialog(app));
  on("btn-prev", () => app.prevPage());
  on("btn-next", () => app.nextPage());
  on("btn-options", () => void (async () => {
    if (await requestCloseInspector()) showOptionsDialog(app);
  })());
  on("btn-help", () => showHelpDialog(app));
  on("btn-undo", () => app.undoEdit());
  on("btn-redo", () => app.redoEdit());
  on("btn-select-mode", () => void (async () => {
    if (app.workspaceSummary().inputEnabled && await requestCloseInspector()) app.toggleInputMode();
  })());
  const inputMode = button("btn-input-mode");
  if (inputMode) {
    app.setInputModeBtn(inputMode);
    inputMode.addEventListener("click", () => void (async () => {
      if (await requestCloseInspector()) app.toggleInputMode();
    })());
  }
  const previewLock = button("btn-preview-lock");
  if (previewLock) {
    app.setPreviewLockBtn(previewLock);
    previewLock.addEventListener("click", () => app.togglePreviewLock());
  }
  on("btn-create", () => void (async () => {
    if (!(await requestCloseInspector())) return;
    const kind = await showCreateScoreDialog();
    if (kind) await app.createDocument(kind);
  })());
  for (const id of ["btn-open", "btn-import"]) {
    on(id, () => void (async () => {
      if (await requestCloseInspector()) await app.openFile();
    })());
  }
  on("btn-score-settings", () => void (async () => {
    if (activeInspectorId() === "score") { await requestCloseInspector(); return; }
    await app.showScoreSettings();
  })());
  on("btn-layout-style", () => void (async () => {
    if (activeInspectorId() === "layout") { await requestCloseInspector(); return; }
    showEngravingStyleDialog(app);
  })());
  if (!isTauriRuntime()) {
    for (const id of ["btn-mixed", "btn-recognize", "sel-recog-view", "btn-phrase"]) {
      const element = document.getElementById(id);
      if (element) element.hidden = true;
    }
  }
  const mixed = button("btn-mixed");
  if (mixed) {
    app.setMixedBtn(mixed);
    mixed.addEventListener("click", () => void (async () => {
      if (await requestCloseInspector()) await app.toggleMixed();
    })());
  }
  const recognize = button("btn-recognize");
  if (recognize) {
    app.setRecognizeBtn(recognize);
    recognize.addEventListener("click", () => void (async () => {
      if (await requestCloseInspector()) await app.toggleRecognize();
    })());
  }
  const recogView = document.getElementById("sel-recog-view") as HTMLSelectElement | null;
  if (recogView) {
    app.setRecogViewSelect(recogView);
    recogView.addEventListener("change", () => app.setRecogView(recogView.value as import("../omr").RecogView));
  }
  const phrase = button("btn-phrase");
  if (phrase) {
    app.setPhraseBtn(phrase);
    phrase.addEventListener("click", () => void (async () => {
      if (await requestCloseInspector()) app.togglePhrase();
    })());
  }
  const play = button("btn-play");
  if (play) {
    app.setPlayBtn(play);
    play.addEventListener("click", () => app.togglePlayback());
  }
  document.querySelectorAll<HTMLButtonElement>("#score-input-keypad [data-input-degree]")
    .forEach((item) => item.addEventListener("click", () => {
      app.inputDegree(Number(item.dataset.inputDegree));
      scorePane.focus({ preventScroll: true });
    }));
  document.querySelectorAll<HTMLButtonElement>("#score-input-keypad [data-input-lane]")
    .forEach((item) => item.addEventListener("click", () => {
      const lane = item.dataset.inputLane;
      if (lane === "above" || lane === "below") app.setInputLane(lane);
      scorePane.focus({ preventScroll: true });
    }));

  await wireDragDrop(app, requestCloseInspector);
}
