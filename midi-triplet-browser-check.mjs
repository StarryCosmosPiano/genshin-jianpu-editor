// Focused MIDI -> keyboard/number TXT -> saved TXT browser regression.
// The musical oracle below is independently audited from the PPQ=960
// "从前说 - 原琴 C调完整版.mid" fixture; pass that fixture as the first argument.
//
// Usage, after npm run build:
//   node midi-triplet-browser-check.mjs <fixture.mid> [artifact-directory]
//   BROWSER_EXECUTABLE_PATH=/path/to/chrome node midi-triplet-browser-check.mjs <fixture.mid>
// Artifacts default to the OS temporary directory, outside the source tree.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { acceptFixtureImport } from "./browser-test-helpers.mjs";

const midiArgument = process.argv[2];
if (!midiArgument) {
  throw new Error("Usage: node midi-triplet-browser-check.mjs <fixture.mid> [artifact-directory]");
}
const midiPath = resolve(midiArgument);
const bytes = await readFile(midiPath);
assert(bytes.subarray(0, 4).toString("ascii") === "MThd", "fixture must be a Standard MIDI File");
assert(bytes.readUInt16BE(12) === 960, "this regression oracle requires the audited PPQ=960 fixture");
const root = resolve("dist");
await readFile(join(root, "index.html"));
const output = process.argv[3]
  ? resolve(process.argv[3])
  : await mkdtemp(join(tmpdir(), "midi-triplet-browser-"));
await mkdir(output, { recursive: true });

const mime = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".woff": "font/woff",
  ".woff2": "font/woff2", ".otf": "font/otf", ".wasm": "application/wasm",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const file = resolve(root, pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
    if (!file.startsWith(`${root}${sep}`)) {
      response.writeHead(403);
      response.end();
      return;
    }
    const data = await readFile(file);
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));

// Absolute MIDI ticks, including the opening pickup measure. The first
// window is measure 8 beat 4; the second is measure 9 beats 3 and 4.
// The ordinary D4 at tick 30480 is inside the triplet's time span and must
// survive. The cross-hand G3/C4/D4 triplet must have only three attacks.
const windows = [[29760, 30720], [32640, 34560]];
const expected = [
  { part: 0, pitch: 67, start: 29760 },
  { part: 0, pitch: 72, start: 30080 },
  { part: 0, pitch: 74, start: 30400 },
  { part: 1, pitch: 53, start: 29760 },
  { part: 1, pitch: 62, start: 30480 },
  { part: 1, pitch: 55, start: 32640 },
  { part: 0, pitch: 60, start: 32960 },
  { part: 0, pitch: 62, start: 33280 },
  { part: 0, pitch: 67, start: 33600 },
  { part: 0, pitch: 72, start: 33920 },
  { part: 0, pitch: 74, start: 34240 },
].sort((a, b) => a.start - b.start || a.part - b.part || a.pitch - b.pitch);

// Read the actual editor model and rendered SVG. No converter, parser,
// layout state, or validation callback is replaced by this regression.
function browserSnapshot() {
  const app = window.__app;
  const score = app.painter.score;
  const tick = (quarters) => Math.round(quarters * 960 * 1e8) / 1e8;
  const notes = score.parts.flatMap((part, partIndex) => part.measures.flatMap((measure) =>
    measure.entries.filter((entry) => entry.notes?.length).flatMap((chord) => {
      const start = tick(measure.position.toFloat() + chord.position.toFloat());
      const main = chord.notes
        .filter((note) => !note.rest && !note.softDeleted && !note.tiePrev && !note.tieEnd
          && !chord.generatedTimingContinuation && !chord.transparentContinuation)
        .map((note) => {
          let last = note;
          const seen = new Set();
          while (last.tieNext && !seen.has(last)) {
            seen.add(last);
            last = last.tieNext;
          }
          return {
            part: partIndex,
            pitch: note.pitch,
            start,
            end: tick(last.chord.measure.position.toFloat() + last.chord.position.toFloat()
              + (last.chord.duration?.toFloat() ?? 0)),
            grace: false,
          };
        });
      const grace = (chord.graceNotes ?? []).filter((note) => !note.rest && !note.softDeleted)
        .map((note, index) => ({ part: partIndex, pitch: note.pitch, start, grace: true, index }));
      return [...main, ...grace];
    })))
    .sort((a, b) => a.start - b.start || a.part - b.part || a.pitch - b.pitch
      || Number(a.grace) - Number(b.grace) || (a.end ?? 0) - (b.end ?? 0)
      || (a.index ?? 0) - (b.index ?? 0));
  const svgs = [...document.querySelectorAll("#score-pane svg")];
  const rendered = svgs.map((svg) => {
    const bounds = svg.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, primitives: svg.querySelectorAll("path,text,line").length };
  });
  return {
    format: app.documentFormat,
    text: app.getText(),
    diagnostics: app._slashTimingDiagnostics,
    voiceCount: app.slashOptions?.voiceCount,
    parts: score.parts.length,
    measurePositions: score.parts.map((part) => part.measures.map((measure) => tick(measure.position.toFloat()))),
    notes,
    rendered,
    errorOverlays: document.querySelectorAll("#score-pane .slash-measure-diagnostics").length,
  };
}

