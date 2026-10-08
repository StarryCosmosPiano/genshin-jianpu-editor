// Long-score staff preview work bounds and comparative editing timings.
// Uses the same 256-measure keyboard fixture as notation-performance-check.mjs.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".wasm": "application/wasm", ".svg": "image/svg+xml" };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    const data = await readFile(join(root, normalize(file)));
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" }); response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [], requested = [], checks = [], report = { measures: 256 };
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error" && !/favicon/.test(message.text())) errors.push(`${message.text()} ${message.location().url}`); });
page.on("request", request => requested.push(request.url()));
const check = (label, condition) => { assert(condition, label); checks.push(label); };
const settled = async () => page.waitForFunction(() => {
  const app = window.__app, pane = document.getElementById("staff-pane");
  return app.isStaffPreviewCurrent() && pane.getAttribute("aria-busy") === "false"
    && Number(pane.dataset.staffRevision) === app.getStaffPreviewSnapshot().revision
    && Boolean(document.querySelector("#staff-pages svg"));
}, null, { timeout: 60000 });
const counters = () => page.evaluate(() => structuredClone(window.__staffPerf));
const resetCounters = () => page.evaluate(() => { window.__staffPerf = { reloads: [], svgCreated: 0, commits: [], busyWrites: 0, modelChanges: [] }; });
const mounted = () => page.evaluate(() => {
  const pane = document.getElementById("staff-pane"), pages = [...document.querySelectorAll("#staff-pages .staff-page")];
  const top = pane.scrollTop, bottom = top + pane.clientHeight;
  let first = pages.findIndex(wrap => wrap.offsetTop + wrap.offsetHeight >= top); if (first < 0) first = pages.length - 1;
  let last = first; while (last + 1 < pages.length && pages[last + 1].offsetTop < bottom) last++;
  const indices = pages.flatMap((wrap, index) => wrap.querySelector("svg") ? [index] : []);
  return { total: pages.length, first, last, indices, allowed: [Math.max(0, first - 1), Math.min(pages.length - 1, last + 1)] };
});
const assertVirtualized = async label => {
  const state = await mounted();
  check(label, state.total > state.indices.length && state.indices.every(index => index >= state.allowed[0] && index <= state.allowed[1])
    && state.indices.length <= state.last - state.first + 3);
  return state;
};
const setup = async () => {
  await page.evaluate(() => {
    const z = "\u2063";
    const row = ["V", "B", "N", "M"].map(bass => `(${bass}${z}G).${z}A.${z}S.${z}D./`).join("");
    const app = window.__app;
    app.setInputMode(false); app.documentFormat = "keyboard";
    app.slashOptions = { kind: "keyboard", voiceCount: 2, instrumentName: "钢琴", title: "长谱性能",
      subtitle: "", composer: "", arranger: "", lyricist: "", tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, spaceDivision: null, noteDivision: null,
      braceMode: "arpeggio", bracketMode: "triplet", showExplicitRests: true };
    app.setText("键盘谱\n4/4拍：\n点=16分音符\n" + Array(256).fill(row).join("\n") + "\n");
    app.setInputMode(true);
  });
  await page.waitForTimeout(250);
};
const benchmark = async () => page.evaluate(() => {
  const app = window.__app, measureIndex = app.painter.score.parts[0].measures.length - 2;
  const focus = partIndex => {
    const chord = app.painter.score.parts[partIndex].measures[measureIndex].entries.find(entry => entry.notes?.some(note => !note.rest) && !entry.generatedTimingContinuation);
    app._input.setCursor(app.painter.score, { partIndex, measureIndex, offset: chord.position, division: 16, lane: "rest" }, chord.notes[0].pitch);
    app.renderInputCursor();
  };
  const measure = (name, action) => { const text = app.getText(), before = window.__staffPerf.reloads.length, start = performance.now(); action(); return { name, ms: +(performance.now() - start).toFixed(1), changed: app.getText() !== text, reloads: window.__staffPerf.reloads.length - before }; };
  focus(0); const input = measure("input", () => app.typeInputDegree(2));
  focus(0); const move = measure("move", () => app.moveInputFocusTiming(1));
  focus(1); app.resizeInputFocus(-1);
  const extend = measure("extend", () => app.resizeInputFocus(1));
  const cursor = measure("cursor", () => app.moveInputCursor(1));
  return [input, move, extend, cursor];
});

