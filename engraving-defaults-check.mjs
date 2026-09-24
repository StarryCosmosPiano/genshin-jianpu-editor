// Verify migration against either the local dist build or APP_TEST_URL (Pages).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const remoteUrl = process.env.APP_TEST_URL;
const dist = join(process.cwd(), "dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = remoteUrl ? null : createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(await readFile(join(dist, normalize(file))));
  } catch { response.writeHead(404); response.end(); }
});
if (server) await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = remoteUrl ?? `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const oldBrace = { braceWidthScale: 0.7, braceStrokeWidth: 0.5 };
const newBrace = { braceWidthScale: 0.35, braceStrokeWidth: 3.2 };
const state = async (page) => page.evaluate(() => {
  const app = window.__app;
  const saved = JSON.parse(localStorage.getItem("jpeditor-render-settings") ?? "{}");
  const d = document.querySelector("#score-pane .piano-brace-path path")?.getAttribute("d") ?? "";
  return {
    style: app.engravingStyle,
    saved,
    braceWidth: Number(/^M([\d.]+)/.exec(d)?.[1]),
    pageW: app.pageW, pageH: app.pageH,
    titleSize: app.titleSize, codePaneWidth: app.codePaneWidth,
    beatPositionFormat: app.beatPositionFormat,
  };
});
const ready = async (page) => {
  await page.waitForFunction(() => window.__app?.painter?.pageCount > 0);
  await page.locator("#score-pane .piano-brace-path path").first().waitFor();
};

async function check(label, initial, expected, extra = () => {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await ready(page);
    if (initial !== null) {
      await page.evaluate((settings) => localStorage.setItem(
        "jpeditor-render-settings", JSON.stringify(settings)), initial);
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready(page);
    }
    const first = await state(page);
    assert.equal(first.style.braceWidthScale, expected.braceWidthScale, `${label}: width`);
    assert.equal(first.style.braceStrokeWidth, expected.braceStrokeWidth, `${label}: stroke`);
    assert.equal(first.saved.engravingStyleVersion, 1, `${label}: version was not saved`);
    assert.deepEqual({
      braceWidthScale: first.saved.engravingStyle?.braceWidthScale,
      braceStrokeWidth: first.saved.engravingStyle?.braceStrokeWidth,
    }, expected, `${label}: stored style`);
    extra(first);
    await page.reload({ waitUntil: "domcontentloaded" });
    await ready(page);
    const reopened = await state(page);
    assert.deepEqual({
      braceWidthScale: reopened.style.braceWidthScale,
      braceStrokeWidth: reopened.style.braceStrokeWidth,
    }, expected, `${label}: style changed on reload`);
    assert.equal(reopened.saved.engravingStyleVersion, 1, `${label}: version changed on reload`);
    assert.equal(errors.length, 0, `${label}: browser errors: ${errors.join("; ")}`);
  } finally {
    await context.close();
  }
}

try {
  await check("fresh", null, newBrace, (result) => {
    assert(Math.abs(result.braceWidth - 7.056) < 0.01,
      `fresh: unexpected brace path width ${result.braceWidth}`);
  });
  await check("legacy pair", {
    engravingStyle: { ...oldBrace, pianoHandGap: 1.8, numberBold: true },
    pageOrientationVersion: 1, pageW: 700, pageH: 900,
    titleSize: 52, codePaneWidth: 440, beatPositionFormat: "decimal",
  }, newBrace, (result) => {
    assert(Math.abs(result.braceWidth - 7.056) < 0.01,
      `legacy pair: old brace geometry remained ${result.braceWidth}`);
    assert.equal(result.style.pianoHandGap, 1.8);
    assert.equal(result.style.numberBold, true);
    assert.equal(result.pageW, 700);
    assert.equal(result.pageH, 900);
    assert.equal(result.titleSize, 52);
    assert.equal(result.codePaneWidth, 440);
    assert.equal(result.beatPositionFormat, "decimal");
    assert.equal(result.saved.pageW, 700, "migration overwrote unread page settings");
    assert.equal(result.saved.engravingStyle.pianoHandGap, 1.8);
  });
  await check("version zero", { engravingStyleVersion: 0, engravingStyle: oldBrace }, newBrace);
  await check("custom width", { engravingStyle: { ...oldBrace, braceWidthScale: 0.9 } },
    { braceWidthScale: 0.9, braceStrokeWidth: 0.5 });
  await check("custom stroke", { engravingStyle: { ...oldBrace, braceStrokeWidth: 1.4 } },
    { braceWidthScale: 0.7, braceStrokeWidth: 1.4 });
  await check("already new", { engravingStyle: newBrace }, newBrace);
  await check("versioned old pair", { engravingStyleVersion: 1, engravingStyle: oldBrace }, oldBrace);
  console.log(`engraving-defaults-check: ok (${url})`);
} finally {
  await browser.close();
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
