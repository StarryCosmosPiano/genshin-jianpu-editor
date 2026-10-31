import assert from "node:assert/strict";
import { defaultKeymap } from "@codemirror/commands";
import { chooseSaveFile, saveBytes, saveByteFiles, writeBrowserFile,
  LocalFileSaveUnavailableError, type BrowserFileHandle } from "./src/editor/fileio";
import { DocumentSaveSession } from "./src/editor/save-session";
import { handleDocumentSaveShortcut, isReservedDocumentSaveChord, wireDocumentSaveShortcuts } from "./src/editor/document-save-shortcut";

const checks: string[] = [];
async function check(name: string, run: () => unknown | Promise<unknown>): Promise<void> {
  await run(); checks.push(name);
}
const bytes = new Uint8Array([0, 255, 1, 127]);
const calls: string[] = [];
let failAt = "";
let closeGate: Promise<void> | null = null;
const saved = new Map<string, number[]>();
function file(name: string): BrowserFileHandle {
  return { name, getFile: async () => { throw new Error("not used"); }, createWritable: async () => {
    calls.push(`open:${name}`);
    if (failAt === "open") throw new Error("open failed");
    let pending: number[] = [];
    return {
      write: async data => {
        calls.push(`write:${name}`);
        if (failAt === "write") throw new Error("write failed");
        assert(data instanceof Uint8Array); pending = [...data];
      },
      close: async () => {
        calls.push(`close:${name}`);
        if (closeGate) await closeGate;
        if (failAt === "close") throw new Error("close failed");
        saved.set(name, pending);
      },
      abort: async () => { calls.push(`abort:${name}`); if (failAt === "write") throw new Error("secondary abort error"); },
    };
  } };
}

type Picker = (options: Record<string, unknown>) => Promise<BrowserFileHandle>;
const windowMock: { showSaveFilePicker?: Picker; showDirectoryPicker?: (options: Record<string, unknown>) => Promise<unknown>;
  __TAURI_INTERNALS__?: { invoke: (command: string, args: unknown, options: unknown) => Promise<unknown> } } = {};
Object.defineProperty(globalThis, "window", { value: windowMock, configurable: true });
Object.defineProperty(globalThis, "document", { value: {
  createElement: () => assert.fail("Saving must never silently create a download link"),
  dispatchEvent: () => true,
}, configurable: true });
Object.defineProperty(globalThis, "isTauri", { value: false, configurable: true, writable: true });

await check("file picker runs synchronously before any export generation", async () => {
  let select!: (handle: BrowserFileHandle) => void;
  windowMock.showSaveFilePicker = function () {
    assert.equal(this, windowMock, "picker keeps the Window receiver");
    calls.push("picker"); return new Promise(resolve => { select = resolve; });
  };
  const pending = saveBytes(async () => { calls.push("generate"); await Promise.resolve(); return bytes; }, "score.mid", "audio/midi");
  assert.deepEqual(calls, ["picker"]);
  select(file("chosen.mid")); assert.equal(await pending, true);
  assert.deepEqual(calls, ["picker", "generate", "open:chosen.mid", "write:chosen.mid", "close:chosen.mid"]);
  assert.deepEqual(saved.get("chosen.mid"), [...bytes]); calls.length = 0;
});

await check("picker cancellation generates and writes nothing", async () => {
  windowMock.showSaveFilePicker = async () => { throw { name: "AbortError" }; };
  assert.equal(await saveBytes(() => assert.fail("cancelled export generated data"), "score.png"), false);
  assert.deepEqual(calls, []);
});

await check("missing browser API fails explicitly without downloading", async () => {
  delete windowMock.showSaveFilePicker;
  await assert.rejects(saveBytes(bytes, "score.txt"), reason => reason instanceof LocalFileSaveUnavailableError
    && /桌面版/.test(reason.message) && /Chrome \/ Edge/.test(reason.message));
});

