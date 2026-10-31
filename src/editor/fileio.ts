// .jpwabc encoding helpers. JP-Word writes UTF-16LE; we read BOM-aware and
// write UTF-16LE with a BOM for unambiguous round-tripping.

import { isTauri } from "@tauri-apps/api/core";
import { isTouchWorkspace } from "../bootstrap/device-mode";

export function isTauriRuntime(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

export function decodeJpwabc(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  // No BOM: heuristically detect UTF-16LE (ASCII-heavy text -> many 0x00 high bytes).
  let zeroHigh = 0;
  const sample = Math.min(bytes.length, 200);
  for (let i = 1; i < sample; i += 2) if (bytes[i] === 0) zeroHigh++;
  if (sample > 0 && zeroHigh / (sample / 2) > 0.3) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export interface BrowserWritableFile {
  write(data: Uint8Array | Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface BrowserFileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<BrowserWritableFile>;
}

interface BrowserDirectoryHandle {
  getFileHandle(name: string, options: { create: boolean }): Promise<BrowserFileHandle>;
}

export interface SaveFileOptions {
  defaultName: string;
  mime?: string;
  description?: string;
  /** Separate document and export folder histories in supporting browsers. */
  id?: string;
  startIn?: BrowserFileHandle;
}

export type SaveFileDestination =
  | { kind: "native"; path: string }
  | { kind: "browser"; handle: BrowserFileHandle };

export class LocalFileSaveUnavailableError extends Error {
  constructor(directory = false, zipAvailable = false) {
    super(`当前浏览器不支持选择本地${directory ? "文件夹" : "保存位置"}。请使用桌面版，或在 Chrome / Edge 的 HTTPS / localhost 页面中${directory ? "导出" : "保存"}。${zipAvailable ? "也可以勾选“打包为 ZIP”后选择文件位置。" : ""}本次操作没有保存文件。`);
    this.name = "LocalFileSaveUnavailableError";
  }
}

export function isFilePickerCancellation(reason: unknown): boolean {
  return typeof reason === "object" && reason !== null && "name" in reason && reason.name === "AbortError";
}

/** Invoke this directly from the click/key handler, before generating export data. */
export async function chooseSaveFile(options: SaveFileOptions): Promise<SaveFileDestination | null> {
  const extension = /\.[a-z0-9]{1,15}$/i.exec(options.defaultName)?.[0].toLowerCase();
  if (isTauriRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: options.defaultName,
      filters: extension ? [{ name: options.description ?? extension.slice(1).toUpperCase(), extensions: [extension.slice(1)] }] : undefined,
    });
    return path ? { kind: "native", path } : null;
  }
  const picker = (window as unknown as {
    showSaveFilePicker?: (options: unknown) => Promise<BrowserFileHandle>;
  }).showSaveFilePicker;
  if (typeof picker !== "function") throw new LocalFileSaveUnavailableError();
  const pickerOptions = {
    suggestedName: options.defaultName,
    id: options.id ?? "score-export",
    ...(options.startIn ? { startIn: options.startIn } : {}),
    types: extension ? [{
      description: options.description ?? extension.slice(1).toUpperCase(),
      accept: { [(options.mime ?? "application/octet-stream").split(";")[0]]: [extension] },
    }] : undefined,
  };
  try {
    return { kind: "browser", handle: await picker.call(window, pickerOptions) };
  } catch (reason) {
    if (isFilePickerCancellation(reason)) return null;
    // A rejected startIn hint must not mask permission/security or disk errors.
    if (!options.startIn || !(reason instanceof TypeError)) throw reason;
    const { startIn: _startIn, ...withoutHint } = pickerOptions;
    void _startIn;
    try {
      return { kind: "browser", handle: await picker.call(window, withoutHint) };
    } catch (retryReason) {
      if (isFilePickerCancellation(retryReason)) return null;
      throw retryReason;
    }
  }
}

/** The close is part of the write: callers may acknowledge saved bytes only after it succeeds. */
export async function writeBrowserFile(handle: BrowserFileHandle, bytes: Uint8Array | Blob): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (reason) {
    try { await writable.abort?.(); } catch { /* Preserve the actual write/close failure. */ }
    throw reason;
  }
}

export async function writeSaveFile(destination: SaveFileDestination, bytes: Uint8Array | Blob): Promise<void> {
  if (destination.kind === "native") {
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(destination.path, bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes);
  } else {
    await writeBrowserFile(destination.handle, bytes);
  }
}

