// Real-browser regression for the independently audited PPQ=480 rhythm fixture.
// The fixture is supplied by the caller; no private MIDI or absolute path is
// required by the default test suite. Build dist/ before running this script.
//
//   node midi-rhythm-browser-check.mjs <fixture.mid> [artifact-directory]
//   BROWSER_TYPE=firefox BROWSER_EXECUTABLE_PATH=/path/to/firefox node ...
// Default browser: installed Edge. Default artifacts: a fresh OS temp folder.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { chromium, firefox } from "playwright";
import { acceptFixtureImport } from "./browser-test-helpers.mjs";

const argument = process.argv[2];
if (!argument) {
  throw new Error("Usage: node midi-rhythm-browser-check.mjs <audited-fixture.mid> [artifact-directory]");
}
const midiPath = resolve(argument);
const bytes = await readFile(midiPath);
assert(bytes.subarray(0, 4).toString("ascii") === "MThd", "fixture must be a Standard MIDI File");
assert.equal(bytes.readUInt16BE(12), 480, "the focused oracle requires the audited PPQ=480 fixture");
const root = resolve("dist");
await readFile(join(root, "index.html"));
const output = process.argv[3]
  ? resolve(process.argv[3])
  : await mkdtemp(join(tmpdir(), "midi-rhythm-browser-"));
await mkdir(output, { recursive: true });

const mime = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".woff": "font/woff", ".woff2": "font/woff2", ".otf": "font/otf",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const file = resolve(root, pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
    if (!file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    const data = await readFile(file);
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" }).end(data);
  } catch {
    response.writeHead(404).end("not found");
  }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));

// This function executes in the actual browser. Neither the MIDI converter,
// parser, score model, SVG measurement nor painter is replaced by a test stub.
function browserSnapshot() {
  const app = window.__app;
  const score = app.painter.score;
  const rounded = (value) => Math.round(value * 1e9) / 1e9;
  const timeline = [];
  for (let part = 0; part < score.parts.length; part++) {
    for (const measure of score.parts[part].measures) {
      for (const chord of measure.entries) {
        for (const note of chord.notes ?? []) {
          if (note.rest || note.softDeleted || note.tiePrev || note.tieEnd
            || chord.generatedTimingContinuation || chord.transparentContinuation) continue;
          let last = note;
          const seen = new Set();
          while (last.tieNext && !seen.has(last)) {
            seen.add(last);
            last = last.tieNext;
          }
          timeline.push({
            part, pitch: note.pitch,
            start: rounded(measure.position.toFloat() + chord.position.toFloat()),
            end: rounded(last.chord.measure.position.toFloat() + last.chord.position.toFloat()
              + last.chord.duration.toFloat()),
          });
        }
      }
    }
  }
  timeline.sort((a, b) => a.start - b.start || a.part - b.part || a.pitch - b.pitch || a.end - b.end);
  const specs = [
    { id: "grid9", part: 0, grid: 9 }, { id: "grid95", part: 1, grid: 95 },
    { id: "grid112", part: 1, grid: 112 }, { id: "grid113", part: 1, grid: 113 },
  ];
  const focus = specs.map((spec) => ({
    ...spec,
    entries: (score.parts[spec.part]?.measures[spec.grid - 1]?.entries ?? [])
      .filter((chord) => chord.notes?.length)
      .map((chord) => ({
        position: rounded(chord.position.toFloat()), duration: rounded(chord.duration.toFloat()),
        beams: chord.beams, beats: chord.beats, dot: chord.dot,
        notes: chord.notes.map((note) => ({
          pitch: note.pitch, rest: note.rest,
          tiePrev: !!note.tiePrev, tieNext: !!note.tieNext,
          tuplet: !!note.tuplet, tupletBegin: note.tupletBegin, tupletEnd: note.tupletEnd,
        })).sort((a, b) => a.pitch - b.pitch || Number(a.rest) - Number(b.rest)),
      })),
  }));
  const svgs = [...document.querySelectorAll("#score-pane svg")];
  return {
    userAgent: navigator.userAgent, format: app.documentFormat,
    text: app.getText(), diagnostics: app._slashTimingDiagnostics,
    explicitRests: app.slashOptions?.showExplicitRests,
    measureCounts: score.parts.map((part) => part.measures.length),
    timeline, focus,
    rendered: svgs.map((svg) => {
      const bounds = svg.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height, primitives: svg.querySelectorAll("path,text,line").length };
    }),
    errorOverlays: document.querySelectorAll("#score-pane .slash-measure-diagnostics").length,
  };
}

