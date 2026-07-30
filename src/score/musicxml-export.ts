import { Fraction } from "../common/fraction";
import {
  BarStyle,
  Chord,
  Measure,
  MusicCommon,
  Note,
  Part,
  Score,
  tempoBpmForUnit,
  type TempoBeatUnit,
} from "./score";
import { scorePartBaseName, scorePartTrackName } from "./part-label";

const DIVISIONS = 1920;
const STEP_PITCH: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function xml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function ticks(value: Fraction): number {
  return Math.max(0, Math.round(value.toFloat() * DIVISIONS));
}

function safeBpm(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.round(value * 10) / 10
    : 90;
}

function beatUnitXml(unit: TempoBeatUnit): string {
  if (unit === "eighth") return "<beat-unit>eighth</beat-unit>";
  if (unit === "dotted-quarter") {
    return "<beat-unit>quarter</beat-unit><beat-unit-dot/>";
  }
  return "<beat-unit>quarter</beat-unit>";
}

interface WrittenRhythm {
  type: string;
  dots: number;
  triplet: boolean;
}

const WRITTEN_TYPES: Array<{ type: string; quarters: number }> = [
  { type: "breve", quarters: 8 },
  { type: "whole", quarters: 4 },
  { type: "half", quarters: 2 },
  { type: "quarter", quarters: 1 },
  { type: "eighth", quarters: 1 / 2 },
  { type: "16th", quarters: 1 / 4 },
  { type: "32nd", quarters: 1 / 8 },
  { type: "64th", quarters: 1 / 16 },
  { type: "128th", quarters: 1 / 32 },
];

function closestWrittenRhythm(quarters: number): {
  rhythm: Omit<WrittenRhythm, "triplet">;
  error: number;
} {
  let best = {
    rhythm: { type: "quarter", dots: 0 },
    error: Number.POSITIVE_INFINITY,
  };
  for (const item of WRITTEN_TYPES) {
    for (let dots = 0; dots <= 2; dots++) {
      const multiplier = dots === 0 ? 1 : dots === 1 ? 1.5 : 1.75;
      const error = Math.abs(quarters - item.quarters * multiplier);
      if (error < best.error) {
        best = { rhythm: { type: item.type, dots }, error };
      }
    }
  }
  return best;
}

function writtenRhythm(chord: Chord): WrittenRhythm {
  const duration = chord.duration?.toFloat() ?? 1;
  const normal = closestWrittenRhythm(duration);
  const triplet = closestWrittenRhythm(duration * 1.5);
  const explicitlyTuplet = chord.notes.some((note) =>
    note.tuplet !== null || note.tupletBegin || note.tupletEnd);
  if (explicitlyTuplet || triplet.error + 1e-8 < normal.error) {
    return { ...triplet.rhythm, triplet: true };
  }
  return { ...normal.rhythm, triplet: false };
}

interface SpelledPitch {
  step: string;
  alter: number;
  octave: number;
}

function storedPitch(note: Note): SpelledPitch | null {
  const stepPitch = STEP_PITCH[note.step];
  if (stepPitch === undefined) return null;
  const expected = (note.octave + 1) * 12 + stepPitch + note.alter;
  return expected === note.pitch
    ? { step: note.step, alter: note.alter, octave: note.octave }
    : null;
}

function preferredStepPitch(note: Note): SpelledPitch | null {
  const stepPitch = STEP_PITCH[note.step];
  if (stepPitch === undefined) return null;
  let best: SpelledPitch | null = null;
  for (let octave = Math.floor(note.pitch / 12) - 2;
    octave <= Math.floor(note.pitch / 12);
    octave++) {
    const alter = note.pitch - ((octave + 1) * 12 + stepPitch);
    if (Math.abs(alter) > 2) continue;
    if (!best || Math.abs(alter) < Math.abs(best.alter)) {
      best = { step: note.step, alter, octave };
    }
  }
  return best;
}

