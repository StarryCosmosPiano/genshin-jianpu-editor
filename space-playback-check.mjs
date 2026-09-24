import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(req.url.split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm" };
    res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    res.end(await readFile(join(process.cwd(), "dist", file)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setCodePaneCollapsed(true);
    app.setText(".Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 | 5 6 7 1' |]");
    app.resetDocumentUndo();
    window.__spacePlayback = { starts: [], stops: 0 };
    app._player = {
      state: "stopped", stopAudition() {}, async audition() {},
      stop() { this.state = "stopped"; window.__spacePlayback.stops++; },
      async play(score, options, start) {
        this.state = "playing";
        window.__spacePlayback.starts.push({
          sourceMatches: start?.chord === app._selectedNotes.at(-1)?.source.chord,
          measure: start?.chord.measure.index, offset: start?.chord.position.toString(),
          completeScore: score === app.painter.score && score.parts[0].measures.length === 2,
          volumes: options.partVolumes === app.partVolumes,
        });
      },
    };
  });
  const state = () => page.evaluate(() => window.__spacePlayback);
  for (const format of ["jpw", "keyboard", "number"]) {
    await page.evaluate(async format => {
      const app = window.__app;
      if (format !== app.documentFormat) await app.changeDocumentFormat(format);
      app.setInputMode(false);
    }, format);
    const target = await page.evaluate(() => {
      const app = window.__app;
      const source = app._sourceNotes.find(s => s.chord.measure.index === 0 && s.note.number === "3");
      const element = app.painter.noteGroupEls(source.chord, source.note)[0].element;
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.click(target.x, target.y);
    const text = await page.evaluate(() => window.__app.getText());
    const before = await state();
    await page.keyboard.press("Space");
    const played = await state();
    assert.equal(played.starts.length, before.starts.length + 1, `${format}: space starts playback`);
    assert.deepEqual(played.starts.at(-1), { sourceMatches: true, measure: 0, offset: "2", completeScore: true, volumes: true });
    assert.equal(await page.evaluate(() => window.__app.getText()), text);
    await page.evaluate(() => window.__app.scorePane.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", repeat: true, bubbles: true, cancelable: true })));
    assert.equal((await state()).stops, played.stops, "holding space must not stop/restart repeatedly");
    await page.keyboard.press("Space");
    assert.equal((await state()).stops, played.stops + 1, `${format}: second press stops`);

    await page.evaluate(() => {
      const app = window.__app; app.setInputMode(true); app.setInputDurationDivision(4);
      app.scorePane.focus();
    });
    const cursorBefore = await page.evaluate(() => window.__app._input.cursor.offset.toFloat());
    const startsBefore = (await state()).starts.length;
    await page.keyboard.press("Space");
    assert.equal((await state()).starts.length, startsBefore, `${format}: input mode never plays on space`);
    assert.equal(await page.evaluate(() => window.__app._input.cursor.offset.toFloat()), cursorBefore + 1,
      `${format}: input space still advances by writing duration`);
    await page.evaluate(() => window.__app.setInputMode(false));
  }
  await page.evaluate(() => {
    const app = window.__app; app.setCodePaneCollapsed(false); app.view.focus();
    app.view.dispatch({ selection: { anchor: app.view.state.doc.length } });
  });
  const beforeText = await page.evaluate(() => window.__app.getText());
  const startsBeforeText = (await state()).starts.length;
  await page.keyboard.press("Space");
  assert.equal(await page.evaluate(() => window.__app.getText()), beforeText + " ");
  assert.equal((await state()).starts.length, startsBeforeText, "text typing must not start playback");
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__app.deselect(false); window.__app.scorePane.focus(); });
  await page.keyboard.press("Space");
  assert.equal((await state()).starts.length, startsBeforeText, "no selection must not unexpectedly start from the beginning");
  assert.deepEqual(errors, []);
  console.log("space-playback: selected JPW/keyboard/number start + stop; input and text space preserved");
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