const rounded = (value) => Math.round(value * 1e9) / 1e9;
const close = (a, b) => Math.abs(a - b) < 1e-8;

// Absolute quarter-note positions include the opening pickup grid. These
// expectations come from paired source Note On/Off events, not converter output.
const sourceWindows = [
  {
    part: 0, from: 32, to: 35,
    notes: [
      ...[67, 71, 79].map((pitch) => ({ pitch, start: 32, end: 34 + 1 / 3 })),
      { pitch: 60, start: 34 + 1 / 3, end: 34 + 2 / 3 },
      { pitch: 62, start: 34 + 2 / 3, end: 35 },
    ],
  },
  {
    part: 1, from: 377.5, to: 379,
    notes: [
      ...[50, 55].map((pitch) => ({ pitch, start: 377.5, end: 378 + 2 / 3 })),
      { pitch: 53, start: 378 + 2 / 3, end: 379 },
    ],
  },
  { part: 1, from: 446.5, to: 452, notes: [{ pitch: 62, start: 446 + 2 / 3, end: 452 }] },
];

function checkSnapshot(snapshot, label) {
  assert.deepEqual(snapshot.diagnostics, [], `${label}: timing diagnostics`);
  assert.deepEqual(snapshot.measureCounts, [118, 118], `${label}: audited fixture measure structure changed`);
  assert.equal(snapshot.timeline.length, 1579, `${label}: attacks omitted or duplicated`);
  assert.equal(snapshot.errorOverlays, 0, `${label}: rendered timing-error overlay`);
  assert(snapshot.rendered.length > 0 && snapshot.rendered.every((page) =>
    page.width > 0 && page.height > 0 && page.primitives > 30), `${label}: no measurable real SVG`);
  for (const window of sourceWindows) {
    const actual = snapshot.timeline.filter((note) => note.part === window.part
      && note.start >= window.from && note.start < window.to)
      .map(({ pitch, start, end }) => ({ pitch, start, end }));
    const expected = window.notes.map((note) => ({
      pitch: note.pitch, start: rounded(note.start), end: rounded(note.end),
    })).sort((a, b) => a.start - b.start || a.pitch - b.pitch || a.end - b.end);
    assert.deepEqual(actual, expected, `${label}: source attacks or tied note ends changed in ${window.from}..${window.to}`);
  }

  const grid9 = snapshot.focus.find((item) => item.id === "grid9");
  const rightTail = grid9.entries.filter((entry) => entry.position >= 2 - 1e-8
    && entry.position < 2 + 1 / 3 - 1e-8
    && entry.notes.some((note) => !note.rest && [67, 71, 79].includes(note.pitch)));
  assert.equal(rightTail.length, 1, `${label}: grid9 chord tail still fragmented`);
  assert(close(rightTail[0].duration, 1 / 3) && rightTail[0].beams === 1
    && rightTail[0].notes.every((note) => note.tuplet && note.tiePrev),
  `${label}: grid9 held chord must occupy one tied eighth-triplet cell`);

  const grid95 = snapshot.focus.find((item) => item.id === "grid95");
  const leftTail = grid95.entries.filter((entry) => entry.position >= 2 - 1e-8
    && entry.position < 2 + 2 / 3 - 1e-8
    && entry.notes.some((note) => !note.rest && [50, 55].includes(note.pitch)));
  assert.equal(leftTail.length, 1, `${label}: grid95 chord tail still fragmented`);
  assert(close(leftTail[0].duration, 2 / 3) && leftTail[0].beams === 0
    && leftTail[0].notes.every((note) => note.tuplet && note.tiePrev),
  `${label}: grid95 held chord must occupy the first two triplet cells as one quarter-triplet value`);

  const grid113 = snapshot.focus.find((item) => item.id === "grid113");
  const longContinuation = grid113.entries.filter((entry) => entry.notes.some((note) => !note.rest));
  assert.equal(longContinuation.length, 1, `${label}: grid113 whole-note sustain was split`);
  assert(close(longContinuation[0].position, 0) && close(longContinuation[0].duration, 4)
    && longContinuation[0].beams === 0 && longContinuation[0].beats === 4
    && longContinuation[0].notes.length === 1
    && longContinuation[0].notes[0].pitch === 62
    && longContinuation[0].notes[0].tiePrev && !longContinuation[0].notes[0].tuplet,
  `${label}: grid113 must contain one tied four-beat D4`);
}

