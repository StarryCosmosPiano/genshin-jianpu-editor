export interface DocumentSaveCommands {
  saveFile(): unknown;
  saveFileAs(): unknown;
}

/** These keys belong to the document in every editor context, including source text. */
export function isReservedDocumentSaveChord(chord: string): boolean {
  const parts = chord.toLowerCase().split("+");
  return parts.pop() === "s" && parts.some((part) => ["mod", "ctrl", "meta"].includes(part))
    && parts.every((part) => ["mod", "ctrl", "meta", "shift"].includes(part));
}

export function handleDocumentSaveShortcut(event: KeyboardEvent, commands: DocumentSaveCommands): boolean {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.getModifierState?.("AltGraph")
    || (event.key.toLowerCase() !== "s" && event.code !== "KeyS")) return false;
  // Intercept before CodeMirror, piano input and the browser's Save Page action.
  event.preventDefault();
  // The key recorder must show its reserved-key message, without saving a document.
  if (typeof Element !== "undefined" && event.target instanceof Element
    && event.target.closest("[data-shortcut-recording]")) return true;
  event.stopImmediatePropagation();
  // Hold/repeat never opens a second dialog; an active IME must finish its text first.
  if (!event.repeat && !event.isComposing) {
    if (event.shiftKey) void commands.saveFileAs();
    else void commands.saveFile();
  }
  return true;
}

export function wireDocumentSaveShortcuts(commands: DocumentSaveCommands, target: Document = document): () => void {
  const onKeyDown = (event: KeyboardEvent): void => { handleDocumentSaveShortcut(event, commands); };
  target.addEventListener("keydown", onKeyDown, { capture: true });
  return () => target.removeEventListener("keydown", onKeyDown, { capture: true });
}
