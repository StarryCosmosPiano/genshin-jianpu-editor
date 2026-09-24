// Visual and functional smoke check for the application appearance.
// Run after `npm run build`: node theme-check.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const output = join(process.cwd(), "artifacts", "ui");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    let path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    if (path === "/") path = "/index.html";
    const content = await readFile(join(root, normalize(path)));
    response.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream" });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const browser = await chromium.launch({ channel: "msedge", headless: true });

async function metrics(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const paper = document.querySelector(".score-page-wrap");
    const header = document.getElementById("app-header");
    const toolbar = document.getElementById("toolbar");
    const score = document.getElementById("score-pane");
    const editor = document.querySelector(".cm-editor");
    const body = document.getElementById("body");
    return {
      theme: root.dataset.theme,
      bg: getComputedStyle(root).getPropertyValue("--bg").trim(),
      paper: paper && getComputedStyle(paper).backgroundColor,
      editor: editor && getComputedStyle(editor).backgroundColor,
      viewportOverflow: root.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
      header: header?.getBoundingClientRect().toJSON(),
      toolbar: toolbar?.getBoundingClientRect().toJSON(),
      score: score?.getBoundingClientRect().toJSON(),
      drawerVisible: body && !body.classList.contains("code-pane-collapsed"),
      pageCount: document.querySelectorAll(".score-page-wrap").length,
      errors: document.querySelector("body > pre")?.textContent ?? "",
    };
  });
}

async function selectTheme(page, preference) {
  await page.locator("#btn-options").click();
  await page.locator(".modal-box").getByRole("combobox", { name: "外观" }).selectOption(preference);
  await page.locator(".modal-box").getByRole("button", { name: "确定" }).click();
}

