import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// Runs current source without changing shared build output.
const server = process.env.MOBILE_TEST_URL ? null : await createServer({
  server: { host: "127.0.0.1", port: 20340, strictPort: false, hmr: false }, clearScreen: false,
});
if (server) await server.listen();
const browser = await chromium.launch(process.env.BROWSER_EXECUTABLE_PATH
  ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH, headless: true } : { channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const output = resolve("artifacts/mobile-surface-modes");
await mkdir(output, { recursive: true });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const fixture = ".Title\nTitle = {触屏分谱回归}\nKeyAndMeters = {1=G,4/4}\n.Voice\n1 2 3 4 | 5 6 7 1' |]";
const ready = () => page.waitForFunction(() => window.__app?.getScoreEditorState().ready);
const text = () => page.evaluate(() => window.__app.getText());
const mode = () => page.evaluate(() => window.__app.interactionMode);
const firstPitch = () => page.evaluate(() => window.__app._sourceNotes[0].note.pitch);
async function waitStaff() {
  await page.waitForFunction(() => window.__app.isStaffPreviewCurrent() && document.querySelector("#staff-pages [data-staff-ref]"));
}
async function tapFirstStaffNote() {
  await waitStaff();
  const point = await page.evaluate(() => {
    const app = window.__app, note = app._sourceNotes[0].note;
    const element = [...document.querySelectorAll("#staff-pages [data-staff-ref]")].find(node =>
      app.getStaffPreviewSnapshot().registry.resolve({ revision: app._staffRevision, id: node.dataset.staffRef })?.note === note);
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  });
  await page.touchscreen.tap(point.x, point.y);
  if (await page.locator(".mobile-candidate-list").count()) await page.locator(".mobile-candidate-list button").first().tap();
}
async function inputStaff(letter, octave, accidental, pitch) {
  await ready();
  const untouched = await page.evaluate(() => window.__app._sourceNotes.slice(1).map(source => ({
    pitch: source.note.pitch, start: source.note.absoluteTick.toString(), duration: source.chord.duration.toString(),
  })));
  await tapFirstStaffNote();
  await page.selectOption("#mobile-staff-octave", String(octave));
  await page.locator(`[data-staff-accidental="${accidental}"]`).tap();
  await page.locator(`.mobile-letter-keyboard [data-input-letter="${letter}"]`).tap();
  await page.waitForFunction(pitch => window.__app._sourceNotes[0].note.pitch === pitch, pitch);
  assert.equal(await firstPitch(), pitch, `${letter}, octave ${octave}, accidental ${accidental}`);
  assert.deepEqual(await page.evaluate(() => window.__app._sourceNotes.slice(1).map(source => ({
    pitch: source.note.pitch, start: source.note.absoluteTick.toString(), duration: source.chord.duration.toString(),
  }))), untouched, `${letter}, octave ${octave}, accidental ${accidental} preserves unselected pitches and rhythm`);
}
try {
  await page.goto(process.env.MOBILE_TEST_URL ?? server.resolvedUrls.local[0], { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app?.executeScoreCommand && document.querySelector("#mobile-surface-select"));
  await page.evaluate(() => {
    document.getElementById("btn-midi-input").addEventListener("click", event => {
      event.stopImmediatePropagation();
      document.body.dataset.testMidiMenuOpened = "true";
    }, { capture: true, once: true });
  });
  await page.locator("#mobile-more").tap();
  await page.getByRole("button", { name: "MIDI 输入设备…", exact: true }).tap();
  await page.waitForFunction(() => document.body.dataset.testMidiMenuOpened === "true");
  assert.equal(await page.locator(".mobile-sheet-layer").count(), 0, "device entry closes the mobile menu before opening settings");
  await page.evaluate(fixture => {
    const app = window.__app;
    app.documentFormat = "jpw"; app.slashOptions = null; app.setText(fixture); app.resetDocumentUndo();
    app._player = { state: "stopped", stop() {}, stopAudition() {}, async audition() {}, async play() {} };
  }, fixture);
  await ready();
  await page.locator('[data-mobile-mode="input"]').tap();
  await page.waitForFunction(() => window.__app.interactionMode === "input");
  assert.equal(await page.locator(".mobile-number-keyboard").isVisible(), true);
  await page.locator("#mobile-keyboard-switch").tap();
  await page.getByRole("button", { name: "原琴21键 QWERTYU / ASDFGHJ / ZXCVBNM", exact: true }).tap();
  assert.equal(await page.locator(".mobile-lyre-keyboard").isVisible(), true);

  await page.selectOption("#mobile-surface-select", "staff");
  await waitStaff();
  assert.equal(await page.locator(".mobile-number-keyboard").isVisible(), false);
  assert.equal(await page.locator(".mobile-lyre-keyboard").isVisible(), false);
  assert.equal(await page.locator("#mobile-keyboard-switch").isVisible(), false);
  assert.equal(await page.locator(".mobile-letter-keyboard").isVisible(), true);
  assert.equal(await page.locator("#mobile-octave").isVisible(), false);
  assert.equal(await page.locator("#mobile-staff-octave").isVisible(), true);
  await inputStaff("C", 4, "0", 60); // G-major movable 1 is G4; fixed C4 remains C4.
  await inputStaff("F", 4, "key", 66); // Key-signature F sharp.
  await inputStaff("F", 4, "0", 65); // Explicit natural overrides key signature.
  await inputStaff("B", 3, "-1", 58);
  await inputStaff("C", 5, "1", 73);
  await waitStaff();
  await page.screenshot({ path: resolve(output, "phone-staff-input.png") });
  await page.selectOption("#mobile-surface-select", "jianpu");
  assert.equal(await page.locator(".mobile-lyre-keyboard").isVisible(), true, "jianpu retains its own keyboard preference");
  await page.selectOption("#mobile-surface-select", "staff");
  await waitStaff();

  await page.setViewportSize({ width: 1024, height: 900 });
  await page.waitForFunction(() => !document.querySelector('#mobile-surface-select option[value="compare"]').disabled);
  const beforeCompare = await text();
  await page.selectOption("#mobile-surface-select", "compare");
  await page.waitForFunction(() => window.__app.interactionMode === "view" && document.documentElement.dataset.mobilePreview === "true");
  assert.equal(await page.locator("#mobile-command-dock").isVisible(), false);
  assert.equal(await page.locator('[data-mobile-mode="input"]').isVisible(), false);
  assert.equal(await page.locator('[data-mobile-mode="select"]').isVisible(), false);
  assert.equal(await page.locator("#mobile-undo").isVisible(), false);
  await tapFirstStaffNote();
  await page.locator("#staff-pane").focus();
  await page.keyboard.press("n"); await page.keyboard.press("Delete");
  const prevented = await page.evaluate(async () => {
    const app = window.__app;
    const modeCommand = await app.executeScoreCommand({ type: "set-mode", mode: "input" });
    const input = await app.executeScoreCommand({ type: "start-input", at: "start" });
    const pitch = await app.executeScoreCommand({ type: "input-letter", letter: "C", octave: 4 });
    app.setInputMode(true);
    return { modeCommand, input, pitch, mode: app.interactionMode, count: app.getScoreEditorState().selection.count };
  });
  assert.deepEqual(prevented, { modeCommand: false, input: false, pitch: false, mode: "view", count: 0 });
  assert.equal(await text(), beforeCompare, "compare gestures, shortcuts and command attempts cannot edit");
  await page.screenshot({ path: resolve(output, "tablet-compare-preview.png") });
  await page.getByRole("button", { name: "打开五线谱进行编辑", exact: true }).tap();
  await page.locator('[data-mobile-mode="input"]').tap();
  await page.waitForFunction(() => window.__app.interactionMode === "input");
  assert.equal(await page.locator(".mobile-letter-keyboard").isVisible(), true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.selectOption("#mobile-surface-select", "text");
  await page.waitForFunction(() => document.documentElement.dataset.mobileText === "true");
  assert.equal(await mode(), "view");
  assert.equal(await page.locator("#code-pane .cm-content").getAttribute("contenteditable"), "true");
  assert.equal(await page.locator("#mobile-command-dock").isVisible(), false);
  assert.equal(await page.locator('[data-mobile-mode="input"]').isVisible(), false);
  const beforeTyping = await text();
  const marker = "ABC 123 qwerty ";
  const insertion = await page.evaluate(() => {
    const app = window.__app, at = app.getText().indexOf("Title = {") + "Title = {".length;
    app.view.dispatch({ selection: { anchor: at }, scrollIntoView: true }); app.view.focus(); return at;
  });
  await page.keyboard.type(marker);
  assert.equal(await text(), beforeTyping.slice(0, insertion) + marker + beforeTyping.slice(insertion), "music shortcut characters remain ordinary text");
  await page.keyboard.press("Backspace");
  assert.equal(await text(), beforeTyping.slice(0, insertion) + marker.slice(0, -1) + beforeTyping.slice(insertion));
  assert.equal(await mode(), "view", "typing cannot reactivate score input");
  await page.screenshot({ path: resolve(output, "phone-text-editor.png") });
  await page.selectOption("#mobile-surface-select", "jianpu");
  await ready();
  assert.equal(await page.locator("#code-workspace").isVisible(), false);
  assert.equal(await mode(), "view");
  await page.locator('[data-mobile-mode="input"]').tap();
  assert.equal(await page.locator(".mobile-lyre-keyboard").isVisible(), true);

  await page.setViewportSize({ width: 1366, height: 900 });
  await page.locator("#mobile-more").tap();
  await page.locator('.mobile-sheet select[aria-label="工作区模式"]').selectOption("desktop");
  await page.waitForFunction(() => document.documentElement.dataset.workspaceMode === "desktop");
  await page.locator("#btn-workspace-mode").click();
  const modal = await page.locator(".mobile-sheet").boundingBox();
  assert(Math.abs(modal.y + modal.height / 2 - 450) < 2, "desktop workspace chooser is centered vertically");
  await page.getByRole("button", { name: "关闭面板", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log("Mobile surface modes: dedicated staff pitch/accidentals/octaves, jianpu preference, preview-only compare, editable text and centered desktop chooser OK.");
} catch (error) {
  await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
  console.error(await page.evaluate(() => ({ state: window.__app?.getScoreEditorState(), dataset: { ...document.documentElement.dataset }, text: window.__app?.getText() })).catch(() => null));
  throw error;
} finally {
  await context.close(); await browser.close(); if (server) await server.close();
}
