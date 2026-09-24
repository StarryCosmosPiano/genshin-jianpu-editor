// In-editor playback. The front-end always owns the play clock and drives the
// cursor-follow highlight; the audio itself comes from one of three sources:
//   - bundled/user SF2: Web Audio + one sampler per assigned instrument timbre
//   - default sampler: Web Audio + smplr FluidR3_GM piano (browser fallback)
//   - native MIDI: system MIDI player via Rust (desktop default)
// See ~/.claude/plans/midi-serialized-snowflake.md.

import { Soundfont, Soundfont2, type Smplr } from "smplr";
import { SoundFont2 } from "soundfont2";
import { Chord } from "../score/score";
import {
  buildTimeline,
  partGain,
  PlayOptions,
  quarterToSeconds,
} from "../score/timeline";
import { scoreToMidi } from "../score/midi";
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
}

interface AuditionSession {
  ctx: AudioContext;
  instruments: Smplr[];
  timer: number;
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
  private curIdx = -1;
  private gen = 0; // invalidates in-flight async play() when stop()/replay happens
  private auditionSessions = new Set<AuditionSession>();
  private auditionGen = 0;

  constructor(
    private onChord: (chords: Chord[] | null, pass: number) => void,
    private onStateChange: (state: PlayState) => void,
  ) {}

  get playing(): boolean {
    return this.state === "playing";
  }

  /** Play a short cursor audition using the assigned SF2 instrument per row. */
  async audition(notes: InputAuditionNote[], sf2?: Sf2PlaybackOptions): Promise<void> {
    if (notes.length === 0) return;
    // Do not stop the previous session here.  A new cursor position may be
    // selected while the previous chord is still sounding; Web Audio can
    // overlap these sessions naturally and stopAudition() remains the explicit
    // cancellation point used when leaving input mode.
    const gen = this.auditionGen;
    const ctx = new AudioContext();
    await ctx.resume();
    let instruments: Smplr[] = [];
    let byPart: Smplr[] = [];
    if (sf2) {
      try {
        byPart = await this.loadSf2Instruments(ctx, sf2, instruments);
      } catch (error) {
        console.warn("input audition SF2 failed; using piano", error);
        for (const instrument of instruments) instrument.dispose();
        instruments = [];
        byPart = [];
      }
    }
    if (instruments.length === 0) {
      const piano = Soundfont(ctx, {
        kit: "FluidR3_GM",
        instrument: "acoustic_grand_piano",
      });
      instruments.push(piano);
      await piano.ready;
      byPart = notes.map(() => piano);
    }
    if (gen !== this.auditionGen) {
      for (const instrument of instruments) instrument.dispose();
      void ctx.close();
      return;
    }
    const now = ctx.currentTime + 0.015;
    const sessionDuration = Math.max(
      0.05,
      ...notes.map((note) => note.durationSeconds ?? 0.8),
    );
    for (const note of notes) {
      const instrument = byPart[note.part] ?? instruments[0];
      instrument.start({
        note: note.pitch,
        time: now,
        duration: Math.max(0.05, note.durationSeconds ?? 0.8),
        velocity: 100,
      });
    }
    const session: AuditionSession = { ctx, instruments, timer: 0 };
    this.auditionSessions.add(session);
    session.timer = window.setTimeout(() => {
      this.auditionSessions.delete(session);
      for (const instrument of session.instruments) {
        instrument.stop();
        instrument.dispose();
      }
      void session.ctx.close();
    }, Math.ceil((sessionDuration + 0.35) * 1000));
  }

  stopAudition(): void {
    this.auditionGen++;
    for (const session of this.auditionSessions) {
      window.clearTimeout(session.timer);
      for (const instrument of session.instruments) {
        instrument.stop();
        instrument.dispose();
      }
      void session.ctx.close();
    }
    this.auditionSessions.clear();
  }

