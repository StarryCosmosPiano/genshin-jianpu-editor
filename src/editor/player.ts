// In-editor playback. The front-end always owns the play clock and drives the
// cursor-follow highlight; the audio itself comes from one of three sources:
//   - bundled/user SF2: Web Audio + one sampler per assigned instrument timbre
//   - default sampler: Web Audio + smplr FluidR3_GM piano (browser fallback)
//   - native MIDI: system MIDI player via Rust (desktop default)
// See ~/.claude/plans/midi-serialized-snowflake.md.

import { Soundfont, Soundfont2, type Smplr, type StopFn } from "smplr";
import { parseSoundfont } from "./soundfonts";
import { Chord, type Note } from "../score/score";
import {
  buildTimeline,
  buildSelectionTimeline,
  partGain,
  PlayOptions,
  quarterToSeconds,
} from "../score/timeline";
import { timelineToMidi } from "../score/midi";
import { Score } from "../score/score";
import { isTauriRuntime } from "./fileio";

export type PlayState = "stopped" | "loading" | "playing";

interface Anchor {
  t: number; // seconds
  chords: Chord[];
  pass: number;
}

export interface Sf2PlaybackOptions {
  bytes: Uint8Array;
  /** SF2 instrument name for each score part. Missing names use the first timbre. */
  instrumentByPart: string[];
}

/** A short input-mode audition request. `part` selects that row's timbre. */
export interface InputAuditionNote {
  pitch: number;
  part: number;
  /** Full sounding duration in seconds. Omitted for a short cursor preview. */
  durationSeconds?: number;
  /** Relative performed onset, preserving rolled chords and ornaments. */
  offsetSeconds?: number;
}

interface AuditionSession {
  stop: StopFn[];
  timer: number;
}

interface AudioBank {
  context: AudioContext;
  bytes: Uint8Array | undefined;
  mapping: string;
  instruments: Smplr[];
  byPart: Smplr[];
  ready: Promise<void>;
}

export class ScorePlayer {
  state: PlayState = "stopped";

  private ctx: AudioContext | null = null;
  private instruments: Smplr[] = [];
  private useNative = false;
  private raf = 0;
  private startCtxTime = 0; // AudioContext time at note t=0 (sampler)
  private startPerf = 0; // performance.now()/1000 at play start (native)
  private startSec = 0; // timeline seconds the cursor begins at (selection start)
  private anchors: Anchor[] = [];
  private duration = 0; // seconds
  private endTail = 0.3;
  private curIdx = -1;
  private gen = 0; // invalidates in-flight async play() when stop()/replay happens
  private auditionSessions = new Set<AuditionSession>();
  private auditionGen = 0;
  private bank: AudioBank | null = null;
  private selectionScope: ReadonlySet<Note> | undefined;

  constructor(
    private onChord: (chords: Chord[] | null, pass: number, notes?: ReadonlySet<Note>) => void,
    private onStateChange: (state: PlayState) => void,
  ) {}

  get playing(): boolean {
    return this.state === "playing";
  }

  /** Resume directly inside the user's tap, before fetching an optional SF2. */
  unlockAudio(loading = false): void {
    if (loading) this.setState("loading");
    void this.audioContext().resume().catch(() => { /* play() reports a resume failure. */ });
  }