async function captureTargets(page, directory) {
  const targets = [
    { id: "grid9", grids: [7, 8, 9] },
    { id: "grid95", grids: [94, 95, 96] },
    { id: "grid112-113", grids: [112, 113, 114] },
  ];
  for (const target of targets) {
    await page.evaluate((grids) => {
      const painter = window.__app.painter;
      const measure = painter.score.parts[0].measures[grids[0] - 1];
      const chord = measure.entries.find((entry) => entry.notes?.length && painter.chordGroupEl(entry));
      painter.chordGroupEl(chord).scrollIntoView({ block: "center", inline: "nearest" });
    }, target.grids);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const clip = await page.evaluate((grids) => {
      const painter = window.__app.painter;
      const bounds = [];
      for (const part of painter.score.parts) for (const index of grids) {
        for (const chord of part.measures[index - 1].entries) {
          if (!chord.notes?.length) continue;
          const rect = painter.chordGroupEl(chord)?.getBoundingClientRect();
          if (rect?.width && rect?.height) bounds.push(rect);
        }
      }
      const left = Math.max(0, Math.min(...bounds.map((rect) => rect.left)) - 50);
      const top = Math.max(0, Math.min(...bounds.map((rect) => rect.top)) - 40);
      const right = Math.min(innerWidth, Math.max(...bounds.map((rect) => rect.right)) + 45);
      const bottom = Math.min(innerHeight, Math.max(...bounds.map((rect) => rect.bottom)) + 25);
      return { x: left, y: top, width: right - left, height: bottom - top };
    }, target.grids);
    assert(clip.width > 200 && clip.height > 100, `invalid rendered geometry for ${target.id}`);
    await page.screenshot({ path: join(directory, `${target.id}.png`), clip });
    target.clip = clip;
  }
  return targets;
}

const browserType = process.env.BROWSER_TYPE ?? "chromium";
assert(["chromium", "firefox"].includes(browserType), "BROWSER_TYPE must be chromium or firefox");
const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
const browserErrors = [];
const failures = [];
const results = [];
let browser;
let page;
let stage = "launch";

function verify(snapshot, label, original) {
  try {
    checkSnapshot(snapshot, label);
    if (original) {
      assert.deepEqual(snapshot.timeline, original.timeline, `${label}: full-score timeline changed`);
      assert.deepEqual(snapshot.focus, original.focus, `${label}: focused notation spelling changed`);
    }
  } catch (error) {
    failures.push({ stage: label, message: String(error?.message ?? error) });
  }
}

