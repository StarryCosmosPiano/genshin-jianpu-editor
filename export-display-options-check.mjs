// Run after npm run build; only the OS save picker is replaced.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { unzipSync } from "fflate";
import { installSavePickerTestBridge, launchSaveCheckBrowser } from "./browser-save-test-helpers.mjs";

const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2" };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = join(process.cwd(), "dist", normalize(path === "/" ? "/index.html" : path));
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, resolve));
const browser = await launchSaveCheckBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const saved = await installSavePickerTestBridge(page);
const errors = [];
const results = [];
page.on("pageerror", error => errors.push(error.message));
const output = join(process.cwd(), "artifacts/export-staff-style-20261018");
await mkdir(output, { recursive: true });
const check = (condition, message) => { assert.ok(condition, message); results.push(message); };
const ready = () => page.waitForFunction(() => {
  const preview = document.querySelector(".watermark-preview");
  return preview?.querySelector("svg") && preview.getAttribute("aria-busy") !== "true"
    && !document.querySelector(".watermark-dialog button.primary")?.disabled;
});
const open = async format => {
  await page.locator("#btn-export").click();
  await page.locator(".modal-box button", { hasText: format }).click();
  await page.locator(".watermark-dialog").waitFor();
  await ready();
};
const appearance = async (name, value) => { await page.getByRole("combobox", { name, exact: true }).selectOption(value); await ready(); };
const colors = () => page.locator(".watermark-controls label", { hasText: "显示颜色标记" }).locator("input");
const cancel = () => page.locator(".watermark-dialog footer button", { hasText: "取消" }).click();
const save = async () => { const pending = saved.nextExport(); await page.locator(".watermark-dialog button.primary").click(); return readFile(await (await pending).path()); };
const unchanged = () => page.evaluate(() => JSON.stringify({ text: window.__app.getText(),
  format: window.__app.documentFormat, options: window.__app.slashOptions,
  svg: [...document.querySelectorAll("#score-pane svg.score-page")].map(svg => svg.outerHTML),
  pitches: window.__app.painter.score.parts.flatMap(part => part.measures.flatMap(measure => measure.entries.flatMap(entry =>
    entry.notes?.map(note => [note.pitch, note.displayText, note.displayHidden]) ?? []))) }));
