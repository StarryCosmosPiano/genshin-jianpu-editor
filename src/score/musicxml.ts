// MusicXML -> Score, ported from score.kt (Score.load / Part.load / Measure.load /
// Note.load / parse*) + musicxml-ext.kt, using the browser DOMParser instead of JAXB.
// Reuses the existing TS Score model + Fraction/MusicCommon/AccidentalStat.

import { Fraction } from "../common/fraction";
import {
  BarStyle,
  BarlineEntry,
  Chord,
  Credit,
  AccidentalStat,
  JumpSpec,
  KeyMark,
  Lyric,
  Measure,
  Note,
  normalizeOpeningPickup,
  ParserTemp,
  Part,
  PlayData,
  PlaySpecKind,
  Score,
  StartStopDiscontinue,
  TempoMark,
  TimePosition,
  type TempoBeatUnit,
} from "./score";

// ---------------- DOM helpers ----------------
function elems(parent: Element, tag: string): Element[] {
  const out: Element[] = [];
  for (const n of Array.from(parent.children)) if (n.tagName === tag) out.push(n);
  return out;
}
function elem(parent: Element, tag: string): Element | null {
  for (const n of Array.from(parent.children)) if (n.tagName === tag) return n;
  return null;
}
function txt(parent: Element, tag: string): string | null {
  const e = elem(parent, tag);
  return e ? (e.textContent ?? "") : null;
}
function normText(s: string | null): string | null {
  const t = s?.trim() ?? "";
  return t.length > 0 ? t : null;
}
function intOf(parent: Element, tag: string): number | null {
  const t = txt(parent, tag);
  return t === null || t.trim() === "" ? null : parseInt(t.trim(), 10);
}
function has(parent: Element, tag: string): boolean {
  return elem(parent, tag) !== null;
}

// ---------------- per-measure parse state ----------------
interface MState {
  pos: Fraction; // raw (un-divided) running position within measure
  noteEnd: Fraction;
}

interface ImportedTempoEvent {
  measure: number;
  offset: Fraction;
  bpm: number;
  beatUnit: TempoBeatUnit;
}

interface ImportedKeyEvent {
  measure: number;
  offset: Fraction;
  fifths: number;
}

function noteDuration(noteEl: Element): Fraction {
  return new Fraction(intOf(noteEl, "duration") ?? 0);
}

function parseTimeSig(timeEl: Element): [number, number] {
  let beats = 4, beatType = 4;
  for (const c of Array.from(timeEl.children)) {
    if (c.tagName === "beats") beats = parseInt(c.textContent ?? "4", 10);
    else if (c.tagName === "beat-type") beatType = parseInt(c.textContent ?? "4", 10);
  }
  return [beats, beatType];
}

// ---------------- Note ----------------
const PITCH_MAP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function loadNote(nt: Note, noteEl: Element): void {
  const pit = elem(noteEl, "pitch");
  if (pit) {
    nt.octave = intOf(pit, "octave") ?? 0;
    nt.step = (txt(pit, "step") ?? " ")[0];
    const alter = intOf(pit, "alter");
    if (alter !== null) nt.alter = alter;
    nt.pitch = (nt.octave + 1) * 12 + (PITCH_MAP[nt.step] ?? 0) + nt.alter;
  } else {
    nt.pitch = 0;
  }
  if (has(noteEl, "rest")) nt.rest = true;
  parseLrc(nt, noteEl);
  parseNotations(nt, noteEl);
}

function parseLrc(nt: Note, noteEl: Element): void {
  for (const lyricEl of elems(noteEl, "lyric")) {
    let text = "";
    for (const t of elems(lyricEl, "text")) text += t.textContent ?? "";
    if (text.length === 0) continue;
    const lrc = new Lyric();
    lrc.text = text;
    const number = lyricEl.getAttribute("number") ?? "1";
    if (number === "chorus") {
      lrc.refrain = true;
      lrc.number = 1;
    } else {
      lrc.number = number.charCodeAt(number.length - 1) - "0".charCodeAt(0);
      if (lrc.number > 10) console.error("bad lrc number " + lrc.number);
    }
    nt.lyrics.push(lrc);
  }
}

