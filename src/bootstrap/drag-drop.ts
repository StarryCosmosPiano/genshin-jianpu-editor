import type { App } from "../editor/app";
import {
  isMidiFile,
  isRecognitionFile,
  isSupportedImportFile,
} from "../editor/file-format";
import { isTauriRuntime } from "../editor/fileio";

function showFileDropTarget(active: boolean): void {
  document.body.classList.toggle("file-drag-active", active);
}

async function importDroppedBytes(
  app: App,
  bytes: Uint8Array,
  name: string,
  mime = "",
  nativePath = false,
): Promise<void> {
  if (isRecognitionFile(name, mime)) {
    await app.recognizeBytes("musicpp", {
      bytes,
      mime: mime || undefined,
      path: nativePath ? name : null,
    });
    app.setImportedFileSource(name);
    return;
  }
  await app.importBytes(bytes, name);
  app.setImportedFileSource(name);
  if (nativePath && !isMidiFile(name)) app.rememberLastFile(name);
}

/** Register the platform-specific file-drop adapter around App.importBytes(). */
export async function wireDragDrop(
  app: App,
  beforeImport: () => Promise<boolean> = async () => true,
): Promise<void> {
  if (isTauriRuntime()) {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    await getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        showFileDropTarget(true);
        return;
      }
      if (event.payload.type === "leave") {
        showFileDropTarget(false);
        return;
      }
      if (event.payload.type !== "drop") return;
      showFileDropTarget(false);
      const path = event.payload.paths.find((candidate) => isSupportedImportFile(candidate));
      if (!path) return;
      if (!(await beforeImport())) return;
      await importDroppedBytes(app, await readFile(path), path, "", true);
    });
    return;
  }

  const dropTarget = document.documentElement;
  const hasFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");
  dropTarget.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    showFileDropTarget(true);
  }, true);
  dropTarget.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    showFileDropTarget(true);
  }, true);
  dropTarget.addEventListener("dragleave", (event) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !dropTarget.contains(next)) showFileDropTarget(false);
  }, true);
  dropTarget.addEventListener("drop", async (event) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    showFileDropTarget(false);
    const file = files.find((candidate) => isSupportedImportFile(candidate.name, candidate.type));
    if (!file) return;
    if (!(await beforeImport())) return;
    await importDroppedBytes(
      app,
      new Uint8Array(await file.arrayBuffer()),
      file.name,
      file.type,
    );
  }, true);
}
