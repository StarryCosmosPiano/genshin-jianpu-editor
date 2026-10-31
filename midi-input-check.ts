import {
  createNativeMidiInputProvider, createWebMidiInputProvider, MidiInputSession, MidiNoteBatcher,
  type MidiInputClock, type MidiInputConnection, type MidiInputDevice, type MidiInputMessage, type MidiInputProvider,
} from "./src/editor/midi-input";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
async function rejects(promise: Promise<unknown>, message: string): Promise<void> {
  let rejected = false;
  try { await promise; } catch { rejected = true; }
  check(rejected, message);
}

class Clock implements MidiInputClock {
  time = 0;
  next = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, delay: number): unknown {
    const id = ++this.next;
    this.tasks.set(id, { at: this.time + delay, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.tasks.delete(handle as number); }
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const task = [...this.tasks].sort((a, b) => a[1].at - b[1].at).find(([, item]) => item.at <= end);
      if (!task) break;
      this.time = task[1].at;
      this.tasks.delete(task[0]);
      task[1].callback();
    }
    this.time = end;
  }
}

const clock = new Clock();
const notes: number[][] = [];
const batcher = new MidiNoteBatcher(pitches => notes.push([...pitches]), clock);
const message = (data: number[], timestamp = clock.now()) => batcher.receive({ data, timestamp });
batcher.setEnabled(true);
message([0x90, 64, 100]);
clock.advance(25);
message([0x90, 60, 100]);
clock.advance(34);
equal(notes, [], "chord committed before the first-onset window ended");
clock.advance(1);
equal(notes, [[60, 64]], "near-simultaneous attacks must be one sorted chord");
message([0x90, 64, 100]);
clock.advance(70);
equal(notes, [[60, 64]], "held note-on duplicates inserted another step");
message([0x90, 64, 0]);
message([0x90, 64, 100]);
clock.advance(60);
equal(notes, [[60, 64], [64]], "velocity-zero note-off did not allow a new attack");

batcher.reset(); notes.length = 0;
message([0x90, 60, 100]);
clock.advance(40);
message([0x90, 64, 100]);
clock.advance(30);
message([0x90, 67, 100]);
equal(notes, [[60, 64]], "chord window slid forward after the second attack");
clock.advance(60);
equal(notes, [[60, 64], [67]], "a later attack merged into the previous chord");

batcher.reset(); notes.length = 0;
message([0x90, 60, 100]);
clock.advance(5);
message([0x90, 64, 100]);
clock.advance(5);
message([0x80, 60, 0]);
clock.advance(5);
message([0x90, 60, 100]);
equal(notes, [[60, 64]], "same-pitch reattack inside the chord window was lost");
clock.advance(60);
equal(notes, [[60, 64], [60]], "reattack did not get a separate step");

batcher.reset(); notes.length = 0;
message([0x90, 60, 100]);
clock.advance(5);
message([0x80, 60, 0]);
message([0x90, 62, 100]);
clock.advance(5);
message([0x90, 62, 0]);
equal(notes, [], "short note-off prematurely completed the chord window");
clock.advance(50);
equal(notes, [[60, 62]], "short nearby staccato pitches did not share the fixed chord window");

batcher.reset(); notes.length = 0;
message([0x90, 60, 100], 1000);
message([0x90, 64, 100], 1070);
equal(notes, [[60]], "queued event timestamps were ignored");
batcher.reset(); notes.length = 0;
message([0x90, 60, 100]);
message([0x91, 60, 100]);
message([0x80, 60, 0]);
equal(notes, [], "releasing one channel prematurely ended a layered pitch");
message([0x81, 60, 0]);
clock.advance(60);
equal(notes, [[60]], "same pitch on multiple channels was not deduplicated");

batcher.reset(); notes.length = 0;
message([0x91, 60, 100]);
clock.advance(10);
message([0x81, 60, 0]);
message([0x92, 60, 100]);
equal(notes, [[60]], "a repeated strike with a new MPE channel was mistaken for a layer");
clock.advance(60);
equal(notes, [[60], [60]], "channel-rotating repeated strikes lost an onset");

