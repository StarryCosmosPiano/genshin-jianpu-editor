import type { SaveContent } from "./save-session";

export const MOBILE_DRAFT_DELAY = 500;
export const MOBILE_DRAFT_DATABASE = "jpeditor-mobile-drafts";

export interface MobileDraftRecord extends SaveContent {
  version: 1;
  id: string;
  name: string;
  updatedAt: number;
  revision: number;
}

export interface MobileDraftStore {
  put(record: MobileDraftRecord): Promise<void>;
  list(): Promise<MobileDraftRecord[]>;
  remove(id: string): Promise<void>;
}

export type MobileDraftState = {
  status: "idle" | "pending" | "saving" | "saved" | "failed";
  updatedAt?: number;
  message?: string;
};

export function validMobileDraft(value: unknown): value is MobileDraftRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<MobileDraftRecord>;
  return item.version === 1 && typeof item.id === "string" && !!item.id
    && typeof item.text === "string" && typeof item.name === "string"
    && (item.format === "jpw" || item.format === "keyboard" || item.format === "number")
    && typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)
    && typeof item.revision === "number" && Number.isSafeInteger(item.revision);
}

export function mobileDraftFailure(error: unknown): string {
  const name = typeof error === "object" && error !== null && "name" in error ? error.name : "";
  if (name === "QuotaExceededError") return "本机草稿空间已满。当前内容仍在页面中，请立即导出副本，或删除不需要的草稿后重试。";
  return "本机草稿未能保存。当前内容仍在页面中，请立即导出副本。"
    + (error instanceof Error ? `（${error.message}）` : "");
}

let database: Promise<IDBDatabase> | null = null;
function openDraftDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("浏览器未开放本地存储")); return; }
    const request = indexedDB.open(MOBILE_DRAFT_DATABASE, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("documents", { keyPath: "id" });
      store.createIndex("updatedAt", "updatedAt");
    };
    request.onerror = () => reject(request.error ?? new Error("无法打开草稿存储"));
    request.onblocked = () => reject(new Error("草稿存储正在更新，请关闭其他编辑器标签后重试"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = null; };
      resolve(db);
    };
  }).catch(error => { database = null; throw error; });
  return database;
}

function draftTransaction(db: IDBDatabase, mode: IDBTransactionMode): IDBTransaction {
  if (mode === "readwrite") {
    try { return db.transaction("documents", mode, { durability: "strict" }); }
    catch (error) { if (!(error instanceof TypeError)) throw error; }
  }
  return db.transaction("documents", mode);
}

async function changeDraft(change: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openDraftDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = draftTransaction(db, "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("草稿写入未完成"));
    change(transaction.objectStore("documents"));
  });
}

export const indexedDbDraftStore: MobileDraftStore = {
  put: record => changeDraft(store => { store.put(record); }),
  remove: id => changeDraft(store => { store.delete(id); }),
  list: async () => {
    const db = await openDraftDatabase();
    return new Promise<MobileDraftRecord[]>((resolve, reject) => {
      const transaction = draftTransaction(db, "readonly");
      const records: MobileDraftRecord[] = [];
      const request = transaction.objectStore("documents").index("updatedAt").openCursor(null, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (validMobileDraft(cursor.value)) records.push(cursor.value);
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(records);
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("无法读取本机草稿"));
    });
  },
};

export interface MobileDraftDependencies {
  store: MobileDraftStore;
  now: () => number;
  createId: () => string;
  schedule: (callback: () => void, milliseconds: number) => unknown;
  cancel: (timer: unknown) => void;
  report: (state: MobileDraftState) => void;
}

/** Raw text is committed even if parsing fails. It never acknowledges a formal file save. */
export class MobileDraftSession {
  private id: string;
  private revision = 0;
  private timer: unknown;
  private pending = new Map<string, MobileDraftRecord>();
  private keys = new Map<string, string>();
  private running: Promise<boolean> | null = null;
  private captureFailure: string | null = null;
  private discarded = false;
  private disposed = false;
  state: MobileDraftState = { status: "idle" };

  constructor(private readonly dependencies: MobileDraftDependencies) {
    this.id = dependencies.createId();
  }

  get documentId(): string { return this.id; }
  get hasCurrentContent(): boolean { return this.keys.has(this.id); }

  beginDocument(): void {
    this.id = this.dependencies.createId();
    this.revision = 0;
    this.captureFailure = null;
    this.discarded = false;
    this.report({ status: "idle" });
    // Keep pending snapshots of the previous document until their commit succeeds.
    if (this.pending.size) this.arm();
  }

  queue(content: SaveContent, name: string): void {
    if (this.disposed || this.discarded) return;
    try {
      const key = JSON.stringify({ text: content.text, format: content.format, options: content.options, name });
      if (this.keys.get(this.id) === key && !this.captureFailure) return;
      const copy = structuredClone(content);
      this.captureFailure = null;
      this.keys.set(this.id, key);
      this.pending.set(this.id, { ...copy, version: 1, id: this.id, name,
        updatedAt: this.dependencies.now(), revision: ++this.revision });
      this.report({ status: "pending" });
      this.arm();
    } catch (error) {
      this.captureFailure = mobileDraftFailure(error);
      this.report({ status: "failed", message: this.captureFailure });
    }
  }

  private arm(): void {
    if (this.timer !== undefined) this.dependencies.cancel(this.timer);
    this.timer = this.dependencies.schedule(() => {
      this.timer = undefined;
      void this.flush();
    }, MOBILE_DRAFT_DELAY);
  }

  flush(): Promise<boolean> {
    if (this.timer !== undefined) this.dependencies.cancel(this.timer);
    this.timer = undefined;
    if (this.running) return this.running;
    if (!this.pending.size) return Promise.resolve(this.state.status !== "failed");
    this.running = (async () => {
      try {
        while (this.pending.size) {
          for (const [id, record] of [...this.pending]) {
            if (id === this.id && !this.captureFailure) this.report({ status: "saving" });
            await this.dependencies.store.put(record);
            if (this.pending.get(id)?.revision === record.revision) this.pending.delete(id);
            if (id === this.id && !this.pending.has(id) && !this.captureFailure) this.report({ status: "saved", updatedAt: record.updatedAt });
          }
        }
        return !this.captureFailure;
      } catch (error) {
        this.report({ status: "failed", message: mobileDraftFailure(error) });
        return false;
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }

  /** Only an explicit discard/removal action deletes a stored draft. */
  async discardCurrent(): Promise<boolean> {
    const id = this.id;
    this.discarded = true;
    this.pending.delete(id);
    if (this.running) await this.running;
    try {
      await this.dependencies.store.remove(id);
      this.keys.delete(id);
      this.report({ status: "idle" });
      return true;
    } catch (error) {
      this.discarded = false;
      this.keys.delete(id);
      this.report({ status: "failed", message: mobileDraftFailure(error) });
      return false;
    }
  }

  private report(state: MobileDraftState): void {
    if (this.state.status === state.status && this.state.updatedAt === state.updatedAt && this.state.message === state.message) return;
    this.state = state;
    this.dependencies.report(state);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) this.dependencies.cancel(this.timer);
    this.timer = undefined;
  }
}

const sessions = new WeakMap<object, MobileDraftSession>();
export function bindMobileDraftSession(host: object, session: MobileDraftSession): void { sessions.set(host, session); }
export function getMobileDraftSession(host: object): MobileDraftSession | undefined { return sessions.get(host); }

export function newMobileDraftId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
