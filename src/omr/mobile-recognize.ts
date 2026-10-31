import { decodeToBinary, isPdf, openRecognitionPdf, type RecognitionPdf } from "./decode";
import { recognizeJianpu } from "./jianpu";
import { toMusicXml } from "./musicxml";
import { paddleOcrBackend } from "./paddleocr";
import type { Binary, RecognizedScore } from "./types";
import { cancellableOcrBackend, mergeRecognizedPages } from "./recognition-pages";
import { chooseRecognitionPages } from "../editor/mobile-import";
import { throwIfFileTaskAborted, withFileTask, yieldFileTask } from "../editor/file-task";

export interface MobileRecognitionResult {
  musicxml: string;
  pageCount: number;
  /** One-page results retain the normal recognition overlay. Multi-page work releases original images. */
  overlay?: { bin: Binary; score: RecognizedScore };
}

export async function recognizeMobilePages(bytes: Uint8Array, mime?: string): Promise<MobileRecognitionResult | null> {
  let pdf: RecognitionPdf | null = null;
  try {
    if (isPdf(bytes, mime)) {
      pdf = await withFileTask("读取 PDF", async task => {
        task.update({ completed: 0, total: 1, message: "正在读取 PDF 页数…" });
        const source = await openRecognitionPdf(bytes);
        if (task.signal.aborted) { await source.dispose(); throwIfFileTaskAborted(task.signal); }
        return source;
      });
    }
    const selected = pdf && pdf.pageCount > 1 ? await chooseRecognitionPages(pdf.pageCount) : [1];
    if (!selected) return null;
    return await withFileTask("识别简谱", async task => {
      const pages: RecognizedScore[] = [];
      let overlay: MobileRecognitionResult["overlay"];
      const backend = cancellableOcrBackend(paddleOcrBackend(), task.signal);
      for (let index = 0; index < selected.length; index++) {
        await yieldFileTask(task.signal);
        task.update({ completed: index, total: selected.length, message: `正在读取第 ${selected[index]} 页（${index + 1}/${selected.length}）…` });
        const bin = pdf ? await pdf.decodePage(selected[index]) : await decodeToBinary(bytes, mime);
        throwIfFileTaskAborted(task.signal);
        task.update({ completed: index, total: selected.length, message: `正在识别第 ${selected[index]} 页的音符、歌词与标题…` });
        const score = await recognizeJianpu(bin, backend);
        throwIfFileTaskAborted(task.signal);
        pages.push(score);
        if (selected.length === 1) overlay = { bin, score };
        task.update({ completed: index + 1, total: selected.length, message: `已识别 ${index + 1}/${selected.length} 页` });
      }
      const score = pages.length === 1 ? pages[0] : mergeRecognizedPages(pages);
      if (!score.rows.some(row => row.nums.length)) throw new Error("没有识别到可用的简谱音符，请选择更清晰的乐谱图片。");
      throwIfFileTaskAborted(task.signal);
      return { musicxml: toMusicXml(score), pageCount: selected.length, overlay };
    });
  } finally { await pdf?.dispose(); }
}
