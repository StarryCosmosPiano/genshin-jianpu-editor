import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(await readFile(join(process.cwd(), "dist", normalize(file))));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

async function notePoint(at, number) {
  return page.evaluate(({ at, number }) => {
    const app = window.__app;
    const source = app._sourceNotes.find((item) => item.partIndex === 0
      && item.chord.position.toString() === at && item.note.number === number);
    if (!source) throw new Error(`missing note ${number} at ${at}`);
    const element = app.painter.noteGroupEls(source.chord, source.note)[0].element;
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    // Use the actual glyph's tight model rectangle, transformed by its SVG
    // matrix. A group's DOM box can include an attached ornament or dot.
    const item = app.painter.pageItemForTarget(element);
    const bound = item.bound;
    const matrix = element.getScreenCTM();
    const point = new DOMPoint((bound.left + bound.right) / 2,
      (bound.top + bound.bottom) / 2).matrixTransform(matrix);
    return { x: point.x, y: point.y, pitch: source.note.pitch };
  }, { at, number });
}

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(".Title\nTitle = {精确点击}\nKeyAndMeters = {1=C,4/4}\n.Voice\n[135] 2 3 4 |]\n");
    app.setCodePaneCollapsed(true);
    app.setInputMode(true);
  });
  let point = await notePoint("1", "2");
  await page.mouse.click(point.x, point.y);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.getByRole("menuitem", { name: "在光标处创建三连音", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("#score-pane .tuplet-number").length === 1);
  const originalText = await page.evaluate(() => window.__app.getText());

  for (const zoom of [0.6, 1, 1.6]) {
    await page.evaluate((value) => window.__app.setZoom(value), zoom);
    for (const input of [false, true]) {
      await page.evaluate((value) => window.__app.setInputMode(value), input);
      // Three chord tones, both ordinary notes after the triplet, and the
      // triplet's own first member must all select their exact visible pitch.
      for (const [at, number] of [["0", "5"], ["0", "1"], ["0", "3"], ["2", "3"], ["3", "4"], ["1", "2"]]) {
        point = await notePoint(at, number);
        await page.mouse.click(point.x, point.y);
        const actual = await page.evaluate(() => {
          const app = window.__app;
          const selected = app._selectedNotes.at(-1);
          return { at: selected?.visualNote.chord.position.toString(), pitch: selected?.visualNote.pitch,
            objects: app._selectedObjects.length, cursor: app._input.cursor?.offset.toString(),
            selection: [app.view.state.selection.main.from, app.view.state.selection.main.to],
            source: selected && [selected.source.from, selected.source.to] };
        });
        assert.equal(actual.at, at, JSON.stringify({ zoom, input, at, number, actual }));
        assert.equal(actual.pitch, point.pitch);
        assert.equal(actual.objects, 0);
        assert.deepEqual(actual.selection, actual.source);
        if (input) assert.equal(actual.cursor, at, "ordinary note was pulled into the triplet ruler");
      }
    }
  }
  assert.equal(await page.evaluate(() => window.__app.getText()), originalText, "clicking changed the score");
  assert.deepEqual(errors, []);
  console.log("input-picking-check: ok (chord tones, triplet and ordinary pitches, 3 zooms, both modes)");
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
