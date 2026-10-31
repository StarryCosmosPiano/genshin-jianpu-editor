import assert from "node:assert/strict";
import { DocumentSaveSession, type SaveContent } from "./src/editor/save-session";
import { AutoBackupService, BACKUP_WINDOW_MS, DEFAULT_AUTO_BACKUP, normalizeAutoBackup, retainBackups,
  type BackupRecord, type AutoBackupDependencies } from "./src/editor/auto-backup";

const contents = (text: string): SaveContent => ({ text, format: "keyboard", options: { tempoBpm: 90 } });
const session = new DocumentSaveSession();
session.begin(contents("initial"));
assert.equal(session.isDirty(contents("initial")), false);
assert.equal(session.isDirty(contents("edited")), true);
assert.equal(session.isDirty(contents("initial")), false, "undo returns to the saved bytes");
const pending = session.capture(contents("edited"));
assert.equal(session.acknowledge(pending), true);
assert.equal(session.isDirty(contents("edited later")), true, "in-flight Save must not acknowledge later edits");
assert.equal(session.isDirty(contents("edited")), false);
assert.equal(session.isDirty({ ...contents("edited"), options: { tempoBpm: 120, derived: true } }), false,
  "delayed parsing cannot make the bytes already saved dirty");
assert.equal(session.isDirty({ ...contents("edited"), format: "jpw" }), true, "changing encoding/format is saveable");
const old = session.capture(contents("old document"));
session.begin(contents("new document"));
assert.equal(session.acknowledge(old), false);
assert.equal(session.isDirty(contents("new document")), false);
session.begin(contents("recovered"), null);
assert.equal(session.isDirty(contents("recovered")), true, "a recovery copy has no formal save baseline");

const record = (createdAt: number, id = String(createdAt)): BackupRecord => ({ id, createdAt, fileName: `${id}.txt`, hash: id });
let history: BackupRecord[] = [];
const expected = new Map([
  [20, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]],
  [60, [0, 2, 4, 6, 10, 14, 18, 26, 42, 58]],
  [120, [0, 2, 6, 10, 14, 22, 38, 54, 86, 118]],
  [1440, [0, 2, 8, 14, 32, 68, 122, 322, 794, 1438]],
  [2880, [0, 2, 6, 18, 36, 58, 142, 302, 704, 1274]],
]);
for (let minute = 2; minute <= 2880; minute += 2) {
  const now = minute * 60_000;
  const candidates = [...history, record(now)];
  history = retainBackups(candidates, now, 120_000, 10);
  assert(history.length <= 10);
  assert.equal(history[0].createdAt, now);
  assert(history.every(item => candidates.includes(item) && now - item.createdAt <= BACKUP_WINDOW_MS));
  if (expected.has(minute)) assert.deepEqual(history.map(item => (now - item.createdAt) / 60_000), expected.get(minute));
}
assert.deepEqual(retainBackups([record(0), record(1), record(2)], 2, 1, 1).map(item => item.createdAt), [2]);
assert.deepEqual(retainBackups([record(0), record(1), record(2)], 2, 1, 2).map(item => item.createdAt), [2, 0]);
assert.equal(retainBackups([record(5_000, "future"), record(1_000, "new-write")], 1_000, 120_000, 1)[0].id, "new-write",
  "clock rollback cannot evict the recovery point just written");
assert.equal(retainBackups([record(0), record(BACKUP_WINDOW_MS + 1)], BACKUP_WINDOW_MS + 1, 120_000, 10).length, 1);
assert.deepEqual(normalizeAutoBackup({ enabled: true, intervalMinutes: 0, maxVersions: 1.5 }), { ...DEFAULT_AUTO_BACKUP, enabled: true });

class VirtualClock {
  now = 0;
  private next = 0;
  private events = new Map<number, { at: number; callback: () => void }>();
  schedule = (callback: () => void, milliseconds: number): number => {
    const handle = ++this.next;
    this.events.set(handle, { at: this.now + milliseconds, callback });
    return handle;
  };
  cancel = (handle: unknown): void => { this.events.delete(handle as number); };
  async advance(milliseconds: number): Promise<void> {
    const end = this.now + milliseconds;
    while (true) {
      const next = [...this.events].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.now = next[1].at;
      this.events.delete(next[0]);
      next[1].callback();
      await new Promise(resolve => setImmediate(resolve));
    }
    this.now = end;
  }
}

async function verifyService(): Promise<void> {
  const clock = new VirtualClock();
  let key = "first";
  let failed = false;
  let readFailed = false;
  let calls = 0;
  let persisted: BackupRecord[] = [];
  const messages: string[] = [];
  let delay: Promise<void> | null = null;
  const dependencies: AutoBackupDependencies = {
    read: () => { if (readFailed) throw new Error("encoding failed"); return { key, bytes: new TextEncoder().encode(key) }; },
    now: () => clock.now, schedule: clock.schedule, cancel: clock.cancel, report: message => messages.push(message),
    write: async (_path, bytes, now, preferences) => {
      calls++;
      if (delay) await delay;
      if (failed) throw new Error("atomic publish failed");
      const newRecord = record(now, new TextDecoder().decode(bytes));
      persisted = retainBackups([...persisted, newRecord], now, preferences.intervalMinutes * 60_000, preferences.maxVersions);
      return { records: persisted };
    },
  };
  const service = new AutoBackupService(dependencies);
  service.setTarget("C:\\scores\\song.txt");
  await clock.advance(240_000);
  assert.equal(calls, 0, "default is disabled");
  service.setTarget(null);
  service.configure({ ...DEFAULT_AUTO_BACKUP, enabled: true });
  await clock.advance(240_000);
  assert.equal(calls, 0, "enabling backup before formal Save creates nothing");
  service.setTarget("C:\\scores\\song.txt");
  await clock.advance(119_999);
  assert.equal(calls, 0);
  await clock.advance(1);
  assert.equal(calls, 1);
  assert.equal(persisted[0].id, "first");
  await clock.advance(BACKUP_WINDOW_MS + 240_000);
  assert.equal(calls, 1);
  assert.equal(persisted.length, 1, "idle time does not prune the only recovery copy");
  key = "second";
  failed = true;
  await clock.advance(120_000);
  assert.equal(calls, 2);
  assert.equal(persisted[0].id, "first", "failed publication cannot prune older history");
  failed = false;
  await clock.advance(120_000);
  assert.equal(calls, 3);
  assert.equal(persisted[0].id, "second", "failed writes remain eligible for retry");
  assert.equal(persisted.length, 1, "24h cleanup happens only after a new recovery point succeeds");
  readFailed = true;
  await clock.advance(120_000);
  assert(messages.some(message => message.includes("encoding failed")), "read/encoding errors use the failure path");
  readFailed = false;
  key = "in flight";
  let release!: () => void;
  delay = new Promise(resolve => { release = resolve; });
  const running = service.tick();
  service.setTarget("C:\\scores\\other.txt");
  key = "other document";
  release();
  await running;
  delay = null;
  await service.tick();
  assert.equal(persisted[0].id, "other document", "the old write cannot acknowledge the new document's backup state");
  service.dispose();
  const before = calls;
  await clock.advance(1_000_000);
  assert.equal(calls, before);
}

await verifyService();
console.log("保存基线、异步竞态、虚拟时间自动备份与等比历史保留验证通过");
