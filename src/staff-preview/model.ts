import { Fraction } from "../common/fraction";
import { BarStyle, Chord, MusicCommon, tempoBpmForUnit, type Measure, type Note, type Score, type Tuplet } from "../score/score";
import { clefForPart, spellPitch } from "../score/musicxml-export";
import type { StaffNoteRef, StaffPreviewSnapshot } from "./types";
import { staffNavigationDiagnostics, staffNavigationLabels } from "./renderer-navigation";

export interface StaffPitch {
  /** Unique drawing id; split notes retain the same semantic ref. */
  id: string;
  ref: StaffNoteRef | null;
  sourceNote: Note | null;
  key: string;
  accidental: string | null;
  lyrics: Array<{ verse: number; text: string }>;
}
export interface StaffEvent {
  id: string;
  voice: string;
  position: Fraction;
  actualDuration: Fraction;
  writtenDuration: Fraction;
  /** VexFlow base duration (w, h, q, 8, 16, ...), without rest/dot suffix. */
  duration: string;
  dots: number;
  rest: boolean;
  sourceChord: Chord | null;
  notes: StaffPitch[];
  grace: StaffPitch[];
  tuplet: { id: string; actual: number; normal: number } | null;
  ornaments: string[];
  fermata: boolean;
  arpeggio: boolean;
  stemUp: boolean;
}
export interface StaffMeasureRow {
  partIndex: number;
  source: Measure | null;
  events: StaffEvent[];
}
export interface StaffMeasure {
  index: number;
  rows: StaffMeasureRow[];
  duration: Fraction;
  time: { beats: number; beatType: number };
  fifths: number;
  key: string;
  keyChanges: Array<{ position: Fraction; key: string; fifths: number }>;
  labels: Array<{ position: Fraction; text: string; partIndex: number; symbol?: "segno" | "coda" }>;
  beginBar: "single" | "double" | "repeat";
  endBar: "single" | "double" | "end" | "repeat";
  volta: string | null;
  newSystem: boolean;
  newPage: boolean;
  signature: string;
}
export interface StaffModel {
  revision: number;
  score: Score;
  snapshot: StaffPreviewSnapshot;
  title: string;
  subtitle: string;
  credits: string[];
  staves: Array<{ partIndex: number; clef: "treble" | "bass"; label: string }>;
  measures: StaffMeasure[];
  /** Endpoints are StaffPitch.id, including synthetic split segments. */
  ties: Array<{ from: string; to: string }>;
  /** Endpoints are StaffEvent.id. */
  slurs: Array<{ from: string; to: string }>;
  diagnostics: string[];
}

const ZERO = new Fraction(0);
const KEYS = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
const keyName = (fifths: number): string => KEYS[Math.max(0, Math.min(14, fifths + 7))];
const min = (a: Fraction, b: Fraction): Fraction => a.compareTo(b) < 0 ? a : b;
const spellings = [
  ["1/2", 8], ["w", 4], ["h", 2], ["q", 1], ["8", 0.5], ["16", 0.25],
  ["32", 0.125], ["64", 0.0625], ["128", 0.03125],
].flatMap(([duration, value]) => [0, 1, 2].map(dots => ({
  duration: String(duration), dots,
  length: new Fraction(Number(value) * 128 * (dots === 2 ? 1.75 : dots === 1 ? 1.5 : 1), 128),
}))).sort((a, b) => b.length.compareTo(a.length));

function splitWritten(duration: Fraction): Array<{ duration: string; dots: number; length: Fraction }> {
  const result: Array<{ duration: string; dots: number; length: Fraction }> = [];
  let remaining = duration;
  while (remaining.compareTo(ZERO) > 0) {
    const next = spellings.find(value => value.length.compareTo(remaining) <= 0);
    if (!next || result.length >= 128) throw new Error(`无法精确表示时值 ${duration.toString()} 拍（支持至 128 分音符）`);
    result.push(next);
    remaining = remaining.minus(next.length);
  }
  return result;
}

/** Normalize a read-only model for VexFlow. Source durations and note objects
 * are never changed; split/gap events live exclusively in this projection. */
