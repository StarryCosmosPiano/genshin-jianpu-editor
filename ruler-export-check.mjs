// Run after npm run build. Actual saved bytes, pixel checks and virtual staff pages.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { installSavePickerTestBridge, launchSaveCheckBrowser } from "./browser-save-test-helpers.mjs";
import { unzipSync } from "fflate";

const root = join(process.cwd(), "dist");
const artifacts = join(process.cwd(), "artifacts", "ruler-export-20261012");
await mkdir(artifacts, { recursive: true });
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2" };
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    res.end(await readFile(join(root, normalize(file))));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await launchSaveCheckBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const savedFiles = await installSavePickerTestBridge(page);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const guideSelector = ".rhythm-guide-line,.rhythm-guide-tick,.staff-rhythm-guide";
const fixture = (bars = 2) => `.Title\nTitle = {刻度导出回归}\nInstrument = {钢琴}\nKeyAndMeters = {1=C,4/4}\n.Voice.RH\n${Array.from({ length: bars }, () => "1 2 3 4").join(" | ")} |]\n.Voice.LH\n${Array.from({ length: bars }, () => "5, 6, 7, 1").join(" | ")} |]\n`;

async function install(surface, bars = 2) {
  await page.locator("#staff-view-select").selectOption("jianpu");
  await page.evaluate((text) => {
    const app = window.__app;
    if (app.inputModeEnabled) app.setInputMode(false);
    app.documentFormat = "jpw"; app.slashOptions = null; app.setText(text);
    app.setCodePaneCollapsed(true);
    app.setEngravingStyle({ ...app.engravingStyle, rhythmGuideEnabled: true,
      rhythmGuideMode: "manual", rhythmGuideDivision: 16 }, false);
  }, fixture(bars));
  if (surface === "staff") {
    await page.locator("#staff-view-select").selectOption("staff");
    await page.waitForFunction(() => document.querySelector("#staff-pages svg")
      && document.getElementById("staff-pane").getAttribute("aria-busy") === "false");
  }
}

async function openExport(label) {
  await page.locator("#btn-export").click();
  await page.locator(".modal-box button", { hasText: label }).click();
  await page.locator(".watermark-dialog").waitFor();
  const ruler = page.getByLabel("导出刻度线", { exact: true });
  assert.equal(await ruler.isChecked(), false, "every new export dialog must default rulers off");
  await page.getByLabel("添加水印", { exact: true }).uncheck();
  if (await page.getByLabel("透明背景", { exact: true }).count()) await page.getByLabel("透明背景", { exact: true }).uncheck();
  assert.equal(await page.locator(`.watermark-preview ${guideSelector.split(",").join(",.watermark-preview ")}`).count(), 0);
  return ruler;
}

async function downloadExport(enabled, basename) {
  await page.getByLabel("导出刻度线", { exact: true }).setChecked(enabled);
  const event = savedFiles.nextExport();
  await page.locator(".watermark-dialog footer button.primary").click();
  const download = await event;
  const bytes = await readFile(await download.path());
  await writeFile(join(artifacts, basename), bytes);
  return bytes;
}

async function guideSamples() {
  return page.locator(".watermark-preview svg").evaluate((svg) => {
    const inverse = svg.getScreenCTM().inverse();
    const vb = svg.viewBox.baseVal;
    const lines = [...svg.querySelectorAll(".rhythm-guide-line,.rhythm-guide-tick,.staff-rhythm-guide line")];
    return lines.flatMap((element) => {
      const bounds = element.getBoundingClientRect();
      if (!bounds.width && !bounds.height) return [];
      // Several points across long baselines and central tick points expose
      // actual ruler ink, while leaving notation above the ruler untouched.
      const fractions = bounds.width > bounds.height * 5 ? [0.15, 0.35, 0.55, 0.75, 0.9] : [0.5];
      return fractions.map((fraction) => {
        const point = new DOMPoint(bounds.left + bounds.width * fraction,
          bounds.top + bounds.height / 2).matrixTransform(inverse);
        return [(point.x - vb.x) / vb.width, (point.y - vb.y) / vb.height];
      });
    });
  });
}

function pdfJpegs(bytes) {
  const text = bytes.toString("latin1");
  const images = [];
  const expression = /\/Subtype \/Image[^]*?\/Length (\d+) >>\nstream\n/g;
  for (let match; (match = expression.exec(text));) {
    const start = expression.lastIndex;
    images.push(bytes.subarray(start, start + Number(match[1])));
    expression.lastIndex = start + Number(match[1]);
  }
  assert(images.length, "raster PDF has no JPEG page streams");
  return images;
}

