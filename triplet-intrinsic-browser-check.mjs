// Build first, or set APP_TEST_URL to an existing development server.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";
import { installSavePickerTestBridge } from "./browser-save-test-helpers.mjs";

let server;
let url = process.env.APP_TEST_URL;
if (!url) {
  const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
    ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
  server = createServer(async (request, response) => {
    try {
      const path = normalize(decodeURIComponent((request.url ?? "/").split("?")[0]));
      const file = path === "/" || path === "\\" ? "index.html" : path;
      const data = await readFile(join(process.cwd(), "dist", file));
      response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
      response.end(data);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
}

const output = "artifacts/triplet-intrinsic-20261020";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const browserErrors = [];
page.on("pageerror", error => browserErrors.push(error.message));
page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const fixture = "Q  [DHQ(VW)]/S   /D   /F   /\n";
let fixtureStats = null;

try {
  await page.addInitScript(() => localStorage.setItem("jpeditor:workspace-mode:v1", "desktop"));
  const saves = await installSavePickerTestBridge(page);
  await page.goto(url);
  await page.waitForFunction(() => window.__app?.painter.score);
  const dialog = page.locator(".slash-import-box");
  const field = name => dialog.locator(`[data-slash-import="${name}"]`);
  const footer = dialog.locator(".modal-footer");
  const open = async (text, name) => {
    await page.evaluate(({ text, name }) => {
      void window.__app.importBytes(new TextEncoder().encode(text), name);
    }, { text, name });
    await dialog.waitFor();
  };
  const waitPreview = async () => {
    await page.waitForFunction(() => {
      const preview = document.querySelector(".slash-score-preview");
      return preview && !preview.hasAttribute("aria-busy") && preview.querySelector("svg");
    });
  };
  const configure = async () => {
    const details = dialog.locator("details").filter({ has: page.locator('[name="noteDivision"]') });
    if (!await details.evaluate(element => element.open)) await details.locator("summary").click();
    await dialog.locator('[name="noteDivision"]').selectOption("16");
    await dialog.locator('[name="spaceDivision"]').selectOption("16");
    await field("beats").fill("4");
    await field("beat-type").selectOption("4");
    await field("bracket").selectOption("triplet");
    await field("paren").selectOption("chord");
    await waitPreview();
  };
  const confirm = async () => {
    const dirty = await page.evaluate(() => window.__app.hasUnsavedChanges());
    await footer.getByRole("button", { name: /^导入为/ }).click();
    if (dirty) await page.getByRole("button", { name: "不保存", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => window.__app.documentFormat === "keyboard"
      && document.querySelector("#score-pane svg"));
  };
  const snapshot = () => page.evaluate(() => {
    const app = window.__app;
    return {
      text: app.getText(),
      options: { note: app.slashOptions.noteDivision, space: app.slashOptions.spaceDivision,
        bracket: app.slashOptions.bracketMode, paren: app.slashOptions.parenMode },
      diagnostics: app._slashTimingDiagnostics.map(item => ({ severity: item.severity, message: item.message })),
      overlays: document.querySelectorAll("#score-pane .slash-measure-diagnostics").length,
      rows: app.painter.score.parts.flatMap((part, partIndex) => part.measures.flatMap((measure, measureIndex) =>
        measure.entries.filter(entry => entry.notes?.length).map(chord => ({
          part: partIndex, measure: measureIndex,
          at: Number(chord.position.toFloat().toFixed(8)),
          duration: Number(chord.duration.toFloat().toFixed(8)), rest: chord.rest,
          pitches: chord.notes.filter(note => !note.rest).map(note => note.pitch).sort((a, b) => a - b),
          tuplet: chord.notes.some(note => note.tuplet !== null),
        })))),
      mapped: app._sourceNotes.map(item => ({
        text: app.getText().slice(item.from, item.to), from: item.from, to: item.to,
        at: item.chord.position.toString(), duration: item.chord.duration?.toString(),
        visible: app.painter.noteGroupEls(item.chord, item.note).some(hit => hit.element.isConnected),
      })),
    };
  });

  const originalText = await page.evaluate(() => window.__app.getText());
  await open(fixture, "三连音自身时值.txt");
  await configure();
  check("preview uses intrinsic and space sixteenths with a triplet bracket",
    await dialog.locator('[name="noteDivision"]').inputValue() === "16"
    && await dialog.locator('[name="spaceDivision"]').inputValue() === "16"
    && await field("bracket").inputValue() === "triplet");
  check("preview sample beat has no timing error", !await dialog.locator(".slash-score-preview-status.has-error").isVisible());
  const preview = await dialog.locator(".slash-score-preview svg").evaluate(svg => {
    // Entry groups also include the final barline; octave dots may share a
    // text node with the digit. Count numeric note entries and their digits.
    const entryTexts = [...svg.querySelectorAll("g.entry")].map(entry => entry.textContent)
      .filter(text => /[1-7]/.test(text));
    return { entries: entryTexts.length,
      pitches: entryTexts.reduce((sum, text) => sum + (text.match(/[1-7]/g)?.length ?? 0), 0), entryTexts };
  });
  check(`preview displays all eight written positions (${JSON.stringify(preview)})`, preview.entries === 8);
  check(`preview displays all nine pitches including the chord (${JSON.stringify(preview)})`, preview.pitches === 9);
  check("preview leaves the current document untouched", await page.evaluate(() => window.__app.getText()) === originalText);
  await page.screenshot({ path: join(output, "import-preview.png") });
  await confirm();
  await page.evaluate(() => { window.__app.setInputMode(false); window.__app.setCodePaneCollapsed(false); });

  const imported = await snapshot();
  check("confirmed import preserves the entire fixture", imported.text.startsWith(fixture.trimEnd()));
  assert.deepEqual(imported.options, { note: 16, space: 16, bracket: "triplet", paren: "chord" });
  check("confirmed import has no timing diagnostics or red overlays", imported.diagnostics.length === 0 && imported.overlays === 0);
  check("four bracket positions retain their quarter-sixteenth total span",
    imported.rows.length === 8 && imported.rows.slice(1, 5).every((row, index) =>
      Math.abs(row.at - (0.75 + index / 16)) < 1e-8 && Math.abs(row.duration - 1 / 16) < 1e-8));
  check("last bracket position retains both chord pitches", imported.rows[4].pitches.length === 2);
  check("every imported pitch has a mounted source mapping", imported.mapped.length === 9
    && imported.mapped.every(item => item.visible));

  // Click each of the five pitch glyphs inside [DHQ(VW)], including both
  // simultaneous chord tones. Validate the actual CodeMirror source range.
  const bracketStart = imported.text.indexOf("[DHQ(VW)]");
  const members = imported.mapped.filter(item => item.from > bracketStart && item.to <= bracketStart + "[DHQ(VW)]".length);
  assert.deepEqual(members.map(item => item.text).sort(), ["D", "H", "Q", "V", "W"].sort());
  for (const member of members) {
    const point = await page.evaluate(({ from, to }) => {
      const app = window.__app;
      const source = app._sourceNotes.find(item => item.from === from && item.to === to);
      const element = app.painter.noteGroupEls(source.chord, source.note)[0].element;
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      const bound = app.painter.pageItemForTarget(element).bound;
      const center = new DOMPoint((bound.left + bound.right) / 2, (bound.top + bound.bottom) / 2)
        .matrixTransform(element.getScreenCTM());
      return { x: center.x, y: center.y };
    }, member);
    await page.mouse.click(point.x, point.y);
    const selected = await page.evaluate(() => {
      const app = window.__app;
      const range = app.view.state.selection.main;
      const selected = app._selectedNotes.at(-1);
      return { text: app.getText().slice(range.from, range.to), from: range.from, to: range.to,
        source: selected && [selected.source.from, selected.source.to] };
    });
    assert.deepEqual(selected, { text: member.text, from: member.from, to: member.to, source: [member.from, member.to] },
      `clicking ${member.text} did not select its exact source token`);
    checks.push(`clicking bracket member ${member.text} selects its own source token`);
  }
  check("member selection leaves the score source unchanged", await page.evaluate(() => window.__app.getText()) === imported.text);
  await page.screenshot({ path: join(output, "imported-members.png") });

  // Exercise the real save encoder; the shared bridge replaces only the OS
  // destination picker and records bytes once its writable handle is closed.
  const pendingSave = saves.next();
  await page.keyboard.press("Control+s");
  const saved = await pendingSave;
  const savedBytes = await readFile(await saved.path());
  const savedText = new TextDecoder().decode(savedBytes);
  check("saved TXT retains reviewed intrinsic options", savedText.includes("@jpeditor")
    && savedText.startsWith(fixture.trimEnd()));
  await writeFile(join(output, "saved.txt"), savedBytes);
  await open(savedText, saved.suggestedFilename());
  await waitPreview();
  check("saved TXT reopens with reviewed bracket and duration choices",
    await field("bracket").inputValue() === "triplet"
    && await dialog.locator('[name="noteDivision"]').inputValue() === "16"
    && await dialog.locator('[name="spaceDivision"]').inputValue() === "16");
  check("reopened preview remains free of timing errors", !await dialog.locator(".slash-score-preview-status.has-error").isVisible());
  await confirm();
  const reopened = await snapshot();
  assert.deepEqual(reopened.rows, imported.rows, "saving and reopening changed member timing or pitches");
  assert.deepEqual(reopened.options, imported.options);
  check("reopened score retains all source mappings", reopened.mapped.length === 9 && reopened.mapped.every(item => item.visible));
  check("reopened score has no timing diagnostics or red overlays", reopened.diagnostics.length === 0 && reopened.overlays === 0);
  await page.screenshot({ path: join(output, "reopened.png") });

  if (process.env.SLASH_IMPORT_FIXTURE) {
    const fullFixture = await readFile(process.env.SLASH_IMPORT_FIXTURE, "utf8");
    await open(fullFixture, "城南花开.txt");
    await configure();
    const status = await dialog.locator(".slash-score-preview-status").textContent();
    await page.screenshot({ path: join(output, "full-fixture-preview.png") });
    await confirm();
    const full = await snapshot();
    fixtureStats = { characters: fullFixture.length, chords: full.rows.length,
      mappedPitches: full.mapped.length, status, diagnostics: full.diagnostics };
    await page.screenshot({ path: join(output, "full-fixture.png") });
  }
  saves.assertNoDownloads();
  assert.deepEqual(browserErrors, [], "browser runtime errors");
  const report = { checks: checks.length, names: checks, preview, fixtureStats, browserErrors };
  await writeFile(join(output, "results.json"), JSON.stringify(report, null, 2));
  console.log(`triplet-intrinsic-browser-check: ok (${checks.length} checks)\n${JSON.stringify({ output, fixtureStats })}`);
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
