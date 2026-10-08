// End-to-end regression for paper-content scaling. Run after npm run build.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";
import { unzipSync } from "fflate";

const root = join(process.cwd(), "dist");
const fixture = await readFile(join(process.cwd(), "examples", "piano-demo.jpwabc"), "utf8");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2" };
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (path === "/") path = "/index.html";
    const data = await readFile(join(root, normalize(path)));
    res.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const artifacts = join(process.cwd(), "artifacts", "content-scale-20261007");
await mkdir(artifacts, { recursive: true });

const installFixture = async () => {
  await page.waitForFunction(() => !!window.__app?.painter);
  await page.locator("#score-pane svg.score-page").first().waitFor();
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
  }, fixture);
  await page.waitForFunction(() => document.querySelector("#score-pane .publication-title text")
    && [...document.querySelectorAll("#score-pane g.entry text")].some((item) => item.textContent?.trim() === "双"));
};

const approxRatio = (actual, expected, label, tolerance = 0.12) =>
  assert.ok(Math.abs(actual - expected) <= tolerance * expected,
    `${label}: expected ratio ${expected}, got ${actual}`);

const scoreMetrics = () => page.evaluate(() => {
  const svg = document.querySelector("#score-pane svg.score-page");
  if (!svg) throw new Error("missing score SVG");
  const exact = (value) => [...svg.querySelectorAll("text")].find((item) => item.textContent?.trim() === value);
  const title = exact("钢琴双手简谱示例");
  const instrument = exact("钢琴");
  const note = [...svg.querySelectorAll("g.entry text")].find((item) => item.textContent?.trim() === "1");
  const lyric = exact("双");
  if (!title || !instrument || !note || !lyric) {
    throw new Error(`missing real score content: ${JSON.stringify({ title: !!title, instrument: !!instrument, note: !!note, lyric: !!lyric })}`);
  }
  const font = (element) => Number(element.getAttribute("font-size"));
  const vb = svg.viewBox.baseVal;
  const app = window.__app;
  return {
    contentScale: app.painter.layout.options.engravingStyle.contentScale,
    savedScale: app.engravingStyle.contentScale,
    paper: [vb.width, vb.height],
    pageSettings: [app.pageW, app.pageH],
    fonts: { title: font(title), instrument: font(instrument), note: font(note), lyric: font(lyric) },
    zoom: app.zoom,
    zoomCss: app.scorePane.style.getPropertyValue("--score-zoom"),
    previewXml: svg.outerHTML,
  };
});

const staffMetrics = async () => {
  await page.waitForFunction(() => window.__app.getActiveScoreSurface() === "staff"
    && document.getElementById("staff-pane")?.getAttribute("aria-busy") === "false"
    && !!document.querySelector("#staff-pages svg"));
  return page.evaluate(async () => {
    const app = window.__app;
    const source = await app.getPageExportSource();
    const svg = source.pages[0]?.svg;
    const title = [...svg.querySelectorAll("text")].find((item) => item.textContent?.trim() === "钢琴双手简谱示例");
    const glyph = document.querySelector("#staff-pages svg [data-staff-glyph]");
    if (!title || !glyph) throw new Error("staff title or note glyph missing");
    const vb = svg.viewBox.baseVal;
    return {
      surface: source.surface,
      pages: source.pages.length,
      paper: [vb.width, vb.height],
      pdfPoints: [source.pages[0].widthPt, source.pages[0].heightPt],
      titleFont: Number(title.getAttribute("font-size")),
      noteWidth: glyph.getBoundingClientRect().width,
      zoom: app.workspaceSummary().zoom,
      jianpuZoom: app.zoom,
    };
  });
};