function parseNotations(nt: Note, noteEl: Element): void {
  const nts = elem(noteEl, "notations");
  if (!nts) return;
  for (const it of Array.from(nts.children)) {
    if (it.tagName === "tied") {
      const ty = it.getAttribute("type");
      if (ty === "start") nt.tieStart = true;
      else if (ty === "stop") nt.tieEnd = true;
    } else if (it.tagName === "tuplet") {
      if (it.getAttribute("type") === "start") nt.tupletBegin = true;
      else nt.tupletEnd = true;
    } else if (it.tagName === "fermata") {
      nt.chord.fermata = true;
    } else if (it.tagName === "slur") {
      const ty = it.getAttribute("type");
      if (ty === "start") nt.chord.slurStart = true;
      else if (ty === "stop") nt.chord.slurEnd = true;
    } else if (it.tagName === "arpeggiate") {
      nt.chord.arpeggio = true;
    } else if (it.tagName === "ornaments") {
      for (const ornament of Array.from(it.children)) {
        const value = ornament.tagName === "inverted-mordent"
          ? { kind: "upper-mordent" as const }
          : ornament.tagName === "mordent"
            ? { kind: "lower-mordent" as const }
            : ornament.tagName === "trill-mark"
              ? { kind: "trill" as const, subdivision: 32 as const }
              : null;
        if (value && !nt.chord.ornaments.some((existing) => existing.kind === value.kind)) {
          nt.chord.ornaments.push(value);
        }
      }
    }
  }
}

function parseDuration(ch: Chord, noteEl: Element): void {
  if (has(noteEl, "dot")) ch.dot = 1;
  const type = txt(noteEl, "type");
  switch (type) {
    case "whole": ch.beats = 4; ch.beams = 0; break;
    case "half": ch.beats = 2; ch.beams = 0; break;
    case "quarter": ch.beats = 1; ch.beams = 0; break;
    case "eighth": ch.beats = 1; ch.beams = 1; break;
    case "16th": ch.beats = 1; ch.beams = 2; break;
    case "32nd": ch.beats = 1; ch.beams = 4; break;
    case null:
      if (has(noteEl, "rest")) { ch.beats = 4; ch.beams = 0; return; }
      break;
    default: throw new Error("bad note type " + type);
  }
  if (ch.dot === 1 && ch.beats > 1) { ch.beats = (ch.beats * 3) / 2; }
}

// ---------------- Measure ----------------
function onNote(
  m: Measure,
  noteEl: Element,
  tmp: ParserTemp,
  div: number,
  st: MState,
  staffFilter: number | null,
): void {
  if (has(noteEl, "grace")) return;
  const isChord = has(noteEl, "chord");
  const noteStaff = intOf(noteEl, "staff") ?? 1;
  // A piano part is parsed twice (staff 1 -> RH, staff 2 -> LH).  Even when a
  // note belongs to the other staff we must advance the MusicXML cursor so the
  // selected staff keeps its original rhythmic positions after backup/forward.
  if (staffFilter !== null && noteStaff !== staffFilter) {
    if (!isChord) {
      st.pos = st.noteEnd;
      if (!has(noteEl, "duration")) throw new Error("note without duration");
      st.noteEnd = st.pos.plus(noteDuration(noteEl));
    }
    return;
  }
  const newChord = m.entries.length === 0 || !isChord;
  if (newChord) m.add(new Chord(m));
  const last = m.entries[m.entries.length - 1] as Chord;
  const nt = new Note(last);
  loadNote(nt, noteEl);
  if (last.slurEnd) {
    if (tmp.slurStart) tmp.slurStart.slurEndChord = last;
  } else if (last.slurStart) {
    tmp.slurStart = last;
  }
  if (nt.tieStart || nt.tieEnd) tmp.tieNotes.push(nt);
  if (nt.tupletBegin || nt.tupletEnd) tmp.tupletNotes.push(nt);
  last.add(nt);
  if (newChord) {
    st.pos = st.noteEnd;
    if (!has(noteEl, "duration")) throw new Error("note without duration");
    st.noteEnd = st.pos.plus(noteDuration(noteEl));
    parseDuration(last, noteEl);
    last.position = st.pos.divInt(div);
    last.duration = noteDuration(noteEl).divInt(div);
    last.voice = intOf(noteEl, "voice") ?? 1;
    last.rest = nt.rest;
  }
}

