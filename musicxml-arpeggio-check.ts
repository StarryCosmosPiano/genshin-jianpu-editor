// MusicXML arpeggiate membership/number regression. No browser or generated
// parser fixtures are needed; the DOM shim only exposes Element.children.
import assert from "node:assert/strict";
import { DOMParser as XmlDomParser } from "@xmldom/xmldom";
import { Fraction } from "./src/common/fraction";
import { Chord, CrossPartArpeggio, Lyric, Measure, Note, Part, Score } from "./src/score/score";
import { chordArpeggioPitchGroups, setChordArpeggioPitchGroups } from "./src/score/arpeggio";
import { scoreToMusicXml } from "./src/score/musicxml-export";
import { loadMusicXml } from "./src/score/musicxml";

(globalThis as { DOMParser?: unknown }).DOMParser = XmlDomParser;
const prototype = Object.getPrototypeOf(new XmlDomParser()
  .parseFromString("<root/>", "application/xml").documentElement);
if (!("children" in prototype)) Object.defineProperty(prototype, "children", {
  get(this: { childNodes: ArrayLike<{ nodeType: number }> }) {
    return Array.from(this.childNodes).filter(node => node.nodeType === 1);
  },
});

let checks = 0;
function check(label: string, run: () => void): void {
  run();
  checks++;
  console.log(`PASS ${label}`);
}

function makeScore(parts: number[][]): Score {
  const score = new Score();
  score.piano = parts.length === 2;
  for (const [index, pitches] of parts.entries()) {
    const part = new Part();
    part.hand = score.piano ? index === 0 ? "right" : "left" : null;
    part.voiceIndex = index + 1;
    const measure = new Measure(0);
    measure.keyChange = true;
    measure.timeChange = true;
    part.measures.push(measure);
    score.parts.push(part);
    addChord(measure, pitches, 0, 4);
  }
  return score;
}

function addChord(measure: Measure, pitches: number[], offset: number, duration = 1, voice = 1): Chord {
  const chord = new Chord(measure);
  chord.position = new Fraction(offset);
  chord.duration = new Fraction(duration);
  chord.beats = duration;
  chord.voice = voice;
  for (const pitch of pitches) {
    const note = new Note(chord);
    note.pitch = pitch;
    note.step = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"][pitch % 12];
    note.alter = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0][pitch % 12];
    note.octave = Math.floor(pitch / 12) - 1;
    chord.add(note);
  }
  measure.add(chord);
  return chord;
}

function chordAt(score: Score, part = 0, measure = 0, offset = 0): Chord {
  const chord = score.parts[part].measures[measure].entries
    .find(entry => entry instanceof Chord && entry.position.equals(offset));
  assert.ok(chord instanceof Chord);
  return chord;
}

function localGroups(chord: Chord): number[][] {
  return chordArpeggioPitchGroups(chord).map(group => [...group].sort((a, b) => a - b))
    .sort((a, b) => a.join(",").localeCompare(b.join(",")));
}

function cross(score: Score, pitches: Array<[number, number]>, direction: "up" | "down" = "up"): void {
  const mark = new CrossPartArpeggio();
  mark.pitches = pitches.map(([part, pitch]) => ({ part, pitch }));
  mark.parts = [...new Set(pitches.map(([part]) => part))];
  mark.direction = direction;
  score.crossPartArpeggios.push(mark);
}

function crossGroups(score: Score): string[] {
  return score.crossPartArpeggios.map(mark => `${mark.measure}:${mark.offset}:${mark.direction}:`
    + mark.pitches.map(item => `${item.part}/${item.pitch}`).sort().join(",")).sort();
}

function writtenNotes(score: Score): string[] {
  return score.parts.flatMap((part, partIndex) => part.measures.flatMap(measure => measure.entries.flatMap(entry =>
    entry instanceof Chord && !entry.rest ? entry.notes.filter(note => !note.rest && !note.softDeleted)
      .map(note => `${partIndex}:${measure.index}:${entry.position}:${entry.duration}:${note.pitch}`) : []))).sort();
}

