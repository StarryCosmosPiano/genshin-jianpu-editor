import type {
  MidiKeySignatureEvent,
  MidiTempoEvent,
  MidiTimeSignatureEvent,
  MidiTrackInfo,
  ParsedMidi,
  ParsedMidiNote,
} from "./types";

class MidiReader {
  pos = 0;
  constructor(
    readonly bytes: Uint8Array,
    readonly end = bytes.length,
  ) {}

  private need(n: number): void {
    if (this.pos + n > this.end) throw new Error("MIDI 文件已截断");
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.pos++];
  }

  peek(): number {
    this.need(1);
    return this.bytes[this.pos];
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  u32(): number {
    return ((this.u8() * 0x1000000) + (this.u8() << 16) + (this.u8() << 8) + this.u8()) >>> 0;
  }

  take(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  text4(): string {
    return String.fromCharCode(...this.take(4));
  }

  vlq(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      value = value * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) return value;
    }
    throw new Error("MIDI 可变长度整数无效");
  }
}

interface ActiveNote {
  tick: number;
  velocity: number;
}

function decodedTextScore(text: string): number {
  let score = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "�") score -= 100;
    else if ((code < 0x20 && char !== "\t" && char !== "\n" && char !== "\r") || code === 0x7f) score -= 30;
    else if (/\p{Script=Han}/u.test(char)) score += 6;
    else if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(char)) score += 8;
    else if (/[\p{L}\p{N}\p{P}\p{Zs}]/u.test(char)) score += 1;
  }
  return score;
}

function sanitizeMidiText(value: string): string {
  const text = value.replace(/\0/g, "").trim();
  if (!text) return "";
  const chars = Array.from(text);
  const placeholders = chars.filter((char) => /[□■▢▣▯�]/u.test(char)).length;
  // A number of Windows MIDI files contain literal square placeholders in
  // their meta title. Treat that as missing metadata so the real file name
  // can be used instead of displaying tofu to the user.
  if (placeholders >= 2 && placeholders / chars.length >= 0.5) return "";
  return text;
}

/**
 * SMF text meta events do not declare an encoding. Prefer strict UTF-8, then
 * try the common East-Asian legacy encodings used by Windows MIDI files.
 */
function decodeText(bytes: Uint8Array): string {
  const clean = sanitizeMidiText;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return clean(new TextDecoder("utf-16le").decode(bytes.subarray(2)));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return clean(new TextDecoder("utf-16be").decode(bytes.subarray(2)));
  }
  try {
    return clean(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // Continue with legacy encodings below.
  }
  const encodings = ["gb18030", "big5", "shift_jis"];
  if (bytes.length % 2 === 0) encodings.push("utf-16le", "utf-16be");
  encodings.push("windows-1252");
  const candidates = encodings
    .map((encoding) => {
      try {
        const text = clean(new TextDecoder(encoding).decode(bytes));
        return { text, score: decodedTextScore(text) };
      } catch {
        return null;
      }
    })
    .filter((item): item is { text: string; score: number } => item !== null);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.text ?? clean(new TextDecoder("utf-8").decode(bytes));
}

function signedByte(n: number): number {
  return n >= 128 ? n - 256 : n;
}

function dataLength(status: number): 1 | 2 {
  const kind = status & 0xf0;
  return kind === 0xc0 || kind === 0xd0 ? 1 : 2;
}

