import assert from "node:assert/strict";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import type { ShortcutContext } from "./src/editor/shortcuts";

// Set navigator before loading shortcuts.ts, whose platform-specific Mod key
// and CodeMirror defaults are selected when the module is initialized.
const simulatedPlatform = process.env.SHORTCUT_TEST_PLATFORM;
if (simulatedPlatform) {
  Object.defineProperty(globalThis, "navigator", {
    value: { platform: simulatedPlatform }, configurable: true,
  });
}
const {
  SHORTCUT_ACTIONS,
  defaultShortcutBindings,
  findShortcutConflicts,
  getShortcutBindings,
  handleTextShortcut,
  remapShortcutEvent,
  saveShortcutBindings,
  shortcutBindingAllowed,
} = await import("./src/editor/shortcuts");
const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const modKey = mac ? { metaKey: true } : { ctrlKey: true };

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
for (const [id, chord] of Object.entries({
  "score.movePartUp": "Mod+Alt+ArrowUp", "score.movePartDown": "Mod+Alt+ArrowDown",
  "input.partUp": "Mod+Alt+ArrowUp", "input.partDown": "Mod+Alt+ArrowDown",
  "input.degreeUp": "Alt+ArrowUp", "input.degreeDown": "Alt+ArrowDown",
  "staff.partUp": "Mod+Alt+ArrowUp", "staff.partDown": "Mod+Alt+ArrowDown",
  "staff.semitoneUp": "Alt+ArrowUp", "staff.semitoneDown": "Alt+ArrowDown",
})) assert.deepEqual(defaults[id], [chord], `${id} has the exchanged default`);
for (const [label, chord] of Object.entries({
  "上移当前行": "Alt+ArrowUp", "下移当前行": "Alt+ArrowDown",
  "向上增加光标": "Mod+Alt+ArrowUp", "向下增加光标": "Mod+Alt+ArrowDown",
})) assert.deepEqual(SHORTCUT_ACTIONS.find(item => item.label === label)?.defaults, [chord],
  `${label} keeps the CodeMirror binding`);
assert.equal(SHORTCUT_ACTIONS.some(item => item.contexts.includes("selection")
  && /octave|duration|delete/.test(item.id)), false,
  "selection mode exposes no pitch, duration or delete shortcut");
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
collision["score.movePartUp"] = ["Mod+Alt+ArrowDown"];
assert.ok(findShortcutConflicts(collision).some((item) =>
  [item.first.id, item.second.id].includes("score.movePartDown")),
"conflicting actions in the same score context are rejected");

// This is a valid old override set. New defaults now overlap three custom
// actions; loading settings must keep those actions and their meanings intact.
const savedOverrides = JSON.stringify({
  "score.movePartUp": ["Mod+Alt+ArrowDown"],
  "input.partUp": ["F10"], "input.partDown": ["Alt+ArrowUp"],
  "staff.partDown": ["F11"], "staff.semitoneUp": ["Alt+ArrowDown"],
});
storage.set("jpeditor.ui.shortcuts.v1", savedOverrides);
const restored = getShortcutBindings();
assert.deepEqual(restored["score.movePartUp"], ["Mod+Alt+ArrowDown"]);
assert.deepEqual(restored["score.movePartDown"], [], "new selection default releases the saved key");
assert.deepEqual(restored["input.degreeUp"], [], "new degree default releases the saved part key");
assert.deepEqual(restored["staff.semitoneDown"], [], "new semitone default releases the saved key");
assert.deepEqual(findShortcutConflicts(restored), []);
assert.equal(storage.get("jpeditor.ui.shortcuts.v1"), savedOverrides, "loading does not rewrite saved preferences");
const restoredPart = mapped(key("ArrowUp", { altKey: true }), "input");
assert.equal(restoredPart?.key, "ArrowDown", "saved part-down still moves down");
assert.equal(restoredPart?.altKey, true);
assert.equal(mac ? restoredPart?.metaKey : restoredPart?.ctrlKey, true, "saved part key uses the new part dispatcher");
const restoredPitch = mapped(key("ArrowDown", { altKey: true }), "staff-input");
assert.equal(restoredPitch?.key, "ArrowUp", "saved semitone-up still raises pitch");
assert.equal(restoredPitch?.altKey, true);
assert.equal(restoredPitch?.metaKey || restoredPitch?.ctrlKey, false, "saved pitch key uses the new pitch dispatcher");
saveShortcutBindings(defaults);

const customized = structuredClone(defaults);
customized["score.movePartUp"] = ["w"];
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
assert.equal(mac ? mapped(key("w"), "selection")?.metaKey : mapped(key("w"), "selection")?.ctrlKey, true,
  "custom part shortcut receives the new Mod+Alt canonical event");
assert.equal(mapped(key("w"), "selection")?.altKey, true);
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
const oldZoom = key("=", modKey);
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
const voiceOnOldTextDefault = key("/", modKey);
assert.equal(handleTextShortcut(voiceOnOldTextDefault, {} as never), false,
  "text command must release its displaced default to a configured voice command");
const voiceMapped = mapped(voiceOnOldTextDefault, "text");
assert.equal(voiceMapped?.key, "2");
assert.equal(voiceMapped?.code, "Digit2");
let textOnOldVoiceDefault = false;
assert.equal(handleTextShortcut(key("2", { altKey: true }), {} as never, (canonical) => {
  textOnOldVoiceDefault = canonical.key === "a" && (mac ? canonical.metaKey : canonical.ctrlKey);
  return true;
}), true, "text command may take a voice command's old default");
assert.equal(textOnOldVoiceDefault, true);
const globalTakesScoreDefault = structuredClone(defaults);
globalTakesScoreDefault["score.movePartUp"] = ["w"];
globalTakesScoreDefault["input.up"] = ["F7"];
globalTakesScoreDefault["staff.diatonicUp"] = ["F9"];
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
scoreTakesGlobalDefault["score.movePartUp"] = ["PageDown"];
assert.deepEqual(findShortcutConflicts(scoreTakesGlobalDefault), []);
saveShortcutBindings(scoreTakesGlobalDefault);
assert.equal(mapped(key("PageDown"), "selection")?.key, "ArrowUp",
  "a new score binding takes priority over a displaced global default");
saveShortcutBindings(defaults);
assert.equal(SHORTCUT_ACTIONS.find(item => item.id === "staff.duration1")?.contexts.includes("staff-selection"), false,
  "staff selection exposes no duration editing");
assert.equal(mapped(key("1", { altKey: true }), "staff-selection")?.altKey, true,
  "staff selection supports voice assignment");
assert.equal(mapped(key("ArrowUp", { ...modKey, altKey: true }), "staff-input")?.altKey, true,
  "staff part movement shortcut preserves the more specific modifier combination");
assert.equal(mapped(key("C", { shiftKey: true }), "staff-input")?.key.toLowerCase(), "c", "staff accepts uppercase letters");
const separateSurfaces = structuredClone(defaults);
separateSurfaces["staff.duration1"] = ["F10"];
saveShortcutBindings(separateSurfaces);
assert.equal(mapped(key("F10"), "staff-input")?.key, "1");
assert.equal(mapped(key("1"), "input")?.key, "1", "staff rebinding leaves jianpu degree unchanged");
saveShortcutBindings(defaults);
assert.equal(getShortcutBindings()["input.degree1"][0], "1", "reset restores defaults");
assert.equal(storage.get("jpeditor.ui.shortcuts.v1"), "{}", "reset clears stored overrides");
console.log(`Shortcut preferences core: ${SHORTCUT_ACTIONS.length} actions, conflicts, persistence and remapping OK`);