function derivedPitch(note: Note, fifths: number): SpelledPitch {
  let best: (SpelledPitch & { cost: number }) | null = null;
  for (const step of Object.keys(STEP_PITCH)) {
    const stepPitch = STEP_PITCH[step];
    for (let octave = Math.floor(note.pitch / 12) - 2;
      octave <= Math.floor(note.pitch / 12);
      octave++) {
      const alter = note.pitch - ((octave + 1) * 12 + stepPitch);
      if (Math.abs(alter) > 2) continue;
      const expected = MusicCommon.getAlter(step, fifths);
      const cost = Math.abs(alter - expected) * 4 + Math.abs(alter);
      if (!best || cost < best.cost) best = { step, alter, octave, cost };
    }
  }
  return best ?? { step: "C", alter: 0, octave: Math.floor(note.pitch / 12) - 1 };
}

function spellPitch(note: Note, fifths: number): SpelledPitch {
  return storedPitch(note) ?? preferredStepPitch(note) ?? derivedPitch(note, fifths);
}

function lyricXml(note: Note): string {
  return note.lyrics.map((lyric) => {
    const number = lyric.refrain ? "chorus" : String(Math.max(1, lyric.number));
    return `<lyric number="${xml(number)}"><text>${xml(lyric.text)}</text></lyric>`;
  }).join("");
}

function notationXml(
  chord: Chord,
  note: Note,
  noteIndex: number,
  rhythm: WrittenRhythm,
): string {
  const values: string[] = [];
  if (note.tieEnd) values.push('<tied type="stop"/>');
  if (note.tieStart) values.push('<tied type="start"/>');
  if (noteIndex === 0 && chord.slurEnd) values.push('<slur type="stop" number="1"/>');
  if (noteIndex === 0 && chord.slurStart) values.push('<slur type="start" number="1"/>');
  if (note.tupletEnd) values.push('<tuplet type="stop" number="1"/>');
  if (note.tupletBegin) values.push('<tuplet type="start" number="1"/>');
  if (noteIndex === 0 && chord.fermata) values.push("<fermata/>");
  const inArpeggio = chord.arpeggio && (
    chord.arpeggioPitches === null || chord.arpeggioPitches.includes(note.pitch)
  );
  if (inArpeggio) values.push("<arpeggiate/>");
  if (rhythm.triplet && values.length === 0 && (note.tupletBegin || note.tupletEnd)) {
    values.push(note.tupletBegin
      ? '<tuplet type="start" number="1"/>'
      : '<tuplet type="stop" number="1"/>');
  }
  return values.length > 0 ? `<notations>${values.join("")}</notations>` : "";
}

function noteXml(
  chord: Chord,
  note: Note | null,
  noteIndex: number,
  voice: number,
  fifths: number,
): string {
  const rhythm = writtenRhythm(chord);
  const rest = note === null || chord.rest || note.rest;
  const pitch = rest ? "" : (() => {
    const spelled = spellPitch(note, fifths);
    return `<pitch><step>${spelled.step}</step>`
      + `${spelled.alter === 0 ? "" : `<alter>${spelled.alter}</alter>`}`
      + `<octave>${spelled.octave}</octave></pitch>`;
  })();
  const duration = ticks(chord.duration ?? new Fraction(1));
  const ties = rest || !note
    ? ""
    : `${note.tieEnd ? '<tie type="stop"/>' : ""}${note.tieStart ? '<tie type="start"/>' : ""}`;
  const dots = "<dot/>".repeat(rhythm.dots);
  const timeModification = rhythm.triplet
    ? "<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes>"
      + `<normal-type>${rhythm.type}</normal-type></time-modification>`
    : "";
  const accidental = !rest && note
    ? note.jpAlter === "#" ? "<accidental>sharp</accidental>"
      : note.jpAlter === "b" ? "<accidental>flat</accidental>"
        : note.jpAlter === "n" ? "<accidental>natural</accidental>" : ""
    : "";
  return "<note>"
    + `${noteIndex > 0 ? "<chord/>" : ""}`
    + `${rest ? "<rest/>" : pitch}`
    + `<duration>${duration}</duration>`
    + ties
    + `<voice>${voice}</voice>`
    + `<type>${rhythm.type}</type>${dots}${accidental}${timeModification}`
    + `${rest || !note ? "" : notationXml(chord, note, noteIndex, rhythm)}`
    + `${rest || !note ? "" : lyricXml(note)}`
    + "</note>";
}