  private audioContext(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      const ctx = new AudioContext();
      this.ctx = ctx;
      ctx.addEventListener("statechange", () => {
        if (ctx !== this.ctx) return;
        const state = String(ctx.state);
        if (state === "interrupted" || state === "suspended" && this.state === "playing") this.stop();
      });
    }
    return this.ctx;
  }

  /** Keep one decoded sampler bank across taps and replay. A changed timbre
   * replaces the bank; ordinary stop only stops voices, not the audio device. */
  private audioBank(sf2?: Sf2PlaybackOptions): AudioBank {
    const ctx = this.audioContext();
    const mapping = JSON.stringify(sf2?.instrumentByPart ?? []);
    if (this.bank && this.bank.context === ctx && this.bank.bytes === sf2?.bytes && this.bank.mapping === mapping) return this.bank;
    this.stopAudition();
    if (this.bank) {
      if (this.instruments === this.bank.instruments) this.instruments = [];
      for (const instrument of this.bank.instruments) instrument.dispose();
    }
    const bank: AudioBank = { context: ctx, bytes: sf2?.bytes, mapping, instruments: [], byPart: [], ready: Promise.resolve() };
    this.bank = bank;
    bank.ready = (async () => {
      try {
        if (sf2) {
          try { bank.byPart = await this.loadSf2Instruments(ctx, sf2, bank.instruments, () => this.bank === bank); }
          catch (error) {
            for (const instrument of bank.instruments) instrument.dispose();
            if (this.bank !== bank) return;
            console.warn("SF2 playback failed; using piano", error);
            bank.instruments = [];
          }
        }
        if (!bank.instruments.length) {
          const piano = Soundfont(ctx, { kit: "FluidR3_GM", instrument: "acoustic_grand_piano" });
          bank.instruments.push(piano);
          await piano.ready;
          bank.byPart = [piano];
        }
      } catch (error) {
        if (this.bank === bank) this.bank = null;
        for (const instrument of bank.instruments) instrument.dispose();
        throw error;
      }
      if (this.bank !== bank) for (const instrument of bank.instruments) instrument.dispose();
    })();
    return bank;
  }

  /** Play a short cursor audition using the assigned SF2 instrument per row. */
  async audition(notes: InputAuditionNote[], sf2?: Sf2PlaybackOptions): Promise<void> {
    if (notes.length === 0) return;
    const ctx = this.audioContext();
    const bank = this.audioBank(sf2);
    const gen = this.auditionGen;
    await ctx.resume();
    await bank.ready;
    if (gen !== this.auditionGen || bank !== this.bank) return;
    // Keep natural overlap, with a bounded number of active audition chords.
    while (this.auditionSessions.size >= 8) {
      const oldest = this.auditionSessions.values().next().value!;
      window.clearTimeout(oldest.timer);
      oldest.stop.forEach(stop => stop());
      this.auditionSessions.delete(oldest);
    }
    const now = ctx.currentTime + 0.015;
    const sessionDuration = Math.max(
      0.05,
      ...notes.map((note) => (note.offsetSeconds ?? 0) + (note.durationSeconds ?? 0.8)),
    );
    const stops: StopFn[] = [];
    for (const note of notes) {
      const instrument = bank.byPart[note.part] ?? bank.instruments[0];
      stops.push(instrument.start({
        note: note.pitch,
        time: now + Math.max(0, note.offsetSeconds ?? 0),
        duration: Math.max(0.05, note.durationSeconds ?? 0.8),
        velocity: 100,
      }));
    }
    const session: AuditionSession = { stop: stops, timer: 0 };
    this.auditionSessions.add(session);
    session.timer = window.setTimeout(() => {
      this.auditionSessions.delete(session);
      session.stop.forEach(stop => stop());
    }, Math.ceil((sessionDuration + 0.35) * 1000));
  }

  stopAudition(): void {
    this.auditionGen++;
    for (const session of this.auditionSessions) {
      window.clearTimeout(session.timer);
      session.stop.forEach(stop => stop());
    }
    this.auditionSessions.clear();
  }

  async play(
    score: Score,
    opts?: PlayOptions,
    start?: { chord: Chord; pass: number },
    sf2?: Sf2PlaybackOptions,
    selection?: ReadonlySet<Note>,
  ): Promise<void> {
    this.stop();
    const gen = this.gen;
    const scope = selection ? new Set(selection) : undefined;
    const tl = scope ? buildSelectionTimeline(score, scope) : buildTimeline(score);
    if (tl.notes.length === 0) return;
    this.selectionScope = scope;

    this.anchors = tl.anchors.map((a) => ({
      t: quarterToSeconds(tl.tempo, a.t0),
      chords: a.chords,
      pass: a.pass,
    }));
    this.duration = quarterToSeconds(tl.tempo, tl.duration);
    this.endTail = selection ? 0 : 0.3;
    this.curIdx = -1;
    // Selecting an SF2 explicitly opts out of the desktop native MIDI player.
    this.useNative = isTauriRuntime() && !sf2;

    // Start offset: if a note is selected, begin at that anchor's time.
    let startSec = selection ? quarterToSeconds(tl.tempo,
      tl.notes.reduce((begin, note) => Math.min(begin, note.t0), Number.POSITIVE_INFINITY)) : 0;
    if (start && !selection) {
      const a =
        tl.anchors.find((x) => x.chords.includes(start.chord) && x.pass === start.pass) ??
        tl.anchors.find((x) => x.chords.includes(start.chord));
      if (a) startSec = quarterToSeconds(tl.tempo, a.t0);
    }
    this.startSec = startSec;

    this.setState("loading");

    if (this.useNative) {
      try {
        const bytes = timelineToMidi(score, tl, opts); // per-part CC7 volume baked in
        const { invoke } = await import("@tauri-apps/api/core");
        if (gen !== this.gen) return;
        await invoke("midi_play_cmd", { bytes: Array.from(bytes), startSeconds: startSec });
        if (gen !== this.gen) {
          void invoke("midi_stop_cmd").catch(() => {});
          return;
        }
        this.startPerf = performance.now() / 1000 - startSec;
      } catch (e) {
        console.warn("native MIDI playback failed, falling back to sampler", e);
        this.useNative = false;
      }
    }

    if (!this.useNative) {
      const ctx = this.audioContext();
      await ctx.resume();
      if (gen !== this.gen) return;
      const bank = this.audioBank(sf2);
      await bank.ready;
      if (gen !== this.gen || bank !== this.bank) return;
      // base maps timeline second `startSec` to `ctx.currentTime + lead`.
      const lead = 0.15;
      const base = ctx.currentTime + lead - startSec;
      for (const n of tl.notes) {
        const t0 = quarterToSeconds(tl.tempo, n.t0);
        const t1 = quarterToSeconds(tl.tempo, n.t1);
        if (t1 <= startSec) continue; // already finished before the start point
        const instrument = bank.byPart[n.part] ?? bank.instruments[0];
        instrument.start({
          note: n.pitch,
          time: Math.max(ctx.currentTime + lead, base + t0),
          duration: Math.max(0.05, t1 - Math.max(t0, startSec)),
          velocity: Math.max(1, Math.round(100 * partGain(opts, n.part))),
        });
      }
      this.ctx = ctx;
      this.instruments = bank.instruments;
      this.startCtxTime = base;
    }

    if (gen !== this.gen) return;
    this.setState("playing");
    this.tick();
  }

  private async loadSf2Instruments(
    ctx: AudioContext,
    options: Sf2PlaybackOptions,
    loaded: Smplr[],
    current: () => boolean,
  ): Promise<Smplr[]> {
    const parsed = parseSoundfont(options.bytes);
    const names = [...new Set(
      parsed.instruments
        .map((instrument) => instrument.header.name.trim())
        .filter(Boolean),
    )];
    const first = names[0];
    if (!first) throw new Error("SF2 音源中没有可播放的音色");

    const resolvedNames = options.instrumentByPart.map((name) =>
      names.includes(name) ? name : first);
    const uniqueNames = [...new Set(resolvedNames.length > 0 ? resolvedNames : [first])];
    const byName = new Map<string, ReturnType<typeof Soundfont2>>();
    const bytes = options.bytes.slice();
    const url = URL.createObjectURL(new Blob([bytes.buffer], { type: "audio/sf2" }));
    try {
      for (const name of uniqueNames) {
        const instrument = Soundfont2(ctx, {
          url,
          createSoundfont: () => parsed,
        });
        loaded.push(instrument);
        await instrument.ready;
        if (!current()) throw new DOMException("音源已切换", "AbortError");
        await instrument.loadInstrument(name);
        if (!current()) throw new DOMException("音源已切换", "AbortError");
        byName.set(name, instrument);
      }
    } finally {
      URL.revokeObjectURL(url);
    }
    const fallback = byName.get(first) ?? byName.values().next().value;
    if (!fallback) throw new Error("SF2 音色加载失败");
    return resolvedNames.map((name) => byName.get(name) ?? fallback);
  }

  stop(): void {
    this.gen++; // invalidate any in-flight play()
    this.stopAudition();
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    for (const instrument of this.instruments) {
      instrument.stop();
    }
    this.instruments = [];
    if (this.useNative) {
      void import("@tauri-apps/api/core").then(({ invoke }) => invoke("midi_stop_cmd")).catch(() => {});
    }
    this.curIdx = -1;
    this.selectionScope = undefined;
    this.onChord(null, 0);
    this.setState("stopped");
  }

  private now(): number {
    return this.useNative
      ? performance.now() / 1000 - this.startPerf
      : this.ctx!.currentTime - this.startCtxTime;
  }

  private tick = (): void => {
    if (this.state !== "playing") return;
    // Clamp to the start point so the sampler's lead-in never lands the cursor
    // on the note just before a selection start.
    const t = Math.max(this.startSec, this.now());
    if (t >= this.duration + this.endTail) {
      this.stop();
      return;
    }
    // Cursor only advances forward; playback time is monotonic.
    let idx = this.curIdx;
    while (idx + 1 < this.anchors.length && this.anchors[idx + 1].t <= t) idx++;
    if (idx !== this.curIdx) {
      this.curIdx = idx;
      const a = idx >= 0 ? this.anchors[idx] : null;
      this.onChord(a ? a.chords : null, a ? a.pass : 0, this.selectionScope);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private setState(s: PlayState): void {
    if (this.state === s) return;
    this.state = s;
    this.onStateChange(s);
  }
}