try {
  await page.goto(process.env.APP_TEST_URL ?? `http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.locator("#score-pane svg").first().waitFor();
  await page.evaluate(() => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = { kind: "keyboard", voiceCount: 2, instrumentName: "钢琴", title: "导出显示回归",
      subtitle: "", composer: "", arranger: "", lyricist: "", tempoBpm: 90, tempoBeatUnit: "quarter",
      fifths: 0, beats: 4, beatType: 4, symbolDurations: { ".": 8 }, spaceDivision: null, noteDivision: null,
      braceMode: "arpeggio", bracketMode: "triplet", ordering: "pitch-asc", keyboardKeyLabels: false, showExplicitRests: true };
    app.scoreVoiceColoring = true;
    app.slashVoiceColors[0] = "#cc3344";
    app.setText("4/4拍：\n" + Array.from({ length: 12 }, () => "(\u2063AZ)../(\u2063SX)../(\u2063DC)../(\u2063FV)../").join("\n"));
    app.applyRenderSettings({ pageW: 595, pageH: 420 });
  });
  const before = await unchanged();
  await open("PNG（全部页面）");
  check(!await colors().isChecked(), "export voice colors default off even with colored editor");
  check(await page.locator(".watermark-preview .score-voice-colored").count() === 0, "default export removes editor color marks");
  await appearance("音符显示", "keyboard");
  check(await page.locator(".watermark-preview svg").evaluate(svg => [...svg.querySelectorAll("text")].some(node => /^[ASDF]$/.test(node.textContent))), "keyboard letters appear in export preview");
  await colors().check(); await ready();
  check(await page.locator(".watermark-preview .score-voice-colored").count() > 0, "export can enable configured voice colors");
  await page.locator(".watermark-dialog").screenshot({ path: join(output, "export-keyboard-colors.png") });
  await appearance("音符显示", "number");
  check(await page.locator(".watermark-preview svg").evaluate(svg => {
    const labels = [...svg.querySelectorAll("text")].map(node => node.textContent);
    return labels.some(value => /^[1-7]$/.test(value)) && !labels.some(value => /^[ASDF]$/.test(value));
  }), "switching keyboard letters back to numbers regenerates numeric notation");
  await cancel();
  check(await unchanged() === before, "cancel preserves editor text, options, note labels, pitch and SVG");

  await open("PPTX（矢量）");
  await appearance("音符显示", "keyboard");
  await colors().check(); await ready();
  const pptx = unzipSync(await save());
  const slides = Object.entries(pptx).filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(([, bytes]) => Buffer.from(bytes).toString());
  check(slides.some(xml => /<a:t>[ASDF]<\/a:t>/.test(xml)), "actual vector PPTX contains selected keyboard letters");
  check(slides.some(xml => xml.includes('val="CC3344"')), "actual vector PPTX contains selected voice colors");
  check(await unchanged() === before, "PPTX export preserves editor state");

  await open("PNG（全部页面）");
  check(!await colors().isChecked(), "voice colors reset off for the next export");
  await appearance("导出谱型", "staff");
  check(await page.getByRole("combobox", { name: "音符显示", exact: true }).isDisabled(), "letter selector is disabled for staff notation");
  check(await page.locator(".watermark-preview [data-staff-glyph]").count() > 0, "staff preview can be selected directly from numbered view");
  await colors().check(); await ready();
  check(await page.locator(".watermark-preview .score-voice-colored").count() > 0, "staff notes accept voice color marks");
  check(await page.locator(".watermark-preview .score-voice-colored").first().evaluate(node => getComputedStyle(node).fill) === "rgb(204, 51, 68)",
    "staff noteheads have the selected computed fill");
  await page.locator(".watermark-dialog").screenshot({ path: join(output, "export-staff-colors.png") });
  const zipControl = page.locator(".watermark-controls label", { hasText: "ZIP" }).locator("input");
  await zipControl.check();
  const pngZip = unzipSync(await save());
  const entries = Object.entries(pngZip);
  check(entries.length > 1 && entries.every(([name, bytes]) => name.endsWith(".png") && Buffer.from(bytes).subarray(1, 4).toString() === "PNG"), "actual staff export saves every page as PNG in ZIP");
  const coloredPixels = await page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d"); context.drawImage(bitmap, 0, 0); bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index] === 204 && pixels[index + 1] === 51 && pixels[index + 2] === 68 && pixels[index + 3] > 240) count++;
    return count;
  }, [...entries[0][1]]);
  check(coloredPixels > 20, "actual exported staff PNG contains selected voice-color pixels");
  check(await unchanged() === before, "staff export preserves editor state");

  await open("PDF（全部页面）");
  await appearance("导出谱型", "staff");
  const pdf = await save();
  check(pdf.subarray(0, 4).toString() === "%PDF", "PDF accepts the same staff display source");
  check(await unchanged() === before, "PDF display choices preserve editor state");

  await page.evaluate(() => {
    const app = window.__app;
    app.setEngravingStyle({ ...app.engravingStyle, tieContinuationGray: true }, false);
    app.applyRenderSettings({ pageH: 842 });
    app.setText("4/4拍：\n(\u2063AZ)../0../0../0../\n0../0../0../0../\n"
      + '// @jpeditor {"ne":[{"part":0,"chord":0,"move":"0","duration":"6"}]}');
  });
  const continuation = await page.evaluate(() => {
    const targets = window.__app.getStaffPreviewSnapshot().registry.targets;
    return { generated: targets.filter(target => target.note.chord.generatedTimingContinuation && target.source?.voiceIndex === 1).length,
      colored: targets.filter(target => target.source?.voiceIndex === 1).length };
  });
  check(continuation.generated > 0, "fixture contains generated cross-bar continuation notes");
  await open("PNG（全部页面）");
  await colors().check(); await ready();
  check(await page.locator('.watermark-preview .score-voice-colored [fill="#eaa9b0"]').count() > 0, "numbered continuation retains the existing fade while inheriting its voice color");
  await appearance("导出谱型", "staff");
  check(await page.locator(".watermark-preview .score-voice-colored").count() === continuation.colored,
    "staff continuation heads inherit the source voice color across barlines");
  await cancel();

  const beforeCancel = await unchanged();
  await open("PNG（全部页面）");
  await page.evaluate(() => {
    const select = document.querySelector('select[aria-label="导出谱型"]');
    select.value = "staff"; select.dispatchEvent(new Event("change"));
    select.value = "jianpu"; select.dispatchEvent(new Event("change"));
    document.querySelector(".watermark-dialog footer button").click();
  });
  await page.waitForTimeout(150);
  check(await page.locator(".watermark-dialog").count() === 0 && await unchanged() === beforeCancel,
    "rapid display switching followed by cancel leaves no dialog or editor mutation");

  await page.evaluate(() => {
    const app = window.__app;
    const original = app.createPageExportPainter;
    app.createPageExportPainter = function(score) {
      app.createPageExportPainter = original;
      const painter = original.call(app, score);
      app.setText(app.getText() + "\n// changed during export preparation");
      return painter;
    };
  });
  await page.locator("#btn-export").click();
  await page.locator(".modal-box button", { hasText: "PNG（全部页面）" }).click();
  await page.getByText("乐谱已更新，请重新导出。", { exact: true }).waitFor();
  check(await page.locator(".watermark-dialog").count() === 0,
    "changing the document before the initial preview opens rejects its stale snapshot");
  await page.locator(".app-dialog button").last().click();
  check(errors.length === 0, `no browser exceptions: ${errors.join("; ")}`);
  await writeFile(join(output, "export-display-options-results.json"), JSON.stringify({ results, staffPages: entries.length }, null, 2));
  console.log(JSON.stringify({ checks: results.length, staffPages: entries.length, results }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
