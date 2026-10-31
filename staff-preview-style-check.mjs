// Build first, or point APP_TEST_URL at Vite. Exercises visible SVG geometry.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
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
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: 2 });
  await page.goto(url);
  await page.waitForFunction(() => typeof window.__staffPreviewTest === "function");
  const report = await page.evaluate(async () => {
    const { Score, Part, Measure, Chord, Note, Fraction, createStaffNoteRegistry, prepareStaffPreview } = await window.__staffPreviewTest();
    const score = new Score(); score.piano = true; score.instrumentName = "钢琴"; score.title = "五线谱样式与近距离延音线";
    score.parts = [new Part(), new Part()];
    for (let part = 0; part < 2; part++) for (let m = 0; m < 3; m++) {
      const measure = new Measure(m); measure.newSystem = m > 0; score.parts[part].measures.push(measure);
      for (let n = 0; n < 32; n++) {
        const chord = new Chord(measure); chord.position = new Fraction(n, 8); chord.duration = new Fraction(1, 8);
        const note = new Note(); note.pitch = part === 0 ? (n < 5 ? 72 : n % 2 ? 84 : 48) : 48 + n % 3 * 2;
        chord.add(note); measure.add(chord);
      }
      const notes = measure.entries.slice(1, 4).map(chord => chord.notes[0]);
      for (let n = 0; n < 2; n++) {
        notes[n + 1].pitch = notes[n].pitch;
        notes[n].tieNext = notes[n + 1]; notes[n + 1].tiePrev = notes[n];
        notes[n].tieStart = true; notes[n + 1].tieEnd = true;
      }
    }
    score.textMarks.push({ partIndex: 1, measure: 1, offset: new Fraction(0), text: "accel.", placement: "above" });
    score.textMarks.push({ partIndex: 0, measure: 1, offset: new Fraction(2), text: "♩ = 87", placement: "above" });
    // This sparse third system checks proximity without a high-register beam
    // forcing the direction away from its staff.
    for (const part of score.parts) {
      const measure = part.measures[2]; measure.entries.length = 0;
      for (let n = 0; n < 4; n++) {
        const chord = new Chord(measure); chord.position = new Fraction(n); chord.duration = new Fraction(1);
        const note = new Note(); note.pitch = part === score.parts[0] ? 64 : 48; chord.add(note); measure.add(chord);
      }
    }
    score.textMarks.push({ partIndex: 0, measure: 2, offset: new Fraction(0), text: "rit.", placement: "above" });
    const registry = createStaffNoteRegistry(score, [], 1);
    const rows = [];
    const pageBox = element => {
      const box = element.getBBox(), matrix = element.getCTM();
      const a = new DOMPoint(box.x, box.y).matrixTransform(matrix);
      const b = new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(matrix);
      return { left: a.x, right: b.x, top: a.y, bottom: b.y };
    };
    for (const notationScale of [1, .5, 1.5, 1]) {
      const doc = await prepareStaffPreview({ score, registry, sources: [], revision: 1, current: true,
        engravingStyle: { notationScale, rhythmGuideEnabled: true } });
      const pages = Array.from({ length: doc.pageCount }, (_, index) => doc.renderPage(index).svg);
      document.body.replaceChildren(...pages);
      const ledgers = pages.flatMap(svg => [...svg.querySelectorAll('[data-staff-ledger]')]);
      const upperLower = { above: 0, below: 0 };
      for (const ledger of ledgers) {
        const staff = ledger.closest('g[transform]');
        const lines = [...staff.querySelectorAll('g.vf-stave path')].slice(0, 5).map(pageBox);
        const box = pageBox(ledger);
        if (box.top < lines[0].top) upperLower.above++;
        if (box.top > lines[4].top) upperLower.below++;
      }
      const directions = pages.flatMap(svg => [...svg.querySelectorAll('[data-staff-prose="annotation"]')]);
      const collisions = [];
      const distances = [];
      for (const text of directions) {
        const systemStart = Number(text.getAttribute('data-staff-system'));
        const staffIndex = Number(text.getAttribute('data-staff-index'));
        const system = pages.flatMap(svg => [...svg.children]).find(group => group.tagName.toLowerCase() === 'g'
          && [...group.querySelectorAll('[data-staff-hit]')].some(hit => hit.getAttribute('aria-label')?.includes(`第 ${systemStart + 1} 小节`)));
        if (!system) throw new Error('direction lost its owning system');
        const staff = [...system.querySelectorAll('g.vf-stave')][staffIndex];
        const line = staff.querySelector('path');
        const box = pageBox(text); const staffTop = pageBox(line).top;
        distances.push({ text: text.textContent, systemStart, staffIndex, gap: staffTop - box.bottom });
        for (const ink of system.querySelectorAll('g.vf-stem path,g.vf-beam > path,[data-staff-ledger],.staff-rhythm-guide')) {
          const other = pageBox(ink);
          if (box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)
            collisions.push({ text: text.textContent, type: ink.getAttribute('class') ?? ink.parentElement?.getAttribute('class') });
        }
      }
      const ties = pages.flatMap(svg => [...svg.querySelectorAll('[data-staff-arc="tie"]')]).map(path => {
        const box = path.getBBox(); return { span: box.width, height: box.height };
      });
      const brace = pages[0].querySelector('[data-staff-brace]');
      const braceBox = pageBox(brace);
      const joinRule = pages[0].querySelector('[data-staff-join] rect');
      const joinBox = pageBox(joinRule);
      rows.push({ notationScale, instrumentSystems: pages.flatMap(svg => [...svg.querySelectorAll('[data-staff-prose="instrument"]')])
        .map(text => text.getAttribute('data-staff-system')),
        ledgerStyles: [...new Set(ledgers.map(ledger => `${ledger.getAttribute('stroke-width')}|${ledger.getAttribute('stroke')}`))],
        ledgerGeometry: ledgers.slice(0, 12).map(ledger => ledger.getAttribute('d')), upperLower,
        ledgerLengths: ledgers.slice(0, 12).map(ledger => ledger.getTotalLength() / notationScale),
        braceWidth: (braceBox.right - braceBox.left) / doc.layouts[0].scale / notationScale,
        joinWidth: (joinBox.right - joinBox.left) / doc.layouts[0].scale / notationScale,
        collisions, distances, ties });
      if (notationScale === 1) window.__staffStylePages = pages;
    }
    return rows;
  });
  for (const row of report) {
    assert(row.instrumentSystems.length === 1 && row.instrumentSystems[0] === '0', 'instrument name repeated after the first system');
    assert(row.upperLower.above > 0 && row.upperLower.below > 0, 'fixture did not exercise upper and lower ledgers');
    assert.deepEqual(row.ledgerStyles, [`${1.2 * .75 * row.notationScale}|#111`], 'ledger ink did not follow staff size');
    assert(Math.abs(row.braceWidth - report[0].braceWidth) < .01, 'brace width did not follow music size');
    assert(Math.abs(row.joinWidth - .75) < .01, 'grand staff joining rule did not follow staff pen weight');
    assert(row.ledgerLengths.every((length, index) => Math.abs(length - report[0].ledgerLengths[index]) < .03),
      'ledger extension changed in proportion to its notehead');
    assert(row.ties.length >= 8, 'dense short ties disappeared');
    assert(row.ties.every(tie => tie.span > 5 * row.notationScale && tie.height / tie.span < .4), 'dense ties still look like narrow hooks');
    assert.equal(row.collisions.length, 0, 'direction text crossed stems, beams, ledger rules or rhythm guides');
    const sparse = row.distances.find(item => item.text === 'rit.');
    assert(sparse && sparse.gap > 0 && sparse.gap < 8 * row.notationScale, 'sparse direction did not sit close to its own staff');
  }
  assert.deepEqual(report[0], report[3], 'notation scale round trip changed cached ledger, direction or tie geometry');
  if (process.env.STAFF_STYLE_SCREENSHOT) {
    await mkdir(process.env.STAFF_STYLE_SCREENSHOT, { recursive: true });
    for (let index = 0; index < await page.locator('svg[role=img]').count(); index++)
      await page.locator('svg[role=img]').nth(index).screenshot({ path: join(process.env.STAFF_STYLE_SCREENSHOT, `staff-style-${index + 1}.png`) });
  }
  console.log(JSON.stringify(report.map(row => ({ scale: row.notationScale, ledgerStyles: row.ledgerStyles,
    shortTies: row.ties.length, shortestTie: Math.min(...row.ties.map(tie => tie.span)), directions: row.distances, collisions: row.collisions })), null, 2));
} finally { await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