for (const [name, mime, extension] of [
  ["score.png", "image/png", ".png"], ["score-PNG.zip", "application/zip", ".zip"],
  ["score.pdf", "application/pdf", ".pdf"], ["score.mid", "audio/midi", ".mid"],
  ["score.musicxml", "application/vnd.recordare.musicxml+xml", ".musicxml"],
  ["score.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
  ["score.jpwabc", "application/octet-stream", ".jpwabc"], ["score.txt", "text/plain;charset=utf-8", ".txt"],
]) await check(`save picker supplies the ${extension} file type`, async () => {
  windowMock.showSaveFilePicker = async options => {
    assert.equal(options.suggestedName, name); assert.equal(options.id, "score-export");
    assert.deepEqual((options.types as Array<{ accept: unknown }>)[0].accept, { [mime.split(";")[0]]: [extension] });
    return file(name);
  };
  assert.equal((await chooseSaveFile({ defaultName: name, mime }))?.kind, "browser");
});

await check("document picker keeps its own folder history and hint", async () => {
  const hint = file("original.txt");
  windowMock.showSaveFilePicker = async options => {
    assert.equal(options.id, "score-document"); assert.equal(options.startIn, hint); return file("saved.txt");
  };
  await chooseSaveFile({ defaultName: "saved.txt", id: "score-document", startIn: hint });
});

await check("incompatible startIn gets one narrow TypeError retry", async () => {
  let count = 0;
  windowMock.showSaveFilePicker = async options => {
    count++;
    if (count === 1) { assert(options.startIn); throw new TypeError("unsupported hint"); }
    assert.equal(options.startIn, undefined); return file("saved.txt");
  };
  assert((await chooseSaveFile({ defaultName: "saved.txt", startIn: file("original.txt") }))?.kind === "browser");
  assert.equal(count, 2);
});

await check("security/permission error is not retried or converted to a download", async () => {
  let count = 0;
  const error = new DOMException("No active user gesture", "SecurityError");
  windowMock.showSaveFilePicker = async () => { count++; throw error; };
  await assert.rejects(chooseSaveFile({ defaultName: "score.txt", startIn: file("original.txt") }), reason => reason === error);
  assert.equal(count, 1);
});

for (const stage of ["open", "write", "close"]) await check(`${stage} failure never reports a completed write`, async () => {
  calls.length = 0; failAt = stage;
  await assert.rejects(writeBrowserFile(file(`failed-${stage}`), bytes), new RegExp(`${stage} failed`));
  assert.equal(saved.has(`failed-${stage}`), false);
  if (stage !== "open") assert(calls.includes(`abort:failed-${stage}`));
  failAt = "";
});

await check("save awaits close before acknowledging a captured document", async () => {
  const session = new DocumentSaveSession();
  const content = (text: string) => ({ text, format: "keyboard", options: {} });
  session.begin(content("initial"));
  const snapshot = session.capture(content("captured"));
  let release!: () => void;
  closeGate = new Promise(resolve => { release = resolve; });
  let completed = false;
  const writing = writeBrowserFile(file("deferred"), bytes).then(() => { session.acknowledge(snapshot); completed = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(completed, false); assert.equal(session.isDirty(content("captured")), true);
  release(); await writing; closeGate = null;
  assert.equal(session.isDirty(content("captured")), false);
  assert.equal(session.isDirty(content("newer edit")), true);
});

await check("generation failure never opens or truncates the chosen existing file", async () => {
  calls.length = 0;
  windowMock.showSaveFilePicker = async () => file("existing.txt");
  await assert.rejects(saveBytes(() => { throw new Error("conversion failed"); }, "score.txt"), /conversion failed/);
  assert.deepEqual(calls, []);
});

await check("export picker never mutates the caller's document target", async () => {
  const documentHandle = file("document.jpwabc");
  windowMock.showSaveFilePicker = async () => file("export.mid");
  await saveBytes(bytes, "score.mid");
  await writeBrowserFile(documentHandle, new Uint8Array([4, 5]));
  assert.deepEqual(saved.get("export.mid"), [...bytes]);
  assert.deepEqual(saved.get("document.jpwabc"), [4, 5]);
});

const pageFiles = [1, 2, 3].map(page => ({ name: `page-${page}.png`, bytes: () => new Uint8Array([page]) }));
await check("multi-page PNG uses one read/write directory picker and no file pickers", async () => {
  let count = 0;
  windowMock.showSaveFilePicker = async () => assert.fail("unexpected per-page picker");
  windowMock.showDirectoryPicker = async function (options) {
    assert.equal(this, windowMock); assert.equal(options.mode, "readwrite"); count++;
    return { getFileHandle: async (name: string, options: { create: boolean }) => {
      if (!options.create) throw new DOMException("No such file", "NotFoundError");
      return file(name);
    } };
  };
  assert.equal(await saveByteFiles(pageFiles), true); assert.equal(count, 1);
  for (let page = 1; page <= 3; page++) assert.deepEqual(saved.get(`page-${page}.png`), [page]);
});

await check("cancelled folder picker generates no pages", async () => {
  windowMock.showDirectoryPicker = async () => { throw new DOMException("cancelled", "AbortError"); };
  assert.equal(await saveByteFiles([{ name: "page.png", bytes: () => assert.fail("generated after cancel") }]), false);
});

await check("missing directory API gives the ZIP/file alternative explicitly", async () => {
  delete windowMock.showDirectoryPicker;
  await assert.rejects(saveByteFiles(pageFiles), /ZIP/);
});

for (const accept of [false, true]) await check(`browser directory overwrite ${accept ? "acceptance" : "cancellation"} is checked once before any encoding`, async () => {
  let encoded = 0;
  let created = 0;
  let confirmed = 0;
  const checked: string[] = [];
  windowMock.showDirectoryPicker = async () => ({ getFileHandle: async (name: string, options: { create: boolean }) => {
    if (!options.create) {
      checked.push(name);
      if (name !== "page-2.png") throw new DOMException("No file", "NotFoundError");
    } else created++;
    return file(name);
  } });
  const result = await saveByteFiles(pageFiles.map(page => ({ name: page.name, bytes: () => { encoded++; return page.bytes(); } })), async names => {
    confirmed++; assert.deepEqual(names, ["page-2.png"]); assert.deepEqual(checked, pageFiles.map(page => page.name));
    assert.equal(encoded, 0); assert.equal(created, 0); return accept;
  });
  assert.equal(result, accept); assert.equal(confirmed, 1); assert.equal(encoded, accept ? 3 : 0); assert.equal(created, accept ? 3 : 0);
});

await check("directory preflight permission errors do not get mistaken for absent files", async () => {
  windowMock.showDirectoryPicker = async () => ({ getFileHandle: async () => { throw new DOMException("denied", "NotAllowedError"); } });
  await assert.rejects(saveByteFiles([{ name: "page.png", bytes: () => assert.fail("permission error encoded data") }],
    async () => assert.fail("permission error prompted for overwrite")), /denied/);
});

await check("native file picker and write protocol retain the chosen path", async () => {
  Object.assign(globalThis, { isTauri: true });
  const nativeCalls: string[] = [];
  windowMock.__TAURI_INTERNALS__ = { invoke: async (command, args, options) => {
    nativeCalls.push(command);
    if (command === "plugin:dialog|save") {
      const config = (args as { options: { defaultPath: string; filters: unknown } }).options;
      assert.equal(config.defaultPath, "score.mid");
      assert.deepEqual(config.filters, [{ name: "MID", extensions: ["mid"] }]);
      return "D:\\scores\\chosen.mid";
    }
    assert.equal(command, "plugin:fs|write_file");
    assert.deepEqual([...args as Uint8Array], [...bytes]);
    assert.equal(decodeURIComponent((options as { headers: { path: string } }).headers.path), "D:\\scores\\chosen.mid");
    return undefined;
  } };
  assert.equal(await saveBytes(bytes, "score.mid", "audio/midi"), true);
  assert.deepEqual(nativeCalls, ["plugin:dialog|save", "plugin:fs|write_file"]);
});

await check("native cancellation performs no conversion/write", async () => {
  windowMock.__TAURI_INTERNALS__ = { invoke: async command => { assert.equal(command, "plugin:dialog|save"); return null; } };
  assert.equal(await saveBytes(() => assert.fail("native cancellation generated data"), "score.pdf"), false);
});

await check("native multi-page PNG selects one directory then writes every page", async () => {
  let picks = 0;
  const nativeWrites: string[] = [];
  windowMock.__TAURI_INTERNALS__ = { invoke: async (command, args, options) => {
    if (command === "plugin:dialog|open") {
      const config = (args as { options: { directory: boolean; multiple: boolean } }).options;
      assert.equal(config.directory, true); assert.equal(config.multiple, false); picks++; return "D:\\scores";
    }
    if (command === "plugin:path|join") return (args as { paths: string[] }).paths.join("\\");
    if (command === "plugin:fs|exists") return false;
    assert.equal(command, "plugin:fs|write_file");
    nativeWrites.push(decodeURIComponent((options as { headers: { path: string } }).headers.path));
    return undefined;
  } };
  assert.equal(await saveByteFiles(pageFiles), true); assert.equal(picks, 1);
  assert.deepEqual(nativeWrites, pageFiles.map(page => `D:\\scores\\${page.name}`));
  Object.assign(globalThis, { isTauri: false });
});

for (const accept of [false, true]) await check(`native directory overwrite ${accept ? "acceptance" : "cancellation"} checks all destinations before encoding`, async () => {
  Object.assign(globalThis, { isTauri: true });
  let confirmed = 0, encoded = 0, writes = 0, inspected = 0;
  windowMock.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    if (command === "plugin:dialog|open") return "D:\\scores";
    if (command === "plugin:path|join") return (args as { paths: string[] }).paths.join("\\");
    if (command === "plugin:fs|exists") { inspected++; return (args as { path: string }).path.endsWith("page-2.png"); }
    assert.equal(command, "plugin:fs|write_file"); writes++; return undefined;
  } };
  assert.equal(await saveByteFiles(pageFiles.map(page => ({ name: page.name, bytes: () => { encoded++; return page.bytes(); } })), async names => {
    confirmed++; assert.deepEqual(names, ["page-2.png"]); assert.equal(inspected, 3); assert.equal(encoded, 0); assert.equal(writes, 0); return accept;
  }), accept);
  assert.equal(confirmed, 1); assert.equal(encoded, accept ? 3 : 0); assert.equal(writes, accept ? 3 : 0);
  Object.assign(globalThis, { isTauri: false });
});

function key(options: Partial<KeyboardEvent> = {}): KeyboardEvent & { prevented: boolean; stopped: boolean } {
  return { key: "s", code: "KeyS", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
    repeat: false, isComposing: false, prevented: false, stopped: false, getModifierState: () => false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; },
    ...options } as unknown as KeyboardEvent & { prevented: boolean; stopped: boolean };
}