/** Click the ink center of the same first right-hand source note at each scale. */
const pickOpeningNote = async () => {
  const point = await page.evaluate(() => {
    const app = window.__app;
    app.deselect(false);
    const source = app._sourceNotes.find((item) => item.partIndex === 0
      && item.chord.measure.index === 0 && item.chord.position.toString() === "0" && !item.note.rest);
    if (!source) throw new Error("opening right-hand note missing");
    const rendered = app.painter.noteGroupEls(source.chord, source.note)[0];
    if (!rendered) throw new Error("opening right-hand note not rendered");
    rendered.element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const item = app.painter.pageItemForTarget(rendered.element);
    const bound = item.bound;
    const matrix = rendered.element.getScreenCTM();
    const point = new DOMPoint((bound.left + bound.right) / 2,
      (bound.top + bound.bottom) / 2).matrixTransform(matrix);
    return { x: point.x, y: point.y,
      expected: { part: source.partIndex, from: source.from, to: source.to, pitch: source.note.pitch } };
  });
  await page.mouse.click(point.x, point.y);
  const selected = await page.evaluate(() => {
    const app = window.__app;
    const note = app._selectedNotes.at(-1);
    return note ? { part: note.source.partIndex, from: note.source.from,
      to: note.source.to, pitch: note.visualNote.pitch } : null;
  });
  assert.deepEqual(selected, point.expected, `visible note click missed at contentScale: ${JSON.stringify(point)}`);
  return selected;
};

const openEngraving = async () => {
  await page.locator("#btn-layout-style").click();
  const inspector = page.locator('#inspector-pane[data-inspector-id="layout"]');
  await inspector.waitFor();
  const section = inspector.locator('input[name="contentScale"]').locator("xpath=ancestor::details[1]");
  if (await section.getAttribute("open") === null) await section.locator("summary").click();
  const slider = inspector.locator('input[name="contentScale"]');
  assert.equal(await slider.getAttribute("aria-label"), "整体内容缩放");
  return { inspector, slider };
};

const setDraftScale = async (slider, value) => {
  await slider.fill(String(value));
  await page.waitForFunction((expected) =>
    Math.abs(window.__app.painter.layout.options.engravingStyle.contentScale - expected) < 1e-8,
  value);
  const preview = await page.locator("#layout-preview-pane svg[data-preview-source='actual-layout']").count();
  assert.ok(preview > 0, "slider should update the actual layout sample");
  return scoreMetrics();
};

const openPageExport = async (name) => {
  await page.locator("#btn-export").click();
  await page.locator(".modal-box button", { hasText: name }).click();
  const dialog = page.locator(".watermark-dialog");
  await dialog.waitFor();
  const watermark = dialog.locator(".watermark-controls input[type=checkbox]").first();
  if (await watermark.isChecked()) await watermark.uncheck();
  const zip = dialog.locator(".watermark-controls label", { hasText: "ZIP" }).locator("input");
  if (await zip.count()) await zip.check();
  return dialog;
};

const download = async (name) => {
  const dialog = await openPageExport(name);
  const pending = page.waitForEvent("download");
  await dialog.locator("footer button.primary").click();
  const file = await pending;
  return { filename: file.suggestedFilename(), bytes: await readFile(await file.path()) };
};

const pngPage = ({ filename, bytes }) => {
  const png = filename.endsWith(".zip")
    ? Object.entries(unzipSync(bytes)).find(([name]) => name.endsWith(".png"))?.[1]
    : bytes;
  assert.ok(png, "PNG export contains a page");
  const data = Buffer.from(png);
  assert.equal(data.subarray(1, 4).toString("ascii"), "PNG");
  return { size: [data.readUInt32BE(16), data.readUInt32BE(20)], data };
};

const pdfPaper = ({ filename, bytes }) => {
  assert.ok(filename.endsWith(".pdf"));
  const text = bytes.toString("latin1");
  const box = text.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
  assert.ok(box, "PDF page MediaBox");
  return [Number(box[1]), Number(box[2])];
};

