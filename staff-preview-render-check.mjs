// Standalone SVG/layout regression. Build first, or set APP_TEST_URL to a Vite URL.
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1300 } });
const externalFonts = [];
page.on("request", (request) => {
  if (/https?:/.test(request.url()) && !request.url().startsWith(url) && /woff|font|jsdelivr/i.test(request.url())) externalFonts.push(request.url());
});
try {
  await page.goto(url);
  await page.waitForFunction(() => typeof window.__staffPreviewTest === "function");
  const results = await page.evaluate(async () => {
    const api = await window.__staffPreviewTest();
    const { Score, Part, Measure, Chord, Note, Lyric, Tuplet, Fraction, PlaySpecKind, JumpSpec, TimePosition, createStaffNoteRegistry, prepareStaffPreview, buildStaffModel } = api;
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const fixture = (kind) => {
      const score = new Score(); score.title = `五线谱回归 ${kind}`; score.piano = kind === "piano";
      if (score.piano) score.instrumentName = "钢琴";
      score.parts = Array.from({ length: score.piano ? 2 : 1 }, (_, index) => {
        const part = new Part(); part.hand = score.piano ? index === 0 ? "right" : "left" : null;
        if (score.piano) part.instrumentName = "钢琴";
        return part;
      });
      const bars = kind === "dense" ? 2 : kind === "piano" ? 18 : kind === "triplet" ? 12 : 24;
      for (let p = 0; p < score.parts.length; p++) for (let m = 0; m < bars; m++) {
        const bar = new Measure(m); score.parts[p].measures.push(bar); bar.newSystem = m > 0 && m % 4 === 0;
        if (m === 0) bar.repeatForward = true;
        if (m === 3) { bar.repeatBackward = true; bar.endingNum = new Set([1]); }
        const count = kind === "dense" ? 32 : kind === "poly" ? 8 : kind === "triplet" ? 3 : 4;
        const notes = [];
        for (let e = 0; e < count; e++) {
          const chord = new Chord(bar);
          chord.position = kind === "triplet" ? new Fraction(e * (m === 0 ? 2 : 4), 3) : kind === "poly" ? new Fraction(Math.floor(e / 2)) : new Fraction(e * 4, count);
          chord.duration = kind === "triplet" ? new Fraction(m === 0 ? e === 2 ? 8 : 2 : 4, 3) : kind === "poly" ? new Fraction(1) : new Fraction(4, count);
          if (kind === "poly") chord.voice = e % 2;
          chord.stemUp = p === 0; bar.add(chord);
          const pitches = kind === "dense" ? [60 + e % 7, 72 + e % 7, 84 + e % 7] : e === 1 && m === 0 ? [60, 60, 64] : [kind === "poly" ? e % 2 ? 60 : 84 : p === 0 ? 60 + e % 4 * 2 : 36 + e % 4 * 2];
          pitches.forEach((pitch) => { const note = new Note(); note.pitch = pitch; chord.add(note); notes.push(note); });
          if (m === 0 && e === 0) {
            chord.ornaments = [{ kind: "upper-mordent" }]; chord.fermata = true;
            const grace = new Note(); grace.pitch = 62; grace.chord = chord; chord.graceNotes.push(grace);
            for (let verse = 1; verse <= 3; verse++) { const lyric = new Lyric(); lyric.number = verse; lyric.text = `歌词${verse}`; chord.notes[0].lyrics.push(lyric); }
          }
          if (m === 1 && e === 0) chord.ornaments = [{ kind: "lower-mordent" }];
          if (m === 2 && e === 0) chord.ornaments = [{ kind: "trill", subdivision: 16 }];
          if (m === 1 && e === 1) chord.arpeggio = true;
          if (kind === "ordinary" && m === 2 && e === 1) chord.notes[0].pitch = 108;
          if (kind === "ordinary" && m === 6 && e === 0) chord.duration = new Fraction(3, 2);
          if (kind === "ordinary" && m === 6 && e === 1) { chord.position = new Fraction(3, 2); chord.duration = new Fraction(1, 2); }
          if (kind === "ordinary" && m === 7 && e === 0) { chord.rest = true; chord.notes[0].rest = true; }
          if (kind === "piano" && m === 2 && e === 1) chord.notes[0].pitch = p ? 24 : 96;
        }
        if (kind === "triplet") { const tuple = new Tuplet(notes[0], notes[notes.length - 1]); notes.forEach((note) => note.tuplet = tuple); }
      }
      const part = score.parts[0];
      const from = part.measures[3]?.entries[part.measures[3].entries.length - 1];
      const to = part.measures[4]?.entries[0];
      if (from && to) { to.notes[0].pitch = from.notes[0].pitch; from.notes[0].tieNext = to.notes[0]; to.notes[0].tiePrev = from.notes[0]; from.notes[0].tieStart = true; to.notes[0].tieEnd = true; from.slurEndChord = to; }
      if (kind === "navigation") {
        score.playData.segno.set("A", new TimePosition(0, new Fraction(0)));
        score.playData.coda.set("B", new TimePosition(12, new Fraction(0)));
        for (const [measure, kind, target] of [[8, PlaySpecKind.ToCoda, "B"], [15, PlaySpecKind.Fine, null], [20, PlaySpecKind.DalSegno, "A"], [23, PlaySpecKind.Dacapo, null]]) {
          const jump = new JumpSpec(kind); jump.value = target;
          score.playData.jumpTo.set(new TimePosition(measure, new Fraction(4)), jump);
        }
      }
      return score;
    };
    const snapshot = (score, revision) => ({ score, revision, sources: [], registry: createStaffNoteRegistry(score, [], revision), current: true });
    const fingerprint = (score) => JSON.stringify(score.parts.map(part => part.measures.map(measure => measure.entries.map(chord => [chord.position.toString(), chord.duration.toString(), chord.voice, chord.stemUp, chord.notes.map(note => [note.pitch, note.tieStart, note.tieEnd, note.softDeleted])]))));
    const summaries = [];
    let oldDoc; let oldFirst;
    for (const kind of ["ordinary", "piano", "triplet", "poly", "dense", "navigation"]) {
      const score = fixture(kind); const source = snapshot(score, 1); const before = fingerprint(score);
      const model = buildStaffModel(source); const doc = await prepareStaffPreview(source);
      check(fingerprint(score) === before, `${kind}: preview mutated source pitch/duration`);
      const seen = new Set(); let glyphs = 0; let first;
      let text = ""; const symbols = [];
      for (let index = 0; index < doc.pageCount; index++) {
        const rendered = doc.renderPage(index); const mount = document.createElement("div"); mount.appendChild(rendered.svg); document.body.appendChild(mount);
        check(rendered.svg.getAttribute("viewBox") === "0 0 794 1123", `${kind}: page is not A4`);
        check(!rendered.svg.textContent.includes("upper-mordent") && !rendered.svg.textContent.includes("lower-mordent") && !rendered.svg.textContent.includes("trill"), `${kind}: ornament rendered as literal name`);
        if (kind === "piano") {
          const systems = [...rendered.svg.children].filter(node => node.tagName.toLowerCase() === "g");
          const names = [...rendered.svg.querySelectorAll('[data-staff-prose="instrument"]')];
          check(names.length === systems.length && names.every(name => name.textContent === "钢琴"),
            "piano: expected one shared instrument name per grand staff");
          systems.forEach((system, position) => {
            const braces = [...system.querySelectorAll('[data-staff-brace]')];
            check(braces.length > 0, "piano: grand staff brace missing");
            const braceLeft = Math.min(...braces.map(brace => {
              const box = brace.getBBox(); const matrix = brace.getCTM();
              return box.x * matrix.a + matrix.e;
            }));
            const box = names[position].getBBox();
            check(braceLeft - (box.x + box.width) >= 6,
              "piano: shared instrument name touches the brace");
          });
        }
        text += rendered.svg.textContent;
        symbols.push(...[...rendered.svg.querySelectorAll("[data-staff-navigation]")].map(node => node.getAttribute("data-staff-navigation")));
        for (const note of rendered.notes) {
          check(source.registry.resolve(note.ref)?.note != null, `${kind}: rendered ref cannot resolve`);
          check(note.element.tagName.toLowerCase() === "text", `${kind}: highlight includes a whole chord/lyric parent`);
          const hit = note.hitElement.getBBox(); const ctm = note.hitElement.getCTM();
          check(hit.width > 0 && hit.width <= 50 && hit.height > 0 && hit.height < 55, `${kind}: hit bounds are not tight glyph geometry`);
          check(hit.y * ctm.d + ctm.f > 0 && (hit.y + hit.height) * ctm.d + ctm.f < 1123, `${kind}: glyph outside page vertically`);
          check(hit.x * ctm.a + ctm.e >= 0 && (hit.x + hit.width) * ctm.a + ctm.e <= 794, `${kind}: glyph clipped outside A4 width`);
          seen.add(note.ref.id); glyphs++;
        }
        if (!first) first = rendered.notes[0];
        if (kind === "ordinary" && index === 0) { window.__staffRenderRegressionPage = rendered.svg.cloneNode(true); }
        if (kind === "piano" && index === 0) { window.__staffPianoRegressionPage = rendered.svg.cloneNode(true); }
        mount.remove();
      }
      const expected = source.registry.targets.filter(target => !target.note.softDeleted);
      if (kind === "navigation") {
        check(symbols.includes("segno") && symbols.includes("coda"), "navigation: musical target symbols missing");
        for (const label of ["D.C.", "D.S. A", "To Coda B", "Fine"]) check(text.includes(label), `navigation: missing ${label}`);
      }
      check(expected.every(target => seen.has(target.ref.id)), `${kind}: missing source notes`);
      check(doc.pagesForChords([score.parts[0].measures[0].entries[0]]).includes(0), `${kind}: pagesForChords misses opening chord`);
      check(doc.pageForRef({ ...first.ref, revision: 999 }) === null, `${kind}: stale revision accepted`);
      summaries.push({ kind, pages: doc.pageCount, glyphs, sourceNotes: expected.length, diagnostics: doc.diagnostics, tuplets: model.measures.flatMap(measure => measure.rows.flatMap(row => row.events)).filter(event => event.tuplet).length });
      if (kind === "ordinary") { oldDoc = doc; oldFirst = first; } else doc.dispose();
    }
    const newScore = fixture("ordinary"); const fresh = await prepareStaffPreview(snapshot(newScore, 2), oldDoc);
    oldDoc.dispose(); const rebound = fresh.renderPage(0).notes[0];
    check(rebound.ref.revision === 2 && rebound.chord === newScore.parts[0].measures[0].entries[0], "cache retained old source objects");
    check(rebound.chord !== oldFirst.chord && rebound.element !== oldFirst.element, "cache shares mutable source or DOM ownership");
    check(rebound.element.parentElement.id === oldFirst.element.parentElement.id, "unchanged geometry was rebuilt instead of reused");
    const cancelled = new AbortController(); cancelled.abort();
    let aborted = false; try { await prepareStaffPreview(snapshot(newScore, 3), fresh, cancelled.signal); } catch (error) { aborted = error.name === "AbortError"; }
    check(aborted, "cancelled job was accepted"); fresh.dispose();
    // A single-measure system always receives the same full width. Therefore
    // changing its neighboring meter/volta must invalidate SVG independently
    // of measured/allocated widths.
    const boundaries = fixture("ordinary"); boundaries.parts[0].measures.length = 2;
    const [left, right] = boundaries.parts[0].measures; right.newSystem = true;
    left.endingNum = new Set([1]); right.endingNum = new Set([1]);
    const initial = await prepareStaffPreview(snapshot(boundaries, 10));
    const initialPage = initial.renderPage(0);
    const systems = page => [...page.svg.children].filter(node => node.tagName.toLowerCase() === "g");
    check(systems(initialPage)[1].querySelectorAll("g.vf-timesignature").length === 0, "meter fixture has an unexpected repeated 4/4");
    left.time.beats = 3;
    const changedMeter = await prepareStaffPreview(snapshot(boundaries, 11), initial);
    const meterPage = changedMeter.renderPage(0);
    check(systems(meterPage)[1].querySelectorAll("g.vf-timesignature").length === 1, "cached next system did not show 3/4 → 4/4 change");
    const voltaLegs = page => [...systems(page)[0].querySelectorAll('rect[width="1"]')]
      .filter(rect => Math.abs(Number(rect.getAttribute("height")) - 15 * Math.SQRT1_2) < 0.1).length;
    const oldLegs = voltaLegs(meterPage);
    right.endingNum = null;
    const changedVolta = await prepareStaffPreview(snapshot(boundaries, 12), changedMeter);
    check(voltaLegs(changedVolta.renderPage(0)) === oldLegs + 1, "cached preceding system did not close its changed volta boundary");
    left.time.beats = 4; left.endingNum = null; left.key.fifths = 1; right.key.fifths = 0;
    boundaries.keyMarks = [{ measure: 0, offset: new Fraction(2), fifths: 0 }];
    left.entries.forEach((chord, index) => chord.notes.forEach(note => { note.step = "F"; note.octave = 4; note.alter = index < 2 ? 1 : 0; note.pitch = index < 2 ? 66 : 65; }));
    const changedKey = await prepareStaffPreview(snapshot(boundaries, 13), changedVolta);
    const keyPage = changedKey.renderPage(0);
    check([...systems(keyPage)[0].querySelectorAll("g.vf-keysignature text")].some(node => node.textContent === String.fromCharCode(0xe261)), "mid-measure G → C omitted cancellation natural");
    initial.dispose(); changedMeter.dispose(); changedVolta.dispose(); changedKey.dispose();
    summaries.push({ kind: "neighbor-cache-and-key-cancellation", ok: true });
    document.body.replaceChildren(window.__staffRenderRegressionPage);
    return summaries;
  });
  assert.deepEqual(externalFonts, [], "staff preview requested an external font");
  if (process.env.STAFF_TEST_SCREENSHOT) await page.screenshot({ path: process.env.STAFF_TEST_SCREENSHOT, fullPage: true });
  if (process.env.STAFF_PIANO_SCREENSHOT) {
    await page.evaluate(() => document.body.replaceChildren(window.__staffPianoRegressionPage));
    await page.locator("svg[role=img]").screenshot({ path: process.env.STAFF_PIANO_SCREENSHOT });
  }
  console.log(JSON.stringify({ ok: true, results, externalFonts }, null, 2));
} finally { await browser.close(); if (server) await new Promise((resolve) => server.close(resolve)); }
