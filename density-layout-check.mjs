// Browser regression for A4 numbered-notation density and its real SVG geometry.
// Run after npm run build.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    const data = await readFile(join(root, normalize(file)));
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 3 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const jpw = `.Title
Title = {A4简谱密度核对}
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
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__app?.painter?.pageCount > 0);
  await page.evaluate((text) => {
    window.__app.documentFormat = "jpw";
    window.__app.setText(text);
  }, jpw);
  await page.waitForFunction(() => window.__app.painter.score.parts[0]?.measures.length === 8);

  const read = async (scale, measures) => page.evaluate(({ scale, measures }) => {
    const app = window.__app;
    app.setEngravingStyle({ ...app.engravingStyle, notationScale: scale,
      measuresPerSystem: measures, connectBarlines: true }, false);
    const opt = app.painter.layout.options;
    const svg = document.querySelector("#score-pane svg");
    const textSize = (selector) => {
      const text = svg?.querySelector(selector);
      return text ? Number(text.getAttribute("font-size")) : null;
    };
    const allText = [...(svg?.querySelectorAll("text") ?? [])];
    const matchingText = (text) => {
      const item = allText.find((node) => node.textContent === text);
      return item ? Number(item.getAttribute("font-size")) : null;
    };
    const systems = [];
    const bars = [];
    const walk = (item) => {
      if (item.classes?.has("piano-system")) systems.push(item);
      if (item.classes?.has("measure-barline")) bars.push(item.data);
      for (const child of item.children) walk(child);
    };
    for (const scorePage of app.painter.layout.pages) walk(scorePage);
    const bar = bars[0];
    const stroke = bar?.group.children[0];
    const finalBar = bars.find((item) => item.group.children.length === 2);
    const finalStrokes = finalBar?.group.children ?? [];
    const note = bar?.line.entries.find((entry) => entry.numbers?.length === 1
      && entry.numbers[0].text === "1");
    const digitBaseline = note?.numbers[0].pos(bar.line.group).y;
    const barTop = stroke?.pos(bar.line.group).y;
    const digitBounds = "01234567".split("").map((digit) => opt.numberBound(digit));
    const glyphTop = Math.min(...digitBounds.map((bound) => bound.top));
    const glyphBottom = Math.max(...digitBounds.map((bound) => bound.bottom));
    const glyphHeight = Math.max(...digitBounds.map((bound) => bound.height));
    const firstSystemBars = systems[0] ? bars.filter((item) => {
      let parent = item.group.parent;
      while (parent && parent !== systems[0]) parent = parent.parent;
      return parent === systems[0];
    }).length : 0;
    const firstSystemConnectors = systems[0]?.children.filter((item) =>
      item.classes?.has("piano-barline-connector")) ?? [];
    const firstSystemLeft = systems[0]?.children.find((item) =>
      item.classes?.has("piano-system-left"));
    const bracePath = svg?.querySelector(".piano-brace-path path");
    return {
      pageW: app.pageW, pageH: app.pageH,
      viewBox: svg?.getAttribute("viewBox"),
      svgWidth: svg?.getBoundingClientRect().width,
      noteSize: opt.numberSize,
      titleSize: textSize(".publication-title text"),
      metaSize: textSize(".publication-meta text"),
      keySize: textSize(".key-signature-entry text"),
      tempoSize: textSize(".tempo-annotation text"),
      instrumentSize: matchingText("钢琴"),
      lyricSize: matchingText("春"),
      firstSystemBars,
      firstSystemConnectors: firstSystemConnectors.length,
      systemLeftWidth: firstSystemLeft?.strokeWidth,
      braceWidth: bracePath?.getBBox().width,
      regularBarWidth: stroke?.strokeWidth,
      finalBarWidths: finalStrokes.map((item) => item.strokeWidth),
      finalBarHeights: finalStrokes.map((item) => item.height),
      barHeight: stroke?.height,
      barTop, barBottom: barTop === undefined ? null : barTop + stroke.height,
      digitBaseline,
      glyphTop, glyphBottom, glyphHeight,
    };
  }, { scale, measures });

  const old = await read(1, 4);
  const dense = await read(Math.SQRT1_2, 6);
  assert.equal(errors.length, 0, errors.join("; "));
  assert.equal(old.pageW, 595);
  assert.equal(old.pageH, 842);
  assert.equal(old.viewBox, "0 0 595 842");
  assert.equal(dense.viewBox, old.viewBox, "A4 SVG page changed size");
  assert(Math.abs(dense.svgWidth - old.svgWidth) < 0.01, "the whole SVG was zoomed");
  assert(Math.abs(dense.noteSize / old.noteSize - Math.SQRT1_2) < 1e-8,
    "number glyphs did not receive the density scale");
  for (const field of ["titleSize", "metaSize", "keySize", "tempoSize", "instrumentSize", "lyricSize"]) {
    assert(old[field] > 0 && dense[field] > 0, `${field} missing from the browser score`);
    assert.equal(dense[field], old[field], `${field} shrank with the notation`);
  }
  assert.equal(old.firstSystemBars, 8, "baseline first system did not contain four paired bars");
  assert.equal(dense.firstSystemBars, 12, "dense first system did not contain six paired bars");
  assert.equal(old.firstSystemConnectors, 4, "baseline barline connectors are incomplete");
  assert.equal(dense.firstSystemConnectors, 6, "dense barline connectors are incomplete");
  for (const field of ["systemLeftWidth", "braceWidth", "regularBarWidth"]) {
    assert(Math.abs(dense[field] / old[field] - Math.SQRT1_2) < 0.01,
      `${field} did not scale with the music`);
  }
  assert.equal(dense.finalBarWidths.length, 2, "final double barline is incomplete");
  assert(dense.finalBarWidths.every((width) => Math.abs(width / old.finalBarWidths[0] - Math.SQRT1_2) < 0.01),
    "final barline weights do not match the music scale");
  assert(dense.finalBarHeights.every((height) => Math.abs(height - dense.barHeight) < 0.01),
    "final barline segments have inconsistent heights");
  assert(Math.abs(dense.barHeight - (dense.glyphBottom - dense.glyphTop + dense.glyphHeight)) < 0.01,
    "barline did not extend a half digit height beyond both ends");
  assert(Math.abs(dense.barTop - (dense.digitBaseline + dense.glyphTop - dense.glyphHeight / 2)) < 0.01
    && Math.abs(dense.barBottom - (dense.digitBaseline + dense.glyphBottom + dense.glyphHeight / 2)) < 0.01,
  "barline top or bottom does not align with the actual digit band");
  console.log("density-layout-check: ok", JSON.stringify({
    page: dense.viewBox,
    musicScale: dense.noteSize / old.noteSize,
    oldBars: old.firstSystemBars / 2,
    denseBars: dense.firstSystemBars / 2,
    digitHeight: dense.glyphHeight,
    barHeight: dense.barHeight,
  }));

  // The following examples are tracked source fixtures. Require a changed
  // title after each load so a parser failure cannot make the previous score
  // accidentally satisfy geometry assertions.
  const symbolScores = [
    [await readFile("examples/三连音与延音线.jpwabc", "utf-8"), "三连音与延音线"],
    [await readFile("examples/ornaments-tempo-demo.jpwabc", "utf-8"), "琶音、倚音与速度变化"],
    [`.Title\nTitle = {附点弧线核对}\nKeyAndMeters = {1=C,4/4}\n.Voice\n(1_ 2_) 3_. 4_ | 5. 6' 7, 1- |]\n`, "附点弧线核对"],
  ];
  const symbolResults = [];
  const symbolScreenshots = [];
  for (const [source, title] of symbolScores) {
    await page.evaluate((text) => window.__app.setText(text), source);
    await page.waitForFunction((expected) => window.__app.painter.score.title === expected, title);
    const rows = [];
    for (const scale of [0.5, Math.SQRT1_2, 1, 1.5]) {
      rows.push(await page.evaluate((value) => {
        const app = window.__app;
        app.setEngravingStyle({ ...app.engravingStyle, notationScale: value,
          justifyLastSystem: false, measuresPerSystem: 8 }, false);
        const opt = app.painter.layout.options;
        const items = [];
        const walk = (item) => {
          items.push(item);
          for (const child of item.children) walk(child);
        };
        for (const scorePage of app.painter.layout.pages) walk(scorePage);
        const one = (predicate) => items.find(predicate);
        const node = (item) => item ? app.painter.nodeMap.get(item)?.firstElementChild : null;
        const line = (item) => {
          const element = node(item);
          return element?.tagName.toLowerCase() === "line"
            ? { length: Math.hypot(Number(element.getAttribute("x2")) - Number(element.getAttribute("x1")),
                Number(element.getAttribute("y2")) - Number(element.getAttribute("y1"))),
              stroke: Number(element.getAttribute("stroke-width")) }
            : null;
        };
        const path = (item) => {
          const element = node(item);
          return element?.tagName.toLowerCase() === "path"
            ? { width: element.getBBox().width, height: element.getBBox().height,
              stroke: Number(element.getAttribute("stroke-width")) }
            : null;
        };
        const text = (item) => {
          const element = node(item);
          return element?.tagName.toLowerCase() === "text"
            ? { width: element.getComputedTextLength(), font: Number(element.getAttribute("font-size")),
              dotWidth: element.textContent?.endsWith("·")
                ? element.getSubStringLength(element.textContent.length - 1, 1) : null }
            : null;
        };
        const beam = one((item) => item.level > 0 && item.left && item.right);
        const extension = one((item) => item.text === "-");
        const dotted = one((item) => item.text?.endsWith("·"));
        const octave = one((item) => item.owner);
        const tuplet = one((item) => item.classes?.has("tuplet-bracket"));
        const tie = one((item) => item.classes?.has("tie-span"));
        const graceBeam = one((item) => item.classes?.has("jianpu-grace-beam"));
        const graceLink = one((item) => item.classes?.has("jianpu-grace-link"));
        const beamBottomOfDigit = beam?.left?.number
          ? beam.left.number.pos(beam.left.line.group).y + beam.left.number.bound.bottom : null;
        const beamY = beam ? beam.pos(beam.left.line.group).y : null;
        const extensionEntry = extension?.parent?.data;
        const extensionIndex = extensionEntry?.line?.entries.indexOf(extensionEntry) ?? -1;
        const priorEntry = extensionIndex > 0
          ? [...extensionEntry.line.entries.slice(0, extensionIndex)].reverse().find((entry) => entry.number)
          : null;
        const extensionGap = priorEntry?.number && extensionEntry
          ? extension.pos(extensionEntry.line.group).x
            - (priorEntry.number.pos(extensionEntry.line.group).x + priorEntry.number.width)
          : null;
        const octaveOwner = octave?.owner;
        const octavePosition = octaveOwner ? octave.pos(octaveOwner.parent).y : null;
        const ownerPosition = octaveOwner?.y;
        const octaveGap = octavePosition === null || ownerPosition === undefined ? null
          : octavePosition < ownerPosition
            ? ownerPosition + octaveOwner.bound.top - (octavePosition + octave.height)
            : octavePosition - (ownerPosition + octaveOwner.bound.bottom);
        const tiePath = tie?.children.find((child) => node(child)?.tagName.toLowerCase() === "path");
        const curves = tiePath?.segs.filter((segment) => segment.op === "C") ?? [];
        const tieThickness = curves.length >= 2 ? curves[1].pts[1] - curves[0].pts[3] : null;
        const arpeggioItem = one((item) => item.classes?.has("jianpu-arpeggio"));
        const waveStart = arpeggioItem?.segs.find((segment) => segment.op === "M");
        const waveFirst = arpeggioItem?.segs.find((segment) => segment.op === "C");
        const titleText = document.querySelector("#score-pane .publication-title text");
        return {
          scale: value,
          titleFont: Number(titleText?.getAttribute("font-size")),
          noteFont: opt.numberSize,
          beam: line(beam),
          beamGap: beamY === null || beamBottomOfDigit === null ? null : beamY - beamBottomOfDigit,
          extension: text(extension),
          extensionGap,
          dotted: text(dotted),
          octave: path(octave),
          octaveGap,
          tie: path(tiePath),
          tieThickness,
          tuplet: path(tuplet),
          graceBeam: line(graceBeam),
          graceLink: path(graceLink),
          arpeggio: arpeggioItem && waveStart && waveFirst
            ? { ...path(arpeggioItem),
              amplitude: Math.abs(waveFirst.pts[0] - waveStart.pts[0]),
              halfWave: Math.abs(waveFirst.pts[5] - waveStart.pts[1]) }
            : null,
        };
      }, scale));
      if (process.argv.includes("--screenshots") && [0.5, 1, 1.5].includes(scale)) {
        const selectors = title === "三连音与延音线"
          ? [".tuplet-mark", ".tie-span"]
          : title === "琶音、倚音与速度变化"
            ? [".jianpu-arpeggio", ".jianpu-grace-group"]
            : [".tie-span", ".rhythmic-system"];
        const boxes = (await Promise.all(selectors.map((selector) =>
          page.locator(`#score-pane ${selector}`).first().boundingBox()))).filter(Boolean);
        assert(boxes.length > 0, `${title}: screenshot targets missing`);
        const padding = 24;
        const left = Math.max(0, Math.min(...boxes.map((box) => box.x)) - padding);
        const top = Math.max(0, Math.min(...boxes.map((box) => box.y)) - padding);
        const right = Math.min(1440, Math.max(...boxes.map((box) => box.x + box.width)) + padding);
        const bottom = Math.min(900, Math.max(...boxes.map((box) => box.y + box.height)) + padding);
        const label = title === "三连音与延音线" ? "beam-tuplet"
          : title === "琶音、倚音与速度变化" ? "grace-arpeggio" : "dotted-slur";
        const path = join(tmpdir(), `jianpu-${label}-${scale}.png`);
        await page.screenshot({ path, clip: { x: left, y: top,
          width: Math.max(1, right - left), height: Math.max(1, bottom - top) } });
        symbolScreenshots.push(path);
      }
    }
    symbolResults.push({ title, rows });
  }
  const failures = [];
  const scaled = (label, row, base, read, tolerance = 0.12) => {
    const observed = read(row);
    const unit = read(base);
    if (!(observed > 0) || !(unit > 0)) {
      failures.push(`${label}: missing SVG geometry`);
      return;
    }
    const ratio = observed / unit;
    if (Math.abs(ratio / row.scale - 1) > tolerance) {
      failures.push(`${label} at ${row.scale}: ratio ${ratio.toFixed(3)}, expected ${row.scale.toFixed(3)}`);
    }
  };
  for (const { title, rows } of symbolResults) {
    const base = rows.find((row) => row.scale === 1);
    assert(base, `${title}: no 1× reference`);
    for (const row of rows) {
      assert.equal(row.titleFont, base.titleFont, `${title}: title typography changed`);
      scaled(`${title} number font`, row, base, (item) => item.noteFont, 0.01);
      if (title === "三连音与延音线") {
        scaled("beam length", row, base, (item) => item.beam?.length);
        scaled("beam stroke", row, base, (item) => item.beam?.stroke);
        scaled("beam to digit gap", row, base, (item) => item.beamGap);
        scaled("tuplet bracket height", row, base, (item) => item.tuplet?.height);
        scaled("tuplet bracket stroke", row, base, (item) => item.tuplet?.stroke);
      }
      if (title === "琶音、倚音与速度变化") {
        scaled("grace beam length", row, base, (item) => item.graceBeam?.length);
        scaled("grace beam stroke", row, base, (item) => item.graceBeam?.stroke);
        scaled("grace link width", row, base, (item) => item.graceLink?.width);
        scaled("grace link stroke", row, base, (item) => item.graceLink?.stroke);
        scaled("arpeggio wave amplitude", row, base, (item) => item.arpeggio?.amplitude);
        scaled("arpeggio wave half-period", row, base, (item) => item.arpeggio?.halfWave);
        scaled("arpeggio wave stroke", row, base, (item) => item.arpeggio?.stroke);
        scaled("extension dash gap", row, base, (item) => item.extensionGap);
        scaled("octave dot gap", row, base, (item) => item.octaveGap);
      }
      if (title === "附点弧线核对") {
        scaled("dotted note glyph", row, base, (item) => item.dotted?.dotWidth);
        scaled("tie/slur arc height", row, base, (item) => item.tie?.height);
        scaled("tie/slur filled thickness", row, base, (item) => item.tieThickness);
        scaled("tie/slur outline", row, base, (item) => item.tie?.stroke);
      }
      scaled(`${title} extension dash width`, row, base, (item) => item.extension?.width);
      scaled(`${title} octave dot diameter`, row, base, (item) => item.octave?.width);
    }
  }
  assert.deepEqual(failures, [], `unscaled music marks:\n${failures.join("\n")}`);
  console.log("density-layout-check: notation marks scale at 0.5/0.707/1/1.5 with text unchanged");
  if (symbolScreenshots.length > 0) console.log("density screenshots", symbolScreenshots.join("\n"));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
