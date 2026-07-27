// Ported from JpwImport (mp/score/jpw.kt lines 13-340).
// Builds a Score from a parsed .jpwabc JpwFile (the .jpwabc edit path).

import { Fraction } from "../common/fraction";
import {
  JpwFile,
  RepeatSection,
  VoiceSection,
  WordsSection,
  WordsSegment,
} from "../jpword/jpwfile";
import type { NoteContext } from "../jpword/parser/JpwabcParser";
import {
  BarStyle,
  BarlineEntry,
  Chord,
  Credit,
  doPairTuplet,
  Key,
  LineBreak,
  Measure,
  MusicCommon,
  Note,
  Lyric,
  normalizeOpeningPickup,
  Part,
  PlayItem,
  RepeatSpec,
  Score,
  TempoMark,
  Time,
} from "./score";
import { applyNoteTimingEdits, parseJpwNoteTimingEdits } from "./note-timing";

class JpState {
  inTuplet = false;
  alter: Record<string, number> = {};
  basePitch = 0;
  fifths = 0;
}

function unescape(str: string): string {
  return str.replace(/\\n/g, "\n");
}

function calcPitch(stat: JpState, nt: Note): void {
  if (nt.number === "0") {
    nt.pitch = 0;
    nt.rest = true;
    return;
  }
  let res = stat.basePitch;
  res += nt.jpOctave * 12;
  res += MusicCommon.stepToPitch(nt.number);
  nt.step = MusicCommon.jpToStep(nt.number, stat.basePitch);
  switch (nt.jpAlter) {
    case " ": break;
    case "b": stat.alter[nt.number] = -1; break;
    case "n": delete stat.alter[nt.number]; break;
    case "#": stat.alter[nt.number] = 1; break;
  }
  res += stat.alter[nt.number] ?? 0;
  nt.pitch = res;
}

/** Parentheses have the same visual shape for slurs and ties in JPW text.
 *  When every chord under the arc contains the same sounding pitches, restore
 *  an adjacent semantic tie chain.  In particular `(A A A)` becomes
 *  `A -> A -> A`, rather than the old A -> last-A shortcut that retriggered
 *  the middle chord.  A phrase containing any different chord remains a slur. */
function convertSamePitchSlurToTie(chords: readonly Chord[]): boolean {
  if (chords.length < 2) return false;
  const sounding = chords.map((chord) =>
    chord.notes.filter((note) => !note.rest).sort((a, b) => a.pitch - b.pitch));
  const first = sounding[0];
  if (first.length === 0) return false;
  if (sounding.some((notes) =>
    notes.length !== first.length ||
    notes.some((note, index) => note.pitch !== first[index].pitch))) return false;

  for (let chordIndex = 0; chordIndex < sounding.length - 1; chordIndex++) {
    const starts = sounding[chordIndex];
    const ends = sounding[chordIndex + 1];
    for (let noteIndex = 0; noteIndex < starts.length; noteIndex++) {
      const start = starts[noteIndex];
      const end = ends[noteIndex];
      start.tieStart = true;
      start.tieNext = end;
      end.tieEnd = true;
      end.tiePrev = start;
    }
  }
  for (const chord of chords) {
    chord.slurStart = false;
    chord.slurEnd = false;
    chord.slurEndChord = null;
  }
  return true;
}

