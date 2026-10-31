import { isTauri } from "@tauri-apps/api/core";

export interface MidiInputDevice {
  id: string;
  name: string;
  manufacturer?: string;
}

export interface MidiInputState {
  status: "idle" | "requesting" | "ready" | "connecting" | "connected" | "error" | "unsupported";
  devices: readonly MidiInputDevice[];
  selectedDeviceId: string | null;
  enabled: boolean;
  error: string | null;
  transport: "web" | "native" | null;
  receivedMessages: number;
  receivedNoteOns: number;
  lastMessageAt: number | null;
  lastNote: number | null;
}

export interface MidiInputMessage {
  data: ArrayLike<number>;
  /** Monotonic milliseconds within this connection (not wall-clock time). */
  timestamp: number;
}

export interface MidiInputConnection {
  close(): Promise<void>;
}

/** A failed close still owns its handle. Mute immediately, release only on success. */
function ownedConnection(
  deactivate: () => void,
  release: () => Promise<void>,
  didClose: (connection: MidiInputConnection) => void,
): MidiInputConnection {
  let closed = false;
  let closing: Promise<void> | null = null;
  const connection: MidiInputConnection = {
    async close() {
      if (closed) return;
      if (closing) return closing;
      deactivate();
      closing = (async () => {
        await release();
        closed = true;
        didClose(connection);
      })();
      try { await closing; } finally { closing = null; }
    },
  };
  return connection;
}

/** Small transport boundary; tests can supply hardware-free providers. */
export interface MidiInputProvider {
  readonly kind: "web" | "native";
  listDevices(): Promise<MidiInputDevice[]>;
  connect(deviceId: string, onMessage: (message: MidiInputMessage) => void): Promise<MidiInputConnection>;
  watchDevices(onChange: () => void): () => void;
  dispose(): Promise<void>;
}

export interface MidiInputClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultClock: MidiInputClock = {
  now: () => performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const MIDI_CHORD_WINDOW_MS = 60;

/** Groups attacks, never held notes or sustain-pedal tails. No rolling debounce. */
export class MidiNoteBatcher {
  private enabled = false;
  private readonly held = new Set<number>();
  private pending: { pitches: Set<number>; keys: Set<number>; startedAt: number } | null = null;
  private timer: unknown = null;

  constructor(
    private readonly onNotes: (pitches: readonly number[]) => void,
    private readonly clock: MidiInputClock = defaultClock,
    private readonly windowMs = MIDI_CHORD_WINDOW_MS,
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    // Keep tracking held keys across mode changes: a held key must be released
    // before it can create another attack after returning to input mode.
    if (!enabled) this.cancelPending();
  }

  receive(message: MidiInputMessage): void {
    const { data } = message;
    if (data.length < 1) return;
    const status = data[0];
    if (status === 0xff) { this.reset(); return; }
    if (data.length < 3 || !Number.isInteger(status) || status < 0x80 || status >= 0xf0) return;
    const pitch = data[1], value = data[2];
    if (![pitch, value].every(n => Number.isInteger(n) && n >= 0 && n < 128)) return;
    const command = status & 0xf0, channel = status & 0x0f;
    const key = channel * 128 + pitch;
    if (command === 0xb0 && (pitch === 120 || pitch >= 123)) {
      // All Sound Off / All Notes Off and channel-mode changes are panic/reset,
      // not a new musical gesture. Do not commit a partly collected chord.
      for (const held of this.held) if (Math.floor(held / 128) === channel) this.held.delete(held);
      this.cancelPending();
      return;
    }
    if (command === 0x80 || command === 0x90 && value === 0) {
      this.held.delete(key);
      return;
    }
    if (command !== 0x90 || this.held.has(key)) return;
    this.held.add(key);
    if (!this.enabled) return;
    const timestamp = Number.isFinite(message.timestamp) ? message.timestamp : this.clock.now();
    // Timestamp checks also separate queued attacks when the UI thread was busy.
    // A released/re-struck pitch is always another step, even inside 60 ms.
    if (this.pending && timestamp - this.pending.startedAt >= this.windowMs) this.flush();
    if (this.pending && (this.pending.keys.has(key)
      || this.pending.pitches.has(pitch) && [...this.pending.keys]
        .filter(previous => previous % 128 === pitch).every(previous => !this.held.has(previous)))) this.flush();
    if (!this.enabled) return; // onNotes may have changed the input mode.
    if (!this.pending) {
      this.pending = { pitches: new Set(), keys: new Set(), startedAt: timestamp };
      this.timer = this.clock.setTimeout(() => this.flush(), this.windowMs);
    }
    this.pending.pitches.add(pitch);
    this.pending.keys.add(key);
  }