export function buildStaffModel(snapshot: StaffPreviewSnapshot): StaffModel {
  const { score, registry } = snapshot;
  if (score.ensemble || (score.parts.length !== 1 && !(score.piano && score.parts.length === 2))) {
    throw new Error("五线谱预览目前仅支持单行和钢琴双行乐谱");
  }
  const model: StaffModel = {
    revision: snapshot.revision, score, snapshot,
    title: score.title, subtitle: score.subtitle,
    credits: [score.lyricist && `作词：${score.lyricist}`, score.composer && `作曲：${score.composer}`,
      score.arranger && `编曲：${score.arranger}`].filter((value): value is string => Boolean(value)),
    staves: score.parts.map((part, partIndex) => ({ partIndex,
      clef: score.piano ? partIndex === 0 ? "treble" : "bass" : clefForPart(part).sign === "F" ? "bass" : "treble",
      label: part.instrumentName || (score.piano ? partIndex === 0 ? "右手" : "左手" : score.instrumentName),
    })),
    measures: [], ties: [], slurs: [], diagnostics: [],
  };
  const count = Math.max(0, ...score.parts.map(part => part.measures.length));
  for (let index = 0; index < count; index++) {
    const source = score.parts[0].measures[index] ?? score.parts[1]?.measures[index];
    if (!source) continue;
    let length = source.duration;
    if (length.compareTo(ZERO) <= 0) length = new Fraction(source.time.beats * 4, source.time.beatType);
    for (const part of score.parts) {
      const duration = part.measures[index]?.duration;
      if (duration && duration.compareTo(length) > 0) length = duration;
    }
    const labels: StaffMeasure["labels"] = [];
    if (index === 0 && !score.tempoMarks.some(mark => mark.measure === 0 && mark.offset.equals(ZERO)
      && !mark.softDeleted && mark.kind === "tempo" && mark.bpm !== null)) {
      const unit = score.tempoBeatUnit;
      labels.push({ position: ZERO, text: `${unit === "eighth" ? "♪" : unit === "dotted-quarter" ? "♩." : "♩"} = ${Math.round(tempoBpmForUnit(score.tempoBpm, unit) * 10) / 10}`, partIndex: 0 });
    }
    for (const mark of score.tempoMarks.filter(mark => mark.measure === index && !mark.softDeleted)) {
      labels.push({ position: mark.offset, partIndex: 0,
        text: mark.kind === "tempo" && mark.bpm !== null
          ? `${mark.beatUnit === "eighth" ? "♪" : mark.beatUnit === "dotted-quarter" ? "♩." : "♩"} = ${Math.round(tempoBpmForUnit(mark.bpm, mark.beatUnit) * 10) / 10}`
          : mark.kind === "accel" ? "accel." : "rit.",
      });
    }
    for (const mark of score.textMarks.filter(mark => mark.measure === index && mark.text.trim())) {
      labels.push({ position: mark.offset, text: mark.text, partIndex: mark.partIndex });
    }
    labels.push(...staffNavigationLabels(score, index));
    model.measures.push({
      index, duration: length, time: { beats: source.time.beats, beatType: source.time.beatType },
      fifths: source.key.fifths, key: keyName(source.key.fifths),
      keyChanges: score.keyMarks.filter(mark => mark.measure === index && mark.offset.compareTo(ZERO) > 0)
        .map(mark => ({ position: mark.offset, fifths: mark.fifths, key: keyName(mark.fifths) })),
      labels, rows: score.parts.map((part, partIndex) => ({ partIndex, source: part.measures[index] ?? null, events: [] })),
      beginBar: source.repeatForward ? "repeat" : source.leftBarline === BarStyle.LIGHT_LIGHT ? "double" : "single",
      endBar: source.repeatBackward ? "repeat" : source.barline === BarStyle.LIGHT_HEAVY ? "end"
        : source.barline === BarStyle.LIGHT_LIGHT ? "double" : "single",
      volta: source.endingNum ? [...source.endingNum].join(",") : null,
      newPage: source.newPage, newSystem: source.newSystem, signature: "",
    });
  }
  model.diagnostics.push(...staffNavigationDiagnostics(score, model.measures));
  const tupleIds = new Map<Tuplet, string>();
  const notePieces = new Map<Note, StaffPitch[]>();
  const chordEvents = new Map<Chord, StaffEvent[]>();
  const pitch = (note: Note, fifths: number, id: string, grace: boolean): StaffPitch => {
    const spelled = spellPitch(note, fifths);
    const alteration = spelled.alter === -2 ? "bb" : spelled.alter === -1 ? "b"
      : spelled.alter === 1 ? "#" : spelled.alter === 2 ? "##" : "";
    return {
      id, ref: registry.refFor(note), sourceNote: note,
      key: `${spelled.step.toLowerCase()}${alteration}/${spelled.octave}`,
      accidental: null,
      lyrics: grace ? [] : note.lyrics.filter(lyric => lyric.text).map(lyric => ({ verse: lyric.number, text: lyric.text })),
    };
  };
  score.parts.forEach((part, partIndex) => part.measures.forEach((source, measureIndex) => {
    source.entries.forEach((entry, entryIndex) => {
      if (!(entry instanceof Chord) || !entry.duration || entry.duration.compareTo(ZERO) <= 0) return;
      const liveNotes = entry.notes.filter(note => !note.softDeleted);
      if (liveNotes.length === 0 && !entry.rest) return;
      const tuple = liveNotes.find(note => note.tuplet && !note.tuplet.ornamentProxy)?.tuplet ?? null;
      let tuplet: StaffEvent["tuplet"] = null;
      if (tuple) {
        let id = tupleIds.get(tuple);
        if (!id) { id = `t${tupleIds.size}`; tupleIds.set(tuple, id); }
        tuplet = { id, actual: tuple.ratioNumerator, normal: tuple.ratioDenominator };
      }
      let remaining = entry.duration;
      let index = measureIndex;
      let position = entry.position;
      let segment = 0;
      while (remaining.compareTo(ZERO) > 0) {
        const measure = model.measures[index];
        if (!measure) {
          throw new Error(`第 ${measureIndex + 1} 小节声部 ${partIndex + 1} 的音符超出乐谱结尾`);
        }
        const available = measure.duration.minus(position);
        if (available.compareTo(ZERO) <= 0) { index++; position = ZERO; continue; }
        const actual = min(remaining, available);
        const written = tuplet ? actual.timesInt(tuplet.actual).divInt(tuplet.normal) : actual;
        let fragments: ReturnType<typeof splitWritten>;
        try { fragments = splitWritten(written); }
        catch (error) { throw new Error(`第 ${index + 1} 小节声部 ${partIndex + 1}：${String((error as Error).message)}`); }
        for (const fragment of fragments) {
          const actualDuration = tuplet ? fragment.length.timesInt(tuplet.normal).divInt(tuplet.actual) : fragment.length;
          const id = `p${partIndex}m${measureIndex}e${entryIndex}s${segment++}`;
          const fifths = [...measure.keyChanges].reverse().find(mark => mark.position.compareTo(position) <= 0)?.fifths ?? measure.fifths;
          const notes = liveNotes.filter(note => !note.rest).map((note, n) => pitch(note, fifths, `${id}n${n}`, false));
          for (const item of notes) {
            const pieces = notePieces.get(item.sourceNote!) ?? [];
            if (pieces.length) { model.ties.push({ from: pieces[pieces.length - 1].id, to: item.id }); item.lyrics = []; }
            pieces.push(item);
            notePieces.set(item.sourceNote!, pieces);
          }
          if (entry.rest && liveNotes[0]) notes.push(pitch(liveNotes[0], fifths, `${id}r`, false));
          const first = segment === 1;
          const event: StaffEvent = {
            id, voice: String(entry.voice), position, actualDuration, writtenDuration: fragment.length,
            duration: fragment.duration, dots: fragment.dots, rest: entry.rest || notes.length === 0,
            sourceChord: entry, notes,
            grace: first ? entry.graceNotes.filter(note => !note.softDeleted && !note.rest)
              .map((note, n) => pitch(note, fifths, `${id}g${n}`, true)) : [],
            tuplet, ornaments: first ? entry.ornaments.map(ornament => ornament.kind) : [],
            fermata: first && entry.fermata, arpeggio: first && (entry.arpeggio
              || score.crossPartArpeggios.some(mark => mark.measure === index && mark.parts.includes(partIndex)
                && mark.offset.equals(position))), stemUp: entry.stemUp,
          };
          measure.rows[partIndex].events.push(event);
          const events = chordEvents.get(entry) ?? [];
          events.push(event); chordEvents.set(entry, events);
          position = position.plus(actualDuration);
          remaining = remaining.minus(actualDuration);
        }
        if (remaining.compareTo(ZERO) > 0) { index++; position = ZERO; }
      }
    });
  }));
  for (const [note, pieces] of notePieces) {
    const next = note.tieNext ? notePieces.get(note.tieNext) : null;
    if (next?.length) model.ties.push({ from: pieces[pieces.length - 1].id, to: next[0].id });
  }
  for (const [chord, events] of chordEvents) {
    const target = chord.slurEndChord ? chordEvents.get(chord.slurEndChord) : null;
    if (target?.length) model.slurs.push({ from: events[0].id, to: target[target.length - 1].id });
  }
  const tiedDestinations = new Set(model.ties.map(tie => tie.to));
  const fillGap = (measure: StaffMeasure, part: number, voice: string, start: Fraction, length: Fraction): StaffEvent[] => {
    const events = gapEvents(measure, part, voice, start, length);
    if (!events.length && length.compareTo(ZERO) > 0) model.diagnostics.push(
      `第 ${measure.index + 1} 小节声部 ${part + 1} 在 ${start.toString()} 拍后的 ${length.toString()} 拍空隙保留准确间隔，未补写休止符`);
    return events;
  };
  for (const measure of model.measures) {
    for (const row of measure.rows) {
      // Each lane is a genuinely non-overlapping voice. The adapter may add
      // lanes for imported independent attacks sharing a source voice value.
      row.events.sort((a, b) => a.position.compareTo(b.position));
      const lanes = new Map<string, Fraction[]>();
      for (const event of row.events) {
        const ends = lanes.get(event.voice) ?? [];
        let lane = ends.findIndex(end => end.compareTo(event.position) <= 0);
        if (lane < 0) lane = ends.length;
        ends[lane] = event.position.plus(event.actualDuration);
        lanes.set(event.voice, ends);
        event.voice = `${event.voice}:${lane}`;
      }
      if (!row.events.length) row.events.push(...fillGap(measure, row.partIndex, "0:0", ZERO, measure.duration));
      else {
        for (const voice of new Set(row.events.map(event => event.voice))) {
          const events = row.events.filter(event => event.voice === voice);
          let end = ZERO;
          for (const event of events) {
            if (event.position.compareTo(end) > 0) row.events.push(...fillGap(measure, row.partIndex, voice, end, event.position.minus(end)));
            end = event.position.plus(event.actualDuration);
          }
          if (end.compareTo(measure.duration) < 0) row.events.push(...fillGap(measure, row.partIndex, voice, end, measure.duration.minus(end)));
        }
        row.events.sort((a, b) => a.position.compareTo(b.position));
      }
      // Accidental state belongs to the staff, not to an individual voice.
      const accidentals = new Map<string, number>();
      let fifths = measure.fifths;
      for (const event of row.events) {
        const active = [...measure.keyChanges].reverse().find(mark => mark.position.compareTo(event.position) <= 0)?.fifths ?? measure.fifths;
        if (active !== fifths) { accidentals.clear(); fifths = active; }
        for (const note of [...event.grace, ...event.notes]) {
          if (!note.sourceNote || note.sourceNote.rest) continue;
          const spelling = spellPitch(note.sourceNote, fifths);
          const key = `${spelling.step}/${spelling.octave}`;
          const before = accidentals.get(key) ?? MusicCommon.getAlter(spelling.step, fifths);
          if (before !== spelling.alter && !(note.sourceNote.tiePrev || tiedDestinations.has(note.id))) {
            note.accidental = spelling.alter === -2 ? "bb" : spelling.alter === -1 ? "b"
              : spelling.alter === 1 ? "#" : spelling.alter === 2 ? "##" : "n";
          }
          accidentals.set(key, spelling.alter);
        }
      }
    }
    measure.signature = JSON.stringify({
      time: measure.time, key: measure.key, changes: measure.keyChanges, labels: measure.labels,
      beginBar: measure.beginBar, endBar: measure.endBar, volta: measure.volta,
      rows: measure.rows.map(row => row.events.map(event => ({
        id: event.id, voice: event.voice, position: event.position.toString(), actual: event.actualDuration.toString(),
        duration: event.duration, dots: event.dots, rest: event.rest, tuplet: event.tuplet,
        notes: event.notes.map(note => [note.id, note.key, note.accidental, note.lyrics]),
        grace: event.grace.map(note => [note.id, note.key, note.accidental]),
        ornaments: event.ornaments, fermata: event.fermata, arpeggio: event.arpeggio, stem: event.stemUp,
      }))),
    });
  }
  return model;
}

function gapEvents(measure: StaffMeasure, part: number, voice: string, start: Fraction, length: Fraction): StaffEvent[] {
  // Fractional gaps inside tuplets are represented as exact invisible timing
  // spacers by the renderer, rather than inventing a tuplet in another voice.
  if ((length.denominator & (length.denominator - 1)) !== 0) return [];
  let position = start;
  return splitWritten(length).map((fragment, index) => {
    const event: StaffEvent = {
      id: `gap-p${part}m${measure.index}v${voice}t${start.toString()}s${index}`, voice, position,
      actualDuration: fragment.length, writtenDuration: fragment.length, duration: fragment.duration, dots: fragment.dots,
      rest: true, sourceChord: null, notes: [], grace: [], tuplet: null, ornaments: [], fermata: false, arpeggio: false, stemUp: true,
    };
    position = position.plus(fragment.length);
    return event;
  });
}
