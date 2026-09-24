// Browser regression for the header menu and UI polish.
// Usage: npm run build && node ui-polish-check.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const dist = join(process.cwd(), "dist");
const screenshots = join(process.cwd(), "artifacts", "ui-polish");
await mkdir(screenshots, { recursive: true });
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
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
const origin = `http://127.0.0.1:${server.address().port}/`;

async function assertReadable(page, selector, state, label) {
  const target = page.locator(selector);
  if (state === "hover") await target.hover();
  else if (state === "focus") await target.focus();
  else {
    await page.mouse.move(1, 900);
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  }
  const sample = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    let background = style.backgroundColor;
    for (let parent = element.parentElement;
         background === "transparent" || /^rgba\([^)]*,\s*0\)$/.test(background);
         parent = parent?.parentElement) {
      if (!parent) {
        background = getComputedStyle(document.documentElement).backgroundColor;
        break;
      }
      background = getComputedStyle(parent).backgroundColor;
    }
    const rgb = (value) => {
      const parts = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return parts.slice(0, 3);
    };
    const brightness = (value) => {
      const linear = rgb(value).map((channel) => {
        const v = channel / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const foreground = brightness(style.color);
    const backgroundLuminance = brightness(background);
    return {
      color: style.color,
      background,
      contrast: (Math.max(foreground, backgroundLuminance) + 0.05) / (Math.min(foreground, backgroundLuminance) + 0.05),
    };
  });
  assert.ok(sample.contrast >= 4.5, `${label} ${state}: unreadable ${sample.color} on ${sample.background} (${sample.contrast.toFixed(2)}:1)`);
  return sample;
}