batcher.reset(); notes.length = 0;
message([0x90, 60, 100]);
batcher.setEnabled(false);
clock.advance(100);
batcher.setEnabled(true);
message([0x90, 60, 100]);
clock.advance(100);
equal(notes, [], "mode change committed pending input or replayed a held key");
message([0x90, 60, 0]);
message([0x90, 60, 100]);
message([0xb0, 123, 0]);
clock.advance(100);
equal(notes, [], "All Notes Off committed an unfinished chord");
message([0x90, 60, 100]);
clock.advance(60);
equal(notes, [[60]], "All Notes Off left the key stuck down");
message([0xff]);
notes.length = 0;
for (const data of [[0x90], [0x90, 128, 100], [0x90, 60, 200], [0xf0, 60, 100], [0xb0, 64, 127], [0xf8]]) message(data);
clock.advance(100);
equal(notes, [], "malformed messages, SysEx, sustain or timing created notes");
message([0x90, 60, 100]);
message([0xff]);
clock.advance(100);
equal(notes, [], "System Reset did not cancel pending notes");

class Provider implements MidiInputProvider {
  readonly kind = "web" as const;
  devices: MidiInputDevice[] = [{ id: "a", name: "Keyboard A" }, { id: "b", name: "Keyboard B" }];
  listeners = new Set<() => void>();
  messages: ((message: MidiInputMessage) => void)[] = [];
  opens: string[] = [];
  closes: string[] = [];
  pauseOpen: Promise<void> | null = null;
  didOpen: (() => void) | null = null;
  fail = false;
  closeFailures = 0;
  disposed = false;
  async listDevices(): Promise<MidiInputDevice[]> { return [...this.devices]; }
  async connect(id: string, onMessage: (message: MidiInputMessage) => void): Promise<MidiInputConnection> {
    this.opens.push(id);
    this.messages.push(onMessage);
    this.didOpen?.();
    if (this.pauseOpen) await this.pauseOpen;
    if (this.fail) throw new Error("busy");
    return { close: async () => {
      this.closes.push(id);
      if (this.closeFailures > 0) { this.closeFailures--; throw new Error("transient close error"); }
    } };
  }
  watchDevices(callback: () => void): () => void { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; }
  async dispose(): Promise<void> { this.disposed = true; }
  send(data: number[]): void { this.messages.at(-1)?.({ data, timestamp: clock.now() }); }
}

const provider = new Provider();
notes.length = 0;
let shouldThrow = false;
const session = new MidiInputSession({ onNotes: pitches => {
  if (shouldThrow) throw new Error("edit unavailable");
  notes.push([...pitches]);
} }, { providerFactory: async () => provider, clock });
await session.requestAccess();
equal(session.state.devices, provider.devices, "device request did not expose input ports");
equal(provider.opens, [], "enumeration auto-opened a device");
await session.selectDevice("a");
provider.send([0x90, 60, 100]);
clock.advance(100);
equal(notes, [], "connected but disabled session wrote a note");
check(session.state.receivedMessages === 1 && session.state.receivedNoteOns === 1
  && session.state.lastNote === 60 && session.state.lastMessageAt !== null,
  "paused input hid the device signal needed to diagnose an inactive editor");
provider.send([0x80, 60, 0]);
session.setEnabled(true);
provider.send([0x90, 60, 100]);
clock.advance(60);
equal(notes, [[60]], "enabled device did not pass notes to the editor");
provider.send([0x90, 64, 100]);
session.cancelPending();
clock.advance(100);
equal(notes, [[60]], "cursor/document cancellation did not cancel the batch");
provider.send([0x80, 64, 0]);
provider.send([0x90, 64, 100]);
provider.devices = [{ id: "b", name: "Keyboard B" }];
await session.refreshDevices();
clock.advance(100);
equal(notes, [[60]], "hot-unplug committed pending device input");
check(session.state.selectedDeviceId === null && !!session.state.error, "hot-unplug retained its active selection");
provider.send([0x90, 67, 100]);
clock.advance(100);
equal(notes, [[60]], "stale device messages survived disconnect");