  async play(
    score: Score,
    opts?: PlayOptions,
    start?: { chord: Chord; pass: number },
    sf2?: Sf2PlaybackOptions,
  ): Promise<void> {
    this.stop();
    const gen = this.gen;
    const tl = buildTimeline(score);
    if (tl.notes.length === 0) return;

    this.anchors = tl.anchors.map((a) => ({
      t: quarterToSeconds(tl.tempo, a.t0),
      chords: a.chords,
      pass: a.pass,
    }));
    this.duration = tl.tempo.durationSeconds;
    this.curIdx = -1;
    // Selecting an SF2 explicitly opts out of the desktop native MIDI player.
    this.useNative = isTauriRuntime() && !sf2;

    // Start offset: if a note is selected, begin at that anchor's time.
    let startSec = 0;
    if (start) {
      const a =
        tl.anchors.find((x) => x.chords.includes(start.chord) && x.pass === start.pass) ??
        tl.anchors.find((x) => x.chords.includes(start.chord));
      if (a) startSec = quarterToSeconds(tl.tempo, a.t0);
    }
    this.startSec = startSec;

    this.setState("loading");

    if (this.useNative) {
      try {
        const bytes = scoreToMidi(score, opts); // per-part CC7 volume baked in
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
      const ctx = new AudioContext();
      await ctx.resume();
      if (gen !== this.gen) {
        void ctx.close();
        return;
      }
      let instruments: Smplr[] = [];
      let instrumentByPart: Smplr[] = [];
      if (sf2) {
        try {
          instrumentByPart = await this.loadSf2Instruments(ctx, sf2, instruments);
        } catch (error) {
          console.warn("SF2 playback failed, falling back to the default piano sampler", error);
          for (const instrument of instruments) instrument.dispose();
          instruments = [];
          instrumentByPart = [];
        }
      }
      if (instruments.length === 0) {
        const fallback = Soundfont(ctx, {
          kit: "FluidR3_GM",
          instrument: "acoustic_grand_piano",
        });
        instruments.push(fallback);
        await fallback.ready;
        instrumentByPart = score.parts.map(() => fallback);
      }
      if (gen !== this.gen) {
        for (const instrument of instruments) instrument.dispose();
        void ctx.close();
        return;
      }
      // base maps timeline second `startSec` to `ctx.currentTime + lead`.
      const lead = 0.15;
      const base = ctx.currentTime + lead - startSec;
      for (const n of tl.notes) {
        const t0 = quarterToSeconds(tl.tempo, n.t0);
        const t1 = quarterToSeconds(tl.tempo, n.t1);
        if (t1 <= startSec) continue; // already finished before the start point
        const instrument = instrumentByPart[n.part] ?? instruments[0];
        instrument.start({
          note: n.pitch,
          time: Math.max(ctx.currentTime + lead, base + t0),
          duration: Math.max(0.05, t1 - Math.max(t0, startSec)),
          velocity: Math.max(1, Math.round(100 * partGain(opts, n.part))),
        });
      }
      this.ctx = ctx;
      this.instruments = instruments;
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
  ): Promise<Smplr[]> {
    const parsed = new SoundFont2(options.bytes);
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
        await instrument.loadInstrument(name);
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
      instrument.dispose();
    }
    this.instruments = [];
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    if (this.useNative) {
      void import("@tauri-apps/api/core").then(({ invoke }) => invoke("midi_stop_cmd")).catch(() => {});
    }
    this.curIdx = -1;
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
    if (t >= this.duration + 0.3) {
      this.stop();
      return;
    }
    // Cursor only advances forward; playback time is monotonic.
    let idx = this.curIdx;
    while (idx + 1 < this.anchors.length && this.anchors[idx + 1].t <= t) idx++;
    if (idx !== this.curIdx) {
      this.curIdx = idx;
      const a = idx >= 0 ? this.anchors[idx] : null;
      this.onChord(a ? a.chords : null, a ? a.pass : 0);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private setState(s: PlayState): void {
    if (this.state === s) return;
    this.state = s;
    this.onStateChange(s);
  }
}
