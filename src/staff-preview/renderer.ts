import {
  Accidental, Annotation, Articulation, BarlineType, Beam, Dot, Element, Formatter,
  Fraction as VexFraction, GhostNote, GraceNote, GraceNoteGroup, KeySignature, KeySigNote,
  ModifierPosition, Ornament, Renderer, Stave, StaveConnector, StaveNote,
  Stem, Stroke, SVGContext, TimeSignature, Tuplet, VexFlow, Voice, VoiceMode, VoltaType,
} from "vexflow/core";
import type { Tickable } from "vexflow/core";
import { buildStaffModel } from "./model";
import type { StaffEvent, StaffMeasure, StaffModel, StaffPitch } from "./model";
import type { Chord } from "../score/score";
import { Fraction } from "../common/fraction";
import { A4_NOTATION_SCALE } from "../layout/notation-density";
import type { StaffNoteRef, StaffPreviewDocument, StaffPreviewSnapshot, StaffRenderedNote, StaffRenderedPage } from "./types";
import { abortStaffPreview, loadStaffFonts, yieldStaffPreview } from "./renderer-fonts";
import { noteHitBox, partitionUnisonHits, SVG_NS, svgText, withMountedSvg } from "./renderer-svg";

const PAGE_WIDTH = 794;
const PAGE_HEIGHT = 1123;
const MARGIN = 64;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const STAFF_DISTANCE = 132;
const ORNAMENT_CODES: Record<string, string> = {
  "upper-mordent": "mordent", "lower-mordent": "mordentInverted", trill: "tr",
  turn: "turn", "inverted-turn": "turnInverted",
};
function diagnostic(messages: string[], message: string): void {
  if (!messages.includes(message)) messages.push(message);
}

interface Binding { measure: number; row: number; event: number; pitch: number; grace: boolean }
interface DrawEvent { model: StaffEvent; note: StaveNote; grace: GraceNote[]; binding: Omit<Binding, "pitch" | "grace"> }
interface MeasureDrawing { voices: Voice[]; staves: Stave[]; events: DrawEvent[]; beams: Beam[]; tuplets: Tuplet[]; formatter: Formatter }
interface SystemLayout { measures: number[]; widths: number[]; offsets: number[]; scale: number; musicScale: number; contentScale: number; y: number; height: number; page: number; key: string }
interface SystemTemplate { svg: SVGSVGElement; bindings: Binding[] }
interface Anchor { x: number; y: number; left: number; right: number; top: number; bottom: number; staff: number; stem: number }
interface CurveObstacle { left: number; right: number; top: number; bottom: number; staff: number }
interface Endpoint { measure: number; staff: number; key: string; stem: number }
const endpointCache = new WeakMap<StaffModel, Map<string, Endpoint>>();

// Cache only immutable geometry and integer paths. No source Note/Chord/ref survives here.
const widthsCache = new Map<string, number>();
const templatesCache = new Map<string, SystemTemplate>();
function remember<T>(cache: Map<string, T>, key: string, value: T, limit: number): T {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
  return value;
}

function ghost(beats: Fraction): GhostNote {
  return new GhostNote({ duration: "q", durationOverride: new VexFraction(beats.numerator, beats.denominator * 4) });
}

function sizeMusicGlyph(element: Element, notationScale: number): void {
  // VexFlow mixes numeric point sizes with CSS strings such as "10pt" (dots).
  // Number("10pt") produces NaN and leaves an unscaled fallback glyph.
  const size = parseFloat(String(element.fontInfo.size));
  if (Number.isFinite(size)) element.setFont({ ...element.fontInfo, size: size * notationScale });
}

class ScaledKeySignature extends KeySignature {
  constructor(key: string, cancel: string | undefined, private readonly notationScale: number) {
    super(key, cancel);
  }
  protected override convertToGlyph(acc: { type: string; line: number }, next: { type: string; line: number }, stave: Stave): void {
    super.convertToGlyph(acc, next, stave);
    // KeySignature creates each accidental during format(). Scaling it here
    // lets the next glyph use the new width in its own x placement.
    sizeMusicGlyph(this.children[this.children.length - 1], this.notationScale);
  }
}

class ScaledKeySigNote extends KeySigNote {
  constructor(key: string, cancel: string | undefined, notationScale: number) {
    super(key, cancel);
    this.keySignature = new ScaledKeySignature(key, cancel, notationScale);
  }
}

class ScaledTimeSignature extends TimeSignature {
  constructor(specification: string, notationScale: number) {
    super(specification, 15 * notationScale);
    sizeMusicGlyph(this, notationScale);
    sizeMusicGlyph(this.topText, notationScale);
    sizeMusicGlyph(this.botText, notationScale);
    this.setTimeSig(specification);
  }
}

function sizeMusicNote(note: StaveNote | GraceNote, notationScale: number): void {
  sizeMusicGlyph(note, notationScale);
  note.noteHeads.forEach(head => sizeMusicGlyph(head, notationScale));
  note.setStemLength(35 * notationScale);
  note.buildFlag();
}

