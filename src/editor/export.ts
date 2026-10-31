// Export: PNG (rasterize page SVG), MIDI (SMF), PPTX, Mixed PDF.
import type { App } from "./app";
import { scoreToMidi } from "../score/midi";
import { scoreToMusicXml } from "../score/musicxml-export";
import { buildPptx } from "./pptx";
import { isTauriRuntime, isFilePickerCancellation, saveBytes, saveByteFiles } from "./fileio";
import { asset } from "../common/asset";
import { archiveByteFiles } from "./file-archive";
import { RasterPdfWriter } from "./file-pdf";
import { createFileTask, throwIfFileTaskAborted, withFileTask, yieldFileTask, type FileTask } from "./file-task";
import { isTouchWorkspace } from "../bootstrap/device-mode";
import { showMessageDialog } from "../ui/app-dialog";
import { DEFAULT_WATERMARK, type WatermarkOptions } from "./watermark";
import { composeExportPageSvg } from "./export-page";
import { choosePageExportOptions, type PageExportOptions } from "./watermark-dialog";
import { editableDocumentFileInfo } from "./file-format";
import { applyKeyboardKeyLabels } from "../slashscore";
import { createStaffNoteRegistry } from "../staff-preview/identity";
import { applyExportVoiceColor, cloneExportScore, exportContinuationVoiceColor, resetExportNumberLabels, type ExportAppearance, type ExportPage } from "./export-display";
import type { JinpuPainter } from "../layout/painter";
import type { PageItem } from "../layout/layout";
import type { Note } from "../score/score";

const SVG_NS = "http://www.w3.org/2000/svg";

let bravuraDataUrlPromise: Promise<string> | null = null;
async function bravuraDataUrl(): Promise<string> {
  if (!bravuraDataUrlPromise) {
    bravuraDataUrlPromise = fetch(asset("redist/Bravura.woff2"))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        let bin = "";
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return `data:font/woff2;base64,${btoa(bin)}`;
      });
  }
  return bravuraDataUrlPromise;
}

function svgDimensions(svg: SVGSVGElement): { width: number; height: number } {
  const viewBox = svg.viewBox.baseVal;
  const width = Number(svg.getAttribute("width")) || viewBox.width || svg.clientWidth;
  const height = Number(svg.getAttribute("height")) || viewBox.height || svg.clientHeight;
  if (!(width > 0) || !(height > 0)) throw new Error("谱面页面尺寸无效");
  return { width, height };
}

/** Render one page with Bravura embedded so PNG/PDF output matches the SVG preview. */
async function svgToCanvas(
  svg: SVGSVGElement,
  scale: number,
  transparent: boolean,
  watermark?: WatermarkOptions,
  includeRhythmGuides = false,
): Promise<HTMLCanvasElement> {
  const { width, height } = svgDimensions(svg);
  const clone = composeExportPageSvg(svg, watermark ?? DEFAULT_WATERMARK, transparent, includeRhythmGuides);
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));

  const style = document.createElementNS(SVG_NS, "style");
  style.textContent =
    `@font-face{font-family:"Bravura";src:url("${await bravuraDataUrl()}") format("woff2");}`;
  clone.insertBefore(style, clone.firstChild);

  const svgText = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }));

  const img = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("谱面 SVG 无法转换为图片"));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器无法创建导出画布，请减少导出页数后重试");
  if (!transparent) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.onload = img.onerror = null;
  img.src = "";
  return canvas;
}

async function canvasToBytes(
  canvas: HTMLCanvasElement,
  type: "image/png" | "image/jpeg",
  quality?: number,
): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, quality));
  if (!blob) throw new Error(`${type} 编码失败`);
  return new Uint8Array(await blob.arrayBuffer());
}

async function svgToBytes(
  svg: SVGSVGElement,
  scale: number,
  transparent = false,
  watermark?: WatermarkOptions,
  includeRhythmGuides = false,
): Promise<Uint8Array> {
  const canvas = await svgToCanvas(svg, scale, transparent, watermark, includeRhythmGuides);
  try { return await canvasToBytes(canvas, "image/png"); }
  finally { canvas.width = 1; canvas.height = 1; }
}

function baseName(app: App): string {
  return (app.painter.score.title.split("\n")[0] || "未命名")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
}