function graceNoteXml(note: Note, voice: number, fifths: number): string {
  const spelled = spellPitch(note, fifths);
  return '<note><grace slash="yes"/>'
    + `<pitch><step>${spelled.step}</step>`
    + `${spelled.alter === 0 ? "" : `<alter>${spelled.alter}</alter>`}`
    + `<octave>${spelled.octave}</octave></pitch>`
    + `<voice>${voice}</voice><type>16th</type></note>`;
}

function chordXml(chord: Chord, voice: number, fifths: number): string {
  const notes = chord.notes.filter((note) => !note.softDeleted);
  const sounding = notes.filter((note) => !note.rest);
  const grace = chord.graceNotes
    .filter((note) => !note.softDeleted && !note.rest)
    .map((note) => graceNoteXml(note, voice, fifths))
    .join("");
  if (chord.rest || sounding.length === 0) {
    return grace + noteXml(chord, notes[0] ?? null, 0, voice, fifths);
  }
  return grace + sounding
    .map((note, index) => noteXml(chord, note, index, voice, fifths))
    .join("");
}

function clefForPart(part: Part): { sign: "G" | "F"; line: 2 | 4 } {
  if (part.hand === "left") return { sign: "F", line: 4 };
  if (part.hand === "right") return { sign: "G", line: 2 };
  const pitches = part.measures.flatMap((measure) =>
    measure.entries.flatMap((entry) =>
      entry instanceof Chord
        ? entry.notes.filter((note) => !note.rest && !note.softDeleted).map((note) => note.pitch)
        : []));
  pitches.sort((left, right) => left - right);
  const median = pitches.length > 0 ? pitches[Math.floor(pitches.length / 2)] : 60;
  return median < 60 ? { sign: "F", line: 4 } : { sign: "G", line: 2 };
}

function attributesXml(
  measure: Measure,
  first: boolean,
  clef: { sign: "G" | "F"; line: 2 | 4 },
): string {
  if (!first && !measure.keyChange && !measure.timeChange) return "";
  return "<attributes>"
    + `${first ? `<divisions>${DIVISIONS}</divisions>` : ""}`
    + `${first || measure.keyChange
      ? `<key><fifths>${measure.key.fifths}</fifths></key>` : ""}`
    + `${first || measure.timeChange
      ? `<time><beats>${measure.time.beats}</beats>`
        + `<beat-type>${measure.time.beatType}</beat-type></time>` : ""}`
    + `${first ? `<clef><sign>${clef.sign}</sign><line>${clef.line}</line></clef>` : ""}`
    + "</attributes>";
}

function metronomeDirection(
  bpm: number,
  beatUnit: TempoBeatUnit,
  offset: Fraction | null,
): string {
  const displayed = safeBpm(tempoBpmForUnit(bpm, beatUnit));
  return '<direction placement="above"><direction-type><metronome>'
    + `${beatUnitXml(beatUnit)}<per-minute>${displayed}</per-minute>`
    + "</metronome></direction-type>"
    + `${offset && ticks(offset) > 0 ? `<offset>${ticks(offset)}</offset>` : ""}`
    + `<sound tempo="${safeBpm(bpm)}"/></direction>`;
}

