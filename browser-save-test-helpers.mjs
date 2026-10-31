// Browser export tests keep the real encoder/rendering pipeline and replace
// only the OS file-picker boundary. Bytes become observable after close().
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox } from "playwright";

export async function launchSaveCheckBrowser() {
  const type = process.env.BROWSER_TYPE ?? "chromium";
  if (type !== "chromium" && type !== "firefox") {
    throw new Error("BROWSER_TYPE must be chromium or firefox");
  }
  const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
  return (type === "firefox" ? firefox : chromium).launch({
    headless: true,
    ...(executablePath ? { executablePath } : type === "chromium" ? { channel: "msedge" } : {}),
  });
}

export async function installSavePickerTestBridge(page) {
  const pending = [];
  let pickerSequence = 0;
  let unexpectedDownload = null;
  page.on("download", download => {
    unexpectedDownload = new Error(`Unexpected browser download: ${download.suggestedFilename()}`);
    for (const listener of pending.splice(0)) listener.reject(unexpectedDownload);
  });
  const directory = await mkdtemp(join(tmpdir(), "jianpu-save-check-"));
  let sequence = 0;
  await page.exposeBinding("__testFilePickerOpened", () => ++pickerSequence);
  await page.exposeBinding("__testFileSaveClosed", async (_source, payload) => {
    const bytes = Buffer.from(payload.base64, "base64");
    const path = join(directory, String(++sequence));
    await writeFile(path, bytes);
    const saved = { suggestedFilename: () => payload.name, path: async () => path,
      saveAs: (destination) => writeFile(destination, bytes) };
    const index = pending.findIndex(listener => listener.pickerId === undefined || listener.pickerId === payload.pickerId);
    if (index >= 0) pending.splice(index, 1)[0].resolve(saved);
  });
  const install = () => {
    window.__testSavePickerEvents = [];
    const requireUserActivation = () => {
      if (navigator.userActivation && !navigator.userActivation.isActive) {
        throw new DOMException("Save picker requires the current user gesture", "SecurityError");
      }
    };
    const handle = (name, pickerId) => ({ kind: "file", name,
      async createWritable() {
        let data = new Uint8Array();
        return {
          async write(value) {
            if (value instanceof Blob) data = new Uint8Array(await value.arrayBuffer());
            else if (typeof value === "string") data = new TextEncoder().encode(value);
            else if (value instanceof ArrayBuffer) data = new Uint8Array(value);
            else if (ArrayBuffer.isView(value)) data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
            else throw new TypeError("Unexpected saved payload");
          },
          async close() {
            let text = "";
            for (let start = 0; start < data.length; start += 16384) {
              text += String.fromCharCode(...data.subarray(start, start + 16384));
            }
            await window.__testFileSaveClosed({ name, pickerId, base64: btoa(text) });
          },
          async abort() { data = new Uint8Array(); },
        };
      },
    });
    window.showSaveFilePicker = async (options) => {
      requireUserActivation();
      window.__testSavePickerEvents.push({ kind: "file", name: options.suggestedName,
        id: options.id, active: navigator.userActivation?.isActive ?? null });
      return handle(options.suggestedName, await window.__testFilePickerOpened());
    };
    window.showDirectoryPicker = async () => {
      requireUserActivation();
      window.__testSavePickerEvents.push({ kind: "directory", active: navigator.userActivation?.isActive ?? null });
      const pickerId = await window.__testFilePickerOpened();
      const files = new Map();
      return { kind: "directory", name: "selected-export-folder",
        async getFileHandle(name, options) {
          if (files.has(name)) return files.get(name);
          if (!options?.create) throw new DOMException("No existing export in the chosen test directory", "NotFoundError");
          const file = handle(name, pickerId);
          files.set(name, file);
          return file;
        },
      };
    };
  };
  await page.addInitScript(install);
  await page.evaluate(install);
  const waitForSave = (timeout = 60000, pickerId) => {
      if (unexpectedDownload) return Promise.reject(unexpectedDownload);
      return new Promise((resolve, reject) => {
        const listener = {
          pickerId,
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); },
        };
        const timer = setTimeout(() => {
          const index = pending.indexOf(listener);
          if (index >= 0) pending.splice(index, 1);
          reject(new Error(`File save did not finish within ${timeout} ms`));
        }, timeout);
        pending.push(listener);
      });
  };
  return {
    next(timeout = 60000) {
      return waitForSave(timeout);
    },
    // PNG directory exports can continue writing later pages after the first
    // closes. Match the next chooser so those pages cannot satisfy a later PDF
    // or watermark export expectation.
    nextExport(timeout = 60000) {
      return waitForSave(timeout, pickerSequence + 1);
    },
    assertNoDownloads() {
      if (unexpectedDownload) throw unexpectedDownload;
    },
  };
}
