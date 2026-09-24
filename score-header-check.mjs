// Run after npm run build. Real browser regression for clickable publication headers.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = process.env.SCORE_HEADER_CHECK_URL ? null : createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(await readFile(join(root, normalize(file))));
  } catch { response.writeHead(404); response.end(); }
});
if (server) await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const origin = process.env.SCORE_HEADER_CHECK_URL ?? `http://127.0.0.1:${server.address().port}/`;
const jpw = ".Title\nTitle = 谱头原题\nSubTitle = 原副题\nLyricist = 原词\nComposer = 原曲\nArranger = 原编\nKeyAndMeters = {1=C,4/4}\nTempo = 88\n.Voice\n1 2 3 4 |]";
const keyboard = "键盘谱\n4/4拍：\n点=16分音符\nA.../B.../C.../D.../\n";

function headerState() {
  const app = window.__app;
  const score = app.painter.score;
  const first = score.parts[0].measures[0];
  return { text: app.getText(), title: score.title, subtitle: score.subtitle,
    lyricist: score.lyricist, composer: score.composer, arranger: score.arranger,
    fifths: first.key.fifths, beats: first.time.beats, beatType: first.time.beatType,
    tempoBpm: score.tempoBpm, tempoBeatUnit: score.tempoBeatUnit };
}

async function clickHeader(selector) {
  const node = page.locator(`#score-pane ${selector}`).first();
  await node.waitFor();
  await node.click();
}

async function editCredits(name) {
  const before = await page.evaluate(headerState);
  await clickHeader(".publication-title");
  const dialog = page.locator('.app-dialog[aria-labelledby="app-dialog-title"]');
  await dialog.waitFor();
  assert(await dialog.locator("input").count() === 5, `${name}: credit dialog lacks five fields`);
  const expected = { title: `${name} 新标题`, subtitle: `${name} 新副标题`,
    lyricist: `${name} 新作词`, composer: `${name} 新作曲`, arranger: `${name} 新编曲` };
  for (const [field, value] of Object.entries(expected)) await dialog.locator(`[name="${field}"]`).fill(value);
  await dialog.locator('button[data-action="apply"]').click();
  await dialog.waitFor({ state: "detached" });
  const after = await page.evaluate(headerState);
  for (const [field, value] of Object.entries(expected)) assert(after[field] === value, `${name}: ${field} not saved`);
  assert(after.text.includes("1") || after.text.includes("A"), `${name}: score body disappeared`);
  assert(await page.locator("#score-pane .publication-title").first().textContent() === expected.title,
    `${name}: page title did not repaint`);
  await page.evaluate(() => window.__app.undoEdit());
  await page.waitForFunction((title) => window.__app.painter.score.title === title, before.title);
  const undone = await page.evaluate(headerState);
  assert(undone.title === before.title, `${name}: undo did not restore title`);
  await page.evaluate(() => window.__app.redoEdit());
  await page.waitForFunction((title) => window.__app.painter.score.title === title, expected.title);
  const redone = await page.evaluate(headerState);
  assert(redone.title === expected.title && redone.arranger === expected.arranger, `${name}: redo did not restore credits`);
  return expected;
}

async function checkCancel(name) {
  const before = await page.evaluate(headerState);
  for (const selector of [".publication-subtitle", ".publication-credit"]) {
    await clickHeader(selector);
    const dialog = page.locator(".app-dialog");
    await dialog.waitFor();
    await dialog.locator('[name="title"]').fill("不应保存");
    await dialog.locator('button[data-action="cancel"]').click();
    await dialog.waitFor({ state: "detached" });
    assert(JSON.stringify(await page.evaluate(headerState)) === JSON.stringify(before), `${name}: cancel changed document`);
  }
}

async function editRhythm(name) {
  const before = await page.evaluate(headerState);
  await clickHeader(".publication-meta");
  const dialog = page.locator(".app-dialog");
  await dialog.waitFor();
  await dialog.locator('[name="fifths"]').selectOption("2");
  await dialog.locator('[name="beats"]').fill("3");
  await dialog.locator('[name="beatType"]').selectOption("8");
  await dialog.locator('[name="tempo"]').fill("96");
  await dialog.locator('[name="tempoBeatUnit"]').selectOption("quarter");
  await dialog.locator('button[data-action="apply"]').click();
  await dialog.waitFor({ state: "detached" });
  const after = await page.evaluate(headerState);
  assert(after.fifths === 2 && after.beats === 3 && after.beatType === 8 && after.tempoBpm === 96,
    `${name}: rhythm values not applied: ${JSON.stringify(after)}`);
  await page.evaluate(() => window.__app.undoEdit());
  await page.waitForFunction((value) => window.__app.painter.score.parts[0].measures[0].time.beats === value, before.beats);
  const undone = await page.evaluate(headerState);
  assert(undone.fifths !== 2 || undone.beats !== 3, `${name}: undo did not restore rhythm`);
  await page.evaluate(() => window.__app.redoEdit());
  await page.waitForFunction(() => window.__app.painter.score.parts[0].measures[0].time.beats === 3);
  const redone = await page.evaluate(headerState);
  assert(redone.fifths === 2 && redone.beats === 3 && redone.tempoBpm === 96, `${name}: redo did not restore rhythm`);
}

