// Real browser UI regression. APP_TEST_URL can target an existing dev server.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const output = join(process.cwd(), "artifacts", "staff-preview");
await mkdir(output, { recursive: true });
let server;
let origin = process.env.APP_TEST_URL;
if (!origin) {
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
  server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
      const file = join(process.cwd(), "dist", normalize(path === "/" ? "/index.html" : path));
      response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
      response.end(await readFile(file));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, resolve));
  origin = `http://127.0.0.1:${server.address().port}/`;
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 960 }, colorScheme: "light" });
const page = await context.newPage();
const errors = [];
const results = [];
page.on("pageerror", error => errors.push(error.message));
const check = (label, condition) => { assert.ok(condition, label); results.push(label); };
const view = async value => { await page.locator("#staff-view-select").selectOption(value); await page.waitForTimeout(120); };
const ready = () => page.waitForFunction(() => document.querySelector("#staff-pages svg") && document.getElementById("staff-pane").dataset.staffRevision === String(window.__app.getStaffPreviewSnapshot().revision) && document.getElementById("staff-pane").getAttribute("aria-busy") === "false", { timeout: 30000 });
const mode = () => page.locator("#score-surfaces").getAttribute("data-staff-view");
const metric = () => page.evaluate(() => ({
  zoom: window.__app.zoom, summary: window.__app.workspaceSummary(),
  staffPageWidth: document.querySelector(".staff-page")?.getBoundingClientRect().width,
  staffWidth: document.getElementById("staff-pane").clientWidth,
  staffTop: document.getElementById("staff-pane").scrollTop,
  jianpuTop: window.__app.scorePane.scrollTop,
  jianpuPage: window.__app.pageIndex,
  toolbar: document.getElementById("toolbar").getBoundingClientRect().toJSON(),
  score: window.__app.scorePane.getBoundingClientRect().toJSON(),
  overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
  paper: getComputedStyle(document.querySelector(".score-page-wrap")).backgroundColor,
  theme: document.documentElement.dataset.theme,
  ratio: document.getElementById("score-surfaces").style.getPropertyValue("--staff-jianpu-ratio"),
}));
const screenshot = name => page.screenshot({ path: join(output, `${name}.png`) });
async function theme(value) {
  await page.locator("#btn-options").click();
  await page.locator(".modal-box").getByRole("combobox", { name: "外观" }).selectOption(value);
  await page.locator(".modal-box").getByRole("button", { name: "确定" }).click();
  await page.waitForFunction(value => document.documentElement.dataset.theme === value, value);
}
async function wheel(selector) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + Math.min(80, box.width / 2), box.y + Math.min(180, box.height / 2));
  await page.mouse.wheel(0, 260); await page.waitForTimeout(200);
}
try {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.waitForSelector(".score-page-wrap");
  check("starts in jianpu", await mode() === "jianpu");
  await screenshot("initial-light");
  // A genuine long source document supplies independent pages in both views.
  await page.evaluate(async () => {
    const source = `.Title\nTitle = 五线谱对照界面回归\nKeyAndMeters = {1=C,4/4}\n.Voice\n${Array.from({ length: 96 }, (_, i) => `${i % 2 ? "5 6 7 1'" : "1 2 3 4"} |`).join("\n")} ]`;
    await window.__app.importBytes(new TextEncoder().encode(source), "staff-ui-fixture.jpwabc");
  });
  await page.waitForTimeout(500);
  const originalToolbar = (await metric()).toolbar.height;
  await view("staff"); await ready();
  check("first open is compare", await mode() === "compare");
  let state = await metric();
  check("first preview fits its pane", state.staffPageWidth <= state.staffWidth - 30);
  check("opening preserves toolbar height", state.toolbar.height === originalToolbar);
  check("both pane page counts exist", await page.locator(".staff-page").count() > 1 && await page.locator(".score-page-wrap").count() > 1);
  await screenshot("compare-light");
  const staff = page.locator("#staff-pane");
  await staff.focus();
  check("active footer names staff", (await page.locator("#active-score-surface").textContent()).includes("五线谱"));
  const before = await metric();
  await page.locator("#btn-zoom-in").click();
  state = await metric();
  check("staff zoom leaves jianpu zoom unchanged", state.zoom === before.zoom && state.summary.zoom > before.summary.zoom);
  check("footer uses active staff zoom", await page.locator("#btn-zoom-reset").textContent() === `${Math.round(state.summary.zoom * 100)}%`);
  await page.locator("#btn-zoom-reset").click();
  await page.locator("#btn-next").click(); await page.waitForTimeout(150);
  state = await metric();
  check("staff page navigation is independent", state.jianpuPage === before.jianpuPage && state.staffTop > before.staffTop);
  await wheel("#staff-pane");
  check("staff manual wheel pauses its follow", await page.locator("#staff-resume-follow").isVisible());
  await page.locator("#staff-resume-follow").click();
  check("staff resume hides paused state", !await page.locator("#staff-resume-follow").isVisible());
  await wheel("#score-pane");
  check("jianpu wheel selects its footer", await page.locator("#active-score-surface").textContent() === "简谱");
  check("jianpu manual wheel pauses its follow", await page.locator("#staff-resume-follow").isVisible());
  await staff.focus();
  check("staff resume does not affect jianpu paused state", !await page.locator("#staff-resume-follow").isVisible());
  await page.locator("#score-pane").focus(); await page.locator("#staff-resume-follow").click();
  check("jianpu resume hides paused state", !await page.locator("#staff-resume-follow").isVisible());
  const box = await page.locator("#staff-divider").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 100); await page.mouse.down(); await page.mouse.move(box.x + 70, box.y + 100, { steps: 4 }); await page.mouse.up();
  const savedRatio = await page.evaluate(() => localStorage.getItem("staff-preview-divider"));
  check("drag divider saves ratio", Number(savedRatio) > 50);
  await page.locator("#staff-divider").focus(); await page.keyboard.press("ArrowLeft");
  const keyRatio = await page.evaluate(() => localStorage.getItem("staff-preview-divider"));
  check("keyboard divider saves ratio", Number(keyRatio) < Number(savedRatio));
  await page.setViewportSize({ width: 700, height: 800 }); await page.waitForTimeout(200);
  check("narrow score area changes compare to staff", await mode() === "staff");
  check("narrow compare option disabled", await page.locator('#staff-view-select option[value="compare"]').isDisabled());
  await screenshot("narrow-staff");
  await page.setViewportSize({ width: 1600, height: 960 }); await page.waitForTimeout(200);
  check("restoring width restores compare", await mode() === "compare");
  const jianpuTop = (await metric()).jianpuTop;
  await view("staff");
  check("explicit staff single mode", await mode() === "staff");
  await view("jianpu");
  check("closing single preserves jianpu position", Math.abs((await metric()).jianpuTop - jianpuTop) < 3);
  check("closing releases staff pages", await page.locator(".staff-page").count() === 0);
  await view("compare"); await ready();
  check("reopen remembers staff preference", await mode() === "staff");
  await view("compare"); await ready();
  const currentTop = (await metric()).jianpuTop;
  await view("jianpu");
  check("closing compare preserves current jianpu position", Math.abs((await metric()).jianpuTop - currentTop) < 3);
  await view("compare"); await ready();
  await theme("dark"); state = await metric();
  check("dark theme keeps white jianpu paper", state.paper === "rgb(255, 255, 255)");
  check("dark theme keeps white staff paper", await page.locator(".staff-page").first().evaluate(element => getComputedStyle(element).backgroundColor) === "rgb(255, 255, 255)");
  check("dark viewport does not overflow", !state.overflow);
  await screenshot("compare-dark");
  await theme("light");
  await page.reload({ waitUntil: "networkidle" }); await page.waitForSelector(".score-page-wrap");
  check("reload still defaults to jianpu", await mode() === "jianpu");
  check("reload restores divider ratio", parseFloat((await metric()).ratio) === Number(keyRatio));
  await view("staff"); await ready();
  check("reload restores remembered compare preview", await mode() === "compare");
  await view("jianpu");
  for (const [name, width, height] of [["standard", 1280, 900], ["compact", 900, 800], ["phone", 390, 844]]) {
    await page.setViewportSize({ width, height }); await page.waitForTimeout(150);
    state = await metric();
    check(`${name}: viewport does not overflow`, !state.overflow);
    check(`${name}: score remains tall`, state.score.height > 250);
    check(`${name}: original toolbar row height`, state.toolbar.height <= (width <= 760 ? 103 : width <= 1350 ? 86 : 49));
    check(`${name}: main toolbar controls fit`, await page.evaluate(() => ["btn-select-mode", "btn-input-mode", "btn-undo", "btn-redo", "btn-play", "btn-score-settings", "btn-layout-style"].every(id => { const r = document.getElementById(id).getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })));
    await screenshot(`${name}-jianpu`);
    await page.locator("#btn-layout-style").click();
    check(`${name}: inspector opens`, await page.locator("#inspector-pane").isVisible());
    await page.locator(".inspector-close").click();
  }
  check("no browser runtime errors", errors.length === 0);
  await writeFile(join(output, "ui-results.json"), JSON.stringify({ origin, checks: results, errors }, null, 2));
  console.log(`PASS ${results.length} staff/UI checks; screenshots: ${output}`);
} catch (error) {
  await screenshot("failure");
  await writeFile(join(output, "ui-results.json"), JSON.stringify({ origin, checks: results, errors, failure: String(error), metrics: await metric().catch(() => null) }, null, 2));
  throw error;
} finally { await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
