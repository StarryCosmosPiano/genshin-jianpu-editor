// Source-based regression: starts Vite directly and never rebuilds or replaces dist/.
import assert from "node:assert/strict";
import { createServer } from "vite";
import { launchSaveCheckBrowser } from "./browser-save-test-helpers.mjs";
import { unzipSync } from "fflate";

const server = await createServer({ configFile: false, root: process.cwd(), base: "/", logLevel: "error",
  cacheDir: "artifacts/checks/mobile-files-vite-cache", optimizeDeps: { include: ["pdfjs-dist", "fflate"] },
  server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null,
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } },
});
await server.listen();
const port = server.httpServer.address().port;
const browser = await launchSaveCheckBrowser();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true,
  isMobile: true, acceptDownloads: true, serviceWorkers: "block" });
const page = await context.newPage();
page.setDefaultTimeout(30000);
const errors = [], downloads = [], checks = [];
page.on("pageerror", error => errors.push(error.message));
page.on("download", download => downloads.push(download.suggestedFilename()));
page.on("dialog", dialog => { void dialog.accept(); });
await page.addInitScript(() => {
  localStorage.setItem("jpeditor:workspace-mode:v1", "phone");
  Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true, writable: true });
  Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true, writable: true });
});
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
const fixture = ".Title\nTitle = {移动文件回归}\nKeyAndMeters = {1=C,4/4}\nTempo = {90}\n.Voice\n1 2 3 4 |]\n";
const incomplete = ".Title\nTitle = {尚未完成的草稿  \n";
const drafts = () => page.evaluate(async () => (await import("/src/editor/mobile-drafts.ts")).indexedDbDraftStore.list());
const source = () => page.evaluate(() => window.__app.getText());
const handoff = () => page.getByRole("dialog", { name: "文件已准备好", exact: true });

async function installActionButton() {
  await page.evaluate(async () => {
    window.__filesApi = await import("/src/editor/fileio.ts");
    window.__exportsApi = await import("/src/editor/export.ts");
    const button = document.createElement("button");
    button.id = "file-check-action";
    button.textContent = "执行文件检查";
    button.style.cssText = "position:fixed;left:6px;bottom:6px;z-index:11000;min-height:44px;background:#fff;color:#000";
    button.onclick = () => {
      window.__fileCheckResult = null;
      let operation;
      if (window.__fileCheckAction === "pdf") operation = window.__exportsApi.exportScorePdf(window.__app);
      else if (window.__fileCheckAction === "camera") operation = window.__app.openRecognitionFile("camera");
      else if (window.__fileCheckAction === "zip") operation = window.__filesApi.saveByteFiles([
        { name: "谱-第1页.png", bytes: () => new Uint8Array([1, 2, 3]) },
        { name: "谱-第2页.png", bytes: () => new Uint8Array([4, 5, 6]) },
      ]);
      else operation = window.__app.saveFile();
      window.__fileCheckPending = Promise.resolve(operation).then(result => {
        window.__fileCheckResult = result ?? { done: true }; return result;
      }).catch(error => { window.__fileCheckResult = { error: error.name, message: error.message }; });
    };
    document.body.append(button);
  });
}

async function act(action = "save") {
  await page.evaluate(value => { window.__fileCheckAction = value; window.__fileCheckResult = null; }, action);
  await page.locator("#file-check-action").click();
}

