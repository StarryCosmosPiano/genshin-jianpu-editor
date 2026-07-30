// Export: PNG (rasterize page SVG), MIDI (SMF), PPTX, Mixed PDF.
import type { App } from "./app";
import { scoreToMidi } from "../score/midi";
import { scoreToMusicXml } from "../score/musicxml-export";
import { buildPptx } from "./pptx";
import { isTauriRuntime, saveBytes } from "./fileio";
import { asset } from "../common/asset";
import { zipSync } from "fflate";

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
): Promise<HTMLCanvasElement> {
  const { width, height } = svgDimensions(svg);
  const clone = svg.cloneNode(true) as SVGSVGElement;
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
  const ctx = canvas.getContext("2d")!;
  if (!transparent) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
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
): Promise<Uint8Array> {
  return canvasToBytes(await svgToCanvas(svg, scale, transparent), "image/png");
}

function baseName(app: App): string {
  return (app.painter.score.title.split("\n")[0] || "未命名")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
}

export async function exportCurrentPagePng(app: App): Promise<void> {
  const wrap = app.pageEls[app.pageIndex];
  if (!wrap) return;
  const svg = wrap.querySelector("svg") as SVGSVGElement | null;
  if (!svg) return;
  const bytes = await svgToBytes(svg, 2, true);
  await saveBytes(bytes, `${baseName(app)}-第${app.pageIndex + 1}页.png`, "image/png");
}

interface PngExportOptions {
  zip: boolean;
  transparent: boolean;
}

function choosePngExportOptions(pageCount: number): Promise<PngExportOptions | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const box = document.createElement("div");
    box.className = "modal-box";
    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = `导出 PNG（共 ${pageCount} 页）`;

    const transparent = document.createElement("input");
    transparent.type = "checkbox";
    transparent.checked = true;
    const transparentRow = document.createElement("label");
    transparentRow.className = "modal-row";
    transparentRow.append(
      Object.assign(document.createElement("span"), { textContent: "透明背景" }),
      transparent,
    );

    const zip = document.createElement("input");
    zip.type = "checkbox";
    zip.checked = pageCount > 1;
    const zipRow = document.createElement("label");
    zipRow.className = "modal-row";
    zipRow.append(
      Object.assign(document.createElement("span"), { textContent: "压缩为一个 ZIP 文件" }),
      zip,
    );
    const hint = document.createElement("div");
    hint.className = "modal-hint";
    hint.textContent = "关闭 ZIP 时每一页会分别保存；浏览器可能会询问是否允许下载多个文件。";

    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    const confirm = document.createElement("button");
    confirm.textContent = "导出";
    footer.append(cancel, confirm);
    box.append(title, transparentRow, zipRow, hint, footer);
    overlay.append(box);
    document.body.append(overlay);

    const close = (value: PngExportOptions | null) => {
      overlay.remove();
      resolve(value);
    };
    cancel.onclick = () => close(null);
    confirm.onclick = () => close({
      zip: zip.checked,
      transparent: transparent.checked,
    });
    overlay.onclick = (event) => {
      if (event.target === overlay) close(null);
    };
  });
}

function scorePageSvgs(app: App): Array<{ page: number; svg: SVGSVGElement }> {
  return app.pageEls.flatMap((wrap, page) => {
    const svg = wrap.querySelector("svg") as SVGSVGElement | null;
    return svg ? [{ page, svg }] : [];
  });
}

export async function exportAllPagesPng(app: App): Promise<void> {
  const pages = scorePageSvgs(app);
  if (pages.length === 0) throw new Error("当前没有可导出的谱面页面");
  const options = await choosePngExportOptions(pages.length);
  if (!options) return;

  const name = baseName(app);
  const files: Record<string, Uint8Array> = {};
  for (const page of pages) {
    files[`${name}-第${page.page + 1}页.png`] = await svgToBytes(
      page.svg,
      2,
      options.transparent,
    );
  }
  if (options.zip) {
    await saveBytes(
      zipSync(files, { level: 6 }),
      `${name}-PNG.zip`,
      "application/zip",
    );
    return;
  }
  for (const [filename, bytes] of Object.entries(files)) {
    await saveBytes(bytes, filename, "image/png");
  }
}

