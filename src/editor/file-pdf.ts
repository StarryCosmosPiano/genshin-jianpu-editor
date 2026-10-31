export interface PdfRasterPage {
  jpeg: Uint8Array;
  pixelWidth: number;
  pixelHeight: number;
  pageWidth: number;
  pageHeight: number;
}

/** Append encoded pages; raw canvases can be released immediately after each call. */
export class RasterPdfWriter {
  private readonly encoder = new TextEncoder();
  private readonly objectCount: number;
  private readonly offsets: number[];
  private chunks: BlobPart[] = [];
  private length = 0;
  private written = 0;
  private finished = false;

  constructor(private readonly pageCount: number) {
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error("PDF 至少需要一页");
    this.objectCount = 2 + pageCount * 3;
    this.offsets = new Array<number>(this.objectCount + 1).fill(0);
    this.append(this.text("%PDF-1.4\n%JPEDITOR\n"));
    this.writeObject(1, [this.text("<< /Type /Catalog /Pages 2 0 R >>")]);
    const pageNumbers = Array.from({ length: pageCount }, (_, index) => 3 + index * 3);
    this.writeObject(2, [this.text(`<< /Type /Pages /Count ${pageCount} /Kids [${pageNumbers.map(number => `${number} 0 R`).join(" ")}] >>`)]);
  }

  private text(value: string): Uint8Array { return this.encoder.encode(value); }
  private append(chunk: Uint8Array): void { this.chunks.push(chunk as BlobPart); this.length += chunk.byteLength; }
  private writeObject(number: number, body: readonly Uint8Array[]): void {
    this.offsets[number] = this.length;
    this.append(this.text(`${number} 0 obj\n`));
    body.forEach(chunk => this.append(chunk));
    this.append(this.text("\nendobj\n"));
  }

  addPage(page: PdfRasterPage): void {
    if (this.finished || this.written >= this.pageCount) throw new Error("PDF 页面数量不匹配");
    const pageObject = 3 + this.written++ * 3;
    const contentObject = pageObject + 1, imageObject = pageObject + 2;
    const width = Math.round(page.pageWidth * 1000) / 1000;
    const height = Math.round(page.pageHeight * 1000) / 1000;
    this.writeObject(pageObject, [this.text(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] `
      + `/Resources << /ProcSet [/PDF /ImageC] /XObject << /Im0 ${imageObject} 0 R >> >> /Contents ${contentObject} 0 R >>`,
    )]);
    const content = this.text(`q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ`);
    this.writeObject(contentObject, [this.text(`<< /Length ${content.byteLength} >>\nstream\n`), content, this.text("\nendstream")]);
    this.writeObject(imageObject, [this.text(
      `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} /ColorSpace /DeviceRGB `
      + `/BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.byteLength} >>\nstream\n`,
    ), page.jpeg, this.text("\nendstream")]);
  }

  finish(): Blob {
    if (this.finished || this.written !== this.pageCount) throw new Error("PDF 尚未完成，不能导出部分文件");
    this.finished = true;
    const xrefOffset = this.length;
    this.append(this.text(`xref\n0 ${this.objectCount + 1}\n0000000000 65535 f \n`));
    for (let object = 1; object <= this.objectCount; object++) {
      this.append(this.text(`${String(this.offsets[object]).padStart(10, "0")} 00000 n \n`));
    }
    this.append(this.text(`trailer\n<< /Size ${this.objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
    const result = new Blob(this.chunks, { type: "application/pdf" });
    this.chunks = [];
    return result;
  }

  dispose(): void { this.finished = true; this.chunks = []; }
}
