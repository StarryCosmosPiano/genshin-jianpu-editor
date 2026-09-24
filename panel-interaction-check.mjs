// Browser regression for brace defaults, details scrolling, and score controls.
// Usage: npm run build && node panel-interaction-check.mjs
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const dist = join(process.cwd(), "dist");
const mime = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm",
};
const server = createServer(async (request, response) => {
  try {
    let path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    if (path === "/") path = "/index.html";
    const data = await readFile(join(dist, normalize(path)));
    response.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream" });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const pane = page.locator("#inspector-pane");
const content = pane.locator(".inspector-content");
const snapshot = () => content.evaluate((scroll) => ({
  top: scroll.scrollTop,
  height: scroll.scrollHeight,
  viewport: scroll.clientHeight,
  reserve: Number.parseFloat(scroll.querySelector("[data-details-scroll-spacer]")?.style.height ?? "0"),
}));

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app?.painter?.layout?.options);
  const defaults = await page.evaluate(() => ({
    width: window.__app.engravingStyle.braceWidthScale,
    stroke: window.__app.engravingStyle.braceStrokeWidth,
    slurTie: window.__app.painter.layout.options.slurTieThickness,
  }));
  assert.deepEqual(defaults, { width: 0.35, stroke: 3.2, slurTie: 3.2 });

  await page.locator("#btn-layout-style").click();
  for (const [name, min, max] of [["braceWidthScale", "0.1", "2"], ["braceStrokeWidth", "0.1", "5"]]) {
    const slider = pane.locator(`input[name="${name}"]`);
    assert.equal(await slider.getAttribute("min"), min);
    assert.equal(await slider.getAttribute("max"), max);
  }
  await content.evaluate((scroll) => { scroll.scrollTop = scroll.scrollHeight; });
  const before = await snapshot();
  assert(before.top > 100, "layout panel needs scrollable content");
  await pane.locator(".engraving-section > summary").first().evaluate((summary) => summary.click());
  await page.waitForTimeout(30);
  const collapsed = await snapshot();
  assert(Math.abs(collapsed.top - before.top) <= 2,
    `collapsing near the bottom jumped the page: ${JSON.stringify({ before, collapsed })}`);
  assert(collapsed.reserve > 0, "collapse did not keep a temporary tail");
  await content.evaluate((scroll) => { scroll.scrollTop += 70; });
  await page.waitForTimeout(30);
  assert(Math.abs((await snapshot()).top - collapsed.top) <= 2, "downward scroll entered temporary blank space");
  await content.evaluate((scroll) => { scroll.scrollTop -= 70; });
  await page.waitForTimeout(30);
  const upward = await snapshot();
  assert(upward.top < collapsed.top && upward.reserve < collapsed.reserve,
    "upward scroll did not release temporary space");
  await content.evaluate((scroll) => { scroll.scrollTop = 0; });
  await page.waitForTimeout(30);
  assert.equal((await snapshot()).reserve, 0, "temporary space remained at the top");

  // Native keyboard activation must take the same path as pointer activation.
  const firstSummary = pane.locator(".engraving-section > summary").first();
  await firstSummary.evaluate((summary) => { summary.focus(); summary.click(); });
  await content.evaluate((scroll) => { scroll.scrollTop = scroll.scrollHeight; });
  const keyboardBefore = await snapshot();
  await page.keyboard.press("Space");
  await page.waitForTimeout(30);
  const keyboardAfter = await snapshot();
  assert(Math.abs(keyboardAfter.top - keyboardBefore.top) <= 2 && keyboardAfter.reserve > 0,
    `keyboard collapse did not retain the scroll position: ${JSON.stringify({ keyboardBefore, keyboardAfter })}`);
  await pane.locator(".inspector-close").click();

  await page.evaluate(() => window.__app.setEngravingStyle({
    ...window.__app.engravingStyle, braceWidthScale: 2.7, braceStrokeWidth: 7,
  }, false));
  await page.locator("#btn-layout-style").click();
  assert.deepEqual(await pane.evaluate((element) => ({
    width: element.querySelector('input[name="braceWidthScale"]').value,
    stroke: element.querySelector('input[name="braceStrokeWidth"]').value,
    maxWidth: element.querySelector('input[name="braceWidthScale"]').max,
    maxStroke: element.querySelector('input[name="braceStrokeWidth"]').max,
  })), { width: "2.7", stroke: "7", maxWidth: "2.7", maxStroke: "7" },
  "older brace settings were truncated by the new slider range");
  await pane.locator(".inspector-close").click();
  await page.evaluate(() => window.__app.setEngravingStyle({
    ...window.__app.engravingStyle, braceWidthScale: 0.35, braceStrokeWidth: 3.2,
  }, false));

  await page.evaluate(() => window.__app.changeDocumentFormat("keyboard"));
  await page.waitForFunction(() => window.__app.documentFormat === "keyboard");
  const checkKeyboardLabel = async () => {
    const layout = await pane.locator(".slash-settings-body .modal-row:has(> input[type=checkbox])")
      .filter({ hasText: "谱面显示键盘按键" }).first().evaluate((row) => {
        const caption = row.querySelector("span").getBoundingClientRect();
        const checkbox = row.querySelector("input[type=checkbox]").getBoundingClientRect();
        const hint = row.querySelector("small").getBoundingClientRect();
        return { caption: caption.toJSON(), checkbox: checkbox.toJSON(), hint: hint.toJSON() };
      });
    assert(Math.abs((layout.caption.top + layout.caption.bottom) / 2
      - (layout.checkbox.top + layout.checkbox.bottom) / 2) <= 4,
    `checkbox is not level with its caption: ${JSON.stringify(layout)}`);
    assert(layout.hint.top >= Math.max(layout.caption.bottom, layout.checkbox.bottom) - 1,
      `hint did not occupy its own line: ${JSON.stringify(layout)}`);
  };
  await page.locator("#btn-score-settings").click();
  await checkKeyboardLabel();
  const keyLabel = pane.locator(".slash-settings-body .modal-row:has(> input[type=checkbox])")
    .filter({ hasText: "谱面显示键盘按键" }).locator("input[type=checkbox]");
  await keyLabel.check();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("editor:header-changed", {
    detail: { title: "面板同步", composer: "作曲者", fifths: 2, beats: 6, beatType: 8,
      tempoBpm: 90, tempoBeatUnit: "dotted-quarter", tempoMarks: [], keyChanges: [] },
  })));
  assert.equal(await pane.getByLabel("标题", { exact: true }).inputValue(), "面板同步");
  assert.equal(await pane.getByLabel("作曲", { exact: true }).inputValue(), "作曲者");
  assert(await keyLabel.isChecked(), "header update cleared unrelated unsaved input");
  await page.setViewportSize({ width: 390, height: 700 });
  await checkKeyboardLabel();
  await pane.getByRole("button", { name: "取消", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("inspector-pane").hidden);
  assert.equal(errors.length, 0, `browser errors: ${errors.join("\n")}`);
  console.log("panel interaction regression passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
