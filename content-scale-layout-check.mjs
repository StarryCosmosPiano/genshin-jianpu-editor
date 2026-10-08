// Browser regression: resize every score element inside an unchanged A4 page.
// Run after npm run build; no browser/CSS zoom or source-text rewrite involved.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const urlArgument = process.argv.indexOf("--url");
const remoteUrl = urlArgument >= 0 ? process.argv[urlArgument + 1] : null;
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = remoteUrl ? null : createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    const data = await readFile(join(root, normalize(file)));
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
if (server) await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const scoreText = `.Title
Title = {整体内容缩放}
Instrument = {钢琴}
KeyAndMeters = {1=C,4/4}
Tempo = {90}
TempoMarks = {2@0=tempo:120}
KeyChanges = {3=G}
.Voice.RH
1 2 3 4 |1 2 3 4 |1 2 3 4 |1 2 3 4 |1 2 3 4 |1 2 3 4 |1 2 3 4 |1 2 3 4 |]
.Voice.LH
1,- 5,- |1,- 5,- |1,- 5,- |1,- 5,- |1,- 5,- |1,- 5,- |1,- 5,- |1,- 5,- |]
.Words
W1@1,1:
春 风 花 月/
`;

try {
  await page.goto(remoteUrl ?? `http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__app?.painter?.pageCount > 0);
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.setText(text);
    window.__contentScaleScore = app.painter.score;
  }, scoreText);
  await page.waitForFunction(() => window.__app.painter.score.title === "整体内容缩放"
    && window.__app.painter.score.parts[0]?.measures.length === 8);

  const inspect = async (scale) => page.evaluate((value) => {
    const app = window.__app;
    app.setEngravingStyle({ ...app.engravingStyle, contentScale: value,
      notationScale: Math.SQRT1_2, connectBarlines: true,
      measuresPerSystem: 6 }, false);
    const opt = app.painter.layout.options;
    const svg = document.querySelector("#score-pane svg");
    const textFont = (selector) => {
      const element = svg?.querySelector(selector);
      return element ? Number(element.getAttribute("font-size")) : null;
    };
    const exactTextFont = (value) => {
      const element = [...(svg?.querySelectorAll("text") ?? [])]
        .find((item) => item.textContent === value);
      return element ? Number(element.getAttribute("font-size")) : null;
    };
    const bars = [];
    const bracePaths = [];
    const pageNumbers = [];
    const walk = (item) => {
      if (item.classes?.has("measure-barline")) bars.push(item.data);
      if (item.classes?.has("piano-brace-path")) bracePaths.push(item);
      if (item.text === `1/${app.painter.pageCount}`) pageNumbers.push(item);
      for (const child of item.children) walk(child);
    };
    for (const scorePage of app.painter.layout.pages) walk(scorePage);
    const firstBar = bars[0]?.group.children[0];
    const digitBounds = "01234567".split("").map((digit) => opt.numberBound(digit));
    const expectedBarHeight = Math.max(...digitBounds.map((bound) => bound.bottom))
      - Math.min(...digitBounds.map((bound) => bound.top))
      + Math.max(...digitBounds.map((bound) => bound.height));
    const firstBrace = bracePaths[0];
    const braceSvg = firstBrace ? app.painter.nodeMap.get(firstBrace)?.querySelector("path") : null;
    const systemLine = svg?.querySelector(".piano-system-left line");
    const pageNumberSvg = pageNumbers[0]
      ? app.painter.nodeMap.get(pageNumbers[0])?.querySelector("text") : null;
    return {
      contentScale: value,
      pageW: app.pageW, pageH: app.pageH,
      viewBox: svg?.getAttribute("viewBox"),
      renderedWidth: svg?.getBoundingClientRect().width,
      text: app.getText(),
      scoreSame: app.painter.score === window.__contentScaleScore,
      rawFontSize: app.fontSize, rawTitleSize: app.titleSize,
      noteSize: opt.numberSize,
      lyricSize: exactTextFont("春"),
      titleSize: textFont(".publication-title text"),
      metaSize: textFont(".publication-meta text"),
      keySize: textFont(".key-signature-entry text"),
      tempoSize: textFont(".tempo-annotation text"),
      instrumentSize: exactTextFont("钢琴"),
      pageNumberSize: pageNumberSvg ? Number(pageNumberSvg.getAttribute("font-size")) : null,
      barWidth: firstBar?.strokeWidth,
      barHeight: firstBar?.height,
      expectedBarHeight,
      systemLineWidth: systemLine ? Number(systemLine.getAttribute("stroke-width")) : null,
      braceWidth: braceSvg?.getBBox().width,
      pages: app.painter.pageCount,
    };
  }, scale);

  const baseline = await inspect(1);
  const smallest = await inspect(0.25);
  const compact = await inspect(0.5);
  const enlarged = await inspect(1.5);
  const largest = await inspect(2);
  assert.equal(errors.length, 0, errors.join("; "));
  for (const sample of [smallest, compact, baseline, enlarged, largest]) {
    assert.equal(sample.pageW, 595);
    assert.equal(sample.pageH, 842);
    assert.equal(sample.viewBox, "0 0 595 842");
    assert.equal(sample.renderedWidth, baseline.renderedWidth, "whole-page zoom changed");
    assert.equal(sample.text, scoreText, "content scale rewrote source text");
    assert(sample.scoreSame, "content scale replaced the score model");
    assert.equal(sample.rawFontSize, baseline.rawFontSize, "raw font setting changed");
    assert.equal(sample.rawTitleSize, baseline.rawTitleSize, "raw title setting changed");
    assert(Math.abs(sample.barHeight - sample.expectedBarHeight) < 0.01,
      "barline height no longer follows the measured digit band");
    for (const field of ["noteSize", "lyricSize", "titleSize", "metaSize", "keySize",
      "tempoSize", "instrumentSize", "pageNumberSize", "barWidth",
      "systemLineWidth", "braceWidth"]) {
      assert(sample[field] > 0 && baseline[field] > 0, `${field} missing`);
      assert(Math.abs(sample[field] / baseline[field] - sample.contentScale) < 0.05,
        `${field} did not follow content scale ${sample.contentScale}`);
    }
  }
  console.log("content-scale-layout-check: ok", JSON.stringify({
    page: baseline.viewBox,
    note: [smallest, compact, baseline, enlarged, largest].map((item) => item.noteSize),
    title: [smallest, compact, baseline, enlarged, largest].map((item) => item.titleSize),
    pages: [smallest, compact, baseline, enlarged, largest].map((item) => item.pages),
  }));

  // A long valid score must repaginate within A4 when the content changes
  // size. Keep the source fixed and only change the engraving style.
  const longVoice = `${Array(72).fill("1 2 3 4").join(" | ")} |]`;
  const longLower = `${Array(72).fill("1,- 5,-").join(" | ")} |]`;
  const longText = `.Title\nTitle = {整体分页核对}\nInstrument = {钢琴}\nKeyAndMeters = {1=C,4/4}\n.Voice.RH\n${longVoice}\n.Voice.LH\n${longLower}\n`;
  await page.evaluate((text) => {
    window.__longContentText = text;
    window.__app.setText(text);
  }, longText);
  await page.waitForFunction(() => window.__app.painter.score.title === "整体分页核对"
    && window.__app.painter.score.parts[0]?.measures.length === 72);
  const pageCounts = [];
  for (const scale of [0.5, 1, 1.5]) {
    pageCounts.push(await page.evaluate((value) => {
      const app = window.__app;
      app.setEngravingStyle({ ...app.engravingStyle, contentScale: value }, false);
      return { pages: app.painter.pageCount, textSame: app.getText() === window.__longContentText,
        viewBox: document.querySelector("#score-pane svg")?.getAttribute("viewBox") };
    }, scale));
  }
  assert(pageCounts[0].pages <= pageCounts[1].pages && pageCounts[1].pages <= pageCounts[2].pages,
    `larger content unexpectedly used fewer pages: ${pageCounts.map((item) => item.pages).join(",")}`);
  assert(pageCounts[0].pages < pageCounts[2].pages,
    "content slider did not change pagination for a long score");
  assert(pageCounts.every((item) => item.textSame), "repagination rewrote source text");
  assert(pageCounts.every((item) => item.viewBox === "0 0 595 842"), "long score changed paper size");
  console.log("content-scale-layout-check: long-score pages", pageCounts.map((item) => item.pages));

  const lyricFixtures = [
    { label: "piano", title: "钢琴双手简谱示例",
      text: await readFile("examples/piano-demo.jpwabc", "utf-8") },
    { label: "single", title: "普通歌词核对",
      text: `.Title\nTitle = {普通歌词核对}\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 | 5 6 7 1' |]\n.Words\nW1@1,1:\n双 手 简 谱/同 步 排 版/\n` },
  ];
  for (const fixture of lyricFixtures) {
    await page.evaluate((text) => window.__app.setText(text), fixture.text);
    await page.waitForFunction((title) => window.__app.painter.score.title === title, fixture.title);
    for (const scale of [0.5, 1, 1.5]) {
      const geometry = await page.evaluate((value) => {
        const app = window.__app;
        app.setEngravingStyle({ ...app.engravingStyle, contentScale: value }, false);
        const lyricEntries = [];
        const allEntries = [];
        const visit = (item, pageRoot, system) => {
          const currentSystem = item.classes?.has("piano-system") ? item : system;
          if (Array.isArray(item.data?.numbers)) {
            const record = { entry: item.data, pageRoot, system: currentSystem };
            allEntries.push(record);
            if (item.data.lrc) lyricEntries.push(record);
          }
          for (const child of item.children) visit(child, pageRoot, currentSystem);
        };
        for (const scorePage of app.painter.layout.pages) visit(scorePage, scorePage, null);
        const tightBox = (item, pageRoot) => {
          const position = item.pos(pageRoot);
          const glyph = item.font.charBound(item.text);
          return { left: position.x + glyph.left, right: position.x + glyph.right,
            top: position.y + glyph.top, bottom: position.y + glyph.bottom };
        };
        const visualBox = (item, pageRoot) => {
          const position = item.pos(pageRoot);
          const shape = item.font && item.text
            ? item.font.charBound(item.text)
            : item.childrenBound && item.children.length > 0 ? item.childrenBound : item.bound;
          return { left: position.x + shape.left, right: position.x + shape.right,
            top: position.y + shape.top, bottom: position.y + shape.bottom };
        };
        const conflicts = [];
        let compared = 0;
        let minimumGap = Infinity;
        for (const { entry, pageRoot, system } of lyricEntries) {
          const lyric = entry.lrc;
          const lyricBox = tightBox(lyric, pageRoot);
          if (!app.painter.nodeMap.get(lyric)?.querySelector("text")) {
            conflicts.push(`unrendered lyric ${lyric.text}`);
            continue;
          }
          for (const neighbour of entry.line.entries) {
            for (const number of neighbour.numbers ?? []) {
              const noteBox = tightBox(number, pageRoot);
              if (lyricBox.left >= noteBox.right || lyricBox.right <= noteBox.left) continue;
              compared++;
              const gap = lyricBox.top - noteBox.bottom;
              minimumGap = Math.min(minimumGap, gap);
              if (gap < -0.01) conflicts.push(`${lyric.text} overlaps ${number.text} by ${(-gap).toFixed(2)}`);
            }
            for (const music of neighbour.group.children) {
              if (music === neighbour.lrc || music.classes?.has("notation-hidden-label")) continue;
              const box = visualBox(music, pageRoot);
              if (lyricBox.left < box.right - 0.01 && lyricBox.right > box.left + 0.01
                && lyricBox.top < box.bottom - 0.01 && lyricBox.bottom > box.top + 0.01) {
                conflicts.push(`${lyric.text} overlaps ${music.text ?? [...music.classes].join("/")}`);
              }
            }
          }
          for (const beam of entry.line.beams) {
            const box = visualBox(beam, pageRoot);
            if (lyricBox.left < box.right - 0.01 && lyricBox.right > box.left + 0.01
              && lyricBox.top < box.bottom - 0.01 && lyricBox.bottom > box.top + 0.01) {
              conflicts.push(`${lyric.text} overlaps a reduction beam`);
            }
          }
          if (system) for (const other of allEntries) {
            if (other.system !== system || other.entry.sourcePartIndex === entry.sourcePartIndex) continue;
            for (const number of other.entry.numbers) {
              const noteBox = tightBox(number, pageRoot);
              if (lyricBox.left < noteBox.right - 0.01 && lyricBox.right > noteBox.left + 0.01
                && lyricBox.bottom > noteBox.top + 0.01 && lyricBox.top < noteBox.bottom - 0.01) {
                conflicts.push(`${lyric.text} overlaps the other hand's ${number.text}`);
              }
            }
          }
        }
        return { lyricCount: lyricEntries.length, compared, minimumGap, conflicts,
          lyricFont: lyricEntries[0]?.entry.lrc?.font.size,
          pages: app.painter.pageCount,
          viewBox: document.querySelector("#score-pane svg")?.getAttribute("viewBox") };
      }, scale);
      assert(geometry.lyricCount >= 4 && geometry.compared > 0,
        `${fixture.label} ${scale}: lyric fixture did not exercise note intersections`);
      assert.deepEqual(geometry.conflicts, [],
        `${fixture.label} ${scale}: rendered lyric glyphs overlap music`);
      assert(geometry.minimumGap >= 0, `${fixture.label} ${scale}: missing lyric clearance`);
      assert.equal(geometry.viewBox, "0 0 595 842");
      if (process.argv.includes("--lyric-screenshots")) {
        const path = join(tmpdir(), `jianpu-lyric-${fixture.label}-${Math.round(scale * 100)}.png`);
        await page.locator("#score-pane svg").first().screenshot({ path });
        console.log("lyric screenshot", path);
      }
    }
  }
  console.log("content-scale-layout-check: lyric glyphs clear music at 50/100/150 in single and piano scores");
} finally {
  await browser.close();
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