/** Parse a Standard MIDI File (format 0/1, PPQ timing) without external dependencies. */
export function parseMidi(bytes: Uint8Array): ParsedMidi {
  const rd = new MidiReader(bytes);
  if (rd.text4() !== "MThd") throw new Error("不是有效的标准 MIDI 文件");
  const headerLen = rd.u32();
  if (headerLen < 6) throw new Error("MIDI 文件头长度无效");
  const format = rd.u16();
  if (format === 2) throw new Error("暂不支持包含多个独立乐曲的 MIDI Format 2");
  if (format !== 0 && format !== 1) throw new Error(`不支持的 MIDI Format ${format}`);
  const trackCount = rd.u16();
  const division = rd.u16();
  if ((division & 0x8000) !== 0) throw new Error("暂不支持 SMPTE 时间制 MIDI，请使用 PPQ MIDI");
  if (division === 0) throw new Error("MIDI PPQ 不能为 0");
  if (headerLen > 6) rd.take(headerLen - 6);

  const notes: ParsedMidiNote[] = [];
  const tempos: MidiTempoEvent[] = [];
  const timeSignatures: MidiTimeSignatureEvent[] = [];
  const keySignatures: MidiKeySignatureEvent[] = [];
  const tracks: MidiTrackInfo[] = [];
  let title = "";
  let fallbackTitle = "";
  let ignoredEvents = 0;
  let endTick = 0;

  for (let ti = 0; ti < trackCount; ti++) {
    if (rd.text4() !== "MTrk") throw new Error(`第 ${ti + 1} 个 MIDI 轨道缺少 MTrk 标记`);
    const len = rd.u32();
    const trackEnd = rd.pos + len;
    if (trackEnd > bytes.length) throw new Error(`第 ${ti + 1} 个 MIDI 轨道已截断`);
    const tr = new MidiReader(bytes, trackEnd);
    tr.pos = rd.pos;
    let tick = 0;
    let runningStatus = 0;
    let name = "";
    const beforeNotes = notes.length;
    const active = new Map<string, ActiveNote[]>();

    while (tr.pos < trackEnd) {
      tick += tr.vlq();
      endTick = Math.max(endTick, tick);
      let status: number;
      if (tr.peek() >= 0x80) {
        status = tr.u8();
        if (status < 0xf0) runningStatus = status;
      } else {
        if (runningStatus === 0) throw new Error(`第 ${ti + 1} 轨 running status 无效`);
        status = runningStatus;
      }

      if (status === 0xff) {
        runningStatus = 0;
        const type = tr.u8();
        const size = tr.vlq();
        const data = tr.take(size);
        if ((type === 0x03 || type === 0x01) && data.length > 0) {
          const text = decodeText(data);
          if (type === 0x03) {
            if (!name) name = text;
            if (!title && text) title = text;
          } else if (!fallbackTitle && text) {
            fallbackTitle = text;
          }
        } else if (type === 0x51 && data.length === 3) {
          const mpqn = data[0] * 65536 + data[1] * 256 + data[2];
          if (mpqn > 0) tempos.push({ tick, bpm: 60000000 / mpqn });
        } else if (type === 0x58 && data.length >= 2) {
          timeSignatures.push({ tick, beats: data[0], beatType: 1 << data[1] });
        } else if (type === 0x59 && data.length >= 2) {
          keySignatures.push({ tick, fifths: signedByte(data[0]), minor: data[1] !== 0 });
        }
        if (type === 0x2f) break;
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        runningStatus = 0;
        tr.take(tr.vlq());
        ignoredEvents++;
        continue;
      }
      if (status >= 0xf0) throw new Error(`不支持的 MIDI 系统事件 0x${status.toString(16)}`);

      const channel = status & 0x0f;
      const kind = status & 0xf0;
      const a = tr.u8();
      const b = dataLength(status) === 2 ? tr.u8() : 0;
      const isOn = kind === 0x90 && b > 0;
      const isOff = kind === 0x80 || (kind === 0x90 && b === 0);
      if (channel === 9) {
        if (isOn || isOff) ignoredEvents++;
        continue;
      }
      if (isOn) {
        const key = `${channel}:${a}`;
        const queue = active.get(key) ?? [];
        queue.push({ tick, velocity: b });
        active.set(key, queue);
      } else if (isOff) {
        const key = `${channel}:${a}`;
        const queue = active.get(key);
        const on = queue?.shift();
        if (queue && queue.length === 0) active.delete(key);
        if (!on || tick <= on.tick) {
          ignoredEvents++;
        } else {
          notes.push({ startTick: on.tick, endTick: tick, pitch: a, velocity: on.velocity, channel, track: ti });
        }
      } else {
        ignoredEvents++;
      }
    }

    for (const queue of active.values()) ignoredEvents += queue.length;
    tracks.push({ index: ti, name, noteCount: notes.length - beforeNotes });
    rd.pos = trackEnd;
  }

  notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch || a.endTick - b.endTick);
  tempos.sort((a, b) => a.tick - b.tick);
  timeSignatures.sort((a, b) => a.tick - b.tick);
  keySignatures.sort((a, b) => a.tick - b.tick);
  if (notes.length === 0) throw new Error("MIDI 中没有可导入的非打击乐音符");

  return {
    format,
    ppq: division,
    trackCount,
    title: title || fallbackTitle,
    tracks,
    notes,
    tempos,
    timeSignatures,
    keySignatures,
    ignoredEvents,
    endTick,
  };
}
