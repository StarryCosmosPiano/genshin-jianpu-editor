import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const dist = join(process.cwd(), "dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2" };
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (path === "/") path = "/index.html";
    const data = await readFile(join(dist, normalize(path)));
    res.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream" }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const errors = [], nativeDialogs = [];
page.on("pageerror", e => errors.push(e.message));
page.on("dialog", async dialog => { nativeDialogs.push(dialog.message()); await dialog.dismiss(); });
const dialog = page.locator(".app-dialog");
const fixture = ".Title\nTitle = {悬浮输入测试}\nKeyAndMeters = {1=C,4/4}\nTempo = {90}\n.Voice\n1 2 3 4 | 5 6 7 1' |]\n";
async function setup() {
  await page.evaluate(text => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "jpw"; app.slashOptions = null;
    app.setText(text); app.resetDocumentUndo();
  }, fixture);
  await page.locator("#score-pane g.entry text").filter({ hasText: /^1$/ }).first().click();
  await page.locator("#btn-input-mode").click();
}
async function openMenu(label, waitForDialog = true) {
  const rect = await page.locator(".score-input-caret").first().boundingBox();
  assert(rect);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2, { button: "right" });
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  if (waitForDialog) await dialog.waitFor({ state: "visible" });
}
async function accept() {
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}
const source = () => page.evaluate(() => window.__app.getText());
async function settingsBackdrop() {
  await page.locator(".modal-overlay").click({ position: { x: 2, y: 2 } });
  await page.getByRole("dialog", { name: "设置尚未保存", exact: true }).waitFor();
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await setup();
  const original = await source();
  await openMenu("设置当前位置速度…");
  assert.equal(await dialog.getAttribute("aria-modal"), "true");
  assert.equal(await page.locator("#app").evaluate(el => el.inert), true);
  const before = await dialog.boundingBox();
  const header = await dialog.locator(".inspector-header").boundingBox();
  await page.mouse.move(header.x + 70, header.y + 20); await page.mouse.down();
  await page.mouse.move(header.x - 40, header.y + 50, { steps: 6 }); await page.mouse.up();
  const moved = await dialog.boundingBox();
  assert(Math.abs(moved.x - before.x) > 60, "prompt did not drag");
  await dialog.locator(".inspector-resize-grip").focus();
  await page.keyboard.press("Shift+ArrowRight");
  assert((await dialog.boundingBox()).width > moved.width, "prompt did not resize");
  assert.equal(await source(), original, "dragging changed the score");
  await dialog.locator("input").fill("0");
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  assert.equal(await dialog.locator('[role="alert"]').isVisible(), true);
  assert.equal(await source(), original, "invalid BPM changed score");
  await dialog.locator("input").fill("123");
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    assert(await page.evaluate(() => !!document.activeElement?.closest(".app-dialog")), "focus escaped prompt");
  }
  await dialog.locator("input").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__app.painter.score.tempoMarks.some(mark => mark.bpm === 123));
  assert.equal(await page.locator("#app").evaluate(el => el.inert), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), "score-pane", "score focus not restored");
  await page.evaluate(() => window.__app.undoEdit());
  await page.waitForFunction(() => !window.__app.painter.score.tempoMarks.some(mark => mark.bpm === 123));

  await setup();
  await openMenu("渐慢到…");
  assert.equal(await dialog.locator("input").count(), 2, "ramp should use one form for BPM and endpoint");
  await dialog.locator('[name="bpm"]').fill("65");
  await dialog.locator('[name="end"]').fill("2");
  await accept();
  await page.waitForFunction(() => window.__app.painter.score.tempoMarks.some(mark => mark.kind === "rit"));
  await page.locator(".tempo-annotation").filter({ hasText: /rit/ }).first().click();
  await page.keyboard.press("Enter");
  assert.equal(await dialog.locator("input").inputValue(), "65");
  await mkdir("artifacts/ui", { recursive: true });
  await page.screenshot({ path: "artifacts/ui/tempo-floating-dialog.png" });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  assert(await page.evaluate(() => window.__app.painter.score.tempoMarks.some(mark => mark.bpm === 65)));
  await page.keyboard.press("Enter");
  await dialog.locator("input").fill("");
  await accept();
  await page.waitForFunction(() => window.__app.painter.score.tempoMarks.every(mark => mark.softDeleted));
  await page.evaluate(() => window.__app.undoEdit());
  await page.waitForFunction(() => window.__app.painter.score.tempoMarks.some(mark => mark.kind === "rit" && !mark.softDeleted));

  await setup();
  await openMenu("倚音…");
  await dialog.locator("input").fill("23");
  await accept();
  assert(await page.evaluate(() => window.__app.painter.score.parts[0].measures[0].entries.some(chord => chord.graceNotes?.length === 2)));
  await page.locator("#score-pane .jianpu-grace-number").first().click();
  await page.keyboard.press("Enter");
  await dialog.locator("input").fill("7");
  await accept();
  assert(await page.evaluate(() => window.__app.painter.score.parts[0].measures[0].entries.some(chord => chord.graceNotes?.[0]?.number === "7")));
  await openMenu("设置当前位置速度…");
  await dialog.locator("input").fill("88");
  await page.evaluate(() => { const app = window.__app; void app.setInputTempo(app._input.cursor); });
  assert.equal(await dialog.count(), 1, "repeated triggers stacked prompts");
  assert.equal(await dialog.locator("input").inputValue(), "88");
  const beforeCancel = await source();
  await page.keyboard.press("Escape");
  assert.equal(await source(), beforeCancel);

  await openMenu("设置当前位置速度…");
  const replacement = fixture.replace("悬浮输入测试", "替换后的文档");
  await page.evaluate(text => window.__app.loadText(text, null), replacement);
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await source(), replacement, "a stale prompt modified the new document");
  assert.equal(await page.locator("#app").evaluate(el => el.inert), false);

  await setup();
  await openMenu("上波音", false);
  await page.locator("#score-pane .jianpu-ornament").first().click();
  await page.keyboard.press("Enter");
  assert.deepEqual(await dialog.locator("option").allTextContents(), ["上波音", "下波音", "颤音（Tr）"]);
  await dialog.locator("select").selectOption("lower-mordent");
  await accept();
  assert(await page.evaluate(() => window.__app.painter.score.parts[0].measures[0].entries.some(chord => chord.ornaments?.[0]?.kind === "lower-mordent")));

  await setup();
  await openMenu("添加文本…");
  await dialog.locator("textarea").fill("第一行");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("第二行");
  assert.equal(await dialog.locator("textarea").inputValue(), "第一行\n第二行");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => window.__app.painter.score.textMarks.some(mark => mark.text === "第一行\n第二行"));
  await page.locator("#score-pane .score-text-annotation").first().click();
  await page.keyboard.press("Enter");
  assert.equal(await dialog.locator("textarea").inputValue(), "第一行\n第二行");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();

  await page.locator("#btn-options").click();
  let settings = page.locator(".options-box");
  const originalStartup = await page.evaluate(() => window.__app.showTextOnStartup);
  await settings.getByRole("checkbox", { name: "启动时显示文本编辑器", exact: true }).setChecked(!originalStartup);
  await settingsBackdrop();
  await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  await page.screenshot({ path: "artifacts/ui/settings-floating-confirm.png" });
  await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
  assert.equal(await settings.isVisible(), true);
  assert.equal(await page.evaluate(() => window.__app.showTextOnStartup), originalStartup);
  await settingsBackdrop();
  await dialog.getByRole("button", { name: "放弃修改", exact: true }).click();
  await settings.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.__app.showTextOnStartup), originalStartup);
  await page.locator("#btn-options").click();
  settings = page.locator(".options-box");
  await settings.getByRole("checkbox", { name: "启动时显示文本编辑器", exact: true }).setChecked(!originalStartup);
  await settingsBackdrop();
  await dialog.getByRole("button", { name: "应用并关闭", exact: true }).click();
  await settings.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.__app.showTextOnStartup), !originalStartup);

  await setup();
  await openMenu("设置当前位置速度…");
  await page.setViewportSize({ width: 390, height: 700 });
  const mobile = await dialog.boundingBox();
  assert(mobile.x >= 0 && mobile.y >= 0 && mobile.x + mobile.width <= 391 && mobile.y + mobile.height <= 701);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.evaluate(() => { window.__savedPages = window.__app.pageEls; window.__app.pageEls = []; });
  await page.locator("#btn-export").click();
  await page.getByRole("button", { name: "PNG（全部页面）", exact: true }).click();
  await page.getByRole("dialog", { name: "导出失败", exact: true }).waitFor();
  assert.match(await dialog.textContent(), /当前没有可导出的谱面页面/);
  await dialog.getByRole("button", { name: "知道了", exact: true }).click();
  await page.evaluate(() => window.__app.pageEls = window.__savedPages);
  assert.deepEqual(nativeDialogs, [], "browser-native prompt/confirm/alert was shown");
  assert.deepEqual(errors, []);
  console.log("App dialogs: tempo/ramp/grace/ornament/text, validation/cancel/undo, drag/resize/focus, document replacement, settings choices and export failure OK");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