export async function exportCurrentPagePng(app: App): Promise<void> {
  const selected = await chooseVisualExport(app, "导出当前页 PNG", true, true);
  if (!selected) return;
  const { options, pages: [page] } = selected;
  await saveBytes(
    () => withFileTask("导出当前页 PNG", async task => {
      task.update({ completed: 0, total: 1, message: `正在生成第 ${page.page + 1} 页…` });
      await yieldFileTask(task.signal);
      try {
        const bytes = await svgToBytes(page.svg, 2, options.transparent, options.watermark, options.includeRhythmGuides);
        throwIfFileTaskAborted(task.signal);
        return bytes;
      } finally { page.svg.replaceChildren(); }
    }),
    `${baseName(app)}-第${page.page + 1}页.png`, "image/png",
  );
}

/** One isolated source per display choice, shared by the dialog and writer. */
async function chooseVisualExport(app: App, title: string, pngOptions = false, currentOnly = false, pptx = false) {
  const { surface: initialSurface, currentPage: initialCurrentPage } = await app.getPageExportContext();
  const snapshot = app.getStaffPreviewSnapshot();
  const availability = app.getStaffPreviewAvailability();
  const slashOptions = app.slashOptions ? structuredClone(app.slashOptions) : null;
  const voiceColors = [...app.slashVoiceColors];
  const cache = new Map<string, Promise<{ pages: ExportPage[]; painter?: JinpuPainter }>>();
  const get = (appearance: ExportAppearance) => {
    const key = JSON.stringify(appearance);
    let result = cache.get(key);
    if (result) return result;
    if (cache.size >= 2) cache.clear();
    result = (async () => {
      const { score, copies } = cloneExportScore(snapshot.score);
      if (appearance.notation !== "current") resetExportNumberLabels(score);
      if (appearance.notation === "keyboard") applyKeyboardKeyLabels(score,
        slashOptions?.keyboardTieAsZero ?? false, slashOptions?.keyboardHideTieLabels ?? false);
      const sources = snapshot.sources.map(source => ({ ...source,
        chord: copies.get(source.chord) as typeof source.chord, note: copies.get(source.note) as Note }));
      const colors = new Map<Note, string>();
      if (appearance.voiceColors) for (const source of sources) {
        if (!source.voiceIndex || source.voiceIndex >= (slashOptions?.voiceCount ?? 1)) continue;
        const color = voiceColors[source.voiceIndex - 1];
        if (color && /^#[\da-f]{6}$/i.test(color)) colors.set(source.note, color);
      }
      const registry = createStaffNoteRegistry(score, sources, snapshot.revision);
      for (const target of registry.targets) {
        const color = target.source ? colors.get(target.source.note) : undefined;
        if (color) colors.set(target.note, color);
      }
      let pages: ExportPage[];
      let painter: JinpuPainter | undefined;
      if (appearance.surface === "staff") {
        if (!availability.supported) throw new Error(availability.reason);
        const prepared = await (await import("../staff-preview/renderer")).prepareStaffPreview({ ...snapshot,
          score, sources, registry });
        try {
          pages = Array.from({ length: prepared.pageCount }, (_, page) => {
            const rendered = prepared.renderPage(page);
            for (const note of rendered.notes) {
              const target = registry.resolve(note.ref)?.note;
              const color = target ? colors.get(target) : undefined;
              if (color) applyExportVoiceColor(note.element, color);
            }
            return { page, svg: rendered.svg, widthPt: prepared.pageWidth * 72 / 96, heightPt: prepared.pageHeight * 72 / 96 };
          });
        } finally { prepared.dispose(); }
      } else {
        painter = app.createPageExportPainter(score);
        pages = painter.layout.pages.map((_, page) => ({ page, svg: painter!.renderPage(page) }));
        for (const [note, color] of colors) for (const rendered of painter.noteGroupEls(note.chord, note)) {
          const paint = exportContinuationVoiceColor(color, note, snapshot.engravingStyle?.tieContinuationGray ?? false);
          applyExportVoiceColor(rendered.element, paint);
          const item = painter.pageItemForTarget(rendered.element);
          if (item) colorExportItem(item, Number.parseInt(paint.slice(1), 16) | 0xff000000);
        }
      }
      if (currentOnly) pages = [pages[Math.min(initialCurrentPage, pages.length - 1)]].filter(Boolean);
      return { pages, painter };
    })();
    cache.set(key, result);
    return result;
  };
  const appearance: ExportAppearance = { surface: pptx ? "jianpu" : initialSurface, notation: "current", voiceColors: false };
  const first = await get(appearance);
  if (!snapshot.current) throw new Error("乐谱已更新，请重新导出。");
  if (!first.pages.length) throw new Error("当前没有可导出的谱面页面");
  const options = await choosePageExportOptions(first.pages, initialCurrentPage, title, pngOptions, {
    initialSurface: appearance.surface, staffAvailable: !pptx && availability.supported,
    staffReason: pptx ? "PPTX 矢量导出支持简谱及键盘字母。" : availability.reason,
    renderPages: async next => (await get(next)).pages,
  });
  if (!options) return null;
  if (!snapshot.current) throw new Error("乐谱已更新，请重新导出。");
  const rendered = await get(options.appearance!);
  return { options, ...rendered, pages: rendered.pages.filter(page => !options.pages || options.pages.includes(page.page)) };
}

function colorExportItem(item: PageItem, color: number): void {
  for (const property of ["color", "fillColor", "strokeColor"] as const) {
    if (property in item) (item as unknown as Record<string, unknown>)[property] = color;
  }
  item.children.forEach(child => colorExportItem(child, color));
}

export async function exportAllPagesPng(app: App): Promise<void> {
  const selected = await chooseVisualExport(app, "导出 PNG（全部页面）", true);
  if (!selected) return;
  const { options, pages } = selected;

  const name = baseName(app);
  let task: FileTask | null = null;
  let completed = 0;
  const ensureTask = (): FileTask => task ??= createFileTask("导出 PNG");
  const closeTask = (): void => { task?.close(); task = null; };
  const files = pages.map((page) => ({
    name: `${name}-第${page.page + 1}页.png`,
    bytes: async () => {
      const running = ensureTask();
      await yieldFileTask(running.signal);
      running.update({ completed, total: pages.length, message: `正在生成第 ${page.page + 1} 页（${completed + 1}/${pages.length}）…` });
      try {
        const bytes = await svgToBytes(page.svg, 2, options.transparent, options.watermark, options.includeRhythmGuides);
        throwIfFileTaskAborted(running.signal);
        completed++;
        running.update({ completed, total: pages.length, message: `已生成 ${completed}/${pages.length} 页` });
        return bytes;
      } finally { page.svg.replaceChildren(); }
    },
  }));
  const mobileZip = isTouchWorkspace() && !isTauriRuntime() && files.length > 1
    && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker !== "function";
  try {
    if (options.zip || mobileZip) {
      await saveBytes(async () => {
        const running = ensureTask();
        try { return await archiveByteFiles(files, { signal: running.signal }); }
        finally { closeTask(); }
      }, `${name}-PNG.zip`, "application/zip");
    } else if (files.length === 1) {
      await saveBytes(async () => {
        try { return await files[0].bytes(); }
        finally { closeTask(); }
      }, files[0].name, "image/png");
    } else {
      await saveByteFiles(files);
    }
  } finally {
    closeTask();
    pages.forEach(page => page.svg.replaceChildren());
  }
}

export async function exportScorePdf(app: App): Promise<void> {
  const selected = await chooseVisualExport(app, "导出 PDF（全部页面）");
  if (!selected) return;
  const { options, pages } = selected;
  await saveBytes(() => rasterizePdfPages(pages, options), `${baseName(app)}.pdf`, "application/pdf");
}

async function rasterizePdfPages(pages: readonly ExportPage[], options: PageExportOptions): Promise<Blob> {
  return withFileTask("导出 PDF", async task => {
    const writer = new RasterPdfWriter(pages.length);
    try {
      for (let index = 0; index < pages.length; index++) {
        await yieldFileTask(task.signal);
        const page = pages[index];
        task.update({ completed: index, total: pages.length, message: `正在生成第 ${page.page + 1} 页（${index + 1}/${pages.length}）…` });
        const { width, height } = svgDimensions(page.svg);
        const canvas = await svgToCanvas(page.svg, 2, false, options.watermark, options.includeRhythmGuides);
        try {
          const jpeg = await canvasToBytes(canvas, "image/jpeg", 0.96);
          throwIfFileTaskAborted(task.signal);
          writer.addPage({ jpeg, pixelWidth: canvas.width, pixelHeight: canvas.height,
            pageWidth: page.widthPt ?? width, pageHeight: page.heightPt ?? height });
        } finally { canvas.width = 1; canvas.height = 1; page.svg.replaceChildren(); }
        task.update({ completed: index + 1, total: pages.length, message: `已生成 ${index + 1}/${pages.length} 页` });
      }
      throwIfFileTaskAborted(task.signal);
      return writer.finish();
    } finally { writer.dispose(); pages.forEach(page => page.svg.replaceChildren()); }
  });
}

export async function exportMidi(app: App): Promise<void> {
  await saveBytes(
    () => scoreToMidi(app.painter.score, { partVolumes: app.partVolumes }),
    `${baseName(app)}.mid`, "audio/midi",
  );
}

export async function exportMusicXml(app: App): Promise<void> {
  await saveBytes(() => {
    const text = app.mode === "mixed" && app.mixedXmlText
      ? app.mixedXmlText : scoreToMusicXml(app.painter.score);
    return new TextEncoder().encode(text);
  }, `${baseName(app)}.musicxml`, "application/vnd.recordare.musicxml+xml");
}

export async function exportPptx(app: App): Promise<void> {
  const selected = await chooseVisualExport(app, "导出 PPTX（全部页面）", false, false, true);
  if (!selected?.painter) return;
  const { options, painter, pages } = selected;
  await saveBytes(
    () => withFileTask("导出 PPTX", async task => {
      try {
        return await buildPptx(painter, options.watermark, options.includeRhythmGuides, {
          signal: task.signal, pages: pages.map(page => page.page),
          onProgress: (completed, total) => task.update({ completed, total,
            message: completed === total ? "正在打包 PPTX…" : `正在生成幻灯片 ${completed + 1}/${total}…` }),
        });
      } finally { pages.forEach(page => page.svg.replaceChildren()); }
    }),
    `${baseName(app)}.pptx`,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
}

interface SlashTextExportOptions {
  includeVoiceMarkers: boolean;
  includeMetadata: boolean;
}

function chooseSlashTextExportOptions(): Promise<SlashTextExportOptions | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const box = document.createElement("div");
    box.className = "modal-box";
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "键盘谱 / 数字谱导出设置";

    const includeVoiceMarkers = document.createElement("input");
    includeVoiceMarkers.type = "checkbox";
    includeVoiceMarkers.checked = true;
    const voiceRow = document.createElement("label");
    voiceRow.className = "modal-row";
    const voiceLabel = document.createElement("span");
    voiceLabel.textContent = "保留多声部隐形标记";
    voiceRow.append(voiceLabel, includeVoiceMarkers);
    const voiceHint = document.createElement("div");
    voiceHint.className = "modal-hint";
    voiceHint.textContent = "开启时保留不可见的 U+2063 声部归属；关闭时会合并为单谱行。";

    const includeMetadata = document.createElement("input");
    includeMetadata.type = "checkbox";
    includeMetadata.checked = true;
    const metadataRow = document.createElement("label");
    metadataRow.className = "modal-row";
    const metadataLabel = document.createElement("span");
    metadataLabel.textContent = "包含 // @jpeditor 元数据";
    metadataRow.append(metadataLabel, includeMetadata);
    const metadataHint = document.createElement("div");
    metadataHint.className = "modal-hint";
    const updateMetadataHint = () => {
      metadataHint.textContent = includeMetadata.checked
        ? "推荐保留：下次打开时会自动恢复谱型、声部、拍号、速度、符号时值及花括号/方括号设置。"
        : "⚠ 不包含元数据时，下次打开无法自动读取这些导入设置，需要重新手动设置。";
      metadataHint.classList.toggle("midi-import-warning", !includeMetadata.checked);
    };
    includeMetadata.addEventListener("change", updateMetadataHint);
    updateMetadataHint();

    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    const confirm = document.createElement("button");
    confirm.textContent = "导出";
    footer.append(cancel, confirm);
    box.append(
      title,
      voiceRow,
      voiceHint,
      metadataRow,
      metadataHint,
      footer,
    );
    overlay.append(box);
    document.body.append(overlay);
    const close = (value: SlashTextExportOptions | null) => {
      overlay.remove();
      resolve(value);
    };
    cancel.onclick = () => close(null);
    confirm.onclick = () => close({
      includeVoiceMarkers: includeVoiceMarkers.checked,
      includeMetadata: includeMetadata.checked,
    });
    overlay.onclick = (event) => {
      if (event.target === overlay) close(null);
    };
  });
}

