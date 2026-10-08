// Browser regression for real-page watermark preview and downloaded PNG/PDF.
// Run after npm run build: node watermark-export-check.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";
import { unzipSync } from "fflate";

const root = join(process.cwd(), "dist");
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.locator("#score-pane svg.score-page").first().waitFor();
  const sourceBefore = await page.locator("#score-pane svg.score-page").first().evaluate((svg) => svg.outerHTML);
  const openExport = async (label) => {
    await page.locator("#btn-export").click();
    await page.locator(".modal-box button", { hasText: label }).click();
    await page.locator(".watermark-dialog").waitFor();
  };
  const marked = async (text = "原琴助手") => {
    const controls = page.locator(".watermark-controls");
    await controls.locator("input[type=checkbox]").first().check();
    await controls.locator("input[type=text]").fill(text);
    const state = await page.locator(".watermark-preview svg").evaluate((svg) => {
      const marks = [...svg.querySelectorAll("g.export-watermark text")];
      const box = svg.viewBox.baseVal;
      return {
        count: marks.length,
        opacity: svg.querySelector("g.export-watermark")?.getAttribute("fill-opacity"),
        central: [Number(marks[0]?.getAttribute("x")), Number(marks[0]?.getAttribute("y"))],
        middle: [box.x + box.width / 2, box.y + box.height / 2],
        text: marks[0]?.textContent,
        xml: new XMLSerializer().serializeToString(svg),
        notation: svg.querySelectorAll("g:not(.export-watermark) text,g:not(.export-watermark) path").length,
        centerFits: (() => {
          const rect = marks[0]?.getBoundingClientRect();
          const page = svg.getBoundingClientRect();
          return !!rect && rect.left >= page.left && rect.right <= page.right && rect.top >= page.top && rect.bottom <= page.bottom;
        })(),
      };
    });
    assert.equal(state.count, 7);
    assert.equal(state.opacity, "0.1");
    assert.deepEqual(state.central, state.middle);
    assert.ok(state.centerFits, "the central watermark must remain fully on the page");
    assert.equal(state.text, text);
    assert.ok(state.notation > 0, "preview must contain the actual score page");
    return state;
  };

  await openExport("PNG（全部页面）");
  assert.equal(await page.locator(".watermark-controls input[type=range]").first().inputValue(), "10");
  assert.equal(await page.locator(".watermark-controls input[type=range]").nth(1).inputValue(), "7");
  const shotRoot = join(process.cwd(), "artifacts", "engraving-watermark-20261007");
  await mkdir(shotRoot, { recursive: true });
  const previewShot = join(shotRoot, "jianpu-watermark-preview.png");
  await page.locator(".watermark-controls input[type=checkbox]").first().check();
  await page.locator(".watermark-controls label", { hasText: "透明背景" }).locator("input").uncheck();
  await page.locator(".watermark-dialog").screenshot({ path: previewShot });
  await page.locator(".watermark-controls input[type=checkbox]").first().uncheck();
  await page.locator(".watermark-controls label", { hasText: "透明背景" }).locator("input").check();
  const zip = page.locator(".watermark-controls label", { hasText: "ZIP" }).locator("input");
  if (await zip.count()) await zip.uncheck();
  const plainPngEvent = page.waitForEvent("download");
  await page.locator(".watermark-dialog footer button.primary").click();
  const plainPng = await plainPngEvent;
  const plainPngBytes = await readFile(await plainPng.path());

  await openExport("PNG（全部页面）");
  const escaped = await marked("<&水印>");
  assert.ok(escaped.xml.includes("&lt;&amp;水印&gt;"));
  await page.locator(".watermark-controls input[type=range]").nth(1).fill("9");
  assert.equal(await page.locator(".watermark-preview .export-watermark text").count(), 9);
  await page.locator(".watermark-controls input[type=range]").nth(1).fill("7");
  await page.locator(".watermark-controls input[type=range]").first().fill("23");
  assert.equal(await page.locator(".watermark-preview .export-watermark").getAttribute("fill-opacity"), "0.23");
  await page.locator(".watermark-controls input[type=range]").first().fill("100");
  assert.equal(await page.locator(".watermark-preview .export-watermark").getAttribute("fill-opacity"), "1");
  await page.locator(".watermark-controls input[type=range]").first().fill("10");
  assert.equal(await page.locator("#score-pane svg.score-page").first().evaluate((svg) => svg.outerHTML), sourceBefore);
  if (await zip.count()) await zip.uncheck();
  const pngDownload = page.waitForEvent("download");
  await page.locator(".watermark-dialog footer button.primary").click();
  const png = await pngDownload;
  const pngBytes = await readFile(await png.path());
  assert.equal(pngBytes.subarray(1, 4).toString("ascii"), "PNG");
  assert.ok(pngBytes.length > 5000);
  assert.notDeepEqual(pngBytes, plainPngBytes, "watermark must change the actual PNG pixels");

  await openExport("PDF（全部页面）");
  await page.locator(".watermark-controls input[type=checkbox]").first().uncheck();
  const plainPdfEvent = page.waitForEvent("download");
  await page.locator(".watermark-dialog footer button.primary").click();
  const plainPdf = await plainPdfEvent;
  const plainPdfBytes = await readFile(await plainPdf.path());
  await openExport("PDF（全部页面）");
  await marked("<&水印>");
  const pdfDownload = page.waitForEvent("download");
  await page.locator(".watermark-dialog footer button.primary").click();
  const pdf = await pdfDownload;
  const pdfBytes = await readFile(await pdf.path());
  assert.equal(pdfBytes.subarray(0, 4).toString("ascii"), "%PDF");
  assert.ok(pdfBytes.includes(Buffer.from("/Subtype /Image")), "PDF should contain rasterized page image");
  assert.ok(pdfBytes.length > 10000);
  assert.notDeepEqual(pdfBytes, plainPdfBytes, "watermark must change the rasterized PDF page");
  await openExport("PPTX（矢量）");
  await marked("<&水印>");
  const pptxEvent = page.waitForEvent("download");
  await page.locator(".watermark-dialog footer button.primary").click();
  const pptx = await pptxEvent;
  const pptxBytes = await readFile(await pptx.path());
  const slide = Buffer.from(unzipSync(pptxBytes)["ppt/slides/slide1.xml"]).toString("utf8");
  assert.equal((slide.match(/<a:alpha val="10000"\/>/g) ?? []).length, 7);
  assert.ok(slide.includes("&lt;&amp;水印&gt;"));
  assert.equal(await page.locator("#score-pane svg.score-page").first().evaluate((svg) => svg.outerHTML), sourceBefore);

  // Switch to the read-only staff surface; its offscreen pages must be exported too.
  await page.locator("#staff-view-select").selectOption("compare");
  await page.locator("#staff-view-select").selectOption("staff");
  await page.waitForFunction(() => window.__app.getActiveScoreSurface() === "staff"
    && document.getElementById("staff-pane")?.getAttribute("aria-busy") === "false", undefined, { timeout: 30000 });
  const staff = await page.evaluate(async () => {
    const source = await window.__app.getPageExportSource();
    return {
      surface: source.surface,
      count: source.pages.length,
      currentPage: source.currentPage,
      background: source.pages[0]?.svg.firstElementChild?.getAttribute("fill"),
      size: [source.pages[0]?.widthPt, source.pages[0]?.heightPt],
    };
  });
  assert.equal(staff.surface, "staff");
  assert.ok(staff.count >= 1);
  assert.equal(staff.background, "white");
  assert.ok(staff.size[0] > 590 && staff.size[0] < 600, "staff PDF width should be A4 points");
  await openExport("PNG（全部页面）");
  await marked("五线谱水印");
  const backgroundOption = page.locator(".watermark-controls label", { hasText: "透明背景" }).locator("input");
  assert.equal(await page.locator(".watermark-preview svg").evaluate((svg) => svg.firstElementChild?.classList.contains("export-watermark")), true,
    "transparent staff preview must remove the white page rect");
  await backgroundOption.uncheck();
  const staffPreview = await page.locator(".watermark-preview svg").evaluate((svg) => {
    const children = [...svg.children];
    return [children[0]?.tagName, children[1]?.classList.contains("export-watermark")];
  });
  assert.deepEqual(staffPreview, ["rect", true], "opaque staff watermark must paint above its white background");
  await page.locator(".watermark-controls input[type=text]").fill("原琴助手");
  const staffShot = join(shotRoot, "staff-watermark-preview.png");
  await page.locator(".watermark-dialog").screenshot({ path: staffShot });
  await page.locator(".watermark-controls input[type=text]").fill("五线谱水印");
  await backgroundOption.check();
  await page.locator(".watermark-controls input[type=range]").first().fill("42");
  await page.locator(".watermark-dialog footer button", { hasText: "取消" }).click();
  await openExport("PNG（全部页面）");
  assert.equal(await page.locator(".watermark-controls input[type=range]").first().inputValue(), "10",
    "cancel must not persist draft settings");
  await marked("五线谱水印");
  const staffPngEvent = page.waitForEvent("download");
  await page.locator(".watermark-dialog footer button.primary").click();
  const staffPng = await staffPngEvent;
  const staffPngBytes = await readFile(await staffPng.path());
  let staffPngPage = staffPngBytes;
  if (staff.count > 1) {
    const unzipped = unzipSync(staffPngBytes);
    const entries = Object.keys(unzipped).filter((name) => name.endsWith(".png"));
    assert.equal(entries.length, staff.count, "ZIP must include every virtual staff page");
    staffPngPage = Buffer.from(unzipped[entries[0]]);
  } else assert.equal(staffPngBytes.subarray(1, 4).toString("ascii"), "PNG");
  const cornerAlpha = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, 1, 1).data[3];
  }, staffPngPage.toString("base64"));
  assert.equal(cornerAlpha, 0, "transparent staff PNG must have a transparent page corner");
  await writeFile(join(shotRoot, "staff-export.png"), staffPngPage);
  await openExport("PDF（全部页面）");
  const staffPdfEvent = page.waitForEvent("download");
  await page.locator(".watermark-dialog footer button.primary").click();
  const staffPdf = await staffPdfEvent;
  const staffPdfBytes = await readFile(await staffPdf.path());
  assert.equal(staffPdfBytes.subarray(0, 4).toString("ascii"), "%PDF");
  assert.ok(staffPdfBytes.includes(Buffer.from(`/Count ${staff.count}`)), "PDF must include every virtual staff page");
  const physicalSize = staff.size.map(value => Math.round(value * 1000) / 1000);
  assert.ok(staffPdfBytes.includes(Buffer.from(`/MediaBox [0 0 ${physicalSize[0]} ${physicalSize[1]}]`)),
    "downloaded staff PDF must preserve A4 physical page dimensions");
  const imageAt = staffPdfBytes.indexOf(Buffer.from("/Subtype /Image"));
  const streamAt = staffPdfBytes.indexOf(Buffer.from("stream\n"), imageAt) + 7;
  const jpegLength = Number(/\/Length (\d+)/.exec(staffPdfBytes.subarray(imageAt, streamAt).toString("ascii"))?.[1]);
  assert.ok(jpegLength > 0);
  await writeFile(join(shotRoot, "staff-pdf-first-page.jpg"), staffPdfBytes.subarray(streamAt, streamAt + jpegLength));
  assert.deepEqual(errors, []);
  console.log("watermark export: preview, escape, density, source isolation, PNG, PDF, PPTX and staff pages passed");
  console.log(`screenshots: ${previewShot}; ${staffShot}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
