// Browser regression for floating score/engraving drafts.
// Usage: npm run build && node inspector-check.mjs
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
const port = server.address().port;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const pane = page.locator("#inspector-pane");
const layoutButton = page.locator("#btn-layout-style");
const scoreButton = page.locator("#btn-score-settings");
const read = () => page.evaluate(() => {
  const app = window.__app;
  return {
    committed: app.engravingStyle.numberScale,
    rendered: app.painter.layout.options.engravingStyle.numberScale,
    pageW: app.pageW,
    pageH: app.pageH,
    painterPageW: app.painter.pageWidth,
    painterPageH: app.painter.pageHeight,
    fontSize: app.fontSize,
    painterFontSize: app.painter.layout.fontSize,
    titleSize: app.titleSize,
    painterTitleSize: app.painter.layout.options.titleSize,
    creditSize: app.creditSize,
    painterCreditSize: app.painter.layout.options.creditSize,
    scoreHtml: document.getElementById("score-pane")?.innerHTML ?? "",
    firstNoteSize: document.querySelector("#score-pane g.entry text")?.getAttribute("font-size") ?? null,
    text: app.getText(),
    settings: localStorage.getItem(app.constructor.SETTINGS_KEY),
    panel: document.getElementById("inspector-pane")?.dataset.inspectorId ?? null,
  };
});
const changeScale = (value) => page.locator('#inspector-pane input[name="numberScale"]').evaluate((input, next) => {
  input.value = String(next);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}, value);

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app?.painter?.layout?.options);
  assert(await pane.isHidden(), "inspector should start closed");
  const original = await read();
  const scoreWidthBeforeInspector = await page.locator("#score-pane").evaluate((score) => score.getBoundingClientRect().width);

  await layoutButton.click();
  assert.equal(await pane.getAttribute("data-inspector-id"), "layout");
  const floatingLayout = await pane.evaluate((element) => ({
    position: getComputedStyle(element).position,
    floating: element.classList.contains("inspector-floating"),
    width: element.getBoundingClientRect().width,
    scoreWidth: document.querySelector("#score-pane").getBoundingClientRect().width,
  }));
  assert.equal(floatingLayout.position, "fixed", "layout inspector must float above the score");
  assert(floatingLayout.floating && floatingLayout.width >= 540,
    `layout inspector should open near 600px wide: ${JSON.stringify(floatingLayout)}`);
  assert(Math.abs(floatingLayout.scoreWidth - scoreWidthBeforeInspector) <= 1,
    "opening the floating inspector must not resize the score");
  await pane.locator(".inspector-close").click();
  await page.waitForFunction(() => document.getElementById("inspector-pane").hidden);
  assert.equal(await pane.locator(".inspector-dirty-prompt").count(), 0,
    "untouched engraving pane must close without a dirty prompt");
  await layoutButton.click();
  await page.evaluate(() => {
    const app = window.__app;
    const originalReload = app.reload.bind(app);
    window.__previewReloads = 0;
    app.reload = (...args) => {
      window.__previewReloads++;
      return originalReload(...args);
    };
  });
  await pane.locator('select[name="pagePreset"]').selectOption("16:9");
  await pane.locator('select[name="pageDirection"]').selectOption("landscape");
  await pane.locator('input[name="fontSize"]').fill("34");
  await pane.locator('input[name="titleSize"]').fill("52");
  await pane.locator('input[name="creditSize"]').fill("40");
  await page.waitForFunction(() => {
    const app = window.__app;
    return app.painter.pageWidth === 960 && app.painter.pageHeight === 540
      && app.painter.layout.fontSize === 34
      && app.painter.layout.options.titleSize === 52
      && app.painter.layout.options.creditSize === 40;
  });
  const pageDraft = await read();
  assert.equal(pageDraft.pageW, original.pageW, "paper draft must not change saved width");
  assert.equal(pageDraft.pageH, original.pageH, "paper draft must not change saved height");
  assert.equal(pageDraft.fontSize, original.fontSize, "font draft must not change saved size");
  assert.equal(pageDraft.titleSize, original.titleSize, "title draft must not change saved size");
  assert.equal(pageDraft.creditSize, original.creditSize, "credit draft must not change saved size");
  assert.equal(pageDraft.text, original.text, "paper preview must not rewrite source");
  assert.equal(pageDraft.settings, original.settings, "paper preview must not persist settings");
  assert.equal(await page.evaluate(() => window.__previewReloads), 0,
    "paper/font preview must not reparse source");
  await pane.getByRole("button", { name: "取消" }).click();
  await page.waitForFunction(() => document.getElementById("inspector-pane").hidden);
  const pageRestored = await read();
  assert.equal(pageRestored.painterPageW, original.painterPageW, "cancel must restore page width");
  assert.equal(pageRestored.painterPageH, original.painterPageH, "cancel must restore page height");
  assert.equal(pageRestored.painterFontSize, original.painterFontSize, "cancel must restore base font");
  assert.equal(pageRestored.painterTitleSize, original.painterTitleSize, "cancel must restore title font");
  assert.equal(pageRestored.painterCreditSize, original.painterCreditSize, "cancel must restore credit font");
  assert.equal(await page.evaluate(() => window.__previewReloads), 0,
    "paper/font cancel must not reparse source");

  await layoutButton.click();
  await page.evaluate(() => {
    const app = window.__app;
    const originalPreview = app.setEngravingPreview.bind(app);
    window.__previewApplications = 0;
    app.setEngravingPreview = (style, render) => {
      if (style) window.__previewApplications++;
      return originalPreview(style, render);
    };
  });
  await page.locator('#inspector-pane input[name="numberScale"]').evaluate((input) => {
    for (const value of [1.05, 1.1, 1.2]) {
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  const beforePreview = await read();
  assert.equal(beforePreview.committed, original.committed, "draft must not change saved style");
  assert.equal(beforePreview.rendered, original.rendered, "preview should trail input");
  assert.equal(beforePreview.settings, original.settings, "draft must not write settings");
  await page.waitForFunction(() => window.__app.painter.layout.options.engravingStyle.numberScale === 1.2);
  assert.equal(await page.evaluate(() => window.__previewApplications), 1,
    "rapid slider inputs must merge into one trailing preview");
  const previewed = await read();
  assert.equal(previewed.text, original.text, "engraving preview must not rewrite source");
  assert.equal(previewed.committed, original.committed, "preview must not commit style");
  assert.notEqual(previewed.scoreHtml, original.scoreHtml, "preview must redraw the actual score");
  await pane.getByRole("button", { name: "取消" }).click();
  await page.waitForFunction(() => document.getElementById("inspector-pane").hidden);
  assert.equal((await read()).rendered, original.rendered, "cancel must restore engraving");
  assert.equal((await read()).firstNoteSize, original.firstNoteSize, "cancel must restore note size");

  // A queued trailing update must never repaint after cancellation.
  await layoutButton.click();
  await changeScale(1.3);
  await pane.getByRole("button", { name: "取消" }).click();
  await page.waitForTimeout(260);
  assert.equal((await read()).rendered, original.rendered, "cancel must clear the preview timer");

  await layoutButton.click();
  await changeScale(1.35);
  await pane.locator('select[name="pageDirection"]').selectOption("landscape");
  await pane.locator('input[name="fontSize"]').fill("30");
  await pane.getByRole("button", { name: "应用到全部简谱" }).click();
  await page.waitForFunction(() => document.getElementById("inspector-pane").hidden);
  const committed = await read();
  assert.equal(committed.committed, 1.35, "apply must save style");
  assert.equal(committed.rendered, 1.35, "apply must flush the queued draft");
  assert.equal(committed.pageW, 842, "apply must save page orientation");
  assert.equal(committed.pageH, 595, "apply must save page orientation");
  assert.equal(committed.fontSize, 30, "apply must save base font size");
  assert.equal(committed.painterPageW, 842, "apply must flush queued page size");
  assert.equal(committed.painterFontSize, 30, "apply must flush queued font size");
  assert.notEqual(committed.settings, original.settings, "apply must persist settings");

  await page.evaluate(() => window.__app.changeDocumentFormat("number"));
  await page.waitForFunction(() => window.__app.documentFormat === "number");
  await layoutButton.click();
  await changeScale(1.5);
  await scoreButton.click();
  await pane.getByRole("button", { name: "继续编辑" }).click();
  assert.equal((await read()).panel, "layout", "continue must keep the old draft");
  await scoreButton.click();
  await pane.getByRole("button", { name: "放弃修改" }).click();
  await page.waitForFunction(() => document.getElementById("inspector-pane")?.dataset.inspectorId === "score");
  assert((await pane.evaluate((element) => element.getBoundingClientRect().width)) >= 540,
    "score inspector should open near 600px wide");
  assert.equal((await read()).rendered, 1.35, "switch discard must restore committed engraving");

  const oldTitle = await page.evaluate(() => window.__app.slashOptions.title);
  await pane.locator("details").filter({ hasText: "标题与署名" }).evaluate((details) => { details.open = true; });
  const titleInput = pane.getByRole("textbox", { name: "标题", exact: true });
  await titleInput.fill(`${oldTitle} 面板测试`);
  assert.equal(await page.evaluate(() => window.__app.slashOptions.title), oldTitle, "score draft must not change the document");
  await layoutButton.click();
  await pane.getByRole("button", { name: "应用", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("inspector-pane")?.dataset.inspectorId === "layout");
  await page.waitForFunction((title) => window.__app.slashOptions.title === title, `${oldTitle} 面板测试`);

  await changeScale(1.6);
  await page.waitForFunction(() => window.__app.painter.layout.options.engravingStyle.numberScale === 1.6);
  await page.evaluate(() => document.dispatchEvent(new Event("editor:document-replaced")));
  await page.waitForFunction(() => document.getElementById("inspector-pane").hidden);
  assert.equal((await read()).rendered, 1.35, "document replacement must dispose preview");
  assert.equal((await read()).committed, 1.35, "document replacement must retain committed style");

  assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`);
  console.log("inspector draft/preview/apply/cancel/switch/reset: OK");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
