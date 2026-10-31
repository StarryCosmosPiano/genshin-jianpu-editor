import { createFileSheet, fileAction, throwIfFileTaskAborted, withFileTask } from "./file-task";

export type RecognitionFileSource = "files" | "photos" | "camera";

export function pickRecognitionFile(source: RecognitionFileSource): Promise<File | null> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = source === "files" ? "image/*,application/pdf,.pdf" : "image/*";
  if (source === "camera") input.setAttribute("capture", "environment");
  input.hidden = true;
  document.body.append(input);
  return new Promise(resolve => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (file: File | null) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("focus", focus);
      input.remove();
      resolve(file);
    };
    const focus = () => { timer = setTimeout(() => { if (!input.files?.length) finish(null); }, 1000); };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    window.addEventListener("focus", focus, { once: true });
    input.click();
  });
}

export function readBrowserFile(file: File, signal?: AbortSignal,
  progress?: (loaded: number, total: number) => void): Promise<Uint8Array> {
  throwIfFileTaskAborted(signal);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => reader.abort();
    reader.onprogress = event => progress?.(event.loaded, event.lengthComputable ? event.total : file.size);
    reader.onload = () => { cleanup(); resolve(new Uint8Array(reader.result as ArrayBuffer)); };
    reader.onerror = () => { cleanup(); reject(reader.error ?? new Error("文件读取失败")); };
    reader.onabort = () => { cleanup(); reject(new DOMException("已取消读取文件", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
    reader.readAsArrayBuffer(file);
  });
}

export async function readMobileFile(file: File): Promise<Uint8Array> {
  return withFileTask("读取文件", async task => {
    task.update({ completed: 0, total: file.size, message: `正在读取 ${file.name}` });
    const bytes = await readBrowserFile(file, task.signal, (completed, total) =>
      task.update({ completed, total, message: `正在读取 ${file.name}` }));
    throwIfFileTaskAborted(task.signal);
    return bytes;
  });
}

export function parseRecognitionPages(value: string, pageCount: number): number[] {
  const result = new Set<number>();
  const parts = value.trim().replace(/[，、]/g, ",").split(",");
  for (const part of parts) {
    const match = /^\s*(\d+)\s*(?:[-–—]\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new Error("请输入页码或范围，例如 1-3,5");
    const from = Number(match[1]), to = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > pageCount)
      throw new Error(`页码必须在 1–${pageCount} 之间，范围按从小到大填写`);
    for (let page = from; page <= to; page++) result.add(page);
  }
  return [...result].sort((a, b) => a - b);
}

export function chooseRecognitionPages(pageCount: number): Promise<number[] | null> {
  const sheet = createFileSheet("选择识别页码");
  const description = document.createElement("p");
  description.textContent = `PDF 共 ${pageCount} 页。将逐页识别并合并为一份乐谱，每页处理后释放原图。可随时取消。`;
  const label = document.createElement("label");
  label.className = "mobile-file-page-range";
  label.textContent = "识别页码";
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "text";
  input.value = pageCount === 1 ? "1" : `1-${pageCount}`;
  input.placeholder = "例如 1-3,5";
  label.append(input);
  sheet.body.append(description, label);
  return new Promise(resolve => {
    const finish = (pages: number[] | null) => { sheet.close(); resolve(pages); };
    sheet.footer.append(fileAction("取消", () => finish(null)), fileAction("开始识别", () => {
      try { finish(parseRecognitionPages(input.value, pageCount)); }
      catch (error) { sheet.message.textContent = error instanceof Error ? error.message : String(error); input.focus(); }
    }, true));
    sheet.onDismiss(() => finish(null));
  });
}
