import type { OcrBackend } from "./ocr";
import type { Binary, RecognizedScore } from "./types";
import { throwIfFileTaskAborted, yieldFileTask } from "../editor/file-task";

/** Preserve each natural OCR strip while allowing cancellation between small batches. */
export function cancellableOcrBackend(backend: OcrBackend, signal: AbortSignal): OcrBackend {
  const batches = async <T, R>(items: T[], run: (batch: T[]) => Promise<R[]>, size = 8): Promise<R[]> => {
    const output: R[] = [];
    for (let index = 0; index < items.length; index += size) {
      await yieldFileTask(signal);
      output.push(...await run(items.slice(index, index + size)));
      throwIfFileTaskAborted(signal);
    }
    return output;
  };
  return {
    recognizeDigits: (bin, rects) => batches(rects, batch => backend.recognizeDigits(bin, batch), 16),
    ...(backend.recognizeTexts ? { recognizeTexts: (canvases: OffscreenCanvas[]) =>
      batches(canvases, batch => backend.recognizeTexts!(batch), 4) } : {}),
    ...(backend.recognizeTextsPos ? { recognizeTextsPos: (canvases: OffscreenCanvas[]) =>
      batches(canvases, batch => backend.recognizeTextsPos!(batch), 4) } : {}),
    ...(backend.rankDigits ? { rankDigits: (bin: Binary, rects: Parameters<NonNullable<OcrBackend["rankDigits"]>>[1]) =>
      batches(rects, batch => backend.rankDigits!(bin, batch), 16) } : {}),
    ...(backend.recognizeRegion ? { recognizeRegion: async (bin: Binary, region: Parameters<NonNullable<OcrBackend["recognizeRegion"]>>[1]) => {
      await yieldFileTask(signal);
      const result = await backend.recognizeRegion!(bin, region);
      throwIfFileTaskAborted(signal);
      return result;
    } } : {}),
  };
}

/** Music semantics are still emitted by the existing MusicXML serializer. */
export function mergeRecognizedPages(pages: readonly RecognizedScore[]): RecognizedScore {
  if (!pages.length) throw new Error("没有可合并的识别页面");
  return { ...pages[0], rows: pages.flatMap(page => page.rows), headerRegions: undefined, lyricRegions: undefined };
}
