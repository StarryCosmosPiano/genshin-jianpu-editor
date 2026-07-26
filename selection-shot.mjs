// Browser interaction regression for score picking -> CodeMirror selections ->
// keyboard pitch editing -> playback start anchor.
// Usage: npm run build && node selection-shot.mjs [out.png]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (path === "/") path = "/index.html";
    const data = await readFile(join(root, normalize(path)));
    res.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.message));

const fixture = `.Title
Title = {点选改音测试}
KeyAndMeters = {1=C,4/4}
Tempo = {96}
TempoMarks = {1@1=tempo:108}
.Voice
1 2 [3'5'] 4 | 5 6 7 1' |]
`;

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await page.evaluate((text) => window.__app.setText(text), fixture);
  await page.waitForFunction(() => document.querySelectorAll("#score-pane g.entry").length >= 8);

  const noteText = (value) => page.locator("#score-pane g.entry text").filter({ hasText: new RegExp(`^${value}$`) }).first();
  await noteText("1").click();
  let state = await page.evaluate(() => ({
    selectedSvg: document.querySelectorAll("#score-pane g.selected").length,
    source: window.__app.view.state.selection.ranges.map((range) =>
      window.__app.view.state.doc.sliceString(range.from, range.to)),
    scoreFocused: document.activeElement?.id === "score-pane",
  }));
  if (state.selectedSvg !== 1 || state.source.join("|") !== "1" || !state.scoreFocused) {
    throw new Error(`single score selection did not sync to the editor: ${JSON.stringify(state)}`);
  }

  await page.keyboard.press("5");
  await page.waitForFunction(() => /\.Voice\s+5 2/.test(window.__app.getText()));
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => /\.Voice\s+5' 2/.test(window.__app.getText()));

  await noteText("2").click({ modifiers: ["Control"] });
  state = await page.evaluate(() => ({
    selectedSvg: document.querySelectorAll("#score-pane g.selected").length,
    source: window.__app.view.state.selection.ranges.map((range) =>
      window.__app.view.state.doc.sliceString(range.from, range.to)).sort(),
    sourceHighlights: document.querySelectorAll(".cm-score-source-selection").length,
  }));
  if (state.selectedSvg !== 2 || state.source.join("|") !== "2|5'" || state.sourceHighlights < 2) {
    throw new Error(`multi-selection did not preserve both source ranges: ${JSON.stringify(state)}`);
  }

  await page.locator("#score-pane svg").first().click({
    position: { x: 4, y: 4 },
    modifiers: ["Control"],
  });
  state = await page.evaluate(() => ({
    selectedNotes: window.__app._selectedNotes.length,
    selectedSvg: document.querySelectorAll("#score-pane g.selected").length,
  }));
  if (state.selectedNotes !== 2 || state.selectedSvg !== 2) {
    throw new Error(`Ctrl-click miss cleared the existing multi-selection: ${JSON.stringify(state)}`);
  }

  await page.keyboard.press("7");
  await page.waitForFunction(() => /\.Voice\s+7' 7/.test(window.__app.getText()));
  await page.keyboard.press("Control+Z");
  await page.waitForFunction(() => /\.Voice\s+5' 2/.test(window.__app.getText()));
  await page.keyboard.press("7");
  await page.waitForFunction(() => /\.Voice\s+7' 7/.test(window.__app.getText()));

  await page.keyboard.press("Delete");
  state = await page.evaluate(() => ({
    selected: window.__app._selectedNotes.length,
    deleted: document.querySelectorAll("#score-pane g.soft-deleted").length,
    modelDeleted: window.__app._sourceNotes.filter((source) => source.note.softDeleted).length,
  }));
  if (state.selected !== 0 || state.deleted < 2 || state.modelDeleted !== 2) {
    throw new Error(`score Delete did not create restorable translucent notes: ${JSON.stringify(state)}`);
  }
  await page.keyboard.press("Control+Z");
  await page.waitForFunction(() =>
    document.querySelectorAll("#score-pane g.soft-deleted").length === 0
    && window.__app._sourceNotes.every((source) => !source.note.softDeleted));

  await noteText("7").first().click();
  await page.keyboard.press("Backspace");
  const deletedNote = page.locator("#score-pane g.soft-deleted").first();
  await deletedNote.dblclick();
  await page.waitForFunction(() => document.querySelectorAll("#score-pane g.soft-deleted").length === 0);

  const tempoMarker = page.locator("#score-pane g.tempo-annotation").first();
  await tempoMarker.click();
  await page.keyboard.press("Delete");
  if (await tempoMarker.evaluate((element) => !element.classList.contains("soft-deleted"))) {
    throw new Error("tempo marker did not become translucent after score deletion");
  }
  await tempoMarker.dblclick();
  if (await tempoMarker.evaluate((element) => element.classList.contains("soft-deleted"))) {
    throw new Error("double-click did not restore a softly deleted tempo marker");
  }

  const sourceToScore = await page.evaluate(() => {
    const app = window.__app;
    const source = app._sourceNotes[2];
    app.view.focus();
    app.view.dispatch({ selection: { anchor: source.from, head: source.to } });
    return {
      selectedNotes: app._selectedNotes.length,
      selectedText: app.view.state.doc.sliceString(
        app.view.state.selection.main.from,
        app.view.state.selection.main.to,
      ),
    };
  });
  if (sourceToScore.selectedNotes !== 1 || sourceToScore.selectedText !== "3'") {
    throw new Error(`source selection did not highlight its rendered note: ${JSON.stringify(sourceToScore)}`);
  }

  const dragBox = await page.evaluate(() => {
    const entries = [...document.querySelectorAll("#score-pane g.entry")].slice(0, 3);
    const rects = entries.map((entry) => entry.getBoundingClientRect());
    return {
      left: Math.min(...rects.map((rect) => rect.left)) - 2,
      top: Math.min(...rects.map((rect) => rect.top)) - 2,
      right: Math.max(...rects.map((rect) => rect.right)) + 2,
      bottom: Math.max(...rects.map((rect) => rect.bottom)) + 2,
    };
  });
  await page.mouse.move(dragBox.left, dragBox.top);
  await page.mouse.down();
  await page.mouse.move(dragBox.right, dragBox.bottom, { steps: 6 });
  await page.mouse.up();
  state = await page.evaluate(() => ({
    selectedNotes: window.__app._selectedNotes.length,
    nativeScoreSelection: (() => {
      const selection = window.getSelection();
      const pane = document.querySelector("#score-pane");
      return Boolean(selection?.anchorNode && pane?.contains(selection.anchorNode));
    })(),
  }));
  if (state.selectedNotes < 3 || state.nativeScoreSelection) {
    throw new Error(`drag selection failed or leaked a native blue selection: ${JSON.stringify(state)}`);
  }

  await page.waitForTimeout(300);
  if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: false });
  const selectedPlayback = await page.evaluate(async () => {
    let start;
    const app = window.__app;
    app._player = { stop() {}, async play(_score, _options, value) { start = value; } };
    await app.playScore();
    const primary = app._selectedNotes.at(-1);
    return Boolean(start && primary && start.chord === primary.source.chord && start.pass === primary.verse);
  });
  if (!selectedPlayback) throw new Error("playback did not start at the current score selection");

  await page.locator("#score-pane svg").first().click({ position: { x: 4, y: 4 } });
  const clearedPlayback = await page.evaluate(async () => {
    let start = "not-called";
    const app = window.__app;
    app._player = { stop() {}, async play(_score, _options, value) { start = value; } };
    await app.playScore();
    return {
      selected: app._selectedNotes.length,
      selectedSvg: document.querySelectorAll("#score-pane g.selected").length,
      startsAtOpening: start === undefined,
    };
  });
  if (clearedPlayback.selected !== 0 || clearedPlayback.selectedSvg !== 0 || !clearedPlayback.startsAtOpening) {
    throw new Error(`clearing the selection did not restore opening playback: ${JSON.stringify(clearedPlayback)}`);
  }

  const jpwGrace = `.Title
KeyAndMeters = {1=C,4/4}
.Voice
{2'}3 4 5 6 |]
`;
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
  }, jpwGrace);
  await page.waitForFunction(() =>
    document.querySelectorAll("#score-pane .jianpu-grace-note").length === 1
    && window.__app._sourceNotes.some((source) => source.grace));
  await page.locator("#score-pane .jianpu-grace-number").click();
  state = await page.evaluate(() => ({
    source: window.__app.view.state.selection.ranges.map((range) =>
      window.__app.view.state.doc.sliceString(range.from, range.to)),
    selectedGrace: document.querySelectorAll("#score-pane .jianpu-grace-note.selected").length,
  }));
  if (state.source.join("|") !== "2'" || state.selectedGrace !== 1) {
    throw new Error(`clicking a JPW grace note did not select its exact source: ${JSON.stringify(state)}`);
  }
  await page.keyboard.press("6");
  await page.waitForFunction(() => /\{6'\}3/.test(window.__app.getText()));
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => /\{6\}3/.test(window.__app.getText()));
  const jpwGraceSourceSelection = await page.evaluate(() => {
    const app = window.__app;
    const source = app._sourceNotes.find((item) => item.grace);
    if (!source) return null;
    app.view.focus();
    app.view.dispatch({ selection: { anchor: source.from, head: source.to } });
    return {
      text: app.view.state.doc.sliceString(source.from, source.to),
      selected: app._selectedNotes.length,
      graceVisual: document.querySelectorAll("#score-pane .jianpu-grace-note.selected").length,
    };
  });
  if (!jpwGraceSourceSelection || jpwGraceSourceSelection.text !== "6"
    || jpwGraceSourceSelection.selected !== 1 || jpwGraceSourceSelection.graceVisual !== 1) {
    throw new Error(`JPW grace source selection did not highlight the grace visual: ${JSON.stringify(jpwGraceSourceSelection)}`);
  }
  const graceBeamPoint = await page.locator("#score-pane .jianpu-grace-beam line").first().evaluate((line) => {
    const x = (Number(line.getAttribute("x1")) + Number(line.getAttribute("x2"))) / 2;
    const y = (Number(line.getAttribute("y1")) + Number(line.getAttribute("y2"))) / 2;
    const matrix = line.getScreenCTM();
    if (!matrix) throw new Error("grace beam has no screen transform");
    const point = new DOMPoint(x, y).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(graceBeamPoint.x, graceBeamPoint.y);
  state = await page.evaluate(() => ({
    source: window.__app.view.state.selection.ranges.map((range) =>
      window.__app.view.state.doc.sliceString(range.from, range.to)),
    selectedGrace: document.querySelectorAll("#score-pane .jianpu-grace-note.selected").length,
  }));
  if (state.source.join("|") !== "6" || state.selectedGrace !== 1) {
    throw new Error(`clicking a grace beam did not select its grace pitch: ${JSON.stringify(state)}`);
  }
  if (process.argv[3]) {
    await page.evaluate(() => {
      window.__app.deselect();
      window.__app.setZoom(4);
    });
    await page.locator("#score-pane g.entry").first().screenshot({ path: process.argv[3] });
    await page.evaluate(() => window.__app.setZoom(1));
  }

  const numberSlash = `数字谱
4/4拍：
点=八分音符
{2}1./2./3./4./
`;
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "number";
    app.slashOptions = {
      kind: "number", title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 8 }, spaceDivision: null, noteDivision: null, braceMode: "grace",
    };
    app.setText(text);
  }, numberSlash);
  await page.waitForFunction(() => window.__app.documentFormat === "number" &&
    document.querySelectorAll("#score-pane g.entry").length >= 4);
  await page.locator("#score-pane .jianpu-grace-number").click();
  state = await page.evaluate(() => ({
    source: window.__app.view.state.selection.ranges.map((range) =>
      window.__app.view.state.doc.sliceString(range.from, range.to)),
    mapped: window.__app._sourceNotes.length,
  }));
  if (state.source.join("|") !== "2" || state.mapped !== 5) {
    throw new Error(`number slash grace selection did not map to its TXT pitch: ${JSON.stringify(state)}`);
  }
  await page.keyboard.press("7");
  await page.waitForFunction(() => /\{7\}1\./.test(window.__app.getText()));
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => /\{\+7\}1\./.test(window.__app.getText()));
  await noteText("1").click();
  state = await page.evaluate(() => ({
    source: window.__app.view.state.selection.ranges.map((range) =>
      window.__app.view.state.doc.sliceString(range.from, range.to)),
    mapped: window.__app._sourceNotes.length,
  }));
  if (state.source.join("|") !== "1" || state.mapped !== 5) {
    throw new Error(`number slash-score selection did not map to its TXT pitch: ${JSON.stringify(state)}`);
  }
  await page.keyboard.press("5");
  await page.waitForFunction(() => /\{\+7\}5\.\/2\./.test(window.__app.getText()));
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => /\{\+7\}\+5\.\/2\./.test(window.__app.getText()));
  const slashPlayback = await page.evaluate(async () => {
    let start;
    const app = window.__app;
    app._player = { stop() {}, async play(_score, _options, value) { start = value; } };
    await app.playScore();
    const primary = app._selectedNotes.at(-1);
    return Boolean(start && primary && start.chord === primary.source.chord && start.pass === primary.verse);
  });
  if (!slashPlayback) throw new Error("number slash-score playback did not start at the selected pitch");

  const keyboardSlash = `键盘谱
4/4拍：
点=八分音符
{Q}A./S./D./F./
`;
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 8 }, spaceDivision: null, noteDivision: null, braceMode: "grace",
    };
    app.setText(text);
  }, keyboardSlash);
  await page.waitForFunction(() => window.__app.documentFormat === "keyboard" &&
    document.querySelectorAll("#score-pane g.entry").length >= 4);
  await page.locator("#score-pane .jianpu-grace-number").click();
  state = await page.evaluate(() => ({
    source: window.__app.view.state.selection.ranges.map((range) =>
      window.__app.view.state.doc.sliceString(range.from, range.to)),
  }));
  if (state.source.join("|") !== "Q") {
    throw new Error(`keyboard slash grace selection did not map to its TXT key: ${JSON.stringify(state)}`);
  }
  await page.keyboard.press("3");
  await page.waitForFunction(() => /\{E\}A\./.test(window.__app.getText()));
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => /\{D\}A\./.test(window.__app.getText()));
  await noteText("1").click();
  state = await page.evaluate(() => ({
    source: window.__app.view.state.selection.ranges.map((range) =>
      window.__app.view.state.doc.sliceString(range.from, range.to)),
  }));
  if (state.source.join("|") !== "A") {
    throw new Error(`keyboard slash-score selection did not map to its TXT key: ${JSON.stringify(state)}`);
  }
  await page.keyboard.press("3");
  await page.waitForFunction(() => /\{D\}D\.\/S\./.test(window.__app.getText()));
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => /\{D\}E\.\/S\./.test(window.__app.getText()));

  const prefixedArpeggioSlash = `键盘谱
4/4拍：
点=16分音符
花括号=琶音
{,NZCB}A..../..../-/-/
`;
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, spaceDivision: null, noteDivision: null, braceMode: "arpeggio",
    };
    app.setText(text);
  }, prefixedArpeggioSlash);
  await page.waitForFunction(() => window.__app._sourceNotes.length === 5 &&
    document.querySelectorAll("#score-pane .jianpu-arpeggio").length === 1);
  const arpeggioMapping = await page.evaluate(async () => {
    const app = window.__app;
    const sources = [...app._sourceNotes];
    const chord = sources[0]?.chord;
    let exactReverseMapping = true;
    for (const source of sources) {
      app.view.dispatch({ selection: { anchor: source.from, head: source.to } });
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      if (app._selectedNotes.length !== 1 || app._selectedNotes[0].source.note !== source.note) {
        exactReverseMapping = false;
      }
    }
    const continuation = chord?.measure.entries.find((entry) => entry.transparentContinuation);
    return {
      text: sources.map((source) => app.view.state.doc.sliceString(source.from, source.to)),
      sameChord: sources.every((source) => source.chord === chord),
      exactReverseMapping,
      tiedContinuation: Boolean(continuation && continuation.notes.length === 5 &&
        continuation.notes.every((note) => note.tieEnd && note.tiePrev?.chord === chord)),
    };
  });
  if (arpeggioMapping.text.join("|") !== ",N|Z|C|B|A" ||
    !arpeggioMapping.sameChord || !arpeggioMapping.exactReverseMapping ||
    !arpeggioMapping.tiedContinuation) {
    throw new Error(`prefixed arpeggio highlighting or tie mapping is inaccurate: ${JSON.stringify(arpeggioMapping)}`);
  }
  const arpeggioClickPoints = await page.evaluate(() => {
    const app = window.__app;
    return app._sourceNotes.map((source) => {
      const element = app.painter.noteGroupEl(source.chord, source.note);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        text: app.view.state.doc.sliceString(source.from, source.to),
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    });
  });
  if (arpeggioClickPoints.some((point) => !point)) {
    throw new Error("a prefixed arpeggio tone has no clickable score visual");
  }
  for (const point of arpeggioClickPoints) {
    await page.mouse.click(point.x, point.y);
    state = await page.evaluate(() => ({
      source: window.__app.view.state.selection.ranges.map((range) =>
        window.__app.view.state.doc.sliceString(range.from, range.to)),
    }));
    if (state.source.join("|") !== point.text) {
      throw new Error(`clicking arpeggio tone ${point.text} selected the wrong TXT range: ${JSON.stringify(state)}`);
    }
  }
  if (process.argv[4]) {
    await page.evaluate(() => {
      window.__app.deselect();
      window.__app.setZoom(3);
    });
    await page.locator("#score-pane .score-page").first().screenshot({ path: process.argv[4] });
    await page.evaluate(() => window.__app.setZoom(1));
  }

  if (errors.filter((error) => !/favicon/.test(error)).length > 0) {
    throw new Error(`browser errors: ${errors.join("\n")}`);
  }
  const result = {
    text: await page.evaluate(() => window.__app.getText()),
    singleSelection: true,
    multiSelection: true,
    keyboardPitchEdit: true,
    numberSlashPitchEdit: true,
    keyboardSlashPitchEdit: true,
    arpeggioHighlighting: true,
    selectedPlayback,
    slashPlayback,
    clearedPlayback,
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  server.close();
}
