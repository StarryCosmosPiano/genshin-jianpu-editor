import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

let server;
let url = process.env.APP_TEST_URL;
if (!url) {
  const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json" };
  server = createServer(async (request, response) => {
    try {
      const path = normalize(decodeURIComponent((request.url ?? "/").split("?")[0]));
      const file = path === "/" || path === "\\" ? "index.html" : path;
      const data = await readFile(join(process.cwd(), "dist", file));
      response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" }); response.end(data);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
  await page.goto(url);
  await page.waitForFunction(() => typeof window.__staffPreviewTest === "function");
  const report = await page.evaluate(async () => {
    const { Score, Part, Measure, Chord, Note, Fraction, createStaffNoteRegistry, prepareStaffPreview, buildStaffModel } = await window.__staffPreviewTest();
    const score = new Score(); score.title = "延音线排版检查"; score.instrumentName = "超长中文小提琴第一声部";
    score.parts = [new Part()];
    for (let m = 0; m < 4; m++) {
      const measure = new Measure(m); measure.newSystem = m === 2;
      score.parts[0].measures.push(measure);
      for (let n = 0; n < 4; n++) {
        const chord = new Chord(measure);
        chord.position = m === 3 ? new Fraction(n, 2) : new Fraction(n);
        chord.duration = m === 3 ? new Fraction(1, 2) : new Fraction(1);
        const pitch = m < 2 ? 84 - n * 2 : 48 + n * 2;
        const note = new Note(); note.pitch = pitch; chord.add(note);
        if (m === 1 && (n === 2 || n === 3)) { const low = new Note(); low.pitch = 60; chord.add(low); }
        measure.add(chord);
      }
    }
    function join(a, b) {
      b.pitch = a.pitch; a.tieNext = b; b.tiePrev = a;
      a.tieStart = true; b.tieEnd = true;
    }
    const by = (m, n) => score.parts[0].measures[m].entries[n];
    join(by(0, 0).notes[0], by(0, 3).notes[0]);
    join(by(1, 3).notes[0], by(2, 0).notes[0]);
    join(by(2, 1).notes[0], by(2, 3).notes[0]);
    join(by(1, 2).notes[1], by(1, 3).notes[1]);
    join(by(1, 0).notes[0], by(1, 1).notes[0]);
    join(by(3, 0).notes[0], by(3, 3).notes[0]);
    by(2, 0).transparentContinuation = true;
    by(0, 0).slurEndChord = by(1, 2);
    const leap = new Chord(score.parts[0].measures[1]);
    leap.position = new Fraction(1, 8); leap.duration = new Fraction(1, 8); leap.voice = 1;
    const leapNote = new Note(); leapNote.pitch = 96; leap.add(leapNote); score.parts[0].measures[1].add(leap);
    const shortSlurSource = new Chord(score.parts[0].measures[1]);
    shortSlurSource.position = new Fraction(0); shortSlurSource.duration = new Fraction(1, 8);
    shortSlurSource.voice = 1; shortSlurSource.slurEndChord = by(1, 3);
    const shortSlurNote = new Note(); shortSlurNote.pitch = 80; shortSlurSource.add(shortSlurNote);
    score.parts[0].measures[1].add(shortSlurSource);
    const snapshot = { score, sources: [], registry: createStaffNoteRegistry(score, [], 1), revision: 1,
      current: true, engravingStyle: { notationScale: Math.SQRT1_2 } };
    const model = buildStaffModel(snapshot);
    const doc = await prepareStaffPreview(snapshot);
    const rendered = doc.renderPage(0);
    document.body.replaceChildren(rendered.svg);
    const continuationPitch = model.measures[2].rows[0].events.find(event => event.sourceChord === by(2, 0))?.notes[0];
    const continuationVisible = Boolean(continuationPitch
      && rendered.svg.querySelector(`[data-staff-pitch-id="${continuationPitch.id}"]`)
      && model.ties.some(tie => tie.to === continuationPitch.id));
    const arcs = [...rendered.svg.querySelectorAll('[data-staff-arc]')].map(path => ({
      kind: path.getAttribute('data-staff-arc'), direction: path.getAttribute('data-staff-arc-direction'),
      from: path.getAttribute('data-staff-arc-from'), to: path.getAttribute('data-staff-arc-to'),
      d: path.getAttribute('d'),
    }));
    const prose = [...rendered.svg.querySelectorAll('[data-staff-prose]')].map(text => ({
      text: text.textContent, size: Number(text.getAttribute('font-size')),
      parent: text.parentNode === rendered.svg,
    }));
    const pagePoint = (element, x, y) => new DOMPoint(x, y).matrixTransform(element.getCTM());
    const pageBox = element => {
      const box = element.getBBox();
      const a = pagePoint(element, box.x, box.y);
      const b = pagePoint(element, box.x + box.width, box.y + box.height);
      return { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x),
        top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
    };
    const paths = [...rendered.svg.querySelectorAll('[data-staff-arc]')];
    const inks = [...rendered.svg.querySelectorAll('[data-staff-arc-ink]')];
    const tapered = inks.every(ink => {
      const samples = Number(ink.getAttribute('data-staff-arc-samples'));
      const points = [...(ink.getAttribute('d') ?? '').matchAll(/(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi)]
        .map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
      const thickness = index => Math.hypot(points[index].x - points[2 * samples + 1 - index].x,
        points[index].y - points[2 * samples + 1 - index].y);
      return ink.getAttribute('fill') === '#111' && points.length === 2 * (samples + 1)
        && thickness(Math.round(samples / 2)) > thickness(0) * 2
        && thickness(Math.round(samples / 2)) < thickness(0) * 4;
    });
    const collisions = []; const hardwareCollisions = []; const proseCollisions = [];
    const badEndpoints = []; const outOfPageArcs = [];
    for (const ink of inks) {
      const bounds = pageBox(ink);
      if (bounds.left < 0 || bounds.right > 794 || bounds.top < 0 || bounds.bottom > 1123) outOfPageArcs.push(bounds);
    }
    for (const path of paths) {
      const group = path.parentElement;
      const head = id => {
        const glyph = [...group.querySelectorAll('[data-staff-pitch-id]')]
          .find(node => node.getAttribute('data-staff-pitch-id') === id);
        return glyph && group.querySelector(`[data-staff-hit="${glyph.getAttribute('data-staff-glyph')}"]`);
      };
      const from = head(path.getAttribute('data-staff-arc-from'));
      const to = head(path.getAttribute('data-staff-arc-to'));
      const total = path.getTotalLength();
      const start = path.getPointAtLength(0); const finish = path.getPointAtLength(total);
      const startPage = pagePoint(path, start.x, start.y);
      const finishPage = pagePoint(path, finish.x, finish.y);
      if (from && startPage.x < pageBox(from).right - 3) badEndpoints.push('from');
      if (to && finishPage.x > pageBox(to).left + 3) badEndpoints.push('to');
      const others = [...rendered.svg.querySelectorAll('[data-staff-hit]')].filter(hit => hit !== from && hit !== to).map(pageBox);
      const hardware = [...rendered.svg.querySelectorAll('g.vf-stem,g.vf-beam > path')].map(element => ({
        ...pageBox(element), kind: element.parentElement?.getAttribute('class') ?? element.getAttribute('class') }));
      const proseBoxes = [...rendered.svg.querySelectorAll('[data-staff-prose]')].map(pageBox);
      const arcBox = pageBox(path);
      if (arcBox.left < 0 || arcBox.right > 794 || arcBox.top < 0 || arcBox.bottom > 1123) outOfPageArcs.push(arcBox);
      for (let length = 5; length < total - 5; length += 1.5) {
        const point = path.getPointAtLength(length);
        const at = pagePoint(path, point.x, point.y);
        const crossedHead = others.find(box => {
          return at.x > box.left + 1 && at.x < box.right - 1 && at.y > box.top + 1 && at.y < box.bottom - 1;
        });
        if (crossedHead) {
          collisions.push({ kind: path.getAttribute('data-staff-arc'), from: path.getAttribute('data-staff-arc-from'),
            to: path.getAttribute('data-staff-arc-to'), at: { x: at.x, y: at.y }, crossedHead }); break;
        }
        const crossed = hardware.find(box => at.x > box.left + 0.5 && at.x < box.right - 0.5
          && at.y > box.top + 0.5 && at.y < box.bottom - 0.5);
        if (crossed) {
          hardwareCollisions.push({ kind: path.getAttribute('data-staff-arc'), from: path.getAttribute('data-staff-arc-from'),
            to: path.getAttribute('data-staff-arc-to'), at: { x: at.x, y: at.y }, crossed }); break;
        }
        if (proseBoxes.some(box => at.x > box.left + 1 && at.x < box.right - 1
          && at.y > box.top + 1 && at.y < box.bottom - 1)) {
          proseCollisions.push(path.getAttribute('data-staff-arc')); break;
        }
      }
    }
    const instrumentBounds = [...rendered.svg.querySelectorAll('[data-staff-prose="instrument"]')].map(pageBox);
    const beamCount = rendered.svg.querySelectorAll('g.vf-beam').length;
    const systems = [...rendered.svg.children].filter(node => node.tagName.toLowerCase() === 'g');
    const adjacentClearance = systems.slice(0, -1).map((system, index) => {
      const arcs = [...system.querySelectorAll('[data-staff-arc]')];
      const nextHeads = [...systems[index + 1].querySelectorAll('[data-staff-hit]')];
      return Math.min(...nextHeads.map(head => pageBox(head).top))
        - Math.max(...arcs.map(arc => pageBox(arc).bottom));
    });
    const densityScore = new Score(); densityScore.title = "A4 五线谱密度";
    densityScore.parts = [new Part()];
    for (let m = 0; m < 48; m++) {
      const measure = new Measure(m); densityScore.parts[0].measures.push(measure);
      for (let n = 0; n < 4; n++) {
        const chord = new Chord(measure); chord.position = new Fraction(n); chord.duration = new Fraction(1);
        const note = new Note(); note.pitch = 60 + n * 2; chord.add(note); measure.add(chord);
      }
    }
    const densitySnapshot = scale => ({ score: densityScore, sources: [],
      registry: createStaffNoteRegistry(densityScore, [], 2), revision: 2, current: true,
      engravingStyle: { notationScale: scale } });
    const normal = await prepareStaffPreview(densitySnapshot(1));
    const compact = await prepareStaffPreview(densitySnapshot(Math.SQRT1_2));
    window.__staffDensityPage = compact.renderPage(0).svg;
    const density = { normalPages: normal.pageCount, compactPages: compact.pageCount,
      normalFirstSystemBars: normal.layouts[0].measures.length,
      compactFirstSystemBars: compact.layouts[0].measures.length,
      normalFirstPageBars: normal.layouts.filter(layout => layout.page === 0).reduce((sum, layout) => sum + layout.measures.length, 0),
      compactFirstPageBars: compact.layouts.filter(layout => layout.page === 0).reduce((sum, layout) => sum + layout.measures.length, 0),
      compactFirstPageSystems: compact.layouts.filter(layout => layout.page === 0).length };
    return { pages: doc.pageCount, modelTies: model.ties.length, modelSlurs: model.slurs.length,
      arcs, inkCount: inks.length, tapered, prose, systems: systems.length, density,
      collisions, hardwareCollisions, proseCollisions,
      badEndpoints, outOfPageArcs,
      instrumentBounds, beamCount, continuationVisible, adjacentClearance,
      viewBox: rendered.svg.getAttribute('viewBox') };
  });
  console.log(JSON.stringify({ arcs: report.arcs.length, tapered: report.tapered,
    directions: [...new Set(report.arcs.map(arc => arc.direction))],
    collisions: report.collisions, hardwareCollisions: report.hardwareCollisions,
    proseCollisions: report.proseCollisions, badEndpoints: report.badEndpoints.length, outOfPageArcs: report.outOfPageArcs.length,
    continuationVisible: report.continuationVisible, beams: report.beamCount,
    adjacentClearance: report.adjacentClearance, density: report.density }, null, 2));
  if (process.env.STAFF_TEST_SCREENSHOT) await page.locator("svg[role=img]").screenshot({ path: process.env.STAFF_TEST_SCREENSHOT });
  assert.equal(report.viewBox, "0 0 794 1123");
  assert(report.modelTies >= 3 && report.modelSlurs >= 1);
  assert(report.inkCount === report.arcs.length && report.tapered,
    "visible ties and slurs are not subtly tapered filled ribbons");
  assert(report.arcs.filter(arc => arc.kind === "tie").length >= 4, "cross-system tie was not split across both systems");
  assert(report.arcs.some(arc => arc.direction === "above") && report.arcs.some(arc => arc.direction === "below"),
    "stem directions did not change arc direction");
  const splitArcs = report.arcs.filter(arc => report.arcs.some(other => other !== arc && other.from === arc.from && other.to === arc.to));
  assert(splitArcs.length >= 2 && new Set(splitArcs.map(arc => arc.direction)).size === 1,
    "cross-system tie changed direction after the line break");
  assert(report.prose.filter(text => text.size >= 12 && text.parent && !text.text.includes("=")).length >= 4,
    "long instrument name was not wrapped in readable page-size text");
  assert(report.prose.some(text => text.text.includes("=") && text.size >= 13 && text.parent));
  assert.equal(report.collisions.length, 0, "an arc crossed another notehead");
  assert.equal(report.hardwareCollisions.length, 0, "an arc crossed a stem or beam");
  assert.equal(report.proseCollisions.length, 0, "an arc crossed tempo or instrument text");
  assert.equal(report.badEndpoints.length, 0, "an arc endpoint entered a notehead");
  assert.equal(report.outOfPageArcs.length, 0, "a high leap sent an arc off the A4 page");
  assert(report.adjacentClearance.every(clearance => clearance > 10), "an arc entered the following system");
  assert(report.instrumentBounds.every(box => box.left >= 0 && box.right < 64), "long instrument name crossed the clef or page edge");
  assert(report.beamCount > 0, "fixture did not include beamed notes");
  assert(report.continuationVisible, "transparent continuation lost its visible tied note");
  assert(report.density.compactFirstSystemBars > report.density.normalFirstSystemBars,
    "smaller notation did not reflow more measures into each system");
  assert(report.density.compactFirstPageBars > report.density.normalFirstPageBars,
    "smaller notation did not fit more music on an A4 page");
  if (process.env.STAFF_DENSITY_SCREENSHOT) {
    await page.evaluate(() => document.body.replaceChildren(window.__staffDensityPage));
    await page.locator("svg[role=img]").screenshot({ path: process.env.STAFF_DENSITY_SCREENSHOT });
  }
} finally { await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