try {
  for (const [name, width, height] of [["desktop", 1440, 960], ["standard", 1280, 900], ["compact", 900, 800], ["phone", 390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: "light" });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".score-page-wrap");
    const light = await metrics(page);
    assert.equal(light.theme, "light", `${name}: initial theme`);
    assert.equal(light.bg.toLowerCase(), "#fffbff", `${name}: light background`);
    assert.equal(light.paper, "rgb(255, 255, 255)", `${name}: score paper`);
    assert.equal(light.viewportOverflow, false, `${name}: horizontal viewport overflow`);
    assert.ok(light.pageCount > 0, `${name}: score rendered`);
    assert.equal(light.drawerVisible, true, `${name}: source should start expanded`);
    assert.ok(light.header?.height < 90, `${name}: oversized header`);
    const controlsFit = await page.evaluate(() => ["btn-select-mode", "btn-input-mode", "btn-undo", "btn-redo", "btn-play", "btn-score-settings", "btn-layout-style"]
      .every((id) => {
        const rect = document.getElementById(id)?.getBoundingClientRect();
        return rect && rect.left >= 0 && rect.right <= innerWidth;
      }));
    assert.equal(controlsFit, true, `${name}: primary toolbar action outside viewport`);
    if (name === "phone") assert.ok(light.score?.height > 250, "phone: score workspace too short");
    await page.screenshot({ path: join(output, `${name}-light.png`) });
    await page.locator("#btn-options").click();
    assert.equal(await page.locator(".modal-box").isVisible(), true, `${name}: options dialog did not open`);
    await page.screenshot({ path: join(output, `${name}-options.png`) });
    await page.locator(".modal-footer button").first().click();

    assert.equal(await page.locator("#code-workspace").isVisible(), true, `${name}: source pane did not open`);
    const sourceWidth = await page.locator("#code-workspace").evaluate((element) => element.getBoundingClientRect().width);
    assert.ok(sourceWidth >= 250 && sourceWidth <= 350, `${name}: source pane width ${sourceWidth}`);
    await page.screenshot({ path: join(output, `${name}-source.png`) });
    if (name === "desktop") {
      const divider = await page.locator("#code-pane-toggle").boundingBox();
      await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
      await page.mouse.down();
      await page.mouse.move(divider.x + divider.width / 2 + 80, divider.y + divider.height / 2, { steps: 4 });
      await page.mouse.up();
      const resized = await page.locator("#code-workspace").evaluate(element => element.getBoundingClientRect().width);
      assert.ok(Math.abs(resized - sourceWidth - 80) < 3, "desktop: drag must resize the text pane");
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("jpeditor-render-settings")).codePaneWidth), 400);
    }
    await page.locator("#btn-layout-style").click();
    assert.equal(await page.locator("#inspector-pane").isVisible(), true, `${name}: inspector did not open`);
    await page.screenshot({ path: join(output, `${name}-inspector.png`) });
    await page.locator(".inspector-close").click();
    assert.equal(await page.locator(".inspector-dirty-prompt").count(), 0, `${name}: pristine inspector prompted on close`);

    await page.evaluate(() => {
      window.__themeCheckEditor = document.querySelector(".cm-editor");
      window.__themeCheckPage = document.querySelector(".score-page-wrap");
      window.__themeCheckModel = window.__app.painter.score;
      window.__themeCheckText = window.__app.getText();
    });
    await selectTheme(page, "dark");
    const dark = await metrics(page);
    assert.equal(dark.theme, "dark", `${name}: dark theme`);
    assert.equal(dark.bg.toLowerCase(), "#101014", `${name}: dark background`);
    assert.equal(dark.paper, "rgb(255, 255, 255)", `${name}: dark score paper`);
    assert.equal(dark.viewportOverflow, false, `${name}: dark horizontal viewport overflow`);
    assert.equal(await page.evaluate(() => document.querySelector(".cm-editor") === window.__themeCheckEditor && document.querySelector(".score-page-wrap") === window.__themeCheckPage), true, `${name}: theme switch recreated editor or score`);
    assert.equal(await page.evaluate(() => window.__app.painter.score === window.__themeCheckModel && window.__app.getText() === window.__themeCheckText), true, `${name}: theme switch reparsed or edited the score`);
    assert.equal(await page.evaluate(() => localStorage.getItem("jpeditor.ui.theme")), "dark", `${name}: preference not stored`);
    await page.screenshot({ path: join(output, `${name}-dark.png`) });
    await page.locator("#btn-options").click();
    assert.equal(await page.locator(".modal-box").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(24, 23, 29)", `${name}: dark dialog surface`);
    await page.screenshot({ path: join(output, `${name}-options-dark.png`) });
    await page.locator(".modal-footer button").first().click();

    await page.locator("#btn-layout-style").click();
    assert.equal(await page.locator("#inspector-pane").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(24, 23, 29)", `${name}: dark inspector surface`);
    await page.screenshot({ path: join(output, `${name}-inspector-dark.png`) });
    await page.locator(".inspector-close").click();
    assert.equal(await page.locator(".inspector-dirty-prompt").count(), 0, `${name}: pristine dark inspector prompted on close`);

    await selectTheme(page, "system");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    assert.equal((await metrics(page)).theme, "dark", `${name}: system dark`);
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    assert.equal((await metrics(page)).theme, "light", `${name}: system light`);
    if (name === "phone") {
      await page.locator("#btn-input-mode").click();
      await page.mouse.move(1, 500);
      assert.equal(await page.locator("#score-input-keypad").isVisible(), true, "phone: input keypad hidden");
      assert.equal(await page.locator("#btn-input-mode").evaluate((button) => getComputedStyle(button).backgroundColor),
        "rgb(239, 187, 82)", "phone: active input mode must use gold");
      assert.ok((await metrics(page)).score.height > 250, "phone: keypad leaves too little score space");
      await page.screenshot({ path: join(output, "phone-keypad.png") });
    }
    if (name === "desktop") {
      await page.reload({ waitUntil: "networkidle" });
      assert.equal(await page.evaluate(() => window.__app.codePaneWidth), 400, "desktop: reload must restore text width");
      assert.equal(await page.evaluate(() => window.__app.codePaneCollapsed), false, "desktop: reload must restore expanded state");
    }
    assert.deepEqual(pageErrors, [], `${name}: page error`);
    console.log(`${name}: light/dark/system OK; screenshots in ${output}`);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
