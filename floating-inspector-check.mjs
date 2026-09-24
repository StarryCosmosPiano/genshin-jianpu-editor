// Floating inspector geometry, draft safety, and linked score-selection clarity.
// Usage: npm run build && node floating-inspector-check.mjs
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
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
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

const pane = page.locator("#inspector-pane");
const layoutButton = page.locator("#btn-layout-style");
const scoreButton = page.locator("#btn-score-settings");
const layoutStorageKey = "jpeditor:inspector-window:layout:v1";
const scoreStorageKey = "jpeditor:inspector-window:score:v1";
const screenshotPath = (name) => join(process.cwd(), "artifacts", "ui", name);
const saveScreenshot = async (name) => {
  const path = screenshotPath(name);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: false });
};
const near = (actual, expected, tolerance = 2) => Math.abs(actual - expected) <= tolerance;
const geometry = () => pane.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
    width: rect.width, height: rect.height,
    viewportW: innerWidth, viewportH: innerHeight,
    position: getComputedStyle(element).position,
    header: element.querySelector(".inspector-header")?.getBoundingClientRect().toJSON(),
    footer: element.querySelector(".inspector-footer")?.getBoundingClientRect().toJSON(),
    scoreWidth: document.querySelector("#score-pane").getBoundingClientRect().width,
  };
});
const assertInsideViewport = (rect, label) => {
  assert(rect.left >= -1 && rect.top >= -1
    && rect.right <= rect.viewportW + 1 && rect.bottom <= rect.viewportH + 1,
  `${label} escaped viewport: ${JSON.stringify(rect)}`);
  assert(rect.header && rect.header.top >= -1 && rect.header.bottom <= rect.viewportH + 1,
    `${label} header is unreachable`);
  assert(rect.footer && rect.footer.top < rect.viewportH && rect.footer.bottom <= rect.viewportH + 1,
    `${label} footer is unreachable`);
};
const modelSnapshot = () => page.evaluate(() => ({
  source: window.__app.getText(),
  style: JSON.stringify(window.__app.engravingStyle),
  pageW: window.__app.pageW,
  pageH: window.__app.pageH,
  score: document.querySelector("#score-pane")?.innerHTML,
}));
const storedRect = (key) => page.evaluate((storageKey) => {
  const json = localStorage.getItem(storageKey);
  return json ? JSON.parse(json) : null;
}, key);
const mouseDrag = async (start, end) => {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
};
const rgb = (value) => {
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    const expanded = hex.length === 3
      ? [...hex].map((digit) => digit + digit)
      : [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)];
    assert(expanded.length === 3 && expanded.every((channel) => /^[0-9a-f]{2}$/i.test(channel)),
      `expected CSS hex color, got ${value}`);
    return expanded.map((channel) => Number.parseInt(channel, 16));
  }
  const channels = value.match(/[\d.]+/g)?.map(Number);
  assert(channels?.length >= 3, `expected CSS RGB color, got ${value}`);
  return channels.slice(0, 3);
};
const luminance = (value) => {
  const channels = rgb(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};
const contrast = (a, b) => {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
};

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app?.painter?.layout?.options);
  const initialScoreWidth = await page.locator("#score-pane").evaluate((element) => element.getBoundingClientRect().width);
  const initialModel = await modelSnapshot();

  await layoutButton.click();
  assert.equal(await pane.getAttribute("data-inspector-id"), "layout");
  assert.equal(await pane.getAttribute("role"), "dialog");
  assert.equal(await pane.getAttribute("aria-modal"), "false");
  assert(await pane.evaluate((element) => element.classList.contains("inspector-floating")));
  const opened = await geometry();
  assert.equal(opened.position, "fixed");
  assert(opened.width >= 540 && opened.width <= 680,
    `layout inspector should start around 600px wide: ${JSON.stringify(opened)}`);
  assert(near(opened.scoreWidth, initialScoreWidth, 1), "floating inspector resized the score pane");
  assertInsideViewport(opened, "initial layout inspector");

  const header = await pane.locator(".inspector-header").boundingBox();
  await mouseDrag(
    { x: header.x + 100, y: header.y + header.height / 2 },
    { x: header.x - 70, y: header.y + header.height / 2 + 55 },
  );
  const dragged = await geometry();
  assert(dragged.left < opened.left - 100 && dragged.top > opened.top + 30,
    `header drag did not move floating inspector: ${JSON.stringify({ opened, dragged })}`);
  assertInsideViewport(dragged, "dragged layout inspector");
  assert.deepEqual(await modelSnapshot(), initialModel, "dragging inspector changed source, model, or score");

  const closeBox = await pane.locator(".inspector-close").boundingBox();
  await mouseDrag(
    { x: closeBox.x + closeBox.width / 2, y: closeBox.y + closeBox.height / 2 },
    { x: closeBox.x - 35, y: closeBox.y + closeBox.height / 2 + 30 },
  );
  const afterControlDrag = await geometry();
  assert(near(afterControlDrag.left, dragged.left, 1)
    && near(afterControlDrag.top, dragged.top, 1),
  "pressing a header control should not drag the inspector");

  const grip = await pane.locator(".inspector-resize-grip").boundingBox();
  assert(grip, "floating inspector needs a visible resize grip");
  await mouseDrag(
    { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 },
    { x: grip.x + grip.width / 2 + 90, y: grip.y + grip.height / 2 - 80 },
  );
  const resized = await geometry();
  assert(resized.width > dragged.width + 50 && resized.height < dragged.height - 50,
    `resize grip did not change both dimensions: ${JSON.stringify({ dragged, resized })}`);
  assertInsideViewport(resized, "resized layout inspector");
  assert.deepEqual(await modelSnapshot(), initialModel, "resizing inspector changed source, model, or score");
  const savedLayout = await storedRect(layoutStorageKey);
  assert(savedLayout && near(savedLayout.left, resized.left)
    && near(savedLayout.top, resized.top)
    && near(savedLayout.width, resized.width)
    && near(savedLayout.height, resized.height),
  `layout position/size did not persist: ${JSON.stringify(savedLayout)}`);

  await pane.locator(".inspector-close").click();
  await page.waitForFunction(() => document.querySelector("#inspector-pane").hidden);
  await layoutButton.click();
  const reopened = await geometry();
  assert(["left", "top", "width", "height"].every((key) => near(reopened[key], resized[key])),
    `layout position/size changed on reopen: ${JSON.stringify({ resized, reopened })}`);
  await page.locator("#score-pane").focus();
  const interruptedHeader = await pane.locator(".inspector-header").boundingBox();
  const interruptedStart = {
    x: interruptedHeader.x + 100,
    y: interruptedHeader.y + interruptedHeader.height / 2,
  };
  await page.mouse.move(interruptedStart.x, interruptedStart.y);
  await page.mouse.down();
  await page.mouse.move(interruptedStart.x - 30, interruptedStart.y + 20, { steps: 3 });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#inspector-pane").hidden);
  await page.mouse.up();
  await layoutButton.click();
  assert(!await pane.evaluate((element) => element.classList.contains("inspector-moving")),
    "Escape during a drag left the reopened inspector in moving state");
  const afterInterruptedDrag = await geometry();
  assert(["left", "top", "width", "height"].every((key) => near(afterInterruptedDrag[key], resized[key])),
    "interrupted drag persisted a partial window position");
  const freshHeader = await pane.locator(".inspector-header").boundingBox();
  await mouseDrag(
    { x: freshHeader.x + 100, y: freshHeader.y + freshHeader.height / 2 },
    { x: freshHeader.x + 45, y: freshHeader.y + freshHeader.height / 2 + 20 },
  );
  const afterFreshDrag = await geometry();
  assert(afterFreshDrag.left < afterInterruptedDrag.left - 30,
    "window cannot drag after an interrupted gesture");
  await saveScreenshot("floating-light.png");

  // A draft previews on the score, but window movement and closing must keep
  // the same apply/discard choice and never rewrite the source by themselves.
  const baselineScale = await page.evaluate(() => window.__app.engravingStyle.numberScale);
  const draftScale = baselineScale === 1.25 ? 1.3 : 1.25;
  await pane.locator('input[name="numberScale"]').evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, draftScale);
  await page.waitForFunction((value) => window.__app.painter.layout.options.engravingStyle.numberScale === value,
    draftScale);
  assert.equal(await page.evaluate(() => window.__app.engravingStyle.numberScale), baselineScale);
  assert.equal(await page.evaluate(() => window.__app.getText()), initialModel.source);
  await pane.locator(".inspector-close").click();
  assert(await pane.locator(".inspector-dirty-prompt").isVisible(), "dirty floating inspector lost its prompt");
  await pane.getByRole("button", { name: "继续编辑" }).click();
  assert(await pane.isVisible(), "continue editing closed the floating inspector");
  await pane.getByRole("button", { name: "取消", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#inspector-pane").hidden);
  assert.equal(await page.evaluate(() => window.__app.painter.layout.options.engravingStyle.numberScale), baselineScale);
  assert.equal(await page.evaluate(() => window.__app.getText()), initialModel.source);

  await layoutButton.click();
  await pane.locator('input[name="numberScale"]').evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, draftScale);
  await pane.getByRole("button", { name: "应用到全部简谱" }).click();
  await page.waitForFunction(() => document.querySelector("#inspector-pane").hidden);
  assert.equal(await page.evaluate(() => window.__app.engravingStyle.numberScale), draftScale,
    "apply did not commit the floating layout draft");

  // Both settings share the window component but keep separate saved geometry.
  await page.evaluate(() => window.__app.changeDocumentFormat("number"));
  await page.waitForFunction(() => window.__app.documentFormat === "number");
  await scoreButton.click();
  assert.equal(await pane.getAttribute("data-inspector-id"), "score");
  const scoreOpened = await geometry();
  assert(scoreOpened.width >= 540 && scoreOpened.width <= 680,
    `score inspector should start around 600px wide: ${JSON.stringify(scoreOpened)}`);
  assertInsideViewport(scoreOpened, "initial score inspector");
  const scoreHeader = await pane.locator(".inspector-header").boundingBox();
  await mouseDrag(
    { x: scoreHeader.x + 90, y: scoreHeader.y + scoreHeader.height / 2 },
    { x: scoreHeader.x + 135, y: scoreHeader.y + scoreHeader.height / 2 + 30 },
  );
  const movedScore = await geometry();
  assert(!near(movedScore.left, scoreOpened.left) || !near(movedScore.top, scoreOpened.top),
    "score inspector header did not drag");
  assert(await storedRect(scoreStorageKey), "score inspector did not save its own geometry");
  await pane.locator(".inspector-close").click();
  await page.waitForFunction(() => document.querySelector("#inspector-pane").hidden);

  // A saved desktop rect must be clamped when the window shrinks. Its header,
  // scrollable body, and footer must remain reachable on a phone-size viewport.
  await page.setViewportSize({ width: 390, height: 700 });
  await layoutButton.click();
  const narrow = await geometry();
  assertInsideViewport(narrow, "narrow layout inspector");
  assert(narrow.width <= 390 && narrow.height <= 700,
    `small viewport did not shrink the inspector: ${JSON.stringify(narrow)}`);
  await saveScreenshot("floating-mobile.png");
  const contentScroll = await pane.locator(".inspector-content").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return {
      scrollable: element.scrollHeight > element.clientHeight,
      reachedBottom: element.scrollTop + element.clientHeight >= element.scrollHeight - 2,
    };
  });
  assert(contentScroll.scrollable && contentScroll.reachedBottom,
    `small viewport cannot reach layout controls: ${JSON.stringify(contentScroll)}`);
  await pane.locator(".inspector-close").click();
  await page.waitForFunction(() => document.querySelector("#inspector-pane").hidden);
  await scoreButton.click();
  assertInsideViewport(await geometry(), "narrow score inspector");
  await pane.locator(".inspector-close").click();
  await page.waitForFunction(() => document.querySelector("#inspector-pane").hidden);

  // Score selection stays light purple on white paper; linked source stays gold.
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.evaluate(() => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(".Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 |]\n");
  });
  await page.waitForSelector("#score-pane g.entry text");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const firstNote = page.locator("#score-pane g.entry text").filter({ hasText: /^1$/ }).first();
    const unselectedColors = await firstNote.evaluate((element) => ({
      fill: getComputedStyle(element).fill,
      stroke: getComputedStyle(element).stroke,
      strokeWidth: getComputedStyle(element).strokeWidth,
    }));
    await firstNote.click();
    const colors = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const selected = document.querySelector("#score-pane g.selected text");
      const linked = document.querySelector(".cm-score-source-selection");
      return {
        ink: root.getPropertyValue("--selection-ink").trim(),
        scoreInk: root.getPropertyValue("--score-selection-ink").trim(),
        note: selected ? getComputedStyle(selected).fill : null,
        noteStroke: selected ? getComputedStyle(selected).stroke : null,
        noteStrokeWidth: selected ? getComputedStyle(selected).strokeWidth : null,
        linkedBackground: linked ? getComputedStyle(linked).backgroundColor : null,
        linkedForeground: linked ? getComputedStyle(linked).color : null,
        linkedChildForeground: linked?.firstElementChild
          ? getComputedStyle(linked.firstElementChild).color : null,
        selectedGroups: document.querySelectorAll("#score-pane g.selected").length,
      };
    });
    assert(colors.note && colors.noteStroke && colors.linkedBackground && colors.linkedForeground,
      `${theme} selected note/link highlight is missing: ${JSON.stringify(colors)}`);
    assert.deepEqual(rgb(colors.ink), rgb("#EFBB52"), `${theme} selection uses an unexpected gold`);
    assert.deepEqual(rgb(colors.note), rgb("#A98DD4"), `${theme} selected note must use light purple`);
    assert(contrast(colors.noteStroke, "rgb(255, 255, 255)") >= 4.5
      && Number.parseFloat(colors.noteStrokeWidth) > 0,
    `${theme} selected note lacks a visible dark outline: ${JSON.stringify(colors)}`);
    assert.deepEqual(rgb(colors.linkedBackground), rgb(colors.ink),
      `${theme} linked editor range does not use the chosen gold`);
    assert(contrast(colors.linkedForeground, colors.linkedBackground) >= 4.5,
      `${theme} linked editor text is unreadable`);
    if (colors.linkedChildForeground) {
      assert(contrast(colors.linkedChildForeground, colors.linkedBackground) >= 4.5,
        `${theme} syntax-highlighted child text is unreadable`);
    }
    if (theme === "light") await saveScreenshot("selection-purple-light.png");
    await page.evaluate(() => window.__app.setInputMode(true));
    const arrow = await page.locator("#score-pane .score-input-triangle").first().evaluate(
      (element) => getComputedStyle(element).fill,
    );
    assert.deepEqual(rgb(arrow), rgb("#A98DD4"), `${theme} input arrow must use light purple`);
    await page.evaluate(() => window.__app.setInputMode(false));
    await page.locator("#score-pane svg").first().click({ position: { x: 4, y: 4 } });
    const restoredColors = await firstNote.evaluate((element) => ({
      fill: getComputedStyle(element).fill,
      stroke: getComputedStyle(element).stroke,
      strokeWidth: getComputedStyle(element).strokeWidth,
    }));
    assert.deepEqual(restoredColors, unselectedColors,
      `${theme} deselection did not restore the note's original voice color`);
  }

  await layoutButton.click();
  await saveScreenshot("floating-dark.png");
  await pane.locator(".inspector-close").click();
  await page.waitForFunction(() => document.querySelector("#inspector-pane").hidden);

  assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`);
  console.log("floating inspector drag/resize/persist/clamp/drafts and selection contrast: OK");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