try {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.evaluate((text) => window.__app.loadText(text, "score-header-check.jpwabc"), jpw);
  await page.locator("#score-pane .publication-title").waitFor();
  await editCredits("JPW");
  await checkCancel("JPW");
  await editRhythm("JPW");

  await page.evaluate((text) => {
    const app = window.__app;
    app._applyImportedSlash(text, {
      kind: "keyboard", voiceCount: 1, instrumentName: "钢琴", title: "键盘原题",
      subtitle: "键盘原副题", lyricist: "键盘原词", composer: "键盘原曲", arranger: "键盘原编",
      tempoBpm: 88, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: null, braceMode: "arpeggio", bracketMode: "triplet",
      barMode: "grace", angleMode: "subdivide", parenMode: "chord", ordering: "pitch-asc",
      showExplicitRests: true,
    });
  }, keyboard);
  await page.locator("#score-pane .publication-title").waitFor();
  await editCredits("键盘");
  await checkCancel("键盘");
  await editRhythm("键盘");

  // A metadata edit should update an open settings pane without replacing unrelated drafts.
  await page.setViewportSize({ width: 2000, height: 900 });
  await page.evaluate(() => { window.__settingsTask = window.__app.showScoreSettings(); });
  const inspector = page.locator('#inspector-pane[data-inspector-id="score"]');
  await inspector.waitFor();
  const instrument = inspector.locator("label").filter({ hasText: "多声部乐器名称" }).locator("input");
  await instrument.fill("尚未应用的乐器草稿");
  const beforeHeaderEdit = await page.evaluate(headerState);
  await clickHeader(".publication-title");
  const dialog = page.locator(".app-dialog");
  await dialog.locator('[name="title"]').fill("面板同步标题");
  await dialog.locator('[name="composer"]').fill("面板同步作曲");
  await dialog.locator('button[data-action="apply"]').click();
  await dialog.waitFor({ state: "detached" });
  const metadata = inspector.locator("details").filter({ hasText: "标题与署名" });
  await metadata.evaluate((node) => { node.open = true; });
  assert(await metadata.locator("label").filter({ hasText: "标题" }).first().locator("input").inputValue() === "面板同步标题",
    "Open settings title did not synchronize");
  assert(await metadata.locator("label").filter({ hasText: "作曲" }).locator("input").inputValue() === "面板同步作曲",
    "Open settings composer did not synchronize");
  assert(await instrument.inputValue() === "尚未应用的乐器草稿", "Header edit overwrote unrelated settings draft");

  const titleDraft = metadata.locator("label").filter({ hasText: "标题" }).first().locator("input");
  const composerDraft = metadata.locator("label").filter({ hasText: "作曲" }).locator("input");
  await page.evaluate(() => window.__app.undoEdit());
  await page.waitForFunction((value) => window.__app.painter.score.title === value, beforeHeaderEdit.title);
  await page.waitForFunction((value) => document.querySelector('#inspector-pane details input')
    && [...document.querySelectorAll('#inspector-pane details')]
      .find((node) => node.textContent.includes("标题与署名"))
      ?.querySelector("label input")?.value === value, beforeHeaderEdit.title);
  assert(await titleDraft.inputValue() === beforeHeaderEdit.title
    && await composerDraft.inputValue() === beforeHeaderEdit.composer,
  "Undo did not restore open settings metadata fields");
  assert(await instrument.inputValue() === "尚未应用的乐器草稿", "Undo overwrote unrelated settings draft");
  await page.evaluate(() => window.__app.redoEdit());
  await page.waitForFunction(() => window.__app.painter.score.title === "面板同步标题");
  await page.waitForFunction(() => [...document.querySelectorAll('#inspector-pane details')]
    .find((node) => node.textContent.includes("标题与署名"))
    ?.querySelector("label input")?.value === "面板同步标题");
  assert(await titleDraft.inputValue() === "面板同步标题"
    && await composerDraft.inputValue() === "面板同步作曲",
  "Redo did not restore open settings metadata fields");
  assert(await instrument.inputValue() === "尚未应用的乐器草稿", "Redo overwrote unrelated settings draft");

  // Opening another score discards the old editor and inspector, with no stale apply path.
  await clickHeader(".publication-title");
  await page.locator('.app-dialog [name="title"]').fill("过期窗口标题");
  await page.evaluate((text) => window.__app.loadText(text, "replacement.jpwabc"), jpw.replace("谱头原题", "替换文档"));
  assert(await page.locator(".app-dialog").count() === 0, "Old header dialog survived document replacement");
  assert(await page.locator('#inspector-pane[data-inspector-id="score"]').count() === 0,
    "Old settings pane survived document replacement");
  const replacement = await page.evaluate(headerState);
  assert(replacement.title === "替换文档" && !replacement.text.includes("过期窗口标题"), "Stale header edit touched replacement score");
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  console.log("谱头点击编辑通过：JPW/键盘 TXT、五项署名、取消、撤销重做、调拍速、设置同步与撤销重做、切文档关闭");
} finally {
  await browser.close();
  server?.close();
}