function markers(xml: string): Array<{ part: string; pitch: number; number: number }> {
  const document = new XmlDomParser().parseFromString(xml, "application/xml");
  return Array.from(document.getElementsByTagName("part")).flatMap(part =>
    Array.from(part.getElementsByTagName("note")).flatMap(note => {
      const text = (name: string) => note.getElementsByTagName(name)[0]?.textContent ?? "0";
      const pitch = (Number(text("octave")) + 1) * 12
        + ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[text("step")] ?? 0) + Number(text("alter"));
      return Array.from(note.getElementsByTagName("arpeggiate")).map(mark => ({
        part: part.getAttribute("id") ?? "", pitch, number: Number(mark.getAttribute("number") || "1"),
      }));
    }));
}

const attributes = "<attributes><divisions>1</divisions><key><fifths>0</fifths></key>"
  + "<time><beats>4</beats><beat-type>4</beat-type></time>";
function externalChord(pitches: number[], numbers: Array<number | null | undefined>, staff = 1): string {
  return pitches.map((pitch, index) => {
    const step = ({ 0: "C", 2: "D", 4: "E", 5: "F", 7: "G", 9: "A", 11: "B" } as Record<number, string>)[pitch % 12];
    const number = numbers[index];
    return `<note>${index > 0 ? "<chord/>" : ""}<pitch><step>${step}</step>`
      + `<octave>${Math.floor(pitch / 12) - 1}</octave></pitch><duration>4</duration>`
      + `<voice>1</voice><type>whole</type><staff>${staff}</staff>`
      + (number === undefined ? "" : `<notations><arpeggiate${number === null ? "" : ` number="${number}"`}/></notations>`)
      + "</note>";
  }).join("");
}

function externalScore(parts: string[], names = parts.map((_, index) => `Instrument ${index + 1}`)): string {
  return '<score-partwise version="4.0"><part-list>'
    + parts.map((_, index) => `<score-part id="P${index + 1}"><part-name>${names[index]}</part-name></score-part>`).join("")
    + "</part-list>" + parts.map((content, index) => `<part id="P${index + 1}"><measure number="1">${content}</measure></part>`).join("")
    + "</score-partwise>";
}

check("two local groups export distinct numbers and leave the outside note unmarked", () => {
  const score = makeScore([[48, 50, 52, 53, 55, 57, 60]]);
  setChordArpeggioPitchGroups(chordAt(score), [[50, 52, 53], [55, 57, 60]]);
  const xml = scoreToMusicXml(score);
  const marks = markers(xml);
  assert.deepEqual(marks.map(mark => mark.pitch), [50, 52, 53, 55, 57, 60]);
  assert.equal(new Set(marks.slice(0, 3).map(mark => mark.number)).size, 1);
  assert.equal(new Set(marks.slice(3).map(mark => mark.number)).size, 1);
  assert.notEqual(marks[0].number, marks[3].number);
  const loaded = loadMusicXml(xml);
  assert.deepEqual(writtenNotes(loaded), writtenNotes(score));
  assert.deepEqual(localGroups(chordAt(loaded)), [[50, 52, 53], [55, 57, 60]]);
  assert.deepEqual(localGroups(chordAt(loadMusicXml(scoreToMusicXml(loaded)))), [[50, 52, 53], [55, 57, 60]]);
});

check("legacy complete-chord arpeggio remains one complete group", () => {
  const score = makeScore([[60, 64, 67]]);
  chordAt(score).arpeggio = true;
  const xml = scoreToMusicXml(score);
  assert.equal(markers(xml).length, 3);
  assert.equal(new Set(markers(xml).map(mark => mark.number)).size, 1);
  assert.deepEqual(localGroups(chordAt(loadMusicXml(xml))), [[60, 64, 67]]);
});