async function mockWritablePicker() {
  await page.evaluate(() => {
    window.__savedFiles = [];
    window.showSaveFilePicker = async options => {
      window.__pickerActivation = navigator.userActivation?.isActive ?? true;
      if (window.__pickerFailure) throw new DOMException("denied by user", "NotAllowedError");
      return { name: options.suggestedName, createWritable: async () => {
        let bytes;
        return { write: async value => { bytes = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value; },
          close: async () => { window.__savedFiles.push({ name: options.suggestedName, bytes: [...bytes] }); },
          abort: async () => {} };
      } };
    };
  });
}

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForFunction(() => window.__app?.view && document.querySelector("#score-pane svg"));
  await installActionButton();
  await page.evaluate(({ fixture, incomplete }) => {
    window.__app.loadText(fixture, null);
    window.__app.setText(incomplete);
  }, { fixture, incomplete });
  await page.waitForFunction(() => document.getElementById("mobile-draft-status")?.dataset.state === "saved");
  const capturedDrafts = await drafts();
  assert.equal(capturedDrafts.find(record => record.text.includes("尚未完成的草稿"))?.text, incomplete,
    `automatic raw draft differs from the source: ${JSON.stringify({ source: await source(), records: capturedDrafts })}`);
  check("500 ms automatic IndexedDB draft preserves incomplete raw text", capturedDrafts.some(record => record.text === incomplete));
  await page.reload({ waitUntil: "networkidle", timeout: 120000 });
  const recovery = page.getByRole("dialog", { name: "继续上次编辑", exact: true });
  await recovery.getByRole("button", { name: "继续编辑", exact: true }).click();
  await page.waitForFunction(text => window.__app.getText() === text, incomplete);
  check("reload recovery keeps invalid text, clears the old preview, and binds no external file", await page.evaluate(() =>
    window.__app.hasUnsavedChanges() && !window.__app.filePath && !window.__app._browserSaveHandle
      && !window.__app._hasSavedCurrent && window.__app.painter.score.parts.length === 0
      && !!document.querySelector("[data-recovery-error]") && !window.__app.codePaneCollapsed));
  await installActionButton();

  await page.evaluate(() => {
    window.__shareCalls = [];
    window.__shareMode = "cancel";
    Object.defineProperty(navigator, "canShare", { configurable: true, value: data => {
      window.__canShareFile = { name: data.files[0].name, type: data.files[0].type, size: data.files[0].size };
      return true;
    } });
    Object.defineProperty(navigator, "share", { configurable: true, value: data => {
      window.__shareCalls.push({ active: navigator.userActivation?.isActive ?? true, name: data.files[0].name });
      return window.__shareMode === "cancel" ? Promise.reject(new DOMException("cancelled", "AbortError")) : Promise.resolve();
    } });
  });
  await act();
  await handoff().waitFor();
  check("preparing a mobile file does not open share or start a download", downloads.length === 0
    && await page.evaluate(() => window.__shareCalls.length === 0 && window.__canShareFile.name.endsWith(".jpwabc")));
  await handoff().getByRole("button", { name: "分享 / 存到文件", exact: true }).click();
  await handoff().getByText("已取消分享。文件仍在这里，可以重试或关闭。", { exact: true }).waitFor();
  check("cancelled sharing keeps the handoff open and never downloads", downloads.length === 0 && await source() === incomplete);
  await page.evaluate(() => { window.__shareMode = "success"; });
  await handoff().getByRole("button", { name: "分享 / 存到文件", exact: true }).click();
  await page.waitForFunction(() => window.__fileCheckResult?.status === "exported");
  check("share uses a fresh user gesture and never acknowledges the formal-save baseline", await page.evaluate(() =>
    window.__shareCalls.every(call => call.active) && window.__fileCheckResult.method === "shared"
      && window.__app.hasUnsavedChanges() && !window.__app._browserSaveHandle && !window.__app._hasSavedCurrent));
  await act();
  await handoff().waitFor();
  const downloading = page.waitForEvent("download");
  await handoff().getByRole("button", { name: "下载副本", exact: true }).click();
  const downloaded = await downloading;
  await page.waitForFunction(() => window.__fileCheckResult?.method === "downloaded");
  check("download happens only after its explicit button and leaves the document dirty", downloads.length === 1
    && downloaded.suggestedFilename().endsWith(".jpwabc") && await page.evaluate(() => window.__app.hasUnsavedChanges()));

  await mockWritablePicker();
  await act();
  await page.waitForFunction(() => window.__fileCheckResult?.status === "success");
  check("supporting mobile browsers preserve direct file writes and the selected save target", await page.evaluate(text => {
    const file = window.__savedFiles[0];
    return window.__pickerActivation && file.bytes[0] === 255 && file.bytes[1] === 254
      && new TextDecoder("utf-16le").decode(new Uint8Array(file.bytes.slice(2))) === text
      && !window.__app.hasUnsavedChanges() && !!window.__app._browserSaveHandle;
  }, incomplete));

  await page.evaluate(text => {
    window.__app.loadText(text, null);
    window.__app.setText(text + "// permission failure\n");
    window.__pickerFailure = true;
  }, fixture);
  await act();
  await page.waitForFunction(() => window.__fileCheckResult?.status === "failed");
  check("permission errors do not silently switch to mobile sharing or downloading", downloads.length === 1 && !await handoff().count());
  await page.evaluate(() => { window.__pickerFailure = false; });

  await act("zip");
  await page.waitForFunction(() => window.__fileCheckResult === true);
  const zip = await page.evaluate(() => window.__savedFiles.at(-1));
  const entries = unzipSync(new Uint8Array(zip.bytes));
  check("missing mobile folder picker produces one explicit ZIP save", zip.name.endsWith(".zip")
    && Object.keys(entries).length === 2 && entries["谱-第2页.png"][2] === 6);

  await page.evaluate(async text => {
    (await import("/src/bootstrap/device-mode.ts")).setWorkspaceModePreference("desktop");
    window.showSaveFilePicker = undefined;
    window.__app.loadText(text, null);
    window.__app.setText(text + "// desktop must not download\n");
  }, fixture);
  await act();
  const unsupported = page.getByRole("dialog", { name: "无法保存到本地", exact: true });
  await unsupported.getByRole("button", { name: "知道了", exact: true }).click();
  await page.waitForFunction(() => window.__fileCheckResult?.status === "failed");
  check("desktop missing-API behavior still fails explicitly without a download fallback", downloads.length === 1 && !await handoff().count());
  await page.evaluate(async () => (await import("/src/bootstrap/device-mode.ts")).setWorkspaceModePreference("phone"));

  const beforeFailure = await drafts();
  await page.evaluate(() => {
    window.__originalDraftPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "documents") throw new DOMException("injected full storage", "QuotaExceededError");
      return window.__originalDraftPut.apply(this, args);
    };
    window.__app.setText(window.__app.getText() + "// latest raw survives quota\n");
    window.__draftFailure = window.__app.flushMobileDraft();
  });
  check("quota failure is visible and does not destroy earlier IndexedDB records", !await page.evaluate(() => window.__draftFailure)
    && (await drafts()).length >= beforeFailure.length
    && (await page.locator("#mobile-draft-status").textContent()).includes("保存失败"));
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.__originalDraftPut; });
  check("quota retry saves the latest source", await page.evaluate(() => window.__app.flushMobileDraft())
    && (await drafts()).some(record => record.text.includes("latest raw survives quota")));

  const beforeCamera = await source();
  const chooser = page.waitForEvent("filechooser");
  await act("camera");
  const cameraChooser = await chooser;
  const cameraInput = await cameraChooser.element().evaluate(input => ({ accept: input.accept, capture: input.capture, attribute: input.getAttribute("capture") }));
  assert.equal(cameraInput.accept, "image/*", JSON.stringify(cameraInput));
  assert.equal(cameraInput.attribute, "environment", JSON.stringify(cameraInput));
  check("camera import is a distinct image-only capture input", true);
  await cameraChooser.element().evaluate(input => input.dispatchEvent(new Event("cancel")));
  await page.waitForFunction(() => window.__fileCheckResult?.done === true);
  check("cancelled camera selection preserves the score", await source() === beforeCamera);

  const pdfProbe = await page.evaluate(async () => {
    const { RasterPdfWriter } = await import("/src/editor/file-pdf.ts");
    const { openRecognitionPdf } = await import("/src/omr/decode.ts");
    const writer = new RasterPdfWriter(3);
    const canvas = document.createElement("canvas"); canvas.width = 200; canvas.height = 280;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 200, 280);
    ctx.fillStyle = "black"; ctx.font = "30px sans-serif"; ctx.fillText("1 2 3 4", 12, 80);
    const jpeg = new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg"))).arrayBuffer());
    for (let page = 0; page < 3; page++) writer.addPage({ jpeg, pixelWidth: 200, pixelHeight: 280, pageWidth: 200, pageHeight: 280 });
    window.__recognitionPdf = new Uint8Array(await writer.finish().arrayBuffer());
    canvas.width = canvas.height = 1;
    const pdf = await openRecognitionPdf(window.__recognitionPdf);
    try {
      const bin = await pdf.decodePage(2);
      return { pages: pdf.pageCount, width: bin.w, height: bin.h, ink: bin.data.reduce((sum, value) => sum + value, 0) };
    } finally { await pdf.dispose(); }
  });
  check("real PDF pages decode independently through the existing bitmap pipeline", pdfProbe.pages === 3
    && pdfProbe.width > 0 && pdfProbe.height > 0 && pdfProbe.ink > 0);
  const beforePdfImport = await source();
  await page.evaluate(() => { window.__recognitionResult = window.__app.recognizeBytes("musicpp", { bytes: window.__recognitionPdf, mime: "application/pdf" }); });
  const pagesDialog = page.getByRole("dialog", { name: "选择识别页码", exact: true });
  await pagesDialog.getByLabel("识别页码", { exact: true }).fill("4");
  await pagesDialog.getByRole("button", { name: "开始识别", exact: true }).click();
  check("invalid PDF page ranges are rejected before OCR", (await pagesDialog.textContent()).includes("1–3"));
  await pagesDialog.getByRole("button", { name: "取消", exact: true }).click();
  check("cancelled page selection never imports or replaces the current document", !await page.evaluate(() => window.__recognitionResult)
    && await source() === beforePdfImport);

  await page.evaluate(text => {
    window.__app.loadText(text.replace("1 2 3 4 |]", Array(8).fill("1 2 3 4").join(" |\n") + " |]"), null);
    window.__app.setLinesPerPage("1|1");
    window.__originalToBlob = HTMLCanvasElement.prototype.toBlob;
    window.__exportCanvases = [];
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      window.__exportCanvases.push(this);
      return window.__originalToBlob.call(this, blob => setTimeout(() => callback(blob), 350), ...args);
    };
  }, fixture);
  await page.waitForFunction(() => window.__app.painter.pageCount > 1).catch(async error => {
    throw new Error(`multi-page fixture did not paginate: ${JSON.stringify(await page.evaluate(() => ({
      text: window.__app.getText(), pages: window.__app.painter.pageCount,
      parts: window.__app.painter.score.parts.length, status: document.getElementById("status")?.textContent,
    })))}`, { cause: error });
  });
  const beforeExport = await source();
  await act("pdf");
  const exportDialog = page.locator(".watermark-dialog");
  await exportDialog.getByRole("button", { name: "导出", exact: true }).click();
  await page.waitForFunction(() => window.__exportCanvases.length > 0);
  await page.getByRole("dialog", { name: "导出 PDF", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
  await page.waitForFunction(() => window.__fileCheckResult?.error === "AbortError");
  check("cancelling PDF generation releases page canvases and never opens share/download", await page.evaluate(() =>
    window.__exportCanvases.every(canvas => canvas.width === 1 && canvas.height === 1))
    && downloads.length === 1 && !await handoff().count() && await source() === beforeExport);
  await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = window.__originalToBlob; });

  await mockWritablePicker();
  await act("pdf");
  await exportDialog.getByLabel("导出页码（留空为全部）", { exact: true }).fill("2");
  await exportDialog.getByRole("button", { name: "导出", exact: true }).click();
  await page.waitForFunction(() => window.__savedFiles.length > 0 && window.__fileCheckResult?.done === true);
  const selectedPdf = await page.evaluate(() => window.__savedFiles[0]);
  const pdfText = Buffer.from(selectedPdf.bytes).toString("latin1");
  check("selected-page PDF writes one complete page through the direct-save branch", selectedPdf.name.endsWith(".pdf")
    && pdfText.startsWith("%PDF-") && /\/Count 1\b/.test(pdfText) && (pdfText.match(/\/Type \/Page /g) ?? []).length === 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
