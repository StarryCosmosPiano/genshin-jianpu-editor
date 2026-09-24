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
const fixture = `键盘谱\n4/4拍：\n点=16分音符\n(V${z}D${z}G).${z}A.${z}N.(${z}D${z}G)./.${z}A.${z}N.${z}A./(B${z}D${z}G).${z}A.${z}N.(${z}D${z}G)./.${z}N.${z}A.${z}N./\n`;
const notePoint = (part, at, pitch) => page.evaluate(({ part, at, pitch }) => {
  const app = window.__app;
  const source = app._sourceNotes.find((item) => item.partIndex === part
    && item.chord.position.toString() === at && item.note.pitch === pitch && !item.note.rest);
  const group = source && app.painter.noteGroupEls(source.chord, source.note)[0]?.element;
  const text = group?.querySelector("text");
  const box = text?.getBoundingClientRect();
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}, { part, at, pitch });
const contextAction = async (part, at, pitch, label) => {
  const point = await notePoint(part, at, pitch);
  assert(point, `no note for voice ${part + 1} at ${at}`);
  await page.mouse.click(point.x, point.y);
  await page.mouse.click(point.x, point.y, { button: "right" });
  const item = page.getByRole("menuitem", { name: label, exact: true });
  await item.waitFor({ state: "visible" });
  assert.equal(await item.isDisabled(), false, label);
  await item.click();
  await page.waitForTimeout(200);
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
  }, fixture);
  await page.waitForTimeout(250);
  await contextAction(1, "0", 53, "在光标处创建三连音");
  await contextAction(0, "1/4", 60, "上波音");

  const result = await page.evaluate(() => {
    const app = window.__app;
    const painter = app.painter;
    const svg = document.querySelector("#score-pane svg.score-page");
    const matrix = svg.getScreenCTM().inverse();
    const scorePoint = (x, y) => new DOMPoint(x, y).matrixTransform(matrix);
    const pick = (x, y, target = document.elementFromPoint(x, y), maxDistance = 0) =>
      painter.pickPageAtPointer(0, scorePoint(x, y), target, maxDistance);
    const source = (part, at, pitch) => app._sourceNotes.find((item) =>
      item.partIndex === part && item.chord.position.toString() === at
      && item.note.pitch === pitch && !item.note.rest);
    const number = (part, at, pitch) => {
      const note = source(part, at, pitch)?.note;
      const entry = note && painter.chordItem.get(note.chord)?.[0]?.item.data;
      return note && entry?.numbers[note.chord.notes.indexOf(note)];
    };
    const center = (element) => {
      const box = element?.getBoundingClientRect();
      return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
    };
    const hitNumber = (part, at, pitch) => {
      const item = number(part, at, pitch);
      const element = item && painter.nodeMap.get(item)?.querySelector("text");
      const origin = item?.pos(painter.layout.pages[0]);
      const ink = item?.font.charBound(item.text);
      const point = item && origin && ink ? new DOMPoint(
        painter.layout.pages[0].x + origin.x + (ink.left + ink.right) / 2,
        painter.layout.pages[0].y + origin.y + (ink.top + ink.bottom) / 2,
      ).matrixTransform(svg.getScreenCTM()) : null;
      return { exists: !!item && !!point,
        strict: !!point && pick(point.x, point.y, undefined, 0) === item,
        direct: !!point && pick(point.x, point.y, element, 0) === item };
    };
    const wave = app.painter.score.parts[0].measures[0].entries
      .find((entry) => entry.position.toString() === "1/4")?.ornaments[0];
    const waveItem = painter.itemGroupsForData(wave)[0]?.item;
    const waveGroup = waveItem && painter.nodeMap.get(waveItem);
    const waveText = waveGroup?.querySelector("text");
    const waveRect = waveGroup?.querySelector("rect");
    const waveCenter = center(waveRect);
    const waveHit = !!waveCenter && pick(waveCenter.x, waveCenter.y, undefined, 0) === waveItem;
    const fullBox = waveText?.getBoundingClientRect();
    const tightBox = waveRect?.getBoundingClientRect();
    // Find a point inside the browser's broad font box but outside the tight
    // model hit rect. A forced stale DOM target must not return the wave.
    const blankPoints = [];
    if (fullBox && tightBox) {
      for (const yRatio of [0.05, 0.25, 0.5, 0.75, 0.95]) {
        for (const xRatio of [0.05, 0.25, 0.5, 0.75, 0.95]) {
          const x = fullBox.x + fullBox.width * xRatio;
          const y = fullBox.y + fullBox.height * yRatio;
          if (x < tightBox.left || x > tightBox.right || y < tightBox.top || y > tightBox.bottom) {
            blankPoints.push({ x, y });
          }
        }
      }
    }
    const fontBlankRejected = blankPoints.length > 0 && blankPoints.every(({ x, y }) =>
      pick(x, y, waveText, 0) !== waveItem);
    const tupletGroup = document.querySelector("g.tuplet-number");
    const tupletItem = tupletGroup && painter.pageItemForTarget(tupletGroup);
    const tupletCenter = center(tupletGroup?.querySelector("rect"));
    const tupletHit = !!tupletCenter && pick(tupletCenter.x, tupletCenter.y, undefined, 0) === tupletItem;
    const bracket = document.querySelector("g.tuplet-bracket path");
    const bracketItem = bracket && painter.pageItemForTarget(bracket);
    const bracketCenter = center(bracket);
    const hollowBracketRejected = !!bracketCenter && !!bracketItem
      && pick(bracketCenter.x, bracketCenter.y, bracket, 0) !== bracketItem;
    const pageBlank = scorePoint(svg.getBoundingClientRect().right - 10,
      svg.getBoundingClientRect().bottom - 10);
    const emptyStrict = painter.pickPageAtPointer(0, pageBlank, svg, 0) === null;
    const emptyTolerant = painter.pickPageAtPointer(0, pageBlank, svg, 3) === null;
    return {
      waveHit, fontBlankRejected, blankCount: blankPoints.length, tupletHit,
      hollowBracketRejected, emptyStrict, emptyTolerant,
      a: hitNumber(0, "1/4", 60), n: hitNumber(0, "1/2", 57),
      chordLow: hitNumber(0, "0", 64), chordHigh: hitNumber(0, "0", 67),
      diagnostics: app._slashTimingDiagnostics.filter((item) => item.severity === "error"),
    };
  });
  assert.deepEqual(result.diagnostics, [], JSON.stringify(result));
  for (const key of ["a", "n", "chordLow", "chordHigh"]) {
    assert.deepEqual(result[key], { exists: true, strict: true, direct: true },
      `${key} picking: ${JSON.stringify(result)}`);
  }
  for (const key of ["waveHit", "fontBlankRejected", "tupletHit",
    "hollowBracketRejected", "emptyStrict", "emptyTolerant"]) {
    assert.equal(result[key], true, `${key}: ${JSON.stringify(result)}`);
  }
  assert(result.blankCount > 0, "test did not find SVG font-box whitespace");
  assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`);
  console.log("picking-check: ok (tight text, hollow paths, chord tones, empty space)");
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