function tempoDirections(score: Score, measureIndex: number): string {
  const marks = score.tempoMarks
    .filter((mark) => !mark.softDeleted && mark.measure === measureIndex)
    .sort((left, right) => left.offset.compareTo(right.offset));
  const hasOpeningTempo = marks.some((mark) =>
    mark.kind === "tempo" && mark.offset.equals(0) && mark.bpm !== null);
  let result = measureIndex === 0 && !hasOpeningTempo
    ? metronomeDirection(score.tempoBpm, score.tempoBeatUnit, null)
    : "";
  for (const mark of marks) {
    if (mark.kind === "tempo" && mark.bpm !== null) {
      result += metronomeDirection(mark.bpm, mark.beatUnit, mark.offset);
      continue;
    }
    const word = mark.kind === "accel" ? "accel." : "rit.";
    result += '<direction placement="above"><direction-type>'
      + `<words font-style="italic">${word}</words></direction-type>`
      + `${ticks(mark.offset) > 0 ? `<offset>${ticks(mark.offset)}</offset>` : ""}`
      + "</direction>";
  }
  return result;
}

function barlineXml(measure: Measure, location: "left" | "right"): string {
  const style = location === "left" ? measure.leftBarline : measure.barline;
  const repeat = location === "left" ? measure.repeatForward : measure.repeatBackward;
  const ending = location === "left"
    ? measure.endingLeft && measure.endingNum
      ? `<ending number="${xml([...measure.endingNum].join(","))}" type="start"/>`
      : ""
    : measure.endingRight && measure.endingNum
      ? `<ending number="${xml([...measure.endingNum].join(","))}" type="${measure.endingRight}"/>`
      : "";
  if (!style && !repeat && !ending) return "";
  const fallback = repeat
    ? location === "left" ? BarStyle.HEAVY_LIGHT : BarStyle.LIGHT_HEAVY
    : null;
  return `<barline location="${location}">`
    + `${style ?? fallback ? `<bar-style>${style ?? fallback}</bar-style>` : ""}`
    + ending
    + `${repeat ? `<repeat direction="${location === "left" ? "forward" : "backward"}"/>` : ""}`
    + "</barline>";
}

function measureContents(score: Score, part: Part, measure: Measure, partIndex: number): string {
  const clef = clefForPart(part);
  let result = "";
  // Deliberately leave page and system breaks to the destination application.
  // JPEditor's breaks describe its jianpu page geometry, not conventional-staff
  // engraving. Importing all of them into Dorico can force dozens of systems
  // into one music frame, while MuseScore silently reflows the same file.
  result += attributesXml(measure, measure.index === 0, clef);
  result += barlineXml(measure, "left");
  if (partIndex === 0) result += tempoDirections(score, measure.index);

  const chords = measure.entries
    .filter((entry): entry is Chord => entry instanceof Chord && entry.duration !== undefined);
  const voices = new Map<number, Chord[]>();
  for (const chord of chords) {
    const voice = Math.max(1, chord.voice || 1);
    const items = voices.get(voice) ?? [];
    items.push(chord);
    voices.set(voice, items);
  }
  const orderedVoices = [...voices].sort(([left], [right]) => left - right);
  let previousCursor = 0;
  orderedVoices.forEach(([voice, entries], voiceIndex) => {
    if (voiceIndex > 0 && previousCursor > 0) {
      result += `<backup><duration>${previousCursor}</duration></backup>`;
    }
    let cursor = 0;
    entries.sort((left, right) => left.position.compareTo(right.position));
    for (const chord of entries) {
      const position = ticks(chord.position);
      if (position > cursor) {
        result += `<forward><duration>${position - cursor}</duration></forward>`;
      } else if (position < cursor) {
        result += `<backup><duration>${cursor - position}</duration></backup>`;
      }
      result += chordXml(chord, voice, measure.key.fifths);
      cursor = position + ticks(chord.duration ?? new Fraction(0));
    }
    previousCursor = cursor;
  });
  result += barlineXml(measure, "right");
  return result;
}

interface PartGroup {
  first: number;
  last: number;
  number: number;
  name: string;
}

function partGroups(score: Score): PartGroup[] {
  const result: PartGroup[] = [];
  let first = 0;
  while (first < score.parts.length) {
    const name = scorePartBaseName(score, score.parts[first], first);
    let last = first;
    while (
      last + 1 < score.parts.length
      && scorePartBaseName(score, score.parts[last + 1], last + 1) === name
    ) {
      last++;
    }
    if (last > first) {
      result.push({ first, last, number: result.length + 1, name });
    }
    first = last + 1;
  }
  return result;
}