check("legacy partial group retains its exact members and outside notes", () => {
  const score = makeScore([[60, 62, 64, 67]]);
  const chord = chordAt(score);
  chord.arpeggio = true;
  chord.arpeggioPitches = [62, 64];
  const loaded = loadMusicXml(scoreToMusicXml(score));
  assert.deepEqual(writtenNotes(loaded), writtenNotes(score));
  assert.deepEqual(localGroups(chordAt(loaded)), [[62, 64]]);
});

check("omitted MusicXML number defaults to one without marking outside notes", () => {
  const xml = externalScore([attributes + "</attributes>" + externalChord([60, 64, 67], [null, null, undefined])]);
  const score = loadMusicXml(xml);
  assert.deepEqual(localGroups(chordAt(score)), [[60, 64]]);
  assert.equal(chordAt(score).notes.length, 3);
});

check("one source part can carry two independent cross-staff numbered groups", () => {
  const xml = externalScore([attributes + "<staves>2</staves></attributes>"
    + externalChord([72, 76, 79], [1, 2, undefined], 1)
    + "<backup><duration>4</duration></backup>"
    + externalChord([48, 52, 55], [1, 2, undefined], 2)]);
  const loaded = loadMusicXml(xml);
  assert.deepEqual(crossGroups(loaded), ["0:0:up:0/72,1/48", "0:0:up:0/76,1/52"]);
  assert.deepEqual(loaded.parts.map((_, index) => localGroups(chordAt(loaded, index))), [[], []]);
  assert.equal(writtenNotes(loaded).length, 6);
  assert.deepEqual(crossGroups(loadMusicXml(scoreToMusicXml(loaded))), crossGroups(loaded));
});

check("different cross-staff numbers preserve separate local waves", () => {
  const xml = externalScore([attributes + "<staves>2</staves></attributes>"
    + externalChord([72, 76], [1, 1], 1) + "<backup><duration>4</duration></backup>"
    + externalChord([48, 52], [2, 2], 2)]);
  const loaded = loadMusicXml(xml);
  assert.deepEqual(crossGroups(loaded), []);
  assert.deepEqual(localGroups(chordAt(loaded)), [[72, 76]]);
  assert.deepEqual(localGroups(chordAt(loaded, 1)), [[48, 52]]);
});

check("chord members written across staves keep each original chord onset", () => {
  const upper = (pitches: number[], numbers: Array<number | undefined>) =>
    externalChord(pitches, numbers, 1).replace("<note>", "<note><chord/>");
  const notes = (externalChord([48], [1], 2) + upper([72, 76], [1, undefined])
    + externalChord([50], [1], 2) + upper([74], [1]))
    .replace(/<duration>4<\/duration>/g, "<duration>1</duration>")
    .replace(/<type>whole<\/type>/g, "<type>quarter</type>");
  const loaded = loadMusicXml(externalScore([attributes + "<staves>2</staves></attributes>" + notes]));
  assert.deepEqual(writtenNotes(loaded), ["0:0:0:1:72", "0:0:0:1:76", "0:0:1:1:74", "1:0:0:1:48", "1:0:1:1:50"]);
  assert.deepEqual(crossGroups(loaded), ["0:0:up:0/72,1/48", "0:1:up:0/74,1/50"]);
});

for (const names of [["Flute", "Cello"], ["Piano Right", "Piano Left"]]) {
  check(`equal numbers in separate external parts never join (${names[0]})`, () => {
    const xml = externalScore([
      attributes + "</attributes>" + externalChord([72, 76], [1, 1]),
      attributes + "</attributes>" + externalChord([48, 52], [1, 1]),
    ], names);
    const loaded = loadMusicXml(xml);
    assert.deepEqual(crossGroups(loaded), []);
    assert.deepEqual(localGroups(chordAt(loaded)), [[72, 76]]);
    assert.deepEqual(localGroups(chordAt(loaded, 1)), [[48, 52]]);
  });
}

function crossFixture(): Score {
  const score = makeScore([[72, 76, 79], [48, 52, 55]]);
  cross(score, [[0, 72], [1, 48]]);
  cross(score, [[0, 76], [1, 52]], "down");
  return score;
}

