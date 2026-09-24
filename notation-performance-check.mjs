import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
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
const reports = [];
const measureCounts = (process.env.PERF_MEASURES ?? "32,128,256").split(",").map(Number);
try {
  await page.goto("http://127.0.0.1:" + server.address().port + "/", { waitUntil: "networkidle" });
  await page.evaluate(() => {
    window.__perf = {};
    const wrap = (object, method, label = method) => {
      const original = object[method];
      if (typeof original !== "function") return;
      object[method] = function (...args) {
        const start = performance.now();
        try { return original.apply(this, args); }
        finally { const list = window.__perf[label] ??= []; list.push(performance.now() - start); }
      };
    };
    const app = window.__app;
    for (const method of ["reload", "serializeCurrentScoreDocument", "replaceDocumentText", "renderPages", "renderInputCursor", "applyScoreVoiceColors", "updateSlashVoiceHighlights", "restoreScoreSelections", "applySoftDeletedClasses"]) wrap(app, method);
    wrap(app.painter, "resize", "layout");
    wrap(app.painter, "renderPage", "svg");
    wrap(app.painter, "renderCachedPage", "cachedSvg");
    wrap(app.painter.layout, "fromPianoScore", "pianoLayout");
    wrap(app.painter.layout, "makePianoSystem", "pianoSystem");
    wrap(app.painter.layout, "rebuildRhythmInputSpans", "inputSpans");
    const screenCTM = SVGSVGElement.prototype.getScreenCTM;
    SVGSVGElement.prototype.getScreenCTM = function (...args) {
      if (this.classList.contains("score-page")) (window.__perf.screenGeometry ??= []).push(1);
      return screenCTM.apply(this, args);
    };
  });
  for (const measures of measureCounts) {
    await page.evaluate((count) => {
      const z = "\u2063";
      const row = ["V", "B", "N", "M"].map((bass) => `(${bass}${z}G).${z}A.${z}S.${z}D./`).join("");
      const app = window.__app;
      window.__perf = {};
      app.documentFormat = "keyboard";
      app.slashOptions = { kind: "keyboard", voiceCount: 2, instrumentName: "钢琴", title: "长谱性能",
        subtitle: "", composer: "", arranger: "", lyricist: "", tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
        symbolDurations: { ".": 16 }, spaceDivision: null, noteDivision: null,
        braceMode: "arpeggio", bracketMode: "triplet", showExplicitRests: true };
      app.setText("键盘谱\n4/4拍：\n点=16分音符\n" + Array(count).fill(row).join("\n") + "\n");
      app.setInputMode(true);
    }, measures);
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.__perf.reload.length), 1,
      "setText must not queue a second full-score reload");
    const result = await page.evaluate(() => {
      const app = window.__app;
      const measureIndex = app.painter.score.parts[0].measures.length - 2;
      const chord = app.painter.score.parts[0].measures[measureIndex].entries.find((entry) => entry.notes?.length);
      app._input.setCursor(app.painter.score, { partIndex: 0, measureIndex, offset: chord.position, division: 16, lane: "rest" }, chord.notes[0].pitch);
      app.renderInputCursor();
      window.__perf = {};
      const originalPages = app.pageEls.map((wrap) => wrap.querySelector("svg"));
      const start = performance.now();
      app.typeInputDegree(2);
      const elapsed = performance.now() - start;
      return { elapsed, pages: app.painter.pageCount, sourceNotes: app._sourceNotes.length,
        measures: app.painter.score.parts[0].measures.length, timings: window.__perf,
        retainedPages: app.pageEls.filter((wrap, i) => wrap.querySelector("svg") === originalPages[i]).length };
    });
    await page.waitForTimeout(300);
    const repeats = await page.evaluate(() => window.__perf.reload?.length ?? 0);
    assert.equal(result.measures, measures);
    assert.equal(repeats, 1);
    assert.equal(result.retainedPages, result.pages, "editing a note recreated page SVGs");
    assert((result.timings.pianoSystem?.length ?? 0) <= 2,
      "editing one measure rebuilt unrelated piano systems");
    assert((result.timings.screenGeometry?.length ?? 0) < 12,
      "one edit forced screen geometry reads across offscreen pages");
    const operations = await page.evaluate(() => {
      const app = window.__app;
      const measureIndex = app.painter.score.parts[0].measures.length - 2;
      const focus = (partIndex) => {
        const chord = app.painter.score.parts[partIndex].measures[measureIndex].entries
          .find((entry) => entry.notes?.some((note) => !note.rest) && !entry.generatedTimingContinuation);
        app._input.setCursor(app.painter.score, { partIndex, measureIndex, offset: chord.position,
          division: 16, lane: "rest" }, chord.notes[0].pitch);
        app.renderInputCursor();
      };
      const measure = (name, action) => {
        window.__perf = {};
        const text = app.getText();
        const start = performance.now();
        action();
        return { name, elapsed: performance.now() - start, changed: text !== app.getText(),
          timings: structuredClone(window.__perf) };
      };
      focus(0);
      const move = measure("move", () => app.moveInputFocusTiming(1));
      focus(1);
      app.resizeInputFocus(-1); // Make a real rest available for lengthening.
      const extend = measure("extend", () => app.resizeInputFocus(1));
      const navigate = measure("cursor", () => app.moveInputCursor(1));
      return [move, extend, navigate];
    });
    assert(operations.slice(0, 2).every((operation) => operation.changed), "move/extend benchmark did not edit the score");
    for (const operation of operations.slice(0, 2)) {
      assert.equal(operation.timings.reload.length, 1, `${operation.name} reloaded more than once`);
      assert((operation.timings.screenGeometry?.length ?? 0) < 12,
        `${operation.name} measured offscreen pages`);
    }
    assert.equal(operations[2].timings.reload, undefined, "moving the cursor must not reparse the score");
    reports.push({ ...result, reloadsAfterSettle: repeats, operations });
    console.log(JSON.stringify({ measures, sourceNotes: result.sourceNotes, pages: result.pages,
      inputMs: +result.elapsed.toFixed(1),
      operations: operations.map(({ name, elapsed }) => ({ name, ms: +elapsed.toFixed(1) })) }));
  }
  // Exercise the actual keyboard handler on the last long score. Rapid input
  // must keep the latest note, with no stale delayed parse after the burst.
  await page.evaluate(() => { window.__perf = {}; window.__app.scorePane.focus(); });
  for (const key of ["3", "4", "5"]) {
    const before = await page.evaluate(() => window.__app.getText());
    await page.keyboard.press(key);
    assert.notEqual(await page.evaluate(() => window.__app.getText()), before);
  }
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => window.__perf.reload.length), 3);
  const latest = await page.evaluate(() => window.__app.getText());
  assert.equal(await page.evaluate(() => window.__app.inputFocus()?.note.number), "5");
  await page.keyboard.press("Control+z");
  await page.waitForFunction((text) => window.__app.getText() !== text, latest);
  await page.waitForTimeout(350);
  await page.keyboard.press("Control+y");
  await page.waitForFunction((text) => window.__app.getText() === text, latest);
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => window.__app.inputFocus()?.note.number), "5");
  // Compare the retained pages with a fresh browser layout of the same Score.
  // This uses the real fonts/SVG measurement engine, including pagination.
  const visualComparison = await page.evaluate(() => {
    const app = window.__app;
    const fresh = new app.painter.constructor(app.painter.layout.fontSize);
    fresh.layout.options = app.painter.layout.options;
    fresh.score = app.painter.score;
    fresh.resize(app.pageW, app.pageH, null);
    const signature = (source) => {
      const svg = source.cloneNode(true);
      svg.querySelectorAll(".score-input-cursor, .score-input-draft, .slash-measure-diagnostics")
        .forEach((element) => element.remove());
      const runtime = new Set(["selected", "playing", "input-focused", "soft-deleted"]);
      const rounded = (value) => value.replace(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi,
        (number) => String(Math.round(Number(number) * 1e6) / 1e6));
      return JSON.stringify([svg, ...svg.querySelectorAll("*")].map((element) => [
        element.tagName,
        [...element.attributes].map(({ name, value }) => [name, name === "class"
          ? value.split(/\s+/).filter((item) => !runtime.has(item)).join(" ")
          : rounded(value)]).filter(([, value]) => value !== "")
          .sort(([a], [b]) => a.localeCompare(b)),
        element.children.length === 0 ? element.textContent : "",
      ]));
    };
    const mismatches = [];
    for (let i = 0; i < fresh.pageCount; i++) {
      const cached = app.pageEls[i]?.querySelector("svg");
      if (!cached || signature(cached) !== signature(fresh.renderPage(i))) mismatches.push(i + 1);
    }
    return { freshPages: fresh.pageCount, cachedPages: app.pageEls.length, mismatches };
  });
  assert.equal(visualComparison.freshPages, visualComparison.cachedPages);
  assert.deepEqual(visualComparison.mismatches, [], "cached pages differ from a fresh browser layout");
  assert.deepEqual(errors, []);
  const output = join(tmpdir(), process.env.PERF_REPORT ?? "notation-performance.json");
  await writeFile(output, JSON.stringify(reports, null, 2));
  console.log(`notation-performance-check: ok (rapid input, undo/redo); report: ${output}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