function partListXml(score: Score): string {
  const groups = partGroups(score);
  const starts = new Map(groups.map((group) => [group.first, group]));
  const stops = new Map(groups.map((group) => [group.last, group]));
  return score.parts.map((part, index) => {
    const label = scorePartTrackName(score, part, index);
    const group = starts.get(index);
    const groupStart = group
      ? `<part-group number="${group.number}" type="start">`
        + `<group-name>${xml(group.name)}</group-name>`
        + "<group-symbol>brace</group-symbol><group-barline>yes</group-barline>"
        + "</part-group>"
      : "";
    const pianoSound = /(?:钢琴|piano|keyboard)/i.test(scorePartBaseName(score, part, index))
      ? "<instrument-sound>keyboard.piano.grand</instrument-sound>"
      : "";
    const scorePart = `<score-part id="P${index + 1}">`
      + `<part-name>${xml(label)}</part-name>`
      + `<score-instrument id="P${index + 1}-I1">`
      + `<instrument-name>${xml(label)}</instrument-name>${pianoSound}`
      + "</score-instrument>"
      + `<midi-instrument id="P${index + 1}-I1">`
      + `<midi-channel>${index % 16 + 1}</midi-channel><midi-program>1</midi-program>`
      + "</midi-instrument></score-part>";
    const stopped = stops.get(index);
    const groupStop = stopped
      ? `<part-group number="${stopped.number}" type="stop"/>`
      : "";
    return groupStart + scorePart + groupStop;
  }).join("");
}

function identificationXml(score: Score): string {
  const creators = new Map(score.creator);
  if (score.composer) creators.set("composer", score.composer);
  if (score.arranger) creators.set("arranger", score.arranger);
  if (score.lyricist) creators.set("lyricist", score.lyricist);
  if (creators.size === 0) return "";
  return "<identification>"
    + [...creators]
      .filter(([, value]) => value.trim().length > 0)
      .map(([type, value]) => `<creator type="${xml(type)}">${xml(value)}</creator>`)
      .join("")
    + "<encoding><software>JPEditor</software></encoding>"
    + "</identification>";
}

function creditsXml(score: Score): string {
  return score.credit
    .filter((credit) => credit.text.trim().length > 0)
    .map((credit) => `<credit page="${credit.page + 1}">`
      + `${credit.type ? `<credit-type>${xml(credit.type)}</credit-type>` : ""}`
      + credit.text.split("\n")
        .map((line) => `<credit-words>${xml(line)}</credit-words>`)
        .join("")
      + "</credit>")
    .join("");
}

/** Serialize the editable jianpu Score as standards-based MusicXML partwise. */
export function scoreToMusicXml(score: Score): string {
  if (score.parts.length === 0) throw new Error("当前乐谱没有可导出的声部");
  const partList = partListXml(score);
  const parts = score.parts.map((part, partIndex) => {
    const measures = part.measures.map((measure, measureIndex) => {
      const number = measure.pickup || measure.displayNumber === null
        ? "0"
        : String(measure.displayNumber ?? measureIndex + 1);
      const implicit = measure.pickup || measure.displayNumber === null ? ' implicit="yes"' : "";
      return `<measure number="${xml(number)}"${implicit}>`
        + measureContents(score, part, measure, partIndex)
        + "</measure>";
    }).join("");
    return `<part id="P${partIndex + 1}">${measures}</part>`;
  }).join("");
  return '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
    + '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" '
    + '"https://www.musicxml.org/dtds/partwise.dtd">\n'
    + '<score-partwise version="4.0">'
    + `${score.title ? `<work><work-title>${xml(score.title)}</work-title></work>` : ""}`
    + `${score.subtitle ? `<movement-title>${xml(score.subtitle)}</movement-title>` : ""}`
    + identificationXml(score)
    + creditsXml(score)
    + `<part-list>${partList}</part-list>${parts}</score-partwise>`;
}