const pptxPage = ({ filename, bytes }) => {
  assert.ok(filename.endsWith(".pptx"));
  const files = unzipSync(bytes);
  const presentation = Buffer.from(files["ppt/presentation.xml"]).toString("utf8");
  const slide = Buffer.from(files["ppt/slides/slide1.xml"]).toString("utf8");
  const box = presentation.match(/<p:sldSz cx="(\d+)" cy="(\d+)"\/>/);
  assert.ok(box, "PPTX slide size");
  const titleOffset = slide.indexOf("<a:t>钢琴双手简谱示例</a:t>");
  assert.ok(titleOffset > 0, "PPTX title text");
  const sizes = [...slide.slice(0, titleOffset).matchAll(/<a:rPr[^>]*\bsz="(\d+)"/g)];
  assert.ok(sizes.length, "PPTX title font size");
  return { size: [Number(box[1]), Number(box[2])], titleFont: Number(sizes.at(-1)[1]), slide };
};

try {
  await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: "networkidle" });
  await installFixture();
  await page.evaluate(() => window.__app.setZoom(1.37));
  const baseline = await scoreMetrics();
  assert.equal(baseline.savedScale, 1, "new setting defaults to 100%");
  assert.deepEqual(baseline.paper, [595, 842]);
  const { inspector, slider } = await openEngraving();
  assert.equal(await slider.inputValue(), "1");
  assert.equal((await slider.locator("xpath=..").locator("output").textContent())?.trim(), "100%");
  const half = await setDraftScale(slider, 0.5);
  assert.equal((await slider.locator("xpath=..").locator("output").textContent())?.trim(), "50%");
  assert.equal(half.savedScale, 1, "draft may not overwrite saved style");
  assert.deepEqual(half.paper, baseline.paper);
  for (const key of Object.keys(baseline.fonts)) approxRatio(half.fonts[key] / baseline.fonts[key], 0.5, `${key} half`);
  const enlarged = await setDraftScale(slider, 1.5);
  assert.equal((await slider.locator("xpath=..").locator("output").textContent())?.trim(), "150%");
  assert.equal(enlarged.savedScale, 1);
  assert.deepEqual(enlarged.paper, baseline.paper);
  for (const key of Object.keys(baseline.fonts)) approxRatio(enlarged.fonts[key] / baseline.fonts[key], 1.5, `${key} enlarged`);
  assert.equal(enlarged.zoom, baseline.zoom);
  assert.equal(enlarged.zoomCss, baseline.zoomCss);
  assert.notEqual(half.previewXml, enlarged.previewXml);
  await inspector.screenshot({ path: join(artifacts, "layout-content-scale-slider.png") });
  await inspector.locator(".inspector-footer").getByRole("button", { name: "取消" }).click();
  await page.waitForFunction(() => document.getElementById("inspector-pane").hidden
    && window.__app.painter.layout.options.engravingStyle.contentScale === 1);
  const cancelled = await scoreMetrics();
  assert.equal(cancelled.savedScale, 1);
  for (const key of Object.keys(baseline.fonts)) approxRatio(cancelled.fonts[key] / baseline.fonts[key], 1, `${key} cancelled`, 0.02);
  await page.locator("#score-pane").screenshot({ path: join(artifacts, "jianpu-content-100.png") });

  const normalPng = pngPage(await download("PNG（全部页面）"));
  const normalPdf = await download("PDF（全部页面）");
  const normalPptx = pptxPage(await download("PPTX（矢量）"));
  assert.deepEqual(normalPng.size, [1190, 1684]);
  assert.deepEqual(pdfPaper(normalPdf), baseline.paper);

  await page.locator("#staff-view-select").selectOption("compare");
  await page.locator("#staff-view-select").selectOption("staff");
  const normalStaff = await staffMetrics();
  assert.equal(normalStaff.surface, "staff");
  assert.ok(normalStaff.pages > 0);
  const normalStaffPng = pngPage(await download("PNG（全部页面）"));
  const normalStaffPdf = await download("PDF（全部页面）");
  await page.locator("#staff-view-select").selectOption("jianpu");

  const halfApply = await openEngraving();
  await setDraftScale(halfApply.slider, 0.5);
  await halfApply.inspector.getByRole("button", { name: "应用到全部简谱" }).click();
  await page.waitForFunction(() => window.__app.engravingStyle.contentScale === 0.5);
  assert.equal((await scoreMetrics()).zoom, baseline.zoom);
  const halfPicked = await pickOpeningNote();

  const apply = await openEngraving();
  await setDraftScale(apply.slider, 1.5);
  await apply.inspector.getByRole("button", { name: "应用到全部简谱" }).click();
  await page.waitForFunction(() => window.__app.engravingStyle.contentScale === 1.5);
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("jpeditor-render-settings") ?? "null")?.engravingStyle?.contentScale);
  assert.equal(persisted, 1.5);
  const applied = await scoreMetrics();
  assert.deepEqual(applied.paper, baseline.paper);
  for (const key of Object.keys(baseline.fonts)) approxRatio(applied.fonts[key] / baseline.fonts[key], 1.5, `${key} applied`);
  assert.equal(applied.zoom, baseline.zoom);
  const enlargedPicked = await pickOpeningNote();
  assert.deepEqual(enlargedPicked, halfPicked, "50% and 150% must select the same note/source");
  await page.locator("#score-pane").screenshot({ path: join(artifacts, "jianpu-content-150.png") });

  await page.reload({ waitUntil: "networkidle" });
  await installFixture();
  const reloaded = await scoreMetrics();
  assert.equal(reloaded.savedScale, 1.5);
  assert.equal(reloaded.contentScale, 1.5);
  assert.deepEqual(reloaded.paper, baseline.paper);
  for (const key of Object.keys(baseline.fonts)) approxRatio(reloaded.fonts[key] / baseline.fonts[key], 1.5, `${key} reloaded`);
  assert.equal(reloaded.zoom, baseline.zoom, "paper scale must not reset screen zoom");

  const scaledPng = pngPage(await download("PNG（全部页面）"));
  const scaledPdf = await download("PDF（全部页面）");
  const scaledPptx = pptxPage(await download("PPTX（矢量）"));
  assert.deepEqual(scaledPng.size, normalPng.size);
  assert.notDeepEqual(scaledPng.data, normalPng.data, "PNG pixels must change with paper content scale");
  assert.deepEqual(pdfPaper(scaledPdf), pdfPaper(normalPdf));
  assert.notDeepEqual(scaledPdf.bytes, normalPdf.bytes, "PDF page image must change");
  assert.deepEqual(scaledPptx.size, normalPptx.size);
  approxRatio(scaledPptx.titleFont / normalPptx.titleFont, 1.5, "PPTX title font", 0.02);
  assert.notEqual(scaledPptx.slide, normalPptx.slide);

  await page.locator("#staff-view-select").selectOption("compare");
  await page.locator("#staff-view-select").selectOption("staff");
  const enlargedStaff = await staffMetrics();
  assert.deepEqual(enlargedStaff.paper, normalStaff.paper);
  assert.deepEqual(enlargedStaff.pdfPoints, normalStaff.pdfPoints);
  approxRatio(enlargedStaff.titleFont / normalStaff.titleFont, 1.5, "staff title font", 0.02);
  assert.ok(enlargedStaff.noteWidth > normalStaff.noteWidth * 1.1,
    `staff music glyph should enlarge: ${normalStaff.noteWidth} -> ${enlargedStaff.noteWidth}`);
  assert.equal(enlargedStaff.jianpuZoom, baseline.zoom);
  await page.locator("#staff-pane").screenshot({ path: join(artifacts, "staff-content-150.png") });
  const scaledStaffPng = pngPage(await download("PNG（全部页面）"));
  const scaledStaffPdf = await download("PDF（全部页面）");
  assert.deepEqual(scaledStaffPng.size, normalStaffPng.size);
  assert.notDeepEqual(scaledStaffPng.data, normalStaffPng.data);
  assert.deepEqual(pdfPaper(scaledStaffPdf), pdfPaper(normalStaffPdf));
  assert.notDeepEqual(scaledStaffPdf.bytes, normalStaffPdf.bytes);
  assert.deepEqual(errors, []);
  console.log("content-scale: draft 50/150%, cancel, persistence, same-source note picking at 137% screen zoom, A4 PNG/PDF/PPTX, and staff export passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