for (const context of ["text", "selection", "input", "staff-input", "toolbar"]) {
  for (const mod of ["ctrlKey", "metaKey"] as const) await check(`${context}: ${mod} + S saves the document and blocks browser save`, () => {
    let saves = 0;
    const event = key({ ctrlKey: false, [mod]: true });
    assert.equal(handleDocumentSaveShortcut(event, { saveFile: () => { saves++; }, saveFileAs: () => assert.fail("wrong command") }), true);
    assert.equal(saves, 1); assert(event.prevented && event.stopped);
  });
}

await check("Shift+S uses the existing Save As copy command", () => {
  let copies = 0;
  assert.equal(handleDocumentSaveShortcut(key({ shiftKey: true }), {
    saveFile: () => assert.fail("saved formal target"), saveFileAs: () => { copies++; },
  }), true);
  assert.equal(copies, 1);
});
for (const options of [{ repeat: true }, { isComposing: true }]) await check(`${Object.keys(options)[0]} blocks browser Save without a duplicate save`, () => {
  const event = key(options);
  handleDocumentSaveShortcut(event, { saveFile: () => assert.fail("unexpected save"), saveFileAs: () => assert.fail("unexpected copy") });
  assert(event.prevented && event.stopped);
});
for (const options of [{ ctrlKey: false }, { altKey: true }, { key: "a", code: "KeyA" }]) await check(`unrelated key ${JSON.stringify(options)} keeps its existing input behavior`, () => {
  const event = key(options);
  assert.equal(handleDocumentSaveShortcut(event, { saveFile: () => assert.fail("unexpected save"), saveFileAs: () => assert.fail("unexpected copy") }), false);
  assert.equal(event.prevented, false);
});
await check("listener is wired in capture phase and can be removed", () => {
  const calls: Array<{ name: string; handler: unknown; options: unknown }> = [];
  const fakeDocument = { addEventListener: (name: string, handler: unknown, options: unknown) => calls.push({ name, handler, options }),
    removeEventListener: (name: string, handler: unknown, options: unknown) => calls.push({ name, handler, options }) };
  const remove = wireDocumentSaveShortcuts({ saveFile() {}, saveFileAs() {} }, fakeDocument as unknown as Document);
  assert.deepEqual(calls[0].options, { capture: true }); remove(); assert.equal(calls[0].handler, calls[1].handler);
});
await check("Ctrl/Cmd save combinations are reserved, ordinary S/Alt+S remain assignable", () => {
  for (const chord of ["Mod+s", "Mod+Shift+s", "Ctrl+s", "Meta+Shift+s"]) assert.equal(isReservedDocumentSaveChord(chord), true);
  for (const chord of ["s", "Shift+s", "Alt+s", "Mod+Alt+s", "Mod+a"]) assert.equal(isReservedDocumentSaveChord(chord), false);
});
await check("previously stored conflicting bindings are removed when loaded", async () => {
  assert(defaultKeymap.length > 0);
  const stored = JSON.stringify({ "input.degree1": ["Mod+s"], "voice.2": ["Mod+Shift+s"] });
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: () => stored }, configurable: true });
  const shortcuts = await import("./src/editor/shortcuts");
  assert.equal(shortcuts.shortcutBindingAllowed("input.degree1", "Mod+s"), false);
  assert.deepEqual(shortcuts.getShortcutBindings()["input.degree1"], ["1"]);
  assert.deepEqual(shortcuts.getShortcutBindings()["voice.2"], ["Alt+2"]);
});

console.log(`系统保存选址、取消/失败、原生协议、多页目录和全局保存快捷键：${checks.length} 项通过`);
console.log(JSON.stringify({ checks }, null, 2));