async function comparePixels(plain, ruled, samples, type) {
  const result = await page.evaluate(async ({ plain, ruled, samples, type }) => {
    const decode = async (bytes) => {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject;
        image.src = `data:${type};base64,${bytes}`; });
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data };
    };
    const off = await decode(plain), on = await decode(ruled);
    let changed = 0, addedInk = 0;
    for (const [nx, ny] of samples) {
      const cx = Math.round(nx * on.width), cy = Math.round(ny * on.height);
      for (let y = Math.max(0, cy - 2); y <= Math.min(on.height - 1, cy + 2); y++)
        for (let x = Math.max(0, cx - 2); x <= Math.min(on.width - 1, cx + 2); x++) {
          const index = (y * on.width + x) * 4;
          const offInk = (off.data[index] + off.data[index + 1] + off.data[index + 2]) / 3;
          const onInk = (on.data[index] + on.data[index + 1] + on.data[index + 2]) / 3;
          if (Math.abs(offInk - onInk) > 12) changed++;
          if (offInk > 235 && onInk < 210) addedInk++;
        }
    }
    return { sameSize: off.width === on.width && off.height === on.height, changed, addedInk };
  }, { plain: plain.toString("base64"), ruled: ruled.toString("base64"), samples, type });
  assert(result.sameSize);
  assert(result.changed > 20 && result.addedInk > 10, `ruler option did not change guide pixels: ${JSON.stringify(result)}`);
}

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  for (const surface of ["jianpu", "staff"]) {
    await install(surface);
    const onScreen = await page.evaluate((surface) => document.querySelector(surface === "staff" ? "#staff-pages" : "#score-pane").innerHTML, surface);
    await openExport("PNG（全部页面）");
    const plainPng = await downloadExport(false, `${surface}-plain.png`);
    await openExport("PNG（全部页面）");
    await page.getByLabel("导出刻度线", { exact: true }).check();
    const samples = await guideSamples();
    assert(samples.length > 10, `${surface} source did not supply exportable ruler geometry`);
    const ruledPng = await downloadExport(true, `${surface}-rulers.png`);
    await comparePixels(plainPng, ruledPng, samples, "image/png");
    await openExport("PDF（全部页面）");
    const plainPdf = await downloadExport(false, `${surface}-plain.pdf`);
    await openExport("PDF（全部页面）");
    const ruledPdf = await downloadExport(true, `${surface}-rulers.pdf`);
    await comparePixels(pdfJpegs(plainPdf)[0], pdfJpegs(ruledPdf)[0], samples, "image/jpeg");
    assert.equal(await page.evaluate((surface) => document.querySelector(surface === "staff" ? "#staff-pages" : "#score-pane").innerHTML, surface), onScreen,
      "export modified the onscreen notation/rulers");
  }

  // PPTX vector traversal uses the same option, retaining watermarks.
  await install("jianpu");
  await openExport("PPTX（矢量）");
  const plainPptx = unzipSync(await downloadExport(false, "plain.pptx"));
  await openExport("PPTX（矢量）");
  await page.getByLabel("添加水印", { exact: true }).check();
  await page.getByLabel("水印文字", { exact: true }).fill("刻度水印");
  const ruledPptx = unzipSync(await downloadExport(true, "rulers.pptx"));
  const plainSlide = new TextDecoder().decode(plainPptx["ppt/slides/slide1.xml"]);
  const ruledSlide = new TextDecoder().decode(ruledPptx["ppt/slides/slide1.xml"]);
  assert(ruledSlide.includes("刻度水印"), "PPTX ruler option removed the watermark");
  assert((ruledSlide.match(/<p:sp>/g) ?? []).length > (plainSlide.match(/<p:sp>/g) ?? []).length + 20,
    "PPTX did not retain optional ruler shapes");

  // Full export sources regenerate virtualized staff pages, not just mounted
  // SVGs. Every PNG in the ZIP keeps the opted-in ruler geometry.
  await install("staff", 80);
  const virtual = await page.evaluate(async () => {
    const app = window.__app;
    const source = await app.getPageExportSource({ includeRhythmGuides: true });
    return { total: source.pages.length, mounted: document.querySelectorAll("#staff-pages svg").length,
      guides: source.pages.map(({ svg }) => svg.querySelectorAll(".staff-rhythm-guide").length) };
  });
  assert(virtual.total > virtual.mounted, `fixture failed to exercise virtual pages: ${JSON.stringify(virtual)}`);
  assert(virtual.guides.every((count) => count > 0), "virtual page source lost its rulers");
  await openExport("PNG（全部页面）");
  assert(await page.getByLabel("压缩为 ZIP 文件", { exact: true }).isChecked());
  await page.getByLabel("导出刻度线", { exact: true }).check();
  for (let index = 1; index < virtual.total; index++) await page.getByRole("button", { name: "下一页", exact: true }).click();
  const lastSamples = await guideSamples();
  const ruledZip = unzipSync(await downloadExport(true, "virtual-rulers.zip"));
  await openExport("PNG（全部页面）");
  const plainZip = unzipSync(await downloadExport(false, "virtual-plain.zip"));
  const names = Object.keys(ruledZip).filter((name) => name.endsWith(".png")).sort((a, b) =>
    Number(a.match(/第(\d+)页/)[1]) - Number(b.match(/第(\d+)页/)[1]));
  assert.equal(names.length, virtual.total);
  await comparePixels(Buffer.from(plainZip[names.at(-1)]), Buffer.from(ruledZip[names.at(-1)]), lastSamples, "image/png");
  savedFiles.assertNoDownloads();
  assert.deepEqual(errors, []);
  console.log("ruler-export-check: ok (default off, PNG/PDF pixels, PPTX/watermark, ZIP virtual pages, screen unchanged)");
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