function rememberKey(
  keys: ImportedKeyEvent[] | null,
  event: ImportedKeyEvent,
): void {
  if (!keys) return;
  const existing = keys.findIndex((item) =>
    item.measure === event.measure && item.offset.equals(event.offset));
  if (existing >= 0) keys[existing] = event;
  else keys.push(event);
}

function parseAttribute(
  m: Measure,
  attrEl: Element,
  offset: Fraction,
  keys: ImportedKeyEvent[] | null,
): void {
  for (const k of elems(attrEl, "key")) {
    const fifths = intOf(k, "fifths");
    if (fifths !== null) {
      if (offset.equals(0)) {
        m.key.fifths = fifths;
        m.keyChange = true;
      }
      rememberKey(keys, { measure: m.index, offset, fifths });
    }
  }
  for (const t of elems(attrEl, "time")) {
    const [beats, beatType] = parseTimeSig(t);
    m.time.beats = beats;
    m.time.beatType = beatType;
    m.timeChange = true;
  }
}

function parsePrint(m: Measure, printEl: Element): void {
  if (printEl.getAttribute("new-system") === "yes") m.newSystem = true;
  if (printEl.getAttribute("new-page") === "yes") { m.newSystem = true; m.newPage = true; }
}

function parseBarline(m: Measure, blEl: Element, st: MState): void {
  const loc = blEl.getAttribute("location") ?? "right";
  const st0 = txt(blEl, "bar-style");
  if (st0 !== null) {
    const style = st0 as BarStyle;
    if (loc === "left") m.leftBarline = style;
    else m.barline = style;
    const be = new BarlineEntry(m);
    be.style = style;
    be.position = st.pos;
    m.entries.push(be);
  }
  const rep = elem(blEl, "repeat");
  if (rep) {
    if (rep.getAttribute("direction") === "backward") m.repeatBackward = true;
    else m.repeatForward = true;
  }
  const ending = elem(blEl, "ending");
  if (ending) {
    if (loc === "left") {
      m.endingNum = m.parseEndingNum(ending.getAttribute("number"));
      m.endingLeft = true;
    } else {
      m.endingRight = (ending.getAttribute("type") as StartStopDiscontinue) ?? null;
    }
  }
}

function parseSound(snd: Element, pd: PlayData, mid: number, offset: Fraction): void {
  const tick = new TimePosition(mid, offset);
  const coda = snd.getAttribute("coda");
  const segno = snd.getAttribute("segno");
  if (coda) pd.coda.set(coda, tick);
  if (segno) pd.segno.set(segno, tick);
  if (snd.getAttribute("dacapo")) pd.jumpTo.set(tick, new JumpSpec(PlaySpecKind.Dacapo));
  if (snd.getAttribute("fine")) pd.jumpTo.set(tick, new JumpSpec(PlaySpecKind.Fine));
  const dalsegno = snd.getAttribute("dalsegno");
  if (dalsegno) { const s = new JumpSpec(PlaySpecKind.DalSegno); s.value = dalsegno; pd.jumpTo.set(tick, s); }
  const tocoda = snd.getAttribute("tocoda");
  if (tocoda) { const s = new JumpSpec(PlaySpecKind.ToCoda); s.value = tocoda; pd.jumpTo.set(tick, s); }
}

