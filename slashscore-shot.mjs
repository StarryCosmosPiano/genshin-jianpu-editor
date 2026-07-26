import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = join(process.cwd(), "dist");
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml",
  ".wasm": "application/wasm", ".mjs": "text/javascript",
};
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (path === "/") path = "/index.html";
    const data = await readFile(join(ROOT, normalize(path)));
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 960 } });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);

await page.locator("#btn-create").click();
const createChoices = await page.locator(".create-score-choices button").allTextContents();
if (createChoices.length !== 3) throw new Error("create dialog must offer three formats");
await page.locator(".create-score-choices button", { hasText: "键盘谱" }).click();
await page.locator(".slash-import-box").waitFor();
await page.getByRole("button", { name: "导入为单行简谱" }).click();
await page.locator(".slash-import-box").waitFor({ state: "detached" });
const created = await page.evaluate(() => ({
  format: window.__app.documentFormat,
  hasTemplateHeader: window.__app.getText().startsWith("键盘谱"),
  singleStaff: !window.__app.painter.score.piano && window.__app.painter.score.parts.length === 1,
}));
if (created.format !== "keyboard" || !created.singleStaff) throw new Error("create keyboard score failed");

const keyboardText = `这行中文说明会原样保留并作为注释忽略
键盘谱
标题=单行简谱排版示例
副标题=键盘谱与数字谱
作曲=测试作曲
编曲=测试编曲
4/4拍：
速度=四分音符(123 BPM)
点=八分音符

 - / - /S.D./Q../ [line1]
(VJ).Q./(ZG)../B.S./D.Q./
`;
await page.evaluate((text) => {
  void window.__app.importBytes(new TextEncoder().encode(text), "中文键盘谱.txt");
}, keyboardText);
await page.locator(".slash-import-box").waitFor();
const slashDialog = {
  info: await page.locator(".slash-import-box .midi-import-info").textContent(),
  hasSpaceMapping: await page.locator(".slash-import-box .modal-row", { hasText: "空格时值" }).count() === 1,
  hasNoteDuration: await page.locator(".slash-import-box .modal-row", { hasText: "音符自身时值" }).count() === 1,
  hasSingleStaffHint: (await page.locator(".slash-import-box").textContent())?.includes("单个简谱谱表") ?? false,
  mappingRows: await page.locator(".slash-symbol-row").count(),
};
if (!slashDialog.hasSpaceMapping || !slashDialog.hasNoteDuration) throw new Error("intrinsic note/space duration controls are missing");
await page.getByRole("button", { name: "导入为单行简谱" }).click();
await page.locator(".slash-import-box").waitFor({ state: "detached" });
await page.waitForTimeout(500);

const imported = await page.evaluate(() => {
  const app = window.__app;
  const chords = app.painter.score.parts[0].measures.flatMap((measure) =>
    measure.entries.filter((entry) => Array.isArray(entry.notes) && !entry.rest));
  const pageTexts = [...document.querySelectorAll("#score-pane text")].map((item) => item.textContent ?? "");
  return {
    format: app.documentFormat,
    piano: app.painter.score.piano,
    parts: app.painter.score.parts.length,
    tempo: app.painter.score.tempoBpm,
    commentsPreserved: app.getText().includes("这行中文说明会原样保留"),
    hasStoredSettings: app.getText().includes("// @jpeditor "),
    tagsPreservedInSource: app.getText().includes("[line1]"),
    chordCount: chords.length,
    verticalChord: chords.some((chord) => chord.notes.length > 1),
    pages: document.querySelectorAll("#score-pane svg").length,
    publicationHeader: ["单行简谱排版示例", "键盘谱与数字谱", "作曲：测试作曲", "编曲：测试编曲"]
      .every((text) => pageTexts.includes(text)),
    titleOccurrences: pageTexts.filter((text) => text === "单行简谱排版示例").length,
    obsoleteHandLabels: [...document.querySelectorAll("#score-pane text")]
      .filter((item) => item.textContent === "左手" || item.textContent === "右手").length,
  };
});
if (imported.format !== "keyboard" || imported.piano || imported.parts !== 1 || !imported.verticalChord ||
    !imported.hasStoredSettings || !imported.publicationHeader || imported.titleOccurrences !== 1) {
  throw new Error("keyboard TXT did not become one vertical-chord staff");
}

const outKeyboard = process.argv[2] ?? "slashscore-keyboard.png";
await page.locator("#btn-next").click();
await page.waitForTimeout(200);
await page.screenshot({ path: outKeyboard, fullPage: false });

