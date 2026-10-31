export interface AutoBackupPreferences {
  enabled: boolean;
  intervalMinutes: number;
  maxVersions: number;
}

export const DEFAULT_AUTO_BACKUP: AutoBackupPreferences = { enabled: false, intervalMinutes: 2, maxVersions: 10 };
export const BACKUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface BackupRecord {
  id: string;
  fileName: string;
  createdAt: number;
  hash: string;
}

export interface BackupWriteResult { records: BackupRecord[]; warning?: string | null }

/** Merge the closest historical points on a logarithmic time axis. */
export function retainBackups(records: readonly BackupRecord[], now: number, intervalMs: number, maxVersions: number): BackupRecord[] {
  const newestId = records[records.length - 1]?.id;
  const kept = records.filter(record => now - record.createdAt <= BACKUP_WINDOW_MS)
    .sort((a, b) => Math.max(0, now - a.createdAt) - Math.max(0, now - b.createdAt)
      || Number(b.id === newestId) - Number(a.id === newestId) || b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const maximum = Math.max(1, Math.floor(maxVersions));
  const interval = Math.max(1, intervalMs);
  if (maximum === 1) return kept.slice(0, 1);
  while (kept.length > maximum) {
    const coordinates = kept.map(record => Math.log1p(Math.max(0, now - record.createdAt) / interval));
    let selected = 1;
    let minimum = Number.POSITIVE_INFINITY;
    for (let index = 1; index < kept.length - 1; index++) {
      const cost = (coordinates[index] - coordinates[index - 1]) * (coordinates[index + 1] - coordinates[index]);
      if (cost < minimum - 1e-12) { minimum = cost; selected = index; }
    }
    kept.splice(selected, 1);
  }
  return kept;
}

export function normalizeAutoBackup(value?: Partial<AutoBackupPreferences>): AutoBackupPreferences {
  const integer = (candidate: number | undefined, fallback: number): number =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : fallback;
  return {
    enabled: value?.enabled === true,
    intervalMinutes: integer(value?.intervalMinutes, DEFAULT_AUTO_BACKUP.intervalMinutes),
    maxVersions: integer(value?.maxVersions, DEFAULT_AUTO_BACKUP.maxVersions),
  };
}

export interface BackupSource { key: string; bytes: Uint8Array }
export interface AutoBackupDependencies {
  read: () => BackupSource;
  write: (path: string, bytes: Uint8Array, now: number, preferences: AutoBackupPreferences) => Promise<BackupWriteResult>;
  now: () => number;
  schedule: (callback: () => void, milliseconds: number) => unknown;
  cancel: (handle: unknown) => void;
  report: (message: string) => void;
}

/** Backup errors leave both the formal-save baseline and existing history alone. */
export class AutoBackupService {
  private preferences = { ...DEFAULT_AUTO_BACKUP };
  private path: string | null = null;
  private lastKey: string | null = null;
  private generation = 0;
  private timer: unknown;
  private running: Promise<void> | null = null;
  constructor(private readonly dependencies: AutoBackupDependencies) {}

  configure(preferences: AutoBackupPreferences): void {
    this.preferences = normalizeAutoBackup(preferences);
    this.restartTimer();
  }

  setTarget(path: string | null): void {
    if (path === this.path && path !== null) return;
    this.generation++;
    this.path = path;
    this.lastKey = null;
    this.restartTimer();
  }

  private restartTimer(): void {
    if (this.timer !== undefined) this.dependencies.cancel(this.timer);
    this.timer = undefined;
    if (this.preferences.enabled && this.path) {
      // setTimeout has a signed 32-bit limit; long user intervals remain real intervals.
      const due = this.dependencies.now() + this.preferences.intervalMinutes * 60_000;
      const wait = (): void => {
        const remaining = due - this.dependencies.now();
        if (remaining > 0) { this.timer = this.dependencies.schedule(wait, Math.min(remaining, 2_147_483_647)); return; }
        this.timer = undefined;
        void this.tick().finally(() => this.restartTimer());
      };
      this.timer = this.dependencies.schedule(wait, Math.min(this.preferences.intervalMinutes * 60_000, 2_147_483_647));
    }
  }

  async tick(): Promise<void> {
    if (this.running) return this.running;
    if (!this.preferences.enabled || !this.path) return;
    const path = this.path;
    const generation = this.generation;
    const preferences = { ...this.preferences };
    this.running = (async () => {
      try {
        const source = this.dependencies.read();
        if (source.key === this.lastKey) return;
        const result = await this.dependencies.write(path, source.bytes, this.dependencies.now(), preferences);
        if (generation !== this.generation) return;
        this.lastKey = source.key;
        if (result.warning) this.dependencies.report(`恢复副本已保存；${result.warning}`);
      } catch (error) {
        if (generation === this.generation) this.dependencies.report(`自动保存失败，已有历史仍保留：${error instanceof Error ? error.message : String(error)}`);
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }

  dispose(): void {
    this.generation++;
    this.path = null;
    if (this.timer !== undefined) this.dependencies.cancel(this.timer);
    this.timer = undefined;
  }
}

export async function writeNativeBackup(path: string, bytes: Uint8Array, now: number, preferences: AutoBackupPreferences): Promise<BackupWriteResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("autosave_write", { projectPath: path, bytes: Array.from(bytes), createdAt: now,
    intervalMs: preferences.intervalMinutes * 60_000, maxVersions: preferences.maxVersions });
}

export async function listNativeBackups(path: string): Promise<BackupRecord[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("autosave_list", { projectPath: path });
}

export async function readNativeBackup(path: string, id: string): Promise<Uint8Array> {
  const { invoke } = await import("@tauri-apps/api/core");
  return new Uint8Array(await invoke<number[]>("autosave_read", { projectPath: path, id }));
}