function numericAttribute(element: Element, name: string): number | null {
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function metronomeTempo(direction: Element): { bpm: number; beatUnit: TempoBeatUnit } | null {
  const directionType = elem(direction, "direction-type");
  const metronome = directionType ? elem(directionType, "metronome") : null;
  if (!metronome) return null;
  const perMinute = Number(txt(metronome, "per-minute"));
  if (!Number.isFinite(perMinute) || perMinute <= 0) return null;
  const rawUnit = normText(txt(metronome, "beat-unit"))?.toLowerCase() ?? "quarter";
  const dotted = has(metronome, "beat-unit-dot");
  if (rawUnit === "eighth" && !dotted) {
    return { bpm: perMinute / 2, beatUnit: "eighth" };
  }
  if (rawUnit === "quarter" && dotted) {
    return { bpm: perMinute * 1.5, beatUnit: "dotted-quarter" };
  }
  if (rawUnit === "quarter") return { bpm: perMinute, beatUnit: "quarter" };
  const quarterLength: Record<string, number> = {
    whole: 4,
    half: 2,
    eighth: 0.5,
    "16th": 0.25,
    "32nd": 0.125,
  };
  const length = quarterLength[rawUnit];
  if (!length) return null;
  return { bpm: perMinute * length * (dotted ? 1.5 : 1), beatUnit: "quarter" };
}

function rememberTempo(
  tempos: ImportedTempoEvent[] | null,
  event: ImportedTempoEvent,
): void {
  if (!tempos) return;
  const existing = tempos.findIndex((item) =>
    item.measure === event.measure && item.offset.equals(event.offset));
  if (existing >= 0) tempos[existing] = event;
  else tempos.push(event);
}

function parseDirection(
  direction: Element,
  pd: PlayData,
  mid: number,
  st: MState,
  div: number,
  tempos: ImportedTempoEvent[] | null,
): void {
  const rawOffset = intOf(direction, "offset") ?? 0;
  const offset = st.noteEnd.plus(new Fraction(rawOffset)).divInt(div);
  const sound = elem(direction, "sound");
  if (sound) parseSound(sound, pd, mid, offset);
  const metronome = metronomeTempo(direction);
  const soundBpm = sound ? numericAttribute(sound, "tempo") : null;
  if (soundBpm !== null || metronome) {
    rememberTempo(tempos, {
      measure: mid,
      offset,
      bpm: soundBpm ?? metronome!.bpm,
      beatUnit: metronome?.beatUnit ?? "quarter",
    });
  }
}

function loadMeasure(
  m: Measure,
  measureEl: Element,
  prev: Measure | null,
  div: number,
  tmp: ParserTemp,
  staffFilter: number | null,
  tempos: ImportedTempoEvent[] | null,
  keys: ImportedKeyEvent[] | null,
  inheritedFifths: number,
): void {
  if (/^(?:yes|true|1)$/i.test(measureEl.getAttribute("implicit") ?? "")) {
    m.pickup = true;
    m.displayNumber = null;
  }
  if (prev) {
    m.key.fifths = inheritedFifths;
    m.time.beats = prev.time.beats;
    m.time.beatType = prev.time.beatType;
  }
  const st: MState = { pos: new Fraction(0), noteEnd: new Fraction(0) };
  for (const item of Array.from(measureEl.children)) {
    switch (item.tagName) {
      case "note": onNote(m, item, tmp, div, st, staffFilter); break;
      // MusicXML backup/forward are relative to the current cursor, which is
      // the end of the preceding non-chord note. Using `st.pos` here starts
      // one duration too early and can put an entire lower staff at a negative
      // offset; JPW happened to hide that because its serializer is sequential,
      // while keyboard/number TXT correctly discarded those negative attacks.
      case "backup": st.pos = st.noteEnd.minus(new Fraction(intOf(item, "duration") ?? 0)); st.noteEnd = st.pos; break;
      case "forward": st.pos = st.noteEnd.plus(new Fraction(intOf(item, "duration") ?? 0)); st.noteEnd = st.pos; break;
      case "attributes": parseAttribute(m, item, st.noteEnd.divInt(div), keys); break;
      case "print": parsePrint(m, item); break;
      case "barline": st.pos = st.noteEnd; parseBarline(m, item, st); break;
      case "sound": {
        const offset = st.noteEnd.divInt(div);
        parseSound(item, tmp.playData, m.index, offset);
        const bpm = numericAttribute(item, "tempo");
        if (bpm !== null) rememberTempo(tempos, {
          measure: m.index,
          offset,
          bpm,
          beatUnit: "quarter",
        });
        break;
      }
      case "direction": parseDirection(item, tmp.playData, m.index, st, div, tempos); break;
    }
  }
}

// ---------------- Part ----------------
function loadPart(
  part: Part,
  partEl: Element,
  pd: PlayData,
  staffFilter: number | null = null,
  tempos: ImportedTempoEvent[] | null = null,
  keys: ImportedKeyEvent[] | null = null,
): void {
  const measureEls = elems(partEl, "measure");
  let div = 1;
  let pos = new Fraction(0);
  const tmp = new ParserTemp(pd);
  let cur: Measure | null = null;
  let inheritedFifths = 0;
  measureEls.forEach((mel, mid) => {
    const attr = elem(mel, "attributes");
    const nextDiv = attr ? intOf(attr, "divisions") : null;
    if (nextDiv !== null && nextDiv > 0) div = nextDiv;
    const mea = new Measure(mid);
    mea.position = pos;
    loadMeasure(mea, mel, cur, div, tmp, staffFilter, tempos, keys, inheritedFifths);
    part.measures.push(mea);
    tmp.pairTuplet();
    pos = pos.plus(mea.duration);
    const measureKeys = keys
      ?.filter((event) => event.measure === mid)
      .sort((left, right) => left.offset.compareTo(right.offset));
    inheritedFifths = measureKeys && measureKeys.length > 0
      ? measureKeys[measureKeys.length - 1].fifths
      : mea.key.fifths;
    cur = mea;
  });
  tmp.pairTie();
}

function applyImportedTempos(score: Score, imported: ImportedTempoEvent[]): void {
  const tempos = [...imported].sort((left, right) =>
    left.measure - right.measure || left.offset.compareTo(right.offset));
  if (tempos.length === 0) return;
  const opening = tempos.find((item) => item.measure === 0 && item.offset.equals(0));
  if (opening) {
    score.tempoBpm = opening.bpm;
    score.tempoBeatUnit = opening.beatUnit;
  }
  score.tempoMarks = tempos.flatMap((item) => {
    if (item === opening) return [];
    const mark = new TempoMark();
    mark.measure = item.measure;
    mark.offset = item.offset;
    mark.kind = "tempo";
    mark.bpm = item.bpm;
    mark.beatUnit = item.beatUnit;
    return [mark];
  });
}

function staffCount(partEl: Element): number {
  let count = 1;
  for (const staves of Array.from(partEl.getElementsByTagName("staves"))) {
    count = Math.max(count, parseInt(staves.textContent ?? "1", 10) || 1);
  }
  for (const staff of Array.from(partEl.getElementsByTagName("staff"))) {
    count = Math.max(count, parseInt(staff.textContent ?? "1", 10) || 1);
  }
  return count;
}

function twoPartPiano(root: Element): boolean {
  const parts = elems(root, "part");
  if (parts.length !== 2) return false;
  const partList = elem(root, "part-list") ?? root;
  const partNames = elems(partList, "score-part")
    .map((p) => (txt(p, "part-name") ?? "").trim());
  const names = partNames.join(" ");
  const pairedVoiceNames = partNames.length === 2
    && partNames.every((name) => /V[12]$/i.test(name))
    && partNames.map((name) => name.replace(/V[12]$/i, "")).every(
      (name, _index, bases) => name === bases[0],
    );
  const braceGroup = elems(partList, "part-group").some((group) =>
    txt(group, "group-symbol") === "brace");
  return pairedVoiceNames || braceGroup
    || /(piano|keyboard|right|left|treble|bass|\brh\b|\blh\b|钢琴|右手|左手)/i.test(names);
}

function pianoRoot(root: Element): boolean {
  const parts = elems(root, "part");
  return (parts.length === 1 && staffCount(parts[0]) >= 2) || twoPartPiano(root);
}

interface ImportedPartMetadata {
  name: string;
  voice: number;
}

function importedPartMetadata(root: Element): Map<string, ImportedPartMetadata> {
  const result = new Map<string, ImportedPartMetadata>();
  const partList = elem(root, "part-list");
  if (!partList) return result;
  let braceGroup: string | null = null;
  const voiceByName = new Map<string, number>();
  for (const child of Array.from(partList.children)) {
    if (child.tagName === "part-group") {
      if (child.getAttribute("type") === "start" && txt(child, "group-symbol") === "brace") {
        braceGroup = normText(txt(child, "group-name"));
      } else if (child.getAttribute("type") === "stop") {
        braceGroup = null;
      }
      continue;
    }
    if (child.tagName !== "score-part") continue;
    const id = child.getAttribute("id");
    if (!id) continue;
    const raw = normText(txt(child, "part-name")) ?? `乐器 ${result.size + 1}`;
    const voiceSuffix = /^(.*?)(?:\s*V(\d+)|\s+声部\s*(\d+))$/i.exec(raw);
    const name = braceGroup
      || voiceSuffix?.[1]?.trim()
      || raw;
    const explicitVoice = parseInt(voiceSuffix?.[2] ?? voiceSuffix?.[3] ?? "", 10);
    const nextVoice = (voiceByName.get(name) ?? 0) + 1;
    const voice = Number.isFinite(explicitVoice) && explicitVoice > 0
      ? explicitVoice
      : nextVoice;
    voiceByName.set(name, Math.max(nextVoice, voice));
    result.set(id, { name, voice });
  }
  return result;
}

function importedPianoInstrumentName(root: Element): string {
  const partList = elem(root, "part-list") ?? root;
  const names = elems(partList, "score-part")
    .flatMap((part) => [
      txt(part, "part-name"),
      ...elems(part, "score-instrument").map((instrument) => txt(instrument, "instrument-name")),
    ])
    .map(normText)
    .filter((name): name is string => name !== null && name.length > 0)
    .map((name) => name
      .replace(/\b(?:right|left)\s*(?:hand)?\b/ig, "")
      .replace(/\b[rl]\.?h\.?\b/ig, "")
      .replace(/右手|左手/g, "")
      .replace(/V\d+$/i, "")
      .replace(/^[\s·:：—–-]+|[\s·:：—–-]+$/g, "")
      .trim())
    .filter((name) => name.length > 0);
  const handOnly = /^(?:right|left|treble|bass|r\.?h\.?|l\.?h\.?|右手|左手)$/i;
  const genericPart = /^(?:part|staff|voice|music|声部|谱表)\s*\d*$/i;
  return names.find((name) => !handOnly.test(name) && !genericPart.test(name)) ?? "钢琴";
}

/** True when MusicXML represents a keyboard score that should become paired jianpu. */
export function isPianoMusicXml(xmlText: string): boolean {
  try {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return false;
    return pianoRoot(doc.documentElement);
  } catch {
    return false;
  }
}

// ---------------- refrain detection (score.kt findRefrain/updateRefrain) ----------------
function findRefrain(score: Score): void {
  const countInf = new Map<string, { pos: Fraction; n: number }>();
  for (const m of score.parts[0].measures) {
    for (const ent of m.entries) {
      if (!(ent instanceof Chord)) continue;
      let cnt = 0;
      for (const n of ent.notes) for (const l of n.lyrics) if (l.text.length > 0) cnt++;
      if (cnt === 0) continue;
      const pos = m.position.plus(ent.position);
      const key = pos.toString();
      const prev = countInf.get(key);
      countInf.set(key, { pos, n: (prev?.n ?? 0) + cnt });
    }
  }
  const entries = [...countInf.values()].sort((a, b) => a.pos.compareTo(b.pos));
  let refrainPos: Fraction | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].n === 1) refrainPos = entries[i].pos;
    else if (entries[i].n > 1) break;
  }
  if (refrainPos) updateRefrain(score, refrainPos);
}

