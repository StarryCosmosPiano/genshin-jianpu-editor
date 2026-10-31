import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import { MobileDraftSession, MOBILE_DRAFT_DELAY, validMobileDraft, mobileDraftFailure,
  type MobileDraftRecord, type MobileDraftState, type MobileDraftStore } from "./src/editor/mobile-drafts";
import { archiveByteFiles, compressArchive } from "./src/editor/file-archive";
import { RasterPdfWriter } from "./src/editor/file-pdf";
import { parseRecognitionPages } from "./src/editor/mobile-import";
import { canShareFile } from "./src/editor/mobile-file";
import { cancellableOcrBackend, mergeRecognizedPages } from "./src/omr/recognition-pages";
import { toMusicXml } from "./src/omr/musicxml";
import type { RecognizedScore } from "./src/omr/types";

const checks: string[] = [];
async function check(name: string, run: () => void | Promise<void>): Promise<void> { await run(); checks.push(name); }
const content = (text: string, options: unknown = null) => ({ text, format: "jpw", options });
function fixture() {
  let time = 1000, ids = 0, timers = 0;
  const scheduled = new Map<number, { due: number; callback: () => void }>();
  const records = new Map<string, MobileDraftRecord>();
  const writes: MobileDraftRecord[] = [];
  const states: MobileDraftState[] = [];
  const store: MobileDraftStore = {
    put: async record => { const copy = structuredClone(record); writes.push(copy); records.set(record.id, copy); },
    list: async () => [...records.values()], remove: async id => { records.delete(id); },
  };
  const session = new MobileDraftSession({ store, now: () => time, createId: () => `document-${++ids}`,
    schedule: (callback, milliseconds) => { const id = ++timers; scheduled.set(id, { due: time + milliseconds, callback }); return id; },
    cancel: timer => { scheduled.delete(timer as number); }, report: state => { states.push(state); },
  });
  return { session, store, records, writes, states, scheduled,
    advance: (milliseconds: number) => {
      time += milliseconds;
      for (const [id, timer] of [...scheduled]) if (timer.due <= time) { scheduled.delete(id); timer.callback(); }
    },
  };
}

await check("raw incomplete text is captured after the 500 ms debounce, unchanged drafts do not rewrite", async () => {
  const f = fixture();
  const raw = ".Title\nTitle = {尚未完成  \n";
  f.session.queue(content(raw), "未命名.jpwabc");
  assert.equal(MOBILE_DRAFT_DELAY, 500);
  f.advance(499); assert.equal(f.writes.length, 0);
  f.advance(1); await f.session.flush();
  assert.equal(f.writes[0].text, raw);
  assert.equal(f.session.state.status, "saved");
  f.session.queue(content(raw), "未命名.jpwabc"); await f.session.flush();
  assert.equal(f.writes.length, 1);
});

await check("draft snapshots clone format options before later mutation", async () => {
  const f = fixture(), options = { kind: "keyboard", beats: 3, nested: { value: 1 } };
  f.session.queue({ text: "[Q", format: "keyboard", options }, "谱.txt");
  options.nested.value = 2;
  await f.session.flush();
  assert.deepEqual(f.writes[0].options, { kind: "keyboard", beats: 3, nested: { value: 1 } });
});

await check("background flush commits immediately and waits for edits received during a write", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const write = f.store.put;
  f.store.put = async record => { if (record.text === "first") await gate; await write(record); };
  f.session.queue(content("first"), "谱.jpwabc");
  const pending = f.session.flush();
  f.session.queue(content("second"), "谱.jpwabc");
  release(); assert.equal(await pending, true);
  assert.deepEqual(f.writes.map(record => record.text), ["first", "second"]);
  assert.equal(f.records.get(f.session.documentId)?.text, "second");
});

await check("document replacement keeps pending old text under its own id", async () => {
  const f = fixture();
  f.session.queue(content("old document"), "旧谱.jpwabc");
  const old = f.session.documentId;
  f.session.beginDocument();
  f.session.queue(content("new document"), "新谱.jpwabc");
  const current = f.session.documentId;
  assert.notEqual(old, current);
  await f.session.flush();
  assert.equal(f.records.get(old)?.text, "old document");
  assert.equal(f.records.get(current)?.text, "new document");
});

