// Browser end-to-end check for MIDI analysis dialog -> editable piano preview.
// Usage: npm run build && npm run check:midi && node midi-shot.mjs [out.png]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".woff2": "font/woff2", ".wasm": "application/wasm", ".mjs": "text/javascript",
};
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (path === "/") path = "/index.html";
    const data = await readFile(join(root, normalize(path)));
    res.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.message));

const readBraceVisual = () => {
  const path = document.querySelector("#score-pane .piano-brace-path path");
  const rect = path?.getBoundingClientRect();
  const numbers = (path?.getAttribute("d")?.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  return rect && numbers.length >= 20 ? {
    width: rect.width,
    height: rect.height,
    quarterThickness: numbers[18] - numbers[6],
    topTipX: numbers[0],
    middleTipX: numbers[12],
    fill: path.getAttribute("fill"),
  } : null;
};

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  const gbkBytes = await readFile(join(root, "midi-gbk-title.mid"));
  await page.evaluate((input) => {
    const data = Uint8Array.from(input);
    void window.__app.importBytes(data, "中文标题.mid");
  }, [...gbkBytes]);
  await page.locator(".midi-import-box").waitFor();
  const decodedChineseTitle = await page.getByLabel("标题", { exact: true }).inputValue();
  if (decodedChineseTitle !== "中文标题") throw new Error(`GBK MIDI title decoded incorrectly: ${decodedChineseTitle}`);
  await page.getByRole("button", { name: "取消" }).click();
  const squareBytes = await readFile(join(root, "midi-square-title.mid"));
  await page.evaluate((input) => {
    const data = Uint8Array.from(input);
    void window.__app.importBytes(data, "C:\\音乐\\月光奏鸣曲.mid");
  }, [...squareBytes]);
  await page.locator(".midi-import-box").waitFor();
  const fallbackFileTitle = await page.getByLabel("标题", { exact: true }).inputValue();
  if (fallbackFileTitle !== "月光奏鸣曲") throw new Error(`placeholder title did not fall back to the file name: ${fallbackFileTitle}`);
  await page.getByRole("button", { name: "取消" }).click();
  const ensembleBytes = await readFile(join(root, "midi-ensemble-fixture.mid"));
  await page.evaluate((input) => {
    void window.__app.importBytes(Uint8Array.from(input), "ensemble-test.mid");
  }, [...ensembleBytes]);
  await page.locator(".midi-import-box").waitFor();
  const ensembleStructureOptions = await page.getByLabel("谱面结构").locator("option").allTextContents();
  if (!ensembleStructureOptions.some((text) => text.includes("多轨总谱"))) {
    throw new Error("three sounding MIDI tracks did not offer full-score import");
  }
  await page.getByRole("button", { name: "取消" }).click();
  const gestureBytes = await readFile(join(root, "midi-gesture-fixture.mid"));
  await page.evaluate((input) => {
    void window.__app.importBytes(Uint8Array.from(input), "rolled-chord.mid");
  }, [...gestureBytes]);
  await page.locator(".midi-import-box").waitFor();
  const gestureCounts = await page.locator(".midi-duration-counts").textContent();
  if (!gestureCounts?.includes("上行琶音组：1")) {
    throw new Error(`rolled-chord analysis was not shown in the dialog: ${gestureCounts}`);
  }
  await page.getByLabel("导入后格式").selectOption("keyboard");
  if (await page.getByLabel("花括号 {}").inputValue() !== "arpeggio" ||
      await page.getByLabel("方括号 []").inputValue() !== "triplet" ||
      await page.getByLabel("尖括号 <>").inputValue() !== "grace" ||
      await page.getByLabel("竖线括号 || ||").inputValue() !== "none") {
    throw new Error("arpeggio/triplet/grace defaults were not assigned to {}, [] and <>");
  }
  await page.getByRole("button", { name: "导入并转为简谱" }).click();
  await page.waitForFunction(() =>
    window.__app.getText().includes("花括号 = 琶音") &&
    window.__app.getText().split(/\r?\n/).some((line) =>
      !line.trimStart().startsWith("//") && line.includes("/") && /\{[^}]+\}/.test(line)));
  const gestureSlashText = await page.evaluate(() => window.__app.getText());
  const gestureSlash = gestureSlashText.split(/\r?\n/)
    .find((line) => !line.trimStart().startsWith("//") && line.includes("/") && /\{[^}]+\}/.test(line));
  if (!gestureSlash || (gestureSlash.match(/\{/g) ?? []).length !== 1) {
    throw new Error(`rolled chord was missing or repeated as new attacks across sustain groups: ${gestureSlash}`);
  }
  const bytes = await readFile(join(root, "midi-import-fixture.mid"));
  await page.evaluate((input) => {
    const data = Uint8Array.from(input);
    void window.__app.importBytes(data, "piano-test.mid");
  }, [...bytes]);
  await page.locator(".midi-import-box").waitFor();
  const dialog = await page.evaluate(() => ({
    info: document.querySelector(".midi-import-info")?.textContent,
    counts: document.querySelector(".midi-duration-counts")?.textContent,
    quantize: [...document.querySelectorAll(".midi-import-box .modal-row")]
      .find((row) => row.firstElementChild?.textContent === "推荐量化")?.querySelector("select")?.value,
    structureOptions: (() => {
      const structureRow = [...document.querySelectorAll(".midi-import-box .modal-row")]
        .find((row) => row.firstElementChild?.textContent === "谱面结构");
      return [...(structureRow?.querySelectorAll("option") ?? [])].map((item) => item.textContent);
    })(),
  }));
  if (dialog.structureOptions.some((text) => text?.includes("多轨总谱"))) {
    throw new Error("two sounding piano tracks must not offer full-score import");
  }
  await page.getByText("调号、拍号与速度", { exact: true }).click();
  const meterRow = page.locator(".midi-import-box .modal-row").filter({ hasText: "拍号" }).first();
  await meterRow.locator('input[type="number"]').fill("12");
  await meterRow.locator("select").selectOption("8");
  const compoundUnit = page.getByLabel("速度音符");
  const tempoInput = page.getByLabel("速度（BPM）");
  if (!await compoundUnit.isVisible()
      || await compoundUnit.inputValue() !== "dotted-quarter"
      || await tempoInput.inputValue() !== "80") {
    throw new Error("12/8 did not recommend dotted-quarter tempo with converted BPM");
  }
  await compoundUnit.selectOption("eighth");
  if (await tempoInput.inputValue() !== "240") {
    throw new Error("eighth-note tempo did not convert from the original quarter-note BPM");
  }
  await meterRow.locator("select").selectOption("4");
  if (await compoundUnit.isVisible() || await tempoInput.inputValue() !== "120") {
    throw new Error("leaving /8 meter did not restore the quarter-note BPM");
  }
  await meterRow.locator('input[type="number"]').fill("4");
  await page.getByLabel("副标题").fill("钢琴双手排版示例");
  await page.getByLabel("作曲").fill("测试作曲");
  await page.getByLabel("编曲").fill("测试编曲");
  await page.getByLabel("乐器名称").fill("中文钢琴");
  await page.getByRole("button", { name: "导入并转为简谱" }).click();
  await page.waitForFunction(() => window.__app.getText().includes(".Voice.RH"));
  await page.waitForTimeout(500);
  const defaultPage = await page.evaluate(() => {
    const wrap = document.querySelector(".score-page-wrap")?.getBoundingClientRect();
    return {
      portraitSetting: window.__app.pageH > window.__app.pageW,
      portraitPaper: Boolean(wrap && wrap.height > wrap.width),
      viewBox: document.querySelector("#score-pane svg")?.getAttribute("viewBox"),
    };
  });
  const defaultBraceVisual = await page.evaluate(readBraceVisual);
  const defaultConnectorSegments = await page.locator("#score-pane .piano-barline-connector").count();
  await page.locator("#btn-layout-style").click();
  await page.locator('#inspector-pane[data-inspector-id="layout"]').waitFor();
  await page.locator("#inspector-pane details.engraving-section").evaluateAll((sections) => {
    for (const section of sections) section.open = true;
  });
  await page.locator('input[name="measuresPerSystem"]').fill("4");
  await page.locator('input[name="rhythmicSpacingExponent"]').fill("0.7");
  await page.locator('input[name="rhythmicSpacingEnabled"]').check();
  await page.locator('input[name="justifyLastSystem"]').check();
  await page.getByLabel("数字大小").fill("1.2");
  await page.getByLabel("和弦最小间距").fill("1.04");
  await page.getByLabel("八度点大小").fill("1.3");
  await page.getByLabel("八度点贴音距离").fill("0.55");
  await page.getByLabel("八度点与相邻音留白").fill("1.8");
  await page.getByLabel("升降号大小").fill("1.15");
  await page.getByLabel("升降号与数字间距").fill("1.8");
  await page.getByLabel("延音线续音变灰").check();
  await page.getByLabel("谱行上下间距").fill("0.75");
  await page.getByLabel("花括号宽度").fill("0.5");
  await page.getByLabel("花括号粗细").fill("0.5");
  await page.waitForFunction(() =>
    document.querySelector("#score-pane .piano-brace-path path")
    && window.__app.painter.layout.options.engravingStyle.braceStrokeWidth === 0.5);
  const thinBraceVisual = await page.evaluate(readBraceVisual);
  if (process.argv[4]) await page.screenshot({ path: process.argv[4], fullPage: false });
  await page.locator('#inspector-pane select[name="pagePreset"]').selectOption("A3");
  await page.locator('#inspector-pane select[name="pageDirection"]').selectOption("landscape");
  await page.locator('#inspector-pane input[name="fontSize"]').fill("32");
  await page.locator('#inspector-pane input[name="titleSize"]').fill("54");
  await page.locator('#inspector-pane input[name="creditSize"]').fill("40");
  await page.waitForFunction(() =>
    document.querySelector("#score-pane svg")?.getAttribute("viewBox") === "0 0 1191 842"
    && window.__app.painter.layout.fontSize === 32);
  const paperFontPreview = await page.evaluate(() => ({
    previewViewBox: document.querySelector("#score-pane svg")?.getAttribute("viewBox"),
    previewBaseFontSize: window.__app.painter.layout.fontSize,
    savedPageW: window.__app.pageW,
    savedPageH: window.__app.pageH,
    savedBaseFontSize: window.__app.fontSize,
    savedTitleSize: window.__app.titleSize,
    savedCreditSize: window.__app.creditSize,
  }));
  await page.locator('#inspector-pane select[name="pagePreset"]').selectOption("A4");
  await page.locator('#inspector-pane select[name="pageDirection"]').selectOption("portrait");
  await page.locator('#inspector-pane input[name="fontSize"]').fill("28");
  await page.locator('#inspector-pane input[name="titleSize"]').fill("48");
  await page.locator('#inspector-pane input[name="creditSize"]').fill("36");
  await page.getByLabel("乐器名称").fill("中国钢琴");
  await page.waitForFunction(() =>
    document.querySelector("#score-pane svg")?.getAttribute("viewBox") === "0 0 595 842"
    && window.__app.painter.layout.fontSize === 28);
  await page.getByLabel("花括号宽度").fill("2");
  await page.getByLabel("花括号粗细").fill("5");
  await page.getByLabel("上下连接线粗细").fill("1.2");
  await page.getByLabel("双实线粗细").fill("5");
  await page.getByLabel("显示节奏刻度线（默认开启）").check();
  await page.getByLabel("刻度模式").selectOption("manual");
  await page.getByLabel("手动最短时值").selectOption("32");
  await page.waitForFunction(() =>
    document.querySelector("#score-pane .piano-brace-path path")
    && window.__app.painter.layout.options.engravingStyle.braceStrokeWidth === 5
    && window.__app.painter.layout.options.engravingStyle.rhythmGuideDivision === 32);
  const previewBraceVisual = await page.evaluate(readBraceVisual);
  const styleDialog = await page.evaluate(() => ({
    controls: document.querySelectorAll("#inspector-pane input[type=range]").length,
    inspectorOpen: !document.querySelector("#inspector-pane")?.hasAttribute("hidden"),
    preview: document.querySelector("#score-pane svg")?.getAttribute("viewBox"),
    previewText: document.querySelector("#score-pane svg")?.textContent,
    previewRhythmGuide: document.querySelectorAll("#score-pane .rhythm-guide-line").length,
    previewSystems: document.querySelectorAll("#score-pane .piano-system").length,
    pendingStyle: window.__app.painter.layout.options.engravingStyle,
    savedStyleStillOriginal: window.__app.engravingStyle.braceStrokeWidth !== 5,
  }));
  const samplePreview = await page.evaluate(() => {
    const app = window.__app;
    const svg = app.renderEngravingStylePreview(app.painter.layout.options.engravingStyle);
    if (!svg) return null;
    return {
      source: svg.getAttribute("data-actual-layout-preview"),
      title: svg.textContent?.includes("全功能排版预览"),
      systems: svg.querySelectorAll(".piano-system").length,
      graceNotes: svg.querySelectorAll(".jianpu-grace-note").length,
      graceLinks: svg.querySelectorAll(".jianpu-grace-link").length,
      arpeggios: svg.querySelectorAll(".jianpu-arpeggio").length,
      sharps: svg.querySelectorAll(".jianpu-accidental-sharp").length,
      flats: svg.querySelectorAll(".jianpu-accidental-flat").length,
    };
  });
  if (process.argv[3]) {
    await page.locator("#score-pane").screenshot({ path: process.argv[3] });
  }
  await page.getByRole("button", { name: "应用到全部简谱" }).click();
  await page.waitForFunction(() => Math.abs(window.__app.engravingStyle.finalBarlineWidth - 5) < 0.001);
  await page.locator("#btn-options").click();
  await page.getByLabel("连接跨行小节线").check();
  await page.locator(".modal-overlay .modal-footer").getByRole("button", { name: "确定" }).click();
  await page.waitForFunction(() => window.__app.engravingStyle.connectBarlines
    && document.querySelectorAll("#score-pane .piano-barline-connector").length >= 2);
  await page.waitForTimeout(250);
  const result = await page.evaluate(() => ({
    piano: window.__app.painter.score.piano,
    parts: window.__app.painter.score.parts.length,
    tempo: window.__app.painter.score.tempoBpm,
    pages: document.querySelectorAll("#score-pane svg").length,
    hasRight: window.__app.getText().includes(".Voice.RH"),
    hasLeft: window.__app.getText().includes(".Voice.LH"),
    hasChord: /\[[^\]]{3,}\]/.test(window.__app.getText()),
    hasSubtitle: window.__app.getText().includes("SubTitle = {钢琴双手排版示例}"),
    hasInstrument: window.__app.getText().includes("Instrument = {中国钢琴}"),
    portrait: window.__app.pageH > window.__app.pageW,
    portraitPaper: (() => {
      const rect = document.querySelector(".score-page-wrap")?.getBoundingClientRect();
      return Boolean(rect && rect.height > rect.width);
    })(),
    pageViewBox: document.querySelector("#score-pane svg")?.getAttribute("viewBox"),
    publicationSizesApplied: (() => {
      const texts = [...document.querySelectorAll("#score-pane svg text")];
      const meta = texts.find((text) => text.textContent?.includes("♩="));
      const instrument = texts.find((text) => text.textContent === "中国钢琴");
      const pageNumber = texts.find((text) => /^\d+\/\d+$/.test(text.textContent ?? ""));
      const opt = window.__app.painter.layout.options;
      return Boolean(
        meta && instrument && pageNumber &&
        Math.abs(Number(meta.getAttribute("font-size")) - opt.numberSize * 0.87) < 0.01 &&
        Math.abs(Number(instrument.getAttribute("font-size")) - opt.lrcFont.size * 0.56 / 1.5) < 0.01 &&
        Math.abs(Number(pageNumber.getAttribute("font-size")) - opt.lrcFont.size * 0.8 / 3) < 0.01
      );
    })(),
    headerText: document.querySelector("#score-pane svg")?.textContent,
    instrumentLabels: [...document.querySelectorAll("#score-pane svg text")].filter((text) => text.textContent === "中国钢琴").length,
    obsoleteHandLabels: [...document.querySelectorAll("#score-pane svg text")].filter((text) => text.textContent === "右手" || text.textContent === "左手").length,
    finalSegments: [...document.querySelectorAll("#score-pane svg line")]
      .filter((line) => Math.abs(Number(line.getAttribute("stroke-width")) - 5) < 0.001).length,
    connectorSegments: [...document.querySelectorAll("#score-pane svg line")]
      .filter((line) => Math.abs(Number(line.getAttribute("stroke-width")) - 6) < 0.001).length,
    rhythmGuideLines: document.querySelectorAll("#score-pane .rhythm-guide-line").length,
    rhythmGuideMajorTicks: document.querySelectorAll("#score-pane .rhythm-guide-major").length,
    rhythmGuideMinorTicks: document.querySelectorAll("#score-pane .rhythm-guide-minor").length,
    headerVisual: (() => {
      const svg = document.querySelector("#score-pane svg");
      const title = [...document.querySelectorAll("#score-pane svg text")]
        .find((node) => node.textContent === "Piano Quantize Test");
      const meta = [...document.querySelectorAll("#score-pane svg text")]
        .find((node) => node.textContent?.includes("♩=120"));
      const rectOf = (node) => {
        const rect = node?.getBoundingClientRect();
        return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
      };
      return {
        svg: rectOf(svg),
        title: rectOf(title),
        meta: rectOf(meta),
        scrollTop: document.querySelector("#score-pane")?.scrollTop,
      };
    })(),
    systemGap: window.__app.painter.layout.options.systemGap(),
    engravingStyle: window.__app.engravingStyle,
    storedStyle: JSON.parse(localStorage.getItem("jpeditor-render-settings") ?? "{}").engravingStyle,
  }));
  const finalBraceVisual = await page.evaluate(readBraceVisual);
  console.log(JSON.stringify({ decodedChineseTitle, fallbackFileTitle, gestureSlash, dialog, defaultPage, defaultBraceVisual, defaultConnectorSegments, thinBraceVisual, previewBraceVisual, finalBraceVisual, paperFontPreview, styleDialog, samplePreview, result, errors: errors.filter((x) => !/favicon/.test(x)) }, null, 2));
  if (!defaultPage.portraitSetting || !defaultPage.portraitPaper || defaultPage.viewBox !== "0 0 595 842") {
    throw new Error("default page is not truly portrait");
  }
  if (!result.piano || result.parts !== 2 || result.tempo !== 120 || !result.hasChord || !result.hasSubtitle || !result.hasInstrument || !result.portrait || !result.portraitPaper || result.pageViewBox !== "0 0 595 842" || result.pages !== 1 || result.instrumentLabels !== 1 || result.obsoleteHandLabels !== 0 || !result.publicationSizesApplied || result.finalSegments < 4 || result.connectorSegments < 2 || result.rhythmGuideLines < 1 || result.rhythmGuideMajorTicks !== 4 || result.rhythmGuideMinorTicks !== 28) {
    throw new Error("MIDI browser import result is incomplete");
  }
  if (result.engravingStyle.measuresPerSystem !== 4 || Math.abs(result.engravingStyle.rhythmicSpacingExponent - 0.7) > 0.001 || !result.engravingStyle.rhythmicSpacingEnabled || !result.engravingStyle.justifyLastSystem || result.storedStyle?.measuresPerSystem !== 4 || Math.abs(result.storedStyle?.rhythmicSpacingExponent - 0.7) > 0.001) {
    throw new Error("rhythmic measure layout settings did not preview or persist");
  }
  if (paperFontPreview.previewViewBox !== "0 0 1191 842"
    || paperFontPreview.previewBaseFontSize !== 32
    || paperFontPreview.savedPageW !== 595
    || paperFontPreview.savedPageH !== 842
    || paperFontPreview.savedBaseFontSize !== 28
    || paperFontPreview.savedTitleSize !== 48
    || paperFontPreview.savedCreditSize !== 36) {
    throw new Error("paper and font preview changed saved settings before Apply");
  }
  if (styleDialog.controls < 17 || !styleDialog.inspectorOpen || !styleDialog.preview || !styleDialog.previewText?.includes("Piano Quantize Test") || styleDialog.previewSystems < 1 || styleDialog.previewRhythmGuide < 1 || styleDialog.pendingStyle?.measuresPerSystem !== 4 || styleDialog.pendingStyle?.rhythmicSpacingExponent !== 0.7 || styleDialog.pendingStyle?.rhythmGuideDivision !== 32 || styleDialog.pendingStyle?.connectBarlines !== false || !styleDialog.savedStyleStillOriginal || !samplePreview || samplePreview.source !== "true" || !samplePreview.title || samplePreview.systems < 2 || samplePreview.graceNotes < 1 || samplePreview.graceLinks < 1 || samplePreview.arpeggios < 1 || samplePreview.sharps < 1 || samplePreview.flats < 1 || defaultConnectorSegments !== 0 || !defaultBraceVisual || !thinBraceVisual || !previewBraceVisual || !finalBraceVisual || defaultBraceVisual.middleTipX >= defaultBraceVisual.topTipX || thinBraceVisual.fill === "none" || previewBraceVisual.quarterThickness <= thinBraceVisual.quarterThickness * 2.5 || finalBraceVisual.width < thinBraceVisual.width * 2.5 || finalBraceVisual.quarterThickness <= thinBraceVisual.quarterThickness * 2.5 || result.engravingStyle.numberScale !== 1.2 || result.engravingStyle.octaveDotDistance !== 0.55 || result.engravingStyle.octaveDotClearance !== 1.8 || result.engravingStyle.accidentalScale !== 1.15 || result.engravingStyle.accidentalGapScale !== 1.8 || !result.engravingStyle.tieContinuationGray || result.engravingStyle.systemGapScale !== 0.75 || result.engravingStyle.braceWidthScale !== 2 || result.engravingStyle.braceStrokeWidth !== 5 || !result.engravingStyle.connectBarlines || result.systemGap <= 0 || !result.engravingStyle.rhythmGuideEnabled || result.engravingStyle.rhythmGuideMode !== "manual" || result.engravingStyle.rhythmGuideDivision !== 32 || result.storedStyle?.finalBarlineWidth !== 5 || result.storedStyle?.octaveDotDistance !== 0.55 || result.storedStyle?.octaveDotClearance !== 1.8 || result.storedStyle?.accidentalScale !== 1.15 || result.storedStyle?.accidentalGapScale !== 1.8 || result.storedStyle?.tieContinuationGray !== true || result.storedStyle?.systemGapScale !== 0.75 || result.storedStyle?.braceWidthScale !== 2 || result.storedStyle?.braceStrokeWidth !== 5 || result.storedStyle?.connectBarlines !== true || result.storedStyle?.rhythmGuideMode !== "manual" || result.storedStyle?.rhythmGuideDivision !== 32) {
    throw new Error("global engraving style dialog did not apply or persist");
  }
  if (errors.filter((x) => !/favicon/.test(x)).length) throw new Error("Browser console errors occurred");
  await page.screenshot({ path: process.argv[2] ?? join(root, "midi-import.png"), fullPage: false });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app && window.__app.pageH > window.__app.pageW && Math.abs(window.__app.engravingStyle.finalBarlineWidth - 5) < 0.001);
  await page.evaluate(() => localStorage.setItem("jpeditor-render-settings", JSON.stringify({ pageW: 960, pageH: 540 })));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => {
    const wrap = document.querySelector(".score-page-wrap")?.getBoundingClientRect();
    return window.__app.pageW === 595 && window.__app.pageH === 842 && Boolean(wrap && wrap.height > wrap.width);
  });
} finally {
  await browser.close();
  server.close();
}