interface PdfRasterPage {
  jpeg: Uint8Array;
  pixelWidth: number;
  pixelHeight: number;
  pageWidth: number;
  pageHeight: number;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function buildRasterPdf(pages: readonly PdfRasterPage[]): Uint8Array {
  const encoder = new TextEncoder();
  const text = (value: string) => encoder.encode(value);
  const objectCount = 2 + pages.length * 3;
  const offsets = new Array<number>(objectCount + 1).fill(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const append = (chunk: Uint8Array) => {
    chunks.push(chunk);
    length += chunk.byteLength;
  };
  const writeObject = (number: number, body: readonly Uint8Array[]) => {
    offsets[number] = length;
    append(text(`${number} 0 obj\n`));
    for (const chunk of body) append(chunk);
    append(text("\nendobj\n"));
  };

  append(text("%PDF-1.4\n%JPEDITOR\n"));
  writeObject(1, [text("<< /Type /Catalog /Pages 2 0 R >>")]);
  const pageNumbers = pages.map((_page, index) => 3 + index * 3);
  writeObject(2, [text(
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageNumbers.map((n) => `${n} 0 R`).join(" ")}] >>`,
  )]);

  pages.forEach((page, index) => {
    const pageObject = 3 + index * 3;
    const contentObject = pageObject + 1;
    const imageObject = pageObject + 2;
    const width = Math.round(page.pageWidth * 1000) / 1000;
    const height = Math.round(page.pageHeight * 1000) / 1000;
    writeObject(pageObject, [text(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] `
      + `/Resources << /ProcSet [/PDF /ImageC] /XObject << /Im0 ${imageObject} 0 R >> >> `
      + `/Contents ${contentObject} 0 R >>`,
    )]);
    const content = text(`q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ`);
    writeObject(contentObject, [
      text(`<< /Length ${content.byteLength} >>\nstream\n`),
      content,
      text("\nendstream"),
    ]);
    writeObject(imageObject, [
      text(
        `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} `
        + `/Height ${page.pixelHeight} /ColorSpace /DeviceRGB `
        + `/BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.byteLength} >>\nstream\n`,
      ),
      page.jpeg,
      text("\nendstream"),
    ]);
  });

  const xrefOffset = length;
  append(text(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`));
  for (let object = 1; object <= objectCount; object++) {
    append(text(`${String(offsets[object]).padStart(10, "0")} 00000 n \n`));
  }
  append(text(
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\n`
    + `startxref\n${xrefOffset}\n%%EOF\n`,
  ));
  return concatBytes(chunks);
}

export async function exportScorePdf(app: App): Promise<void> {
  const pages = scorePageSvgs(app);
  if (pages.length === 0) throw new Error("当前没有可导出的谱面页面");
  const rasterPages: PdfRasterPage[] = [];
  for (const page of pages) {
    const { width, height } = svgDimensions(page.svg);
    const canvas = await svgToCanvas(page.svg, 2, false);
    rasterPages.push({
      jpeg: await canvasToBytes(canvas, "image/jpeg", 0.96),
      pixelWidth: canvas.width,
      pixelHeight: canvas.height,
      pageWidth: width,
      pageHeight: height,
    });
  }
  await saveBytes(
    buildRasterPdf(rasterPages),
    `${baseName(app)}.pdf`,
    "application/pdf",
  );
}

export async function exportMidi(app: App): Promise<void> {
  const bytes = scoreToMidi(app.painter.score, { partVolumes: app.partVolumes });
  await saveBytes(bytes, `${baseName(app)}.mid`, "audio/midi");
}

export async function exportMusicXml(app: App): Promise<void> {
  const text = app.mode === "mixed" && app.mixedXmlText
    ? app.mixedXmlText
    : scoreToMusicXml(app.painter.score);
  await saveBytes(
    new TextEncoder().encode(text),
    `${baseName(app)}.musicxml`,
    "application/vnd.recordare.musicxml+xml",
  );
}

export async function exportPptx(app: App): Promise<void> {
  const bytes = await buildPptx(app.painter);
  await saveBytes(
    bytes,
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
  const result = app.exportTextDocument(
    format,
    options.includeVoiceMarkers,
    options.includeMetadata,
  );
  await saveBytes(result.bytes, result.name, result.mime);
}

/** Export mixed-mode pages to PDF via Tauri svg2pdf command or browser print dialog. */
export async function exportMixedPdf(app: App): Promise<void> {
  if (!app["_mixedPainter"] || app.mode !== "mixed") return;
  const painter = app["_mixedPainter"] as import("../mixed/painter").MixedPainter;
  const wPt = painter.pageWidthPt;
  const hPt = painter.pageHeightPt;

  if (isTauriRuntime()) {
    // Tauri path: serialize SVGs and invoke Rust export_pdf command
    const { invoke } = await import("@tauri-apps/api/core");
    const { save } = await import("@tauri-apps/plugin-dialog");
    const title = painter.title || "混排";
    const outPath = await save({ defaultPath: `${title}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!outPath) return;
    const pages: string[] = [];
    for (let i = 0; i < painter.pageCount; i++) {
      const svg = painter.renderPage(i);
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      svg.setAttribute("width", `${wPt}pt`);
      svg.setAttribute("height", `${hPt}pt`);
      pages.push(new XMLSerializer().serializeToString(svg));
    }
    await invoke("export_pdf_cmd", { pagesSvg: pages, widthPt: wPt, heightPt: hPt, outPath });
  } else {
    // Browser path: open print window with embedded font
    const bravuraUrl = await bravuraDataUrl();
    const win = window.open("", "_blank", "width=800,height=900");
    if (!win) return;
    const d = win.document;
    const wMm = (wPt * 25.4 / 72).toFixed(1);
    const hMm = (hPt * 25.4 / 72).toFixed(1);
    d.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
@font-face{font-family:"Bravura";src:url("${bravuraUrl}") format("woff2");}
@page{size:${wMm}mm ${hMm}mm;margin:0}
body{margin:0;padding:0;background:#fff}
svg{display:block;width:100%;page-break-after:always}
</style></head><body>`);
    for (let i = 0; i < painter.pageCount; i++) {
      const svg = painter.renderPage(i);
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
        console.error(e);
        window.alert(`导出失败：${e instanceof Error ? e.message : String(e)}`);
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
    item("PPTX（矢量）", () => exportPptx(app));
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