async function exportTextScore(
  app: App,
  format: "jpw" | "keyboard" | "number",
): Promise<void> {
  const options = format === "jpw"
    ? { includeVoiceMarkers: true, includeMetadata: true }
    : await chooseSlashTextExportOptions();
  if (!options) return;
  const fileInfo = editableDocumentFileInfo(format);
  await saveBytes(() => app.exportTextDocument(
    format, options.includeVoiceMarkers, options.includeMetadata,
  ).bytes, `${baseName(app)}${fileInfo.extension}`, fileInfo.mime);
}

/** Export mixed-mode pages to PDF via Tauri svg2pdf command or browser print dialog. */
export async function exportMixedPdf(app: App): Promise<void> {
  if (!app["_mixedPainter"] || app.mode !== "mixed") return;
  const painter = app["_mixedPainter"] as import("../mixed/painter").MixedPainter;
  const wPt = painter.pageWidthPt;
  const hPt = painter.pageHeightPt;
  const sourcePages = Array.from({ length: painter.pageCount }, (_, page) => ({ page, svg: painter.renderPage(page) }));
  if (!sourcePages.length) throw new Error("当前没有可导出的谱面页面");
  const options = await choosePageExportOptions(sourcePages, app.pageIndex, `导出混排 PDF（共 ${sourcePages.length} 页）`);
  if (!options) return;
  const selectedPages = sourcePages.filter(page => !options.pages || options.pages.includes(page.page));

  if (!isTauriRuntime() && isTouchWorkspace()) {
    await saveBytes(() => rasterizePdfPages(selectedPages.map(page => ({ ...page, widthPt: wPt, heightPt: hPt })), options),
      `${painter.title || "混排"}.pdf`, "application/pdf");
    return;
  }

  if (isTauriRuntime()) {
    // Tauri path: serialize SVGs and invoke Rust export_pdf command
    const { invoke } = await import("@tauri-apps/api/core");
    const { save } = await import("@tauri-apps/plugin-dialog");
    const title = painter.title || "混排";
    const outPath = await save({ defaultPath: `${title}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!outPath) return;
    const pages: string[] = [];
    for (const page of selectedPages) {
      const svg = composeExportPageSvg(page.svg, options.watermark, false, options.includeRhythmGuides);
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      svg.setAttribute("width", `${wPt}pt`);
      svg.setAttribute("height", `${hPt}pt`);
      pages.push(new XMLSerializer().serializeToString(svg));
    }
    await invoke("export_pdf_cmd", { pagesSvg: pages, widthPt: wPt, heightPt: hPt, outPath });
  } else {
    // Browser path: open print window with embedded font
    const win = window.open("", "_blank", "width=800,height=900");
    if (!win) throw new Error("浏览器阻止了打印窗口，请允许此页面打开弹窗后重试；在系统打印窗口选择“另存为 PDF”及保存位置。");
    const bravuraUrl = await bravuraDataUrl();
    const d = win.document;
    const wMm = (wPt * 25.4 / 72).toFixed(1);
    const hMm = (hPt * 25.4 / 72).toFixed(1);
    d.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
@font-face{font-family:"Bravura";src:url("${bravuraUrl}") format("woff2");}
@page{size:${wMm}mm ${hMm}mm;margin:0}
body{margin:0;padding:0;background:#fff}
svg{display:block;width:100%;page-break-after:always}
</style></head><body>`);
    for (const page of selectedPages) {
      const svg = composeExportPageSvg(page.svg, options.watermark, false, options.includeRhythmGuides);
      svg.setAttribute("xmlns", SVG_NS);
      svg.setAttribute("width", `${wPt}pt`);
      svg.setAttribute("height", `${hPt}pt`);
      d.write(new XMLSerializer().serializeToString(svg));
    }
    d.write("</body></html>");
    d.close();
    setTimeout(() => win.print(), 500);
  }
}

export function showExportDialog(app: App): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  const title = document.createElement("div");
  title.className = "modal-title";
  title.textContent = "导出";
  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:8px";

  const close = () => overlay.remove();
  const item = (label: string, fn: () => void | Promise<void>) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText = "padding:8px 12px;text-align:left;cursor:pointer";
    btn.onclick = async () => {
      close();
      try {
        await fn();
      } catch (e) {
        if (isFilePickerCancellation(e)) { app.reportFileStatus("已取消导出，当前乐谱没有更改。"); return; }
        console.error(e);
        await showMessageDialog("导出失败", e instanceof Error ? e.message : String(e));
      }
    };
    list.append(btn);
  };
  if (app.mode === "mixed") {
    item("混排 PDF", () => exportMixedPdf(app));
    item("MusicXML", () => exportMusicXml(app));
  } else {
    item("PNG（全部页面）", () => exportAllPagesPng(app));
    item("PDF（全部页面）", () => exportScorePdf(app));
    if (app.getActiveScoreSurface() === "jianpu") item("PPTX（矢量）", () => exportPptx(app));
    item("MIDI", () => exportMidi(app));
    item("MusicXML", () => exportMusicXml(app));
    item("键盘谱 TXT", () => exportTextScore(app, "keyboard"));
    item("数字谱 TXT", () => exportTextScore(app, "number"));
    item("JPW 简谱（.jpwabc）", () => exportTextScore(app, "jpw"));
  }

  const footer = document.createElement("div");
  footer.className = "modal-footer";
  const cancel = document.createElement("button");
  cancel.textContent = "取消";
  cancel.onclick = close;
  footer.append(cancel);

  box.append(title, list, footer);
  overlay.append(box);
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  document.body.append(overlay);
}
