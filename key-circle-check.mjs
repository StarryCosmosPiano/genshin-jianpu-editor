// Run after npm run build. Exercises the real bundled dialogs in local Edge.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = process.env.KEY_CIRCLE_CHECK_URL ? null : createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(await readFile(join(root, normalize(file))));
  } catch { response.writeHead(404); response.end(); }
});
if (server) await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

try {
  await page.goto(process.env.KEY_CIRCLE_CHECK_URL ?? `http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    const app = window.__app;
    app.setText(".Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 |]");
    const Fraction = app.painter.score.parts[0].measures[0].position.constructor;
    window.__testCursor = { partIndex: 0, measureIndex: 0,
      offset: new Fraction(0), division: 4, lane: "rest" };
    window.__keyTask = app.setInputKey(window.__testCursor);
  });
  await page.locator(".key-circle-dialog").waitFor();
  if (process.env.KEY_CIRCLE_SHOT) await page.locator(".key-circle-dialog").screenshot({ path: process.env.KEY_CIRCLE_SHOT });
  const keys = await page.locator(".key-circle-option").count();
  assert(keys === 15, `Expected all 15 keys, got ${keys}`);
  const cBox = await page.locator('.key-circle-option[data-fifths="0"]').boundingBox();
  const wheelBox = await page.locator(".key-circle-wheel").boundingBox();
  assert(cBox && wheelBox && cBox.y < wheelBox.y + wheelBox.height * .18, "C is not at twelve o'clock");
  assert(await page.locator('.key-circle-option[data-fifths="-7"] small').textContent() === "7 降", "C♭ count missing");
  assert(await page.locator('.key-circle-option[data-fifths="7"] small').textContent() === "7 升", "C♯ count missing");
  assert(await page.locator('.key-circle-option[data-fifths="0"]').getAttribute("aria-pressed") === "true", "Current key not marked");
  await page.keyboard.press("ArrowRight");
  assert(await page.locator('.key-circle-option[data-fifths="1"]').evaluate((node) => node === document.activeElement),
    "Arrow key did not advance key choice");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__keyTask);
  assert(await page.locator(".notation-dialog-layer").count() === 0, "Escape left the dialog open");

  await page.setViewportSize({ width: 360, height: 560 });
  await page.evaluate(() => { window.__keyTask = window.__app.setInputKey(window.__testCursor); });
  await page.locator(".key-circle-dialog").waitFor();
  const panel = await page.locator(".key-circle-dialog").boundingBox();
  assert(panel && panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= 361 && panel.y + panel.height <= 561,
    "Key dialog is clipped in a small viewport");
  await page.locator('.key-circle-option[data-fifths="-7"]').click();
  await page.evaluate(() => window.__keyTask);
  assert(await page.locator(".notation-dialog-layer").count() === 0, "Selection did not close the key dialog");

  await page.evaluate(() => { window.__timeTask = window.__app.setInputTimeSignature(window.__testCursor); });
  await page.locator(".time-signature-dialog").waitFor();
  await page.locator(".notation-time-custom input").fill("7");
  await page.locator(".notation-dialog-footer .primary").click();
  await page.evaluate(() => window.__timeTask);
  assert(await page.locator(".notation-dialog-layer").count() === 0, "Apply left the meter dialog open");

  await page.evaluate(() => { window.__keyTask = window.__app.setInputKey(window.__testCursor); });
  await page.locator(".key-circle-dialog").waitFor();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("editor:document-replaced")));
  await page.evaluate(() => window.__keyTask);
  assert(await page.locator(".notation-dialog-layer").count() === 0, "Document replacement did not dismiss dialog");
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  console.log("五度圈与拍号浮窗回归通过：15 调、C 顶端、升降数、键盘、窄窗、文档替换");
} finally {
  await browser.close();
  server?.close();
}