provider.fail = true;
await session.selectDevice("b");
check(session.state.status === "error", "open failure did not surface");
provider.fail = false;
await session.selectDevice("b");
check(session.state.status === "connected", "failed device could not be retried");
shouldThrow = true;
provider.send([0x90, 67, 100]);
clock.advance(60);
check(session.state.error?.includes("edit unavailable"), "editor callback failure was not reported");
shouldThrow = false;
provider.send([0x90, 69, 100]);
clock.advance(60);
equal(notes, [[60], [69]], "editor callback failure killed the transport");
await session.dispose();
check(provider.disposed && provider.listeners.size === 0, "dispose leaked a provider/watch");

const racing = new Provider();
const raced = new MidiInputSession({ onNotes: () => { throw new Error("stale callback"); } }, { providerFactory: async () => racing, clock });
await raced.requestAccess();
let finishOpen!: () => void;
racing.pauseOpen = new Promise<void>(resolve => { finishOpen = resolve; });
const openStarted = new Promise<void>(resolve => { racing.didOpen = resolve; });
const first = raced.selectDevice("a");
await openStarted;
const second = raced.selectDevice("b");
racing.pauseOpen = null;
finishOpen();
await Promise.all([first, second]);
equal(racing.opens, ["a", "b"], "device selections were not serialized");
equal(racing.closes, ["a"], "superseded connect was not closed before selecting its successor");
check(raced.state.selectedDeviceId === "b" && raced.state.status === "connected", "stale selection overwrote the current device");
await raced.dispose();
equal(racing.closes, ["a", "b"], "final connection was leaked");

const staleProvider = new Provider();
const staleSession = new MidiInputSession({ onNotes() {} }, { providerFactory: async () => staleProvider, clock });
await staleSession.requestAccess();
let finishStaleOpen!: () => void;
staleProvider.pauseOpen = new Promise<void>(resolve => { finishStaleOpen = resolve; });
const staleOpenStarted = new Promise<void>(resolve => { staleProvider.didOpen = resolve; });
const staleSelection = staleSession.selectDevice("a");
await staleOpenStarted;
const newSelection = staleSession.selectDevice("b");
staleProvider.closeFailures = 1;
staleProvider.pauseOpen = null;
finishStaleOpen();
await Promise.all([staleSelection, newSelection]);
equal(staleProvider.closes, ["a", "a"], "failed close of a superseded open lost ownership");
check(staleSession.state.status === "connected" && staleSession.state.selectedDeviceId === "b",
  "successor could not recover after a stale connection failed to close");
await staleSession.dispose();

const direct = new MidiInputSession({ onNotes() {} }, { providerFactory: async () => new Provider(), clock });
await direct.selectDevice("missing");
check(direct.state.status === "error", "selection before access hung on an absent device");
await direct.selectDevice("a");
check(direct.state.status === "connected", "selection-before-access failure was not recoverable");
await direct.dispose();

class Port extends EventTarget {
  id = "web";
  name = "Web keyboard";
  manufacturer = "test";
  state = "connected";
  opened = 0;
  closed = 0;
  closeFailures = 0;
  async open(): Promise<void> { this.opened++; }
  async close(): Promise<void> {
    this.closed++;
    if (this.closeFailures > 0) { this.closeFailures--; throw new Error("transient Web MIDI close error"); }
  }
  send(data: number[]): void {
    const event = new Event("midimessage");
    Object.defineProperty(event, "data", { value: Uint8Array.from(data) });
    this.dispatchEvent(event);
  }
}
const port = new Port();
const access = Object.assign(new EventTarget(), { inputs: new Map([[port.id, port]]) });
const web = createWebMidiInputProvider(access as unknown as MIDIAccess);
let webChanges = 0;
const unwatch = web.watchDevices(() => { webChanges++; });
const webNotes: number[][] = [];
const webConnection = await web.connect("web", event => webNotes.push(Array.from(event.data)));
port.send([0x90, 60, 127]);
await webConnection.close();
port.send([0x90, 64, 127]);
equal(webNotes, [[0x90, 60, 127]], "Web MIDI listener survived closing its input");
port.state = "disconnected";
access.dispatchEvent(new Event("statechange"));
equal(await web.listDevices(), [], "Web MIDI listed a disconnected port");
equal(webChanges, 1, "Web MIDI statechange did not refresh devices");
unwatch();
await web.dispose();
access.dispatchEvent(new Event("statechange"));
equal(webChanges, 1, "Web MIDI left a statechange listener installed");
equal(port.closed, 1, "Web MIDI closed the same handle repeatedly");

