// Browser regression for repeated vertical chord entry on a two-row score.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(await readFile(join(root, normalize(file))));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

const fixture = `.Title\nTitle = {连续纵向和弦输入}\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V1\n1 2 3 4 |]\n.Voice.Piano.V2\n5 6 7 1 |]\n`;
const state = () => page.evaluate(() => {
  const app = window.__app;
  const cursor = app._input.cursor;
  const chordAt = (part) => app.painter.score.parts[part].measures[0].entries
    .find((entry) => entry.notes?.length && !entry.rest && entry.position.toString() === "0");
  return {
    part: cursor?.partIndex ?? null,
    measure: cursor?.measureIndex ?? null,
    offset: cursor?.offset.toString() ?? null,
    lane: cursor?.lane ?? null,
    placeholder: document.querySelectorAll(".score-input-note-placeholder").length,
    upper: chordAt(0)?.notes.filter((note) => !note.rest).map((note) => note.pitch).sort((a, b) => a - b) ?? [],
    lower: chordAt(1)?.notes.filter((note) => !note.rest).map((note) => note.pitch).sort((a, b) => a - b) ?? [],
    text: app.getText(),
  };
});
const expectCursor = async (label, part, offset, lane, placeholder) => {
  const actual = await state();
  assert.deepEqual([actual.part, actual.measure, actual.offset, actual.lane, actual.placeholder],
    [part, 0, offset, lane, placeholder], `${label}: ${JSON.stringify(actual)}`);
  return actual;
};

