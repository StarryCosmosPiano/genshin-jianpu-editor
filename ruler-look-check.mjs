// Actual SVG rulers and natural four-measure staff packing. Build first.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

let server, origin = process.env.APP_TEST_URL;
if (!origin) {
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json" };
  server = createServer(async (request, response) => {
    try {
      const path = normalize(decodeURIComponent((request.url ?? "/").split("?")[0]));
      const file = join(process.cwd(), "dist", path === "/" || path === "\\" ? "index.html" : path);
      response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" }); response.end(await readFile(file));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1300 } });
  await page.goto(origin);
  await page.waitForFunction(() => window.__app?.isStaffPreviewCurrent());
  await page.evaluate(() => {
    const app = window.__app;
    app.documentFormat = "jpw"; app.slashOptions = null;
    app.setText(`.Title\nTitle = 刻度外观\nKeyAndMeters = {1=C,4/4}\n.Voice\n${Array.from({ length: 32 }, () => "1 3 5 3 |").join("")} ]\n`);
    app.setEngravingStyle({ ...app.engravingStyle, rhythmGuideEnabled: true,
      rhythmGuideMode: "manual", rhythmGuideDivision: 8, rhythmGuideDotted: true });
  });
  await page.waitForFunction(() => window.__app.isStaffPreviewCurrent());
  const result = await page.evaluate(async () => {
    const app = window.__app, api = await window.__staffPreviewTest();
    const { Score, Part, Measure, Chord, Note, Fraction, createStaffNoteRegistry, prepareStaffPreview } = api;
    const check = (value, message) => { if (!value) throw new Error(message); };
    const inspectRuler = svg => {
      const baselines = [...svg.querySelectorAll(".rhythm-guide-line")].map(node => node.tagName.toLowerCase() === "line" ? node : node.querySelector("line"));
      const ticks = [...svg.querySelectorAll(".rhythm-guide-tick")].map(node => node.tagName.toLowerCase() === "line" ? node : node.querySelector("line"));
      check(baselines.length && ticks.length, "SVG omitted shared ruler classes");
      check(baselines.every(line => line.getAttribute("stroke") === "rgb(107,76,138)"), `baseline is not deep purple: ${baselines.map(line => line.getAttribute("stroke")).join(",")}`);
      check([...baselines, ...ticks].every(line => Number(line.getAttribute("stroke-width")) >= .7 * app.engravingStyle.contentScale - 1e-8),
        "compact ruler line fell below the visible 0.7px content-scaled minimum");
      check(ticks.every(line => Number(line.getAttribute("y2")) < Number(line.getAttribute("y1"))), "ruler tick points away from music");
      check(ticks.every(line => line.getAttribute("stroke") === ((line.closest(".rhythm-guide-tick")).classList.contains("rhythm-guide-muted") ? "rgb(182,164,200)" : "rgb(107,76,138)")), "tick colour differs across SVG/export");
      check(ticks.every(line => (line.closest(".rhythm-guide-tick")).classList.contains("rhythm-guide-major") || (line.closest(".rhythm-guide-tick")).classList.contains("rhythm-guide-minor")), "tick lost beat/subdivision class");
      check(ticks.some(line => (line.closest(".rhythm-guide-tick")).classList.contains("rhythm-guide-muted")), "dotted ruler lacks muted reference subdivisions");
      return { baselines: baselines.length, ticks: ticks.length };
    };
    const numbered = inspectRuler(app.painter.renderPage(0));
    const snapshot = app.getStaffPreviewSnapshot();
    const document = await prepareStaffPreview(snapshot);
    const staff = inspectRuler(document.renderPage(0).svg);
    const widths = document.layouts.map(layout => layout.measures.length);
    check(widths.every(count => count <= 4), "natural staff system exceeds four measures");
    check(widths.filter(count => count >= 3).length >= widths.length * .75, "ordinary staff did not naturally pack three or four measures");
    let rendered = 0;
    for (let index = 0; index < document.pageCount; index++) rendered += document.renderPage(index).notes.length;
    check(rendered === snapshot.registry.targets.length, "packing lost source notes");
    const compact = { barsPerSystem: widths, pages: document.pageCount,
      lineSpacing: document.renderPage(0).inputSpans[0].lineSpacing, paper: document.renderPage(0).svg.getAttribute("viewBox"), expectedPaper: snapshot.paper ? `0 0 ${snapshot.paper.widthPt * 96 / 72} ${snapshot.paper.heightPt * 96 / 72}` : "0 0 794 1123", rendered };
    document.dispose();
    const score = new Score(); score.parts = [new Part()];
    for (let m = 0; m < 4; m++) {
      const measure = new Measure(m); score.parts[0].measures.push(measure);
      for (let n = 0; n < 32; n++) {
        const chord = new Chord(measure); chord.position = new Fraction(n, 8); chord.duration = new Fraction(1, 8);
        const note = new Note(); note.pitch = 60 + n % 7; chord.add(note); measure.add(chord);
      }
    }
    const fingerprint = JSON.stringify(score.parts[0].measures.map(bar => bar.entries.map(chord => [chord.position.toString(), chord.duration.toString(), chord.notes[0].pitch])));
    const dense = await prepareStaffPreview({ score, revision: 1, sources: [], current: true, registry: createStaffNoteRegistry(score, [], 1) });
    check(dense.layouts.every(layout => layout.measures.length <= 4), "dense systems violate measure cap");
    check(dense.layouts.some(layout => layout.measures.length < 3), "dense fixture did not exercise narrower systems");
    let denseNotes = 0;
    for (let index = 0; index < dense.pageCount; index++) denseNotes += dense.renderPage(index).notes.length;
    check(denseNotes === 128, "dense packing dropped source notes");
    check(fingerprint === JSON.stringify(score.parts[0].measures.map(bar => bar.entries.map(chord => [chord.position.toString(), chord.duration.toString(), chord.notes[0].pitch]))), "compact preview mutated source music");
    const denseBars = dense.layouts.map(layout => layout.measures.length); dense.dispose();
    return { numbered, staff, compact, denseBars, denseNotes };
  });
  assert.equal(result.compact.paper, result.compact.expectedPaper);
  assert(Math.abs(result.compact.lineSpacing - 10 * Math.SQRT1_2 * .75) < .001);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