let nativeCallback: ((message: MidiInputMessage) => void) | null = null;
const nativeIds: string[] = [];
const nativeClosed: string[] = [];
const native = createNativeMidiInputProvider({
  listDevices: async () => [{ id: "native", name: "Native keyboard" }],
  async connect(_deviceId, id, callback) { nativeIds.push(id); nativeCallback = callback; },
  async disconnect(id) { nativeClosed.push(id); },
});
let nativeMessages = 0;
const nativeConnection = await native.connect("native", () => { nativeMessages++; });
(nativeCallback as ((message: MidiInputMessage) => void) | null)?.({ data: [0x90, 60, 100], timestamp: 1 });
await nativeConnection.close();
(nativeCallback as ((message: MidiInputMessage) => void) | null)?.({ data: [0x90, 64, 100], timestamp: 2 });
check(nativeMessages === 1, "native bridge accepted late messages after disconnect");
equal(nativeClosed, nativeIds, "native bridge did not scope disconnect to its connection token");
await native.dispose();

// A failed close must mute the connection without discarding its owned handle.
const flakyPort = new Port();
const flakyAccess = Object.assign(new EventTarget(), { inputs: new Map([[flakyPort.id, flakyPort]]) });
const flakyWeb = createWebMidiInputProvider(flakyAccess as unknown as MIDIAccess);
let afterWebClose = 0;
const flakyWebConnection = await flakyWeb.connect(flakyPort.id, () => { afterWebClose++; });
flakyPort.closeFailures = 1;
await rejects(flakyWebConnection.close(), "temporary Web MIDI close failure was hidden");
flakyPort.send([0x90, 60, 100]);
equal(afterWebClose, 0, "Web MIDI accepted notes after a failed close");
await flakyWeb.dispose();
equal(flakyPort.closed, 2, "Web MIDI dispose lost ownership after a failed close");

const retryPort = new Port();
const retryAccess = Object.assign(new EventTarget(), { inputs: new Map([[retryPort.id, retryPort]]) });
const retryWeb = createWebMidiInputProvider(retryAccess as unknown as MIDIAccess);
await retryWeb.connect(retryPort.id, () => {});
retryPort.closeFailures = 1;
await rejects(retryWeb.dispose(), "provider disposal failure was hidden");
await retryWeb.dispose();
equal(retryPort.closed, 2, "provider disposal failure was not retryable");

class UnpluggingPort extends Port {
  async open(): Promise<void> { this.opened++; this.state = "disconnected"; }
}
const unpluggingPort = new UnpluggingPort();
unpluggingPort.closeFailures = 1;
const unpluggingAccess = Object.assign(new EventTarget(), { inputs: new Map([[unpluggingPort.id, unpluggingPort]]) });
const unpluggingWeb = createWebMidiInputProvider(unpluggingAccess as unknown as MIDIAccess);
await rejects(unpluggingWeb.connect(unpluggingPort.id, () => {}), "unplug-during-open was not reported");
await unpluggingWeb.dispose();
equal(unpluggingPort.closed, 2, "failed cleanup of an unplugged new port lost its handle");