function updateRefrain(score: Score, refrainPos: Fraction): void {
  for (const m of score.parts[0].measures) {
    const end = m.position.plus(m.duration);
    if (end.compareTo(refrainPos) <= 0) continue;
    for (const ent of m.entries) {
      if (!(ent instanceof Chord)) continue;
      const pos = m.position.plus(ent.position);
      if (pos.compareTo(refrainPos) < 0) continue;
      for (const n of ent.notes) for (const l of n.lyrics) l.refrain = true;
    }
  }
}

function extractScoreTitle(root: Element): string {
  for (const cr of elems(root, "credit")) {
    if (normText(txt(cr, "credit-type")) !== "title") continue;
    const creditTitle = normText(txt(cr, "credit-words"));
    if (creditTitle) return creditTitle;
  }

  const work = elem(root, "work");
  const workTitle = normText(work ? txt(work, "work-title") : null);
  if (workTitle) return workTitle;

  const movementTitle = normText(txt(root, "movement-title"));
  if (movementTitle) return movementTitle;
  return "";
}

// ---------------- top-level ----------------
export function loadMusicXml(xmlText: string): Score {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0] ?? null;
  if (err) throw new Error("MusicXML 解析失败: " + err.textContent);
  const root = doc.documentElement; // score-partwise
  const score = new Score();
  const importedTempos: ImportedTempoEvent[] = [];
  const importedKeys: ImportedKeyEvent[] = [];

  score.title = extractScoreTitle(root);
  const movementTitle = normText(txt(root, "movement-title"));
  if (movementTitle && movementTitle !== score.title) score.subtitle = movementTitle;

  const ident = elem(root, "identification");
  if (ident) {
    for (const cr of elems(ident, "creator")) {
      score.creator.set(cr.getAttribute("type") ?? "", cr.textContent ?? "");
    }
  }
  score.composer = score.creator.get("composer")?.trim() ?? "";
  score.arranger = score.creator.get("arranger")?.trim() ?? "";
  score.lyricist = (score.creator.get("lyricist") ?? score.creator.get("poet"))?.trim() ?? "";
  for (const cr of elems(root, "credit")) {
    const cred = new Credit();
    const ct = txt(cr, "credit-type");
    if (ct) cred.type = ct;
    // A <credit> may hold several <credit-words> lines (e.g. 词:… / 曲:… / Public
    // Domain). Keep them all, joined by newlines so multipleLineText renders each.
    const cw = elems(cr, "credit-words")
      .map((e) => (e.textContent ?? "").trim())
      .filter((s) => s.length > 0)
      .join("\n");
    if (cw) cred.text = cw;
    cred.page = (parseInt(cr.getAttribute("page") ?? "1", 10) || 1) - 1;
    score.credit.push(cred);
  }
  for (const it of score.credit) {
    if (it.type === null && it.text === score.title) it.type = "title";
    for (const line of it.text.split("\n")) {
      const match = /^(作词|词|作曲|曲|编曲|编)\s*[：:]\s*(.+)$/.exec(line.trim());
      if (!match) continue;
      if ((match[1] === "作词" || match[1] === "词") && !score.lyricist) score.lyricist = match[2].trim();
      if ((match[1] === "作曲" || match[1] === "曲") && !score.composer) score.composer = match[2].trim();
      if ((match[1] === "编曲" || match[1] === "编") && !score.arranger) score.arranger = match[2].trim();
    }
  }

  const partEls = elems(root, "part");
  if (partEls.length === 0) throw new Error("MusicXML 没有 part");
  if (partEls.length === 1 && staffCount(partEls[0]) >= 2) {
    const right = new Part();
    right.hand = "right";
    right.voiceIndex = 1;
    loadPart(right, partEls[0], score.playData, 1, importedTempos, importedKeys);
    const left = new Part();
    left.hand = "left";
    left.voiceIndex = 2;
    // Sound/repeat metadata is score-global; parsing the second staff into a
    // throwaway PlayData avoids duplicating jump entries.
    loadPart(left, partEls[0], new PlayData(), 2);
    score.parts.push(right, left);
    score.piano = true;
  } else if (twoPartPiano(root)) {
    const right = new Part();
    right.hand = "right";
    right.voiceIndex = 1;
    loadPart(right, partEls[0], score.playData, null, importedTempos, importedKeys);
    const left = new Part();
    left.hand = "left";
    left.voiceIndex = 2;
    loadPart(left, partEls[1], new PlayData());
    score.parts.push(right, left);
    score.piano = true;
  } else {
    const metadata = importedPartMetadata(root);
    for (let partIndex = 0; partIndex < partEls.length; partIndex++) {
      const partEl = partEls[partIndex];
      const id = partEl.getAttribute("id") ?? "";
      const info = metadata.get(id) ?? {
        name: `乐器 ${partIndex + 1}`,
        voice: 1,
      };
      const staves = staffCount(partEl);
      for (let staff = 1; staff <= staves; staff++) {
        const part = new Part();
        part.instrumentName = info.name;
        part.voiceIndex = info.voice + staff - 1;
        loadPart(
          part,
          partEl,
          score.parts.length === 0 ? score.playData : new PlayData(),
          staves > 1 ? staff : undefined,
          score.parts.length === 0 ? importedTempos : null,
          score.parts.length === 0 ? importedKeys : null,
        );
        score.parts.push(part);
      }
    }
    score.ensemble = score.parts.length > 1;
  }
  if (score.piano) {
    score.instrumentName = importedPianoInstrumentName(root);
    const count = Math.min(...score.parts.map((p) => p.measures.length));
    for (let i = 0; i < count; i++) {
      const newSystem = score.parts.some((p) => p.measures[i].newSystem);
      const newPage = score.parts.some((p) => p.measures[i].newPage);
      for (const p of score.parts) {
        p.measures[i].newSystem = newSystem;
        p.measures[i].newPage = newPage;
      }
    }
  }
  applyImportedTempos(score, importedTempos);
  score.keyMarks = importedKeys
    .filter((event) => event.measure > 0 || !event.offset.equals(0))
    .sort((left, right) => left.measure - right.measure || left.offset.compareTo(right.offset))
    .map((event) => new KeyMark(event.measure, event.offset, event.fifths));
  for (const part of score.parts) {
    for (const m of part.measures) {
      m.init(score.piano || score.ensemble
        ? { keepChords: true, primaryVoice: true }
        : undefined);
      if (score.piano || score.ensemble) {
        for (const ent of m.entries) {
          if (!(ent instanceof Chord)) continue;
          const lyrics = ent.notes.flatMap((n) => n.lyrics);
          ent.notes.sort((a, b) => b.pitch - a.pitch);
          if (lyrics.length > 0 && ent.notes.length > 0) {
            for (const n of ent.notes) n.lyrics = [];
            ent.notes[0].lyrics = lyrics;
          }
        }
      }
      const localKeys = score.keyMarks
        .filter((mark) => mark.measure === m.index)
        .sort((left, right) => left.offset.compareTo(right.offset));
      if (localKeys.length > 0) {
        let fifths = m.key.fifths;
        let keyCursor = 0;
        let accidental = new AccidentalStat(fifths);
        const chords = m.entries
          .filter((entry): entry is Chord => entry instanceof Chord)
          .sort((left, right) => left.position.compareTo(right.position));
        for (const chord of chords) {
          while (keyCursor < localKeys.length
            && localKeys[keyCursor].offset.compareTo(chord.position) <= 0) {
            fifths = localKeys[keyCursor].fifths;
            accidental = new AccidentalStat(fifths);
            keyCursor++;
          }
          if (chord.rest) continue;
          for (const note of [...chord.graceNotes, ...chord.notes]) {
            if (!note.rest) note.init(fifths, accidental);
          }
        }
      }
    }
  }
  normalizeOpeningPickup(score);
  findRefrain(score);
  score.parseRepeatInf();
  return score;
}
