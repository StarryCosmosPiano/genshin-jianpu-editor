import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = createServer(async (request, response) => {
  try {
    const urlPath = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = urlPath === "/" ? "/index.html" : urlPath;
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(await readFile(join(root, normalize(file))));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

const z = "\u2063";
const keyboard = `键盘谱\n4/4拍：\n点=16分音符\n(V${z}D${z}G).${z}A.${z}N.(${z}D${z}G)./.${z}A.${z}N.${z}A./(B${z}D${z}G).${z}A.${z}N.(${z}D${z}G)./.${z}N.${z}A.${z}N./\n`;

// Rasterize the actual font glyph in the browser. The point is chosen from
// opaque pixels, never from the model bbox or the transparent hit rectangle.
const glyphSample = (selector) => page.evaluate((selector) => {
  const text = document.querySelector(selector);
  if (!(text instanceof SVGTextElement)) return null;
  const item = window.__app.painter.pageItemForTarget(text);
  const fontSize = Number(text.getAttribute("font-size"));
  const family = text.getAttribute("font-family") ?? "Bravura";
  const weight = text.getAttribute("font-weight") ?? "normal";
  const scale = 4;
  const origin = 64;
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.scale(scale, scale);
  ctx.font = `${weight} ${fontSize}px "${family}"`;
  ctx.fillStyle = "#000";
  ctx.fillText(text.textContent ?? "", origin, origin);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
  const painted = [];
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    if (pixels[(y * canvas.width + x) * 4 + 3] < 48) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
    painted.push([x, y]);
  }
  if (!painted.length) return null;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const nearest = painted.reduce((best, point) => {
    const distance = (point[0] - cx) ** 2 + (point[1] - cy) ** 2;
    return distance < best.distance ? { point, distance } : best;
  }, { point: painted[0], distance: Infinity }).point;
  const local = { x: nearest[0] / scale - origin, y: nearest[1] / scale - origin };
  const matrix = text.getScreenCTM();
  if (!matrix) return null;
  const inkPoint = new DOMPoint(local.x, local.y).matrixTransform(matrix);
  const ink = { left: left / scale - origin, top: top / scale - origin,
    right: (right + 1) / scale - origin, bottom: (bottom + 1) / scale - origin };
  const svg = text.getBBox();
  const model = item?.bound;
  const oldLocal = model && { x: (model.left + model.right) / 2,
    y: model.bottom - Math.min(0.2, model.height / 10) };
  const oldPoint = oldLocal && new DOMPoint(oldLocal.x, oldLocal.y).matrixTransform(matrix);
  const svgRoot = text.closest("svg");
  const oldScorePoint = oldPoint && svgRoot?.getScreenCTM()?.inverse()
    ? new DOMPoint(oldPoint.x, oldPoint.y).matrixTransform(svgRoot.getScreenCTM().inverse()) : null;
  const oldModelStrictHit = !!oldScorePoint
    && window.__app.painter.pickPageAtPointer(0, oldScorePoint, text, 0) === item;
  const oldBelowInkPixels = oldLocal
    ? (oldLocal.y - ink.bottom) * Math.hypot(matrix.c, matrix.d) : 0;
  const lower = [0.96, 0.85, 0.74].map((fraction) => ({
    x: svg.x + svg.width / 2, y: svg.y + svg.height * fraction,
  })).find((candidate) => candidate.y > ink.bottom + 4 && candidate.y > (model?.bottom ?? -Infinity) + 4);
  const lowerPoint = lower && new DOMPoint(lower.x, lower.y).matrixTransform(matrix);
  return {
    inkPoint: { x: inkPoint.x, y: inkPoint.y },
    lowerPoint: lowerPoint ? { x: lowerPoint.x, y: lowerPoint.y } : null,
    oldPoint: oldPoint && oldLocal.y > ink.bottom + 0.5
      ? { x: oldPoint.x, y: oldPoint.y } : null,
    oldBelowInkPixels, oldModelStrictHit,
    ink, model: model ? { left: model.left, top: model.top,
      right: model.right, bottom: model.bottom } : null,
    svg: { left: svg.x, top: svg.y, right: svg.x + svg.width, bottom: svg.y + svg.height },
    targetAtInk: document.elementFromPoint(inkPoint.x, inkPoint.y)?.outerHTML.slice(0, 180),
  };
}, selector);

const clickCheck = async (selector, kind, label, inputMode, zoom) => {
  await page.evaluate(({ inputMode, zoom }) => {
    const app = window.__app;
    app.setInputMode(inputMode);
    app.setZoom(zoom);
    app.deselect(false);
  }, { inputMode, zoom });
  await page.waitForTimeout(80);
  const sample = await glyphSample(selector);
  assert(sample, `${label}: no rasterized ink sample`);
  await page.mouse.click(sample.inkPoint.x, sample.inkPoint.y);
  const selected = await page.evaluate(() => window.__app._selectedObjects.at(-1)?.kind ?? null);
  assert.equal(selected, kind,
    `${label} ${inputMode ? "input" : "select"} zoom=${zoom}: ink click selected ${selected}; ${JSON.stringify(sample)}`);
  if (sample.lowerPoint) {
    await page.evaluate(() => window.__app.deselect(false));
    await page.mouse.click(sample.lowerPoint.x, sample.lowerPoint.y);
    const below = await page.evaluate(() => window.__app._selectedObjects.at(-1)?.kind ?? null);
    assert.notEqual(below, kind,
      `${label} ${inputMode ? "input" : "select"} zoom=${zoom}: old lower blank still selected symbol`);
  }
  if (sample.oldPoint) {
    assert.equal(sample.oldModelStrictHit, false,
      `${label} ${inputMode ? "input" : "select"} zoom=${zoom}: old reflected model box was accepted at zero tolerance`);
    if (sample.oldBelowInkPixels > 3.5) {
      await page.evaluate(() => window.__app.deselect(false));
      await page.mouse.click(sample.oldPoint.x, sample.oldPoint.y);
      const below = await page.evaluate(() => window.__app._selectedObjects.at(-1)?.kind ?? null);
      assert.notEqual(below, kind,
        `${label} ${inputMode ? "input" : "select"} zoom=${zoom}: old reflected box still selected symbol`);
    }
  }
  return sample;
};

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = { kind: "keyboard", voiceCount: 2, instrumentName: "钢琴",
      title: "键盘谱", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, spaceDivision: null, noteDivision: null,
      braceMode: "chord", parenMode: "chord", bracketMode: "triplet" };
    app.setText(text);
    app.setInputMode(true);
    const first = app.painter.score.parts[1].measures[0].entries.find((entry) =>
      entry.position.toString() === "0" && entry.notes?.some((note) => !note.rest));
    app._input.setCursor(app.painter.score, { partIndex: 1, measureIndex: 0,
      offset: first.position, division: 16, lane: "rest" }, first.notes[0].pitch);
    app.addInputTriplet(app._input.cursor);
  }, keyboard);
  await page.waitForTimeout(250);
  const diagnostics = await page.evaluate(() => window.__app._slashTimingDiagnostics
    .filter((item) => item.severity === "error"));
  assert.deepEqual(diagnostics, []);

  const samples = {};
  for (const zoom of [0.6, 1, 1.6]) for (const inputMode of [false, true]) {
    samples[`triplet-${zoom}-${inputMode}`] = await clickCheck(
      "#score-pane g.tuplet-number text", "tuplet", "triplet 3", inputMode, zoom);
  }

  for (const [wave, kind] of [["upper", "upper-mordent"], ["lower", "lower-mordent"]]) {
    await page.evaluate((kind) => {
      const app = window.__app;
      const chord = app.painter.score.parts[0].measures[0].entries.find((entry) =>
        entry.position.toString() === "1/4" && entry.notes?.some((note) => !note.rest));
      if (chord.ornaments.length) app.setInputOrnament(chord, chord.ornaments[0].kind);
      const target = app.painter.score.parts[0].measures[0].entries.find((entry) =>
        entry.position.toString() === "1/4" && entry.notes?.some((note) => !note.rest));
      app.setInputOrnament(target, kind);
    }, kind);
    await page.waitForTimeout(250);
    for (const zoom of [0.6, 1, 1.6]) for (const inputMode of [false, true]) {
      samples[`${wave}-${zoom}-${inputMode}`] = await clickCheck(
        "#score-pane g.jianpu-ornament text", "ornament", `${wave} wave`, inputMode, zoom);
    }
  }

  // JPW supports a plain-text Tr ornament and a Bravura fermata. Add them on
  // separate ordinary notes so their real printed glyphs can be clicked too.
  const jpw = `.Title\nTitle = {符号点击}\nKeyAndMeters = {1=C,4/4}\nTempo = {90}\n.Voice\n1 2 3 4 |]\n`;
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    app.setInputMode(true);
  }, jpw);
  await page.waitForTimeout(200);
  const addJpwMark = async (at, label) => {
    const point = await page.evaluate((at) => {
      const app = window.__app;
      const source = app._sourceNotes.find((item) => item.partIndex === 0
        && item.chord.position.toString() === at && !item.note.rest);
      const text = source && app.painter.noteGroupEls(source.chord, source.note)[0]?.element.querySelector("text");
      const box = text?.getBoundingClientRect();
      return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
    }, at);
    assert(point, `${label}: no source note`);
    await page.mouse.click(point.x, point.y);
    await page.mouse.click(point.x, point.y, { button: "right" });
    const item = page.getByRole("menuitem", { name: label, exact: true });
    await item.waitFor({ state: "visible" });
    assert.equal(await item.isDisabled(), false, `${label}: unavailable`);
    await item.click();
    await page.waitForTimeout(200);
  };
  await addJpwMark("0", "Tr 颤音");
  await addJpwMark("1", "延长号");
  for (const zoom of [0.6, 1, 1.6]) for (const inputMode of [false, true]) {
    samples[`trill-${zoom}-${inputMode}`] = await clickCheck(
      "#score-pane g.jianpu-ornament text", "ornament", "Tr", inputMode, zoom);
    samples[`fermata-${zoom}-${inputMode}`] = await clickCheck(
      "#score-pane g.jianpu-fermata text", "fermata", "fermata", inputMode, zoom);
  }
  assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`);
  console.log(JSON.stringify({
    result: "symbol-picking-check: ok",
    bounds: Object.fromEntries(Object.entries(samples).filter(([name]) => name.endsWith("-1-false"))
      .map(([name, sample]) => [name, { ink: sample.ink, model: sample.model,
        svg: sample.svg, lowerBlankFound: !!sample.lowerPoint }])),
  }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
