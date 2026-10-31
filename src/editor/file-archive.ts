import { Zip, ZipPassThrough, zip, type Zippable } from "fflate";

export interface ArchiveFile { name: string; bytes: () => Uint8Array | Promise<Uint8Array> }
export interface ArchiveOptions {
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number, name: string) => void;
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
}

/** PNGs are already compressed. Store one page at a time without another full input map. */
export async function archiveByteFiles(files: readonly ArchiveFile[], options: ArchiveOptions = {}): Promise<Blob> {
  const chunks: BlobPart[] = [];
  let error: Error | null = null;
  let ended = false;
  const archive = new Zip((reason, data, final) => {
    if (reason) { error = reason; return; }
    chunks.push(data as BlobPart);
    ended = final;
  });
  try {
    for (let index = 0; index < files.length; index++) {
      check(options.signal);
      const file = files[index];
      options.onProgress?.(index, files.length, file.name);
      const bytes = await file.bytes();
      check(options.signal);
      const entry = new ZipPassThrough(file.name);
      archive.add(entry);
      entry.push(bytes, true);
      if (error) throw error;
      options.onProgress?.(index + 1, files.length, file.name);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    check(options.signal);
    archive.end();
    if (error) throw error;
    if (!ended) throw new Error("ZIP 文件未能完成，请重试");
    return new Blob(chunks, { type: "application/zip" });
  } finally {
    archive.terminate();
    chunks.length = 0;
  }
}

/** Existing fflate worker compression is cancellable without adding a dependency. */
export function compressArchive(files: Zippable, signal?: AbortSignal): Promise<Uint8Array> {
  check(signal);
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      terminate();
      reject(new DOMException("操作已取消", "AbortError"));
    };
    const terminate = zip(files, { level: 6 }, (error, data) => {
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (signal?.aborted) reject(new DOMException("操作已取消", "AbortError"));
      else resolve(data);
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