function makeNote(event: StaffEvent, clef: string, diagnostics: string[], autoStem: boolean, stemUp: boolean,
  notationScale: number, contentScale: number): { note: StaveNote; grace: GraceNote[] } {
  const note = new StaveNote({
    keys: event.rest ? [clef === "bass" ? "d/3" : "b/4"] : event.notes.map((pitch) => pitch.key),
    duration: event.duration,
    type: event.rest ? "r" : "n",
    dots: event.dots,
    clef,
    stemDirection: stemUp ? Stem.UP : Stem.DOWN,
    autoStem,
  });
  sizeMusicNote(note, notationScale);
  event.notes.forEach((pitch, index) => {
    if (pitch.accidental && !event.rest) {
      const accidental = new Accidental(pitch.accidental);
      sizeMusicGlyph(accidental, notationScale);
      note.addModifier(accidental, index);
    }
    pitch.lyrics.forEach((lyric) => {
      const annotation = new Annotation(lyric.text).setFont("Arial, Microsoft YaHei, sans-serif", 10 * contentScale)
        .setVerticalJustification("bottom").setJustification("center");
      annotation.setTextLine(Math.max(0, lyric.verse - 1));
      note.addModifier(annotation, index);
    });
  });
  for (let dot = 0; dot < event.dots; dot++) Dot.buildAndAttach([note], { all: true });
  // Dot.setNote inherits the already-scaled parent note font; scaling it a
  // second time would apply notationScale twice.
  for (const type of event.ornaments) {
    if (!ORNAMENT_CODES[type]) { diagnostic(diagnostics, `装饰音 ${type} 无法显示（${event.id}）`); continue; }
    try {
      const ornament = new Ornament(ORNAMENT_CODES[type]);
      sizeMusicGlyph(ornament, notationScale);
      note.addModifier(ornament, 0);
    }
    catch { diagnostic(diagnostics, `装饰音 ${type} 无法显示（${event.id}）`); }
  }
  if (event.fermata) {
    const articulation = new Articulation("a@a").setPosition(ModifierPosition.ABOVE);
    sizeMusicGlyph(articulation, notationScale);
    note.addModifier(articulation, 0);
  }
  if (event.arpeggio) {
    const stroke = new Stroke(Stroke.Type.ARPEGGIO_DIRECTIONLESS);
    sizeMusicGlyph(stroke, notationScale);
    note.addModifier(stroke, 0);
  }
  const grace = event.grace.map((pitch) => {
    const tiny = new GraceNote({ keys: [pitch.key], duration: "16", clef, slash: true });
    sizeMusicNote(tiny, notationScale);
    if (pitch.accidental) {
      const accidental = new Accidental(pitch.accidental);
      sizeMusicGlyph(accidental, notationScale);
      tiny.addModifier(accidental, 0);
    }
    return tiny;
  });
  if (grace.length) {
    const group = new GraceNoteGroup(grace, true).beamNotes();
    group.renderOptions.slurYShift = 7 * (notationScale - 1);
    for (const beam of (group as unknown as { beams: Beam[] }).beams) {
      beam.renderOptions.beamWidth *= notationScale;
      beam.renderOptions.partialBeamLength *= notationScale;
    }
    note.addModifier(group, 0);
  }
  return { note, grace };
}

function buildMeasure(model: StaffModel, measure: StaffMeasure, measureIndex: number, x: number, y: number,
  width: number, first: boolean, diagnostics: string[], notationScale: number, contentScale: number,
  context?: SVGContext, offsets?: number[]): MeasureDrawing {
  const voices: Voice[] = [];
  const events: DrawEvent[] = [];
  const beams: Beam[] = [];
  const tuplets: Tuplet[] = [];
  const formatter = new Formatter();
  const previous = model.measures[measureIndex - 1];
  const staves = model.staves.map((definition, rowIndex) => {
    const stave = new Stave(x, y + (offsets?.[rowIndex] ?? rowIndex * STAFF_DISTANCE * notationScale), width,
      { spacingBetweenLinesPx: 10 * notationScale });
    if (first) {
      stave.addClef(definition.clef);
      stave.getModifiers(undefined, "Clef").forEach(clef => sizeMusicGlyph(clef, notationScale));
      stave.addModifier(new ScaledKeySignature(measure.key, undefined, notationScale));
    } else if (previous && previous.key !== measure.key)
      stave.addModifier(new ScaledKeySignature(measure.key, previous.key, notationScale));
    if (!previous || previous.time.beats !== measure.time.beats || previous.time.beatType !== measure.time.beatType)
      stave.addModifier(new ScaledTimeSignature(`${measure.time.beats}/${measure.time.beatType}`, notationScale));
    stave.setBegBarType(measure.beginBar === "repeat" ? BarlineType.REPEAT_BEGIN : measure.beginBar === "double" ? BarlineType.DOUBLE : BarlineType.SINGLE);
    stave.setEndBarType(measure.endBar === "repeat" ? BarlineType.REPEAT_END : measure.endBar === "end" ? BarlineType.END : measure.endBar === "double" ? BarlineType.DOUBLE : BarlineType.SINGLE);
    if (rowIndex === 0) {
      if (measure.volta) {
        const begins = first || previous?.volta !== measure.volta;
        const ends = model.measures[measureIndex + 1]?.volta !== measure.volta;
        stave.setVoltaType(begins ? ends ? VoltaType.BEGIN_END : VoltaType.BEGIN : ends ? VoltaType.END : VoltaType.MID, `${measure.volta}.`, 6 * notationScale);
        stave.getModifiers(undefined, "Volta").forEach(volta => sizeMusicGlyph(volta, notationScale));
      }
    }
    if (context) stave.setContext(context);
    return stave;
  });
  Stave.formatBegModifiers(staves);
  staves.forEach((stave) => stave.setNoteStartX(Math.max(...staves.map((item) => item.getNoteStartX()))));
  model.staves.forEach((definition, staveIndex) => {
    const rowIndex = measure.rows.findIndex((row) => row.partIndex === definition.partIndex);
    const row = measure.rows[rowIndex];
    const grouped = new Map<string, Array<{ event: StaffEvent; index: number }>>();
    row?.events.forEach((event, index) => {
      const group = grouped.get(event.voice) ?? [];
      group.push({ event, index }); grouped.set(event.voice, group);
    });
    if (!grouped.size) grouped.set("empty", []);
    const staffVoices: Voice[] = [];
    let lane = 0;
    for (const group of grouped.values()) {
      const tickables: Tickable[] = [];
      const notes: StaveNote[] = [];
      const tupletGroups = new Map<string, { notes: StaveNote[]; actual: number; normal: number }>();
      let position = new Fraction(0);
      for (const item of group) {
        const event = item.event;
        const gap = event.position.minus(position);
        if (gap.numerator > 0) tickables.push(ghost(gap));
        const drawn = makeNote(event, definition.clef, diagnostics, grouped.size === 1, lane % 2 === 0, notationScale, contentScale);
        drawn.note.setStave(staves[staveIndex]);
        tickables.push(drawn.note); notes.push(drawn.note);
        events.push({ model: event, ...drawn, binding: { measure: measureIndex, row: rowIndex, event: item.index } });
        position = event.position.plus(event.actualDuration);
        if (event.tuplet) {
          const current = tupletGroups.get(event.tuplet.id) ?? { notes: [], actual: event.tuplet.actual, normal: event.tuplet.normal };
          current.notes.push(drawn.note); tupletGroups.set(event.tuplet.id, current);
        }
      }
      for (const group of tupletGroups.values()) {
        const tuplet = new Tuplet(group.notes, { numNotes: group.actual, notesOccupied: group.normal, bracketed: true });
        // VexFlow owns the numeral as a separate Element, created in Tuplet's
        // constructor. Scale that glyph while leaving prose annotations alone.
        sizeMusicGlyph((tuplet as unknown as { textElement: Element }).textElement, notationScale);
        tuplets.push(tuplet);
      }
      const tail = measure.duration.minus(position);
      if (tail.numerator > 0) tickables.push(ghost(tail));
      // Even a silent hand owns its complete temporal lane.
      if (!tickables.length) tickables.push(ghost(measure.duration.numerator > 0 ? measure.duration : new Fraction(1)));
      const voice = new Voice({ numBeats: measure.time.beats, beatValue: measure.time.beatType }).setMode(VoiceMode.SOFT).addTickables(tickables).setStave(staves[staveIndex]);
      staffVoices.push(voice); voices.push(voice);
      const generated = Beam.generateBeams(notes, {
        groups: [new VexFraction(measure.time.beatType === 8 && measure.time.beats % 3 === 0 ? 3 : 1, measure.time.beatType)],
        stemDirection: grouped.size > 1 ? lane % 2 === 0 ? Stem.UP : Stem.DOWN : undefined,
      });
      generated.forEach(beam => {
        beam.renderOptions.beamWidth *= notationScale;
        beam.renderOptions.partialBeamLength *= notationScale;
        beam.renderOptions.stemletExtension *= notationScale;
      });
      beams.push(...generated);
      lane++;
    }
    if (measure.keyChanges.length) {
      const keys: Tickable[] = [];
      let position = new Fraction(0);
      let activeKey = measure.key;
      for (const change of measure.keyChanges) {
        const gap = change.position.minus(position);
        if (gap.numerator > 0) keys.push(ghost(gap));
        keys.push(new ScaledKeySigNote(change.key, activeKey, notationScale).setStave(staves[staveIndex])); position = change.position;
        activeKey = change.key;
      }
      const tail = measure.duration.minus(position);
      if (tail.numerator > 0) keys.push(ghost(tail));
      const voice = new Voice({ numBeats: measure.time.beats, beatValue: measure.time.beatType }).setMode(VoiceMode.SOFT).addTickables(keys).setStave(staves[staveIndex]);
      staffVoices.push(voice); voices.push(voice);
    }
    formatter.joinVoices(staffVoices);
  });
  return { voices, staves, events, beams, tuplets, formatter };
}