function flakyNativeSession() {
  const bridgeState = { active: null as string | null, attempts: 0, failures: 0, messages: 0 };
  let callback: ((message: MidiInputMessage) => void) | null = null;
  const transport = createNativeMidiInputProvider({
    listDevices: async () => [{ id: "a", name: "Keyboard" }],
    async connect(_deviceId, id, onMessage) { bridgeState.active = id; callback = onMessage; },
    async disconnect(id) {
      bridgeState.attempts++;
      if (bridgeState.failures > 0) { bridgeState.failures--; throw new Error("transient native close error"); }
      if (bridgeState.active === id) bridgeState.active = null;
    },
  });
  const input = new MidiInputSession({ onNotes() { bridgeState.messages++; } }, { providerFactory: async () => transport, clock });
  return { input, bridgeState, send() { callback?.({ data: [0x90, 60, 100], timestamp: clock.now() }); } };
}

const failedDisconnect = flakyNativeSession();
await failedDisconnect.input.requestAccess();
await failedDisconnect.input.selectDevice("a");
failedDisconnect.input.setEnabled(true);
failedDisconnect.bridgeState.failures = 1;
await failedDisconnect.input.disconnect();
check(failedDisconnect.input.state.status === "error" && !!failedDisconnect.bridgeState.active,
  "failed native close pretended the handle was released");
failedDisconnect.send(); clock.advance(60);
equal(failedDisconnect.bridgeState.messages, 0, "failed native close continued delivering notes");
await failedDisconnect.input.disconnect();
check(failedDisconnect.input.state.status === "ready" && !failedDisconnect.bridgeState.active,
  "second disconnect did not release the retained handle");
equal(failedDisconnect.bridgeState.attempts, 2, "disconnect retry skipped the transport");
await failedDisconnect.input.dispose();
equal(failedDisconnect.bridgeState.attempts, 2, "dispose closed an already released native handle");

const failedDispose = flakyNativeSession();
await failedDispose.input.requestAccess();
await failedDispose.input.selectDevice("a");
failedDispose.bridgeState.failures = 2;
await rejects(failedDispose.input.dispose(), "persistent native disposal failure was hidden");
check(!!failedDispose.bridgeState.active, "persistent failure fixture unexpectedly released its handle");
await failedDispose.input.dispose();
check(!failedDispose.bridgeState.active, "session disposal could not retry its retained handle");
equal(failedDispose.bridgeState.attempts, 3, "session disposal lost connection ownership");

let provideLate!: (provider: MidiInputProvider) => void;
const lateAccess = new Promise<MidiInputProvider>(resolve => { provideLate = resolve; });
const lateSession = new MidiInputSession({ onNotes() {} }, { providerFactory: () => lateAccess, clock });
let lateDisposals = 0;
const lateProvider = new Provider();
lateProvider.dispose = async () => {
  lateDisposals++;
  if (lateDisposals === 1) throw new Error("late provider cleanup failed");
};
const accessWhileClosing = lateSession.requestAccess();
const closeWhileRequesting = lateSession.dispose();
provideLate(lateProvider);
await accessWhileClosing;
await rejects(closeWhileRequesting, "late provider cleanup failure was swallowed");
await lateSession.dispose();
equal(lateDisposals, 2, "provider acquired during disposal became unreachable after failure");

let concurrentAttempts = 0;
let finishConcurrent!: () => void;
const concurrentGate = new Promise<void>(resolve => { finishConcurrent = resolve; });
const concurrentNative = createNativeMidiInputProvider({
  listDevices: async () => [{ id: "a", name: "Keyboard" }],
  async connect() {},
  async disconnect() { concurrentAttempts++; await concurrentGate; },
});
const concurrentConnection = await concurrentNative.connect("a", () => {});
const closeA = concurrentConnection.close();
const closeB = concurrentNative.dispose();
await Promise.resolve();
equal(concurrentAttempts, 1, "parallel close and dispose raced the native handle");
finishConcurrent();
await Promise.all([closeA, closeB]);

console.log("MIDI input checks passed: chord timing, reattacks, panic/mode cancellation, hotplug, selection races, Web MIDI and native bridges.");