check("cross-part metadata preserves exact groups, direction and written timing", () => {
  const score = crossFixture();
  const xml = scoreToMusicXml(score);
  assert.match(xml, /<miscellaneous-field name="jpeditor-cross-part-arpeggios">/);
  assert.equal(markers(xml).length, 4);
  assert.equal((xml.match(/direction="down"/g) ?? []).length, 2);
  const loaded = loadMusicXml(xml);
  assert.deepEqual(writtenNotes(loaded), writtenNotes(score));
  assert.deepEqual(crossGroups(loaded), crossGroups(score));
  assert.deepEqual(crossGroups(loadMusicXml(scoreToMusicXml(loaded))), crossGroups(score));
  assert.deepEqual(localGroups(chordAt(loaded)), []);
});

check("stripping the private extension never implies a cross-part join", () => {
  const xml = scoreToMusicXml(crossFixture()).replace(/<miscellaneous>.*?<\/miscellaneous>/s, "");
  const loaded = loadMusicXml(xml);
  assert.deepEqual(crossGroups(loaded), []);
  assert.deepEqual(localGroups(chordAt(loaded)), []);
  assert.equal(writtenNotes(loaded).length, 6);
});

for (const overlap of [false, true]) {
  check(`local and cross-part groups coexist with ${overlap ? "a shared" : "different"} note members`, () => {
    const score = makeScore([[60, 62, 64, 67], [36, 40]]);
    setChordArpeggioPitchGroups(chordAt(score), [[60, 62]]);
    cross(score, [[0, overlap ? 62 : 64], [1, 36]]);
    const loaded = loadMusicXml(scoreToMusicXml(score));
    assert.deepEqual(localGroups(chordAt(loaded)), [[60, 62]]);
    assert.deepEqual(crossGroups(loaded), crossGroups(score));
    assert.deepEqual(writtenNotes(loaded), writtenNotes(score));
  });
}

check("the same number can be reused at later offsets and measures", () => {
  const score = makeScore([[60, 64]]);
  const measure = score.parts[0].measures[0];
  chordAt(score).duration = new Fraction(1);
  chordAt(score).beats = 1;
  chordAt(score).arpeggio = true;
  addChord(measure, [62, 65], 1).arpeggio = true;
  const second = new Measure(1);
  second.position = new Fraction(2);
  score.parts[0].measures.push(second);
  addChord(second, [64, 67], 0).arpeggio = true;
  const xml = scoreToMusicXml(score);
  assert.ok(markers(xml).every(mark => mark.number === 1));
  const loaded = loadMusicXml(xml);
  assert.deepEqual(localGroups(chordAt(loaded)), [[60, 64]]);
  assert.deepEqual(localGroups(chordAt(loaded, 0, 0, 1)), [[62, 65]]);
  assert.deepEqual(localGroups(chordAt(loaded, 0, 1)), [[64, 67]]);
  assert.deepEqual(writtenNotes(loaded), writtenNotes(score));
});

check("ordinary single-part chords still simplify and retained lyrics do not duplicate", () => {
  const score = makeScore([[60, 64, 67]]);
  const chord = chordAt(score);
  chord.duration = new Fraction(1);
  chord.beats = 1;
  setChordArpeggioPitchGroups(chord, [[60, 64]]);
  for (const [index, note] of chord.notes.entries()) {
    const lyric = new Lyric();
    lyric.text = `word${index}`;
    note.lyrics.push(lyric);
  }
  addChord(score.parts[0].measures[0], [50, 53, 57], 1);
  const loaded = loadMusicXml(scoreToMusicXml(score));
  assert.deepEqual(chordAt(loaded).notes.map(note => note.pitch), [67, 64, 60]);
  assert.deepEqual(chordAt(loaded).notes.flatMap(note => note.lyrics.map(lyric => lyric.text)), ["word0", "word1", "word2"]);
  assert.deepEqual(chordAt(loaded, 0, 0, 1).notes.map(note => note.pitch), [57]);
});