function checkSnapshot(snapshot, format, label) {
  assert.equal(snapshot.format, format, `${label}: wrong active format`);
  assert.deepEqual(snapshot.diagnostics, [], `${label}: generated TXT contains timing diagnostics`);
  assert.equal(snapshot.parts, 2, `${label}: two hands were not retained`);
  assert.equal(snapshot.voiceCount, 2, `${label}: TXT voice count changed`);
  assert(snapshot.rendered.some((svg) => svg.width > 0 && svg.height > 0 && svg.primitives > 30),
    `${label}: no nonempty, measurable score SVG was rendered`);
  assert.equal(snapshot.errorOverlays, 0, `${label}: the rendered score still contains error overlays`);
  assert(snapshot.measurePositions.every((positions) => positions.length === 118
    && positions.every((position, index) => position === index * 3840)),
  `${label}: a beat overflow changed a measure boundary or measure count`);
  const attacks = snapshot.notes
    .filter((note) => !note.grace && windows.some(([start, end]) => note.start >= start && note.start < end))
    .map(({ part, pitch, start }) => ({ part, pitch, start }));
  assert.deepEqual(attacks, expected, `${label}: measure 8/9 attacks were shifted, omitted, or duplicated`);
  return attacks;
}

let browser;
let page;
let stage = "launch";
const browserErrors = [];
const results = [];
try {
  const executable = process.env.BROWSER_EXECUTABLE_PATH;
  browser = await chromium.launch({
    ...(executable ? { executablePath: executable } : { channel: "msedge" }),
    headless: true,
    args: ["--no-sandbox"],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("dialog", async (dialog) => {
    browserErrors.push(`Unexpected ${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss();
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app && document.querySelector("#score-pane svg"));

  for (const format of ["keyboard", "number"]) {
    stage = `${format}: import`;
    await page.evaluate(({ input, name }) => {
      window.__midiTripletImportDone = null;
      window.__midiTripletImportError = null;
      void window.__app.importBytes(Uint8Array.from(input), name).then((ok) => {
        window.__midiTripletImportDone = ok;
      }).catch((error) => {
        window.__midiTripletImportError = String(error?.stack ?? error);
        window.__midiTripletImportDone = false;
      });
    }, { input: [...bytes], name: basename(midiPath) });
    await page.locator(".midi-import-box").waitFor();
    const midiRowSelect = (label) => page.locator(".midi-import-box .modal-row")
      .filter({ has: page.locator("span").filter({ hasText: new RegExp(`^${label}$`) }) }).locator("select");
    assert.equal(await midiRowSelect("推荐量化").inputValue(), "16",
      `${format}: the audited fixture no longer defaults to 16th-note quantization`);
    await midiRowSelect("导入后格式").selectOption(format);
    await acceptFixtureImport(page, page.getByRole("button", { name: "导入并转为简谱", exact: true }));
    await page.waitForFunction(() => window.__midiTripletImportDone !== null, null, { timeout: 60000 });
    const imported = await page.evaluate(() => ({
      ok: window.__midiTripletImportDone, error: window.__midiTripletImportError,
    }));
    assert.equal(imported.ok, true, `${stage}: import failed: ${imported.error ?? "see browser errors"}`);
    await page.waitForFunction(() => document.querySelector("#score-pane svg"));

    const before = await page.evaluate(browserSnapshot);
    await writeFile(join(output, `${format}-import.json`), JSON.stringify(before, null, 2));
    await page.screenshot({ path: join(output, `${format}-import.png`) });
    const keyAttacks = checkSnapshot(before, format, stage);

    stage = `${format}: save and reload`;
    // Use the editor's real save encoding, write and read the bytes, then
    // enter its decoded-file loadText path. Keep the active TXT session, as
    // loadText intentionally expects its existing TXT options for .txt files.
    const savedBytes = await page.evaluate(() => [...window.__app.documentBytes()]);
    const savedPath = join(output, `${format}-saved.txt`);
    await writeFile(savedPath, new Uint8Array(savedBytes));
    const savedText = await readFile(savedPath, "utf8");
    assert.equal(savedText, before.text, `${stage}: save encoding changed the text`);
    await page.evaluate(({ text, name }) => window.__app.loadText(text, name), {
      text: savedText, name: basename(savedPath),
    });
    const after = await page.evaluate(browserSnapshot);
    checkSnapshot(after, format, stage);
    assert.deepEqual(after.notes, before.notes, `${stage}: attacks, grace notes, or tied note ends changed`);
    assert.deepEqual(after.measurePositions, before.measurePositions, `${stage}: measure timing changed`);
    assert.equal(after.text, before.text, `${stage}: reopening changed the saved document`);
    await writeFile(join(output, `${format}-reload.json`), JSON.stringify(after, null, 2));

    stage = `${format}: fresh TXT import`;
    // Browser.newPage starts a separate context: no active TXT options,
    // document session, or saved preference can supply missing metadata.
    const previousPage = page;
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("dialog", async (dialog) => {
      browserErrors.push(`Unexpected ${dialog.type()}: ${dialog.message()}`);
      await dialog.dismiss();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__app && document.querySelector("#score-pane svg"));
    // Startup displays the bundled keyboard sample. Clear it using the
    // regular decoded JPW load path, which also clears its TXT options.
    await page.evaluate(() => window.__app.loadText(
      ".Title\nTitle = {Fresh TXT import}\nKeyAndMeters = {1=C,4/4}\n.Voice\n0--- |]\n", null,
    ));
    assert.equal(await page.evaluate(() => window.__app.documentFormat), "jpw",
      `${stage}: the new session must start outside TXT mode`);
    assert.equal(await page.evaluate(() => window.__app.slashOptions), null,
      `${stage}: the new session must not inherit TXT options`);
    await page.evaluate(({ input, name }) => {
      window.__midiTripletImportDone = null;
      window.__midiTripletImportError = null;
      void window.__app.importBytes(Uint8Array.from(input), name).then((ok) => {
        window.__midiTripletImportDone = ok;
      }).catch((error) => {
        window.__midiTripletImportError = String(error?.stack ?? error);
        window.__midiTripletImportDone = false;
      });
    }, { input: [...await readFile(savedPath)], name: basename(savedPath) });
    await page.locator(".slash-import-box").waitFor();
    await acceptFixtureImport(page, page.getByRole("button", { name: "导入为 2 声部简谱", exact: true }));
    await page.waitForFunction(() => window.__midiTripletImportDone !== null, null, { timeout: 60000 });
    const freshImport = await page.evaluate(() => ({
      ok: window.__midiTripletImportDone, error: window.__midiTripletImportError,
    }));
    assert.equal(freshImport.ok, true, `${stage}: ${freshImport.error ?? "import failed"}`);
    const fresh = await page.evaluate(browserSnapshot);
    checkSnapshot(fresh, format, stage);
    assert.deepEqual(fresh.notes, before.notes, `${stage}: attacks, grace notes, or tied note ends changed`);
    assert.deepEqual(fresh.measurePositions, before.measurePositions, `${stage}: measure timing changed`);
    await writeFile(join(output, `${format}-fresh-import.json`), JSON.stringify(fresh, null, 2));
    await page.screenshot({ path: join(output, `${format}-fresh-import.png`) });
    await previousPage.close();
    results.push({ format, attacks: before.notes.filter((note) => !note.grace).length,
      measures: before.measurePositions[0].length, keyAttacks, savedPath, freshImport: true });
  }
  assert.deepEqual(browserErrors, [], "browser console/runtime errors occurred");
  await writeFile(join(output, "results.json"), JSON.stringify({ passed: true, results, browserErrors }, null, 2));
  console.log(JSON.stringify({ passed: true, artifacts: output, results }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  await writeFile(join(output, "failure.json"), JSON.stringify({
    stage, message: String(error?.stack ?? error), browserErrors, results,
  }, null, 2));
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise((closed) => server.close(closed));
}
