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
  } catch { response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const assert = (condition, message) => { if (!condition) throw new Error(message); };

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.evaluate(() => window.__app.setCodePaneCollapsed(false));
  await page.evaluate(() => {
    const app = window.__app;
    app.documentFormat = "number";
    app.slashOptions = { kind: "number", voiceCount: 1, instrumentName: "钢琴",
      title: "多声部连续打谱", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4, symbolDurations: { ".": 8 },
      spaceDivision: null, noteDivision: null, braceMode: "arpeggio", bracketMode: "triplet" };
    app.setText("数字谱\n4/4拍：\n点=八分音符\n(15)../(26)../(37)../(41)../\n");
    const source = app._sourceNotes[0];
    app.view.focus();
    app.view.dispatch({ selection: { anchor: source.from, head: source.to } });
  });
  const original = await page.evaluate(() => window.__app.getText());
  await page.keyboard.press("Alt+1");
  await page.waitForFunction(() => window.__app.painter.score.parts.length === 2);
  const assigned = await page.evaluate(() => window.__app.getText());
  await page.keyboard.press("Control+z");
  await page.waitForFunction((text) => window.__app.getText() === text, original);
  await page.waitForFunction(() => window.__app.painter.score.parts.length === 1);
  assert(await page.evaluate(() => window.__app.slashOptions.voiceCount === 1), "Alt+1 undo retained two-voice settings");
  await page.keyboard.press("Control+y");
  await page.waitForFunction((text) => window.__app.getText() === text && window.__app.painter.score.parts.length === 2, assigned);

  await page.evaluate(() => {
    const app = window.__app;
    app.setSlashVoiceSettings(3, app.slashVoiceColors, true, true);
    app.view.focus();
  });
  await page.waitForFunction(() => window.__app.painter.score.parts.length === 3);
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => window.__app.painter.score.parts.length === 2);
  assert(await page.evaluate(() => window.__app.slashOptions.voiceCount === 2), "voice count undo kept three-voice settings");

  await page.evaluate(async () => {
    await window.__app.changeDocumentFormat("jpw");
    window.__app.view.focus();
  });
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => window.__app.documentFormat === "number" && window.__app.painter.score.parts.length === 2);
  assert(await page.evaluate(() => !window.__app.getText().includes(".Voice")), "format conversion undo left JPW text");
  await page.keyboard.press("Control+y");
  await page.waitForFunction(() => window.__app.documentFormat === "jpw" && window.__app.getText().includes(".Voice"));

  // The end of the score is a navigation boundary, including Space advance.
  await page.evaluate(() => {
    const app = window.__app;
    app.setText(".Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 |]");
    app.setRhythmEditDivision(16);
    app.setInputDurationDivision(4);
    app.setInputMode(true);
    const Fraction = app.painter.score.parts[0].measures[0].position.constructor;
    app._input.setCursor(app.painter.score, {
      partIndex: 0, measureIndex: 0, offset: new Fraction(15, 4), division: 16, lane: "rest",
    });
    app.scorePane.focus();
  });
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  assert(await page.evaluate(() => window.__app._input.cursor.offset.toFloat() === 3.75),
    "navigation at the end of the score wrapped to the start of the last bar");

  // Reordered sections must map a real click and input to the selected voice.
  await page.evaluate(() => {
    const app = window.__app;
    app.setInputMode(false);
    app.setText(".Title\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V2\n5 6 7 1 |]\n.Voice.Piano.V1\n1 2 3 4 |]");
    app.setInputMode(true);
  });
  const point = await page.evaluate(() => {
    const app = window.__app;
    const source = app._sourceNotes.find((note) => note.partIndex === 0 && !note.grace);
    const element = app.painter.noteGroupEls(source.chord, source.note)[0].element;
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press("7");
  await page.waitForFunction(() => window.__app.painter.score.parts[0].measures[0].entries
    .find((entry) => entry.notes?.length)?.notes[0]?.number === "7");
  assert(await page.evaluate(() => window.__app.painter.score.parts[1].measures[0].entries
    .find((entry) => entry.notes?.length)?.notes[0]?.number === "5"), "V1 editing changed the V2 pitch");

  await page.evaluate(async () => {
    const app = window.__app;
    app.setInputMode(false);
    app.setText(".Title\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V1\n{(3}1_ 2_ 3_) 0 0 0 |]\n.Voice.Piano.V2\n0--- |]");
    await app.changeDocumentFormat("number");
    const source = app._sourceNotes.find((item) => item.partIndex === 0 && item.note.number === "2" && item.note.tuplet);
    if (!source) throw new Error("missing source triplet for Alt+2 regression");
    app.view.focus();
    app.view.dispatch({ selection: { anchor: source.from, head: source.to } });
  });
  await page.keyboard.press("Alt+2");
  await page.waitForFunction(() => window.__app.painter.score.parts[1].measures[0].entries
    .some((entry) => entry.notes?.some((note) => note.number === "2" && note.tuplet)));
  const movedTriplet = await page.evaluate(() => {
    const app = window.__app;
    const chord = app.painter.score.parts[1].measures[0].entries.find((entry) => entry.notes?.some((note) => note.number === "2"));
    return { start: chord.position.toFloat(), duration: chord.duration.toFloat(),
      sourceRest: app.painter.score.parts[0].measures[0].entries.some((entry) => entry.rest && entry.position.equals(chord.position)
        && entry.notes?.some((note) => note.tuplet)), annotations: app.slashOptions.annotations };
  });
  assert(Math.abs(movedTriplet.start - 1 / 3) < 1e-8 && Math.abs(movedTriplet.duration - 1 / 3) < 1e-8
    && movedTriplet.sourceRest, `Alt+2 changed the triplet member time or source rest: ${JSON.stringify(movedTriplet)}`);

  const incompatible = `键盘谱\n4/4拍：\n点=16分音符\n[(V\u2063G).\u2063W.\u20630]N.(G\u2063W)./..../..../..../\n\n// @jpeditor {"v":2,"vc":2,"k":"k","s":{".":16},"q":"t","an":[{"type":"triplet","part":0,"voice":1,"measure":0,"offset":0.25,"scope":"voice","end":0.5,"members":[0.25,0.125],"restoreUnit":0.25},{"type":"triplet","part":1,"voice":2,"measure":0,"offset":0,"scope":"voice","end":0.5,"members":[0.25,0.25,0.25],"restoreUnit":0.5}]}\n`;
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = { ...app.slashOptions, kind: "keyboard", voiceCount: 2, braceMode: "none", symbolDurations: { ".": 16 } };
    app.setText(text);
    const source = app._sourceNotes.find((item) => item.partIndex === 0 && item.note.tuplet);
    app.view.focus();
    app.view.dispatch({ selection: { anchor: source.from, head: source.to } });
  }, incompatible);
  await page.keyboard.press("Alt+2");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("不兼容"));
  assert(await page.evaluate((text) => window.__app.getText() === text, incompatible),
    "moving between incompatible triplet grids changed the source document");

  // Merging voices must not apply an old voice's chord-0 timing edit to the
  // new voice's earlier chord-0 attack.
  const migration = await page.evaluate(() => {
    const app = window.__app;
    app.setInputMode(false);
    const options = { kind: "number", voiceCount: 3, instrumentName: "钢琴",
      title: "时值覆盖声部合并", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4, symbolDurations: { ".": 16 },
      spaceDivision: null, noteDivision: null, braceMode: "arpeggio", bracketMode: "triplet",
      showExplicitRests: true, noteTimingEdits: [{ part: 2, chord: 0, move: "1/4", duration: "0" }] };
    app.documentFormat = "number";
    app.slashOptions = options;
    app.setText(`数字谱\n4/4拍：\n点=16分音符\n\u2063\u20632..../5..../0..../0..../\n// @jpeditor ${JSON.stringify(options)}\n`);
    const attacks = () => app.painter.score.parts.flatMap((part, partIndex) => part.measures.flatMap((measure) =>
      measure.entries.flatMap((entry) => (entry.notes ?? []).filter((note) => !note.rest && !note.tiePrev)
        .map((note) => ({ part: partIndex, number: note.number, start: measure.position.plus(entry.position).toFloat() })))));
    const before = attacks();
    app.setSlashVoiceSettings(2, app.slashVoiceColors, true, true);
    return { before, after: attacks(), edits: app.slashOptions.noteTimingEdits };
  });
  assert(migration.before.some((note) => note.number === "5" && note.start === 1.25),
    `timing migration fixture was not shifted: ${JSON.stringify(migration)}`);
  assert(migration.after.some((note) => note.part === 1 && note.number === "2" && note.start === 0)
    && migration.after.some((note) => note.part === 1 && note.number === "5" && note.start === 1.25)
    && migration.edits.length === 0, `voice merge applied the timing edit to the wrong attack: ${JSON.stringify(migration)}`);

  // Loading another file establishes a new undo boundary while edits in it
  // continue to support normal undo.
  const newFile = ".Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n6 5 4 3 |]";
  await page.evaluate((text) => { window.__app.loadText(text, "new-score.jpwabc"); window.__app.view.focus(); }, newFile);
  await page.keyboard.press("Control+z");
  assert(await page.evaluate((text) => window.__app.getText() === text && window.__app.documentFormat === "jpw", newFile),
    "opening a new file retained undo history from the previous document");
  await page.evaluate(() => {
    const app = window.__app;
    const source = app._sourceNotes[0];
    app.view.dispatch({ changes: { from: source.from, to: source.to, insert: "7" } });
  });
  await page.keyboard.press("Control+z");
  assert(await page.evaluate((text) => window.__app.getText() === text, newFile), "new file lost ordinary text undo");
  await page.screenshot({ path: join(process.env.TEMP ?? process.cwd(), "notation-flow-check.png") });
  assert(errors.length === 0, `browser errors: ${errors.join("; ")}`);
  console.log("notation-flow-check: ok (voice/format undo, score-end cursor, reordered voice input, timed voice merge, new-file history)");
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
