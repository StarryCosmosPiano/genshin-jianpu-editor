import assert from "node:assert/strict";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import {
  SHORTCUT_ACTIONS,
  defaultShortcutBindings,
  findShortcutConflicts,
  getShortcutBindings,
  handleTextShortcut,
  remapShortcutEvent,
  saveShortcutBindings,
  shortcutBindingAllowed,
  type ShortcutContext,
} from "./src/editor/shortcuts";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
}, configurable: true });
Object.defineProperty(globalThis, "document", { value: { dispatchEvent: () => true }, configurable: true });
Object.defineProperty(globalThis, "CustomEvent", { value: class { constructor(public type: string) {} }, configurable: true });

function key(keyName: string, options: Partial<KeyboardEvent> = {}): KeyboardEvent & { blocked?: boolean } {
  return {
    key: keyName,
    code: /^[0-9]$/.test(keyName) ? `Digit${keyName}` : keyName,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    isComposing: false,
    getModifierState: () => false,
    preventDefault() { this.blocked = true; },
    stopPropagation() {},
    ...options,
  } as unknown as KeyboardEvent & { blocked?: boolean };
}

function mapped(event: KeyboardEvent, context: ShortcutContext): KeyboardEvent | null {
  return remapShortcutEvent(event, context);
}

const defaults = defaultShortcutBindings();
assert.ok(SHORTCUT_ACTIONS.length >= 80, "catalog includes CodeMirror and score commands");
for (const [index, binding] of [...defaultKeymap, ...historyKeymap].entries()) {
  if (!binding.win && !binding.key) continue;
  assert.ok(SHORTCUT_ACTIONS.some((item) => item.id === `text.command.${index}`),
    `CodeMirror command ${index} is editable`);
  if (binding.shift) assert.ok(SHORTCUT_ACTIONS.some((item) => item.id === `text.command.${index}.shift`),
    `CodeMirror Shift command ${index} is independently editable`);
}
assert.deepEqual(findShortcutConflicts(defaults), [], "defaults are conflict-free");
assert.equal(defaults["score.octaveUp"][0], defaults["input.up"][0],
  "same arrow may mean different actions in disjoint score modes");
assert.equal(shortcutBindingAllowed("text.command.0", "a"), false,
  "plain letters remain text input");
for (const chord of [".", "Shift+Plus", "Shift+/", "Space", "7", "Shift+7"]) {
  assert.equal(shortcutBindingAllowed("voice.2", chord), false,
    `${chord} must remain available for text entry`);
}
assert.equal(shortcutBindingAllowed("text.command.38", "Enter"), true,
  "Enter remains an editable text command");
assert.equal(shortcutBindingAllowed("input.advance", "Space"), true,
  "input-mode Space may still be configured outside text context");

const collision = structuredClone(defaults);
collision["score.octaveUp"] = ["Alt+ArrowDown"];
assert.ok(findShortcutConflicts(collision).some((item) =>
  [item.first.id, item.second.id].includes("score.movePartDown")),
"conflicting actions in the same score context are rejected");

const customized = structuredClone(defaults);
customized["score.octaveUp"] = ["w"];
customized["input.degree1"] = ["F2"];
customized["voice.1"] = ["Alt+q"];
customized["page.zoomIn"] = ["Alt+g"];
const textSelectAll = SHORTCUT_ACTIONS.find((item) => item.label === "全选文本");
assert.ok(textSelectAll);
customized[textSelectAll.id] = ["Mod+Shift+a"];
const textMoveLeft = SHORTCUT_ACTIONS.find((item) => item.label === "光标左移字符" && item.defaults.includes("ArrowLeft"));
assert.ok(textMoveLeft);
customized[textMoveLeft.id] = ["F4"];
const textSelectLeft = SHORTCUT_ACTIONS.find((item) => item.id === `${textMoveLeft.id}.shift`);
assert.ok(textSelectLeft && textSelectLeft.defaults.includes("Shift+ArrowLeft"),
  "CodeMirror shift variant has its own editable action");
customized[textSelectLeft.id] = ["F6"];
assert.deepEqual(findShortcutConflicts(customized), []);
saveShortcutBindings(customized);
assert.equal(getShortcutBindings()["input.degree1"][0], "F2");
assert.ok(storage.get("jpeditor.ui.shortcuts.v1")?.includes("input.degree1"),
  "changed shortcuts are persisted separately from document settings");