  cancelPending(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  reset(): void {
    this.cancelPending();
    this.held.clear();
  }

  private flush(): void {
    const pending = this.pending;
    this.cancelPending();
    if (this.enabled && pending?.pitches.size) this.onNotes([...pending.pitches].sort((a, b) => a - b));
  }
}

export class MidiInputUnsupportedError extends Error {}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "MIDI 访问未获允许，请在浏览器站点权限中允许 MIDI 后重试。";
    return error.message;
  }
  return String(error);
}

export interface MidiInputCallbacks {
  onNotes(pitches: readonly number[]): void;
  onState?(state: MidiInputState): void;
}

export interface MidiInputSessionOptions {
  providerFactory?: () => Promise<MidiInputProvider>;
  clock?: MidiInputClock;
  chordWindowMs?: number;
}

/** Owns permission, selection, hotplug and cancellation; contains no score edits. */
export class MidiInputSession {
  private current: MidiInputState = {
    status: "idle", devices: [], selectedDeviceId: null, enabled: false, error: null, transport: null,
    receivedMessages: 0, receivedNoteOns: 0, lastMessageAt: null, lastNote: null,
  };
  private provider: MidiInputProvider | null = null;
  private accessRequest: Promise<void> | null = null;
  private connection: MidiInputConnection | null = null;
  private unwatch: (() => void) | null = null;
  private connectionGeneration = 0;
  private refreshGeneration = 0;
  private selectionOperations: Promise<void> = Promise.resolve();
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private readonly batcher: MidiNoteBatcher;

  constructor(private readonly callbacks: MidiInputCallbacks, private readonly options: MidiInputSessionOptions = {}) {
    this.batcher = new MidiNoteBatcher(pitches => {
      try { this.callbacks.onNotes(pitches); }
      catch (error) { this.update({ error: `MIDI 输入未写入：${errorText(error)}` }); }
    }, options.clock, options.chordWindowMs);
  }

  get state(): MidiInputState { return this.current; }

  async requestAccess(): Promise<void> {
    if (this.disposed) return;
    if (this.provider) { await this.refreshDevices(); return; }
    if (this.accessRequest) return this.accessRequest;
    this.update({ status: "requesting", error: null });
    this.accessRequest = (async () => {
      try {
        const provider = await (this.options.providerFactory ?? createMidiInputProvider)();
        this.provider = provider;
        // dispose waits for this request and retains ownership if cleanup fails.
        if (this.disposed) return;
        this.unwatch = provider.watchDevices(() => { void this.refreshDevices(); });
        this.update({ transport: provider.kind, status: "ready" });
        await this.refreshDevices();
      } catch (error) {
        if (!this.disposed) this.update({ status: error instanceof MidiInputUnsupportedError ? "unsupported" : "error", error: errorText(error) });
      } finally { this.accessRequest = null; }
    })();
    return this.accessRequest;
  }

  async refreshDevices(): Promise<void> {
    if (this.disposed) return;
    if (!this.provider) { await this.requestAccess(); return; }
    const generation = ++this.refreshGeneration;
    try {
      const devices = await this.provider.listDevices();
      if (this.disposed || generation !== this.refreshGeneration) return;
      this.update({ devices });
      if (this.current.selectedDeviceId && (this.connection || this.current.status === "connecting")
        && !devices.some(device => device.id === this.current.selectedDeviceId)) {
        await this.disconnect();
        if (!this.disposed && this.current.status !== "error") this.update({ error: "MIDI 设备已断开，请重新连接并选择设备。" });
      }
    } catch (error) {
      if (!this.disposed && generation === this.refreshGeneration) {
        this.batcher.reset();
        this.update({ error: `无法刷新 MIDI 设备：${errorText(error)}` });
      }
    }
  }

