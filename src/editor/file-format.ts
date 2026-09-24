import type { SlashScoreKind } from "../slashscore";

/** File families accepted by the editor's shared import entry point. */
export type ImportFileKind =
  | "jpw"
  | "slash"
  | "midi"
  | "musicxml"
  | "abc"
  | "recognition"
  | "unknown";

export const IMPORT_FILE_EXTENSIONS = Object.freeze({
  jpw: ["jpwabc"],
  slash: ["txt", "keyscore", "numscore", "kps", "nps"],
  midi: ["mid", "midi"],
  musicxml: ["xml", "musicxml"],
  abc: ["abc"],
  recognition: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "pdf"],
} as const);

const extensionKind = new Map<string, Exclude<ImportFileKind, "unknown">>();
for (const [kind, extensions] of Object.entries(IMPORT_FILE_EXTENSIONS)) {
  for (const extension of extensions) {
    extensionKind.set(extension, kind as Exclude<ImportFileKind, "unknown">);
  }
}

/** Extensions shown by Open. Image/PDF recognition remains a drag/recognize workflow. */
export const SCORE_OPEN_EXTENSIONS = Object.freeze([
  ...IMPORT_FILE_EXTENSIONS.jpw,
  ...IMPORT_FILE_EXTENSIONS.slash,
  ...IMPORT_FILE_EXTENSIONS.midi,
  ...IMPORT_FILE_EXTENSIONS.musicxml,
  ...IMPORT_FILE_EXTENSIONS.abc,
]);

/** Tauri filters are case-sensitive on some platforms; preserve the legacy JPW variant. */
export const SCORE_OPEN_TAURI_EXTENSIONS = Object.freeze([
  "jpwabc",
  "JPWABC",
  ...SCORE_OPEN_EXTENSIONS.filter((extension) => extension !== "jpwabc"),
]);

export const SCORE_OPEN_DESCRIPTION = "简谱 / 斜杠谱 TXT / MIDI / MusicXML / ABC";

export const SCORE_OPEN_INPUT_ACCEPT = SCORE_OPEN_EXTENSIONS
  .map((extension) => `.${extension}`)
  .join(",");

export const SCORE_OPEN_PICKER_ACCEPT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "application/octet-stream": [".jpwabc", ".mid", ".midi"],
  "text/plain": [".txt", ".keyscore", ".numscore", ".kps", ".nps", ".abc"],
  "application/xml": [".xml", ".musicxml"],
});

export function fileExtension(path: string): string {
  const leaf = path.split(/[\\/]/).pop() ?? path;
  const clean = leaf.split(/[?#]/, 1)[0];
  const dot = clean.lastIndexOf(".");
  return dot >= 0 && dot < clean.length - 1 ? clean.slice(dot + 1).toLowerCase() : "";
}

export function fileStem(path: string): string {
  const leaf = path.split(/[\\/]/).pop() ?? path;
  const clean = leaf.split(/[?#]/, 1)[0];
  const dot = clean.lastIndexOf(".");
  const stem = (dot > 0 ? clean.slice(0, dot) : clean).trim();
  try {
    return decodeURIComponent(stem);
  } catch {
    return stem;
  }
}

export function replaceFileExtension(path: string, extension: string): string {
  const normalized = extension.startsWith(".") ? extension : `.${extension}`;
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  return `${dot > slash ? path.slice(0, dot) : path}${normalized}`;
}

export function classifyImportFile(path: string, mime = ""): ImportFileKind {
  const normalizedMime = mime.trim().toLowerCase();
  if (normalizedMime.startsWith("image/") || normalizedMime === "application/pdf") {
    return "recognition";
  }
  return extensionKind.get(fileExtension(path)) ?? "unknown";
}

export function isSupportedImportFile(path: string, mime = ""): boolean {
  return classifyImportFile(path, mime) !== "unknown";
}

export function isRecognitionFile(path: string, mime = ""): boolean {
  return classifyImportFile(path, mime) === "recognition";
}

export function isMidiFile(path: string): boolean {
  return classifyImportFile(path) === "midi";
}

export function isJpwFile(path: string): boolean {
  return classifyImportFile(path) === "jpw";
}

export function isSlashFile(path: string): boolean {
  return classifyImportFile(path) === "slash";
}

export function slashKindHint(path: string): SlashScoreKind | undefined {
  const extension = fileExtension(path);
  if (extension === "keyscore" || extension === "kps") return "keyboard";
  if (extension === "numscore" || extension === "nps") return "number";
  return undefined;
}

export interface EditableDocumentFileInfo {
  description: string;
  extension: ".jpwabc" | ".txt";
  mime: string;
}

export function editableDocumentFileInfo(format: "jpw" | SlashScoreKind): EditableDocumentFileInfo {
  return format === "jpw"
    ? { description: "JPW 简谱", extension: ".jpwabc", mime: "application/octet-stream" }
    : { description: "TXT 谱", extension: ".txt", mime: "text/plain" };
}