assert.equal(mapped(key("w"), "selection")?.key, "ArrowUp");
assert.equal(mapped(key("F2"), "input")?.key, "1");
const oldInput = key("1");
assert.equal(mapped(oldInput, "input"), null, "old binding no longer edits a note");
assert.equal(oldInput.blocked, true);
assert.equal(mapped(key(" "), "selection")?.key, " ", "selection Space still plays");
assert.equal(mapped(key(" "), "input")?.key, " ", "input Space still advances");
assert.equal(mapped(key(" "), "text")?.key, " ", "text Space remains native typing");
assert.equal(mapped(key("q", { altKey: true }), "text")?.code, "Digit1",
  "custom voice key retains the existing voice handler's digit code");
assert.equal(mapped(key("g", { altKey: true }), "global")?.key, "+",
  "custom zoom key reaches the original zoom branch");
let markerKey = "";
assert.equal(handleTextShortcut(key("F4"), {} as never, (canonical) => {
  markerKey = canonical.key;
  return true;
}), true, "text command is handled by the score marker hook first");
assert.equal(markerKey, "ArrowLeft", "marker hook sees the original CodeMirror direction");
let selectedShift = false;
assert.equal(handleTextShortcut(key("F6"), {} as never, (canonical) => {
  selectedShift = canonical.key === "ArrowLeft" && canonical.shiftKey;
  return true;
}), true);
assert.equal(selectedShift, true, "remapped selection command preserves Shift in marker hook");
const oldZoom = key("=", { ctrlKey: true });
assert.equal(mapped(oldZoom, "global"), null);

const cancelledDraft = getShortcutBindings();
cancelledDraft["input.degree1"] = ["F3"];
assert.equal(getShortcutBindings()["input.degree1"][0], "F2", "draft edits do not apply on cancel");
const reassigned = getShortcutBindings();
reassigned["text.command.17"] = ["F8"];
reassigned["voice.2"] = ["Mod+/"];
reassigned[textSelectAll.id] = ["Alt+2"];
assert.deepEqual(findShortcutConflicts(reassigned), []);
saveShortcutBindings(reassigned);
const voiceOnOldTextDefault = key("/", { ctrlKey: true });
assert.equal(handleTextShortcut(voiceOnOldTextDefault, {} as never), false,
  "text command must release its displaced default to a configured voice command");
const voiceMapped = mapped(voiceOnOldTextDefault, "text");
assert.equal(voiceMapped?.key, "2");
assert.equal(voiceMapped?.code, "Digit2");
let textOnOldVoiceDefault = false;
assert.equal(handleTextShortcut(key("2", { altKey: true }), {} as never, (canonical) => {
  textOnOldVoiceDefault = canonical.key === "a" && canonical.ctrlKey;
  return true;
}), true, "text command may take a voice command's old default");
assert.equal(textOnOldVoiceDefault, true);
const globalTakesScoreDefault = structuredClone(defaults);
globalTakesScoreDefault["score.octaveUp"] = ["w"];
globalTakesScoreDefault["input.up"] = ["F7"];
globalTakesScoreDefault["page.next"] = ["ArrowUp"];
assert.deepEqual(findShortcutConflicts(globalTakesScoreDefault), []);
saveShortcutBindings(globalTakesScoreDefault);
const oldScoreArrow = key("ArrowUp");
assert.equal(mapped(oldScoreArrow, "selection")?.key, "F24",
  "score handler receives a neutral key when a global action takes its old binding");
assert.equal(oldScoreArrow.blocked, undefined, "physical key may bubble to global handler");
assert.equal(mapped(oldScoreArrow, "global")?.key, "PageDown",
  "global handler receives the rebound physical key");
const scoreTakesGlobalDefault = structuredClone(defaults);
scoreTakesGlobalDefault["page.next"] = ["F7"];
scoreTakesGlobalDefault["score.octaveUp"] = ["PageDown"];
assert.deepEqual(findShortcutConflicts(scoreTakesGlobalDefault), []);
saveShortcutBindings(scoreTakesGlobalDefault);
assert.equal(mapped(key("PageDown"), "selection")?.key, "ArrowUp",
  "a new score binding takes priority over a displaced global default");
saveShortcutBindings(defaults);
assert.equal(getShortcutBindings()["input.degree1"][0], "1", "reset restores defaults");
assert.equal(storage.get("jpeditor.ui.shortcuts.v1"), "{}", "reset clears stored overrides");
console.log(`Shortcut preferences core: ${SHORTCUT_ACTIONS.length} actions, conflicts, persistence and remapping OK`);
