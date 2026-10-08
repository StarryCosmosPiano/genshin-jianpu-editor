// Standalone content-scale regression. Build first, or set APP_TEST_URL to a Vite URL.
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
  const rows = await page.evaluate(async () => {
    const { Score, Part, Measure, Chord, Note, Lyric, Fraction, createStaffNoteRegistry, prepareStaffPreview } =
      await window.__staffPreviewTest();
    const score = new Score();
    score.title = "整体缩放标题"; score.subtitle = "整体缩放副标题";
    score.lyricist = "测试作词"; score.composer = "测试作曲";
    score.instrumentName = "小提琴";
    const part = new Part(); part.instrumentName = "小提琴"; score.parts = [part];
    for (let index = 0; index < 40; index++) {
      const measure = new Measure(index); part.measures.push(measure);
      measure.key.fifths = 2;
      for (let step = 0; step < 4; step++) {
        const chord = new Chord(measure); chord.position = new Fraction(step);
        chord.duration = new Fraction(1);
        const note = new Note(); note.pitch = 60 + step * 2;
        if (index === 0 && step === 0) {
          const lyric = new Lyric(); lyric.number = 1; lyric.text = "歌词"; note.lyrics.push(lyric);
        }
        chord.add(note); measure.add(chord);
      }
    }
    const fingerprint = () => JSON.stringify(part.measures.map(measure => measure.entries.map(chord =>
      [chord.position.toString(), chord.duration.toString(), chord.notes.map(note => [note.pitch, note.lyrics.map(lyric => lyric.text)])])));
    const original = fingerprint();
    const rows = [];
    for (const contentScale of [.5, 1, 1.5]) {
      const snapshot = { score, sources: [], registry: createStaffNoteRegistry(score, [], 1), revision: 1,
        current: true, engravingStyle: { notationScale: 1, contentScale } };
      const doc = await prepareStaffPreview(snapshot);
      const rendered = doc.renderPage(0); document.body.replaceChildren(rendered.svg);
      const root = rendered.svg;
      const allPages = Array.from({ length: doc.pageCount }, (_, index) => index === 0 ? rendered : doc.renderPage(index));
      const val = (node, name) => node ? parseFloat(node.getAttribute(name) ?? "") : null;
      const text = value => [...root.querySelectorAll("text")].find(node => node.textContent === value);
      const line = root.querySelector("g.vf-stave path");
      const lineYs = [...root.querySelectorAll("g.vf-stave path")].slice(0, 2)
        .map(node => Number(/M[\d.]+ ([\d.]+)/.exec(node.getAttribute("d") ?? "")?.[1]));
      const firstSystem = root.querySelector("g[data-staff-system]") ?? root.querySelector("g.vf-stave")?.parentElement;
      const firstStave = root.querySelector("g.vf-stave");
      const box = node => { const rect = node?.getBBox(); return rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null; };
      const pageBox = node => { const rect = node?.getBoundingClientRect(); return rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null; };
      const title = text(score.title); const subtitle = text(score.subtitle);
      const credit = text(`作词：${score.lyricist}`);
      const instrument = root.querySelector('[data-staff-prose="instrument"]');
      const tempo = root.querySelector('[data-staff-prose="annotation"]');
      const lyric = text("歌词");
      const sizes = { title: val(title, "font-size"), subtitle: val(subtitle, "font-size"),
        credit: val(credit, "font-size"), instrument: val(instrument, "font-size"),
        tempo: val(tempo, "font-size"), lyric: val(lyric, "font-size"),
        footer: val(text("1"), "font-size"), clef: val(root.querySelector("g.vf-clef text"), "font-size"),
        time: val(root.querySelector("g.vf-timesignature text"), "font-size") };
      rows.push({ contentScale, pageCount: doc.pageCount, paper: root.getAttribute("viewBox"),
        widths: allPages.map(page => page.svg.getAttribute("width")),
        heights: allPages.map(page => page.svg.getAttribute("height")),
        sourceNotes: part.measures.reduce((sum, measure) => sum + measure.entries.length, 0),
        renderedNotes: allPages.reduce((sum, page) => sum + page.notes.length, 0),
        firstSystemBars: doc.layouts[0].measures.length, firstSystemScale: doc.layouts[0].scale,
        staffGap: Math.abs(lineYs[1] - lineYs[0]), lineWidth: val(line, "stroke-width"),
        stemWidth: val(root.querySelector("g.vf-stem path"), "stroke-width"), sizes,
        titleBox: pageBox(title), subtitleBox: pageBox(subtitle), creditBox: pageBox(credit),
        firstSystemBox: pageBox(firstSystem), firstStaveBox: pageBox(firstStave),
        proseBoxes: [...root.querySelectorAll("[data-staff-prose]")].map(box),
        sourceUnchanged: fingerprint() === original });
    }
    return rows;
  });
  const near = (actual, expected, tolerance = .02) => actual !== null && Math.abs(actual - expected) <= tolerance * Math.max(1, expected);
  for (const row of rows) {
    const scale = row.contentScale;
    assert.equal(row.paper, "0 0 794 1123");
    assert(row.widths.every(value => value === "794") && row.heights.every(value => value === "1123"));
    assert.equal(row.sourceNotes, 160);
    assert.equal(row.renderedNotes, 160);
    assert.equal(row.sourceUnchanged, true);
    assert(near(row.staffGap, 10 * scale));
    assert(near(row.lineWidth, scale));
    assert(near(row.stemWidth, 1.5 * scale));
    for (const [name, base] of Object.entries({ title: 23, subtitle: 13, credit: 12, instrument: 13,
      tempo: 14, lyric: 10, footer: 11, clef: 30, time: 30 }))
      assert(near(row.sizes[name], base * scale), `${name} did not scale at ${scale}: ${row.sizes[name]}`);
    assert(row.titleBox && row.subtitleBox && row.creditBox && row.firstSystemBox && row.firstStaveBox);
    assert(row.titleBox.y + row.titleBox.h < row.subtitleBox.y + 2);
    assert(row.creditBox.y + row.creditBox.h < row.firstSystemBox.y,
      `credit collided with first system at ${scale}`);
    assert(row.proseBoxes.every(box => box && box.x >= -1 && box.x + box.w <= 795));
  }
  assert(rows[0].firstSystemBars > rows[1].firstSystemBars && rows[1].firstSystemBars >= rows[2].firstSystemBars,
    "music did not reflow into fewer bars per system as content grew");
  assert(rows[0].pageCount < rows[1].pageCount && rows[1].pageCount < rows[2].pageCount,
    "music did not repaginate as content grew");
  const edgeRows = await page.evaluate(async () => {
    const { Score, Part, Measure, Chord, Note, Fraction, createStaffNoteRegistry, prepareStaffPreview } =
      await window.__staffPreviewTest();
    const results = [];
    for (const piano of [false, true]) for (const contentScale of [.25, 2]) {
      const score = new Score(); score.title = "极限缩放页眉";
      score.instrumentName = piano ? "钢琴" : "小提琴"; score.piano = piano;
      score.parts = Array.from({ length: piano ? 2 : 1 }, () => {
        const part = new Part(); part.instrumentName = score.instrumentName; return part;
      });
      for (const [partIndex, part] of score.parts.entries()) for (let index = 0; index < 12; index++) {
        const measure = new Measure(index); part.measures.push(measure);
        for (let step = 0; step < 4; step++) {
          const chord = new Chord(measure); chord.position = new Fraction(step); chord.duration = new Fraction(1);
          const note = new Note(); note.pitch = (partIndex ? 36 : 60) + step * 2;
          chord.add(note); measure.add(chord);
        }
      }
      const snapshot = { score, sources: [], registry: createStaffNoteRegistry(score, [], 8), revision: 8,
        current: true, engravingStyle: { notationScale: 1, contentScale } };
      const doc = await prepareStaffPreview(snapshot);
      const pages = [];
      for (let index = 0; index < doc.pageCount; index++) {
        const rendered = doc.renderPage(index); document.body.replaceChildren(rendered.svg);
        const svg = rendered.svg; const origin = svg.getBoundingClientRect();
        const box = node => {
          const rect = node.getBoundingClientRect();
          return { left: rect.left - origin.left, right: rect.right - origin.left,
            top: rect.top - origin.top, bottom: rect.bottom - origin.top };
        };
        const labels = [...svg.querySelectorAll('[data-staff-prose="instrument"]')].map(box);
        const braces = [...svg.querySelectorAll('[data-staff-brace]')].map(box);
        const systems = [...svg.querySelectorAll(':scope > g')].map(group =>
          [...group.querySelectorAll('g.vf-stave path')].map(box));
        const header = [...svg.querySelectorAll(':scope > text')].filter(text => text.textContent === score.title).map(box);
        const annotations = [...svg.querySelectorAll('[data-staff-prose="annotation"]')].map(box);
        pages.push({ labels, braces, systems, header, annotations,
          paper: svg.getAttribute('viewBox'), noteCount: rendered.notes.length });
      }
      results.push({ piano, contentScale, pages });
    }
    return results;
  });
  for (const row of edgeRows) {
    assert(row.pages.every(page => page.paper === "0 0 794 1123"));
    assert.equal(row.pages.reduce((sum, page) => sum + page.noteCount, 0), row.piano ? 96 : 48);
    for (const page of row.pages) {
      assert(page.labels.length > 0 && page.systems.length > 0);
      for (const label of page.labels) {
        assert(label.left >= -0.5 && label.right < 64, `label clipped or touching stave at ${row.contentScale}, piano=${row.piano}`);
        assert(label.top >= 0 && label.bottom <= 1123, `label above or below paper at ${row.contentScale}`);
      }
      for (const brace of page.braces) {
        assert(page.labels.every(label => label.right + 1 < brace.left),
          `shared piano label collided with brace at ${row.contentScale}`);
      }
      for (const staveLines of page.systems) {
        assert(staveLines.length > 0);
        assert(staveLines.every(line => line.top >= -1 && line.bottom <= 1123), `system cropped at ${row.contentScale}`);
      }
      for (let index = 1; index < page.systems.length; index++) {
        const previousBottom = Math.max(...page.systems[index - 1].map(line => line.bottom));
        const nextTop = Math.min(...page.systems[index].map(line => line.top));
        assert(previousBottom < nextTop, `successive systems overlap at ${row.contentScale}`);
      }
      if (page.header.length) assert(page.header.every(header => header.top >= 0
        && header.bottom < Math.min(...page.systems[0].map(line => line.top),
          ...page.annotations.map(annotation => annotation.top))),
        `header collided with first system at ${row.contentScale}`);
    }
  }
  console.log(JSON.stringify(rows.map(({ contentScale, pageCount, firstSystemBars, sizes, staffGap }) =>
    ({ contentScale, pageCount, firstSystemBars, sizes, staffGap })), null, 2));
} finally { await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
