// Actual settings UI: hiding explicit rests intentionally fills internal silence.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const server = createServer(async (request, response) => {
  try {
    const file = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const path = file === "/" ? "/index.html" : file;
    response.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript",
      ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2" })[extname(path)] ?? "application/octet-stream");
    response.end(await readFile(join(process.cwd(), "dist", path)));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const seed = async (kind, text, sourceTimedRows = false) => {
  await page.evaluate(({ kind, text, sourceTimedRows }) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = kind;
    app.slashOptions = { kind, voiceCount: 1, instrumentName: "钢琴", title: "休止设置",
      subtitle: "", composer: "", arranger: "", lyricist: "", tempoBpm: 90, fifths: 0,
      beats: 4, beatType: 4, symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: null, wholeMeasureGroups: false, showExplicitRests: true,
      braceMode: "arpeggio", bracketMode: "triplet", parenMode: "chord", angleMode: "grace", barMode: "none",
      sourceTimedRows, ...(sourceTimedRows ? { adjacentAsChord: true } : {}) };
    app.setText(text); app.resetDocumentUndo();
  }, { kind, text, sourceTimedRows });
};
const snapshot = () => page.evaluate(() => {
  const app = window.__app;
  return { text: app.getText(), rests: app.slashOptions.showExplicitRests,
    options: JSON.stringify(app.slashOptions), revision: app.getStaffEditorState().revision,
    status: document.getElementById("status").textContent,
    attacks: app.painter.score.parts.flatMap((part, partIndex) => part.measures.flatMap(measure => measure.entries
      .filter(entry => entry.notes && !entry.rest && entry.notes.some(note => !note.rest && !note.tiePrev))
      .flatMap(entry => entry.notes.filter(note => !note.rest && !note.tiePrev).map(note => {
        let tail = note; const seen = new Set();
        while (tail.tieNext && !seen.has(tail)) { seen.add(tail); tail = tail.tieNext; }
        return { part: partIndex, pitch: note.pitch, at: measure.position.plus(entry.position).toFloat(),
          end: tail.chord.measure.position.plus(tail.chord.position).plus(tail.chord.duration).toFloat() };
      })))) };
});
async function settings(rests, division) {
  await page.evaluate(() => { void window.__app.showScoreSettings(); });
  await page.locator(".inspector-content summary").filter({ hasText: "时值与括号规则" }).click();
  const row = page.locator(".inspector-content label.modal-row").filter({ has: page.locator("span", { hasText: "保留 0 休止符" }) });
  await row.locator('input[type="checkbox"]').setChecked(rests);
  if (division) await page.locator(".inspector-content .slash-symbol-row select").first().selectOption(String(division), { force: true });
  await page.getByRole("button", { name: "应用到当前乐谱", exact: true }).click();
}
try {
  await page.goto(process.env.CHECK_BASE_URL ?? `http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  for (const kind of ["keyboard", "number"]) {
    const heading = kind === "keyboard" ? "键盘谱" : "数字谱";
    const [a, b] = kind === "keyboard" ? ["A", "B"] : ["1", "2"];
    const text = `${heading}\n0..../${a}..../0..../${b}..../\n`;
    await seed(kind, text);
    const before = await snapshot();
    assert.deepEqual(before.attacks.map(note => [note.at, note.end]), [[1, 2], [3, 4]]);
    await settings(false);
    const hidden = await snapshot();
    assert.equal(hidden.rests, false, `${kind}: disabling rest preservation failed: ${hidden.status}`);
    assert.deepEqual(hidden.attacks.map(note => [note.at, note.end]), [[1, 3], [3, 4]], "only internal silence should be filled");
    assert.deepEqual(hidden.attacks.map(note => note.pitch), before.attacks.map(note => note.pitch));
    assert(hidden.text.includes("0...."), "leading silence must remain explicit");
    await page.evaluate(() => window.__app.undoEdit());
    await page.waitForFunction(text => window.__app.getText() === text && window.__app.slashOptions.showExplicitRests === true, text);
    await page.waitForFunction(() => window.__app.painter.score.parts[0].measures[0].entries
      .some(entry => entry.notes && !entry.rest && entry.position.equals(1) && entry.duration.equals(1)
        && entry.notes.every(note => !note.tieNext)));
    assert.deepEqual((await snapshot()).attacks, before.attacks, "one undo restores the explicit-rest timeline");
    await page.evaluate(() => window.__app.redoEdit());
    await page.waitForFunction(() => window.__app.slashOptions.showExplicitRests === false);
    await page.evaluate(() => window.__app.reload(window.__app.getText()));
    assert.deepEqual((await snapshot()).attacks, hidden.attacks, "hidden-rest score must survive save/reload");
    await settings(true);
    assert.equal((await snapshot()).rests, true, "rest preservation can be enabled again");
  }
  await seed("keyboard", "键盘谱\nA.0.../B..0../C...0./D..../\n");
  await settings(false, 32);
  const fineRests = await snapshot();
  assert.equal(fineRests.rests, false, fineRests.status);
  assert.deepEqual(fineRests.attacks.map(note => [note.at, note.end]), [[0, 1], [1, 2], [2, 3], [3, 4]],
    "quarter-, half- and three-quarter-beat gaps are filled without shifting attacks");
  await page.evaluate(async () => {
    const app = window.__app;
    app.documentFormat = "jpw"; app.slashOptions = null;
    app.loadText(".Title\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V1\n0 1 0 2 |]\n.Voice.Piano.V2\n5 0 0 0 |]\n", "two-voice-rest.jpwabc");
    await app.changeDocumentFormat("keyboard"); app.resetDocumentUndo();
  });
  const voices = await snapshot();
  await settings(false);
  const hiddenVoices = await snapshot();
  assert.equal(hiddenVoices.rests, false, hiddenVoices.status);
  assert.deepEqual(hiddenVoices.attacks.map(note => [note.part, note.at, note.pitch]),
    voices.attacks.map(note => [note.part, note.at, note.pitch]), "voice ownership and attack positions stay fixed");
  assert.deepEqual(hiddenVoices.attacks.map(note => [note.part, note.at, note.end]), [[0, 1, 3], [0, 3, 4], [1, 0, 4]]);
  // Symbol changes still undergo exact timing checks; hiding rests is not a bypass.
  await seed("keyboard", "键盘谱\nA.B.../0..../0..../0..../\n");
  const beforeCoarse = await snapshot();
  await settings(false, 4);
  const coarse = await snapshot();
  assert.equal(coarse.text, beforeCoarse.text);
  assert.equal(coarse.options, beforeCoarse.options);
  assert.equal(coarse.revision, beforeCoarse.revision);
  assert(coarse.status.includes("不能精确保留"), "a truly unrepresentable onset must still explain the precision error");
  // Literal imported rows use their existing clock, then materialize the chosen rest policy.
  await seed("keyboard", "键盘谱\nA....0....B....0..../\n", true);
  assert.deepEqual((await snapshot()).attacks.map(note => [note.at, note.end]), [[0, 1], [2, 3]]);
  await settings(false);
  const literal = await snapshot();
  assert.equal(literal.rests, false, literal.status);
  assert.deepEqual(literal.attacks.map(note => [note.at, note.end]), [[0, 2], [2, 4]]);
  await page.evaluate(() => window.__app.undoEdit());
  await page.waitForFunction(() => window.__app.slashOptions.sourceTimedRows === true
    && window.__app.getText() === "键盘谱\nA....0....B....0..../\n");
  await page.evaluate(() => window.__app.reload(window.__app.getText()));
  assert.deepEqual((await snapshot()).attacks.map(note => [note.at, note.end]), [[0, 1], [2, 3]],
    "literal-row undo restores the original source clock");
  assert.deepEqual(errors, []);
  console.log("rest settings: disabling/enabling, leading silence, undo/redo, reload, exact precision rejection and literal rows passed");
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
