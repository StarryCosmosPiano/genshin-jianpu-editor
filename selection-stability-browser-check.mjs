// Actual Edge keyboard and pointer gestures for member identity and input marquee.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = process.env.APP_TEST_URL ? null : createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(await readFile(join(root, normalize(file))));
  } catch { response.writeHead(404); response.end(); }
});
if (server) await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
await page.addInitScript(() => localStorage.setItem("jpeditor:workspace-mode:v1", "desktop"));
const errors = [];
page.on("pageerror", error => errors.push(error.message));

async function reset(text, keyboard = false) {
  await page.evaluate(async ({ text, keyboard }) => {
    const app = window.__app;
    app.setInputMode(false); app.documentFormat = "jpw"; app.slashOptions = null;
    app.setText(text);
    if (keyboard) { await app.changeDocumentFormat("keyboard"); app.slashOptions.keyboardKeyLabels = true; app.reload(app.getText()); }
    app.setCodePaneCollapsed(true); app.setRhythmEditDivision(16); app.setInputDurationDivision(16);
    app.resetDocumentUndo(); app.scorePane.focus({ preventScroll: true });
  }, { text, keyboard });
}
async function box(offset, degree) {
  return page.evaluate(({ offset, degree }) => {
    const app = window.__app;
    const source = app._sourceNotes.find(item => item.chord.position.toString() === offset
      && item.note.number === degree && !item.note.rest);
    if (!source) throw new Error(`Missing note ${offset}/${degree}`);
    const rendered = app.painter.noteGroupEls(source.chord, source.note)[0];
    rendered.element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const rect = rendered.element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  }, { offset, degree });
}
async function clickNote(offset, degree) {
  const rect = await box(offset, degree);
  await page.mouse.click((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
}
async function marquee(offset, degree, modifier) {
  const rect = await box(offset, degree);
  await page.keyboard.down(modifier);
  await page.mouse.move(rect.left - 14, rect.top - 14);
  await page.mouse.down();
  assert.equal(await page.evaluate(() => !!window.__app._dragSelection), true, "blank modified drag must arm a marquee in input mode");
  await page.mouse.move(rect.right + 3, rect.bottom + 3, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up(modifier);
}
async function staffReady() {
  await page.waitForFunction(() => {
    const app = window.__app, pane = document.getElementById("staff-pane");
    return app?.isStaffPreviewCurrent() && pane?.dataset.staffRevision === String(app.getStaffPreviewSnapshot().revision)
      && pane.getAttribute("aria-busy") === "false" && document.querySelector("#staff-pages [data-staff-ref]");
  }, { timeout: 30000 });
}
async function staffNote(offset, degree) {
  const id = await page.evaluate(({ offset, degree }) => {
    const target = window.__app.getStaffPreviewSnapshot().registry.targets.find(item => !item.grace
      && !item.note.rest && item.partIndex === 0 && item.measureIndex === 0
      && item.note.chord.position.toString() === offset && item.note.number === degree);
    if (!target) throw new Error(`Missing staff note ${offset}/${degree}`);
    return target.ref.id;
  }, { offset, degree });
  return page.locator(`#staff-pages [data-staff-ref="${id}"]`).first();
}
async function staffMarquee(offset, degree, modifier) {
  const note = await staffNote(offset, degree);
  await note.scrollIntoViewIfNeeded();
  const rect = await note.boundingBox();
  assert.ok(rect, "staff note needs a rendered hit rectangle");
  await page.keyboard.down(modifier);
  await page.mouse.move(rect.x - 14, rect.y - 14);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width + 3, rect.y + rect.height + 3, { steps: 6 });
  assert.equal(await page.locator("#staff-pages .staff-marquee").count(), 1,
    "blank modified drag must display a staff marquee in input mode");
  await page.mouse.up();
  await page.keyboard.up(modifier);
}
async function state() {
  return page.evaluate(() => {
    const app = window.__app;
    const selected = app._selectedNotes;
    return { input: app._input.enabled, selected: selected.map(item => ({ pitch: item.visualNote.pitch,
      degree: item.visualNote.number, octave: item.visualNote.jpOctave, offset: item.visualNote.chord.position.toString() })),
      targets: app._input.targets.map(target => ({ id: target.memberId, pitch: target.focusPitch })),
      focusMatches: app.inputFocus()?.note === selected.at(-1)?.visualNote,
      inputFocusCount: document.querySelectorAll(".input-focused").length,
      chord: app._sourceNotes.find(source => source.chord.position.equals(0))?.chord.notes
        .map(note => ({ pitch: note.pitch, selected: selected.some(item => item.visualNote === note) })),
      status: document.querySelector("#status")?.textContent };
  });
}

try {
  await page.goto(process.env.APP_TEST_URL ?? `http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  const chordFixture = ".Title\nTitle = {和弦成员选择}\nKeyAndMeters = {1=C,4/4}\n.Voice\n[135] 2 3 4 |]\n";
  for (const selectedDegree of ["1", "5"]) {
    await reset(chordFixture, true);
    await clickNote("0", selectedDegree);
    await page.keyboard.press("n");
    const initial = await state();
    assert.equal(initial.selected.length, 1);
    const identity = initial.targets[0].id;
    const untouched = initial.chord.filter(note => !note.selected).map(note => note.pitch).sort();
    for (const [key, pitch] of [["u", 83], ["d", 64], ["z", 48], ["d", 64], ["h", 69]]) {
      await page.keyboard.press(key);
      const actual = await state();
      assert.equal(actual.selected.length, 1, `${selectedDegree}/${key}: selection widened: ${JSON.stringify(actual)}`);
      assert.equal(actual.selected[0].pitch, pitch, `${key}: current member was not edited: ${JSON.stringify(actual)}`);
      assert.equal(actual.targets[0].id, identity, `${key}: member identity changed`);
      assert.equal(actual.focusMatches, true, `${key}: caret moved to another same-pitch member`);
      assert.equal(actual.inputFocusCount, 1);
      assert.equal(actual.chord.length, 3);
      assert.deepEqual(actual.chord.filter(note => !note.selected).map(note => note.pitch).sort(), untouched);
    }
    await page.keyboard.press("Control+z");
    await page.waitForFunction(() => window.__app._selectedNotes[0]?.visualNote.pitch === 64);
    assert.equal((await state()).targets[0].id, identity, "undo must restore the same member identity");
    await page.keyboard.press("Control+y");
    await page.waitForFunction(() => window.__app._selectedNotes[0]?.visualNote.pitch === 69);
    assert.equal((await state()).focusMatches, true);
  }

  for (const keyboard of [false, true]) {
    await reset(".Title\nTitle = {输入框选与级进}\nKeyAndMeters = {1=C,4/4}\n.Voice\n3 6 7 2 |]\n", keyboard);
    await clickNote("0", "3"); await page.keyboard.press("n");
    await marquee("1", "6", "Control");
    assert.equal((await state()).selected.length, 2, "first Ctrl marquee must accumulate");
    await marquee("2", "7", "Control");
    let actual = await state();
    assert.equal(actual.selected.length, 3, "subsequent Ctrl marquee must retain previous boxes");
    assert.equal(actual.targets.length, 3);
    await page.keyboard.press("Alt+ArrowUp");
    actual = await state();
    assert.deepEqual(actual.selected.map(note => note.pitch), [65, 71, 72], `one degree must cross 3/4 and 7/1: ${JSON.stringify(actual)}`);
    await page.keyboard.press("Alt+ArrowDown");
    assert.deepEqual((await state()).selected.map(note => note.pitch), [64, 69, 71]);
    await marquee("3", "2", "Shift");
    actual = await state();
    assert.equal(actual.input, true);
    assert.equal(actual.selected.length, 1, "Shift marquee replaces every previous box");
    assert.equal(actual.targets.length, 1, "replaced selection must also replace edit targets");
    await page.keyboard.press("Alt+ArrowUp");
    assert.equal((await state()).selected[0].pitch, 64);
  }

  // The staff owns separate pointer handlers. Exercise its real note-hit
  // rectangles rather than calling the shared selection API directly.
  await reset(".Title\nTitle = {五线谱输入框选}\nKeyAndMeters = {1=C,4/4}\n.Voice\n3 6 7 2 |]\n");
  await page.selectOption("#staff-view-select", "staff");
  await staffReady();
  await (await staffNote("0", "3")).click();
  await page.keyboard.press("n");
  await staffReady();
  const staffText = await page.evaluate(() => window.__app.getText());
  assert.equal((await state()).input, true, "staff N enters input before the pointer gestures");
  await staffMarquee("1", "6", "Control");
  let staffActual = await state();
  assert.deepEqual(staffActual.selected.map(note => note.offset), ["0", "1"],
    `first staff Ctrl marquee must accumulate: ${JSON.stringify(staffActual)}`);
  assert.equal(staffActual.targets.length, 2);
  await staffMarquee("2", "7", "Control");
  staffActual = await state();
  assert.deepEqual(staffActual.selected.map(note => note.offset), ["0", "1", "2"],
    "subsequent staff Ctrl marquee must retain both previous selections");
  assert.deepEqual(staffActual.targets.map(target => target.pitch), [64, 69, 71]);
  await staffMarquee("3", "2", "Shift");
  staffActual = await state();
  assert.equal(staffActual.input, true, "staff marquee retains input mode");
  assert.deepEqual(staffActual.selected.map(note => note.offset), ["3"], "staff Shift marquee replaces previous boxes");
  assert.deepEqual(staffActual.targets.map(target => target.pitch), [62], "staff Shift marquee replaces the edit targets");
  assert.equal(await page.evaluate(() => window.__app.getText()), staffText, "staff input marquee must not insert or edit notes");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "staff-pane", "staff marquee retains staff keyboard focus");
  assert.deepEqual(errors, []);
  console.log("selection-stability-browser-check: ok (letter crossing/unisons/undo, jianpu and staff input marquee, degree batches)");
} finally { await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
