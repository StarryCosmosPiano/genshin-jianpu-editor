// Real browser regression for independent staff keyboard/pointer ghosts and input-first hit testing.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

let server;
let origin = process.env.APP_TEST_URL;
if (!origin) {
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
  server = createServer(async (request, response) => {
    try {
      const requested = decodeURIComponent((request.url ?? "/").split("?")[0]);
      const file = join(process.cwd(), "dist", normalize(requested === "/" ? "/index.html" : requested));
      const bytes = await readFile(file);
      response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" }); response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [], results = [];
page.on("pageerror", error => errors.push(error.message));
const check = (label, value) => { assert.ok(value, label); results.push(label); };
const ready = () => page.waitForFunction(() => {
  const app = window.__app, pane = document.getElementById("staff-pane");
  return app?.isStaffPreviewCurrent() && pane?.dataset.staffRevision === String(app.getStaffPreviewSnapshot().revision)
    && pane.getAttribute("aria-busy") === "false" && document.querySelector("#staff-pages [data-staff-ref]");
}, { timeout: 30000 });
const inputState = () => page.evaluate(() => window.__app.getStaffEditorState());
const heard = () => page.evaluate(() => window.__staffAuditions.at(-1)?.map(note => note.pitch) ?? []);
const pointFor = (tick, degreeAboveE = 0, ruler = false) => page.evaluate(async ({ tick, degreeAboveE, ruler }) => {
  const app = window.__app, api = await window.__staffPreviewTest(), doc = await api.prepareStaffPreview(app.getStaffPreviewSnapshot());
  const rendered = doc.renderPage(0), span = rendered.inputSpans.find(s => s.partIndex === 0 && s.measureIndex === 0);
  const anchor = api.staffSnapAnchors(span).find(a => Math.abs(a.tick - tick) < 1e-8);
  const svgY = ruler ? span.rulerY : span.bottomLineY - degreeAboveE * span.lineSpacing / 2;
  const point = new DOMPoint(anchor.x, svgY).matrixTransform(document.querySelector("#staff-pages svg").getScreenCTM());
  doc.dispose(); return { x: point.x, y: point.y, svgX: anchor.x, svgY, lineSpacing: span.lineSpacing };
}, { tick, degreeAboveE, ruler });
const fixture = `.Title\nTitle = {独立五线谱光标}\nKeyAndMeters = {1=C,4/4}\n.Voice\n3 0 0 0 |0 0 0 0 |]\n`;
try {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app?.isStaffPreviewCurrent());
  await page.evaluate(text => { const app = window.__app; app.documentFormat = "jpw"; app.slashOptions = null; app.setText(text); app.setEngravingStyle({ ...app.engravingStyle, rhythmGuideMode: "manual", rhythmGuideDivision: 4, rhythmGuideDotted: false }); }, fixture);
  await page.selectOption("#staff-view-select", "staff"); await ready();
  await page.evaluate(() => {
    window.__staffAuditions = [];
    window.__app._player = { state: "stopped", stop() {}, stopAudition() {}, audition(notes) { window.__staffAuditions.push(notes.map(note => ({ ...note }))); return Promise.resolve(); } };
  });
  await page.locator("#staff-pages [data-staff-ref]").first().click();
  await page.keyboard.press("n");
  await ready();
  check("N starts the keyboard cursor at the selected note position", (await inputState()).cursor?.offset === "0" && (await inputState()).cursor?.focusPitch === 64);
  const initial = await page.evaluate(() => {
    const column = document.querySelector('[data-staff-input-column="cursor"]'), ghost = document.querySelector('[data-staff-input-overlay="cursor"] ellipse');
    return { x: Number(column?.getAttribute("x1")), columnStroke: column ? getComputedStyle(column).stroke : null,
      headFill: ghost ? getComputedStyle(ghost).fill : null, focusShadow: getComputedStyle(document.getElementById("staff-pane")).boxShadow };
  });
  check("persistent keyboard cursor is a dark gold vertical column", initial.columnStroke === "rgb(156, 112, 19)");
  check("input entry preserves the real selected note and omits its overlapping ghost", initial.headFill === null
    && await page.evaluate(() => window.__app.getStaffSelectionState().notes.length === 1));
  check("staff keyboard focus has no purple frame", initial.focusShadow === "none");
  const sourceBeforeHover = await page.evaluate(() => window.__app.getText()), cursorBeforeHover = (await inputState()).cursor;
  const auditionCountBeforeHover = await page.evaluate(() => window.__staffAuditions.length);
  const hoverPoint = await pointFor(1, 1);
  await page.mouse.move(hoverPoint.x, hoverPoint.y);
  check("pointer ghost coexists with the persistent keyboard ghost", await page.locator('[data-staff-input-overlay="hover"]').count() === 1 && await page.locator('[data-staff-input-overlay="cursor"]').count() === 1);
  check("hover ghost shows only a notehead and required ledger lines", await page.locator('[data-staff-input-column="hover"]').count() === 0);
  check("ghost notehead has fine dark purple outline", await page.locator('[data-staff-input-overlay="hover"] ellipse').evaluate(head => {
    const style = getComputedStyle(head); return style.fill === "none" && style.stroke === "rgb(117, 82, 158)" && style.strokeWidth === "0.7px";
  }));
  check("hover preserves keyboard pitch and beat", JSON.stringify((await inputState()).cursor) === JSON.stringify(cursorBeforeHover));
  check("hover never rewrites the score", await page.evaluate(() => window.__app.getText()) === sourceBeforeHover);
  check("pointer hovering never auditions a note", await page.evaluate(() => window.__staffAuditions.length) === auditionCountBeforeHover);
  await mkdir(join(process.cwd(), "artifacts", "staff-preview"), { recursive: true });
  await page.screenshot({ path: join(process.cwd(), "artifacts", "staff-preview", "independent-staff-cursors.png") });
  await page.keyboard.press("ArrowRight");
  check("right arrow advances the gold column while pointer preview stays", (await inputState()).cursor?.offset === "1" && await page.locator('[data-staff-input-overlay="hover"]').count() === 1);
  check("arrow keeps the selected note written staff height", (await inputState()).cursor?.step === "E" && (await inputState()).cursor?.octave === 4);
  await page.mouse.move(2, 2);
  check("pointer leave removes only the pointer ghost", await page.locator('[data-staff-input-overlay="hover"]').count() === 0 && await page.locator('[data-staff-input-overlay="cursor"]').count() === 1);
  await page.keyboard.press("Enter"); await ready();
  check("Enter writes the keyboard ghost even after hovering another pitch", await page.evaluate(() => {
    const chord = window.__app.painter.score.parts[0].measures[0].entries.find(e => e.notes?.some(n => !n.rest) && e.position.toString() === "1");
    return chord?.notes.some(n => n.pitch === 64) && !chord.notes.some(n => n.pitch === 65);
  }));
  check("Enter auditions the exact keyboard ghost pitch", JSON.stringify(await heard()) === "[64]");
  await page.keyboard.press("Control+z"); await ready();
  check("Enter input undoes as one score edit", await page.evaluate(() => window.__app.getText()) === sourceBeforeHover);
  const exact = await pointFor(0, 0), sourceBeforeExact = await page.evaluate(() => window.__app.getText());
  await page.mouse.click(exact.x, exact.y);
  check("exact beat and written pitch select the existing note without insertion", await page.evaluate(() => window.__app.getStaffSelectionState().primary?.pitch === 64 && window.__app.getStaffSelectionState().notes.length === 1) && await page.evaluate(() => window.__app.getText()) === sourceBeforeExact);
  check("exact selected note in N auditions its exact pitch", JSON.stringify(await heard()) === "[64]");
  check("selected real notes use light purple", await page.evaluate(() => {
    const selected = document.querySelector("#staff-pages .staff-selected"); return selected && getComputedStyle(selected).fill === "rgb(201, 182, 228)";
  }));
  check("hover and keyboard ghost leave exact selected real note visibly light purple", await page.locator('[data-staff-input-overlay] ellipse').count() === 0
    && await page.locator('[data-staff-input-column="cursor"]').count() === 1 && await page.locator('[data-staff-input-column="hover"]').count() === 0);
  await page.screenshot({ path: join(process.cwd(), "artifacts", "staff-preview", "selected-staff-cursor.png") });
  const existingRuler = await pointFor(0, 0, true);
  await page.mouse.click(existingRuler.x, existingRuler.y);
  check("unselected real note does not suppress the keyboard ghost", await page.evaluate(() => window.__app.getStaffSelectionState().notes.length === 0)
    && await page.locator('[data-staff-input-overlay="cursor"] ellipse').count() === 1);
  await page.mouse.click(exact.x, exact.y);
  const pendingOnlyText = await page.evaluate(() => window.__app.getText());
  await page.keyboard.press("2");
  check("N half-note key changes only the pending duration", (await inputState()).durationDivision === 2 && await page.evaluate(() => window.__app.getText()) === pendingOnlyText);
  await page.keyboard.press("4");
  check("N eighth-note key changes only the pending duration", (await inputState()).durationDivision === 8 && await page.evaluate(() => window.__app.getText()) === pendingOnlyText);
  await page.keyboard.press(".");
  check("N dot changes only pending notation even with a real selected note", (await inputState()).dotted && await page.evaluate(() => window.__app.getText()) === pendingOnlyText);
  check("selected source note keeps its original quarter-note duration", await page.evaluate(() => window.__app.getStaffSelectionState().primary?.chord.duration.toString() === "1"));
  await page.keyboard.press("."); await page.keyboard.press("3");
  const adjacentPitch = await pointFor(0, 1);
  await page.mouse.click(adjacentPitch.x, adjacentPitch.y); await ready();
  check("N click on adjacent written pitch adds a chord tone instead of selecting old note", await page.evaluate(() => {
    const chord = window.__app.painter.score.parts[0].measures[0].entries.find(e => e.notes?.some(n => !n.rest));
    return chord?.notes.some(n => n.pitch === 64) && chord.notes.some(n => n.pitch === 65);
  }));
  check("pointer insertion auditions only the added pitch", JSON.stringify(await heard()) === "[65]");
  check("click moves persistent keyboard cursor to the clicked pitch and beat", (await inputState()).cursor?.offset === "0" && (await inputState()).cursor?.step === "F" && (await inputState()).cursor?.octave === 4);
  const wideHitPoint = await pointFor(2, 2);
  // Dispatch through an old glyph with the coordinates of another exact column.
  // This directly reproduces the broad-hitbox case without relying on font metrics.
  await page.locator("#staff-pages [data-staff-ref]").first().dispatchEvent("click", { clientX: wideHitPoint.x, clientY: wideHitPoint.y, bubbles: true });
  await ready();
  check("N prioritizes snapped input even when event target is an old glyph hitbox", await page.evaluate(() => {
    const chord = window.__app.painter.score.parts[0].measures[0].entries.find(e => e.notes?.some(n => !n.rest) && e.position.toString() === "2");
    return chord?.notes.some(n => n.pitch === 67);
  }));
  const rulerPoint = await pointFor(3, 0, true);
  await page.mouse.click(rulerPoint.x, rulerPoint.y);
  check("ruler click updates beat while retaining the keyboard written pitch", (await inputState()).cursor?.offset === "3" && (await inputState()).cursor?.step === "G" && (await inputState()).cursor?.octave === 4);
  await page.keyboard.press("ArrowUp");
  check("up arrow updates written ghost pitch and auditions A4", (await inputState()).cursor?.step === "A" && (await inputState()).cursor?.focusPitch === 69 && JSON.stringify(await heard()) === "[69]");
  await page.keyboard.press("ArrowDown");
  check("down arrow restores written ghost pitch and auditions G4", (await inputState()).cursor?.step === "G" && (await inputState()).cursor?.focusPitch === 67 && JSON.stringify(await heard()) === "[67]");
  await page.keyboard.press("Enter"); await ready();
  check("Enter after ruler click inserts retained pitch at its new beat", await page.evaluate(() => {
    const chord = window.__app.painter.score.parts[0].measures[0].entries.find(e => e.notes?.some(n => !n.rest) && e.position.toString() === "3");
    return chord?.notes.some(n => n.pitch === 67);
  }));
  await page.mouse.move(hoverPoint.x, hoverPoint.y);
  await page.keyboard.press("Escape");
  check("Escape removes both independent input overlays", await page.locator("[data-staff-input-overlay]").count() === 0);
  // Letter entry audition uses the actual resulting pitch, including B->C octave spelling.
  await page.evaluate(text => {
    const app = window.__app; app.setText(text); app.setInputDurationDivision(4);
  }, fixture); await ready();
  await page.locator("#staff-pages [data-staff-ref]").first().click(); await page.keyboard.press("n"); await ready();
  for (const [letter, expectedPitch] of [["c", 60], ["d", 62], ["e", 64], ["f", 65], ["g", 67], ["a", 69], ["b", 71]]) {
    const ruler = await pointFor(1, 0, true); await page.mouse.click(ruler.x, ruler.y);
    // Existing E4 at this offset is selected by Enter if already present, so reset this empty slot before each letter.
    await page.keyboard.press(letter); await ready();
    check(`${letter.toUpperCase()} letter input auditions exact ${expectedPitch} pitch`, JSON.stringify(await heard()) === `[${expectedPitch}]`);
    await page.keyboard.press("Control+z"); await ready();
  }
  await page.evaluate(text => {
    const app = window.__app; app.setInputMode(false); app.documentFormat = "keyboard";
    app.slashOptions = { kind: "keyboard", voiceCount: 1, instrumentName: "钢琴", title: "TXT 五线谱最细时值", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4, symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: 16, braceMode: "arpeggio", bracketMode: "triplet", barMode: "grace", angleMode: "subdivide", parenMode: "chord", ordering: "pitch-asc", showExplicitRests: true };
    app.setText(text); app.setRhythmEditDivision(16); app.setInputDurationDivision(16); app._inputDurationDotted = false;
  }, `键盘谱\n4/4拍：\n点=16分音符\nA.../B0../C.../D.../\n`); await ready();
  await page.locator("#staff-pages [data-staff-ref]").first().click(); await page.keyboard.press("n"); await ready();
  const txtBefore = await page.evaluate(() => window.__app.getText());
  await page.keyboard.press("6");
  check("TXT rejects 32nd pending duration without changing source", (await inputState()).durationDivision === 16 && await page.evaluate(() => window.__app.getText()) === txtBefore);
  await page.keyboard.press("7");
  check("TXT rejects 64th pending duration without changing source", (await inputState()).durationDivision === 16 && await page.evaluate(() => window.__app.getText()) === txtBefore);
  await page.keyboard.press(".");
  check("TXT rejects dot at its finest supported duration", !(await inputState()).dotted && await page.evaluate(() => window.__app.getText()) === txtBefore);
  const unsupportedInsertion = await page.evaluate(() => {
    const app = window.__app; app.setInputDurationDivision(null);
    const before = app.getText();
    const changed = app.insertStaffInputNote({ partIndex: 0, measureIndex: 0, offset: "1/4", midi: 65, step: "F", octave: 4, gridDivision: 64 });
    return { changed, same: before === app.getText() };
  });
  check("TXT auto input rejects unsupported 64th duration instead of quantizing", !unsupportedInsertion.changed && unsupportedInsertion.same);
  check("no browser runtime errors", errors.length === 0);
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ results, errors, state: await inputState() }, null, 2)); throw error;
} finally { await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
