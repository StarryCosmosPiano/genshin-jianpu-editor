import { SoundFont2 } from "soundfont2";
import { isTauriRuntime } from "./fileio";

const SOUNDFONT_DIR = "soundfonts";

const bundledSoundfontUrls = import.meta.glob<string>(
  "../assets/soundfonts/*.sf2",
  { eager: true, query: "?url", import: "default" },
);

export interface SoundfontCatalogEntry {
  /** Stable persisted identifier. Bundled and desktop entries both use the file name. */
  id: string;
  fileName: string;
  instruments: string[];
  bytes: Uint8Array;
  error?: string;
}

interface SoundfontBytes {
  fileName: string;
  bytes: Uint8Array;
}

function bundledEntries(): { fileName: string; url: string }[] {
  return Object.entries(bundledSoundfontUrls)
    .map(([sourcePath, url]) => ({
      fileName: sourcePath.split("/").pop() ?? sourcePath,
      url,
    }))
    .sort((a, b) => a.fileName.localeCompare(b.fileName, "zh-CN"));
}

async function fetchBundledSoundfonts(): Promise<SoundfontBytes[]> {
  const result: SoundfontBytes[] = [];
  for (const entry of bundledEntries()) {
    const response = await fetch(entry.url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${entry.fileName}: HTTP ${response.status}`);
    result.push({
      fileName: entry.fileName,
      bytes: new Uint8Array(await response.arrayBuffer()),
    });
  }
  return result;
}

async function ensureDesktopSoundfontDirectory(): Promise<void> {
  const { BaseDirectory, exists, mkdir, writeFile } = await import("@tauri-apps/plugin-fs");
  await mkdir(SOUNDFONT_DIR, { baseDir: BaseDirectory.AppLocalData, recursive: true });
  for (const bundled of bundledEntries()) {
    const relativePath = `${SOUNDFONT_DIR}/${bundled.fileName}`;
    if (await exists(relativePath, { baseDir: BaseDirectory.AppLocalData })) continue;
    const response = await fetch(bundled.url);
    if (!response.ok) throw new Error(`${bundled.fileName}: HTTP ${response.status}`);
    await writeFile(
      relativePath,
      new Uint8Array(await response.arrayBuffer()),
      { baseDir: BaseDirectory.AppLocalData },
    );
  }
}

async function readDesktopSoundfonts(): Promise<SoundfontBytes[]> {
  await ensureDesktopSoundfontDirectory();
  const { BaseDirectory, readDir, readFile } = await import("@tauri-apps/plugin-fs");
  const entries = await readDir(SOUNDFONT_DIR, { baseDir: BaseDirectory.AppLocalData });
  const result: SoundfontBytes[] = [];
  for (const entry of entries
    .filter((item) => item.isFile && /\.sf2$/i.test(item.name))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))) {
    result.push({
      fileName: entry.name,
      bytes: await readFile(
        `${SOUNDFONT_DIR}/${entry.name}`,
        { baseDir: BaseDirectory.AppLocalData },
      ),
    });
  }
  return result;
}

function parseCatalogEntry(source: SoundfontBytes): SoundfontCatalogEntry {
  try {
    const parsed = new SoundFont2(source.bytes);
    const instruments = [...new Set(
      parsed.instruments
        .map((instrument) => instrument.header.name.trim())
        .filter(Boolean),
    )];
    if (instruments.length === 0) throw new Error("音源中没有可播放的音色");
    return {
      id: source.fileName,
      fileName: source.fileName,
      instruments,
      bytes: source.bytes,
    };
  } catch (error) {
    return {
      id: source.fileName,
      fileName: source.fileName,
      instruments: [],
      bytes: source.bytes,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Read and parse the SF2 catalog once. Callers decide when to invoke this;
 * the app intentionally calls it only on startup and on manual refresh.
 */
export async function readSoundfontCatalog(): Promise<SoundfontCatalogEntry[]> {
  let sources: SoundfontBytes[];
  if (isTauriRuntime()) {
    try {
      sources = await readDesktopSoundfonts();
    } catch (error) {
      console.warn("读取桌面 SF2 音源目录失败，改用内置音源", error);
      sources = await fetchBundledSoundfonts();
    }
  } else {
    sources = await fetchBundledSoundfonts();
  }
  return sources.map(parseCatalogEntry);
}

export async function openSoundfontDirectory(): Promise<void> {
  if (!isTauriRuntime()) return;
  await ensureDesktopSoundfontDirectory();
  const [{ appLocalDataDir, join }, { openPath }] = await Promise.all([
    import("@tauri-apps/api/path"),
    import("@tauri-apps/plugin-opener"),
  ]);
  await openPath(await join(await appLocalDataDir(), SOUNDFONT_DIR));
}
