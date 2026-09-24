import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm",
};
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
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const source = `键盘谱\n4/4拍：\n点=16分音符\n(V⁣G).⁣W.⁣Y.(A⁣W)./.(V⁣W).A.⁣W./B.⁣Q.⁣U.(M⁣J)./.(B⁣Q).M.⁣J./\n`;
const snapshot = () => page.evaluate(() => {
  const app = window.__app;
  const rows = app.painter.score.parts.flatMap((part, partIndex) => part.measures
    .slice(0, 4).flatMap((measure, measureIndex) => measure.entries
      .filter((entry) => entry.notes?.length)
      .map((entry) => ({
        part: partIndex, measure: measureIndex, at: entry.position.toString(),
        dur: entry.duration?.toString(), rest: entry.rest,
        nums: entry.notes.map((note) => note.number).join(""),
        beams: entry.beams, dot: entry.dot,
        tuple: entry.notes.some((note) => note.tuplet),
      }))));
  return { text: app.getText(), rows, diagnostics: document.querySelectorAll("#score-pane .diagnostic-box").length };
});
const positionValue = (value) => {
  const [numerator, denominator = "1"] = value.split("/");
  return Number(numerator) / Number(denominator);
};
const stableRows = (state) => state.rows.filter((row) =>
  row.part !== 1 || row.measure !== 0 || positionValue(row.at) >= 0.75);
const tupleRows = (state) => state.rows.filter((row) => row.part === 1 && row.measure === 0 && row.tuple);
const checkShape = (state, label) => {
  const tuples = tupleRows(state);
  assert(tuples.length === 3, `${label}: expected 3 tuple members: ${JSON.stringify(state.rows)}`);
  assert(tuples.map((row) => row.at).join(",") === "0,1/6,1/3", `${label}: bad tuple positions`);
  assert(tuples.every((row) => row.dur === "1/6" && row.dot === 0 && row.beams === 2), `${label}: bad tuple spelling`);
  assert(state.rows.some((row) => row.part === 1 && row.measure === 0 && row.at === "1/2" && row.dur === "1/4" && row.rest), `${label}: V2 half-beat rest missing: ${JSON.stringify(state)}`);
  assert(state.diagnostics === 0, `${label}: diagnostics=${state.diagnostics}`);
};

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  for (const showExplicitRests of [true, false]) {
    await page.evaluate(({ text, show }) => {
      const app = window.__app;
      app.documentFormat = "keyboard";
      app.slashOptions = {
        kind: "keyboard", voiceCount: 2, instrumentName: "钢琴", title: "dotted-triplet",
        subtitle: "", composer: "", arranger: "", lyricist: "", tempoBpm: 90,
        tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
        symbolDurations: { ".": 16 }, spaceDivision: null, noteDivision: null,
        braceMode: "arpeggio", bracketMode: "triplet", showExplicitRests: show,
      };
      app.setText(text);
      app.setInputMode(true);
    }, { text: source, show: showExplicitRests });
    await page.waitForTimeout(250);
    const baseline = await snapshot();
    const loaded = await page.evaluate(() => {
      const app = window.__app;
      const v = app._sourceNotes.find((item) => app.getText().slice(item.from, item.to) === "V");
      return { parts: app.painter.score.parts.length, vPart: v?.partIndex ?? null };
    });
    assert(loaded.parts === 2 && loaded.vPart === 1, `baseline load failed: ${JSON.stringify(loaded)}`);
    const untouched = stableRows(baseline);
    const point = await page.evaluate(() => {
      const app = window.__app;
      const v = app._sourceNotes.find((item) => app.getText().slice(item.from, item.to) === "V" && item.partIndex === 1);
      const box = app.painter.noteGroupEls(v.chord, v.note)[0].element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.click(point.x, point.y);
    await page.mouse.click(point.x, point.y, { button: "right" });
    await page.getByRole("menuitem", { name: "在光标处创建三连音", exact: true }).click();
    await page.waitForTimeout(250);
    const created = await snapshot();
    checkShape(created, `create rests=${showExplicitRests}`);
    assert(JSON.stringify(stableRows(created)) === JSON.stringify(untouched), "creation changed other voice/measure data");

    const third = await page.evaluate(() => {
      const app = window.__app; const svg = document.querySelector("#score-pane svg");
      const span = app.painter.rhythmInputSpansForPage(0, svg).find((item) => item.measureIndex === 0 && item.partIndexes.includes(1));
      const group = span?.tupletGroups.find((item) => item.partIndex === 1);
      const row = span?.partRows.find((item) => item.partIndex === 1);
      const anchor = group?.anchors.at(-1); const matrix = svg?.getScreenCTM();
      if (!anchor || !row || !matrix) return null;
      const point = new DOMPoint(anchor.x, (row.yTop + row.yBottom) / 2).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    });
    assert(third, "third member hit target missing");
    await page.mouse.click(third.x, third.y); await page.keyboard.press("1"); await page.waitForTimeout(180);
    let edited = await snapshot(); checkShape(edited, "input 1");
    assert(tupleRows(edited)[2].rest === false && tupleRows(edited)[2].nums.includes("1"), "input 1 did not fill third cell");
    await page.keyboard.press("2"); await page.waitForTimeout(180); edited = await snapshot(); checkShape(edited, "input 2");
    assert(tupleRows(edited)[2].nums.includes("2"), "input 2 did not replace third cell");
    await page.keyboard.press("Delete"); await page.waitForTimeout(180); const deleted = await snapshot(); checkShape(deleted, "delete");
    assert(tupleRows(deleted)[2].rest, "delete did not restore third rest");
    await page.keyboard.press("Control+z"); await page.waitForTimeout(300); const undone = await snapshot(); checkShape(undone, "undo");
    assert(tupleRows(undone)[2].nums.includes("2") && !tupleRows(undone)[2].rest, "undo did not restore 2");
    await page.keyboard.press("Control+y"); await page.waitForTimeout(300); const redone = await snapshot(); checkShape(redone, "redo");
    assert(tupleRows(redone)[2].rest, "redo did not restore delete");
    assert(JSON.stringify(stableRows(redone)) === JSON.stringify(untouched), "edit changed other voice/measure data");
    const saved = redone.text;
    await page.evaluate((text) => window.__app.setText(text), saved); await page.waitForTimeout(250);
    const reloaded = await snapshot(); checkShape(reloaded, "reload");
    assert(JSON.stringify(stableRows(reloaded)) === JSON.stringify(untouched), "reload changed other voice/measure data");
    await page.screenshot({ path: join(process.env.TEMP ?? process.cwd(), `dotted-triplet-${showExplicitRests}.png`) });
    console.log(JSON.stringify({ showExplicitRests, loaded, tuple: tupleRows(reloaded), stableCount: stableRows(reloaded).length }));
  }
  assert(errors.length === 0, `browser errors: ${errors.join("; ")}`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