const intrinsicText = `键盘谱
4/4拍：
 Q (CBDGQ)/ Z (ZG)/ Z (CBQ)/ (ZSGW)(BM) /
`;
await page.evaluate((text) => {
  void window.__app.importBytes(new TextEncoder().encode(text), "音符自身时值.txt");
}, intrinsicText);
await page.locator(".slash-import-box").waitFor();
await page.locator('select[name="noteDivision"]').selectOption("4");
await page.locator('select[name="spaceDivision"]').selectOption("4");
await page.getByRole("button", { name: "导入为单行简谱" }).click();
await page.locator(".slash-import-box").waitFor({ state: "detached" });
await page.waitForTimeout(300);
const intrinsicImport = await page.evaluate(() => {
  const app = window.__app;
  const measures = app.painter.score.parts[0].measures;
  const last = measures[3];
  const notes = last?.entries.filter((entry) => Array.isArray(entry.notes) && !entry.rest)
    .map((entry) => ({
      at: entry.position.toFloat(),
      duration: entry.duration?.toFloat() ?? 0,
      pitches: entry.notes.length,
    })) ?? [];
  return {
    measures: measures.length,
    notes,
    noteDivision: app.slashOptions?.noteDivision,
    spaceDivision: app.slashOptions?.spaceDivision,
    stored: app.getText().includes('"nd":4') && app.getText().includes('"sp":4'),
  };
});
if (intrinsicImport.measures !== 4 || intrinsicImport.notes.length !== 2 ||
    intrinsicImport.notes[0]?.at !== 0 || intrinsicImport.notes[1]?.at !== 2 ||
    intrinsicImport.notes[0]?.duration !== 2 || intrinsicImport.notes[1]?.duration !== 2 ||
    intrinsicImport.notes[0]?.pitches !== 4 || intrinsicImport.notes[1]?.pitches !== 2 ||
    intrinsicImport.noteDivision !== 4 || intrinsicImport.spaceDivision !== 4 || !intrinsicImport.stored) {
  throw new Error("intrinsic note/space duration import did not match the four-quarter example");
}

const fullNumberText = await readFile("examples/所念皆星河 - 数字谱.txt", "utf8");
await page.evaluate((text) => {
  void window.__app.importBytes(new TextEncoder().encode(text), "所念皆星河 - 数字谱.txt");
}, fullNumberText);
await page.locator(".slash-import-box").waitFor();
await page.getByRole("button", { name: "导入为单行简谱" }).click();
await page.locator(".slash-import-box").waitFor({ state: "detached" });
await page.waitForTimeout(600);
const fullExampleLayout = await page.evaluate(() => {
  const app = window.__app;
  const linesByPage = app.painter.layout.pages.map((layoutPage) =>
    layoutPage.children.filter((child) => child.children.some((entry) => entry.classes?.has("entry"))));
  const lineRanges = linesByPage.flatMap((lines) =>
    lines
      .map((line) => {
        const measures = line.children
          .map((entry) => entry.data?.syncMeasure)
          .filter((value) => Number.isInteger(value) && value >= 0);
        return measures.length ? [Math.min(...measures), Math.max(...measures)] : [-1, -1];
      }));
  const svgs = [...document.querySelectorAll("#score-pane svg")];
  const titleNodes = svgs.flatMap((svg) => [...svg.querySelectorAll("text")])
    .filter((node) => node.textContent === "所念皆星河");
  const firstSvgRect = svgs[0]?.getBoundingClientRect();
  const titleRect = titleNodes[0]?.getBoundingClientRect();
  const metaNode = [...(svgs[0]?.querySelectorAll("text") ?? [])]
    .find((node) => node.textContent?.includes("1=C") && node.textContent?.includes("123"));
  const firstPageGaps = (linesByPage[0] ?? []).slice(1).map((line, index) =>
    line.y - (linesByPage[0][index].y + linesByPage[0][index].height));
  const rightEdgeErrors = linesByPage.flatMap((lines) => lines.map((line) => {
    const bars = line.children.filter((child) => child.classes?.has("measure-barline"));
    const last = bars.sort((a, b) => a.x + a.width - (b.x + b.width)).at(-1);
    return last ? Math.abs(line.width - (last.x + last.width)) : Number.POSITIVE_INFINITY;
  }));
  const expectedSystemGap = app.painter.layout.options.systemGap();
  return {
    pages: svgs.length,
    systems: lineRanges.length,
    systemsPerPage: linesByPage.map((lines) => lines.length),
    maxMeasuresPerSystem: Math.max(...lineRanges.map(([first, last]) => last - first + 1)),
    maxRightEdgeError: Math.max(...rightEdgeErrors),
    titleCount: titleNodes.length,
    titleTop: titleRect && firstSvgRect ? titleRect.top - firstSvgRect.top : -1,
    metaAtTop: Boolean(metaNode && metaNode.getBBox().y < 180),
    firstSystemTop: linesByPage[0]?.[0]?.y ?? -1,
    lastSystemBottom: linesByPage[0]?.length
      ? linesByPage[0][linesByPage[0].length - 1].y + linesByPage[0][linesByPage[0].length - 1].height
      : -1,
    expectedSystemGap,
    maxSystemGapError: firstPageGaps.length
      ? Math.max(...firstPageGaps.map((gap) => Math.abs(gap - expectedSystemGap)))
      : -1,
  };
});
if (fullExampleLayout.systems < 12 || fullExampleLayout.maxMeasuresPerSystem > 4 ||
    fullExampleLayout.maxRightEdgeError > 0.1 ||
    fullExampleLayout.titleCount !== 1 || fullExampleLayout.titleTop < 0 ||
    fullExampleLayout.titleTop > 140 || !fullExampleLayout.metaAtTop ||
    fullExampleLayout.firstSystemTop > 260 || fullExampleLayout.pages > 3 ||
    fullExampleLayout.maxSystemGapError < 0 || fullExampleLayout.maxSystemGapError > 0.1) {
  throw new Error("single-staff publication header, target measure count, or automatic vertical reflow did not apply");
}
const outFull = process.argv[4] ?? "slashscore-full-number-layout.png";
await page.locator("#score-pane").evaluate((pane) => { pane.scrollTop = 0; });
await page.screenshot({ path: outFull, fullPage: false });

