// Staff keyboard, paper, and pointer previews use the real browser/App bridge.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { installSavePickerTestBridge, launchSaveCheckBrowser } from "./browser-save-test-helpers.mjs";

let server;
let origin = process.env.APP_TEST_URL;
if (!origin) {
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm" };
  server = createServer(async (request, response) => {
    try {
      const file = join(process.cwd(), "dist", normalize(decodeURIComponent((request.url ?? "/").split("?")[0] === "/" ? "/index.html" : (request.url ?? "/").split("?")[0])));
      response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" }); response.end(await readFile(file));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
}
const browser = await launchSaveCheckBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
const savedFiles = await installSavePickerTestBridge(page);
const errors = [], results = [];
page.on("pageerror", error => errors.push(error.message));
const check = (label, value) => { assert.ok(value, label); results.push(label); };
const ready = async () => {
  await page.waitForFunction(() => {
    const app = window.__app, pane = document.getElementById("staff-pane");
    return app?.isStaffPreviewCurrent() && pane.dataset.staffRevision === String(app.getStaffPreviewSnapshot().revision)
      && pane.getAttribute("aria-busy") === "false" && document.querySelector("#staff-pages [data-staff-ref]");
  }, { timeout: 30000 });
};
const fixture = `.Title\nTitle = {五线谱编辑回归}\nSubTitle = {鼠标与键盘}\nLyricist = {词作者}\nComposer = {曲作者}\nKeyAndMeters = {1=C,4/4}\n.Voice\n3 0 0 0 |1 3 4 0 |]\n`;
const first = async () => {
  await page.evaluate(() => { if (window.__app.interactionMode === "view") window.__app.setInteractionMode("select"); });
  await page.locator("#staff-pages [data-staff-ref]").first().click();
};
const pitch = () => page.evaluate(() => window.__app.painter.score.parts[0].measures[0].entries.find(entry => entry.notes?.some(note => !note.rest)).notes[0].pitch);
try {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app?.isStaffPreviewCurrent());
  await page.evaluate(text => { const app = window.__app; app.documentFormat = "jpw"; app.slashOptions = null; app.setText(text); }, fixture);
  check("view order is jianpu / staff / compare", await page.locator("#staff-view-select option").allTextContents().then(labels => labels.join() === "简谱,五线谱,对照"));
  await page.selectOption("#staff-view-select", "staff"); await ready();
  await page.evaluate(() => {
    window.__app._player = { state: "stopped", stop() {}, stopAudition() {}, audition() { return Promise.resolve(); } };
  });
  check("first explicit staff choice opens staff", await page.locator("#score-surfaces").getAttribute("data-staff-view") === "staff");
  const geometry = await page.evaluate(async () => {
    const app = window.__app, api = await window.__staffPreviewTest();
    const doc = await api.prepareStaffPreview(app.getStaffPreviewSnapshot());
    const rendered = doc.renderPage(0), span = rendered.inputSpans.find(span => span.partIndex === 0 && span.measureIndex === 0);
    const base = api.staffPitchAtY(span, span.bottomLineY, 0);
    const halfStep = api.staffPitchAtY(span, span.bottomLineY - span.lineSpacing / 2, 0);
    const bass = api.staffPitchAtY({ ...span, clef: "bass" }, span.bottomLineY, 0);
    doc.dispose();
    return { base, halfStep, bass, anchors: span.gridAnchors.length, width: rendered.svg.viewBox.baseVal.width };
  });
  check("treble bottom E4 and next space F4", geometry.base.midi === 64 && geometry.halfStep.midi === 65);
  check("bass bottom G2 maps correctly", geometry.bass.midi === 43);
  check("real staff grid exposes empty cells", geometry.anchors >= 4);
  check("A4 uses current paper points", Math.abs(geometry.width - 595 * 96 / 72) < .01);
  await first();
  await page.evaluate(() => window.__app.setInputMode(true));
  await page.keyboard.press("ArrowUp"); await ready();
  check("plain staff up moves E4 to F4", await pitch() === 65);
  await page.keyboard.press("Alt+ArrowDown"); await ready();
  check("Alt down moves one semitone", await pitch() === 64);
  await page.keyboard.press("Control+z"); await ready();
  check("staff pitch edit shares undo", await pitch() === 65);
  await page.keyboard.press("Control+z"); await ready();
  check("second undo restores original E4", await pitch() === 64);
  await first();
  await ready();
  check("N enters staff input", await page.evaluate(() => window.__app.getStaffEditorState().inputEnabled));
  check("staff input hides the jianpu-only degree keypad", await page.locator("#score-input-keypad").isHidden());
  const sourceBeforeHover = await page.evaluate(() => window.__app.getText());
  await page.locator("#staff-pages [data-staff-ref]").first().click();
  check("clicking an existing note in N selects without rewriting", await page.evaluate(before =>
    window.__app.getText() === before && window.__app.getStaffSelectionState().notes.length === 1
    && window.__app.getStaffEditorState().inputEnabled, sourceBeforeHover));
  const selectedBeforeHover = await page.evaluate(() => {
    const app = window.__app;
    window.__hoverLayouts = 0;
    const resize = app.painter.resize.bind(app.painter);
    app.painter.resize = (...args) => { window.__hoverLayouts++; return resize(...args); };
    return app.getStaffSelectionState().notes.map(note => app.getStaffPreviewSnapshot().registry.refFor(note)?.id);
  });
  await page.mouse.move(5, 5);
  await page.locator("#staff-pages [data-staff-ref]").first().hover();
  check("hover renders exactly one dashed note", await page.locator('[data-staff-input-overlay="hover"]').count() === 1);
  check("hover preview omits the cursor column", await page.locator('[data-staff-input-column="hover"]').count() === 0);
  check("hover never mutates notation", await page.evaluate(() => window.__app.getText()) === sourceBeforeHover);
  check("hover preserves exact selection and never relayouts", await page.evaluate(expected =>
    window.__hoverLayouts === 0 && JSON.stringify(window.__app.getStaffSelectionState().notes.map(note =>
      window.__app.getStaffPreviewSnapshot().registry.refFor(note)?.id)) === JSON.stringify(expected), selectedBeforeHover));
  const pointer = await page.evaluate(async () => {
    const app = window.__app, api = await window.__staffPreviewTest();
    const doc = await api.prepareStaffPreview(app.getStaffPreviewSnapshot());
    const span = doc.renderPage(0).inputSpans.find(span => span.partIndex === 0 && span.measureIndex === 0);
    const anchor = span.gridAnchors.find(anchor => anchor.tick === 1);
    const matrix = document.querySelector("#staff-pages svg").getScreenCTM();
    const ruler = new DOMPoint(anchor.x, span.rulerY).matrixTransform(matrix);
    const note = new DOMPoint(anchor.x, span.bottomLineY - span.lineSpacing / 2).matrixTransform(matrix);
    doc.dispose(); return { ruler: { x: ruler.x, y: ruler.y }, note: { x: note.x, y: note.y } };
  });
  await page.mouse.click(pointer.ruler.x, pointer.ruler.y);
  check("ruler click moves cursor without adding notes", await page.evaluate(() => window.__app.getStaffEditorState().cursor.offset === "1" && window.__app.getText()) === sourceBeforeHover);
  await page.keyboard.press("ArrowRight");
  check("right moves one real rhythm tick", await page.evaluate(() => window.__app.getStaffEditorState().cursor.offset) === "2");
  await page.keyboard.press("ArrowLeft");
  check("left returns to the same tick without rewriting notes", await page.evaluate(() => window.__app.getStaffEditorState().cursor.offset === "1" && window.__app.getText()) === sourceBeforeHover);
  await page.mouse.click(pointer.note.x, pointer.note.y); await ready();
  check("staff click places F4 at exact ruler beat", await page.evaluate(() => window.__app.painter.score.parts[0].measures[0].entries.some(entry => entry.position.equals(1) && entry.notes?.some(note => note.pitch === 65 && !note.rest))));
  await page.keyboard.press("Control+z"); await ready();
  check("one undo removes the mouse insertion", await page.evaluate(() => window.__app.getText()) === sourceBeforeHover);
  const letterPosition = await page.evaluate(async () => {
    const app = window.__app, api = await window.__staffPreviewTest(), doc = await api.prepareStaffPreview(app.getStaffPreviewSnapshot());
    const span = doc.renderPage(0).inputSpans.find(span => span.partIndex === 0 && span.measureIndex === 1);
    const anchor = span.gridAnchors.find(anchor => anchor.tick === 3);
    const point = new DOMPoint(anchor.x, span.rulerY).matrixTransform(document.querySelector("#staff-pages svg").getScreenCTM());
    doc.dispose(); return { x: point.x, y: point.y };
  });
  await page.mouse.click(letterPosition.x, letterPosition.y);
  await page.keyboard.press("b"); await ready();
  check("B input uses the preceding F4 octave", await page.evaluate(() => window.__app.painter.score.parts[0].measures[1].entries.some(entry => entry.position.equals(3) && entry.notes?.some(note => note.pitch === 71))));
  await page.keyboard.press("c"); await ready();
  check("C at same beat stays C4 instead of nearest C5", await page.evaluate(() => window.__app.painter.score.parts[0].measures[1].entries.some(entry => entry.position.equals(3) && entry.notes?.some(note => note.pitch === 60))));
  await page.keyboard.press("Control+z"); await ready(); await page.keyboard.press("Control+z"); await ready();
  await page.keyboard.press("Escape");
  check("Escape removes previews", await page.locator("[data-staff-input-overlay]").count() === 0);
  await first(); await page.evaluate(() => { window.__app.setInputMode(true); window.__app.editStaffDuration(2); }); await ready();
  check("2 sets half-note duration", await page.evaluate(() => window.__app.painter.score.parts[0].measures[0].entries.find(entry => entry.notes?.some(note => !note.rest)).duration.toString()) === "2");
  await page.evaluate(() => window.__app.editStaffDuration(null)); await ready();
  check("dot sets dotted half duration", await page.evaluate(() => window.__app.painter.score.parts[0].measures[0].entries.find(entry => entry.notes?.some(note => !note.rest)).duration.toString()) === "3");
  await page.evaluate(() => window.__app.applyRenderSettings({ pageW: 842, pageH: 1191 })); await ready();
  const paper = await page.evaluate(async () => {
    const source = await window.__app.getPageExportSource(), svg = document.querySelector("#staff-pages svg");
    return { width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height, exportWidth: source.pages[0].widthPt,
      exportHeight: source.pages[0].heightPt, shown: document.querySelector(".staff-page").getBoundingClientRect().width, pane: document.getElementById("staff-pane").clientWidth };
  });
  check("A3 changes staff layout and export dimensions", Math.abs(paper.width - 842 * 96 / 72) < .01 && Math.abs(paper.height - 1191 * 96 / 72) < .01 && Math.abs(paper.exportWidth - 842) < .01 && Math.abs(paper.exportHeight - 1191) < .01);
  check("paper changes keep fit width", paper.shown <= paper.pane - 30);
  check("export strips interactive ruler and previews", await page.evaluate(async () => (await window.__app.getPageExportSource()).pages.every(page => !page.svg.querySelector(".staff-rhythm-guide,[data-staff-input-overlay]"))));
  await page.locator("#btn-export").click();
  await page.locator(".modal-box button", { hasText: "PDF（全部页面）" }).click();
  await page.locator(".watermark-dialog").waitFor();
  const a3Download = savedFiles.nextExport();
  await page.locator(".watermark-dialog footer button.primary").click();
  const a3Pdf = await readFile(await (await a3Download).path());
  check("actual A3 PDF keeps A3 physical size", a3Pdf.includes(Buffer.from("/MediaBox [0 0 842 1191]")));
  await page.evaluate(() => window.__app.applyRenderSettings({ pageW: 1191, pageH: 842 })); await ready();
  check("A3 landscape updates every export page", await page.evaluate(async () =>
    (await window.__app.getPageExportSource()).pages.every(page => Math.abs(page.widthPt - 1191) < .01 && Math.abs(page.heightPt - 842) < .01)));
  await page.evaluate(() => window.__app.applyRenderSettings({ pageW: 842, pageH: 1191 })); await ready();
  await page.locator('[data-staff-header="composer"]').click();
  check("composer header focuses composer field", await page.evaluate(() => document.activeElement?.value === "曲作者"));
  await page.keyboard.press("Escape");
  await ready();
  await first(); await page.locator("#staff-pages [data-staff-ref]").first().click({ button: "right" });
  check("staff right click opens shared note menu", await page.locator(".score-input-context-menu").count() > 0);
  await page.getByRole("menuitem", { name: "4分音符", exact: true }).click(); await ready();
  check("right menu edits duration and restores staff focus", await page.evaluate(() =>
    window.__app.painter.score.parts[0].measures[0].entries.find(entry => entry.notes?.some(note => !note.rest)).duration.toString() === "3/2"
    && document.activeElement?.id === "staff-pane"));
  await page.locator("#staff-pages [data-staff-ref]").first().click({ button: "right" });
  await page.keyboard.press("Escape");
  check("escape closes shared menu and restores staff focus", await page.evaluate(() =>
    !document.querySelector(".score-input-context-menu") && document.activeElement?.id === "staff-pane"));
  await page.evaluate(() => {
    const app = window.__app;
    app.setInputMode(false);
    app.setText(".Title\nTitle = {跨小节输入}\nKeyAndMeters = {1=C,4/4}\n.Voice\n0 0 0 0 |]\n");
  }); await ready();
  await page.locator("#staff-pane").focus(); await page.keyboard.press("n");
  await ready();
  const lastRulerPoint = await page.evaluate(async () => {
    const app = window.__app, api = await window.__staffPreviewTest(), doc = await api.prepareStaffPreview(app.getStaffPreviewSnapshot());
    const span = doc.renderPage(0).inputSpans[0], anchor = span.gridAnchors.find(anchor => anchor.tick === 3);
    const point = new DOMPoint(anchor.x, span.rulerY).matrixTransform(document.querySelector("#staff-pages svg").getScreenCTM());
    doc.dispose(); return { x: point.x, y: point.y };
  });
  await page.mouse.click(lastRulerPoint.x, lastRulerPoint.y);
  await page.keyboard.press("2");
  if (await page.evaluate(() => window.__app.getStaffEditorState().dotted)) await page.keyboard.press(".");
  const beforeLongInput = await page.evaluate(() => window.__app.getText());
  await page.keyboard.press("f"); await ready();
  check("staff half-note input at final beat preserves full tied duration", await page.evaluate(() => {
    const app = window.__app;
    const first = app.painter.score.parts[0].measures[0].entries.find(entry => entry.notes?.some(note => !note.rest));
    let note = first?.notes[0], beats = 0, guard = 0;
    while (note && guard++ < 10) { beats += note.chord.duration.toFloat(); note = note.tieNext; }
    return first?.position.toString() === "3" && beats === 2 && app.painter.score.parts[0].measures.length === 2;
  }));
  const firstTieDuration = () => page.evaluate(() => {
    const first = window.__app.painter.score.parts[0].measures[0].entries.find(entry => entry.notes?.some(note => !note.rest));
    let note = first?.notes[0], beats = 0, guard = 0;
    while (note && guard++ < 10) { beats += note.chord.duration.toFloat(); note = note.tieNext; }
    return beats;
  });
  const halfInputText = await page.evaluate(() => window.__app.getText());
  // Number keys change pending notation; the input context menu edits real notes.
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__app.setInteractionMode("select"));
  const firstSoundingRef = await page.evaluate(() => window.__app.getStaffPreviewSnapshot().registry.targets.find(target => !target.grace && !target.note.rest)?.ref.id);
  await page.locator(`#staff-pages [data-staff-ref="${firstSoundingRef}"]`).first().click();
  await page.evaluate(() => { window.__app.setInputMode(true); window.__app.editStaffDuration(2); }); await ready();
  check("absolute half-note command preserves a two-beat cross-bar chain", await firstTieDuration() === 2);
  await page.evaluate(() => window.__app.editStaffDuration(null)); await ready();
  check("dot extends the complete cross-bar chain to three beats", await firstTieDuration() === 3);
  const dottedInputText = await page.evaluate(() => window.__app.getText());
  await page.evaluate(() => window.__app.editStaffDuration(null)); await ready();
  check("second dot restores the complete cross-bar chain to two beats", await firstTieDuration() === 2);
  await page.keyboard.press("Control+z"); await ready();
  check("one undo restores the complete dotted cross-bar chain", await firstTieDuration() === 3 && await page.evaluate(() => window.__app.getText()) === dottedInputText);
  await page.keyboard.press("Control+z"); await ready();
  check("second undo restores the complete original half-note chain", await firstTieDuration() === 2 && await page.evaluate(() => window.__app.getText()) === halfInputText);
  await page.keyboard.press("Control+z"); await ready();
  check("cross-bar insertion undoes as one gesture", await page.evaluate(() => window.__app.getText()) === beforeLongInput);
  await page.evaluate(() => {
    const app = window.__app; app.setInputMode(false);
    app.setText(`.Title\nTitle = {真实刻度导航}\nKeyAndMeters = {1=C,4/4}\n.Voice\n{(3}1_ 0_ 0_) 0 0 0 |${Array(16).fill("1__").join(" ")} |]\n`);
    app.setEngravingStyle({ ...app.engravingStyle, rhythmGuideMode: "auto", rhythmGuideDotted: false });
  }); await ready();
  await first(); await page.keyboard.press("n"); await ready();
  const sourceBeforeNav = await page.evaluate(() => window.__app.getText());
  const placeRulerCursor = async (measureIndex, tick) => {
    const point = await page.evaluate(async ({ measureIndex, tick }) => {
      const app = window.__app, api = await window.__staffPreviewTest(), doc = await api.prepareStaffPreview(app.getStaffPreviewSnapshot());
      const span = doc.renderPage(0).inputSpans.find(span => span.partIndex === 0 && span.measureIndex === measureIndex);
      const anchor = api.staffSnapAnchors(span).find(anchor => Math.abs(anchor.tick - tick) < 1e-8);
      const point = new DOMPoint(anchor.x, span.rulerY).matrixTransform(document.querySelector("#staff-pages svg").getScreenCTM());
      doc.dispose(); return { x: point.x, y: point.y };
    }, { measureIndex, tick });
    await page.mouse.click(point.x, point.y);
  };
  const cursorAt = (measure, offset) => page.evaluate(({ measure, offset }) => {
    const cursor = window.__app.getStaffEditorState().cursor;
    return cursor?.measureIndex === measure && cursor.offset === offset;
  }, { measure, offset });
  await placeRulerCursor(0, 0);
  await page.keyboard.press("ArrowRight");
  check("actual controller visits first tuplet member", await cursorAt(0, "1/3"));
  const ghostAlignment = await page.evaluate(async () => {
    const app = window.__app, api = await window.__staffPreviewTest(), doc = await api.prepareStaffPreview(app.getStaffPreviewSnapshot());
    const span = doc.renderPage(0).inputSpans.find(span => span.partIndex === 0 && span.measureIndex === 0);
    const x = api.staffSnapAnchors(span).find(anchor => Math.abs(anchor.tick - 1 / 3) < 1e-8).x;
    const ghost = document.querySelector('[data-staff-input-overlay="cursor"] ellipse');
    doc.dispose(); return ghost && Math.abs(Number(ghost.getAttribute("cx")) - x) < .01;
  });
  check("tuplet keyboard cursor uses the mouse preview column", ghostAlignment);
  await page.keyboard.press("ArrowRight");
  check("actual controller skips binary tick inside triplet", await cursorAt(0, "2/3"));
  await page.keyboard.press("ArrowRight");
  check("actual controller exits tuplet at its real boundary", await cursorAt(0, "1"));
  await page.keyboard.press("ArrowLeft");
  check("actual controller returns to preceding tuplet member", await cursorAt(0, "2/3"));
  await placeRulerCursor(0, 3.5);
  await page.keyboard.press("ArrowRight");
  check("actual controller crosses into next measure", await cursorAt(1, "0"));
  await page.keyboard.press("ArrowRight");
  check("next measure uses its finer automatic grid", await cursorAt(1, "1/4"));
  await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft");
  check("reverse crossing returns to previous measure last tick", await cursorAt(0, "7/2"));
  check("controller ruler navigation never changes source", await page.evaluate(() => window.__app.getText()) === sourceBeforeNav);
  await page.evaluate(() => {
    const app = window.__app; app.setInputMode(false);
    app.setText(`.Title\nTitle = {共享时值工具栏}\nKeyAndMeters = {1=C,4/4}\n.Voice\n${Array(8).fill("1__ 0__").join(" ")} |0 0 0 0 |]\n`);
    if (app.getStaffEditorState().dotted) app.toggleTimingDot("duration");
  }); await ready();
  await first(); await page.keyboard.press("n"); await ready();
  await placeRulerCursor(1, 0);
  await page.locator('[data-input-duration-division="8"]').click();
  check("shared duration toolbar returns focus to active staff", await page.evaluate(() => document.activeElement?.id === "staff-pane"));
  await page.keyboard.press("f"); await ready();
  check("letter input works immediately after staff toolbar click", await page.evaluate(() => {
    const chord = window.__app.painter.score.parts[0].measures[1].entries.find(e => e.notes?.some(n => !n.rest));
    return chord?.position.toString() === "0" && chord.duration.toString() === "1/2" && chord.notes[0].pitch === 65;
  }));
  await placeRulerCursor(0, .25);
  await page.locator("#input-duration-auto").click();
  check("automatic duration keeps staff keyboard focus", await page.evaluate(() => document.activeElement?.id === "staff-pane"));
  check("automatic duration preview follows the active sixteenth-note span", await page.evaluate(() => window.__app.getStaffEditorState().durationDivision === 16));
  await page.keyboard.press("g"); await ready();
  check("automatic staff insertion uses the local quarter-beat tick", await page.evaluate(() => {
    const chord = window.__app.painter.score.parts[0].measures[0].entries.find(e => e.notes?.some(n => !n.rest) && e.position.toString() === "1/4");
    return chord?.duration.toString() === "1/4" && chord.notes[0].pitch === 67;
  }));
  await mkdir(join(process.cwd(), "artifacts", "staff-preview"), { recursive: true });
  await page.screenshot({ path: join(process.cwd(), "artifacts", "staff-preview", "editable-staff-a3.png") });
  savedFiles.assertNoDownloads();
  check("no runtime errors", errors.length === 0);
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} catch (error) { console.error(JSON.stringify({ errors, results, state: await page.evaluate(() => ({
  editor: window.__app.getStaffEditorState(), current: window.__app.isStaffPreviewCurrent(),
  selection: window.__app.getStaffSelectionState().notes.length, active: document.activeElement?.outerHTML.slice(0, 200),
  menu: document.querySelector('.score-input-context-menu')?.outerHTML.slice(0, 500),
  pane: document.getElementById('staff-pane').getAttribute('aria-busy'), status: document.getElementById('status-msg')?.textContent,
})) }, null, 2)); throw error; }
finally { await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
