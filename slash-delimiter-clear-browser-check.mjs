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
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("dialog", async dialog => dialog.dismiss());
const seed = async (text, own = null) => {
  await page.evaluate(({ text, own }) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = { kind: "keyboard", voiceCount: 1, instrumentName: "钢琴", title: "括号规则",
      subtitle: "", composer: "", arranger: "", lyricist: "", tempoBpm: 90, fifths: 0,
      beats: 4, beatType: 4, symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: own, wholeMeasureGroups: false,
      braceMode: "arpeggio", bracketMode: "triplet", parenMode: "chord", angleMode: "grace", barMode: "none" };
    app.setText(text);
    app.resetDocumentUndo();
  }, { text, own });
};
const changeRule = async (label, value, division) => {
  await page.evaluate(() => { void window.__app.showScoreSettings(); });
  await page.locator(".inspector-content summary").filter({ hasText: "时值与括号规则" }).click();
  const row = page.locator(".inspector-content label.modal-row").filter({ has: page.locator("span", { hasText: label }) });
  await row.locator("select").selectOption(value);
  if (division) await page.locator(".inspector-content .slash-symbol-row select").first().selectOption(String(division), { force: true });
  await page.getByRole("button", { name: "应用到当前乐谱", exact: true }).click();
};
try {
  await page.goto(process.env.CHECK_BASE_URL ?? `http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app?.painter.score);
  const chordText = "键盘谱\n(AB)..../..../..../..../\n";
  await seed(chordText);
  await changeRule("圆括号 ()", "none");
  await page.waitForFunction(() => window.__app.slashOptions.parenMode === "none");
  assert(await page.evaluate(() => window.__app.getText().includes("AB..../") && !window.__app.getText().includes("(AB)")),
    "settings did not remove chord delimiters automatically");
  assert(await page.evaluate(() => window.__app._sourceNotes.filter(source => !source.note.tiePrev).length === 2),
    "settings clearing did not keep both bare chord tones");
  await page.evaluate(() => { window.__app.view.focus(); window.__app.undoEdit(); });
  await page.waitForFunction(text => window.__app.getText() === text && window.__app.slashOptions.parenMode === "chord", chordText);
  await page.evaluate(() => window.__app.redoEdit());
  await page.waitForFunction(() => window.__app.slashOptions.parenMode === "none" && !window.__app.getText().includes("(AB)"));

  await seed(chordText);
  await changeRule("圆括号 ()", "none", 32);
  await page.waitForFunction(() => window.__app.slashOptions.parenMode === "none" && window.__app.slashOptions.symbolDurations["."] === 32);
  assert(await page.evaluate(() => /[AB]{2}\.{8}\//.test(window.__app.getText())),
    "simultaneous symbol change and chord clearing read the new glyphs using old durations");
  assert(await page.evaluate(() => window.__app._sourceNotes[0].chord.duration.toFloat() === 1),
    "simultaneous symbol change and chord clearing changed the original chord length");

  // This compatibility fixture declares the old half-beat span explicitly;
  // a new bare bracket instead shares one intrinsic sixteenth across the group.
  await seed("键盘谱\n[ABC]/..../..../..../\n// @jpeditor " + JSON.stringify({
    annotations: [{ type: "triplet", part: 0, voice: 1, measure: 0, offset: 0,
      end: .5, scope: "all", members: [.25, .25, .25], restoreUnit: .5 }],
  }), 16);
  await changeRule("方括号 []", "none");
  await page.waitForFunction(() => window.__app.slashOptions.bracketMode === "none"
    || [...document.querySelectorAll('[role="dialog"]')].some(dialog => dialog.textContent.includes("未能取消括号用途")));
  assert(await page.evaluate(() => window.__app.slashOptions.bracketMode === "none"),
    await page.locator('[role="dialog"]').allTextContents());
  assert(await page.evaluate(() => window.__app.getText().includes("A B C/")), "triplet clear did not produce ordinary sequential text");
  await page.evaluate(() => window.__app.undoEdit());
  await page.waitForFunction(() => window.__app.slashOptions.bracketMode === "triplet" && window.__app.getText().includes("[ABC]"));

  const overfull = "键盘谱\n[A.B.C.]../..../..../..../\n";
  await seed(overfull);
  const before = await page.evaluate(() => ({ text: window.__app.getText(), options: JSON.stringify(window.__app.slashOptions),
    revision: window.__app.getStaffEditorState().revision }));
  await changeRule("方括号 []", "none");
  const message = page.getByRole("dialog", { name: "未能取消括号用途", exact: true });
  await message.waitFor();
  assert((await message.textContent()).includes("腾出空间"), "overflow did not explain how to resolve the conflict");
  const after = await page.evaluate(() => ({ text: window.__app.getText(), options: JSON.stringify(window.__app.slashOptions),
    revision: window.__app.getStaffEditorState().revision }));
  assert.equal(after.text, before.text, "failed clear changed the text");
  assert.equal(after.options, before.options, "failed clear changed document settings");
  assert.equal(after.revision, before.revision, "failed clear rebuilt the score");
  await message.getByRole("button", { name: "知道了", exact: true }).click();
  await page.evaluate(() => window.__app.undoEdit());
  assert.equal(await page.evaluate(() => window.__app.getText()), overfull, "failed clear added an undo history event");
  assert.deepEqual(errors, []);
  console.log("slash delimiter settings: automatic clearing, undo/redo, sequential restoration and atomic overflow rejection passed");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