function widthFor(model: StaffModel, measure: StaffMeasure, index: number, diagnostics: string[], notationScale: number, contentScale: number): number {
  const previous = model.measures[index - 1];
  const key = `${notationScale}|${contentScale}|${measure.signature}|${model.staves.map((stave) => stave.clef).join(",")}|${previous?.key ?? ""}|${previous?.time.beats ?? ""}/${previous?.time.beatType ?? ""}`;
  const cached = widthsCache.get(key);
  if (cached !== undefined) return cached;
  const drawing = buildMeasure(model, measure, index, 0, 0, CONTENT_WIDTH, true, diagnostics, notationScale, contentScale);
  const minimum = drawing.formatter.preCalculateMinTotalWidth(drawing.voices);
  const modifiers = Math.max(...drawing.staves.map((stave) => stave.getNoteStartX()));
  // Extra horizontal room prevents lyrics and accidentals colliding at barlines.
  return remember(widthsCache, key, Math.max(140 * notationScale, minimum + modifiers + 28 * notationScale), 512);
}

function systemGeometry(model: StaffModel, measures: number[], notationScale: number, contentScale: number): { offsets: number[]; height: number } {
  const extents = model.staves.map((stave) => {
    let count = 0;
    let top = 2 * notationScale; let bottom = 85 * notationScale;
    for (const index of measures) {
      const stacked = new Map<string, number>();
      for (const label of model.measures[index].labels.filter((label) => label.partIndex === stave.partIndex)) {
        const key = label.position.toString(); const level = stacked.get(key) ?? 0;
        top = Math.min(top, 2 * notationScale - (28 + level * 21) * contentScale); stacked.set(key, level + 1);
      }
      for (const row of model.measures[index].rows.filter((row) => row.partIndex === stave.partIndex)) for (const event of row.events) {
        for (const pitch of [...event.notes, ...event.grace]) {
          const match = /^([a-g])[#b]*\/(-?\d+)$/i.exec(pitch.key);
          if (match && !event.rest) {
            const degree = "cdefgab".indexOf(match[1].toLowerCase()) + Number(match[2]) * 7;
            const bottomLineDegree = stave.clef === "bass" ? 20 : 30;
            const y = (60 + (bottomLineDegree - degree) * 5) * notationScale;
            top = Math.min(top, y - 42 * notationScale - (event.ornaments.length || event.fermata ? 22 * notationScale : 0));
            bottom = Math.max(bottom, y + 30 * notationScale);
          }
          for (const lyric of pitch.lyrics) count = Math.max(count, lyric.verse);
        }
      }
    }
    return { top, bottom: Math.max(bottom, 85 * notationScale + count * 18 * contentScale) };
  });
  const offsets = [Math.max(0, 12 * notationScale - (extents[0]?.top ?? 2 * notationScale))];
  for (let index = 1; index < model.staves.length; index++)
    offsets.push(offsets[index - 1] + Math.max(STAFF_DISTANCE * notationScale, extents[index - 1].bottom - extents[index].top + 26 * notationScale));
  return { offsets, height: offsets[offsets.length - 1] + (extents[extents.length - 1]?.bottom ?? 85 * notationScale) + 25 * notationScale };
}

function endpoints(model: StaffModel): Map<string, Endpoint> {
  const cached = endpointCache.get(model);
  if (cached) return cached;
  const map = new Map<string, Endpoint>();
  model.measures.forEach((measure, index) => measure.rows.forEach((row) => {
    const staff = model.staves.findIndex((stave) => stave.partIndex === row.partIndex);
    const voices = [...new Set(row.events.map(event => event.voice))];
    const middleDegree = model.staves[staff].clef === "bass" ? 24 : 34;
    const degreeOf = (key: string): number | null => {
      const match = /^([a-g])[#b]*\/(-?\d+)$/i.exec(key);
      return match ? "cdefgab".indexOf(match[1].toLowerCase()) + Number(match[2]) * 7 : null;
    };
    const beamStems = new Map<StaffEvent, number>();
    if (voices.length === 1) {
      const beatLength = measure.time.beatType === 8 && measure.time.beats % 3 === 0
        ? 12 / measure.time.beatType : 4 / measure.time.beatType;
      const groups = new Map<number, StaffEvent[]>();
      for (const event of row.events) {
        if (event.rest || !["8", "16", "32", "64", "128"].includes(event.duration)) continue;
        const beat = Math.floor(event.position.toFloat() / beatLength + 1e-8);
        const group = groups.get(beat) ?? []; group.push(event); groups.set(beat, group);
      }
      for (const group of groups.values()) if (group.length > 1) {
        const sum = group.flatMap(event => event.notes.map(pitch => degreeOf(pitch.key)))
          .filter((degree): degree is number => degree !== null)
          .reduce((total, degree) => total + degree - middleDegree, 0);
        const direction = sum >= 0 ? Stem.DOWN : Stem.UP;
        group.forEach(event => beamStems.set(event, direction));
      }
    }
    row.events.forEach((event) => {
      const key = event.notes[0]?.key ?? (model.staves[staff].clef === "bass" ? "d/3" : "b/4");
      let stem = event.stemUp ? Stem.UP : Stem.DOWN;
      if (beamStems.has(event)) stem = beamStems.get(event)!;
      else if (voices.length === 1 && event.notes.length) {
        const degrees = event.notes.map(pitch => degreeOf(pitch.key)).filter((degree): degree is number => degree !== null);
        if (degrees.length) {
          stem = (Math.min(...degrees) + Math.max(...degrees)) / 2 < middleDegree ? Stem.UP : Stem.DOWN;
        }
      } else if (voices.length > 1) stem = voices.indexOf(event.voice) % 2 === 0 ? Stem.UP : Stem.DOWN;
      map.set(event.id, { measure: index, staff, key, stem });
      [...event.notes, ...event.grace].forEach((pitch) => map.set(pitch.id, { measure: index, staff, key: pitch.key, stem }));
    });
  }));
  endpointCache.set(model, map);
  return map;
}

function relevantLinks(model: StaffModel, indices: number[], links: Array<{ from: string; to: string }>): Array<{ from: string; to: string }> {
  const map = endpoints(model); const first = indices[0]; const last = indices[indices.length - 1];
  return links.filter((link) => {
    const from = map.get(link.from); const to = map.get(link.to);
    return from && to && from.measure <= last && to.measure >= first;
  });
}

function linkShape(model: StaffModel, indices: number[]): string {
  const map = endpoints(model);
  const shape = (links: Array<{ from: string; to: string }>) => relevantLinks(model, indices, links)
    .map((link) => [link, map.get(link.from), map.get(link.to)]);
  return JSON.stringify([shape(model.ties), shape(model.slurs)]);
}

function pathCurve(svg: SVGElement, from: Anchor, to: Anchor, slur: boolean, obstacles: CurveObstacle[], direction: number,
  fromId: string, toId: string, allowFlip: boolean, notationScale: number): void {
  const path = document.createElementNS(SVG_NS, "path");
  const x1 = from.right + (slur ? 3 : 1.5) * notationScale;
  const x2 = to.left - (slur ? 3 : 1.5) * notationScale;
  if (x2 <= x1 + 4 * notationScale) return;
  const span = x2 - x1;
  const nearby = obstacles.filter(item => item.staff === from.staff
    && item.right > x1 + 4 * notationScale && item.left < x2 - 4 * notationScale);
  const edge = (anchor: Anchor, side: number) => side < 0 ? anchor.top : anchor.bottom;
  const dFor = (side: number, lift: number): string => {
    const y1 = edge(from, side) + side * (slur ? 5 : 2) * notationScale;
    const y2 = edge(to, side) + side * (slur ? 5 : 2) * notationScale;
    if (lift <= 36 * notationScale || span < 70 * notationScale)
      return `M ${x1} ${y1} C ${x1 + span * .33} ${y1 + side * lift}, ${x2 - span * .33} ${y2 + side * lift}, ${x2} ${y2}`;
    // A shoulder rises close to each endpoint. A nearby leap then needs a
    // local bend, rather than a huge arch over the entire system.
    const shoulder = Math.min(30 * notationScale, span * .18);
    return `M ${x1} ${y1} C ${x1 + shoulder * .35} ${y1 + side * lift}, ${x1 + shoulder * .7} ${y1 + side * lift}, ${x1 + shoulder} ${y1 + side * lift}`
      + ` C ${x1 + span * .4} ${y1 + side * lift}, ${x2 - span * .4} ${y2 + side * lift}, ${x2 - shoulder} ${y2 + side * lift}`
      + ` C ${x2 - shoulder * .7} ${y2 + side * lift}, ${x2 - shoulder * .35} ${y2 + side * lift}, ${x2} ${y2}`;
  };
  path.setAttribute("fill", "none"); path.setAttribute("stroke", "none");
  path.setAttribute("data-staff-arc", slur ? "slur" : "tie");
  path.setAttribute("data-staff-arc-from", fromId);
  path.setAttribute("data-staff-arc-to", toId);
  svg.appendChild(path);
  const clear = (): boolean => {
    if (!nearby.length) return true;
    const length = path.getTotalLength();
    for (let along = 3 * notationScale; along < length - 3 * notationScale; along += .75 * notationScale) {
      const at = path.getPointAtLength(along);
      if (at.x <= x1 + 3 * notationScale || at.x >= x2 - 3 * notationScale) continue;
      if (nearby.some(item => at.x > item.left - 2 * notationScale && at.x < item.right + 2 * notationScale
        && at.y > item.top - 2 * notationScale && at.y < item.bottom + 2 * notationScale)) return false;
    }
    return true;
  };
  // The ordinary arc is about 30% shallower than the original fixed curve.
  // Larger rises are reserved for real obstacles and scale with the notation.
  const lifts = (slur ? [11, 16, 22, 29, 39, 51, 66] : [6.5, 10, 15, 22, 29, 39, 51, 66])
    .map(value => value * notationScale);
  let chosen = direction;
  let best: { d: string; side: number; cost: number } | null = null;
  for (const side of allowFlip ? [direction, -direction] : [direction]) {
    for (const lift of lifts) {
      path.setAttribute("d", dFor(side, lift));
      if (clear()) {
        const cost = lift + (side === direction ? 0 : 20 * notationScale);
        if (!best || cost < best.cost) best = { d: path.getAttribute("d")!, side, cost };
        break;
      }
    }
  }
  if (best) { path.setAttribute("d", best.d); chosen = best.side; }
  else path.setAttribute("d", dFor(direction, lifts[lifts.length - 1]));
  path.setAttribute("data-staff-arc-direction", chosen < 0 ? "above" : "below");
  // Fill a narrow ribbon around the collision-tested centerline. Its width
  // eases from a hairline at each endpoint to only slightly thicker midway.
  const total = path.getTotalLength();
  const count = Math.max(16, Math.min(96, Math.ceil(total / (7 * notationScale))));
  const upper: string[] = []; const lower: string[] = [];
  const maxWidth = (slur ? 1.55 : 1.25) * notationScale;
  for (let index = 0; index <= count; index++) {
    const distance = total * index / count;
    const point = path.getPointAtLength(distance);
    const a = path.getPointAtLength(Math.max(0, distance - notationScale));
    const b = path.getPointAtLength(Math.min(total, distance + notationScale));
    const dx = b.x - a.x; const dy = b.y - a.y;
    const magnitude = Math.hypot(dx, dy) || 1;
    const halfWidth = (0.3 + 0.7 * Math.sin(Math.PI * index / count)) * maxWidth / 2;
    const nx = -dy / magnitude * halfWidth; const ny = dx / magnitude * halfWidth;
    upper.push(`${point.x + nx} ${point.y + ny}`);
    lower.push(`${point.x - nx} ${point.y - ny}`);
  }
  const ink = document.createElementNS(SVG_NS, "path");
  ink.setAttribute("d", `M ${upper.join(" L ")} L ${lower.reverse().join(" L ")} Z`);
  ink.setAttribute("fill", "#111"); ink.setAttribute("stroke", "none");
  ink.setAttribute("data-staff-arc-ink", slur ? "slur" : "tie");
  ink.setAttribute("data-staff-arc-samples", String(count));
  svg.appendChild(ink);
}

function instrumentLabel(svg: SVGElement, text: string, baseline: number, rightEdge: number, contentScale: number): void {
  const lines: string[] = [];
  let line = "";
  const measure = svgText(svg, "", 0, 0, 13 * contentScale);
  for (const character of [...text]) {
    measure.textContent = line + character;
    if (line && measure.getComputedTextLength() > rightEdge - 8 * contentScale) { lines.push(line); line = character; }
    else line += character;
  }
  measure.remove();
  if (line) lines.push(line);
  lines.forEach((part, index) => {
    const label = svgText(svg, part, rightEdge, baseline + (index - (lines.length - 1) / 2) * 15 * contentScale, 13 * contentScale);
    label.setAttribute("text-anchor", "end");
    label.setAttribute("data-staff-prose", "instrument");
  });
}

function sizeMusicPenWeights(svg: SVGElement, notationScale: number): void {
  // VexFlow keeps these SVG strokes / filled one-pixel rules constant even
  // when glyph fonts and stave spacing change. Size the ink independently of
  // the page prose; this does not transform the notes or system coordinates.
  svg.querySelectorAll<SVGPathElement>("g.vf-stave path").forEach(path =>
    path.setAttribute("stroke-width", String(notationScale)));
  svg.querySelectorAll<SVGPathElement>("g.vf-stem path").forEach(path =>
    path.setAttribute("stroke-width", String((Number(path.getAttribute("stroke-width")) || 1.5) * notationScale)));
  svg.querySelectorAll<SVGRectElement>("g.vf-stavebarline rect, g.vf-tuplet rect").forEach(rect => {
    const width = Number(rect.getAttribute("width"));
    const height = Number(rect.getAttribute("height"));
    if (width > 0 && width <= 3) {
      const thinner = width * notationScale;
      rect.setAttribute("x", String(Number(rect.getAttribute("x")) + (width - thinner) / 2));
      rect.setAttribute("width", String(thinner));
    }
    if (height > 0 && height <= 3) {
      const thinner = height * notationScale;
      rect.setAttribute("y", String(Number(rect.getAttribute("y")) + (height - thinner) / 2));
      rect.setAttribute("height", String(thinner));
    }
  });
}

function renderSystem(model: StaffModel, layout: SystemLayout, diagnostics: string[]): SystemTemplate {
  const cached = templatesCache.get(layout.key);
  if (cached) return cached;
  const host = document.createElement("div");
  const renderer = new Renderer(host, Renderer.Backends.SVG);
  const naturalPageWidth = MARGIN * 2 + CONTENT_WIDTH / layout.scale;
  const naturalHeight = layout.height / layout.scale;
  renderer.resize(naturalPageWidth, naturalHeight);
  const context = renderer.getContext() as SVGContext;
  const svg = context.svg;
  svg.setAttribute("viewBox", `0 0 ${naturalPageWidth} ${naturalHeight}`);
  const bindings: Binding[] = [];
  const anchors = new Map<string, Anchor>();
  const obstacles: CurveObstacle[] = [];
  const hits: SVGRectElement[] = [];
  const leftEdges: number[] = [];
  withMountedSvg(host, () => {
    let x = MARGIN;
    layout.measures.forEach((measureIndex, column) => {
      const measure = model.measures[measureIndex];
      const drawing = buildMeasure(model, measure, measureIndex, x, 20 * layout.musicScale, layout.widths[column], column === 0,
        diagnostics, layout.musicScale, layout.contentScale, context, layout.offsets);
      drawing.staves.forEach((stave) => stave.draw());
      if (column === 0) drawing.staves.forEach((stave, index) => {
        leftEdges[index] = stave.getNoteStartX() - 25 * layout.musicScale;
      });
      if (column === 0 && model.score.piano && drawing.staves.length === 2) {
        const first = model.staves[0].label;
        const second = model.staves[1].label;
        const shared = model.score.instrumentName || (first === second ? first : "钢琴");
        const middle = (drawing.staves[0].getYForLine(2) + drawing.staves[1].getYForLine(2)) / 2 + 4 * layout.contentScale;
        // Keep the physical label gutter inside the fixed page margin. At 200%,
        // scaling the gutter too would leave less than one full CJK glyph.
        if (shared) instrumentLabel(svg, shared, middle, MARGIN - 24, layout.contentScale);
      } else if (column === 0 && model.staves[0]?.label) {
        instrumentLabel(svg, model.staves[0].label, drawing.staves[0].getYForLine(2) + 4 * layout.contentScale,
          MARGIN - 8, layout.contentScale);
      }
      if (column === 0 && drawing.staves.length > 1) {
        const beforeBrace = new Set(svg.children);
        new StaveConnector(drawing.staves[0], drawing.staves[drawing.staves.length - 1]).setType(model.score.piano ? "brace" : "bracket").setContext(context).draw();
        for (const element of [...svg.children]) if (!beforeBrace.has(element)) element.setAttribute("data-staff-brace", "");
        new StaveConnector(drawing.staves[0], drawing.staves[drawing.staves.length - 1]).setType("singleLeft").setContext(context).draw();
      }
      const noteStart = Math.max(...drawing.staves.map((stave) => stave.getNoteStartX()));
      const noteEnd = Math.min(...drawing.staves.map((stave) => stave.getNoteEndX()));
      drawing.formatter.format(drawing.voices, Math.max(20, noteEnd - noteStart - 12), { context });
      drawing.voices.forEach((voice) => voice.draw(context));
      drawing.beams.forEach((beam) => beam.setContext(context).draw());
      drawing.tuplets.forEach((tuplet) => tuplet.setContext(context).draw());
      for (const drawn of drawing.events) {
        if (drawn.model.rest || !drawn.note.hasStem()) continue;
        const staff = model.staves.findIndex((definition) => definition.partIndex === measure.rows[drawn.binding.row].partIndex);
        const x = drawn.note.getStemX(); const extents = drawn.note.getStemExtents();
        obstacles.push({ left: x - 1.5, right: x + 1.5,
          top: Math.min(extents.topY, extents.baseY), bottom: Math.max(extents.topY, extents.baseY), staff });
      }
      for (const beam of drawing.beams) {
        const element = beam.getSVGElement() as SVGGraphicsElement | undefined;
        const firstNote = beam.getNotes()[0];
        if (!element || !firstNote) continue;
        const staff = drawing.staves.findIndex(stave => stave === firstNote.checkStave());
        // The beam group also contains long stems; take each beam polygon's
        // ink box and let the stem extents above handle stems separately.
        for (const polygon of element.querySelectorAll<SVGGraphicsElement>(":scope > path")) {
          const box = polygon.getBBox();
          obstacles.push({ left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height, staff });
        }
      }
      for (const drawn of drawing.events) {
        const staff = model.staves.findIndex((definition) => definition.partIndex === measure.rows[drawn.binding.row].partIndex);
        const addPitch = (pitch: StaffPitch, note: StaveNote, pitchIndex: number, grace: boolean, headIndex: number) => {
          const headGroup = note.noteHeads[headIndex]?.getSVGElement();
          // NoteHead's group also contains lyric/accidental modifier groups. The
          // direct text child is the actual pitch glyph, independently of those.
          const glyph = headGroup?.querySelector<SVGGraphicsElement>(":scope > text");
          if (!glyph) { diagnostic(diagnostics, `未找到音符图形：${pitch.id}`); return; }
          const metrics = note.noteHeads[headIndex].getTextMetrics();
          const baseline = Number(glyph.getAttribute("y"));
          const origin = Number(glyph.getAttribute("x"));
          const anchor: Anchor = {
            x: origin + (metrics.actualBoundingBoxRight - metrics.actualBoundingBoxLeft) / 2,
            y: note.getYs()[headIndex],
            left: origin - metrics.actualBoundingBoxLeft,
            right: origin + metrics.actualBoundingBoxRight,
            top: baseline - metrics.actualBoundingBoxAscent,
            bottom: baseline + metrics.actualBoundingBoxDescent,
            staff, stem: note.getStemDirection(),
          };
          anchors.set(pitch.id, anchor);
          if (!drawn.model.rest) obstacles.push(anchor);
          glyph.setAttribute("data-staff-pitch-id", pitch.id);
          if (!drawn.model.sourceChord) return;
          const bindingIndex = bindings.length;
          bindings.push({ ...drawn.binding, pitch: pitchIndex, grace });
          glyph.setAttribute("data-staff-glyph", String(bindingIndex));
          hits.push(noteHitBox(glyph, svg, bindingIndex, {
            x: origin - metrics.actualBoundingBoxLeft,
            y: baseline - metrics.actualBoundingBoxAscent,
            width: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
            height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
          }));
        };
        drawn.model.notes.forEach((pitch, index) => addPitch(pitch, drawn.note, index, false, drawn.model.rest ? 0 : index));
        drawn.model.grace.forEach((pitch, index) => addPitch(pitch, drawn.grace[index], index, true, 0));
        const heads = drawn.model.notes.map((pitch) => anchors.get(pitch.id)).filter((value): value is Anchor => Boolean(value));
        if (heads.length) anchors.set(drawn.model.id, {
          x: (Math.min(...heads.map(head => head.left)) + Math.max(...heads.map(head => head.right))) / 2,
          y: (Math.min(...heads.map(head => head.top)) + Math.max(...heads.map(head => head.bottom))) / 2,
          left: Math.min(...heads.map(head => head.left)), right: Math.max(...heads.map(head => head.right)),
          top: Math.min(...heads.map(head => head.top)), bottom: Math.max(...heads.map(head => head.bottom)),
          staff, stem: drawn.note.getStemDirection(),
        });
      }
      const labelLevels = new Map<string, number>();
      for (const label of measure.labels) {
        const candidates = drawing.events.filter((event) => measure.rows[event.binding.row].partIndex === label.partIndex)
          .sort((a, b) => a.model.position.compareTo(b.model.position));
        const position = label.position.toFloat();
        const before = [...candidates].reverse().find((event) => event.model.position.toFloat() <= position);
        const after = candidates.find((event) => event.model.position.toFloat() > position);
        let anchor = before?.note.getNoteHeadBeginX() ?? noteStart;
        if (after) {
          const leftTick = before?.model.position.toFloat() ?? 0;
          const leftX = before?.note.getNoteHeadBeginX() ?? noteStart;
          const span = after.model.position.toFloat() - leftTick;
          anchor = span > 0 ? leftX + (after.note.getNoteHeadBeginX() - leftX) * (position - leftTick) / span : leftX;
        } else if (position >= measure.duration.toFloat()) anchor = noteEnd - 6;
        const staff = Math.max(0, model.staves.findIndex((definition) => definition.partIndex === label.partIndex));
        const slotKey = `${staff}:${label.position.toString()}`;
        const level = labelLevels.get(slotKey) ?? 0; labelLevels.set(slotKey, level + 1);
        const baseline = 20 * layout.musicScale + layout.offsets[staff] - (28 + level * 21) * layout.contentScale;
        if (label.symbol) {
          const mark = svgText(svg, label.symbol === "segno" ? VexFlow.Glyphs.segno : VexFlow.Glyphs.coda, anchor, baseline, 25 * layout.musicScale);
          mark.setAttribute("font-family", "Bravura"); mark.setAttribute("data-staff-navigation", label.symbol);
          anchor += mark.getComputedTextLength() + 5;
        }
        if (label.text) {
          const text = svgText(svg, label.text, anchor, baseline, 14 * layout.contentScale);
          text.setAttribute("data-staff-prose", "annotation");
          if (position >= measure.duration.toFloat()) text.setAttribute("text-anchor", "end");
        }
      }
      x += layout.widths[column];
    });
    for (const label of svg.querySelectorAll<SVGGraphicsElement>("[data-staff-prose]")) {
      const box = label.getBBox();
      obstacles.push({ left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height, staff: 0 });
    }
    for (const [links, slur] of [[model.ties, false], [model.slurs, true]] as const) {
      for (const link of relevantLinks(model, layout.measures, links)) {
        const from = anchors.get(link.from); const to = anchors.get(link.to);
        const source = endpoints(model).get(link.from);
        const target = endpoints(model).get(link.to);
        const direction = from && to ? from.stem : source?.stem ?? from?.stem ?? to?.stem ?? target?.stem ?? Stem.UP;
        if (from && to) pathCurve(svg, from, to, slur, obstacles, direction, link.from, link.to, true, layout.musicScale);
        else if (from) pathCurve(svg, from, { ...from, x: naturalPageWidth - MARGIN, left: naturalPageWidth - MARGIN, right: naturalPageWidth - MARGIN },
          slur, obstacles, direction, link.from, link.to, false, layout.musicScale);
        else if (to) {
          const left = leftEdges[to.staff] ?? MARGIN + 12;
          pathCurve(svg, { ...to, x: left, left, right: left }, to, slur, obstacles, direction, link.from, link.to, false,
            layout.musicScale);
        }
        else {
          const endpoint = endpoints(model).get(link.from)!;
          const match = /^([a-g])[#b]*\/(-?\d+)$/i.exec(endpoint.key);
          if (match) {
            const degree = "cdefgab".indexOf(match[1].toLowerCase()) + Number(match[2]) * 7;
            const bottomLineDegree = model.staves[endpoint.staff].clef === "bass" ? 20 : 30;
            const y = (60 + (bottomLineDegree - degree) * 5) * layout.musicScale + layout.offsets[endpoint.staff];
            const left = leftEdges[endpoint.staff] ?? MARGIN + 12;
            const anchor: Anchor = { staff: endpoint.staff, x: left, left, right: left, y,
              top: y - 4, bottom: y + 4, stem: endpoint.stem };
            const right = naturalPageWidth - MARGIN;
            pathCurve(svg, anchor, { ...anchor, x: right, left: right, right }, slur, obstacles, direction, link.from, link.to, false,
              layout.musicScale);
          }
        }
      }
    }
    sizeMusicPenWeights(svg, layout.musicScale);
    partitionUnisonHits(hits);
  });
  return remember(templatesCache, layout.key, { svg, bindings }, 128);
}

class PreviewDocument implements StaffPreviewDocument {
  readonly revision: number;
  readonly pageWidth = PAGE_WIDTH;
  readonly pageHeight = PAGE_HEIGHT;
  readonly pageCount: number;
  readonly diagnostics: string[];
  private model: StaffModel | null;
  private readonly layouts: SystemLayout[];
  private readonly contentScale: number;
  private readonly refPages = new Map<string, number>();
  private readonly chordPages = new Map<Chord, Set<number>>();
  constructor(model: StaffModel, layouts: SystemLayout[], diagnostics: string[], contentScale: number) {
    this.model = model; this.revision = model.revision; this.layouts = layouts; this.diagnostics = diagnostics;
    this.contentScale = contentScale;
    this.pageCount = Math.max(1, layouts.length ? layouts[layouts.length - 1].page + 1 : 1);
    for (const layout of layouts) for (const index of layout.measures) for (const row of model.measures[index].rows) for (const event of row.events) {
      if (event.sourceChord) {
        const pages = this.chordPages.get(event.sourceChord) ?? new Set<number>();
        pages.add(layout.page); this.chordPages.set(event.sourceChord, pages);
      }
      for (const pitch of [...event.notes, ...event.grace]) if (pitch.ref && !this.refPages.has(pitch.ref.id)) this.refPages.set(pitch.ref.id, layout.page);
    }
  }
  pageForRef(ref: StaffNoteRef): number | null { return ref.revision === this.revision ? this.refPages.get(ref.id) ?? null : null; }
  pagesForChords(chords: readonly Chord[]): number[] {
    const pages = new Set<number>();
    for (const chord of chords) for (const page of this.chordPages.get(chord) ?? []) pages.add(page);
    return [...pages].sort((a, b) => a - b);
  }
  renderPage(index: number): StaffRenderedPage {
    if (!this.model) throw new Error("五线谱文档已释放");
    if (index < 0 || index >= this.pageCount) throw new RangeError("五线谱页码越界");
    const model = this.model;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}`);
    svg.setAttribute("width", String(PAGE_WIDTH)); svg.setAttribute("height", String(PAGE_HEIGHT));
    svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `${model.title || "五线谱"} 第 ${index + 1} 页`);
    svg.style.background = "white";
    const background = document.createElementNS(SVG_NS, "rect");
    background.setAttribute("width", String(PAGE_WIDTH)); background.setAttribute("height", String(PAGE_HEIGHT)); background.setAttribute("fill", "white");
    svg.appendChild(background);
    if (index === 0) {
      const title = svgText(svg, model.title, PAGE_WIDTH / 2, 28 + 24 * this.contentScale, 23 * this.contentScale);
      title.setAttribute("text-anchor", "middle");
      const subtitle = svgText(svg, model.subtitle, PAGE_WIDTH / 2, 28 + 48 * this.contentScale, 13 * this.contentScale);
      subtitle.setAttribute("text-anchor", "middle");
      model.credits.forEach((credit, creditIndex) => {
        const node = svgText(svg, credit, PAGE_WIDTH - MARGIN, 28 + (70 + creditIndex * 17) * this.contentScale,
          12 * this.contentScale);
        node.setAttribute("text-anchor", "end");
      });
    }
    const notes: StaffRenderedNote[] = [];
    for (const layout of this.layouts.filter((system) => system.page === index)) {
      const template = renderSystem(model, layout, this.diagnostics);
      const group = document.createElementNS(SVG_NS, "g");
      group.setAttribute("transform", `translate(${MARGIN * (1 - layout.scale)} ${layout.y}) scale(${layout.scale})`);
      for (const attribute of [...template.svg.attributes]) {
        if (!["width", "height", "viewBox", "pointer-events"].includes(attribute.name)) group.setAttribute(attribute.name, attribute.value);
      }
      // Clone children, preserving notehead-only geometry and independent hit targets.
      for (const child of [...template.svg.childNodes]) group.appendChild(child.cloneNode(true));
      // Prose is printed at A4 page size, independent of emergency music
      // compression for an overfull measure.
      for (const text of [...group.querySelectorAll<SVGTextElement>("[data-staff-prose]")]) {
        const x = Number(text.getAttribute("x")); const y = Number(text.getAttribute("y"));
        text.setAttribute("x", String(MARGIN * (1 - layout.scale) + x * layout.scale));
        text.setAttribute("y", String(layout.y + y * layout.scale));
        text.setAttribute("data-staff-system", String(layout.measures[0]));
        svg.appendChild(text);
      }
      template.bindings.forEach((binding, bindingIndex) => {
        const event = model.measures[binding.measure].rows[binding.row].events[binding.event];
        const pitch = (binding.grace ? event.grace : event.notes)[binding.pitch];
        const element = group.querySelector<SVGElement>(`[data-staff-glyph="${bindingIndex}"]`);
        const hitElement = group.querySelector<SVGElement>(`[data-staff-hit="${bindingIndex}"]`);
        if (pitch.ref && event.sourceChord && element && hitElement) {
          hitElement.setAttribute("data-staff-ref", pitch.ref.id);
          hitElement.setAttribute("aria-label", `${pitch.key}，第 ${binding.measure + 1} 小节`);
          notes.push({ ref: pitch.ref, chord: event.sourceChord, element, hitElement });
        }
      });
      svg.appendChild(group);
    }
    const number = svgText(svg, String(index + 1), PAGE_WIDTH / 2, PAGE_HEIGHT - 27 * this.contentScale,
      11 * this.contentScale);
    number.setAttribute("text-anchor", "middle");
    return { svg, notes };
  }
  dispose(): void { this.model = null; this.refPages.clear(); this.chordPages.clear(); }
}

export async function prepareStaffPreview(snapshot: StaffPreviewSnapshot, _previous?: StaffPreviewDocument, signal?: AbortSignal): Promise<StaffPreviewDocument> {
  abortStaffPreview(signal);
  await loadStaffFonts(); abortStaffPreview(signal);
  const model = buildStaffModel(snapshot);
  const notationScale = Math.max(0.5, Math.min(1.5, snapshot.engravingStyle?.notationScale ?? A4_NOTATION_SCALE));
  const contentScale = Math.max(0.25, Math.min(2, snapshot.engravingStyle?.contentScale ?? 1));
  const musicScale = notationScale * contentScale;
  const diagnostics = [...model.diagnostics];
  for (const measure of model.measures) for (const row of measure.rows) for (const event of row.events)
    for (const type of event.ornaments) if (!ORNAMENT_CODES[type]) diagnostic(diagnostics, `装饰音 ${type} 无法显示（${event.id}）`);
  const widths: number[] = [];
  for (let index = 0; index < model.measures.length; index++) {
    widths.push(widthFor(model, model.measures[index], index, diagnostics, musicScale, contentScale));
    if (index % 4 === 3) await yieldStaffPreview(signal);
  }
  const systems: SystemLayout[] = [];
  let page = 0; let y = MARGIN + (55 + model.credits.length * 17) * contentScale;
  let current: number[] = []; let total = 0;
  const flush = () => {
    if (!current.length) return;
    const { offsets, height: naturalHeight } = systemGeometry(model, current, musicScale, contentScale);
    const scale = Math.min(1, CONTENT_WIDTH / total);
    const height = naturalHeight * scale;
    const contentBottom = Math.min(PAGE_HEIGHT - MARGIN, PAGE_HEIGHT - 48 * contentScale);
    if (y + height > contentBottom && systems.length) { page++; y = MARGIN; }
    const ratio = CONTENT_WIDTH / total;
    const allocated = current.map((index) => widths[index] * ratio / scale);
    const previous = model.measures[current[0] - 1];
    const next = model.measures[current[current.length - 1] + 1];
    const boundaries = { previous: previous ? { key: previous.key, time: previous.time, volta: previous.volta } : null, nextVolta: next?.volta ?? null };
    const key = JSON.stringify([current, allocated.map((width) => Math.round(width * 100) / 100), scale,
      musicScale, contentScale, offsets, model.staves, current.map((index) => model.measures[index].signature),
      boundaries, linkShape(model, current), model.score.piano, current[0] === 0 ? model.score.tempoBpm : null]);
    systems.push({ measures: current, widths: allocated, offsets, scale, musicScale, contentScale, y, height, page, key });
    y += height; current = []; total = 0;
  };
  model.measures.forEach((measure, index) => {
    if (current.length && (measure.newPage || measure.newSystem || total + widths[index] > CONTENT_WIDTH)) flush();
    if (measure.newPage && systems.length && y !== MARGIN) { page++; y = MARGIN; }
    if (widths[index] > CONTENT_WIDTH) diagnostics.push(`第 ${index + 1} 小节音符过密；已单独排一行并缩小至 ${Math.round(CONTENT_WIDTH / widths[index] * 100)}%，完整显示全部音符。`);
    current.push(index); total += widths[index];
  });
  flush(); abortStaffPreview(signal);
  return new PreviewDocument(model, systems, diagnostics, contentScale);
}
