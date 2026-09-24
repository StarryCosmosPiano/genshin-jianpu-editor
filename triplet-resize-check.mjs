import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(await readFile(join(root, normalize(file))));
  } catch { response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const z = "\u2063";
const snapshot = () => page.evaluate(() => {
  const app = window.__app;
  return {
    text: app.getText(), diagnostics: document.querySelectorAll("#score-pane .diagnostic-box").length,
    rows: app.painter.score.parts.flatMap((part, partIndex) => part.measures.flatMap((measure, measureIndex) =>
      measure.entries.filter((entry) => entry.notes?.length).map((entry) => ({
        part: partIndex, measure: measureIndex, at: entry.position.toFloat(),
        duration: entry.duration?.toString(), rest: entry.rest,
        pitches: entry.notes.filter((note) => !note.rest).map((note) => note.pitch),
        tuplet: entry.notes.some((note) => note.tuplet), beams: entry.beams, dot: entry.dot,
      })))),
  };
});
const untouched = (state) => state.rows.filter((row) => row.part !== 1 || row.measure !== 0 || row.at >= 0.5);
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  for (const last of ["A", "0"]) for (const showExplicitRests of [true, false]) {
    const text = `键盘谱\n4/4拍：\n点=16分音符\n[(${z.repeat(2)}V${z}G).${z.repeat(2)}0.${z}W${z.repeat(2)}${last}.](D${z}Y).(A${z}W)./.(V${z}W).A.${z}W./B.${z}Q.${z}U.(M${z}J)./.(B${z}Q).M.${z}W./\n`;
    await page.evaluate(({ text, showExplicitRests, last }) => {
      const app = window.__app;
      app.documentFormat = "keyboard";
      app.slashOptions = {
        kind: "keyboard", voiceCount: 2, instrumentName: "钢琴", title: "三连音与正拍混合",
        subtitle: "", composer: "", arranger: "", lyricist: "", tempoBpm: 90,
        fifths: 0, beats: 4, beatType: 4, symbolDurations: { ".": 16 },
        spaceDivision: null, noteDivision: null, braceMode: "arpeggio", bracketMode: "triplet",
        showExplicitRests, annotations: [{ type: "triplet", part: 1, voice: 2, measure: 0,
          offset: 0, end: 0.5, scope: "voice", members: [0.25, 0.25, 0.25],
          memberRests: [false, true, last === "0"], restoreUnit: 0.5,
          ordinary: [{ part: 0, offset: 0, duration: 0.25, rest: false },
            { part: 0, offset: 0.25, duration: 0.25, rest: false }],
        }],
      };
      app.setText(text + `\n// @jpeditor ${JSON.stringify({
        v: 2, vc: 2, k: "k", s: { ".": 16 }, nd: null, sp: null, q: "t", b: "a",
        ri: showExplicitRests, an: app.slashOptions.annotations,
      })}\n`);
      app.setInputMode(true);
    }, { text, showExplicitRests, last });
    await page.waitForTimeout(300);
    const before = await snapshot();
    assert.equal(before.diagnostics, 0);
    const point = await page.evaluate(() => {
      const app = window.__app;
      const item = app._sourceNotes.find((source) => app.getText().slice(source.from, source.to) === "V" && source.partIndex === 1);
      const box = app.painter.noteGroupEls(item.chord, item.note)[0].element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.click(point.x, point.y);
    await page.keyboard.press("Control+ArrowRight");
    await page.waitForTimeout(300);
    const after = await snapshot();
    assert.equal(after.diagnostics, 0);
    assert.deepEqual(untouched(after), untouched(before));
    const tuples = after.rows.filter((row) => row.part === 1 && row.tuplet);
    assert.deepEqual(tuples.map((row) => [row.at, row.duration, row.beams, row.dot]),
      [[0, "1/3", 1, 0], [1 / 3, "1/6", 2, 0]]);
    assert.equal(tuples[1].rest, last === "0");
    const bracket = after.text.match(/\[[^\]\r\n]*\]/)?.[0].replaceAll(z, "");
    assert.equal(bracket, `[(VG)..W${last}.]`, after.text);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    assert.deepEqual((await snapshot()).rows, before.rows);
    await page.keyboard.press("Control+y");
    await page.waitForTimeout(300);
    assert.deepEqual((await snapshot()).rows, after.rows);
    await page.evaluate((saved) => window.__app.setText(saved), after.text);
    await page.waitForTimeout(300);
    assert.deepEqual((await snapshot()).rows, after.rows);
    if (last === "A" && showExplicitRests) await page.screenshot({ path: join(process.env.TEMP ?? process.cwd(), "triplet-resize-check.png") });
  }
  assert.deepEqual(errors, []);
  console.log("triplet-resize-check: ok (Ctrl+Right, mixed text, independent timing, undo/redo)");
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
