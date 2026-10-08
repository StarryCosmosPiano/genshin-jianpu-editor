// Validate the actual production bundle at / or a GitHub Pages project prefix.
// STAFF_DIST=artifacts/staff-pages-build BASE_PATH=/genshin-jianpu-editor/ node ...
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";

const root = resolve(process.env.STAFF_DIST || "dist");
const prefix = process.env.BASE_PATH || "/";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const requests = [];
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    requests.push(url.pathname);
    if (!url.pathname.startsWith(prefix)) throw new Error("incorrect base");
    const relative = decodeURIComponent(url.pathname.slice(prefix.length));
    const file = resolve(root, relative || "index.html");
    if (!file.startsWith(root + sep)) throw new Error("outside bundle");
    const bytes = await readFile(file);
    response.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  const external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin + "/")) external.push(request.url()); });
  page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(origin + prefix, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app?.isStaffPreviewCurrent());
  assert(!requests.some(path => /\/renderer-[^/]+\.js$/.test(path)), "staff renderer loaded before opening preview");
  await page.locator("#staff-view-select").selectOption("compare");
  await page.waitForFunction(() => document.querySelector("#staff-pages svg")
    && document.getElementById("staff-pane").getAttribute("aria-busy") === "false");
  assert(requests.some(path => path === `${prefix}redist/Bravura.woff2`), "local Bravura font was not requested under the deployment base");
  assert(await page.evaluate(() => document.fonts.check('40px "Bravura"')), "local notation font unavailable");
  assert(await page.locator("#staff-pages [data-staff-hit]").count() > 0, "production renderer has no note bindings");
  assert.deepEqual(external, [], "preview requested a CDN or external service");
  assert.deepEqual(errors, []);
  console.log(`staff-preview-assets-check: ${prefix} local lazy renderer + Bravura + SVG OK, no external requests`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