  async selectDevice(deviceId: string | null): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.connectionGeneration;
    this.batcher.reset();
    this.update({ selectedDeviceId: deviceId, status: this.provider ? "ready" : "idle", error: null });
    const operation = this.selectionOperations.then(() => this.applySelection(deviceId, generation));
    this.selectionOperations = operation.catch(() => {});
    return operation;
  }

  private async applySelection(deviceId: string | null, generation: number): Promise<void> {
    try {
      await this.closeConnection();
      if (!deviceId || this.disposed || generation !== this.connectionGeneration) return;
      if (!this.provider) await this.requestAccess();
      if (!this.provider || this.disposed || generation !== this.connectionGeneration) return;
      if (!this.current.devices.some(device => device.id === deviceId)) throw new Error("所选 MIDI 设备已不可用，请刷新设备列表。");
      this.update({ status: "connecting", selectedDeviceId: deviceId, error: null,
        receivedMessages: 0, receivedNoteOns: 0, lastMessageAt: null, lastNote: null });
      const connection = await this.provider.connect(deviceId, message => {
        if (this.disposed || generation !== this.connectionGeneration) return;
        const noteOn = message.data.length >= 3 && (message.data[0] & 0xf0) === 0x90
          && message.data[1] >= 0 && message.data[1] < 128 && message.data[2] > 0 && message.data[2] < 128;
        this.current = { ...this.current, receivedMessages: this.current.receivedMessages + 1,
          receivedNoteOns: this.current.receivedNoteOns + Number(noteOn), lastMessageAt: Date.now(),
          lastNote: noteOn ? message.data[1] : this.current.lastNote };
        // Expose real device activity even while editing is paused. Reconcile
        // UI eligibility before collecting an attack; clock messages stay quiet.
        if (noteOn) this.callbacks.onState?.(this.current);
        this.batcher.receive(message);
      });
      // Keep even a superseded connection reachable until its close succeeds.
      this.connection = connection;
      if (this.disposed || generation !== this.connectionGeneration) { await this.closeConnection(); return; }
      this.update({ status: "connected" });
    } catch (error) {
      if (!this.disposed && generation === this.connectionGeneration) {
        this.batcher.reset();
        this.update({ status: "error", error: `${deviceId ? "MIDI 连接失败" : "MIDI 断开失败"}：${errorText(error)}` });
      }
    }
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.batcher.setEnabled(enabled);
    if (this.current.enabled !== enabled) this.update({ enabled });
  }

  /** Cancel the current attack group when the document or input cursor changes. */
  cancelPending(): void { this.batcher.cancelPending(); }

  async disconnect(): Promise<void> { await this.selectDevice(null); }

  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    if (!this.disposed) {
      this.disposed = true;
      ++this.connectionGeneration;
      ++this.refreshGeneration;
      this.batcher.setEnabled(false);
      this.batcher.reset();
      this.unwatch?.();
      this.unwatch = null;
    }
    this.disposal = (async () => {
      await this.selectionOperations;
      await this.accessRequest;
      // The provider retries a failed close while retaining every owned handle.
      // On failure both references survive so a later dispose can retry again.
      try { await this.closeConnection(); } catch { /* retry through provider */ }
      await this.provider?.dispose();
      await this.closeConnection();
      this.provider = null;
    })();
    try { await this.disposal; } finally { this.disposal = null; }
  }

  private async closeConnection(): Promise<void> {
    const connection = this.connection;
    await connection?.close();
    if (this.connection === connection) this.connection = null;
  }

  private update(patch: Partial<MidiInputState>): void {
    this.current = { ...this.current, ...patch };
    this.callbacks.onState?.(this.current);
  }
}