try {
  browser = await (browserType === "firefox" ? firefox : chromium).launch({
    headless: true,
    ...(executablePath ? { executablePath } : browserType === "chromium" ? { channel: "msedge" } : {}),
    ...(browserType === "chromium" ? { args: ["--no-sandbox"] } : {}),
  });
  for (const format of ["keyboard", "number"]) for (const explicitRests of [true, false]) {
    const label = `${format}-${explicitRests ? "rests" : "hidden"}`;
    const directory = join(output, label);
    await mkdir(directory, { recursive: true });
    page = await browser.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 2 });
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);
    page.on("pageerror", (error) => browserErrors.push({ label, message: error.message }));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push({ label, message: message.text() });
    });
    page.on("dialog", async (dialog) => {
      browserErrors.push({ label, message: `Unexpected dialog: ${dialog.message()}` });
      await dialog.dismiss();
    });
    stage = `${label}: import`;
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__app && document.querySelector("#score-pane svg"));
    await page.evaluate(({ input, name }) => {
      window.__rhythmImportDone = null;
      window.__rhythmImportError = null;
      void window.__app.importBytes(Uint8Array.from(input), name).then((ok) => {
        window.__rhythmImportDone = ok;
      }).catch((error) => {
        window.__rhythmImportDone = false;
        window.__rhythmImportError = String(error?.stack ?? error);
      });
    }, { input: [...bytes], name: basename(midiPath) });
    await page.locator(".midi-import-box").waitFor();
    const select = (labelText) => page.locator(".midi-import-box .modal-row")
      .filter({ has: page.locator("span").filter({ hasText: new RegExp(`^${labelText}$`) }) }).locator("select");
    await select("推荐量化").selectOption("16");
    await select("导入后格式").selectOption(format);
    await page.getByLabel("保留 0 休止符", { exact: true }).setChecked(explicitRests);
    await acceptFixtureImport(page, page.getByRole("button", { name: "导入并转为简谱", exact: true }));
    await page.waitForFunction(() => window.__rhythmImportDone !== null, null, { timeout: 60000 });
    const imported = await page.evaluate(() => ({ ok: window.__rhythmImportDone, error: window.__rhythmImportError }));
    assert.equal(imported.ok, true, `${stage}: ${imported.error ?? "import failed"}`);
    // Use the same public layout setting for each before/after capture.
    await page.evaluate(() => {
      const app = window.__app;
      app.setEngravingStyle({ ...app.engravingStyle, measuresPerSystem: 3 }, false);
    });
    await page.evaluate(() => document.fonts.ready);
    const original = await page.evaluate(browserSnapshot);
    assert.equal(original.format, format, `${stage}: active format changed`);
    assert.equal(original.explicitRests, explicitRests, `${stage}: explicit rest setting changed`);
    verify(original, stage);
    await writeFile(join(directory, "import.json"), JSON.stringify(original, null, 2));
    await writeFile(join(directory, "import.txt"), original.text);
    const svgPages = await page.locator("#score-pane svg").evaluateAll((svgs) => svgs.map((svg) => svg.outerHTML));
    for (let index = 0; index < svgPages.length; index++) {
      await writeFile(join(directory, `page-${index + 1}.svg`), svgPages[index]);
    }
    const targets = await captureTargets(page, directory);
    const checkedStages = [];
    for (let round = 1; round <= 2; round++) {
      stage = `${label}: save-reopen-${round}`;
      const savedBytes = await page.evaluate(() => [...window.__app.documentBytes()]);
      const savedPath = join(directory, `saved-${round}.txt`);
      await writeFile(savedPath, new Uint8Array(savedBytes));
      const savedText = await readFile(savedPath, "utf8");
      await page.evaluate(({ text, name }) => window.__app.loadText(text, name), {
        text: savedText, name: basename(savedPath),
      });
      const reopened = await page.evaluate(browserSnapshot);
      verify(reopened, stage, original);
      assert.equal(reopened.text, savedText, `${stage}: saved bytes did not reopen unchanged`);
      await writeFile(join(directory, `reopened-${round}.json`), JSON.stringify(reopened, null, 2));
      checkedStages.push(stage);
    }
    const otherFormat = format === "keyboard" ? "number" : "keyboard";
    for (const target of [otherFormat, format]) {
      stage = `${label}: convert-to-${target}`;
      await page.evaluate((next) => window.__app.changeDocumentFormat(next), target);
      const converted = await page.evaluate(browserSnapshot);
      verify(converted, stage, original);
      assert.equal(converted.format, target, `${stage}: active format was not changed`);
      await writeFile(join(directory, `converted-${target}.json`), JSON.stringify(converted, null, 2));
      checkedStages.push(stage);
    }
    const reopenedDirectory = join(directory, "after-roundtrips");
    await mkdir(reopenedDirectory, { recursive: true });
    await captureTargets(page, reopenedDirectory);

    stage = `${label}: fresh-TXT-import`;
    const freshBytes = await page.evaluate(() => [...window.__app.documentBytes()]);
    const freshPath = join(directory, "fresh-import-source.txt");
    await writeFile(freshPath, new Uint8Array(freshBytes));
    const previousPage = page;
    page = await browser.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 2 });
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);
    page.on("pageerror", (error) => browserErrors.push({ label, message: error.message }));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push({ label, message: message.text() });
    });
    page.on("dialog", async (dialog) => {
      browserErrors.push({ label, message: `Unexpected dialog: ${dialog.message()}` });
      await dialog.dismiss();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__app && document.querySelector("#score-pane svg"));
    // Startup uses a keyboard sample. The normal JPW load boundary clears
    // that sample's options before the saved TXT enters the real import UI.
    await page.evaluate(() => window.__app.loadText(
      ".Title\nTitle = {Fresh TXT import}\nKeyAndMeters = {1=C,4/4}\n.Voice\n0--- |]\n", null,
    ));
    assert.equal(await page.evaluate(() => window.__app.documentFormat), "jpw",
      `${stage}: new context must start outside TXT mode`);
    assert.equal(await page.evaluate(() => window.__app.slashOptions), null,
      `${stage}: new context must not inherit TXT options`);
    await page.evaluate(({ input, name }) => {
      window.__rhythmImportDone = null;
      window.__rhythmImportError = null;
      void window.__app.importBytes(Uint8Array.from(input), name).then((ok) => {
        window.__rhythmImportDone = ok;
      }).catch((error) => {
        window.__rhythmImportDone = false;
        window.__rhythmImportError = String(error?.stack ?? error);
      });
    }, { input: [...await readFile(freshPath)], name: basename(freshPath) });
    await page.locator(".slash-import-box").waitFor();
    await acceptFixtureImport(page, page.getByRole("button", { name: "导入为 2 声部简谱", exact: true }));
    await page.waitForFunction(() => window.__rhythmImportDone !== null, null, { timeout: 60000 });
    const freshImport = await page.evaluate(() => ({ ok: window.__rhythmImportDone, error: window.__rhythmImportError }));
    assert.equal(freshImport.ok, true, `${stage}: ${freshImport.error ?? "import failed"}`);
    await page.evaluate(() => {
      const app = window.__app;
      app.setEngravingStyle({ ...app.engravingStyle, measuresPerSystem: 3 }, false);
    });
    await page.evaluate(() => document.fonts.ready);
    const fresh = await page.evaluate(browserSnapshot);
    verify(fresh, stage, original);
    assert.equal(fresh.format, format, `${stage}: saved TXT format was not recovered`);
    assert.equal(fresh.explicitRests, explicitRests, `${stage}: explicit rest setting was not recovered`);
    await writeFile(join(directory, "fresh-import.json"), JSON.stringify(fresh, null, 2));
    const freshDirectory = join(directory, "fresh-import");
    await mkdir(freshDirectory, { recursive: true });
    await captureTargets(page, freshDirectory);
    await previousPage.close();
    checkedStages.push(stage);
    results.push({ format, explicitRests, attacks: original.timeline.length,
      measures: original.measureCounts, pages: original.rendered.length, targets, checkedStages });
    await page.close();
    page = null;
  }
  const report = { passed: failures.length === 0 && browserErrors.length === 0,
    browserType, results, failures, browserErrors };
  await writeFile(join(output, "results.json"), JSON.stringify(report, null, 2));
  assert.deepEqual(browserErrors, [], "browser console/runtime errors occurred");
  assert.deepEqual(failures, [], "MIDI rhythm spelling browser checks failed; see results.json");
  console.log(JSON.stringify({ passed: true, output, combinations: results.length,
    snapshotsChecked: results.length * 6, browserType }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  await writeFile(join(output, "failure.json"), JSON.stringify({
    stage, message: String(error?.stack ?? error), failures, browserErrors, results,
  }, null, 2));
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise((closed) => server.close(closed));
}
