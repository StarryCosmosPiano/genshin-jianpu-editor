// Build first, or set APP_TEST_URL to a Vite server. STAFF_SCALE_SHOTS is an output directory.
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
  const rows = [];
  for (const scale of [0.5, Math.SQRT1_2, 1, 1.5]) {
    const row = await page.evaluate(async scale => {
      const { Score, Part, Measure, Chord, Note, Fraction, Tuplet, createStaffNoteRegistry, prepareStaffPreview } = await window.__staffPreviewTest();
      const score = new Score(); score.title = "五线谱尺寸对照"; score.instrumentName = "小提琴";
      const part = new Part(); const measure = new Measure(0); part.measures.push(measure); score.parts = [part];
      measure.key.fifths = 2;
      const entries = [[0, 1, 72], [1, .5, 72], [1.5, .5, 78], [2, 1.5, 76], [3.5, .5, 74]];
      const notes = [];
      for (const [position, duration, midi] of entries) {
        const chord = new Chord(measure);
        chord.position = new Fraction(Math.round(position * 2), 2);
        chord.duration = new Fraction(Math.round(duration * 2), 2);
        const note = new Note(); note.pitch = midi; chord.add(note); measure.add(chord); notes.push(note);
      }
      notes[0].tieNext = notes[1]; notes[1].tiePrev = notes[0];
      measure.entries[0].slurEndChord = measure.entries[4];
      measure.entries[0].ornaments = [{ kind: "trill" }];
      const grace = new Note(); grace.pitch = 70; measure.entries[0].graceNotes.push(grace);
      const snapshot = { score, sources: [], registry: createStaffNoteRegistry(score, [], 1), revision: 1,
        current: true, engravingStyle: { notationScale: scale } };
      const doc = await prepareStaffPreview(snapshot);
      const rendered = doc.renderPage(0); document.body.replaceChildren(rendered.svg);
      const root = rendered.svg;
      const first = selector => root.querySelector(selector);
      const attr = (node, name) => node?.hasAttribute(name) ? parseFloat(node.getAttribute(name)) : null;
      const box = node => {
        if (!node) return null;
        const { x, y, width, height } = node.getBBox();
        return { x, y, width, height };
      };
      const hits = [...root.querySelectorAll('[data-staff-hit]')];
      const notesInk = hits.map(node => box(node));
      const staveLines = [...root.querySelectorAll('g.vf-stave path')];
      const lineY = node => parseFloat(/M[\d.]+ ([\d.]+)/.exec(node?.getAttribute('d') ?? '')?.[1] ?? 'NaN');
      const ink = first('[data-staff-arc-ink]');
      const vertices = [...(ink?.getAttribute('d') ?? '').matchAll(/(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi)]
        .map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
      const samples = Number(ink?.getAttribute('data-staff-arc-samples') ?? 0);
      const profileWidth = position => {
        const i = Math.round(samples * position);
        const a = vertices[i], b = vertices[2 * samples + 1 - i];
        return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
      };
      const tripletScore = new Score(); const tripletPart = new Part(); const tripletMeasure = new Measure(0);
      tripletPart.measures.push(tripletMeasure); tripletScore.parts = [tripletPart];
      const tripletNotes = [];
      for (let index = 0; index < 3; index++) {
        const chord = new Chord(tripletMeasure); chord.position = new Fraction(index * 2, 3);
        chord.duration = new Fraction(2, 3);
        const note = new Note(); note.pitch = 60 + index * 2; chord.add(note);
        tripletMeasure.add(chord); tripletNotes.push(note);
      }
      const tuple = new Tuplet(tripletNotes[0], tripletNotes[2]); tuple.writtenUnit = new Fraction(1);
      tripletNotes.forEach(note => note.tuplet = tuple);
      const tripletSource = { score: tripletScore, sources: [], registry: createStaffNoteRegistry(tripletScore, [], 2),
        revision: 2, current: true, engravingStyle: { notationScale: scale } };
      const tupletDoc = await prepareStaffPreview(tripletSource);
      const tupletSvg = tupletDoc.renderPage(0).svg; document.body.appendChild(tupletSvg);
      const tupletRects = [...tupletSvg.querySelectorAll('g.vf-tuplet rect')];
      const tupletText = tupletSvg.querySelector('g.vf-tuplet text');
      const tuplet = { count: tupletRects.length, rule: Math.min(...tupletRects.map(rect =>
        Math.min(attr(rect, 'height') ?? Infinity, attr(rect, 'width') ?? Infinity))),
        numeralSize: attr(tupletText, 'font-size') };
      tupletSvg.remove();
      const heads = [...root.querySelectorAll('[data-staff-pitch-id]')];
      const textInfo = selector => [...root.querySelectorAll(selector)].map(node => ({
        size: attr(node, 'font-size'), box: box(node), text: node.textContent,
      }));
      const dotGlyphs = [...root.querySelectorAll('text')]
        .filter(node => node.textContent === String.fromCharCode(0xe1e7))
        .map(node => ({ size: attr(node, 'font-size'), box: box(node) }));
      return { scale, fallbackScale: doc.layouts[0].scale, page: root.getAttribute("viewBox"),
        headWidth: notesInk[0]?.width, headHeight: notesInk[0]?.height,
        headCount: heads.length, stemWidth: attr(first('g.vf-stem path'), 'stroke-width'),
        beamHeight: box(first('g.vf-beam > path'))?.height,
        arcWidth: attr(first('[data-staff-arc]'), 'stroke-width'),
        arcBox: box(first('[data-staff-arc]')),
        arcInk: { midpoint: profileWidth(.5), endpoint: profileWidth(0), box: box(ink), fill: ink?.getAttribute('fill') },
        staveLineWidth: attr(staveLines[0], 'stroke-width'),
        staveGap: staveLines.length >= 2 ? Math.abs(lineY(staveLines[1]) - lineY(staveLines[0])) : null,
        staveLineCount: staveLines.length,
        barlineWidth: attr(first('g.vf-stavebarline rect'), 'width'), tuplet,
        clef: textInfo('g.vf-clef text'), time: textInfo('g.vf-timesignature text'),
        key: textInfo('g.vf-keysignature text'), dot: dotGlyphs,
        ornament: textInfo('g.vf-ornament text'),
        flag: textInfo('g.vf-flag text'),
        tempo: textInfo('[data-staff-prose="annotation"]'),
      };
    }, scale);
    rows.push(row);
    if (process.env.STAFF_SCALE_SHOTS) await page.locator('svg[role=img]').screenshot({
      path: join(process.env.STAFF_SCALE_SHOTS, `staff-scale-${String(scale).replace('.', '-')}.png`),
    });
  }
  const near = (actual, expected, tolerance = .05) => actual !== null
    && Math.abs(actual - expected) <= tolerance * Math.max(1, expected);
  for (const row of rows) {
    assert.equal(row.fallbackScale, 1, `scale ${row.scale}: unexpected whole-system fallback`);
    assert.equal(row.page, '0 0 794 1123');
    assert.equal(row.staveLineCount, 5);
    assert.equal(row.headCount, 6);
    assert(near(row.staveGap, 10 * row.scale, .01));
    assert(near(row.staveLineWidth, row.scale, .01));
    assert(near(row.stemWidth, 1.5 * row.scale, .01));
    assert(near(row.barlineWidth, row.scale, .01));
    assert(near(row.clef[0]?.size, 30 * row.scale, .01));
    assert(near(row.time[0]?.size, 30 * row.scale, .01), `scale ${row.scale}: time signature did not follow staff spacing`);
    assert(near(row.key[0]?.size, 30 * row.scale, .01));
    assert(near(row.flag[1]?.size, 30 * row.scale, .01));
    assert(row.dot.length > 0 && near(row.dot[0]?.size, 30 * row.scale, .01));
    assert(near(row.tuplet.rule, row.scale, .01) && near(row.tuplet.numeralSize, 30 * row.scale, .01));
    assert(near(row.arcInk.midpoint, 1.25 * row.scale, .02));
    assert(row.arcInk.endpoint > row.arcInk.midpoint * .25
      && row.arcInk.endpoint < row.arcInk.midpoint * .4 && row.arcInk.midpoint < 1.5 * row.scale,
      `scale ${row.scale}: tie must taper gently from fine to slightly thick and back`);
    assert.equal(row.arcInk.fill, '#111');
    assert(row.arcBox.height <= 5.5 * row.scale,
      `scale ${row.scale}: ordinary tie curvature remained too tall`);
    assert.equal(row.tempo[0]?.size, 14, 'page prose changed with notation size');
  }
  console.log(JSON.stringify(rows.map(row => ({ scale: row.scale, staveGap: row.staveGap,
    timeSize: row.time[0]?.size, clefSize: row.clef[0]?.size, keySize: row.key[0]?.size, dotSize: row.dot[0]?.size,
    stemWidth: row.stemWidth, beamHeight: row.beamHeight, tuplet: row.tuplet,
    arcHeight: row.arcBox.height, tieEndpoint: row.arcInk.endpoint, tieMiddle: row.arcInk.midpoint,
    tempoSize: row.tempo[0]?.size })), null, 2));
} finally { await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
