import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
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

const z = "\u2063";
const source = `键盘谱\n4/4拍：\n点=16分音符\n(V${z}D${z}G).${z}A.${z}N.(${z}D${z}G)./.${z}A.${z}N.${z}A./(B${z}D${z}G).${z}A.${z}N.(${z}D${z}G)./.${z}N.${z}A.${z}N./\n`;
const sameRangeSource = `键盘谱\n4/4拍：\n点=16分音符\n${`(V${z}A).(W${z}S).(Y${z}D).(V${z}F)./`.repeat(4)}\n`;
const snapshot = () => page.evaluate(() => {
  const app = window.__app;
  const rows = app.painter.score.parts.map((part) => part.measures[0].entries
    .filter((entry) => entry.notes?.length && (!entry.rest || entry.notes.some((note) => note.tuplet)))
    .map((entry) => ({
      at: entry.position.toString(), end: entry.position.plus(entry.duration).toString(),
      pitches: entry.notes.filter((note) => !note.rest).map((note) => note.pitch).sort((a, b) => a - b),
      tuplet: entry.notes.some((note) => note.tuplet),
    }))
    .sort((a, b) => Number(a.at.split("/")[0]) / Number(a.at.split("/")[1] ?? 1)
      - Number(b.at.split("/")[0]) / Number(b.at.split("/")[1] ?? 1)));
  return { text: app.getText(), rows,
    marks: document.querySelectorAll("#score-pane .tuplet-number").length,
    diagnostics: app._slashTimingDiagnostics.filter((item) => item.severity === "error") };
});
const createAt = async (part, offset) => {
  const point = await page.evaluate(({ part, offset }) => {
    const app = window.__app;
    const source = app._sourceNotes.find((item) => item.partIndex === part
      && item.chord.position.toString() === offset && !item.note.rest);
    if (!source) return null;
    const box = app.painter.noteGroupEls(source.chord, source.note)[0].element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, { part, offset });
  assert(point, `missing note at voice ${part + 1}, ${offset}`);
  await page.mouse.click(point.x, point.y);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.getByRole("menuitem", { name: "在光标处创建三连音", exact: true }).click();
  await page.waitForTimeout(250);
};
const assertClean = (state, label) => {
  assert.equal(state.diagnostics.length, 0, `${label}: ${JSON.stringify(state.diagnostics)}\n${state.text}`);
  assert.equal(state.marks,
    label === "initial" ? 0 : label === "second voice" || label === "undo" ? 1 : 2,
    `${label}: expected a separate visible 3 above each distinct voice span`);
  assert.equal(state.rows[0].filter((row) => row.tuplet).length,
    label === "first voice" || label === "redo" || label === "reload" ? 3 : 0,
    `${label}: voice 1 members`);
  assert.equal(state.rows[1].filter((row) => row.tuplet).length,
    label === "initial" ? 0 : 3,
    `${label}: voice 2 members`);
};

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = { kind: "keyboard", voiceCount: 2, instrumentName: "钢琴",
      title: "键盘谱", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, spaceDivision: null, noteDivision: null,
      braceMode: "chord", parenMode: "chord", bracketMode: "triplet" };
    app.setText(text);
    app.setInputMode(true);
  }, source);
  await page.waitForTimeout(250);
  const initial = await snapshot();
  assertClean(initial, "initial");
  await createAt(1, "0");
  const second = await snapshot();
  assertClean(second, "second voice");
  assert.deepEqual(second.rows[1].filter((row) => row.tuplet), [
    { at: "0", end: "2/3", pitches: [53], tuplet: true },
    { at: "2/3", end: "4/3", pitches: [], tuplet: true },
    { at: "4/3", end: "2", pitches: [], tuplet: true },
  ], "second voice triplet timing");
  assert.deepEqual(second.rows[0], initial.rows[0], "second voice edit changed first voice");
  await createAt(0, "1/4");
  const both = await snapshot();
  assertClean(both, "first voice");
  const screenshot = join(tmpdir(), "overlapping-tuplet-two-marks.png");
  await page.screenshot({ path: screenshot });
  assert.deepEqual(both.rows[0].filter((row) => row.tuplet), [
    { at: "1/4", end: "1/3", pitches: [60], tuplet: true },
    { at: "1/3", end: "5/12", pitches: [], tuplet: true },
    { at: "5/12", end: "1/2", pitches: [], tuplet: true },
  ], "first voice triplet timing");
  assert.deepEqual(both.rows[0].filter((row) => !row.tuplet),
    initial.rows[0].filter((row) => row.at !== "1/4"), "first voice edit changed other notes");
  assert.deepEqual(both.rows[1], second.rows[1], "first voice edit changed second voice");
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForTimeout(250);
  const undone = await snapshot();
  assertClean(undone, "undo");
  assert.deepEqual(undone.rows, second.rows, "undo did not restore second voice state");
  await page.keyboard.press("ControlOrMeta+y");
  await page.waitForTimeout(250);
  const redone = await snapshot();
  assertClean(redone, "redo");
  assert.deepEqual(redone.rows, both.rows, "redo changed tuplet members");
  await page.evaluate((text) => window.__app.setText(text), redone.text);
  await page.waitForTimeout(250);
  const reloaded = await snapshot();
  assertClean(reloaded, "reload");
  assert.deepEqual(reloaded.rows, both.rows, "reload changed tuplet members");

  await page.evaluate((text) => window.__app.setText(text), sameRangeSource);
  await page.waitForTimeout(250);
  await createAt(1, "0");
  await createAt(0, "0");
  const sameRange = await snapshot();
  assert.equal(sameRange.diagnostics.length, 0, JSON.stringify(sameRange.diagnostics));
  assert.equal(sameRange.rows[0].filter((row) => row.tuplet).length, 3,
    "same-range voice 1 lost members");
  assert.equal(sameRange.rows[1].filter((row) => row.tuplet).length, 3,
    "same-range voice 2 lost members");
  assert.equal(sameRange.marks, 1,
    `identical voice ranges should share one 3: ${sameRange.text}`);
  assert.equal(errors.length, 0, `browser errors: ${errors.join("; ")}`);
  console.log(`overlapping-tuplet-check browser: ok (two distinct marks, same-range dedupe; ${screenshot})`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