try {
  const testUrl = process.env.APP_TEST_URL || `http://127.0.0.1:${server.address().port}/`;
  await page.goto(testUrl, { waitUntil: "networkidle" });
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setCodePaneCollapsed(true);
    app.setText(text);
    app.setRhythmEditDivision(16);
    app.resetDocumentUndo();
  }, fixture);
  const firstPoint = await page.evaluate(() => {
    const app = window.__app;
    const source = app._sourceNotes.find((item) => item.partIndex === 0
      && item.chord.position.toString() === "0" && !item.note.rest);
    const element = source && app.painter.noteGroupEls(source.chord, source.note)[0]?.element.querySelector("text");
    const rect = element?.getBoundingClientRect();
    return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
  });
  assert(firstPoint, "top staff's first note is missing");
  await page.mouse.click(firstPoint.x, firstPoint.y);
  await page.locator("#btn-input-mode").click();
  const initial = await expectCursor("select top note", 0, "0", "rest", 0);
  assert.equal(initial.upper.length, 1);
  assert.equal(initial.lower.length, 1);

  await page.keyboard.press("ArrowDown");
  await expectCursor("first lower slot", 0, "0", "below", 1);
  await page.keyboard.press("ArrowDown");
  await expectCursor("unfilled lower slot crosses to the next row", 1, "0", "rest", 0);
  await page.mouse.click(firstPoint.x, firstPoint.y);
  await expectCursor("return to the upper note", 0, "0", "rest", 0);
  await page.keyboard.press("ArrowDown");
  await expectCursor("first lower slot again", 0, "0", "below", 1);
  await page.keyboard.press("3");
  const two = await expectCursor("first lower tone", 0, "0", "rest", 0);
  assert.equal(two.upper.length, 2, two.text);
  assert.deepEqual(two.lower, initial.lower, "editing the upper row changed the lower row");

  await page.keyboard.press("ArrowDown");
  await expectCursor("second lower slot", 0, "0", "below", 1);
  await page.keyboard.press("5");
  const three = await expectCursor("second lower tone", 0, "0", "rest", 0);
  assert.equal(three.upper.length, 3, three.text);
  assert.deepEqual(three.lower, initial.lower);

  await page.keyboard.press("ArrowDown");
  await expectCursor("third lower slot", 0, "0", "below", 1);
  for (let step = 0; step < 4; step++) await page.keyboard.press("ArrowUp");
  await expectCursor("upper slot after traversing chord", 0, "0", "above", 1);
  await page.keyboard.press("7");
  const four = await expectCursor("new upper tone", 0, "0", "rest", 0);
  assert.equal(four.upper.length, 4, four.text);
  assert.deepEqual(four.lower, initial.lower);
  await page.keyboard.press("ArrowUp");
  await expectCursor("next upper slot", 0, "0", "above", 1);
  await page.keyboard.press("2");
  const five = await expectCursor("second upper tone", 0, "0", "rest", 0);
  assert.equal(five.upper.length, 5, five.text);
  assert.deepEqual(five.lower, initial.lower);

  await page.evaluate(() => window.__app.view.focus());
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await page.waitForFunction(() => window.__app.painter.score.parts[0].measures[0].entries
    .find((entry) => entry.notes?.length && !entry.rest && entry.position.toString() === "0")?.notes
    .filter((note) => !note.rest).length === 4);
  assert.deepEqual((await state()).lower, initial.lower, "undo changed the other row");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+y");
  await page.waitForFunction(() => window.__app.painter.score.parts[0].measures[0].entries
    .find((entry) => entry.notes?.length && !entry.rest && entry.position.toString() === "0")?.notes
    .filter((note) => !note.rest).length === 5);
  assert.deepEqual((await state()).upper, five.upper, "redo did not restore the chord");

  // Empty rhythmic columns still use ArrowDown/ArrowUp to switch score rows.
  await page.evaluate(() => {
    const app = window.__app;
    app.scorePane.focus({ preventScroll: true });
    app._input.setCursor(app.painter.score, {
      partIndex: 0, measureIndex: 0, offset: app.painter.score.parts[0].measures[0].entries[0].position,
      division: 16, lane: "rest", verticalIndex: 0,
    });
    app.renderInputCursor();
  });
  await page.keyboard.press("ArrowRight");
  await expectCursor("empty column", 0, "1/4", "rest", 0);
  await page.keyboard.press("ArrowDown");
  await expectCursor("switch to lower row at empty column", 1, "1/4", "rest", 0);
  await page.keyboard.press("ArrowUp");
  await expectCursor("return to upper row at empty column", 0, "1/4", "rest", 0);

  // Keyboard TXT is the default editable format. Reuse the two-row source
  // through the real JPW -> keyboard conversion and exercise the same input
  // gesture without duplicating the full JPW undo/redo sequence.
  await page.evaluate(async (text) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    await app.changeDocumentFormat("keyboard");
    app.setRhythmEditDivision(16);
  }, fixture);
  const keyboardReady = await page.evaluate(() => ({
    format: window.__app.documentFormat,
    voices: window.__app.slashOptions?.voiceCount,
    parts: window.__app.painter.score.parts.length,
  }));
  assert.deepEqual(keyboardReady, { format: "keyboard", voices: 2, parts: 2 });
  const keyboardPoint = await page.evaluate(() => {
    const app = window.__app;
    const source = app._sourceNotes.find((item) => item.partIndex === 0
      && item.chord.position.toString() === "0" && !item.note.rest);
    const text = source && app.painter.noteGroupEls(source.chord, source.note)[0]?.element.querySelector("text");
    const rect = text?.getBoundingClientRect();
    return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
  });
  assert(keyboardPoint, "converted keyboard score has no selectable top-row note");
  await page.mouse.click(keyboardPoint.x, keyboardPoint.y);
  await page.locator("#btn-input-mode").click();
  const keyboardInitial = await expectCursor("keyboard top note", 0, "0", "rest", 0);
  await page.keyboard.press("ArrowDown");
  await expectCursor("keyboard first lower slot", 0, "0", "below", 1);
  await page.keyboard.press("3");
  assert.equal((await state()).upper.length, 2);
  await page.keyboard.press("ArrowDown");
  await expectCursor("keyboard second lower slot", 0, "0", "below", 1);
  await page.keyboard.press("5");
  const keyboardResult = await expectCursor("keyboard second lower tone", 0, "0", "rest", 0);
  assert.equal(keyboardResult.upper.length, 3, keyboardResult.text);
  assert.deepEqual(keyboardResult.lower, keyboardInitial.lower);
  assert(keyboardResult.text.includes("键盘谱"), "keyboard input changed the document format");

  assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`);
  console.log("vertical-chord-input-check: ok (repeat lower/upper entry, undo/redo, row navigation, keyboard TXT)");
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