async function assertThemeColor(page, selector, kind, label) {
  const sample = await page.locator(selector).evaluate((element, kind) => {
    const style = getComputedStyle(element);
    const token = kind === "gold-hover" ? "--gold-hover" : kind === "gold" ? "--gold" : "--purple";
    return { actual: style.backgroundColor, expected: getComputedStyle(document.documentElement).getPropertyValue(token).trim() };
  }, kind);
  const expected = await page.evaluate((value) => {
    const probe = document.createElement("div");
    probe.style.color = value;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, sample.expected);
  assert.equal(sample.actual, expected, `${label}: ${kind} active background`);
}

async function selectTheme(page, preference) {
  await page.locator("#btn-options").click();
  await page.locator(".modal-box").getByRole("combobox", { name: "外观" }).selectOption(preference);
  await page.locator(".modal-box").getByRole("button", { name: "确定" }).click();
}

async function checkMenu(page) {
  const trigger = page.locator("#btn-file-menu");
  const menu = page.locator("#file-menu");
  const select = page.locator("#sel-recog-view");
  // The recognition select is only shown by Tauri. Expose that same DOM control
  // here so Edge can exercise its native select events and the shared menu code.
  await select.evaluate((element) => { element.hidden = false; });
  await trigger.click();
  assert.equal(await menu.isVisible(), true, "file menu did not open");
  await select.click();
  assert.equal(await menu.isVisible(), true, "clicking recognition select closed file menu");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(await menu.isVisible(), true, "changing recognition select closed file menu");
  assert.equal(await select.inputValue(), "inplace", "recognition select did not change");
  await page.keyboard.press("Escape");
  assert.equal(await menu.isHidden(), true, "Escape did not close file menu");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false", "Escape left file trigger expanded");
  assert.equal(await trigger.evaluate((element) => document.activeElement === element), true, "Escape did not restore trigger focus");

  await trigger.click();
  await page.locator("#score-pane").click({ position: { x: 15, y: 15 } });
  assert.equal(await menu.isHidden(), true, "outside click did not close file menu");
  await trigger.click();
  await page.locator("#btn-create").click();
  assert.equal(await menu.isHidden(), true, "file action did not close menu");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false", "file action left trigger expanded");
}

async function checkTheme(page, theme) {
  if (theme === "dark") {
    await selectTheme(page, "dark");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  }
  const logo = page.locator("#app-header .brand-mark");
  assert.equal(await logo.locator("img, svg").count(), 1, `${theme}: header is missing 原琴助手 logo artwork`);
  assert.equal((await logo.textContent()).trim(), "", `${theme}: header still has a musical glyph`);

  for (const [selector, label] of [["#btn-save", "save"], ["#btn-export", "export"]]) {
    await page.mouse.move(1, 900);
    for (const state of ["normal", "hover", "focus"]) await assertReadable(page, selector, state, `${theme} ${label}`);
  }
  await page.locator("#btn-select-mode").click();
  await page.locator("#score-pane g.entry text").first().click();
  const selectionColors = await page.evaluate(() => {
    const note = document.querySelector("#score-pane g.selected text");
    const source = document.querySelector(".cm-score-source-selection");
    const cursor = document.querySelector(".cm-cursor");
    const gold = getComputedStyle(document.documentElement).getPropertyValue("--selection-ink").trim();
    const probe = document.createElement("span");
    probe.style.color = gold;
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--selection-caret").trim();
    const expectedCaret = getComputedStyle(probe).color;
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--score-selection-ink").trim();
    const expectedScore = getComputedStyle(probe).color;
    probe.remove();
    return { expected, expectedCaret, expectedScore, note: note && getComputedStyle(note).fill,
      source: source && getComputedStyle(source).boxShadow,
      cursor: cursor && getComputedStyle(cursor).borderLeftColor };
  });
  assert.equal(selectionColors.note, selectionColors.expectedScore, `${theme}: selected note must be light purple`);
  assert.ok(selectionColors.source?.includes(selectionColors.expected), `${theme}: linked text selection must be gold`);
  if (selectionColors.cursor) assert.equal(selectionColors.cursor, selectionColors.expectedCaret, `${theme}: text caret must be gold`);
  for (const [selector, label, kind] of [["#btn-select-mode", "selection mode", "purple"], ["#btn-input-mode", "input mode", "gold"]]) {
    if (label === "input mode") await page.locator(selector).click();
    if (label === "input mode") {
      assert.equal(await page.locator(".score-input-triangle").first().evaluate((el) => getComputedStyle(el).fill),
        selectionColors.expectedScore, `${theme}: input arrow must be light purple`);
    }
    await page.mouse.move(1, 900);
    await assertThemeColor(page, selector, kind, `${theme} ${label}`);
    for (const state of ["normal", "hover", "focus"]) await assertReadable(page, selector, state, `${theme} ${label}`);
    if (kind === "gold") {
      await page.locator(selector).hover();
      await assertThemeColor(page, selector, "gold-hover", `${theme} ${label} hover`);
    }
  }
  const rest = page.locator('#score-input-keypad [data-input-degree="0"]');
  assert.equal((await rest.textContent()).trim(), "0", `${theme}: rest key must display only 0`);
  assert.match(await rest.getAttribute("title") ?? "", /^输入休止/, `${theme}: rest key title`);
  for (const [selector, auto, label] of [["#rhythm-grid-control button[data-rhythm-division='4']", "#rhythm-grid-auto", "grid choice"], ["#rhythm-grid-control button[data-input-duration-division='4']", "#input-duration-auto", "duration choice"]]) {
    await page.locator(auto).click();
    await page.locator(selector).click();
    assert.equal(await page.locator(selector).getAttribute("aria-pressed"), "true", `${theme} ${label}: choice did not activate`);
    await page.mouse.move(1, 900);
    await assertThemeColor(page, selector, "purple", `${theme} ${label}`);
    for (const state of ["normal", "hover", "focus"]) await assertReadable(page, selector, state, `${theme} ${label}`);
  }

  for (const [selector, label] of [["#rhythm-grid-dot-toggle", "grid dot"], ["#input-duration-dot-toggle", "duration dot"]]) {
    const button = page.locator(selector);
    assert.equal((await button.textContent()).trim(), "附点", `${theme} ${label}: label`);
    if (await button.getAttribute("aria-pressed") === "true") await button.click();
    await button.click();
    assert.equal(await button.getAttribute("aria-pressed"), "true", `${theme} ${label}: toggle did not activate`);
    await page.mouse.move(1, 900);
    await assertThemeColor(page, selector, "gold", `${theme} ${label}`);
    for (const state of ["normal", "hover", "focus"]) await assertReadable(page, selector, state, `${theme} ${label}`);
    await button.hover();
    await assertThemeColor(page, selector, "gold-hover", `${theme} ${label} hover`);
  }

  assert.equal(await page.locator("#code-workspace").isVisible(), true, `${theme}: source should start expanded`);
  const lock = page.locator("#btn-preview-lock");
  await lock.click();
  assert.equal(await lock.getAttribute("aria-pressed"), "true", `${theme}: preview lock did not activate`);
  await page.mouse.move(1, 900);
  await assertThemeColor(page, "#btn-preview-lock", "gold", `${theme} preview lock`);
  for (const state of ["normal", "hover", "focus"]) await assertReadable(page, "#btn-preview-lock", state, `${theme} preview lock`);
  await lock.hover();
  await assertThemeColor(page, "#btn-preview-lock", "gold-hover", `${theme} preview lock hover`);
  await page.locator("#btn-layout-style").click();
  const pane = page.locator("#inspector-pane");
  assert.equal(await pane.isVisible(), true, `${theme}: engraving inspector did not open`);
  const apply = "#inspector-pane .inspector-footer > button:last-child";
  await assertThemeColor(page, apply, "gold", `${theme} inspector apply`);
  for (const state of ["normal", "hover", "focus"]) await assertReadable(page, apply, state, `${theme} inspector apply`);
  await page.locator(apply).hover();
  await assertThemeColor(page, apply, "gold-hover", `${theme} inspector apply hover`);
  const inset = await pane.evaluate((element) => {
    const content = element.querySelector(".inspector-content");
    const root = content.getBoundingClientRect();
    const children = [...content.querySelectorAll(".engraving-section > .modal-row, .engraving-control")]
      .filter((node) => node.getClientRects().length);
    const rects = children.map((node) => node.getBoundingClientRect());
    return { padding: parseFloat(getComputedStyle(content).paddingLeft), left: Math.min(...rects.map((rect) => rect.left - root.left)), right: Math.min(...rects.map((rect) => root.right - rect.right)), count: rects.length };
  });
  assert.ok(inset.count > 0, `${theme}: no visible inspector controls`);
  assert.ok(inset.padding >= 10 && inset.left >= 8 && inset.right >= 8, `${theme}: inspector controls touch edges ${JSON.stringify(inset)}`);

  const preview = page.locator("#layout-preview-pane");
  await preview.locator("svg").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector(".engraving-preview svg")?.getAttribute("data-preview-source") === "actual-layout");
  const sizes = await preview.evaluate((element) => {
    const outer = element.getBoundingClientRect();
    const svg = element.querySelector("svg").getBoundingClientRect();
    const padding = getComputedStyle(element);
    return { available: outer.width - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight), svg: svg.width };
  });
  assert.ok(sizes.svg >= sizes.available * 0.92, `${theme}: engraving sample does not fill left pane ${JSON.stringify(sizes)}`);
  assert.equal(await preview.locator('svg[data-preview-source="actual-layout"]').count(), 1, `${theme}: sample is not actual score layout`);

  const expand = preview.locator(".engraving-preview-expand");
  await expand.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(screenshots, `sample-inline-${theme}.png`) });
  await expand.click();
  const overlay = page.locator('.engraving-preview-overlay[role="dialog"]');
  assert.equal(await overlay.isVisible(), true, `${theme}: large engraving viewer did not open`);
  const largeWidth = await overlay.locator(".engraving-preview-large-svg").evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(largeWidth > sizes.svg * 1.5, `${theme}: large viewer is not substantially larger (${largeWidth} vs ${sizes.svg})`);
  await page.screenshot({ path: join(screenshots, `sample-large-${theme}.png`) });
  await page.keyboard.press("Escape");
  assert.equal(await overlay.isHidden(), true, `${theme}: Escape did not close large viewer`);
  assert.equal(await expand.evaluate((element) => document.activeElement === element), true, `${theme}: viewer did not restore expand focus`);
  await pane.locator(".inspector-close").click();

  await page.locator("#btn-options").click();
  const modalApply = ".modal-box .modal-footer button:last-child";
  await assertThemeColor(page, modalApply, "gold", `${theme} dialog apply`);
  for (const state of ["normal", "hover", "focus"]) await assertReadable(page, modalApply, state, `${theme} dialog apply`);
  await page.locator(modalApply).hover();
  await assertThemeColor(page, modalApply, "gold-hover", `${theme} dialog apply hover`);
  await page.locator(".modal-box .modal-footer button:first-child").click();
}

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, colorScheme: "light" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.waitForSelector(".score-page-wrap");
  await checkMenu(page);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".score-page-wrap");
  await checkTheme(page, "light");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".score-page-wrap");
  await checkTheme(page, "dark");
  assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`);
  console.log("UI polish: file menu, colors, logo, inspector spacing and engraving viewer OK");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
