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
  const testUrl = process.env.APP_TEST_URL || `http://127.0.0.1:${server.address().port}/`;
  await page.goto(testUrl, { waitUntil: "networkidle" });
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

  // At minimum window height the real collapsed content is almost as tall as
  // the retained viewport. Grow back past that content length: scrollHeight
  // is then clamped by clientHeight, so measuring it would lose the anchor.
  const resizeGrip = pane.locator(".inspector-resize-grip");
  await resizeGrip.focus();
  for (let step = 0; step < 48; step++) await resizeGrip.press("ArrowUp");
  await content.evaluate((scroll) => { scroll.scrollTop = 300; });
  await page.waitForTimeout(30);
  const smallWindow = await snapshot();
  assert(Math.abs(smallWindow.top - 300) <= 2,
    `small window could not retain the manual scroll: ${JSON.stringify(smallWindow)}`);
  for (let step = 0; step < 48; step++) await resizeGrip.press("ArrowDown");
  const grownWindow = await snapshot();
  assert(Math.abs(grownWindow.top - smallWindow.top) <= 2 && grownWindow.reserve > smallWindow.reserve,
    `growing the window jumped above the retained view: ${JSON.stringify({ smallWindow, grownWindow })}`);

  // A short section can leave real content below the retained position after
  // the floating window is made shorter. Wheel motion must reach that content
  // instead of being blocked by the old spacer guard.
  await content.evaluate((scroll) => { scroll.scrollTop = 0; });
  await firstSummary.evaluate((summary) => summary.click());
  await page.waitForTimeout(30);
  const lastSummary = pane.locator(".engraving-section > summary").last();
  await lastSummary.click();
  await content.evaluate((scroll) => { scroll.scrollTop = scroll.scrollHeight; });
  const shortBefore = await snapshot();
  const anchorBefore = await lastSummary.evaluate((summary) => summary.getBoundingClientRect().top);
  await lastSummary.click();
  await page.waitForTimeout(30);
  const shortAfter = await snapshot();
  assert(Math.abs(shortAfter.top - shortBefore.top) <= 2 && shortAfter.reserve > 0,
    `collapsing a visible lower section jumped to the top: ${JSON.stringify({ shortBefore, shortAfter })}`);
  const anchorAfter = await lastSummary.evaluate((summary) => ({
    top: summary.getBoundingClientRect().top,
    focused: document.activeElement === summary,
  }));
  assert(Math.abs(anchorAfter.top - anchorBefore) <= 2 && anchorAfter.focused,
    `collapse moved the visible summary or focus: ${JSON.stringify({ anchorBefore, anchorAfter })}`);
  await resizeGrip.focus();
  for (let step = 0; step < 20; step++) await resizeGrip.press("ArrowUp");
  const resized = await snapshot();
  assert(Math.abs(resized.top - shortAfter.top) <= 2,
    `resizing lost the retained scroll position: ${JSON.stringify({ shortAfter, resized })}`);
  const realBottom = resized.height - resized.viewport - resized.reserve;
  assert(realBottom > resized.top + 40,
    `fixture needs real content below the retained position: ${JSON.stringify({ resized, realBottom })}`);
  const box = await content.boundingBox();
  assert(box);
  await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2);
  await page.mouse.wheel(0, 75);
  await page.waitForTimeout(50);
  const wheeled = await snapshot();
  assert(wheeled.top > resized.top + 20 && wheeled.top <= realBottom + 2,
    `wheel cannot reach real content after resize: ${JSON.stringify({ resized, wheeled, realBottom })}`);
  await lastSummary.evaluate((summary) => summary.click());
  await page.waitForTimeout(30);
  const expanded = await snapshot();
  assert(Math.abs(expanded.top - wheeled.top) <= 2,
    `reopening the section lost the visible anchor: ${JSON.stringify({ wheeled, expanded })}`);
  await page.mouse.wheel(0, 75);
  await page.waitForTimeout(50);
  assert((await snapshot()).top > expanded.top + 20,
    "wheel cannot move down after reopening the section");
  await pane.locator(".inspector-reset").click();
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