try {
  await page.goto(process.env.APP_TEST_URL || `http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app?.isStaffPreviewCurrent());
  check("closed startup requests no renderer or VexFlow module", !requested.some(url => /\/renderer[-.]|\/renderer\.ts|vexflow/i.test(url)));
  await page.evaluate(() => {
    window.__staffPerf = { reloads: [], svgCreated: 0, commits: [], busyWrites: 0, modelChanges: [] };
    const app = window.__app, reload = app.reload;
    app.reload = function (...args) { const start = performance.now(); try { return reload.apply(this, args); } finally { window.__staffPerf.reloads.push(performance.now() - start); } };
    const create = document.createElementNS.bind(document);
    document.createElementNS = function (namespace, name, ...args) { if (name.toLowerCase() === "svg") window.__staffPerf.svgCreated++; return create(namespace, name, ...args); };
    const pane = document.getElementById("staff-pane"), setAttribute = pane.setAttribute.bind(pane);
    pane.setAttribute = function (name, value) { if (name === "aria-busy" && value === "true") window.__staffPerf.busyWrites++; return setAttribute(name, value); };
    new MutationObserver(records => {
      for (const record of records) if (record.attributeName === "data-staff-revision") {
        const revision = Number(pane.dataset.staffRevision); if (Number.isFinite(revision) && !window.__staffPerf.commits.includes(revision)) window.__staffPerf.commits.push(revision);
      }
    }).observe(pane, { attributes: true, attributeFilter: ["data-staff-revision"] });
    document.addEventListener("staff:model-change", event => window.__staffPerf.modelChanges.push(event.detail.revision));
  });
  await setup();
  check("closed long-score registry stays lazy", await page.evaluate(() => window.__app._staffRegistry === null));
  check("fixture has exactly 256 measures", await page.evaluate(() => window.__app.painter.score.parts[0].measures.length === 256));
  await resetCounters(); report.closed = await benchmark();
  await page.waitForTimeout(250);
  check("closed input/move/extend each reload exactly once", report.closed.slice(0, 3).every(operation => operation.changed && operation.reloads === 1));
  check("closed cursor movement never reparses", report.closed[3].reloads === 0);
  check("closed edits never schedule staff layout", (await counters()).busyWrites === 0 && (await counters()).commits.length === 0);
  check("closed edits still do not load renderer", !requested.some(url => /\/renderer[-.]|\/renderer\.ts|vexflow/i.test(url)));

  await setup(); // Recreate identical input pitches before the open-view comparison.
  const openStart = Date.now(); await page.selectOption("#staff-view-select", "compare"); await settled(); report.firstPrepareMs = Date.now() - openStart;
  report.initialVirtualization = await assertVirtualized("initial long-score mount contains only visible pages and one neighbor on each side");
  await resetCounters(); report.open = await benchmark(); await settled();
  check("open input/move/extend each reload exactly once", report.open.slice(0, 3).every(operation => operation.changed && operation.reloads === 1));
  check("open cursor movement never reparses", report.open[3].reloads === 0);
  const burst = await counters();
  check("continuous synchronous edits commit only their latest revision", burst.commits.length === 1 && burst.commits[0] === await page.evaluate(() => window.__app.getStaffPreviewSnapshot().revision));
  report.afterEditsVirtualization = await assertVirtualized("after edits offscreen staff page SVGs remain unmounted");

  // Select an actual visible notehead and replay its callbacks without audio/network.
  await page.evaluate(() => {
    const app = window.__app; app._player = { state: "stopped", stop() { this.state = "stopped"; app.onPlayChord(null, 0); app.onPlayState("stopped"); }, stopAudition() {}, audition() {} };
    const pane = document.getElementById("staff-pane"); pane.scrollTop = 0;
  });
  await page.waitForTimeout(50);
  const hit = page.locator("#staff-pages [data-staff-ref]").first(); await hit.scrollIntoViewIfNeeded();
  await page.evaluate(() => { window.__staffStableSvgs = [...document.querySelectorAll("#staff-pages svg")]; });
  await resetCounters(); await hit.click();
  await page.evaluate(() => {
    const app = window.__app, primary = app.getStaffSelectionState().primary;
    app._player.state = "playing"; app.onPlayState("playing");
    for (let pass = 0; pass < 5; pass++) app.onPlayChord([primary.chord], 0);
    app.stopPlayback();
  });
  await page.waitForTimeout(250);
  const quiet = await counters();
  check("selection and playback callbacks never parse or prepare", quiet.reloads.length === 0 && quiet.commits.length === 0 && quiet.busyWrites === 0);
  check("selection and playback do not create SVGs", quiet.svgCreated === 0);
  check("selection and playback retain every mounted page SVG", await page.evaluate(() => window.__staffStableSvgs.every(svg => svg.isConnected)));
  report.selectionAndPlayback = quiet;

  // One ordinary text edit uses the existing delayed parse once, then one staff commit.
  await resetCounters();
  const editStart = Date.now();
  await page.evaluate(() => { const app = window.__app; app.view.dispatch({ changes: { from: 0, to: 0, insert: "\n" } }); });
  await settled(); report.singleTextEditWallMs = Date.now() - editStart;
  const one = await counters();
  check("one text edit causes exactly one reload and staff commit", one.reloads.length === 1 && one.commits.length === 1);
  report.singleTextEdit = one;

  // A text burst is coalesced by the existing parser and staff scheduler.
  await resetCounters();
  await page.evaluate(() => { const app = window.__app; for (let edit = 0; edit < 3; edit++) app.view.dispatch({ changes: { from: 0, to: 0, insert: "\n" } }); });
  await settled();
  const textBurst = await counters();
  check("rapid text updates reload once and commit the latest snapshot", textBurst.reloads.length === 1 && textBurst.commits.length === 1 && textBurst.commits[0] === await page.evaluate(() => window.__app.getStaffPreviewSnapshot().revision));
  report.textBurst = textBurst;

  await page.selectOption("#staff-view-select", "jianpu"); await resetCounters();
  await page.evaluate(() => { const app = window.__app; app.view.dispatch({ changes: { from: 0, to: 0, insert: "\n" } }); });
  await page.waitForFunction(() => window.__staffPerf.reloads.length === 1);
  await page.waitForTimeout(350);
  const closedAgain = await counters();
  check("closing disposes every staff SVG and page wrapper", await page.locator("#staff-pages svg, #staff-pages .staff-page").count() === 0);
  check("updates after closing never schedule or commit staff layout", closedAgain.busyWrites === 0 && closedAgain.commits.length === 0);
  check("browser reports no runtime or console errors", errors.length === 0);
  report.checks = checks; report.errors = errors;
  const output = join(tmpdir(), process.env.STAFF_PERF_REPORT ?? "staff-preview-performance.json");
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, measures: 256, closed: report.closed, open: report.open, firstPrepareMs: report.firstPrepareMs,
    mounted: report.initialVirtualization, checks: checks.length, report: output }, null, 2));
} catch (error) { console.error(JSON.stringify({ completed: checks, errors, report, counters: await counters().catch(() => null), ui: await page.evaluate(() => ({ availability: window.__app?.getStaffPreviewAvailability(), current: window.__app?.isStaffPreviewCurrent(), view: document.getElementById("score-surfaces")?.dataset.staffView, pane: document.getElementById("staff-pane")?.outerHTML.slice(0, 500), status: document.getElementById("staff-preview-status")?.textContent })).catch(() => null) }, null, 2)); throw error; }
finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
