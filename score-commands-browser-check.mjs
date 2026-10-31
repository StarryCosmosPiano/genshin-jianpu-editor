import assert from "node:assert/strict";
import { createServer } from "vite";
import { launchSaveCheckBrowser } from "./browser-save-test-helpers.mjs";

// Run current sources by default, or a caller's already-built app. Never
// invokes a build or replaces dist/.
const server = process.env.APP_TEST_URL ? null : await createServer({ server: { host: "127.0.0.1", port: 5261, strictPort: false }, clearScreen: false });
if (server) await server.listen();
const browser = await launchSaveCheckBrowser();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, hasTouch: true });
const errors = [], checks = [];
page.on("pageerror", error => errors.push(error.message));
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const ready = () => page.waitForFunction(() => window.__app?.getScoreEditorState().ready);
const command = async value => {
  const result = await page.evaluate(value => window.__app.executeScoreCommand(value), value);
  await ready(); return result;
};
const state = () => page.evaluate(() => window.__app.getScoreEditorState());
const text = () => page.evaluate(() => window.__app.getText());
const notes = () => page.evaluate(() => {
  const result = [];
  window.__app.painter.score.parts.forEach((part, partIndex) => part.measures.forEach((measure, measureIndex) =>
    measure.entries.forEach(entry => entry.notes?.filter(note => !note.rest).forEach(note => result.push({
      part: partIndex, measure: measureIndex, at: entry.position.toString(), pitch: note.pitch,
      degree: note.number, octave: note.jpOctave, duration: entry.duration.toString(),
      grace: entry.graceNotes.map(item => ({ degree: item.number, pitch: item.pitch })),
    })))));
  return result;
});
const fixture = async (upper, lower, key = "C") => {
  const source = `.Title\nTitle = {触屏命令回归}\nKeyAndMeters = {1=${key},4/4}\n`
    + (lower === undefined ? `.Voice\n${upper}\n` : `.Voice.RH\n${upper}\n.Voice.LH\n${lower}\n`);
  await command({ type: "set-mode", mode: "view" });
  await page.evaluate(source => window.__app.loadText(source, null), source);
  await ready();
  await command({ type: "set-auto-advance", enabled: false });
  await command({ type: "start-input", at: "start" });
  await command({ type: "set-duration", division: 4 });
  return source;
};
const choose = async (part, offset, pitch) => {
  const ref = await page.evaluate(({ part, offset, pitch }) => window.__app.getStaffPreviewSnapshot().registry.targets
    .find(item => !item.grace && !item.note.rest && item.partIndex === part && item.note.chord.position.toString() === offset
      && (pitch === undefined || item.note.pitch === pitch))?.ref, { part, offset, pitch });
  assert(ref, "fixture note is missing");
  return command({ type: "select-notes", refs: [ref] });
};
const withDialog = async (value, entry) => {
  await page.evaluate(value => { window.__scoreCommandPending = window.__app.executeScoreCommand(value); }, value);
  const dialog = page.getByRole("dialog").last();
  await dialog.getByRole("textbox").first().fill(entry);
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  const result = await page.evaluate(() => window.__scoreCommandPending);
  await ready(); return result;
};
try {
  await page.goto(process.env.APP_TEST_URL ?? server.resolvedUrls.local[0], { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app?.getScoreEditorState);
  await ready();
  await page.evaluate(() => {
    const app = window.__app;
    app.setCodePaneCollapsed(true);
    app.soundfontsLoaded = true;
    app._player = { state: "stopped", stop() {}, stopAudition() {}, async unlockAudio() {},
      async audition() {}, async play() {} };
  });

  await fixture("0--- |]", "0--- |]");
  check("start input supplies the first beat without a keyboard", (await state()).cursor?.offset === "0");
  check("input defaults to retaining its position", (await state()).autoAdvance === false);
  await command({ type: "input-degree", degree: 3 });
  await command({ type: "input-degree", degree: 5 });
  check("two digits replace the same tone and leave the cursor", (await notes()).length === 1
    && (await notes())[0].pitch === 67 && (await state()).cursor.offset === "0");
  await command({ type: "prepare-chord", side: "above" });
  await command({ type: "input-degree", degree: 1 });
  await command({ type: "input-degree", degree: 3 });
  check("explicit chord mode adds distinct tones without replacing the source", JSON.stringify((await notes()).filter(note => note.part === 0).map(note => note.pitch).sort()) === JSON.stringify([67, 72, 76]));
  await command({ type: "finish-chord" });
  const upperBefore = (await notes()).filter(note => note.part === 0);
  await command({ type: "select-part", partIndex: 1 });
  await command({ type: "input-degree", degree: 1, octave: -1 });
  check("selecting another staff and entering a tone never moves original tones", JSON.stringify((await notes()).filter(note => note.part === 0)) === JSON.stringify(upperBefore)
    && (await notes()).some(note => note.part === 1 && note.pitch === 48));
  await command({ type: "set-auto-advance", enabled: true });
  await command({ type: "input-degree", degree: 2, octave: -1 });
  check("optional auto advance moves once after a successful input", (await state()).cursor.offset === "1");
  await command({ type: "set-position", position: { partIndex: 0, measureIndex: 0, offset: "0", midi: 67, step: "G", octave: 4 } });
  const duplicateBefore = await text();
  check("duplicate insertion is rejected", await command({ type: "input-degree", degree: 5, octave: 0 }) === false);
  check("rejected input does not advance or modify source", (await state()).cursor.offset === "0" && await text() === duplicateBefore);

  await fixture("0--- |]");
  await command({ type: "set-position", position: { partIndex: 0, measureIndex: 0, offset: "1", midi: 65, step: "F", octave: 4 } });
  await command({ type: "confirm-input" });
  check("confirm writes the exact pending pitch and retains the beat", (await notes()).some(note => note.at === "1" && note.pitch === 65)
    && (await state()).cursor.offset === "1");
  const confirmed = await text();
  check("confirm on an existing note cannot append or alter its chord", await command({ type: "confirm-input" }) === false && await text() === confirmed);

  await fixture("1 0 0 4 |]");
  const beforeEnd = await text();
  await command({ type: "start-input", at: "end" });
  check("go to end chooses the final position and does not create a measure", (await state()).cursor.offset === "3" && await text() === beforeEnd);

  await fixture("1 2 3 4 |]");
  let refs = await page.evaluate(() => window.__app.getStaffPreviewSnapshot().registry.targets.filter(item => !item.grace && !item.note.rest).map(item => item.ref));
  await command({ type: "select-notes", refs: [refs[0], refs[2]] });
  await command({ type: "set-auto-advance", enabled: true });
  await command({ type: "input-degree", degree: 6 });
  check("touch multi-selection changes both exact targets without auto advance", (await state()).selection.noteCount === 2
    && (await state()).cursor.offset === "2" && (await notes()).filter(note => note.pitch === 69).length === 2);
  refs = await page.evaluate(() => window.__app.getStaffPreviewSnapshot().registry.targets.filter(item => !item.grace && !item.note.rest).map(item => item.ref));
  await command({ type: "select-notes", refs: [refs[0]] });
  await command({ type: "select-notes", refs: [refs[3]], range: true });
  check("touch range selection includes every intervening note without Shift", (await state()).selection.noteCount === 4);

  await fixture("0 0 0 0 |]", "0 0 0 0 |]", "G");
  await command({ type: "set-position", position: { partIndex: 0, measureIndex: 0, offset: "3", midi: 67, step: "G", octave: 4 } });
  await command({ type: "set-auto-advance", enabled: true });
  const beforeTail = await text();
  await command({ type: "input-degree", degree: 7 });
  check("auto advance appends synchronized staff bars", (await state()).cursor.measureIndex === 1
    && await page.evaluate(() => window.__app.painter.score.parts.every(part => part.measures.length === 2)));
  await command({ type: "undo" });
  check("one undo restores both the input and its auto-appended bar", await text() === beforeTail);
  await command({ type: "redo" });
  check("redo restores the advanced cursor", (await state()).cursor.measureIndex === 1 && (await state()).cursor.offset === "0");

  await fixture("1' 2 3 4 |]", undefined, "G");
  await choose(0, "0");
  await command({ type: "input-degree", degree: 7 });
  check("screen degrees use the local G key and selected upper register", (await notes()).some(note => note.at === "0" && note.pitch === 90));
  const selectionBeforeSwitch = (await state()).selection.noteCount;
  const surfaceSelect = await page.locator("#mobile-surface-select").isVisible() ? "#mobile-surface-select" : "#staff-view-select";
  await page.selectOption(surfaceSelect, "staff");
  await page.waitForFunction(() => document.getElementById("staff-pane")?.getAttribute("aria-busy") === "false"
    && document.querySelector("#staff-pages [data-staff-ref]"));
  check("staff switching retains shared exact selection", (await state()).selection.noteCount === selectionBeforeSwitch && (await state()).cursor.offset === "0");
  const physicalBefore = await text();
  await page.locator("#staff-pane").focus(); await page.keyboard.press("1");
  check("physical staff 1 still selects a whole-note pending duration", (await state()).duration.division === 1 && await text() === physicalBefore);
  await command({ type: "input-degree", degree: 2 });
  check("screen staff 2 remains a degree, not a duration shortcut", (await notes()).some(note => note.at === "0" && note.pitch === 81));
  await command({ type: "input-letter", letter: "F" });
  check("screen named pitches use current written register and key", (await notes()).some(note => note.at === "0" && note.pitch === 78));

  await fixture("1 2 3 4 |]");
  await choose(0, "0");
  await command({ type: "add-mark", kind: "fermata" });
  let object = (await state()).objects.find(item => item.kind === "fermata");
  check("staff-accessible object list contains existing fermata", !!object);
  await command({ type: "select-object", ref: object.ref });
  const objectBeforeDigit = await text();
  check("numeric input cannot overwrite a hidden note behind a selected mark", await command({ type: "input-degree", degree: 6 }) === false && await text() === objectBeforeDigit);
  await command({ type: "delete-object" });
  check("existing fermata is deleted through the shared object command", !(await state()).objects.some(item => item.kind === "fermata"));
  await command({ type: "undo" });
  check("object deletion is undoable", (await state()).objects.some(item => item.kind === "fermata"));
  await choose(0, "0");
  await withDialog({ type: "add-mark", kind: "text" }, "dolce");
  object = (await state()).objects.find(item => item.kind === "text"); assert(object);
  await withDialog({ type: "edit-object", ref: object.ref }, "cantabile");
  check("existing staff annotation edits use the original object", (await state()).objects.some(item => item.label.includes("cantabile")));
  object = (await state()).objects.find(item => item.kind === "text");
  const beforeCancel = await text();
  await page.evaluate(ref => { window.__scoreCommandPending = window.__app.executeScoreCommand({ type: "edit-object", ref }); }, object.ref);
  await page.getByRole("dialog").last().getByRole("textbox").fill("应丢弃的内容");
  await page.getByRole("dialog").last().getByRole("button", { name: "取消", exact: true }).click();
  await page.evaluate(() => window.__scoreCommandPending);
  check("canceling an existing annotation leaves source unchanged", await text() === beforeCancel);
  await command({ type: "delete-object", ref: object.ref });
  check("annotation deletion does not remove the attached note", (await notes()).some(note => note.at === "0" && note.pitch === 60));
  await choose(0, "0");
  const keyObject = (await state()).objects.find(item => item.kind === "key"); assert(keyObject);
  const beforeKey = await text();
  const keyMarks = await page.evaluate(() => window.__app.painter.score.keyMarks.length);
  await command({ type: "select-object", ref: keyObject.ref });
  await page.evaluate(() => { window.__scoreCommandPending = window.__app.executeScoreCommand({ type: "edit-object" }); });
  await page.getByRole("dialog").last().getByRole("button", { name: "取消", exact: true }).click();
  await page.evaluate(() => window.__scoreCommandPending);
  check("selecting and canceling the opening key never materializes a hidden key mark", await text() === beforeKey
    && await page.evaluate(() => window.__app.painter.score.keyMarks.length) === keyMarks);
  await choose(0, "0");
  await command({ type: "add-mark", kind: "upper-mordent" });
  object = (await state()).objects.find(item => item.kind === "ornament"); assert(object);
  await command({ type: "delete-object", ref: object.ref });
  check("ornament deletion is reachable without a right click", !(await state()).objects.some(item => item.kind === "ornament"));
  await choose(0, "0");
  await withDialog({ type: "add-mark", kind: "grace" }, "23");
  object = (await state()).objects.find(item => item.kind === "grace"); assert(object);
  await command({ type: "select-object", ref: object.ref });
  await command({ type: "input-degree", degree: 5 });
  check("selected grace digit edits grace rather than main note", (await notes()).find(note => note.at === "0")?.pitch === 60
    && (await notes()).find(note => note.at === "0")?.grace.some(note => note.degree === "5"));
  object = (await state()).objects.find(item => item.kind === "grace" && item.label.includes("5")); assert(object);
  await command({ type: "delete-object", ref: object.ref });
  check("grace deletion retains the other grace and main note", (await notes()).find(note => note.at === "0")?.grace.length === 1);

  await page.evaluate(() => document.dispatchEvent(new CustomEvent("workspace:score-view", { detail: "jianpu" })));
  await fixture("(1 1) (2 3) |]");
  await choose(0, "2");
  object = (await state()).objects.find(item => item.kind === "slur"); assert(object);
  check("slurs expose their own curve beside a consolidated tied note", await page.evaluate(() =>
    document.querySelectorAll("#score-pane .jianpu-slur.tie-span").length === 1)
    && (await notes()).find(note => note.at === "0")?.duration === "2");
  await command({ type: "select-object", ref: object.ref });
  check("the slur object list selects its actual connected curve", await page.evaluate(() => {
    const app = window.__app, selected = app._selectedObjects[0];
    return selected?.kind === "slur" && selected.element.isConnected
      && selected.element.matches(".jianpu-slur.selected") && !!selected.element.querySelector("path")
      && app.renderedScoreObject(selected)?.element === selected.element;
  }));
  const slurPoint = await page.evaluate(() => {
    const path = window.__app._selectedObjects[0].element.querySelector("path");
    const point = path.getPointAtLength(path.getTotalLength() / 4);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM());
    return { x: screen.x, y: screen.y };
  });
  await command({ type: "clear-selection" });
  await page.touchscreen.tap(slurPoint.x, slurPoint.y);
  check("touching the drawn slur resolves the same semantic object", await page.evaluate(() => {
    const selected = window.__app._selectedObjects[0];
    return selected?.kind === "slur" && selected.element.matches(".jianpu-slur.selected")
      && selected.mark.slurStart && !!selected.mark.slurEndChord;
  }));
  const notesBeforeSlurDelete = JSON.stringify(await notes());
  await command({ type: "delete-object" });
  check("slur deletion retains notes and the adjacent tied duration", JSON.stringify(await notes()) === notesBeforeSlurDelete
    && await page.evaluate(() => !document.querySelector("#score-pane .jianpu-slur")));
  await command({ type: "undo" });
  check("undo restores the slur's visible semantic target", await page.evaluate(() => !!document.querySelector("#score-pane .jianpu-slur path")));
  object = (await state()).objects.find(item => item.kind === "slur"); assert(object);
  await command({ type: "edit-object", ref: object.ref });
  check("the existing slur edit action still removes only the slur", JSON.stringify(await notes()) === notesBeforeSlurDelete
    && await page.evaluate(() => !document.querySelector("#score-pane .jianpu-slur")));

  await fixture(Array.from({ length: 120 }, (_, index) => index === 47 ? "(1 2) 3 4 |" : "1 2 3 4 |").join("\n") + "]");
  await page.setViewportSize({ width: 390, height: 844 });
  await command({ type: "set-mode", mode: "select" });
  const distantSlur = await page.evaluate(() => {
    const app = window.__app, item = app.scoreCommandObjects(47).find(item => item.selection.kind === "slur");
    return { revision: app._staffRevision, id: item.id };
  });
  await command({ type: "select-object", ref: distantSlur });
  const slurText = await text();
  const selectedSlurVisible = () => page.evaluate(() => {
    const app = window.__app, selected = app._selectedObjects[0];
    if (app.getScoreEditorState().cursor || app._selectedNotes.length || !selected?.element.isConnected) return false;
    const rect = selected.element.getBoundingClientRect(), viewport = app.scorePane.getBoundingClientRect();
    return selected.element.matches(".jianpu-slur.selected") && rect.left >= viewport.left - .5
      && rect.right <= viewport.right + .5 && rect.top >= viewport.top - .5 && rect.bottom <= viewport.bottom + .5;
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(180);
  check("rotation keeps a selected slur visible without a note cursor", await selectedSlurVisible());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(120);
  await page.locator("#mobile-view-tools").click();
  for (let index = 0; index < 4; index++) {
    await page.getByRole("button", { name: "放大谱面", exact: true }).click();
    await page.waitForTimeout(40);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  check("screen zoom reveals the selected slur without changing the document", await selectedSlurVisible() && await text() === slurText);

  assert.deepEqual(errors, []);
  console.log(`score-commands-browser-check: ${checks.length} shared input, staff, auto-advance, history and object checks passed`);
} finally {
  await browser.close(); if (server) await server.close();
}