await page.locator("#btn-layout-style").click();
await page.locator(".engraving-box").waitFor();
const rhythmDefaults = {
  enabled: await page.locator('input[name="rhythmGuideEnabled"]').isChecked(),
  mode: await page.locator('select[name="rhythmGuideMode"]').inputValue(),
  division: await page.locator('select[name="rhythmGuideDivision"]').inputValue(),
  manualDivisionDisabled: await page.locator('select[name="rhythmGuideDivision"]').isDisabled(),
  systemGap: await page.locator('input[name="systemGapScale"]').inputValue(),
  measuresPerSystem: await page.locator('input[name="measuresPerSystem"]').inputValue(),
  rhythmicSpacingEnabled: await page.locator('input[name="rhythmicSpacingEnabled"]').isChecked(),
  rhythmicSpacingExponent: await page.locator('input[name="rhythmicSpacingExponent"]').inputValue(),
  justifyLastSystem: await page.locator('input[name="justifyLastSystem"]').isChecked(),
  previewMeasures: await page.locator('[data-preview-horizontal-layout="true"]').getAttribute("data-preview-measures"),
  previewSpacing: await page.locator('[data-preview-horizontal-layout="true"]').getAttribute("data-preview-spacing"),
  pianoOnlyLabeled: (await page.locator(".engraving-box").textContent())?.includes("钢琴双手系统（仅双行谱）") ?? false,
};
if (rhythmDefaults.enabled || rhythmDefaults.mode !== "auto" || rhythmDefaults.division !== "4" ||
    !rhythmDefaults.manualDivisionDisabled || rhythmDefaults.systemGap !== "1" ||
    rhythmDefaults.measuresPerSystem !== "4" || !rhythmDefaults.rhythmicSpacingEnabled ||
    rhythmDefaults.rhythmicSpacingExponent !== "0.65" || !rhythmDefaults.justifyLastSystem ||
    rhythmDefaults.previewMeasures !== "4" || rhythmDefaults.previewSpacing !== "rhythmic" ||
    !rhythmDefaults.pianoOnlyLabeled) {
  throw new Error("rhythm guide defaults or piano-only labels are incorrect");
}
await page.locator('input[name="measuresPerSystem"]').fill("2");
await page.waitForTimeout(220);
const twoMeasureLive = await page.evaluate(() => {
  const systems = window.__app.painter.layout.pages.flatMap((layoutPage) =>
    layoutPage.children.filter((child) => child.classes?.has("rhythmic-system")));
  return Math.max(...systems.map((system) => new Set(system.children
    .map((child) => child.data?.syncMeasure)
    .filter((value) => Number.isInteger(value) && value >= 0)).size));
});
if (twoMeasureLive > 2) throw new Error("target measures-per-system control did not reflow the live score");
await page.locator('input[name="measuresPerSystem"]').fill("4");
await page.waitForTimeout(220);
await page.locator('input[name="noteGapScale"]').evaluate((input) => {
  input.value = "1.35";
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.locator('input[name="systemGapScale"]').evaluate((input) => {
  input.value = "3";
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(180);
const expandedGapPages = await page.evaluate(() => window.__app.painter.layout.pages.length);
await page.locator('input[name="systemGapScale"]').evaluate((input) => {
  input.value = "0.35";
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.locator('input[name="rhythmGuideEnabled"]').check();
await page.waitForTimeout(100);
const autoPreviewMode = await page.locator('[data-preview-rhythm-guide="true"]').getAttribute("data-preview-rhythm-mode");
const autoPreviewDivision = await page.locator('[data-preview-rhythm-guide="true"]').getAttribute("data-preview-rhythm-division");
await page.locator('select[name="rhythmGuideMode"]').selectOption("manual");
await page.locator('select[name="rhythmGuideDivision"]').selectOption("32");
await page.waitForTimeout(180);
const previewRhythmGuide = await page.locator('[data-preview-rhythm-guide="true"]').count() === 1;
const previewRhythmMode = await page.locator('[data-preview-rhythm-guide="true"]').getAttribute("data-preview-rhythm-mode");
const previewRhythmDivision = await page.locator('[data-preview-rhythm-guide="true"]').getAttribute("data-preview-rhythm-division");
const previewNextSystem = await page.locator('[data-preview-next-system="true"]').count() === 1;
await page.getByRole("button", { name: "应用到整个软件" }).click();
await page.locator(".engraving-box").waitFor({ state: "detached" });
await page.waitForTimeout(600);
const rhythmGuideLayout = await page.evaluate(() => {
  const app = window.__app;
  let guideLines = 0, majorTicks = 0, minorTicks = 0;
  const alignments = [];
  const systemLinesByPage = app.painter.layout.pages.map((layoutPage) =>
    layoutPage.children.filter((child) => child.children.some((entry) => entry.classes?.has("entry"))));
  const systemGaps = systemLinesByPage.flatMap((lines) => lines.slice(1).map((line, index) =>
    line.y - (lines[index].y + lines[index].height)));
  for (const layoutPage of app.painter.layout.pages) {
    const ticks = [];
    const notes = [];
    const walk = (item) => {
      if (item.classes?.has("rhythm-guide-line")) guideLines++;
      if (item.classes?.has("rhythm-guide-major")) majorTicks++;
      if (item.classes?.has("rhythm-guide-minor")) minorTicks++;
      if (item.classes?.has("rhythm-guide-tick")) ticks.push(item.pos(layoutPage).x);
      const entry = item.data;
      if (item.classes?.has("entry") && entry?.number && entry.syncMeasure >= 0) {
        notes.push(entry.number.pos(layoutPage).x + entry.number.cx);
      }
      for (const child of item.children ?? []) walk(child);
    };
    walk(layoutPage);
    for (const noteX of notes) {
      if (ticks.length) alignments.push(Math.min(...ticks.map((tickX) => Math.abs(tickX - noteX))));
    }
  }
  const stored = JSON.parse(localStorage.getItem("jpeditor-render-settings") ?? "{}").engravingStyle;
  return {
    guideLines,
    majorTicks,
    minorTicks,
    maxNoteAlignmentError: alignments.length ? Math.max(...alignments) : -1,
    pages: systemLinesByPage.length,
    systemsPerPage: systemLinesByPage.map((lines) => lines.length),
    expectedSystemGap: app.painter.layout.options.systemGap(),
    maxSystemGapError: systemGaps.length
      ? Math.max(...systemGaps.map((gap) => Math.abs(gap - app.painter.layout.options.systemGap())))
      : -1,
    style: app.engravingStyle,
    stored,
  };
});
if (autoPreviewMode !== "auto" || autoPreviewDivision !== "16" || !previewRhythmGuide ||
    previewRhythmMode !== "manual" || previewRhythmDivision !== "32" ||
    !previewNextSystem || rhythmGuideLayout.guideLines < 1 || rhythmGuideLayout.majorTicks < 4 ||
    rhythmGuideLayout.minorTicks < 4 || rhythmGuideLayout.maxNoteAlignmentError < 0 ||
    rhythmGuideLayout.maxNoteAlignmentError > 0.6 || !rhythmGuideLayout.style.rhythmGuideEnabled ||
    rhythmGuideLayout.style.rhythmGuideMode !== "manual" || rhythmGuideLayout.style.rhythmGuideDivision !== 32 ||
    rhythmGuideLayout.style.noteGapScale !== 1.35 ||
    rhythmGuideLayout.style.systemGapScale !== 0.35 || expandedGapPages < fullExampleLayout.pages ||
    rhythmGuideLayout.style.measuresPerSystem !== 4 || !rhythmGuideLayout.style.rhythmicSpacingEnabled ||
    rhythmGuideLayout.style.rhythmicSpacingExponent !== 0.65 || !rhythmGuideLayout.style.justifyLastSystem ||
    rhythmGuideLayout.pages > expandedGapPages ||
    rhythmGuideLayout.maxSystemGapError < 0 || rhythmGuideLayout.maxSystemGapError > 0.1 ||
    !rhythmGuideLayout.stored?.rhythmGuideEnabled || rhythmGuideLayout.stored?.rhythmGuideMode !== "manual" ||
    rhythmGuideLayout.stored?.rhythmGuideDivision !== 32 || rhythmGuideLayout.stored?.systemGapScale !== 0.35 ||
    rhythmGuideLayout.stored?.measuresPerSystem !== 4 || !rhythmGuideLayout.stored?.rhythmicSpacingEnabled ||
    rhythmGuideLayout.stored?.rhythmicSpacingExponent !== 0.65 || !rhythmGuideLayout.stored?.justifyLastSystem) {
  throw new Error("rhythm guide rendering, alignment, preview, or persisted engraving settings failed");
}
const outGuide = process.argv[5] ?? "slashscore-rhythm-guide.png";
await page.locator("#score-pane").evaluate((pane) => { pane.scrollTop = 0; });
await page.screenshot({ path: outGuide, fullPage: false });

const continuousText = `数字谱
点=八分音符
1../2../3../4../5../6../7../1../
`;
await page.evaluate((text) => {
  void window.__app.importBytes(new TextEncoder().encode(text), "没有小节线的数字谱.txt");
}, continuousText);
await page.locator(".slash-import-box").waitFor();
const continuousDialog = {
  info: await page.locator(".slash-import-box .midi-import-info").textContent(),
  requiredMeter: await page.locator(".slash-import-box .modal-row", { hasText: "拍号（必填，用于分小节）" }).count() === 1,
};
await page.locator(".slash-import-box .modal-footer button", { hasText: "取消" }).click();

const midi = new Uint8Array(await readFile("dist/midi-import-fixture.mid"));
await page.evaluate((bytes) => {
  void window.__app.importBytes(new Uint8Array(bytes), "双手测试.mid");
}, Array.from(midi));
await page.locator(".midi-import-box").waitFor();
await page.locator(".midi-import-box .modal-row", { hasText: "导入后格式" }).locator("select").selectOption("number");
await page.getByRole("button", { name: "导入并转为简谱" }).click();
await page.locator(".midi-import-box").waitFor({ state: "detached" });
await page.waitForTimeout(600);
const midiNumber = await page.evaluate(() => ({
  format: window.__app.documentFormat,
  startsWithHeader: window.__app.getText().startsWith("数字谱"),
  piano: window.__app.painter.score.piano,
  parts: window.__app.painter.score.parts.length,
  sourceContainsMapping: window.__app.getText().includes("点="),
  sourceContainsStoredSettings: window.__app.getText().includes("// @jpeditor "),
  pages: document.querySelectorAll("#score-pane svg").length,
}));
if (midiNumber.format !== "number" || midiNumber.piano || midiNumber.parts !== 1 || !midiNumber.sourceContainsStoredSettings) {
  throw new Error("MIDI number output did not merge hands to one staff");
}
const outMidi = process.argv[3] ?? "slashscore-midi-number.png";
await page.locator("#btn-next").click();
await page.waitForTimeout(200);
await page.screenshot({ path: outMidi, fullPage: false });

const relevantErrors = errors.filter((error) => !/favicon/.test(error));
console.log(JSON.stringify({ createChoices, created, slashDialog, imported, intrinsicImport, fullExampleLayout, rhythmDefaults, twoMeasureLive, expandedGapPages, rhythmGuideLayout, continuousDialog, midiNumber, errors: relevantErrors }, null, 2));
if (relevantErrors.length) throw new Error(relevantErrors.join("\n"));

await browser.close();
server.close();
