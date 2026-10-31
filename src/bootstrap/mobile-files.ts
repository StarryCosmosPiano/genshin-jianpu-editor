import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { App } from "../editor/app";
import { isTauriRuntime } from "../editor/fileio";
import { bindMobileDraftSession, indexedDbDraftStore, MobileDraftSession, mobileDraftFailure,
  newMobileDraftId, type MobileDraftState } from "../editor/mobile-drafts";
import { offerLastMobileDraft } from "../editor/mobile-draft-ui";
import { isTouchWorkspace } from "./device-mode";

/** Install after mountEditor; no parsing success or external save target is required. */
export function initializeMobileFiles(app: App): () => void {
  if (isTauriRuntime()) return () => {};
  const status = document.createElement("span");
  status.id = "mobile-draft-status";
  status.setAttribute("role", "status");
  let lastState: MobileDraftState = { status: "idle" };
  let disposed = false;
  let queued = false;
  let offered = false;
  const paintState = (): void => {
    const host = document.getElementById("mobile-document-info");
    if (host && status.parentElement !== host) host.append(status);
    status.hidden = !isTouchWorkspace();
    status.dataset.state = lastState.status;
    status.textContent = lastState.status === "failed" ? "本机草稿保存失败，请导出副本"
      : lastState.status === "saving" ? "正在保存本机草稿…"
        : lastState.status === "pending" ? "有更新，准备保存草稿…"
          : lastState.status === "saved" ? `本机草稿已保存 ${new Date(lastState.updatedAt!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "编辑后自动保存本机草稿";
    status.title = lastState.message ?? "本机草稿不会覆盖原文件；重要乐谱请另行导出备份。";
  };
  const report = (state: MobileDraftState): void => {
    lastState = state;
    paintState();
    document.dispatchEvent(new CustomEvent("editor:draft-state", { detail: state }));
    if (state.status === "failed") app.reportFileStatus(state.message!);
  };
  const draft = new MobileDraftSession({
    store: indexedDbDraftStore, now: () => Date.now(), createId: newMobileDraftId,
    schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
    cancel: timer => window.clearTimeout(timer as number), report,
  });
  bindMobileDraftSession(app, draft);
  const capture = (): void => {
    if (disposed || !isTouchWorkspace() || (!app.hasUnsavedChanges() && !draft.hasCurrentContent)) return;
    const snapshot = app.getMobileDraftContent();
    draft.queue(snapshot.content, snapshot.name);
  };
  const scheduleCapture = (): void => {
    if (queued || disposed) return;
    queued = true;
    // Imports finish their document session synchronously after dispatching text.
    queueMicrotask(() => { queued = false; capture(); });
  };
  app.view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of(update => {
    if (update.docChanged) scheduleCapture();
  })) });
  const flush = (): void => {
    capture();
    if (isTouchWorkspace()) void draft.flush();
  };
  const visibility = (): void => { if (document.visibilityState === "hidden") flush(); };
  const offer = async (): Promise<void> => {
    if (offered || !isTouchWorkspace() || disposed) return;
    offered = true;
    try {
      const records = await indexedDbDraftStore.list();
      if (!disposed && isTouchWorkspace() && records.length && !app.hasUnsavedChanges()) {
        offerLastMobileDraft(records[0], async record => { await app.restoreMobileDraft(record); }, () => app.showMobileDrafts());
      }
    } catch (error) { report({ status: "failed", message: mobileDraftFailure(error) }); }
  };
  const modeChange = (): void => { paintState(); capture(); void offer(); };
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("editor:workspace-change", scheduleCapture);
  document.addEventListener("workspace:mode-change", modeChange);
  window.addEventListener("pagehide", flush);
  // The update prompt can ask for this before reloading the application shell.
  document.addEventListener("editor:flush-draft", flush);
  paintState();
  void offer();
  return () => {
    flush();
    disposed = true;
    draft.dispose();
    status.remove();
    document.removeEventListener("visibilitychange", visibility);
    document.removeEventListener("editor:workspace-change", scheduleCapture);
    document.removeEventListener("workspace:mode-change", modeChange);
    document.removeEventListener("editor:flush-draft", flush);
    window.removeEventListener("pagehide", flush);
  };
}
