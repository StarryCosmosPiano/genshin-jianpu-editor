// Headless structural regression for the paired-jianpu path.  Unlike shot.mjs
// this does not require an installed browser; its tiny DOM shim supplies only
// the SVG/canvas measurement calls used by Layout.
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMParser as XmlDomParser } from "@xmldom/xmldom";
import { Fraction } from "./src/common/fraction";

class FakeElement {
  constructor(public tagName = "div") {}
  isConnected = true;
  id = "";
  style: Record<string, string> = {};
  textContent = "";
  children: FakeElement[] = [];
  attrs = new Map<string, string>();
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  appendChild<T extends FakeElement>(child: T): T { this.children.push(child); return child; }
  getComputedTextLength(): number { return [...this.textContent].length * 14; }
  getBBox(): { x: number; y: number; width: number; height: number } {
    if (this.attrs.has("d")) {
      const nums = (this.attrs.get("d")!.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      const xs = nums.filter((_n, i) => i % 2 === 0);
      const ys = nums.filter((_n, i) => i % 2 === 1);
      const minX = Math.min(0, ...xs), maxX = Math.max(0, ...xs);
      const minY = Math.min(0, ...ys), maxY = Math.max(0, ...ys);
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    return { x: 0, y: -22, width: this.getComputedTextLength(), height: 28 };
  }
  getContext(): { font: string; measureText: (text: string) => Record<string, number> } {
    return {
      font: "",
      measureText: (text: string) => ({
        width: [...text].length * 14,
        actualBoundingBoxAscent: 22,
        actualBoundingBoxDescent: 6,
        fontBoundingBoxAscent: 22,
        fontBoundingBoxDescent: 6,
      }),
    };
  }
  get outerHTML(): string {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const attrs = [...this.attrs].map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
    const children = this.children.map((c) => c.outerHTML).join("");
    return `<${this.tagName}${attrs}>${esc(this.textContent)}${children}</${this.tagName}>`;
  }
}

const body = new FakeElement("body");
const fakeDocument = {
  body,
  getElementById: (_id: string) => null,
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
};
(globalThis as { document?: unknown }).document = fakeDocument;
(globalThis as { DOMParser?: unknown }).DOMParser = XmlDomParser;
const probe = new XmlDomParser().parseFromString("<root><child/></root>", "application/xml");
const elementProto = Object.getPrototypeOf(probe.documentElement) as Record<string, unknown>;
if (!("children" in elementProto)) {
  Object.defineProperty(elementProto, "children", {
    get(this: { childNodes: ArrayLike<{ nodeType: number }> }) {
      return Array.from(this.childNodes).filter((n) => n.nodeType === 1);
    },
  });
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const [{ JpwFile }, { fromJpw }, { scoreToJpwabc }, { buildTimeline }, { scoreToMidi }, layoutMod, scoreMod, painterMod, musicXmlMod, smuflMod, slashMod, selectionMod] =
  await Promise.all([
    import("./src/jpword/jpwfile"),
    import("./src/score/jpwimport"),
    import("./src/score/jpscore"),
    import("./src/score/timeline"),
    import("./src/score/midi"),
    import("./src/layout/layout"),
    import("./src/score/score"),
    import("./src/layout/painter"),
    import("./src/score/musicxml"),
    import("./src/smufl/smufl"),
    import("./src/slashscore"),
    import("./src/editor/note-selection"),
  ]);

const smuflMeta = smuflMod.MetaData.fromJson(JSON.parse(await readFile("public/redist/bravura_metadata.json", "utf-8")));

const text = await readFile("examples/piano-demo.jpwabc", "utf-8");
const file = JpwFile.fromString(text);
check(file, "piano example did not parse");
check(file.getVoice("right")?.hand === "right", "missing RH section");
check(file.getVoice("left")?.hand === "left", "missing LH section");

const legacyFile = JpwFile.fromString(".Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 |]\n");
check(legacyFile, "legacy single-voice example did not parse");
const legacyScore = fromJpw(legacyFile);
check(legacyScore && !legacyScore.piano && legacyScore.parts.length === 1, "legacy .Voice compatibility broke");

const tieFile = JpwFile.fromString(`.Title
KeyAndMeters = {1=C,4/4}
.Voice
(1 1) 2 3 |]
`);
check(tieFile, "same-pitch tie fixture did not parse");
const tieScore = fromJpw(tieFile);
check(tieScore, "same-pitch tie fixture did not import");
const tieChords = tieScore.parts[0].measures[0].entries.filter((entry) => entry instanceof scoreMod.Chord);
check(tieChords.length === 4, "tie fixture lost a chord");
check(tieChords[0].notes[0].tieStart && tieChords[1].notes[0].tieEnd &&
  tieChords[0].notes[0].tieNext === tieChords[1].notes[0] &&
  tieChords[1].notes[0].tiePrev === tieChords[0].notes[0],
"same-pitch parentheses were not restored as a semantic tie");
const tieTimeline = buildTimeline(tieScore);
check(tieTimeline.notes.length === 3 && tieTimeline.notes[0].t0 === 0 && tieTimeline.notes[0].t1 === 2,
  "tied continuation retriggered instead of extending the first sounding note");

const tieChainFile = JpwFile.fromString(`.Title
KeyAndMeters = {1=C,4/4}
.Voice
([15] [15] [15]) 2 |]
`);
check(tieChainFile, "three-chord tie-chain fixture did not parse");
const tieChainScore = fromJpw(tieChainFile);
check(tieChainScore, "three-chord tie-chain fixture did not import");
const tieChainChords = tieChainScore.parts[0].measures[0].entries
  .filter((entry): entry is InstanceType<typeof scoreMod.Chord> => entry instanceof scoreMod.Chord);
check(tieChainChords.length === 4, "three-chord tie-chain fixture lost a chord");
check(tieChainChords[0].notes.every((note) => note.tieStart && !note.tieEnd) &&
  tieChainChords[1].notes.every((note) =>
    note.tieStart && note.tieEnd && note.tiePrev?.chord === tieChainChords[0] &&
    note.tieNext?.chord === tieChainChords[2]) &&
  tieChainChords[2].notes.every((note) => note.tieEnd && !note.tieStart),
"same-pitch slur across three chords was not converted to adjacent tie segments");
const tieChainTimeline = buildTimeline(tieChainScore);
const sustainedChainNotes = tieChainTimeline.notes.filter((note) => note.t0 === 0);
check(sustainedChainNotes.length === 2 && sustainedChainNotes.every((note) => note.t1 === 3),
  "middle or final tie-chain continuation retriggered during playback");
const serializedTieChain = scoreToJpwabc(tieChainScore);
const reparsedTieChainFile = JpwFile.fromString(serializedTieChain);
check(reparsedTieChainFile, "serialized tie chain did not parse");
const reparsedTieChain = fromJpw(reparsedTieChainFile);
check(reparsedTieChain?.parts[0].measures[0].entries
  .filter((entry): entry is InstanceType<typeof scoreMod.Chord> => entry instanceof scoreMod.Chord)[1]
  ?.notes.every((note) => note.tieStart && note.tieEnd),
"tie-chain middle continuation was lost after jpwabc round-trip");

const selectionText = `.Title
KeyAndMeters = {1=C,4/4}
.Voice
1' [1,3'5] b4 0 |]
`;
const selectionFile = JpwFile.fromString(selectionText);
check(selectionFile, "note-selection fixture did not parse");
const selectionScore = fromJpw(selectionFile);
check(selectionScore, "note-selection fixture did not import");
const sourceNotes = selectionMod.buildJpwSourceNotes(selectionText, selectionScore);
check(sourceNotes.map((source) => selectionText.substring(source.from, source.to)).join(" ") === "1' 1, 3' 5 b4 0",
  "score notes were not mapped to their exact source pitches, including chord tones");
check(selectionMod.editJpwPitch("#5''", { kind: "number", number: "3" }) === "#3''",
  "number-key editing lost accidental or octave markers");
check(selectionMod.editJpwPitch("6,", { kind: "octave", delta: 1 }) === "6"
  && selectionMod.editJpwPitch("6", { kind: "octave", delta: 1 }) === "6'"
  && selectionMod.editJpwPitch("2", { kind: "octave", delta: -1 }) === "2,",
"arrow-key octave editing did not cross lower/normal/upper octaves correctly");
const graceSelectionText = `.Title
KeyAndMeters = {1=C,4/4}
.Voice
{#2'}3 4 5 6 |]
`;
const graceSelectionFile = JpwFile.fromString(graceSelectionText);
check(graceSelectionFile, "grace-note selection fixture did not parse");
const graceSelectionScore = fromJpw(graceSelectionFile);
check(graceSelectionScore, "grace-note selection fixture did not import");
const graceSelectionSources = selectionMod.buildJpwSourceNotes(
  graceSelectionText,
  graceSelectionScore,
);
check(graceSelectionSources.length === 5
  && graceSelectionSources[0].grace
  && graceSelectionText.slice(
    graceSelectionSources[0].from,
    graceSelectionSources[0].to,
  ) === "#2'"
  && !graceSelectionSources[1].grace,
"JPW grace and main pitches were not mapped to separate editable source ranges");

const score = fromJpw(file);
check(score?.piano, "score did not enter piano mode");
check(score.parts.length === 2, "piano score must have two parts");
check(score.parts[0].hand === "right" && score.parts[1].hand === "left", "hand order is wrong");
check(score.instrumentName === "钢琴", "piano score did not receive the default instrument name");
const rhChord = score.parts[0].measures[1].entries.find((e) => e instanceof scoreMod.Chord);
check(rhChord && rhChord.notes.length === 3, "stacked RH chord was not preserved");

const roundTrip = scoreToJpwabc(score);
check(roundTrip.includes(".Voice.RH") && roundTrip.includes(".Voice.LH"), "round-trip lost hand sections");
check(roundTrip.includes("Instrument = {钢琴}"), "round-trip lost the instrument name");
check(roundTrip.includes("[5'3'1']") || roundTrip.includes("[1'3'5']"), "round-trip lost chord pitches");

const xmlText = await readFile("examples/piano-demo.musicxml", "utf-8");
check(musicXmlMod.isPianoMusicXml(xmlText), "two-staff MusicXML was not detected as piano");
const xmlScore = musicXmlMod.loadMusicXml(xmlText);
check(xmlScore.piano && xmlScore.parts.length === 2, "MusicXML did not split into RH/LH");
check(xmlScore.parts[0].hand === "right" && xmlScore.parts[1].hand === "left", "MusicXML hand labels are wrong");
check(xmlScore.instrumentName === "Piano", "MusicXML part name was not imported as the instrument name");
const chineseXmlScore = musicXmlMod.loadMusicXml(xmlText.replace("<part-name>Piano</part-name>", "<part-name>中文钢琴右手</part-name>"));
check(chineseXmlScore.instrumentName === "中文钢琴", "Chinese MusicXML instrument name was not preserved");
const importedChord = xmlScore.parts[0].measures[1].entries.find((e) => e instanceof scoreMod.Chord);
check(importedChord && importedChord.notes.length === 3, "MusicXML chord tones were collapsed");
const importedText = scoreToJpwabc(xmlScore);
check(importedText.includes(".Voice.RH") && importedText.includes(".Voice.LH"), "MusicXML serialization lost piano sections");
const importedFile = JpwFile.fromString(importedText);
check(importedFile, "serialized piano MusicXML did not parse as jpwabc");
const importedRoundTrip = fromJpw(importedFile);
check(importedRoundTrip?.piano && importedRoundTrip.parts.length === 2, "MusicXML -> jpwabc round-trip lost piano mode");

const timeline = buildTimeline(score);
check(timeline.notes.some((n) => n.part === 0) && timeline.notes.some((n) => n.part === 1), "timeline lost a hand");
check(timeline.anchors.some((a) => a.chords.length >= 2), "playback cursor is not grouping both hands");
const midi = scoreToMidi(score);
check(((midi[10] << 8) | midi[11]) === 3, "MIDI should contain tempo + RH + LH tracks");

const layout = new layoutMod.Layout(28);
layout.options.smuflMeta = smuflMeta;
layout.fromScore(score, null, 960, 540);
check(layout.pages.length > 0, "piano layout produced no pages");

const ornamentFile = JpwFile.fromString(await readFile("examples/ornaments-tempo-demo.jpwabc", "utf-8"));
check(ornamentFile, "ornament and tempo example did not parse");
const ornamentScore = fromJpw(ornamentFile);
check(ornamentScore?.piano, "ornament and tempo example lost piano mode");
check(ornamentScore.tempoMarks.map((mark) => mark.kind).join(",") === "accel,tempo,rit,tempo",
  "tempo annotations were not restored from jpwabc");
const ornamentLayout = new layoutMod.Layout(28);
ornamentLayout.options.smuflMeta = smuflMeta;
ornamentLayout.fromScore(ornamentScore, null, 960, 540);
const ornamentClassCounts = new Map<string, number>();
const ornamentGraceEntries: InstanceType<typeof layoutMod.NoteEntry>[] = [];
const ornamentGraceLinks: InstanceType<typeof layoutMod.GraphicPath>[] = [];
const ornamentGraceBeams: InstanceType<typeof layoutMod.GraphicLine>[] = [];
const walkOrnaments = (item: InstanceType<typeof layoutMod.PageItem>): void => {
  for (const className of item.classes) {
    ornamentClassCounts.set(className, (ornamentClassCounts.get(className) ?? 0) + 1);
  }
  if (item.data instanceof layoutMod.NoteEntry && item.data.chord.graceNotes.length > 0) {
    ornamentGraceEntries.push(item.data);
  }
  if (item instanceof layoutMod.GraphicPath && item.classes.has("jianpu-grace-link")) {
    ornamentGraceLinks.push(item);
  }
  if (item instanceof layoutMod.GraphicLine && item.classes.has("jianpu-grace-beam")) {
    ornamentGraceBeams.push(item);
  }
  for (const child of item.children) walkOrnaments(child as InstanceType<typeof layoutMod.PageItem>);
};
for (const page of ornamentLayout.pages) walkOrnaments(page);
check((ornamentClassCounts.get("jianpu-arpeggio") ?? 0) === 1,
  "arpeggio did not render as one adaptive-height wavy mark");
check((ornamentClassCounts.get("jianpu-grace-number") ?? 0) === 1 &&
  (ornamentClassCounts.get("jianpu-grace-beam") ?? 0) === 2,
  "grace note did not render with one small number and exactly two beams");
check((ornamentClassCounts.get("jianpu-grace-link") ?? 0) === 1,
  "grace note did not render its independent curved link to the main note");
const ornamentGraceEntry = ornamentGraceEntries[0];
const ornamentGraceNote = ornamentGraceEntry?.chord.graceNotes[0];
const ornamentGraceItem = ornamentGraceNote
  ? ornamentGraceEntry.graceItems.get(ornamentGraceNote)
  : null;
const ornamentGraceNumber = ornamentGraceItem?.children.find(
  (item): item is InstanceType<typeof layoutMod.JpNumber> =>
    item instanceof layoutMod.JpNumber,
);
check(ornamentGraceEntry?.number && ornamentGraceItem && ornamentGraceNumber,
  "grace note lost its dedicated selectable visual group");
const graceDigitPosition = ornamentGraceNumber.pos(ornamentGraceEntry.group);
const mainDigitPosition = ornamentGraceEntry.number.pos(ornamentGraceEntry.group);
check(graceDigitPosition.x + ornamentGraceNumber.width < mainDigitPosition.x
  && graceDigitPosition.y < mainDigitPosition.y,
"grace digit is not placed at the upper-left of its main digit");
check(
  Math.abs(
    graceDigitPosition.y + ornamentGraceNumber.bound.bottom -
    (mainDigitPosition.y + ornamentGraceEntry.number.bound.top),
  ) < 1e-6,
  "grace digit bottom no longer aligns with the main digit top",
);
const graceLink = ornamentGraceLinks[0];
const graceLinkPosition = graceLink.pos(ornamentGraceEntry.group);
const lowerGraceBeam = [...ornamentGraceBeams].sort(
  (left, right) => left.pos(ornamentGraceEntry.group).y - right.pos(ornamentGraceEntry.group).y,
).at(-1);
check(lowerGraceBeam, "grace-note curve has no lower beam to start beneath");
const lowerGraceBeamPosition = lowerGraceBeam.pos(ornamentGraceEntry.group);
const linkStart = graceLink.segs.find((segment) => segment.op === "M");
const linkCurves = graceLink.segs.filter((segment) => segment.op === "C");
const linkEnd = [...graceLink.segs].reverse().find((segment) => segment.op === "C");
check(linkStart && linkEnd, "grace-note curve lost its cubic geometry");
check(
  linkCurves.length === 2 &&
  linkCurves[0].pts[1] > linkStart.pts[1] &&
  linkCurves[0].pts[5] > linkStart.pts[1] &&
  linkCurves[1].pts[4] > linkCurves[0].pts[4] &&
  Math.abs(linkCurves[0].pts[0] - linkStart.pts[0]) > 1e-3 &&
  Math.abs(linkCurves[1].pts[1] - linkCurves[1].pts[5]) > 1e-3,
  "grace-note link is no longer a bowed down-then-right gesture",
);
const linkStartX = graceLinkPosition.x + linkStart.pts[0];
const linkStartY = graceLinkPosition.y + linkStart.pts[1];
const linkEndX = graceLinkPosition.x + linkEnd.pts[4];
const linkEndY = graceLinkPosition.y + linkEnd.pts[5];
check(
  linkStartX > lowerGraceBeamPosition.x
  && linkStartX < lowerGraceBeamPosition.x + lowerGraceBeam.width
  && linkStartY > lowerGraceBeamPosition.y + lowerGraceBeam.height
  && graceDigitPosition.y + ornamentGraceNumber.height * 0.65 < linkStartY,
  "grace-note curve does not start below the double beam with the grace digit above it",
);
check(
  linkEndX < mainDigitPosition.x + ornamentGraceEntry.number.bound.left,
  "grace-note curve touches the main digit instead of stopping just before it",
);
check(
  Math.abs(
    linkEndY -
    (mainDigitPosition.y +
      (ornamentGraceEntry.number.bound.top + ornamentGraceEntry.number.bound.bottom) / 2),
  ) < 1e-6,
  "grace-note curve no longer aims at the vertical middle of the main digit",
);
check((ornamentClassCounts.get("tempo-accel") ?? 0) === 1 &&
  (ornamentClassCounts.get("tempo-rit") ?? 0) === 1 &&
  (ornamentClassCounts.get("tempo-tempo") ?? 0) === 2,
  "piano tempo ramp annotations were missing or duplicated");

const nearbySourceTempo = ornamentScore.tempoMarks.find((mark) => mark.kind === "tempo");
check(nearbySourceTempo, "tempo collision fixture has no concrete tempo mark");
const nearbyTempo = new scoreMod.TempoMark();
nearbyTempo.measure = nearbySourceTempo.measure;
nearbyTempo.offset = nearbySourceTempo.offset.plus(new Fraction(1, 192));
nearbyTempo.kind = "tempo";
nearbyTempo.bpm = (nearbySourceTempo.bpm ?? 90) + 2;
ornamentScore.tempoMarks.push(nearbyTempo);
const collisionLayout = new layoutMod.Layout(28);
collisionLayout.options.smuflMeta = smuflMeta;
collisionLayout.fromScore(ornamentScore, null, 960, 540);
for (const page of collisionLayout.pages) {
  const visuals: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  const collectTempoVisuals = (item: InstanceType<typeof layoutMod.PageItem>): void => {
    if (item.classes.has("tempo-annotation")) {
      const position = item.pos(page);
      visuals.push({
        left: position.x,
        right: position.x + item.width,
        top: position.y,
        bottom: position.y + item.height,
      });
    }
    for (const child of item.children) {
      collectTempoVisuals(child as InstanceType<typeof layoutMod.PageItem>);
    }
  };
  collectTempoVisuals(page);
  for (let left = 0; left < visuals.length; left++) {
    for (let right = left + 1; right < visuals.length; right++) {
      const a = visuals[left], b = visuals[right];
      check(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
        "nearby tempo annotations still overlap after layout collision avoidance");
    }
  }
}

const dottedMeasure = new scoreMod.Measure(0);
const dottedChord = new scoreMod.Chord(dottedMeasure);
dottedChord.beats = 1;
dottedChord.dot = 1;
for (const number of ["5", "3", "1"]) {
  const note = new scoreMod.Note(dottedChord);
  note.number = number;
  dottedChord.add(note);
}
const dottedEntries: InstanceType<typeof layoutMod.Entry>[] = [];
layoutMod.NoteEntry.fromChord(dottedEntries, dottedChord, 0, layout.options);
const dottedEntry = dottedEntries[0];
check(dottedEntry instanceof layoutMod.NoteEntry && dottedEntry.numbers.length === 3,
  "dotted chord did not render all chord tones");
check(dottedEntry.numbers.every((number) => number.text.endsWith("·")),
  "augmentation dot was not rendered after every chord tone");

const tieColorOptions = new layoutMod.LayoutOptions(28);
tieColorOptions.smuflMeta = smuflMeta;
tieColorOptions.applyEngravingStyle({ tieContinuationGray: true });
const grayTieEntries: InstanceType<typeof layoutMod.Entry>[] = [];
layoutMod.NoteEntry.fromChord(grayTieEntries, tieChords[1], 0, tieColorOptions);
const grayTieEntry = grayTieEntries[0];
check(grayTieEntry instanceof layoutMod.NoteEntry && grayTieEntry.number,
  "tie destination did not create a numbered entry");
const grayChannel = (grayTieEntry.number.color >>> 16) & 0xff;
check(((grayTieEntry.number.color >>> 24) & 0xff) === 0xff && grayChannel > 0 && grayChannel < 0xff,
  "enabled tie continuation style did not render the destination as opaque gray");
tieColorOptions.applyEngravingStyle({ tieContinuationGray: false });
const blackTieEntries: InstanceType<typeof layoutMod.Entry>[] = [];
layoutMod.NoteEntry.fromChord(blackTieEntries, tieChords[1], 0, tieColorOptions);
const blackTieEntry = blackTieEntries[0];
check(blackTieEntry instanceof layoutMod.NoteEntry && blackTieEntry.number?.color === tieColorOptions.color,
  "disabling tie continuation gray did not restore the normal score color");
tieColorOptions.applyEngravingStyle({ tieContinuationGray: true });
for (const chord of tieChainChords.slice(1, 3)) {
  const continuationEntries: InstanceType<typeof layoutMod.Entry>[] = [];
  layoutMod.NoteEntry.fromChord(continuationEntries, chord, 0, tieColorOptions);
  const continuationEntry = continuationEntries[0];
  check(continuationEntry instanceof layoutMod.NoteEntry &&
    continuationEntry.numbers.every((number) => {
      const channel = (number.color >>> 16) & 0xff;
      return channel > 0 && channel < 0xff;
    }),
  "every destination in a multi-segment tie must use the gray continuation style");
}

const accidentalGap = (scale: number): number => {
  const options = new layoutMod.LayoutOptions(28);
  options.smuflMeta = smuflMeta;
  options.applyEngravingStyle({ accidentalGapScale: scale });
  const measure = new scoreMod.Measure(0);
  const chord = new scoreMod.Chord(measure);
  chord.beats = 1;
  const note = new scoreMod.Note(chord);
  note.number = "4";
  note.jpAlter = "#";
  chord.add(note);
  const entries: InstanceType<typeof layoutMod.Entry>[] = [];
  layoutMod.NoteEntry.fromChord(entries, chord, 0, options);
  const entry = entries[0];
  check(entry instanceof layoutMod.NoteEntry && entry.number && entry.accidental,
    "accidental spacing fixture did not render its sharp");
  return entry.number.x + entry.number.bound.left - (entry.accidental.x + entry.accidental.bound.right);
};
const narrowAccidentalGap = accidentalGap(0.3);
const wideAccidentalGap = accidentalGap(3);
check(wideAccidentalGap > narrowAccidentalGap + 1,
  "accidental-to-number spacing control did not affect production layout geometry");

let pianoSystems = 0, stackedEntries = 0, braceGlyphs = 0, instrumentLabels = 0, obsoleteHandLabels = 0;
const renderedNotes: InstanceType<typeof layoutMod.NoteEntry>[] = [];
const renderedSystems: InstanceType<typeof layoutMod.Group>[] = [];
const renderedText: InstanceType<typeof layoutMod.TextFrame>[] = [];
const walk = (item: InstanceType<typeof layoutMod.PageItem>): void => {
  if (item.classes.has("piano-system")) {
    pianoSystems++;
    renderedSystems.push(item as InstanceType<typeof layoutMod.Group>);
  }
  if (item instanceof layoutMod.TextFrame && item.text === String.fromCharCode(0xe000)) braceGlyphs++;
  if (item instanceof layoutMod.TextFrame) renderedText.push(item);
  if (item instanceof layoutMod.TextFrame && item.text === "钢琴") instrumentLabels++;
  if (item instanceof layoutMod.TextFrame && (item.text === "右手" || item.text === "左手")) obsoleteHandLabels++;
  if (item.data instanceof layoutMod.NoteEntry) {
    renderedNotes.push(item.data);
    if (item.data.numbers.length >= 3) stackedEntries++;
  }
  for (const child of item.children) walk(child as InstanceType<typeof layoutMod.PageItem>);
};
for (const page of layout.pages) walk(page);
check(pianoSystems > 0, "paired piano systems were not created");
check(stackedEntries > 0, "stacked chord was not rendered as numbered rows");
check(braceGlyphs === pianoSystems, "piano systems are not using one standard SMuFL brace each");
check(instrumentLabels === 1, "instrument name must appear on the first piano system only");
check(obsoleteHandLabels === 0, "obsolete right/left hand labels are still rendered");
const instrumentFrame = renderedText.find((item) => item.text === "钢琴");
const titleFrame = renderedText.find((item) => item.text === score.title);
const metaFrame = renderedText.find((item) => item.text.startsWith("1=") && item.text.includes("♩="));
const creditFrame = renderedText.find((item) => item.text === "jpeditor piano");
const pageNumberFrame = renderedText.find((item) => /^\d+\/\d+$/.test(item.text));
check(instrumentFrame && Math.abs(instrumentFrame.font.size - layout.options.lrcFont.size * 0.56 / 1.5) < 0.01, "instrument font was not reduced by 1.5x");
const publicationTitleSize = Math.min(layout.options.titleSize, layout.options.numberSize * 1.25);
check(titleFrame && Math.abs(titleFrame.y - (publicationTitleSize * 2.2 + layout.options.numberSize * 0.35)) < 0.01,
  "publication title was not moved down by one title size plus the global offset");
check(metaFrame && Math.abs(metaFrame.font.size - layout.options.numberSize * 0.87) < 0.01,
  "key/meter/tempo metadata was not reduced by the requested 1.2x");
check(creditFrame && Math.abs(creditFrame.font.size - layout.options.numberSize * 0.52) < 0.01, "credits changed size with the enlarged metadata");
check(pageNumberFrame && Math.abs(pageNumberFrame.font.size - layout.options.lrcFont.size * 0.8 / 3) < 0.01, "page number was not reduced to one third");
const braceGlyphOf = (system: InstanceType<typeof layoutMod.Group>): InstanceType<typeof layoutMod.TextFrame> | null => {
  let found: InstanceType<typeof layoutMod.TextFrame> | null = null;
  const find = (item: InstanceType<typeof layoutMod.PageItem>): void => {
    if (item instanceof layoutMod.TextFrame && item.text === String.fromCharCode(0xe000)) found = item;
    for (const child of item.children) find(child as InstanceType<typeof layoutMod.PageItem>);
  };
  find(system);
  return found;
};
if (renderedSystems.length > 1) {
  const continuationBrace = braceGlyphOf(renderedSystems[1]);
  check(continuationBrace?.parent, "continuation piano system lost its brace");
  const labelLeft = instrumentFrame.pos(renderedSystems[0]).x;
  const braceLeft = continuationBrace.parent.pos(renderedSystems[1]).x - continuationBrace.strokeWidth / 2;
  check(Math.abs(labelLeft - braceLeft) < 0.1, `continuation brace does not align with the first instrument-name character (${labelLeft} vs ${braceLeft})`);
}
let braceAlignedMeasureNumbers = 0;
for (const system of renderedSystems) {
  const label = system.children.find((item): item is InstanceType<typeof layoutMod.TextFrame> =>
    item instanceof layoutMod.TextFrame && item.classes.has("measure-number"));
  if (!label) continue;
  const brace = braceGlyphOf(system);
  check(brace?.parent, "numbered piano system lost its brace");
  const braceLeft = brace.parent.pos(system).x - brace.strokeWidth / 2;
  check(Math.abs(label.pos(system).x - braceLeft) < 0.1,
    "piano measure number is not aligned with the brace's left edge");
  braceAlignedMeasureNumbers++;
}
check(braceAlignedMeasureNumbers > 0, "piano systems did not render a brace-aligned measure number");
for (const entry of renderedNotes) {
  for (const dot of entry.octaveDot) {
    check(dot.owner, "octave dot lost its owning number");
    check(Math.abs(dot.x + dot.width / 2 - (dot.owner.x + dot.owner.cx)) < 0.01, "octave dot is not centered on its number");
  }
  if (entry.numbers.length < 2) continue;
  const peer = entry.line.entries.find((e) => e instanceof layoutMod.NoteEntry && e.numbers.length === 1 && e.number?.text !== "-");
  check(peer instanceof layoutMod.NoteEntry && peer.number, "stacked chord has no baseline peer");
  const chordBottom = entry.numbers[entry.numbers.length - 1].pos(entry.line.group).y;
  const peerBaseline = peer.number.pos(entry.line.group).y;
  check(Math.abs(chordBottom - peerBaseline) < 0.01, "bottom chord tone is not on the rhythmic baseline");
}
const octaveGeometry = (distance: number, clearance: number): { ownerGap: number; neighbourGap: number } => {
  const options = new layoutMod.LayoutOptions(28);
  options.smuflMeta = smuflMeta;
  options.applyEngravingStyle({ octaveDotDistance: distance, octaveDotClearance: clearance });
  const measure = new scoreMod.Measure(0);
  const chord = new scoreMod.Chord(measure);
  chord.beats = 1;
  const upper = new scoreMod.Note(chord);
  upper.number = "5";
  upper.jpOctave = -1;
  chord.add(upper);
  const lower = new scoreMod.Note(chord);
  lower.number = "1";
  chord.add(lower);
  const entries: InstanceType<typeof layoutMod.Entry>[] = [];
  layoutMod.NoteEntry.fromChord(entries, chord, 0, options);
  const entry = entries[0];
  check(entry instanceof layoutMod.NoteEntry && entry.numbers.length === 2,
    "octave-dot clearance fixture did not render its chord rows");
  const dot = entry.octaveDot.find((item) => item.owner === entry.numbers[0]);
  check(dot, "octave-dot clearance fixture lost the upper row's lower dot");
  const owner = entry.numbers[0];
  const neighbour = entry.numbers[1];
  return {
    ownerGap: dot.y - (owner.y + owner.bound.bottom),
    neighbourGap: neighbour.y + neighbour.bound.top - (dot.y + dot.height),
  };
};
const closeOwnerDot = octaveGeometry(0.2, 1);
const distantOwnerDot = octaveGeometry(2, 1);
const narrowNeighbourGap = octaveGeometry(0.75, 0.3);
const wideNeighbourGap = octaveGeometry(0.75, 3);
check(distantOwnerDot.ownerGap > closeOwnerDot.ownerGap + 0.5,
  "octave-dot owner-distance control did not affect the real note geometry");
check(wideNeighbourGap.neighbourGap > narrowNeighbourGap.neighbourGap + 1,
  "octave-dot adjacent-tone clearance control did not affect chord-row geometry");
let matchedFullHeightBarlines = 0;
for (const system of renderedSystems) {
  const directLines = system.children.filter((item): item is InstanceType<typeof layoutMod.GraphicLine> => item instanceof layoutMod.GraphicLine);
  const connectors = directLines.filter((line) => line.classes.has("piano-barline-connector"));
  const nestedLines: InstanceType<typeof layoutMod.GraphicLine>[] = [];
  const numbers: InstanceType<typeof layoutMod.JpNumber>[] = [];
  const collect = (item: InstanceType<typeof layoutMod.PageItem>): void => {
    if (item !== system && item instanceof layoutMod.GraphicLine && item.parent !== system) nestedLines.push(item);
    if (item instanceof layoutMod.JpNumber) numbers.push(item);
    for (const child of item.children) collect(child as InstanceType<typeof layoutMod.PageItem>);
  };
  collect(system);
  for (const connector of connectors) {
    const x = connector.pos(system).x;
    const nearest = Math.min(...nestedLines.map((line) => Math.abs(line.pos(system).x - x)));
    check(nearest < 0.01, "between-hand connector is not centered on the local barline");
  }
  const systemLeft = directLines.find((line) => line.classes.has("piano-system-left"));
  check(systemLeft && numbers.length > 0, "piano system left edge or numbers are missing");
  const firstNumberX = Math.min(...numbers.map((number) => number.pos(system).x));
  check(firstNumberX - systemLeft.pos(system).x > layout.options.numberSize * 0.4, "left system line is too close to the first number");
  const allLines = [...directLines, ...nestedLines];
  const systemTop = systemLeft.pos(system).y;
  const systemBottom = systemTop + systemLeft.height;
  for (const connector of connectors) {
    const x = connector.pos(system).x;
    const segments = allLines.filter((line) =>
      line.height > line.width && Math.abs(line.pos(system).x - x) < 0.01);
    const top = Math.min(...segments.map((line) => line.pos(system).y));
    const bottom = Math.max(...segments.map((line) => line.pos(system).y + line.height));
    check(Math.abs(top - systemTop) < 0.01 && Math.abs(bottom - systemBottom) < 0.01,
      "measure barline does not share the brace-side system line height");
    matchedFullHeightBarlines++;
  }
}

const uniformFile = JpwFile.fromString(`.Title
KeyAndMeters = {1=C,4/4}
.Voice.RH
1 2 3 4 |1 2 3 4 |1 2 3 4 |1 2 3 4 |1 2 3 4 |1 2 3 4 |1 2 3 4 |1 2 3 4 |]
.Voice.LH
1,- 5,- |1,- 5,- |1,- 5,- |1,- 5,- |1,- 5,- |1,- 5,- |1,- 5,- |1,- 5,- |]
`);
check(uniformFile, "uniform four-measure piano fixture did not parse");
const uniformScore = fromJpw(uniformFile);
check(uniformScore?.piano, "uniform fixture did not enter piano mode");
const uniformLayout = new layoutMod.Layout(28);
uniformLayout.options.smuflMeta = smuflMeta;
uniformLayout.fromScore(uniformScore, null, 960, 540);
const uniformSystems: InstanceType<typeof layoutMod.Group>[] = [];
const collectUniformSystems = (item: InstanceType<typeof layoutMod.PageItem>): void => {
  if (item instanceof layoutMod.Group && item.classes.has("piano-system")) uniformSystems.push(item);
  for (const child of item.children) collectUniformSystems(child as InstanceType<typeof layoutMod.PageItem>);
};
for (const page of uniformLayout.pages) collectUniformSystems(page);
check(uniformSystems.length === 2, "eight ordinary measures should use two four-measure systems");
const uniformMeasureWidths: number[][] = [];
for (const system of uniformSystems) {
  const barXs: number[] = [];
  const collectBars = (item: InstanceType<typeof layoutMod.PageItem>): void => {
    if (item instanceof layoutMod.Group && item.data instanceof layoutMod.Barline) {
      barXs.push(item.pos(system).x + item.width);
    }
    for (const child of item.children) collectBars(child as InstanceType<typeof layoutMod.PageItem>);
  };
  collectBars(system);
  barXs.sort((a, b) => a - b);
  const uniqueBars = barXs.filter((x, index) => index === 0 || Math.abs(x - barXs[index - 1]) > 0.01);
  check(uniqueBars.length === 4, "target four-measure system has the wrong number of shared barlines");
  check(barXs.length === 8, "right/left hands did not contribute one aligned barline per measure");
  const widths = uniqueBars.slice(1).map((x, index) => x - uniqueBars[index]);
  check(Math.max(...widths) - Math.min(...widths) < 0.01, "ordinary measures in a system are not equal width");
  check(Math.abs(uniqueBars[uniqueBars.length - 1] - system.width) < 0.01, "last measure does not reach the system right edge");
  uniformMeasureWidths.push(widths);
}

const customLayout = new layoutMod.Layout(28);
customLayout.options.smuflMeta = smuflMeta;
customLayout.options.applyEngravingStyle({
  numberScale: 1.2,
  numberBold: true,
  chordRowGap: 1.05,
  braceStrokeWidth: 2.4,
  pianoConnectorScale: 1.2,
  finalBarlineWidth: 5,
});
customLayout.fromScore(score, null, 960, 540);
let customFinalSegments = 0, customConnectorSegments = 0, boldNumbers = 0, customBraceWeight = 0;
const walkCustom = (item: InstanceType<typeof layoutMod.PageItem>): void => {
  if (item instanceof layoutMod.GraphicLine) {
    if (Math.abs(item.strokeWidth - 5) < 0.001) customFinalSegments++;
    if (Math.abs(item.strokeWidth - 6) < 0.001) customConnectorSegments++;
  }
  if (item instanceof layoutMod.JpNumber && item.font.bold) boldNumbers++;
  if (item instanceof layoutMod.SmuflText && item.text === String.fromCharCode(0xe000)) {
    customBraceWeight = item.strokeWidth;
    check(item.nonScalingStroke, "brace weight is being scaled with brace geometry");
  }
  for (const child of item.children) walkCustom(child as InstanceType<typeof layoutMod.PageItem>);
};
for (const page of customLayout.pages) walkCustom(page);
check(customFinalSegments >= 4, "custom final double-bar thickness was not applied");
check(customConnectorSegments >= 2, "custom between-hand connector thickness was not applied");
check(boldNumbers > 0, "custom bold number style was not applied");
check(Math.abs(customBraceWeight - 2.4) < 0.001, "custom brace weight was not applied to the actual SMuFL glyph");

const braceMetrics = (widthScale: number, strokeWidth: number): { outerWidth: number; strokeWidth: number } => {
  const target = new layoutMod.Layout(28);
  target.options.smuflMeta = smuflMeta;
  target.options.applyEngravingStyle({ braceWidthScale: widthScale, braceStrokeWidth: strokeWidth });
  target.fromScore(score, null, 960, 540);
  const groups: InstanceType<typeof layoutMod.Group>[] = [];
  const glyphs: InstanceType<typeof layoutMod.SmuflText>[] = [];
  const find = (item: InstanceType<typeof layoutMod.PageItem>): void => {
    if (item instanceof layoutMod.Group && item.classes.has("piano-brace")) groups.push(item);
    if (item instanceof layoutMod.SmuflText && item.classes.has("piano-brace-glyph")) glyphs.push(item);
    for (const child of item.children) find(child as InstanceType<typeof layoutMod.PageItem>);
  };
  for (const page of target.pages) find(page);
  check(groups[0] && glyphs[0], "brace geometry fixture did not render a brace");
  const box = smuflMeta.getBBox(String.fromCharCode(0xe000));
  check(box, "brace metadata bounding box is missing");
  const baseWidth = Math.max(0.1, (box.bBoxNE[0] - box.bBoxSW[0]) * target.options.smuflFont.size / 4);
  return {
    outerWidth: groups[0].matrix.mat[0] * baseWidth + glyphs[0].strokeWidth,
    strokeWidth: glyphs[0].strokeWidth,
  };
};
const narrowBrace = braceMetrics(0.5, 1.6);
const wideBrace = braceMetrics(2.2, 1.6);
const thinBrace = braceMetrics(1, 0.5);
const thickBrace = braceMetrics(1, 5);
check(wideBrace.outerWidth > narrowBrace.outerWidth * 4,
  "brace width slider is still being swallowed by a fixed minimum width");
check(Math.abs(thinBrace.outerWidth - thickBrace.outerWidth) < 0.05 && thickBrace.strokeWidth > thinBrace.strokeWidth * 9,
  "brace width and weight controls are not independent");
const pianoGuideLayout = new layoutMod.Layout(28);
pianoGuideLayout.options.smuflMeta = smuflMeta;
pianoGuideLayout.options.applyEngravingStyle({ rhythmGuideEnabled: true, rhythmGuideDivision: 4 });
pianoGuideLayout.fromScore(score, null, 960, 540);
let pianoGuideLines = 0;
const walkPianoGuide = (item: InstanceType<typeof layoutMod.PageItem>): void => {
  if (item.classes.has("rhythm-guide-line")) pianoGuideLines++;
  for (const child of item.children) walkPianoGuide(child as InstanceType<typeof layoutMod.PageItem>);
};
for (const page of pianoGuideLayout.pages) walkPianoGuide(page);
check(pianoGuideLines >= 1, "paired piano score did not receive its shared lower rhythm guide");
const legacyLayout = new layoutMod.Layout(28);
legacyLayout.options.smuflMeta = smuflMeta;
legacyLayout.fromScore(legacyScore, null, 960, 540);
check(legacyLayout.pages.length > 0, "legacy single-line layout produced no pages");

const pickupFile = JpwFile.fromString(`.Title
KeyAndMeters = {1=C,4/4}
.Voice
1 2 3 4 | 1 2 3 4 | 1 2 3 4 | 1 2 3 4 | 1 2 3 4 |]
`);
check(pickupFile, "pickup layout fixture did not parse");
const pickupScore = fromJpw(pickupFile);
check(pickupScore, "pickup layout fixture did not convert");
const pickupPart = pickupScore.parts[0];
const pickupFirst = pickupPart.measures[0];
pickupFirst.entries = pickupFirst.entries
  .filter((entry): entry is InstanceType<typeof scoreMod.Chord> => entry instanceof scoreMod.Chord)
  .slice(0, 2);
pickupFirst.pickup = true;
pickupFirst.displayNumber = null;
pickupPart.measures.slice(1).forEach((measure, index) => { measure.displayNumber = index + 1; });
const pickupLayout = new layoutMod.Layout(28);
pickupLayout.options.smuflMeta = smuflMeta;
pickupLayout.options.applyEngravingStyle({ measuresPerSystem: 4, justifyLastSystem: true });
pickupLayout.fromScore(pickupScore, null, 960, 540);
const pickupSystems = pickupLayout.pages.flatMap((page) => page.children)
  .filter((item): item is InstanceType<typeof layoutMod.Group> =>
    item instanceof layoutMod.Group && item.classes.has("rhythmic-system"));
check(pickupSystems[0], "pickup layout did not produce a rhythmic system");
const pickupMeasureIds = new Set<number>();
const pickupBarXs: number[] = [];
const pickupLabels: InstanceType<typeof layoutMod.TextFrame>[] = [];
const walkPickup = (item: InstanceType<typeof layoutMod.PageItem>): void => {
  if (item.data instanceof layoutMod.Entry && item.data.syncMeasure >= 0) pickupMeasureIds.add(item.data.syncMeasure);
  if (item.data instanceof layoutMod.Barline) pickupBarXs.push(item.pos(pickupSystems[0]).x);
  if (item instanceof layoutMod.TextFrame && item.classes.has("measure-number")) pickupLabels.push(item);
  for (const child of item.children) walkPickup(child as InstanceType<typeof layoutMod.PageItem>);
};
walkPickup(pickupSystems[0]);
pickupBarXs.sort((a, b) => a - b);
check(pickupMeasureIds.size === 5, "pickup consumed one of the four preferred formal-measure slots");
check(pickupBarXs.length === 5 && pickupBarXs[0] < pickupBarXs[1] - pickupBarXs[0],
  "pickup measure did not receive a visibly shorter width");
check(pickupLabels.length === 1 && pickupLabels[0].text === "(1)" && !pickupLabels[0].affectsLayout,
  "first full measure is missing its non-flowing parenthesized number");

const slashContinuationText = `键盘谱
4/4拍：
(AB)(AC)/ (AD) (AE)/ (AF)  /(AG)  (AH)/
`;
const slashContinuationAnalysis = slashMod.analyzeSlashScore(slashContinuationText);
const slashContinuationOptions = {
  ...slashMod.defaultSlashScoreOptions("keyboard", slashContinuationAnalysis),
  symbolDurations: {},
  spaceDivision: 16 as const,
  noteDivision: 16 as const,
};
const slashContinuationScore = slashMod.parseSlashScore(slashContinuationText, slashContinuationOptions).score;
const slashContinuationLayout = new layoutMod.Layout(28);
slashContinuationLayout.options.smuflMeta = smuflMeta;
slashContinuationLayout.fromScore(slashContinuationScore, null, 960, 540);
let transparentNumbers = 0;
let continuationTies = 0;
const continuationAlphas: number[] = [];
const continuationGrayChannels: number[] = [];
const walkSlashContinuation = (item: InstanceType<typeof layoutMod.PageItem>): void => {
  if (item instanceof layoutMod.Tie) continuationTies++;
  if (item instanceof layoutMod.JpNumber && item.parent?.data instanceof layoutMod.NoteEntry &&
      item.parent.data.chord.transparentContinuation) {
    transparentNumbers++;
    continuationAlphas.push((item.color >>> 24) & 0xff);
    continuationGrayChannels.push((item.color >>> 16) & 0xff);
  }
  for (const child of item.children) walkSlashContinuation(child as InstanceType<typeof layoutMod.PageItem>);
};
for (const page of slashContinuationLayout.pages) walkSlashContinuation(page);
check(transparentNumbers === 4 && continuationAlphas.every((alpha) => alpha === 0xff) &&
  continuationGrayChannels.every((channel) => channel > 0 && channel < 0xff),
"generated continuation chord numbers are not rendered with the gray continuation style");
check(continuationTies >= 2, "generated cross-group continuation ties were not added to the layout");

const partialArpeggioText = `键盘谱
4/4拍：
花括号=琶音
(,ZZ){F#GQR}/-/-/-/
`;
const partialArpeggioAnalysis = slashMod.analyzeSlashScore(partialArpeggioText);
const partialArpeggioOptions = slashMod.defaultSlashScoreOptions("keyboard", partialArpeggioAnalysis);
const partialArpeggioScore = slashMod.parseSlashScore(partialArpeggioText, partialArpeggioOptions).score;
const partialArpeggioChord = partialArpeggioScore.parts[0].measures[0].entries
  .find((entry): entry is InstanceType<typeof scoreMod.Chord> =>
    entry instanceof scoreMod.Chord && entry.arpeggio);
check(partialArpeggioChord, "partial arpeggio fixture did not produce a written arpeggio chord");
const partialArpeggioEntries: InstanceType<typeof layoutMod.Entry>[] = [];
const partialArpeggioEntryOptions = new layoutMod.LayoutOptions(28);
partialArpeggioEntryOptions.smuflMeta = smuflMeta;
layoutMod.NoteEntry.fromChord(partialArpeggioEntries, partialArpeggioChord, 0, partialArpeggioEntryOptions);
const partialArpeggioEntry = partialArpeggioEntries[0];
check(partialArpeggioEntry instanceof layoutMod.NoteEntry,
  "partial arpeggio fixture did not render as a numbered entry");
const partialArpeggioWave = partialArpeggioEntry.group.children.find((item) =>
  item instanceof layoutMod.GraphicPath && item.classes.has("jianpu-arpeggio"));
check(partialArpeggioWave instanceof layoutMod.GraphicPath,
  "partial arpeggio fixture did not render its wave");
const waveYs = partialArpeggioWave.segs.flatMap((segment) =>
  segment.pts.filter((_value, index) => index % 2 === 1));
const rolledPitchSet = new Set(partialArpeggioChord.arpeggioPitches ?? []);
const rolledRows = partialArpeggioEntry.numbers.filter((_number, index) =>
  rolledPitchSet.has(partialArpeggioChord.notes[index].pitch));
const bassRows = partialArpeggioEntry.numbers.filter((_number, index) =>
  !rolledPitchSet.has(partialArpeggioChord.notes[index].pitch));
check(rolledRows.length === 4 && bassRows.length === 2,
  "partial arpeggio layout lost the four rolled rows or two simultaneous bass rows");
const waveTop = Math.min(...waveYs);
const waveBottom = Math.max(...waveYs);
check(waveTop < Math.min(...rolledRows.map((number) => number.y)) &&
      waveBottom > Math.max(...rolledRows.map((number) => number.y)),
  "partial arpeggio wave does not span every bracketed upper note");
check(waveBottom < Math.min(...bassRows.map((number) => number.y)),
  "partial arpeggio wave incorrectly extends into the unbracketed bass notes");
const partialArpeggioLayout = new layoutMod.Layout(28);
partialArpeggioLayout.options.smuflMeta = smuflMeta;
partialArpeggioLayout.fromScore(partialArpeggioScore, null, 960, 540);

let defaultRhythmGuides = 0;
const countDefaultGuides = (item: InstanceType<typeof layoutMod.PageItem>): void => {
  if (item.classes.has("rhythm-guide-line")) defaultRhythmGuides++;
  for (const child of item.children) countDefaultGuides(child as InstanceType<typeof layoutMod.PageItem>);
};
for (const page of legacyLayout.pages) countDefaultGuides(page);
check(defaultRhythmGuides >= 1, "the saved baseline style should enable the automatic rhythm guide by default");

const firstLegacyChord = legacyScore.parts[0].measures[0].entries.find((entry) => entry instanceof scoreMod.Chord);
check(firstLegacyChord, "legacy guide fixture has no chord");
firstLegacyChord.beams = 2; // force a 16th-note minor grid in the guide regression
const guideLayout = new layoutMod.Layout(28);
guideLayout.options.smuflMeta = smuflMeta;
guideLayout.options.applyEngravingStyle({ rhythmGuideEnabled: true, rhythmGuideDivision: 4 });
guideLayout.fromScore(legacyScore, null, 960, 540);
let guideLines = 0, majorTicks = 0, minorTicks = 0;
const majorXs: number[] = [], beatNoteXs: number[] = [];
const guidePage = guideLayout.pages[0];
const walkGuide = (item: InstanceType<typeof layoutMod.PageItem>): void => {
  if (item.classes.has("rhythm-guide-line")) guideLines++;
  if (item.classes.has("rhythm-guide-major")) {
    majorTicks++;
    majorXs.push(item.pos(guidePage).x);
  }
  if (item.classes.has("rhythm-guide-minor")) minorTicks++;
  if (item instanceof layoutMod.JpNumber && item.parent?.data instanceof layoutMod.NoteEntry) {
    const entry = item.parent.data;
    if (entry.syncTick.denominator === 1) beatNoteXs.push(item.pos(guidePage).x + item.cx);
  }
  for (const child of item.children) walkGuide(child as InstanceType<typeof layoutMod.PageItem>);
};
for (const page of guideLayout.pages) walkGuide(page);
check(guideLines >= 1, "enabled rhythm guide baseline is missing");
check(majorTicks >= 4 && minorTicks >= 12, "4/4 sixteenth grid must contain long beat ticks and short subdivision ticks");
check(beatNoteXs.length >= 4 && beatNoteXs.every((x) => Math.min(...majorXs.map((tickX) => Math.abs(tickX - x))) < 0.05),
  "rhythm guide long ticks are not aligned with beat-note centers");
check(guideLayout.options.engravingStyle.rhythmGuideMode === "auto", "rhythm guide must default to automatic shortest-value detection");

const manualGuideCounts = (division: 4 | 8 | 16 | 32 | 64): { major: number; minor: number } => {
  const target = new layoutMod.Layout(28);
  target.options.smuflMeta = smuflMeta;
  target.options.applyEngravingStyle({
    rhythmGuideEnabled: true,
    rhythmGuideMode: "manual",
    rhythmGuideDivision: division,
  });
  target.fromScore(legacyScore, null, 960, 540);
  let major = 0, minor = 0;
  const walkTicks = (item: InstanceType<typeof layoutMod.PageItem>): void => {
    if (item.classes.has("rhythm-guide-major")) major++;
    if (item.classes.has("rhythm-guide-minor")) minor++;
    for (const child of item.children) walkTicks(child as InstanceType<typeof layoutMod.PageItem>);
  };
  for (const page of target.pages) walkTicks(page);
  return { major, minor };
};
const manualQuarter = manualGuideCounts(4);
const manualThirtySecond = manualGuideCounts(32);
check(manualQuarter.major === 4 && manualQuarter.minor === 0,
  "manual quarter-note guide must ignore finer notes and draw beat ticks only");
check(manualThirtySecond.major === 4 && manualThirtySecond.minor === 28,
  "manual thirty-second guide did not draw the requested fixed subdivision grid");

const longRight = Array.from({ length: 36 }, (_, index) => index === 35
  ? "1' 2' 3' 4' |]"
  : "1' 2' 3' 4' |").join(" ");
const longLeft = Array.from({ length: 36 }, (_, index) => index === 35
  ? "1, 5, 1, 5, |]"
  : "1, 5, 1, 5, |").join(" ");
const longPianoFile = JpwFile.fromString(`.Title
KeyAndMeters = {1=C,4/4}
Instrument = {钢琴}
.Voice.RH
${longRight}
.Voice.LH
${longLeft}
`);
check(longPianoFile, "long piano pagination fixture did not parse");
const longPianoScore = fromJpw(longPianoFile);
check(longPianoScore?.piano, "long piano pagination fixture lost piano mode");
const makeGapLayout = (scale: number): InstanceType<typeof layoutMod.Layout> => {
  const result = new layoutMod.Layout(28);
  result.options.smuflMeta = smuflMeta;
  result.options.applyEngravingStyle({ systemGapScale: scale });
  result.fromScore(longPianoScore, null, 595, 842);
  return result;
};
const defaultGapLayout = makeGapLayout(1);
const compactGapLayout = makeGapLayout(0.35);
const systemsByPage = (target: InstanceType<typeof layoutMod.Layout>) => target.pages.map((page) =>
  page.children.filter((item) => item.classes.has("piano-system")));
const defaultGapSystems = systemsByPage(defaultGapLayout);
const compactGapSystems = systemsByPage(compactGapLayout);
const checkSystemGaps = (target: InstanceType<typeof layoutMod.Layout>, pages: InstanceType<typeof layoutMod.PageItem>[][]): void => {
  const expected = target.options.systemGap();
  for (const systems of pages) {
    for (let index = 1; index < systems.length; index++) {
      const actual = systems[index].y - (systems[index - 1].y + systems[index - 1].height);
      check(Math.abs(actual - expected) < 0.05, "piano system gap does not match the global setting");
    }
  }
};
checkSystemGaps(defaultGapLayout, defaultGapSystems);
checkSystemGaps(compactGapLayout, compactGapSystems);
check(compactGapLayout.pages.length <= defaultGapLayout.pages.length,
  "smaller piano system gaps did not reflow later systems into earlier pages");
check(compactGapSystems[0].length >= defaultGapSystems[0].length,
  "smaller piano system gaps reduced the first page capacity");

const ensembleVoice = (note: string): string => Array.from({ length: 16 }, (_unused, index) =>
  index === 15 ? `${note} ${note} ${note} ${note} |]` : `${note} ${note} ${note} ${note} |`,
).join(" ");
const ensembleFile = JpwFile.fromString(`.Title
Title = {多轨总谱排版测试}
KeyAndMeters = {1=C,4/4}
Tempo = {96}
.Voice.钢琴.V1
${ensembleVoice("1'")}
.Voice.钢琴.V2
${ensembleVoice("1,")}
.Voice.小提琴.V1
${ensembleVoice("5'")}
`);
check(ensembleFile, "ensemble layout fixture did not parse");
const ensembleScore = fromJpw(ensembleFile);
check(ensembleScore?.ensemble && ensembleScore.parts.length === 3, "ensemble layout fixture lost its voices");
const ensembleLayout = new layoutMod.Layout(28);
ensembleLayout.options.smuflMeta = smuflMeta;
ensembleLayout.fromScore(ensembleScore, null, 595, 842);
const ensembleSystems = ensembleLayout.pages.flatMap((page) =>
  page.children.filter((item) => item.classes.has("ensemble-system")));
check(ensembleSystems.length >= 4, "ensemble measures were not packed into repeated full-score systems");
let ensembleBrackets = 0, ensembleHooks = 0, ensembleConnectors = 0;
let ensembleInstrumentBraces = 0, ensembleRhythmGuides = 0;
for (const system of ensembleSystems) {
  const rows = system.children.filter((item): item is InstanceType<typeof layoutMod.Group> =>
    item instanceof layoutMod.Group && item.children.some((child) => child.data instanceof layoutMod.NoteEntry));
  check(rows.length === 3, "pagination split an ensemble system into orphan voice rows");
  const withinInstrumentGap = rows[1].y - (rows[0].y + rows[0].height);
  const betweenInstrumentGap = rows[2].y - (rows[1].y + rows[1].height);
  check(betweenInstrumentGap > withinInstrumentGap + 0.1,
    "different instruments do not have a wider gap than voices of the same instrument");
  const labels = system.children.filter((item) => item.classes.has("ensemble-instrument-label"));
  check(labels.length === 2, "ensemble system did not label every instrument group");
  const instrumentBraces = system.children.filter((item) => item.classes.has("ensemble-instrument-brace"));
  check(instrumentBraces.length === 1,
    "a multi-voice instrument did not receive exactly one shared brace");
  ensembleInstrumentBraces += instrumentBraces.length;
  const guideBaselines = system.children.filter((item): item is InstanceType<typeof layoutMod.GraphicLine> =>
    item instanceof layoutMod.GraphicLine && item.classes.has("rhythm-guide-line"));
  const guideRows = new Set(guideBaselines.map((line) => line.y.toFixed(4)));
  check(guideRows.size === 2, "each instrument did not receive its own rhythm guide");
  ensembleRhythmGuides += guideRows.size;
  const bracketLines = system.children.filter((item): item is InstanceType<typeof layoutMod.GraphicLine> =>
    item instanceof layoutMod.GraphicLine && item.classes.has("ensemble-bracket"));
  ensembleBrackets += bracketLines.length;
  const bracketHooks = system.children.filter((item): item is InstanceType<typeof layoutMod.GraphicLine> =>
    item instanceof layoutMod.GraphicLine && item.classes.has("ensemble-bracket-hook"));
  check(bracketHooks.every((hook) => Math.abs(hook.p1.y) < 1e-8),
    "ensemble bracket hooks are not horizontal 90-degree corners");
  check(bracketLines.length === 1 && bracketHooks.every((hook) =>
    Math.abs(hook.x - (bracketLines[0].x - bracketLines[0].strokeWidth / 2)) < 1e-8),
  "ensemble bracket hook left edges do not align with the vertical stroke");
  ensembleHooks += bracketHooks.length;
  ensembleConnectors += system.children.filter((item) => item.classes.has("ensemble-barline-connector")).length;
}
check(ensembleBrackets === ensembleSystems.length && ensembleHooks === ensembleSystems.length * 2,
  "ensemble bracket or its right-angle hooks are missing");
check(ensembleConnectors > 0, "barlines were not connected inside an instrument voice group");

const oneInstrumentFile = JpwFile.fromString(`.Title
Title = {单乐器多声部总谱}
KeyAndMeters = {1=C,4/4}
.Voice.钢琴.V1
${ensembleVoice("1'")}
.Voice.钢琴.V2
${ensembleVoice("1,")}
`);
check(oneInstrumentFile, "single-instrument ensemble fixture did not parse");
const oneInstrumentScore = fromJpw(oneInstrumentFile);
check(oneInstrumentScore?.ensemble && oneInstrumentScore.parts.length === 2,
  "single-instrument ensemble fixture lost its voices");
const oneInstrumentLayout = new layoutMod.Layout(28);
oneInstrumentLayout.options.smuflMeta = smuflMeta;
oneInstrumentLayout.fromScore(oneInstrumentScore, null, 595, 842);
const oneInstrumentSystems = oneInstrumentLayout.pages.flatMap((page) =>
  page.children.filter((item) => item.classes.has("ensemble-system")));
check(oneInstrumentSystems.length > 0, "single-instrument ensemble did not render any systems");
for (const system of oneInstrumentSystems) {
  check(system.children.filter((item) => item.classes.has("ensemble-instrument-brace")).length === 1,
    "single multi-voice instrument lost its internal brace");
  check(system.children.every((item) =>
    !item.classes.has("ensemble-bracket") && !item.classes.has("ensemble-bracket-hook")),
  "single-instrument ensemble must not draw the outer square bracket");
}

const svg = new FakeElement("svg");
svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
svg.setAttribute("viewBox", "0 0 960 540");
svg.setAttribute("width", "960");
svg.setAttribute("height", "540");
svg.appendChild(painterMod.renderPageItem(layout.pages[0]) as unknown as FakeElement);
const svgPath = join(tmpdir(), "piano-demo.svg");
await writeFile(svgPath, svg.outerHTML, "utf-8");
const slashSvg = new FakeElement("svg");
slashSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
slashSvg.setAttribute("viewBox", "0 0 960 540");
slashSvg.setAttribute("width", "960");
slashSvg.setAttribute("height", "540");
slashSvg.appendChild(painterMod.renderPageItem(slashContinuationLayout.pages[0]) as unknown as FakeElement);
const slashSvgPath = join(tmpdir(), "slash-continuation.svg");
await writeFile(slashSvgPath, slashSvg.outerHTML, "utf-8");
const partialArpeggioSvg = new FakeElement("svg");
partialArpeggioSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
partialArpeggioSvg.setAttribute("viewBox", "0 0 960 540");
partialArpeggioSvg.setAttribute("width", "960");
partialArpeggioSvg.setAttribute("height", "540");
partialArpeggioSvg.appendChild(
  painterMod.renderPageItem(partialArpeggioLayout.pages[0]) as unknown as FakeElement,
);
const partialArpeggioSvgPath = join(tmpdir(), "partial-arpeggio.svg");
await writeFile(partialArpeggioSvgPath, partialArpeggioSvg.outerHTML, "utf-8");

console.log(JSON.stringify({
  parts: score.parts.length,
  measures: score.parts[0].measures.length,
  pages: layout.pages.length,
  pianoSystems,
  customFinalSegments,
  customConnectorSegments,
  matchedFullHeightBarlines,
  braceControls: { narrowBrace, wideBrace, thinBrace, thickBrace },
  uniformMeasureWidths,
  rhythmGuide: { guideLines, majorTicks, minorTicks, pianoGuideLines, manualQuarter, manualThirtySecond },
  systemGapReflow: {
    defaultPages: defaultGapLayout.pages.length,
    compactPages: compactGapLayout.pages.length,
    defaultFirstPage: defaultGapSystems[0].length,
    compactFirstPage: compactGapSystems[0].length,
  },
  ensemble: {
    pages: ensembleLayout.pages.length,
    systems: ensembleSystems.length,
    brackets: ensembleBrackets,
    instrumentBraces: ensembleInstrumentBraces,
    rhythmGuides: ensembleRhythmGuides,
    connectors: ensembleConnectors,
  },
  midiTracks: (midi[10] << 8) | midi[11],
  musicXmlParts: xmlScore.parts.length,
  svg: svgPath,
  slashSvg: slashSvgPath,
  partialArpeggioSvg: partialArpeggioSvgPath,
}, null, 2));