check("retaining arpeggio members does not resurrect a discarded secondary voice", () => {
  const score = makeScore([[60, 67]]);
  addChord(score.parts[0].measures[0], [36, 40], 0, 4, 2).arpeggio = true;
  const loaded = loadMusicXml(scoreToMusicXml(score));
  assert.deepEqual(writtenNotes(loaded), ["0:0:0:4:67"]);
  assert.deepEqual(localGroups(chordAt(loaded)), []);
});

for (const invalid of [
  "not json",
  JSON.stringify([{ measure: 0, offset: "1/0", pitches: [] }]),
  JSON.stringify([{ measure: 0, offset: "999999999999999999999999/2", pitches: [] }]),
  JSON.stringify([{ measure: 0, offset: "0", pitches: [{ part: "P1", pitch: 72, number: 1 }, { part: "P2", pitch: 99, number: 1 }] }]),
]) {
  check(`invalid or stale optional metadata is ignored (${invalid.slice(0, 26)})`, () => {
    const escaped = invalid.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const xml = scoreToMusicXml(crossFixture()).replace(/(<miscellaneous-field[^>]*>).*?(<\/miscellaneous-field>)/s, `$1${escaped}$2`);
    const loaded = loadMusicXml(xml);
    assert.deepEqual(crossGroups(loaded), []);
    assert.equal(writtenNotes(loaded).length, 6);
  });
}

check("soft-deleted members are omitted without widening surviving groups", () => {
  const score = makeScore([[48, 50, 52, 53, 55, 57, 60]]);
  setChordArpeggioPitchGroups(chordAt(score), [[50, 52, 53], [55, 57, 60]]);
  chordAt(score).notes.find(note => note.pitch === 52)!.softDeleted = true;
  const xml = scoreToMusicXml(score);
  assert.deepEqual(markers(xml).map(mark => mark.pitch), [50, 53, 55, 57, 60]);
  assert.deepEqual(localGroups(chordAt(loadMusicXml(xml))), [[50, 53], [55, 57, 60]]);
});

check("duplicate pitches belong to distinct numbered note occurrences", () => {
  const score = makeScore([[60, 60, 64, 67]]);
  setChordArpeggioPitchGroups(chordAt(score), [[60, 64], [60, 67]]);
  const xml = scoreToMusicXml(score);
  const unisons = markers(xml).filter(mark => mark.pitch === 60);
  assert.equal(unisons.length, 2);
  assert.notEqual(unisons[0].number, unisons[1].number);
  const loaded = loadMusicXml(xml);
  assert.deepEqual(localGroups(chordAt(loaded)), [[60, 64], [60, 67]]);
  assert.deepEqual(writtenNotes(loaded), writtenNotes(score));
});

check("a lone arpeggiate marker never expands to the whole chord", () => {
  const score = loadMusicXml(externalScore([attributes + "</attributes>" + externalChord([60, 64, 67], [1, undefined, undefined])]));
  assert.equal(chordAt(score).notes.length, 3);
  assert.deepEqual(localGroups(chordAt(score)), []);
});

check("all sixteen standard number-level values are supported", () => {
  const groups = Array.from({ length: 16 }, (_, index) => [30 + index * 2, 31 + index * 2]);
  const score = makeScore([groups.flat()]);
  setChordArpeggioPitchGroups(chordAt(score), groups);
  const xml = scoreToMusicXml(score);
  assert.equal(new Set(markers(xml).map(mark => mark.number)).size, 16);
  assert.deepEqual(localGroups(chordAt(loadMusicXml(xml))), groups);
});

check("more than sixteen simultaneous groups cannot produce invalid XML numbers", () => {
  const groups = Array.from({ length: 17 }, (_, index) => [30 + index * 2, 31 + index * 2]);
  const score = makeScore([groups.flat()]);
  setChordArpeggioPitchGroups(chordAt(score), groups);
  assert.throws(() => scoreToMusicXml(score), /16.*MusicXML/);
});

console.log(`MusicXML arpeggio checks passed: ${checks}/${checks}`);