await check("quota failure keeps old records and the pending source for a real retry", async () => {
  const f = fixture();
  f.session.queue(content("previous"), "谱.jpwabc"); await f.session.flush();
  const write = f.store.put;
  f.store.put = async () => { throw new DOMException("full", "QuotaExceededError"); };
  f.session.queue(content("latest raw"), "谱.jpwabc");
  assert.equal(await f.session.flush(), false);
  assert.equal(f.records.get(f.session.documentId)?.text, "previous");
  assert.match(f.session.state.message!, /空间已满/);
  f.store.put = write;
  assert.equal(await f.session.flush(), true);
  assert.equal(f.records.get(f.session.documentId)?.text, "latest raw");
});

await check("snapshot failures are reported once and cannot acknowledge an older pending draft", async () => {
  const f = fixture();
  f.session.queue(content("previous"), "谱.jpwabc");
  const invalid = content("latest raw", { unsupported: () => {} });
  f.session.queue(invalid, "谱.jpwabc");
  f.session.queue(invalid, "谱.jpwabc");
  assert.equal(f.states.filter(state => state.status === "failed").length, 1);
  assert.equal(await f.session.flush(), false);
  assert.equal(f.session.state.status, "failed");
  assert.equal(f.records.get(f.session.documentId)?.text, "previous");
  f.session.queue(content("latest raw"), "谱.jpwabc");
  assert.equal(await f.session.flush(), true);
  assert.equal(f.records.get(f.session.documentId)?.text, "latest raw");
});

await check("explicit discard waits for an in-flight write then deletes only that document", async () => {
  const f = fixture();
  f.session.queue(content("keep"), "保留.jpwabc"); await f.session.flush();
  const keep = f.session.documentId;
  f.session.beginDocument();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const write = f.store.put;
  f.store.put = async record => { await gate; await write(record); };
  f.session.queue(content("discard"), "放弃.jpwabc");
  const current = f.session.documentId;
  const writing = f.session.flush();
  const discarding = f.session.discardCurrent();
  release(); await writing; assert.equal(await discarding, true);
  assert.equal(f.records.has(current), false);
  assert.equal(f.records.get(keep)?.text, "keep");
});

await check("draft validation rejects incompatible stored records and errors stay actionable", async () => {
  const f = fixture(); f.session.queue(content("raw"), "谱.jpwabc"); await f.session.flush();
  assert(validMobileDraft(f.writes[0]));
  assert(!validMobileDraft({ ...f.writes[0], version: 2 }));
  assert(!validMobileDraft({ ...f.writes[0], format: "html" }));
  assert.match(mobileDraftFailure(new Error("blocked")), /导出副本.*blocked/);
});

await check("sharing checks the exact File object and does not infer support from the API name", () => {
  const file = new File(["source"], "谱.jpwabc", { type: "application/octet-stream" });
  let inspected: File | undefined;
  assert.equal(canShareFile(file, { share: async () => {}, canShare: data => { inspected = data?.files?.[0]; return false; } }), false);
  assert.equal(inspected, file);
  assert.equal(canShareFile(file, { share: async () => {}, canShare: () => { throw new TypeError("unknown type"); } }), false);
});

await check("page selection supports ordered unique ranges and rejects invalid/out-of-range input", () => {
  assert.deepEqual(parseRecognitionPages("3,1–2，2、5", 5), [1, 2, 3, 5]);
  for (const value of ["", "0", "6", "3-1", "1,,2", "a", "1.5", "1-999999999999"]) {
    assert.throws(() => parseRecognitionPages(value, 5));
  }
});

await check("PNG archive processes pages sequentially and keeps names and bytes intact", async () => {
  let active = 0, maximum = 0;
  const files = [1, 2, 3].map(value => ({ name: `乐谱-第${value}页.png`, bytes: async () => {
    active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return new Uint8Array([value, 255, 0]);
  } }));
  const blob = await archiveByteFiles(files);
  const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(maximum, 1);
  assert.deepEqual(Object.keys(archive), files.map(file => file.name));
  files.forEach((file, index) => assert.deepEqual([...archive[file.name]], [index + 1, 255, 0]));
});

