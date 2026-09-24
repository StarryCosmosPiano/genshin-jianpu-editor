// Browser regression for startup, Settings, the left engraving sample, and navigation.
// Usage: npm run build && node workspace-preferences-check.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const dist = join(process.cwd(), "dist");
const mime = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml",
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
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, colorScheme: "light" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app?.painter?.pageCount > 0);
  const startup = await page.evaluate(() => ({
    format: window.__app.documentFormat,
    side: window.__app.codePaneSide,
    collapsed: window.__app.codePaneCollapsed,
    restore: window.__app.restoreLastFileOnStartup,
    connected: window.__app.engravingStyle.connectBarlines,
  }));
  assert.equal(startup.format, "keyboard", "new installs should open the keyboard score sample");
  assert.equal(startup.side, "left", "source should start on the left");
  assert.equal(startup.collapsed, false, "source should start expanded");
  assert.equal(startup.restore, false, "last-file restoration should be opt-in");
  assert.equal(startup.connected, false, "barlines should start unconnected");
  assert.equal(await page.locator("#code-workspace").isVisible(), true, "source workspace is hidden");

  await page.evaluate(() => {
    window.__originalCodeMirror = document.querySelector("#code-pane .cm-editor");
    window.__originalSource = window.__app.getText();
  });
  await page.locator("#btn-layout-style").click();
  await page.locator("#layout-preview-pane svg").waitFor({ state: "visible" });
  assert.equal(await page.locator("#inspector-pane").getAttribute("data-inspector-id"), "layout");
  assert.equal(await page.locator("#body").getAttribute("data-code-pane-side"), "left");
  assert.equal(await page.getByRole("tab", { name: "排版样张" }).getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#code-pane").isHidden(), true, "sample tab did not hide source");
  assert.equal(await page.evaluate(() => document.querySelector("#code-pane .cm-editor") === window.__originalCodeMirror), true,
    "switching to sample recreated CodeMirror");
  assert.equal(await page.locator('#layout-preview-pane svg[data-preview-source="actual-layout"]').count(), 1,
    "sample is not using the score layout renderer");
  await page.getByRole("tab", { name: "文本谱" }).click();
  assert.equal(await page.locator("#code-pane").isVisible(), true, "text tab did not restore source");
  assert.equal(await page.evaluate(() => window.__app.getText() === window.__originalSource
    && document.querySelector("#code-pane .cm-editor") === window.__originalCodeMirror), true,
  "text tab changed source or editor instance");
  await page.getByRole("tab", { name: "排版样张" }).click();
  await page.locator("#inspector-pane .inspector-close").click();
  await page.waitForFunction(() => document.getElementById("inspector-pane").hidden);
  assert.equal(await page.locator("#layout-preview-pane").count(), 0, "sample pane leaked after close");
  assert.equal(await page.locator("#code-pane").isVisible(), true, "closing layout did not return to source");
  assert.equal(await page.evaluate(() => document.querySelector("#code-pane .cm-editor") === window.__originalCodeMirror), true,
    "closing layout recreated CodeMirror");

  // Select the note at offset 3/4 from the rendered score.
  const subdivisionScore = `.Title\nTitle = {拍数显示回归}\nKeyAndMeters = {1=C,4/4}\n.Voice\n1_ 2__ 3__ 4_ 5_ 6_ 7_ 1'_ 2'_ |]$(true,0,0,true)\n`;
  await page.evaluate((text) => window.__app.loadText(text, null), subdivisionScore);
  await page.waitForFunction(() => window.__app._sourceNotes.some((source) =>
    !source.grace && source.chord.position.toString() === "3/4"));
  await page.locator("#score-pane g.entry text").filter({ hasText: /^3$/ }).first().click();
  await page.waitForFunction(() => window.__app.workspaceSummary().position.includes("7/4 拍"));
  await page.evaluate(() => {
    const app = window.__app;
    window.__beatSource = app.getText();
    window.__beatScore = app.painter.score;
    window.__beatEditor = app.view;
  });
  assert.match((await page.locator("#workspace-position").textContent()) ?? "", /7\/4 拍/,
    "selected subdivision is not shown as a fraction");

  await page.locator("#btn-options").click();
  const settings = page.locator(".modal-box");
  assert.equal((await settings.locator(".modal-title").textContent()).trim(), "设置");
  assert.equal(await settings.getByRole("combobox", { name: "外观" }).inputValue(), "system");
  assert.equal(await settings.getByRole("combobox", { name: "拍数位置显示" }).inputValue(), "fraction");
  await settings.getByRole("combobox", { name: "外观" }).selectOption("dark");
  await settings.getByRole("combobox", { name: "拍数位置显示" }).selectOption("decimal");
  await settings.getByRole("button", { name: "确定" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  const preferences = await page.evaluate(() => ({
    beat: window.__app.beatPositionFormat,
    beatText: window.__app.workspaceSummary().position,
    sourceSame: window.__app.getText() === window.__beatSource,
    scoreSame: window.__app.painter.score === window.__beatScore,
    editorSame: window.__app.view === window.__beatEditor,
    connected: window.__app.engravingStyle.connectBarlines,
  }));
  assert.equal(preferences.beat, "decimal");
  assert.match(preferences.beatText, /1\.75 拍/, "selected subdivision is not shown as a decimal");
  assert.equal(preferences.sourceSame && preferences.scoreSame && preferences.editorSame, true,
    "appearance/beat display changed the source or reparsed the score");
  assert.equal(preferences.connected, false, "barlines changed without using their setting");
  assert.match((await page.locator("#workspace-position").textContent()) ?? "", /1\.75 拍/,
    "workspace status did not refresh its beat display");
  await page.locator("#btn-options").click();
  await page.locator(".modal-box").getByRole("checkbox", { name: "连接跨行小节线" }).check();
  await page.locator(".modal-box").getByRole("button", { name: "确定" }).click();
  assert.equal(await page.evaluate(() => window.__app.engravingStyle.connectBarlines), true,
    "connected barlines setting did not apply");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app?.painter?.pageCount > 0);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark", "appearance did not persist");
  assert.equal(await page.evaluate(() => window.__app.beatPositionFormat), "decimal", "beat display did not persist");
  assert.equal(await page.evaluate(() => window.__app.engravingStyle.connectBarlines), true,
    "barline connection did not persist");

  const playbackWidths = await page.evaluate(() => {
    const button = document.getElementById("btn-play");
    const width = () => button.getBoundingClientRect().width;
    const values = [width()];
    for (const state of ["loading", "playing", "stopped"]) {
      window.__app.onPlayState(state);
      values.push(width());
    }
    return values;
  });
  assert.ok(Math.max(...playbackWidths) - Math.min(...playbackWidths) < 1,
    `play button changed width across states: ${playbackWidths.join(", ")}`);
  await page.evaluate(() => {
    const app = window.__app;
    window.__playCalls = { play: 0, stop: 0 };
    app._player = {
      state: "stopped",
      async play() {
        window.__playCalls.play++;
        this.state = "playing";
        app.onPlayState("playing");
      },
      stop() {
        window.__playCalls.stop++;
        this.state = "stopped";
        app.onPlayState("stopped");
      },
      stopAudition() {},
      async audition() {},
    };
  });
  await page.locator("#btn-play").click();
  await page.waitForFunction(() => window.__playCalls.play === 1);
  await page.locator("#btn-play").click();
  assert.deepEqual(await page.evaluate(() => window.__playCalls), { play: 1, stop: 1 },
    "the single playback button did not toggle play and stop");

  const systems = Array.from({ length: 8 }, (_, index) =>
    `${"1 2 3 4 | ".repeat(4)}${index === 7 ? "]$(true,0,0,true)" : "$(true)"}`);
  const multiPageScore = `.Title\nTitle = {翻页回归}\nKeyAndMeters = {1=C,4/4}\n.Layout\nLinesPerPage = 1\n.Voice\n${systems.join("\n")}\n`;
  await page.evaluate((text) => window.__app.loadText(text, null), multiPageScore);
  await page.waitForFunction(() => window.__app.pageEls.length >= 6);
  await page.evaluate(() => window.__app.goToPage(4));
  await page.waitForFunction(() => window.__app.pageIndex === 4);
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(() => window.__app.pageIndex), 4, "jump to page five did not settle");
  await page.evaluate(() => {
    const counter = document.getElementById("workspace-page-count");
    window.__pageTrace = [];
    let running = true;
    const capture = () => {
      const sample = `${window.__app.pageIndex + 1}|${counter.textContent.trim()}`;
      if (window.__pageTrace.at(-1) !== sample) window.__pageTrace.push(sample);
    };
    const observer = new MutationObserver(capture);
    observer.observe(counter, { childList: true, characterData: true, subtree: true });
    const frame = () => {
      if (!running) return;
      capture();
      requestAnimationFrame(frame);
    };
    capture();
    requestAnimationFrame(frame);
    window.__stopPageTrace = () => {
      running = false;
      observer.disconnect();
      capture();
    };
  });
  await page.locator("#btn-next").click();
  await page.waitForFunction(() => window.__app.pageIndex === 5);
  await page.waitForTimeout(1000);
  const pageTrace = await page.evaluate(() => {
    window.__stopPageTrace();
    return window.__pageTrace;
  });
  const reachedSix = pageTrace.findIndex((sample) => sample.startsWith("6|6 /"));
  assert.ok(reachedSix >= 0, `page six was never observed: ${pageTrace.join(" → ")}`);
  assert.ok(pageTrace.slice(reachedSix).every((sample) => sample.startsWith("6|6 /")),
    `next-page target regressed during smooth scrolling: ${pageTrace.join(" → ")}`);
  assert.equal(await page.evaluate(() => window.__app.pageIndex), 5, "next-page target jumped back");
  await page.locator("#score-pane").hover({ position: { x: 180, y: 180 } });
  await page.mouse.wheel(0, -1200);
  await page.waitForFunction(() => window.__app.pageIndex < 5);
  assert.ok(await page.evaluate(() => window.__app.pageIndex < 5),
    "manual wheel did not restore scroll-following page selection");

  assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`);
  console.log("workspace preferences, left sample, playback width, and page navigation: OK");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
