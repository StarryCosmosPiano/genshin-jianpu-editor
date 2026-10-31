// Existing silence is not a Delete target. Typing 0 remains an explicit edit.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const server = process.env.APP_TEST_URL ? null : createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    response.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript",
      ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2" })[extname(file)] ?? "application/octet-stream");
    response.end(await readFile(join(process.cwd(), "dist", file)));
  } catch { response.writeHead(404); response.end(); }
});
if (server) await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const fixture = ".Title\nTitle = {休止符删除回归}\nKeyAndMeters = {1=C,4/4}\n.Voice\n0 1 2 3 |]\n";
const readyStaff = () => page.waitForFunction(() => {
  const app = window.__app, pane = document.getElementById("staff-pane");
  return app.isStaffPreviewCurrent() && pane.dataset.staffRevision === String(app.getStaffPreviewSnapshot().revision)
    && pane.getAttribute("aria-busy") === "false";
});
const focusAt = async (offset, surface) => {
  await page.evaluate(({ offset, surface }) => {
    const app = window.__app;
    app._input.setCursor(app.painter.score, {
      partIndex: 0, measureIndex: 0,
      offset: app.painter.score.parts[0].measures[0].position.constructor.fromString(offset),
      division: 16, lane: "rest", verticalIndex: 0,
    });
    app.selectInputFocus(false);
    app.renderInputCursor();
    (surface === "staff" ? document.getElementById("staff-pane") : app.scorePane).focus();
  }, { offset, surface });
};
const snapshot = () => page.evaluate(() => {
  const app = window.__app;
  return { text: app.getText(), revision: app.getStaffPreviewSnapshot().revision,
    dirty: app.hasUnsavedChanges(), cursor: app._input.cursor?.offset.toString(),
    entries: app.painter.score.parts[0].measures[0].entries.filter(entry => entry.notes).map(entry => ({
      at: entry.position.toString(), duration: entry.duration?.toString(), rest: entry.rest,
      pitches: entry.notes.map(note => note.pitch),
    })) };
});

try {
  await page.goto(process.env.APP_TEST_URL ?? `http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    window.__app._player = { state: "stopped", stop() {}, stopAudition() {}, async audition() {} };
  });
  let checks = 0;
  for (const format of ["jpw", "keyboard", "number"]) {
    await page.selectOption("#staff-view-select", "jianpu");
    await page.evaluate(async ({ fixture, format }) => {
      const app = window.__app;
      app.setInputMode(false);
      app.documentFormat = "jpw"; app.slashOptions = null;
      app.loadText(fixture, "rest-delete.jpwabc");
      if (format !== "jpw") await app.changeDocumentFormat(format);
      if (app.slashOptions) {
        app.slashOptions.showExplicitRests = true;
        app.setText(app.serializeCurrentScoreDocument(true));
      }
      app.resetDocumentUndo();
      app.setRhythmEditDivision(16);
      app.setInputDurationDivision(16);
      app.setInputMode(true);
    }, { fixture, format });
    for (const surface of ["jianpu", "staff"]) {
      await page.selectOption("#staff-view-select", surface);
      if (surface === "staff") await readyStaff();
      for (const offset of ["1/4", "1/2", "3/4", "0"]) {
        await focusAt(offset, surface);
        const before = await snapshot();
        for (const key of ["Delete", "Backspace", "Delete"]) {
          await page.keyboard.press(key);
          assert.deepEqual(await snapshot(), before, `${format}/${surface} ${key} at ${offset} changed an existing quarter rest`);
          checks++;
        }
      }
    }
    // A real note is still deletable; a second Delete on its new rest is inert.
    await page.selectOption("#staff-view-select", "jianpu");
    await focusAt("1", "jianpu");
    await page.keyboard.press("Delete");
    const deleted = await snapshot();
    assert(deleted.entries.some(entry => entry.at === "1" && entry.rest), `${format}: real note was not deleted`);
    await focusAt("5/4", "jianpu");
    const silence = await snapshot();
    await page.keyboard.press("Delete");
    assert.deepEqual(await snapshot(), silence, `${format}: repeated deletion subdivided the replacement rest`);
    // 0 intentionally writes a grid-sized rest, so the Delete fix must not suppress it.
    await focusAt("2", "jianpu");
    const beforeZero = await snapshot();
    await page.keyboard.press("0");
    const afterZero = await snapshot();
    assert.notEqual(afterZero.text, beforeZero.text, `${format}: explicit 0 no longer inserts a rest`);
    assert(afterZero.entries.some(entry => entry.rest && entry.at === "2"),
      `${format}: explicit 0 did not replace the current attack with silence`);
  }
  assert.deepEqual(errors, []);
  console.log(`rest Delete/Backspace: ${checks} no-op checks plus real deletion and explicit 0 checks passed`);
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