function makeChord(note: NoteContext, mea: Measure, stat: JpState): Chord {
  const res = new Chord(mea);
  res.beats = 1;
  let txt = note.Note().getText();
  const tupletText = "{(3}";
  const inTupletBefore = stat.inTuplet;
  const tupletBegins = txt.includes(tupletText);
  if (tupletBegins) {
    if (stat.inTuplet) throw new Error("");
    stat.inTuplet = true;
    txt = txt.replace(tupletText, "");
  }
  const inTupletForChord = inTupletBefore || tupletBegins;
  // 演奏记号 {DunYin|BoYin|YanYin|ZhongYin}（Jpwabc.g4 Articulation）。目前仅渲染延音(fermata)。
  const artMatch = txt.match(/\{(?:DunYin|BoYin|YanYin|ZhongYin)(?:,(?:DunYin|BoYin|YanYin|ZhongYin))*\}/);
  if (artMatch) {
    if (artMatch[0].includes("YanYin")) res.fermata = true;
    txt = txt.replace(artMatch[0], "");
  }

  // Strip JP-Word control blocks before looking for pitches.  Otherwise the
  // numbers in `{C:...}` can be mistaken for notes.  Chords use the existing
  // grammar form `[135]`; every pitch becomes a Note in one Chord and is later
  // rendered as a vertical numbered stack.
  let musical = txt.replace(/\{C:[^}]*\}/g, "");
  const graceMatch = musical.match(/\{((?:(?:#b|#|b)?[0-7](?:[,'gd])*)+)\}/);
  if (graceMatch) musical = musical.replace(graceMatch[0], "");
  const bracket = musical.match(/\[([^\]]+)\]/);
  const pitchSource = bracket?.[1] ?? musical;
  const pitchTexts = pitchSource.match(/(?:#b|#|b)?[0-7](?:[,'gd])*/g) ?? [];
  if (pitchTexts.length === 0) throw new Error("note without pitch");
  const parsePitch = (pitchText: string): Note => {
    const nt = new Note(res);
    const num = pitchText.match(/[0-7]/)?.[0];
    if (!num) throw new Error("note without pitch number");
    nt.number = num;
    if (pitchText.startsWith("#b")) nt.jpAlter = "n";
    else if (pitchText.startsWith("#")) nt.jpAlter = "#";
    else if (pitchText.startsWith("b")) nt.jpAlter = "b";
    nt.jpOctave = (pitchText.match(/'/g)?.length ?? 0) - (pitchText.match(/,/g)?.length ?? 0);
    calcPitch(stat, nt);
    return nt;
  };
  const gracePitches = graceMatch?.[1].match(/(?:#b|#|b)?[0-7](?:[,'gd])*/g) ?? [];
  for (const pitchText of gracePitches) {
    res.graceNotes.push(parsePitch(pitchText));
  }
  for (const pitchText of pitchTexts) {
    res.add(parsePitch(pitchText));
  }
  // Keep the melodic/top note at index 0 because lyrics, ties, selection and
  // several legacy code paths intentionally use notes[0].
  res.notes.sort((a, b) => b.pitch - a.pitch);
  const nt = res.notes[0];
  res.rest = res.notes.every((n) => n.rest);

  const writtenPitch = bracket?.[0] ?? pitchTexts[0]!;
  for (const ch of musical.replace(writtenPitch, "")) {
    switch (ch) {
      case "_": res.beams += 1; break;
      case "-": res.beats++; break;
      case ".": res.dot++; break;
      case "(": res.slurStart = true; break;
      case ")":
        if (stat.inTuplet) {
          stat.inTuplet = false;
          nt.tupletEnd = true;
        } else {
          res.slurEnd = true;
        }
        break;
      default: break;
    }
  }
  if (tupletBegins) nt.tupletBegin = true;
  if (!stat.inTuplet && inTupletBefore) nt.tupletEnd = true;
  let dur = new Fraction(res.beats);
  if (res.dot > 0) {
    dur = dur.timesInt(3);
    dur = dur.divInt(2);
  }
  if (inTupletForChord) {
    dur = dur.timesInt(2);
    dur = dur.divInt(3);
  }
  dur = dur.divInt(1 << res.beams);
  res.duration = dur;
  return res;
}

function updateTimeInf(p: Part): void {
  let pos = new Fraction(0);
  let inTuplet = false;
  for (const m of p.measures) {
    m.position = pos;
    let mpos = new Fraction(0);
    for (const ent of m.entries) {
      ent.position = mpos;
      if (!(ent instanceof Chord)) {
        ent.duration = new Fraction(0);
        continue;
      }
      const ch = ent;
      const tupletBegins = ch.notes.some((note) => note.tupletBegin);
      const tupletEnds = ch.notes.some((note) => note.tupletEnd);
      if (tupletBegins) inTuplet = true;
      let dur = new Fraction(ch.beats);
      dur = dur.divInt(1 << ch.beams);
      if (ch.dot === 1) {
        dur = dur.timesInt(3);
        dur = dur.divInt(2);
      }
      if (inTuplet) {
        dur = dur.timesInt(2);
        dur = dur.divInt(3);
      }
      ch.duration = dur;
      mpos = mpos.plus(dur);
      if (tupletEnds) inTuplet = false;
    }
    pos = pos.plus(mpos);
  }
}

function makePart(sec: VoiceSection, key: Key, ts: Time): Part {
  const res = new Part();
  res.hand = sec.hand;
  res.instrumentName = sec.instrumentName ?? "";
  res.voiceIndex = sec.voiceIndex ?? 1;
  const data = sec.voiceData;
  let mea: Measure | null = null;
  let newMeasure = false;
  let slurChords: Chord[] | null = null;
  const stat = new JpState();
  stat.basePitch = MusicCommon.getBasePitchOfKey(key);
  stat.fifths = key.fifths;
  const tupNotes: Note[] = [];
  let mid = 0;
  let currentTime = new Time(ts.beats, ts.beatType);
  let pendingTimeChange = false;

  for (const e of data.entry_list()) {
    const noteCtx = e.note();
    const barlineCtx = e.barline();
    const linebreakCtx = e.linebreak();
    const timeCtx = e.timesig();
    if (noteCtx) {
      if (mea === null || newMeasure) {
        mea = new Measure(mid);
        mea.time = new Time(currentTime.beats, currentTime.beatType);
        mea.timeChange = mid > 0 && pendingTimeChange;
        mea.key = new Key();
        mea.key.fifths = key.fifths;
        pendingTimeChange = false;
        mid++;
        res.measures.push(mea);
        newMeasure = false;
      }
      const chord = makeChord(noteCtx, mea, stat);
      const nt = chord.notes[0];
      // A serialized tie-chain middle chord is written as `(A (A) A)`, so it
      // simultaneously closes one arc and opens the next.  Pairing the first
      // segment clears its visual slur flags; retain this fact before pairing
      // so the same chord can still seed the following segment.
      const startsFollowingSlur = chord.slurStart;
      if (nt.tupletEnd || nt.tupletBegin) tupNotes.push(nt);
      if (slurChords !== null && !slurChords.includes(chord)) slurChords.push(chord);
      if (chord.slurEnd) {
        if (slurChords !== null && !convertSamePitchSlurToTie(slurChords)) {
          slurChords[0].slurEndChord = chord;
        }
        slurChords = null;
      }
      if (startsFollowingSlur) {
        chord.slurStart = true;
        slurChords = [chord];
      }
      mea.entries.push(chord);
    } else if (barlineCtx) {
      const ent = new BarlineEntry(mea!);
      const txt = barlineCtx.Barline().getText();
      switch (txt) {
        case "|": ent.style = BarStyle.REGULAR; break;
        case "|]": ent.style = BarStyle.LIGHT_HEAVY; break;
        case "[|]": ent.style = BarStyle.NONE; break;
        case "||": ent.style = BarStyle.LIGHT_LIGHT; break;
        case "|:": ent.style = BarStyle.HEAVY_LIGHT; break;
        case ":|": ent.style = BarStyle.LIGHT_HEAVY; break;
        default: throw new Error(`bad barline: ${txt}`);
      }
      mea!.entries.push(ent);
      newMeasure = true;
      stat.alter = {};
    } else if (timeCtx) {
      const match = /^(\d+)\/(\d+)/.exec(timeCtx.TimeSig().getText());
      if (match) {
        const beats = parseInt(match[1], 10);
        const beatType = parseInt(match[2], 10);
        if (beats > 0 && [2, 4, 8, 16].includes(beatType)) {
          currentTime = new Time(beats, beatType);
          pendingTimeChange = true;
        }
      }
    } else if (linebreakCtx) {
      const ret = linebreakCtx.Return().getText();
      const args = substringBefore(substringAfter(ret, "("), ")").split(",");
      let pg = false;
      if (args.length >= 4) pg = args[3].toLowerCase() === "true";
      mea?.lineBreak(pg);
    }
    // TextContext / TimesigContext / prelude: ignored (as in original)
  }

  doPairTuplet(tupNotes);
  updateTimeInf(res);
  return res;
}

function applyTitleAnnotations(
  score: Score,
  tempoText: string | null,
  arpeggioText: string | null,
): void {
  for (const token of tempoText?.split(";") ?? []) {
    const match = /^(\d+)@([^=]+)=(accel|rit|tempo)(?::(\d+))?$/.exec(token.trim());
    if (!match) continue;
    const measure = parseInt(match[1], 10) - 1;
    const offset = Fraction.fromString(match[2]);
    if (measure < 0 || !Number.isFinite(offset.toFloat())) continue;
    const mark = new TempoMark();
    mark.measure = measure;
    mark.offset = offset;
    mark.kind = match[3] as TempoMark["kind"];
    mark.bpm = match[4] ? Math.max(1, parseInt(match[4], 10)) : null;
    if (mark.kind === "tempo" && mark.bpm === null) continue;
    score.tempoMarks.push(mark);
  }

  for (const token of arpeggioText?.split(";") ?? []) {
    const match = /^(\d+):(\d+)@(.+)$/.exec(token.trim());
    if (!match) continue;
    const part = score.parts[parseInt(match[1], 10) - 1];
    const measure = part?.measures[parseInt(match[2], 10) - 1];
    if (!measure) continue;
    const offset = Fraction.fromString(match[3]);
    const chord = measure.entries.find((entry): entry is Chord =>
      entry instanceof Chord && entry.position.equals(offset));
    if (chord) chord.arpeggio = true;
  }
}

export function fromJpw(f: JpwFile): Score | null {
  const res = new Score();
  const title = f.getTitle();
  res.title = unescape(title?.title ?? "");
  res.subtitle = unescape(title?.subtitle ?? "");
  res.composer = unescape(title?.composer ?? "");
  res.arranger = unescape(title?.arranger ?? "");
  res.lyricist = unescape(title?.lyricist ?? "");
  res.instrumentName = unescape(title?.instrument ?? "");
  res.tempoBpm = title?.tempo ?? 90;
  res.tempoBeatUnit = title?.tempoUnit ?? "quarter";
  const key = title?.key ?? "C";
  const author = title?.wordsMusicBy ?? null;
  if (author !== null) {
    for (const line of unescape(author).split("\n")) {
      const match = /^(作词|词|作曲|曲|编曲|编)\s*[：:]\s*(.+)$/.exec(line.trim());
      if (!match) continue;
      if ((match[1] === "作词" || match[1] === "词") && !res.lyricist) res.lyricist = match[2].trim();
      if ((match[1] === "作曲" || match[1] === "曲") && !res.composer) res.composer = match[2].trim();
      if ((match[1] === "编曲" || match[1] === "编") && !res.arranger) res.arranger = match[2].trim();
    }
    const cred = new Credit();
    cred.text = unescape(author);
    cred.page = 0;
    res.credit.push(cred);
  }
  const tm = title?.meter ?? "4/4";
  const tmArr = tm.split("/");
  const ts = new Time();
  ts.beatType = parseInt(tmArr[1], 10);
  ts.beats = parseInt(tmArr[0], 10);
  const kk = new Key();
  kk.fifths = MusicCommon.keyNameToFifth(key);
  const voices = f.getVoices();
  if (voices.length === 0) return null;
  const ensembleVoices = voices.filter((voice) => voice.instrumentName !== null && voice.voiceIndex !== null);
  if (ensembleVoices.length > 0) {
    if (ensembleVoices.length !== voices.length) {
      throw new Error("总谱声部不能与 .Voice 或 .Voice.RH/.Voice.LH 混用");
    }
    const groupOrder = new Map<string, number>();
    for (const voice of ensembleVoices) {
      const name = voice.instrumentName!;
      if (!groupOrder.has(name)) groupOrder.set(name, groupOrder.size);
    }
    const ordered = [...ensembleVoices].sort((a, b) =>
      groupOrder.get(a.instrumentName!)! - groupOrder.get(b.instrumentName!)! ||
      a.voiceIndex! - b.voiceIndex!,
    );
    for (const voice of ordered) res.parts.push(makePart(voice, kk, ts));
    res.ensemble = true;
    applyTitleAnnotations(res, title?.tempoMarks ?? null, title?.arpeggios ?? null);
    const primary = res.parts[0];
    const lrc = f.getLyric();
    let pass = 0;
    if (lrc !== null) {
      assignLrcSection(primary, lrc);
      for (const it of lrc.segments) pass = Math.max(pass, it.passLast);
    }
    normalizeOpeningPickup(res);
    applyNoteTimingEdits(res, parseJpwNoteTimingEdits(title?.noteTimingEdits), "jpw");
    processRepeat(res, primary, pass, f.getSection(RepeatSection));
    return res;
  }
  const rightVoice = f.getVoice("right");
  const leftVoice = f.getVoice("left");
  const piano = rightVoice !== null || leftVoice !== null;
  if (piano && (!rightVoice || !leftVoice)) {
    throw new Error("钢琴简谱需要同时包含 .Voice.RH 和 .Voice.LH");
  }
  const part = makePart((piano ? rightVoice : f.getVoice())!, kk, ts);
  const lrc = f.getLyric();
  let pass = 0;
  if (lrc !== null) {
    assignLrcSection(part, lrc);
    for (const it of lrc.segments) pass = Math.max(pass, it.passLast);
  }
  res.parts.push(part);
  if (piano) {
    const left = makePart(leftVoice!, kk, ts);
    res.parts.push(left);
    res.piano = true;
    if (!res.instrumentName.trim()) res.instrumentName = "钢琴";
  }
  applyTitleAnnotations(res, title?.tempoMarks ?? null, title?.arpeggios ?? null);
  normalizeOpeningPickup(res);
  applyNoteTimingEdits(res, parseJpwNoteTimingEdits(title?.noteTimingEdits), "jpw");
  processRepeat(res, part, pass, f.getSection(RepeatSection));
  return res;
}

function processRepeat(
  res: Score,
  part: Part,
  pass: number,
  rep: RepeatSection | null,
): void {
  if (rep === null) {
    const end = res.piano || res.ensemble
      ? Math.max(...res.parts.map((p) => p.measures.length))
      : part.measures.length;
    for (let pp = 0; pp < Math.max(1, pass); pp++) {
      const p = new PlayItem();
      p.pass = 1 + pp;
      p.mid = 0;
      p.end = end;
      res.playData.measures.push(p);
    }
    res.playData.isSimpple = true;
  } else {
    const ss = rep.data.join("\n");
    const spec = new RepeatSpec(ss);
    res.doRepeat(spec);
  }
}

function assignLrcSeg(part: Part, seg: WordsSegment): void {
  const notes: Note[] = [];
  let mid = 0;
  for (const m of part.measures) {
    mid++;
    let nid = 0;
    for (const ent of m.entries) {
      if (ent instanceof LineBreak) {
        if (ent !== m.entries[m.entries.length - 1]) {
          mid++;
          nid = 0;
        }
        continue;
      }
      if (!(ent instanceof Chord)) continue;
      nid++;
      if (mid < seg.measure) continue;
      if (mid === seg.measure && nid < seg.noteIndex) continue;
      notes.push(ent.notes[0]);
    }
  }
  let idx = 0;
  for (const it of seg.data) {
    if (idx >= notes.length) break;
    for (let pass = seg.passFirst; pass <= seg.passLast; pass++) {
      const lrc = new Lyric();
      lrc.number = pass;
      if (it.text.length > 0) {
        lrc.text = it.text;
        notes[idx].lyrics.push(lrc);
      }
    }
    idx++;
  }
}

function assignLrcSection(part: Part, sec: WordsSection): void {
  for (const seg of sec.segments) assignLrcSeg(part, seg);
}

// Kotlin substringAfter/substringBefore semantics.
function substringAfter(s: string, delim: string): string {
  const i = s.indexOf(delim);
  return i < 0 ? s : s.substring(i + delim.length);
}
function substringBefore(s: string, delim: string): string {
  const i = s.indexOf(delim);
  return i < 0 ? s : s.substring(0, i);
}
