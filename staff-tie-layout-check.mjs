// Build first, or set APP_TEST_URL to a running Vite instance.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const artifactDir = process.env.STAFF_TIE_ARTIFACT_DIR ?? "artifacts/tie-layout-20261020";
await mkdir(artifactDir, { recursive: true });
let server;
let baselineServer;
let url = process.env.APP_TEST_URL;
if (process.env.STAFF_TIE_BASELINE) {
  const { createServer: createViteServer } = await import("vite");
  baselineServer = await createViteServer({
    server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
    plugins: [{ name: "staff-tie-baseline", enforce: "pre", async load(id) {
      if (id.replaceAll("\\", "/").split("?")[0].endsWith("/src/staff-preview/renderer.ts"))
        return readFile(process.env.STAFF_TIE_BASELINE, "utf8");
    } }],
  });
  await baselineServer.listen(); url = baselineServer.resolvedUrls.local[0];
  console.log(`Baseline renderer served independently at ${url}`);
}
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 1200 }, deviceScaleFactor: 2 });
  await page.goto(url);
  await page.waitForFunction(() => typeof window.__staffPreviewTest === "function");
  const report = await page.evaluate(async () => {
    const { Score, Part, Measure, Chord, Note, Fraction, createStaffNoteRegistry, prepareStaffPreview } = await window.__staffPreviewTest();
    const specs = [
      { name: "low-ledger-chord", pitches: [55, 60] },
      { name: "low-second-chord", pitches: [59, 60] },
      { name: "high-ledger-chord", pitches: [84, 89] },
      { name: "high-second-chord", pitches: [83, 84] },
      { name: "low-three-note-chord", pitches: [55, 59, 60] },
      { name: "high-three-note-chord", pitches: [83, 84, 89] },
      { name: "low-partial-chord", pitches: [55, 59, 60], tied: [0, 2] },
      { name: "high-partial-chord", pitches: [83, 84, 89], tied: [0, 2] },
      { name: "low-single-control", pitches: [55] },
      { name: "high-single-control", pitches: [89] },
    ].flatMap(spec => [false, true].map(tight => ({ ...spec, tight, crossSystem: false })));
    specs.push(
      { name: "low-cross-system", pitches: [55, 60], tight: false, crossSystem: true },
      { name: "high-cross-system", pitches: [84, 89], tight: false, crossSystem: true },
      { name: "low-second-cross-system", pitches: [59, 60], tight: false, crossSystem: true },
      { name: "high-second-cross-system", pitches: [83, 84], tight: false, crossSystem: true },
    );
    const crosses = (a, b, c, d) => {
      const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
      return side(a, b, c) * side(a, b, d) < -1e-7 && side(c, d, a) * side(c, d, b) < -1e-7;
    };
    const rows = [];
    window.__tieLayoutScreenshots = [];
    let revision = 0;
    for (const notationScale of [.5, 1, 1.5]) for (const spec of specs) {
      const score = new Score(); score.title = `${spec.name} / ${spec.tight ? "tight" : "normal"} / ${notationScale}`;
      score.parts = [new Part()];
      const count = spec.tight ? 32 : 4;
      const denominator = spec.tight ? 8 : 1;
      const bars = spec.crossSystem ? 2 : 1;
      for (let m = 0; m < bars; m++) {
        const measure = new Measure(m); measure.newSystem = m > 0; score.parts[0].measures.push(measure);
        for (let n = 0; n < count; n++) {
          const chord = new Chord(measure); chord.position = new Fraction(n, denominator); chord.duration = new Fraction(1, denominator);
          for (const pitch of spec.pitches) { const note = new Note(); note.pitch = pitch; chord.add(note); }
          measure.add(chord);
        }
      }
      const sourceIndex = spec.crossSystem ? count - 1 : spec.tight ? 8 : 1;
      const targetIndex = spec.crossSystem ? 0 : spec.tight ? 9 : 2;
      const source = score.parts[0].measures[0].entries[sourceIndex];
      const target = score.parts[0].measures[spec.crossSystem ? 1 : 0].entries[targetIndex];
      source.notes.forEach((note, index) => {
        if (spec.tied && !spec.tied.includes(index)) return;
        const next = target.notes[index]; note.tieNext = next; next.tiePrev = note; note.tieStart = true; next.tieEnd = true;
      });
      const snapshot = { score, registry: createStaffNoteRegistry(score, [], ++revision), sources: [], revision, current: true,
        engravingStyle: { notationScale, rhythmGuideEnabled: true } };
      const doc = await prepareStaffPreview(snapshot);
      const pages = Array.from({ length: doc.pageCount }, (_, index) => doc.renderPage(index).svg);
      document.body.replaceChildren(...pages);
      const musicScale = .75 * notationScale;
      const failures = [];
      const curves = [];
      for (const svg of pages) for (const path of svg.querySelectorAll('[data-staff-arc="tie"]')) {
        const length = path.getTotalLength();
        const start = path.getPointAtLength(0); const end = path.getPointAtLength(length);
        const samples = Array.from({ length: 161 }, (_, index) => {
          const point = path.getPointAtLength(length * index / 160); return { x: point.x, y: point.y };
        });
        const sag = Math.max(...samples.map(point => Math.abs(point.y - (start.y + (end.y - start.y) * (point.x - start.x) / (end.x - start.x)))));
        const from = path.getAttribute("data-staff-arc-from"); const to = path.getAttribute("data-staff-arc-to");
        const parent = path.parentElement;
        const sourceGlyph = [...parent.querySelectorAll('[data-staff-pitch-id]')].find(glyph => glyph.getAttribute('data-staff-pitch-id') === from);
        const targetGlyph = [...parent.querySelectorAll('[data-staff-pitch-id]')].find(glyph => glyph.getAttribute('data-staff-pitch-id') === to);
        const ownHits = [sourceGlyph, targetGlyph].filter(Boolean).map(glyph => parent.querySelector(`[data-staff-hit="${glyph.getAttribute('data-staff-glyph')}"]`));
        const obstacles = [...parent.querySelectorAll('[data-staff-hit]')].filter(hit => !ownHits.includes(hit)).map(hit => ({
          kind: "head", left: Number(hit.getAttribute('data-staff-ink-x')), top: Number(hit.getAttribute('data-staff-ink-y')),
          right: Number(hit.getAttribute('data-staff-ink-x')) + Number(hit.getAttribute('data-staff-ink-width')),
          bottom: Number(hit.getAttribute('data-staff-ink-y')) + Number(hit.getAttribute('data-staff-ink-height')),
        }));
        for (const element of parent.querySelectorAll('g.vf-stem path,g.vf-beam > path,[data-staff-ledger]')) {
          const box = element.getBBox(); const pad = element.hasAttribute('data-staff-ledger') ? .6 * musicScale : 0;
          obstacles.push({ kind: element.hasAttribute('data-staff-ledger') ? "ledger" : "stem/beam",
            left: box.x, right: box.x + box.width, top: box.y - pad, bottom: box.y + box.height + pad });
        }
        const collisions = new Set();
        for (let distance = 3 * musicScale; distance < length - 3 * musicScale; distance += .3 * musicScale) {
          const point = path.getPointAtLength(distance);
          for (const obstacle of obstacles) {
            const inset = obstacle.kind === "head" ? .8 * musicScale : .1 * musicScale;
            if (point.x > obstacle.left + inset && point.x < obstacle.right - inset
              && point.y > obstacle.top + inset && point.y < obstacle.bottom - inset) collisions.add(obstacle.kind);
          }
        }
        const curve = { from, to, direction: path.getAttribute('data-staff-arc-direction'), span: end.x - start.x,
          normalizedSag: sag / musicScale, collisions: [...collisions], parent, samples };
        curves.push(curve);
        if (curve.normalizedSag > 12) failures.push(`deep tie (${curve.normalizedSag.toFixed(2)} music units)`);
        if (curve.collisions.length) failures.push(`tie crosses ${curve.collisions.join(", ")}`);
      }
      const groups = new Map();
      for (const curve of curves) { const group = groups.get(curve.parent) ?? []; group.push(curve); groups.set(curve.parent, group); }
      for (const group of groups.values()) {
        const sags = group.map(curve => curve.normalizedSag);
        if (sags.length > 1 && Math.max(...sags) - Math.min(...sags) > 1.8)
          failures.push(`unequal chord curvature (${sags.map(sag => sag.toFixed(2)).join(" / ")})`);
        for (let left = 0; left < group.length; left++) for (let right = left + 1; right < group.length; right++) {
          const a = group[left].samples; const b = group[right].samples;
          let crossed = false;
          for (let i = 0; i < a.length - 1 && !crossed; i++) for (let j = 0; j < b.length - 1 && !crossed; j++)
            crossed = crosses(a[i], a[i + 1], b[j], b[j + 1]);
          if (crossed) failures.push("chord ties intersect");
        }
      }
      const expected = (spec.tied?.length ?? spec.pitches.length) * (spec.crossSystem ? 2 : 1);
      if (curves.length !== expected) failures.push(`missing ties (${curves.length}/${expected})`);
      const headBounds = prefix => pages.flatMap(svg => [...svg.querySelectorAll('[data-staff-pitch-id]')])
        .filter(glyph => glyph.getAttribute('data-staff-pitch-id').startsWith(prefix))
        .map(glyph => {
          const hit = glyph.parentElement.closest('svg,g[transform]')?.querySelector(`[data-staff-hit="${glyph.getAttribute('data-staff-glyph')}"]`)
            ?? pages.flatMap(svg => [...svg.querySelectorAll('[data-staff-hit]')]).find(hit => hit.getAttribute('data-staff-hit') === glyph.getAttribute('data-staff-glyph'));
          const left = Number(hit.getAttribute('data-staff-ink-x')); const width = Number(hit.getAttribute('data-staff-ink-width'));
          return { id: glyph.getAttribute('data-staff-pitch-id'), left, right: left + width,
            top: Number(hit.getAttribute('data-staff-ink-y')), height: Number(hit.getAttribute('data-staff-ink-height')) };
        });
      const sourceHeads = headBounds(`p0m0e${sourceIndex}s0n`);
      const targetHeads = headBounds(`p0m${spec.crossSystem ? 1 : 0}e${targetIndex}s0n`);
      const row = { name: spec.name, spacing: spec.tight ? "tight" : "normal", notationScale,
        expected, sourceHeads, targetHeads,
        normalizedChordGap: spec.crossSystem ? null : (Math.min(...targetHeads.map(head => head.left)) - Math.max(...sourceHeads.map(head => head.right))) / musicScale,
        curves: curves.map(({ parent, samples, ...curve }) => curve), failures: [...new Set(failures)] };
      rows.push(row);
      if (notationScale === 1 && spec.pitches.length > 1)
        window.__tieLayoutScreenshots.push({ name: `${spec.name}-${row.spacing}`, pages });
      doc.dispose();
    }
    return rows;
  });
  await writeFile(join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  const screenshots = await page.evaluate(() => window.__tieLayoutScreenshots.map(({ name }) => name));
  for (let index = 0; index < screenshots.length; index++) {
    const count = await page.evaluate(index => {
      const item = window.__tieLayoutScreenshots[index]; document.body.replaceChildren(...item.pages); return item.pages.length;
    }, index);
    for (let pageIndex = 0; pageIndex < count; pageIndex++)
      await page.locator('svg[role="img"]').nth(pageIndex).screenshot({ path: join(artifactDir, `${screenshots[index]}-${pageIndex + 1}.png`) });
  }
  for (const row of report) console.log(`${row.failures.length ? "FAIL" : "PASS"} ${row.name} ${row.spacing} ${row.notationScale}x: `
    + `sag ${row.curves.map(curve => curve.normalizedSag.toFixed(2)).join(" / ")}; ${row.failures.join("; ") || "clear"}`);
  const failures = report.filter(row => row.failures.length);
  assert.equal(failures.length, 0, `${failures.length}/${report.length} tie layout cases failed; see ${artifactDir}/report.json`);
  console.log(`PASS all ${report.length} staff tie layout cases; screenshots: ${artifactDir}`);
} finally { await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); if (baselineServer) await baselineServer.close(); }