/** Exported factory accepts a browser access object for integration tests. */
export function createWebMidiInputProvider(access: MIDIAccess): MidiInputProvider {
  const connections = new Set<MidiInputConnection>();
  const watchers = new Set<() => void>();
  const onStateChange = () => { for (const watcher of watchers) watcher(); };
  access.addEventListener("statechange", onStateChange);
  return {
    kind: "web",
    async listDevices() {
      return [...access.inputs.values()].filter(port => port.state === "connected")
        .map(port => ({ id: port.id, name: port.name || "MIDI 输入设备", manufacturer: port.manufacturer || undefined }));
    },
    async connect(deviceId, onMessage) {
      const port = access.inputs.get(deviceId);
      if (!port || port.state !== "connected") throw new Error("MIDI 设备已断开。");
      await port.open();
      let active = true;
      const handler = (event: MIDIMessageEvent) => {
        if (active && event.data) onMessage({ data: event.data, timestamp: event.timeStamp });
      };
      const connection = ownedConnection(
        () => {
          active = false;
          port.removeEventListener("midimessage", handler);
        },
        async () => { await port.close(); },
        closed => { connections.delete(closed); },
      );
      connections.add(connection);
      if (port.state !== "connected") { await connection.close(); throw new Error("MIDI 设备已断开。"); }
      port.addEventListener("midimessage", handler);
      return connection;
    },
    watchDevices(onChange) { watchers.add(onChange); return () => { watchers.delete(onChange); }; },
    async dispose() {
      access.removeEventListener("statechange", onStateChange);
      watchers.clear();
      await Promise.all([...connections].map(connection => connection.close()));
    },
  };
}

export interface NativeMidiInputBridge {
  listDevices(): Promise<MidiInputDevice[]>;
  connect(deviceId: string, connectionId: string, onMessage: (message: MidiInputMessage) => void): Promise<void>;
  disconnect(connectionId: string): Promise<void>;
}

/** Windows has no Web MIDI permission dependency; poll only while a session exists. */
export function createNativeMidiInputProvider(bridge: NativeMidiInputBridge): MidiInputProvider {
  const connections = new Set<MidiInputConnection>();
  const watchers = new Set<() => void>();
  let poll: ReturnType<typeof setInterval> | null = null;
  let nextId = 0;
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Serialize native opens so a superseded connection cannot replace a newer one.
  let operations: Promise<unknown> = Promise.resolve();
  const run = <T>(action: () => Promise<T>): Promise<T> => {
    const result = operations.then(action, action);
    operations = result.catch(() => {});
    return result;
  };
  return {
    kind: "native",
    listDevices: () => bridge.listDevices(),
    async connect(deviceId, onMessage) {
      const connectionId = `${sessionId}-${++nextId}`;
      let active = true;
      await run(() => bridge.connect(deviceId, connectionId, message => { if (active) onMessage(message); }));
      const connection = ownedConnection(
        () => { active = false; },
        () => run(() => bridge.disconnect(connectionId)),
        closed => { connections.delete(closed); },
      );
      connections.add(connection);
      return connection;
    },
    watchDevices(onChange) {
      watchers.add(onChange);
      poll ??= setInterval(() => { for (const watcher of watchers) watcher(); }, 1000);
      return () => {
        watchers.delete(onChange);
        if (!watchers.size && poll !== null) { clearInterval(poll); poll = null; }
      };
    },
    async dispose() {
      if (poll !== null) clearInterval(poll);
      poll = null;
      watchers.clear();
      await Promise.all([...connections].map(connection => connection.close()));
    },
  };
}

export async function createMidiInputProvider(): Promise<MidiInputProvider> {
  if (isTauri()) {
    const { invoke, Channel } = await import("@tauri-apps/api/core");
    if (await invoke<boolean>("midi_input_available")) {
      return createNativeMidiInputProvider({
        listDevices: () => invoke<MidiInputDevice[]>("midi_input_list"),
        async connect(deviceId, connectionId, onMessage) {
          const channel = new Channel<{ data: number[]; timestamp: number }>(onMessage);
          await invoke("midi_input_connect", { deviceId, connectionId, onMessage: channel });
        },
        disconnect: connectionId => invoke("midi_input_disconnect", { connectionId }),
      });
    }
  }
  if (typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function") {
    return createWebMidiInputProvider(await navigator.requestMIDIAccess({ sysex: false }));
  }
  throw new MidiInputUnsupportedError("当前环境不支持 MIDI 设备输入。请使用 Windows 桌面版，或通过 HTTPS / localhost 打开的 Chrome、Edge 浏览器。");
}