await check("archive cancellation stops before the next page, and compression can be cancelled", async () => {
  const controller = new AbortController(); let generated = 0;
  await assert.rejects(archiveByteFiles([1, 2].map(value => ({ name: `${value}.png`, bytes: () => {
    generated++; controller.abort(); return new Uint8Array([value]);
  } })), { signal: controller.signal }), error => error instanceof DOMException && error.name === "AbortError");
  assert.equal(generated, 1);
  await assert.rejects(async () => compressArchive({ "a.txt": new Uint8Array([1]) }, controller.signal), /取消/);
  const archive = await compressArchive({ "a.txt": new TextEncoder().encode("test") });
  assert.equal(new TextDecoder().decode(unzipSync(archive)["a.txt"]), "test");
});

await check("PDF writer emits all selected page objects and valid byte offsets without accepting an incomplete file", async () => {
  const writer = new RasterPdfWriter(2);
  writer.addPage({ jpeg: new Uint8Array([255, 216, 255, 217]), pixelWidth: 20, pixelHeight: 30, pageWidth: 595, pageHeight: 842 });
  assert.throws(() => writer.finish(), /尚未完成/);
  writer.addPage({ jpeg: new Uint8Array([255, 216, 0, 255, 217]), pixelWidth: 30, pixelHeight: 20, pageWidth: 842, pageHeight: 595 });
  const data = Buffer.from(await writer.finish().arrayBuffer());
  const text = data.toString("latin1");
  assert.match(text, /\/Count 2/);
  assert.equal((text.match(/\/Type \/Page /g) ?? []).length, 2);
  const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
  assert.equal(data.subarray(xref, xref + 4).toString(), "xref");
  const offsets = text.slice(xref).split("\n").slice(3, 11).map(row => Number(row.slice(0, 10)));
  offsets.forEach((offset, index) => assert.equal(data.subarray(offset, offset + `${index + 1} 0 obj`.length).toString(), `${index + 1} 0 obj`));
  writer.dispose();
});

await check("OCR batching preserves natural rectangles and reacts between batches", async () => {
  const controller = new AbortController();
  const seen: number[] = [];
  const backend = cancellableOcrBackend({ recognizeDigits: async (_bin, rects) => {
    seen.push(...rects.map(rect => rect.x)); return rects.map(rect => rect.x % 8);
  } }, controller.signal);
  const rects = Array.from({ length: 35 }, (_, x) => ({ x, y: 1, w: 4, h: 10 }));
  assert.deepEqual(await backend.recognizeDigits({ w: 1, h: 1, data: new Uint8Array(1) }, rects), rects.map(rect => rect.x % 8));
  assert.deepEqual(seen, rects.map(rect => rect.x));
  let calls = 0;
  const cancelled = cancellableOcrBackend({ recognizeDigits: async (_bin, batch) => {
    calls++; controller.abort(); return batch.map(() => 1);
  } }, controller.signal);
  await assert.rejects(cancelled.recognizeDigits({ w: 1, h: 1, data: new Uint8Array(1) }, rects), /取消/);
  assert.equal(calls, 1);
});

await check("multi-page recognition merges rows in page order and keeps first-page metadata", () => {
  const page = (digit: number): RecognizedScore => ({ key: "C", fifths: 0, beats: 4, beatType: 4, title: `page${digit}`,
    rows: [{ topY: 0, bottomY: 10, barlineXs: [0, 100], nums: [{ digit, bbox: { x: 10, y: 0, w: 10, h: 10 }, dot: 0, octave: 0, div: 0, augment: 3 }] }] });
  const merged = mergeRecognizedPages([page(1), page(2)]);
  assert.equal(merged.title, "page1");
  assert.deepEqual(merged.rows.map(row => row.nums[0].digit), [1, 2]);
  assert.equal((toMusicXml(merged).match(/<measure number=/g) ?? []).length, 2);
});

console.log(`移动文件、草稿、逐页导出和识别：${checks.length} 项通过`);
console.log(JSON.stringify({ checks }, null, 2));