export type SaveBytesSource = Uint8Array | Blob | (() => Uint8Array | Blob | Promise<Uint8Array | Blob>);

/** Pick once, then generate/write. A dismissed picker returns false and generates nothing. */
export async function saveBytes(
  source: SaveBytesSource,
  defaultName: string,
  mime = "application/octet-stream",
): Promise<boolean> {
  if (!isTauriRuntime() && isTouchWorkspace()
    && typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker !== "function") {
    const bytes = typeof source === "function" ? await source() : source;
    const { handoffMobileFile } = await import("./mobile-file");
    return await handoffMobileFile(bytes, defaultName, mime) !== "cancelled";
  }
  const destination = await chooseSaveFile({ defaultName, mime });
  if (!destination) return false;
  const bytes = typeof source === "function" ? await source() : source;
  await writeSaveFile(destination, bytes);
  return true;
}

async function confirmFileReplacements(names: readonly string[]): Promise<boolean> {
  const { showConfirmDialog } = await import("../ui/app-dialog");
  const preview = names.slice(0, 4).join("、") + (names.length > 4 ? " 等" : "");
  return showConfirmDialog({
    title: "覆盖已有 PNG",
    message: `所选文件夹已有 ${names.length} 个同名文件：${preview}。是否覆盖这些文件？`,
    confirmText: "覆盖并导出",
  });
}

/** Multi-page PNGs share one explicit directory selection, including in the desktop runtime. */
export async function saveByteFiles(
  files: ReadonlyArray<{ name: string; bytes: () => Uint8Array | Promise<Uint8Array> }>,
  confirmOverwrite: (names: readonly string[]) => Promise<boolean> = confirmFileReplacements,
): Promise<boolean> {
  if (!files.length) return false;
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const directory = await open({ directory: true, multiple: false, title: "选择 PNG 导出文件夹" });
    if (typeof directory !== "string") return false;
    const { join } = await import("@tauri-apps/api/path");
    const { exists } = await import("@tauri-apps/plugin-fs");
    const destinations = [];
    const conflicts: string[] = [];
    for (const file of files) {
      const path = await join(directory, file.name);
      destinations.push({ file, path });
      if (await exists(path)) conflicts.push(file.name);
    }
    if (conflicts.length && !await confirmOverwrite(conflicts)) return false;
    for (const { file, path } of destinations) {
      const bytes = await file.bytes();
      await writeSaveFile({ kind: "native", path }, bytes);
    }
    return true;
  }
  const picker = (window as unknown as {
    showDirectoryPicker?: (options: unknown) => Promise<BrowserDirectoryHandle>;
  }).showDirectoryPicker;
  if (typeof picker !== "function" && isTouchWorkspace()) {
    const base = files[0].name.replace(/(?:-第\d+页)?\.[^.]+$/, "");
    return saveBytes(async () => (await import("./file-archive")).archiveByteFiles(files), `${base}-PNG.zip`, "application/zip");
  }
  if (typeof picker !== "function") throw new LocalFileSaveUnavailableError(true,
    typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function");
  let directory: BrowserDirectoryHandle;
  try {
    directory = await picker.call(window, { id: "score-png-export", mode: "readwrite" });
  } catch (reason) {
    if (isFilePickerCancellation(reason)) return false;
    throw reason;
  }
  const conflicts: string[] = [];
  for (const file of files) {
    try {
      await directory.getFileHandle(file.name, { create: false });
      conflicts.push(file.name);
    } catch (reason) {
      if (!(typeof reason === "object" && reason !== null && "name" in reason && reason.name === "NotFoundError")) throw reason;
    }
  }
  if (conflicts.length && !await confirmOverwrite(conflicts)) return false;
  for (const file of files) {
    const bytes = await file.bytes();
    const handle = await directory.getFileHandle(file.name, { create: true });
    await writeBrowserFile(handle, bytes);
  }
  return true;
}

export function encodeJpwabc(text: string): Uint8Array {
  const units = text.length;
  const out = new Uint8Array(2 + units * 2);
  out[0] = 0xff; // BOM LE
  out[1] = 0xfe;
  for (let i = 0; i < units; i++) {
    const code = text.charCodeAt(i);
    out[2 + i * 2] = code & 0xff;
    out[2 + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return out;
}
