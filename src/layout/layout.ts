// Ported from mp/layout/layout.kt. Pure model + geometry; SVG emission lives in
// painter.ts. Skija Path/Canvas/Font replaced by GraphicPath command lists,
// the common geom types, and the Font abstraction (measurement via SVG/canvas).

import { Fraction } from "../common/fraction";
import { Point, Rect, Matrix33, newMatrix, Colors } from "../common/geom";
import { pathTightBounds } from "../common/measure";
import { Font } from "./font";
import { normalizeEngravingStyle, type EngravingStyle } from "./style";
import {
  buildMeasureLayout,
  packMeasureSystems,
  type MeasureLayout as HorizontalMeasureLayout,
  type RhythmColumnKind,
  type RhythmItem,
} from "./horizontal";
import { MetaData, GlyphCodes } from "../smufl/smufl";
import * as S from "../score/score";

function getOrNull<T>(arr: T[], i: number): T | null {
  return i >= 0 && i < arr.length ? arr[i] : null;
}

function continuationColor(color: number, continuation: boolean): number {
  if (!continuation) return color;
  const alpha = (color >>> 24) & 0xff;
  const fade = (channel: number) => Math.round(channel + (255 - channel) * 0.58);
  const red = fade((color >>> 16) & 0xff);
  const green = fade((color >>> 8) & 0xff);
  const blue = fade(color & 0xff);
  return ((alpha << 24) | (red << 16) | (green << 8) | blue) >>> 0;
}

function fadeTiedContinuation(chord: S.Chord, options: LayoutOptions, note?: S.Note): boolean {
  if (!options.engravingStyle.tieContinuationGray) return false;
  if (chord.transparentContinuation) return true;
  if (note) return note.tieEnd && note.tiePrev !== null;
  return chord.notes.some((item) => item.tieEnd && item.tiePrev !== null);
}

export function pointRotate(p: Point, cos: number, sin: number): Point {
  return p.rotate(cos, sin);
}

// ---------------- PageItem hierarchy ----------------

export class PageItem {
  parent: PageItem | null = null;
  children: PageItem[] = [];
  _width = 0;
  _height = 0;
  matrix: Matrix33 = newMatrix();
  classes = new Set<string>();
  data: unknown = null;
  _selected = false;
  selectable = false;
  /** Decorative annotations may draw outside their owner without changing flow/pagination. */
  affectsLayout = true;

  get selected(): boolean {
    return this._selected;
  }
  set selected(v: boolean) {
    this._selected = v;
  }

  get bound(): Rect {
    return new Rect(0, 0, this.width, this.height);
  }

  changeColor(clr: number): void {
    for (const it of this.children) it.changeColor(clr);
    if (this instanceof TextFrame) {
      this.color = clr;
    } else if (this instanceof GraphicLine) {
      this.strokeColor = clr;
    } else if (this instanceof GraphicPath) {
      if (this.stroke) this.strokeColor = clr;
      if (this.fill) this.fillColor = clr;
    }
  }

  pos(root: PageItem | null): Point {
    let loc = new Point(this.x, this.y);
    if (this.parent === root) return loc;
    const pp = this.parent!.pos(root);
    loc = loc.offset(pp);
    return loc;
  }

  get x(): number {
    return this.matrix.translateX;
  }
  set x(v: number) {
    this.matrix.translateX = v;
  }
  get y(): number {
    return this.matrix.translateY;
  }
  set y(v: number) {
    this.matrix.translateY = v;
  }
  get width(): number {
    return this._width;
  }
  set width(v: number) {
    this._width = v;
  }
  get height(): number {
    return this._height;
  }
  set height(v: number) {
    this._height = v;
  }

  get childrenBound(): Rect {
    let r = new Rect();
    for (const ch of this.children) {
      if (!ch.affectsLayout) continue;
      let rr = ch instanceof Group ? ch.childrenBound : ch.bound;
      rr = rr.offset(ch.x, ch.y);
      r = r.union(rr);
    }
    return r;
  }

  update(): void {
    let r = new Rect();
    for (const ch of this.children) {
      ch.update();
      if (!ch.affectsLayout) continue;
      let rr1 = ch.bound;
      rr1 = rr1.offset(ch.x, ch.y);
      r = r.union(rr1);
    }
    this.width = r.right;
    this.height = r.bottom;
  }

  add(pageItem: PageItem): void {
    this.children.push(pageItem);
    pageItem.parent = this;
  }
}

export type PathSeg = { op: "M" | "L" | "C" | "Z"; pts: number[] };

export class GraphicPath extends PageItem {
  segs: PathSeg[] = [];
  strokeWidth = 1;
  strokeColor = 0;
  fillColor = 0;
  stroke = false;
  fill = false;

  get d(): string {
    let s = "";
    for (const seg of this.segs) {
      if (seg.op === "Z") s += "Z";
      else s += `${seg.op}${seg.pts.join(" ")} `;
    }
    return s.trim();
  }

  override update(): void {
    const bnd = this.computeTightBounds();
    this.width = bnd.width;
    this.height = bnd.height;
    this.x += bnd.left;
    this.y += bnd.top;
    this.offset(-bnd.left, -bnd.top);
  }

  offset(dx: number, dy: number): void {
    for (const seg of this.segs) {
      for (let i = 0; i < seg.pts.length; i += 2) {
        seg.pts[i] += dx;
        seg.pts[i + 1] += dy;
      }
    }
  }
  moveTo(x: number | Point, y = 0): void {
    if (x instanceof Point) this.segs.push({ op: "M", pts: [x.x, x.y] });
    else this.segs.push({ op: "M", pts: [x, y] });
  }
  lineTo(x: number | Point, y = 0): void {
    if (x instanceof Point) this.segs.push({ op: "L", pts: [x.x, x.y] });
    else this.segs.push({ op: "L", pts: [x, y] });
  }
  cubicTo(p1: Point, p2: Point, p3: Point): void;
  cubicTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void;
  cubicTo(
    a: number | Point,
    b?: number | Point,
    c?: number | Point,
    d?: number,
    e?: number,
    f?: number,
  ): void {
    if (a instanceof Point) {
      const p1 = a, p2 = b as Point, p3 = c as Point;
      this.segs.push({ op: "C", pts: [p1.x, p1.y, p2.x, p2.y, p3.x, p3.y] });
    } else {
      this.segs.push({ op: "C", pts: [a, b as number, c as number, d!, e!, f!] });
    }
  }
  computeTightBounds(): Rect {
    if (this.segs.length === 0) return new Rect();
    return pathTightBounds(this.d);
  }
  close(): void {
    this.segs.push({ op: "Z", pts: [] });
  }
}

export class Group extends PageItem {
  get minY(): number | null {
    const children = this.children.filter((child) => child.affectsLayout);
    if (children.length === 0) return null;
    return children.reduce((m, c) => (c.y < m.y ? c : m)).y;
  }
  get minX(): number | null {
    const children = this.children.filter((child) => child.affectsLayout);
    if (children.length === 0) return null;
    return children.reduce((m, c) => (c.x < m.x ? c : m)).x;
  }
  get maxX(): number | null {
    const children = this.children.filter((child) => child.affectsLayout);
    if (children.length === 0) return null;
    const it = children.reduce((m, c) => (c.x + c.width > m.x + m.width ? c : m));
    return it.x + it.width;
  }
  get maxY(): number | null {
    const children = this.children.filter((child) => child.affectsLayout);
    if (children.length === 0) return null;
    const it = children.reduce((m, c) => (c.y + c.height > m.y + m.height ? c : m));
    return it.y + it.height;
  }

  normalizeX(): void {
    if (this.children.length === 0) return;
    const mx = this.minX;
    if (mx === null) return;
    for (const it of this.children) it.x -= mx;
    this.x += mx;
  }
  normalizeY(): void {
    if (this.children.length === 0) return;
    const mx = this.minY;
    if (mx === null) return;
    for (const it of this.children) it.y -= mx;
    this.y += mx;
  }

  override update(): void {
    for (const it of this.children) it.update();
    const bnd = this.childrenBound;
    for (const it of this.children) {
      it.x -= bnd.left;
      it.y -= bnd.top;
    }
    this.x += bnd.left;
    this.y += bnd.top;
    this.width = bnd.width;
    this.height = bnd.height;
  }
}

export class TextFrame extends PageItem {
  text = "";
  color = Colors.black;
  strokeColor = Colors.black;
  strokeWidth = 0;
  nonScalingStroke = false;
  font!: Font;
  previous: TextFrame | null = null;
  next: TextFrame | null = null;

  measureText(beg = 0, len = -1): number {
    const str = len < 0 ? this.text.substring(beg) : this.text.substring(beg, beg + len);
    return this.font.measureText(str);
  }

  override get bound(): Rect {
    const fm = this.font.metrics;
    return new Rect(0, fm.ascent, this.width, fm.descent);
  }

  override update(): void {
    this.width = this.measureText();
    this.height = this.font.size;
  }
}

export class GraphicLine extends PageItem {
  p0 = new Point();
  p1 = new Point();
  strokeWidth = 1;
  strokeColor = 0;

  override update(): void {
    this.y += this.p0.y;
    this.x += this.p0.x;
    this.p1 = this.p1.offset(-this.p0.x, -this.p0.y);
    this.p0 = new Point(0, 0);
    this.width = Math.abs(this.p1.x);
    this.height = Math.abs(this.p1.y);
    if (this.p0.x === this.p1.x) this.width = this.strokeWidth;
    if (this.p0.y === this.p1.y) this.height = this.strokeWidth;
  }
}

export class SmuflText extends TextFrame {
  asPath = false;
  meta: MetaData;
  constructor(options: LayoutOptions) {
    super();
    this.meta = options.smuflMeta;
    this.font = options.smuflFont;
  }
  override get bound(): Rect {
    const first = this.text[0];
    const box = this.meta.getBBox(first);
    if (!box) throw new Error("no smufl bbox");
    const dy1 = (box.bBoxNE[1] * this.font.size) / 4;
    const dy2 = (box.bBoxSW[1] * this.font.size) / 4;
    const l = (box.bBoxSW[0] * this.font.size) / 4;
    const r = (box.bBoxNE[0] * this.font.size) / 4;
    return new Rect(l, dy2, r, dy1);
  }
}

export class JpOctaveDot extends GraphicPath {
  owner: JpNumber | null = null;

  constructor(radius: number, color: number) {
    super();
    this.selectable = true;
    this.fill = true;
    this.fillColor = color;
    const d = radius * 2;
    const k = radius * 0.5522847498;
    this.moveTo(d, radius);
    this.cubicTo(d, radius + k, radius + k, d, radius, d);
    this.cubicTo(radius - k, d, 0, radius + k, 0, radius);
    this.cubicTo(0, radius - k, radius - k, 0, radius, 0);
    this.cubicTo(radius + k, 0, d, radius - k, d, radius);
    this.close();
  }
}

export class JpNumber extends TextFrame {
  constructor() {
    super();
    this.selectable = true;
  }
  get left(): number {
    return this.measureText(0, 1) / 2;
  }
  get right(): number {
    return this.measureText(0, 1) / 2 + this.measureText(1);
  }
  get cx(): number {
    return this.measureText(0, 1) / 2;
  }
  get numberPos(): number {
    let end = this.text.length;
    while (end > 0 && this.text[end - 1] === "·") end--;
    return this.measureText(0, end);
  }
  override get bound(): Rect {
    const bnd = LayoutOptions.charBound(this.font, this.text[0]);
    return new Rect(0, bnd.top, this.width, bnd.bottom);
  }
}

export class Lyric extends TextFrame {
  _widths = [0, 0, 0];
  constructor() {
    super();
    this.selectable = true;
  }
  get left(): number {
    return this._widths[0] + this._widths[1] / 2;
  }
  get right(): number {
    return this._widths[1] / 2 + this._widths[2];
  }
  override update(): void {
    let sl = "", sc = "", sr = "";
    if (this.text.length === 1) {
      sc = this.text;
    } else {
      const punct = "1234567890.,;'\"!?。：，；！？“”｡､";
      let pos = 0;
      while (pos < this.text.length) {
        const c = this.text[pos];
        if (punct.includes(c)) sl += c;
        else break;
        pos++;
      }
      while (pos < this.text.length) {
        const c = this.text[pos];
        if (!punct.includes(c)) sc += c;
        else break;
        pos++;
      }
      sr = this.text.substring(pos);
    }
    this._widths[0] = this.measureText(0, sl.length);
    this._widths[1] = this.measureText(sl.length, sc.length);
    this._widths[2] = this.measureText(sl.length + sc.length, sr.length);
    this.width = this._widths[0] + this._widths[1] + this._widths[2];
    this.height = this.font.size;
  }
}

export abstract class SlurTieBase extends Group {
  static calcSlurPoints(pl: Point, pr: Point): [Point, Point, number] {
    const xr = pr.x, xl = pl.x, yr = pr.y, yl = pl.y;
    const dx = xr - xl, dy = yr - yl;
    const square = dx * dx + dy * dy;
    const dist = Math.sqrt(square);
    const theta = Math.atan2(dy, dx);
    const cos = Math.cos(-theta);
    const sin = Math.sin(-theta);
    const xlen = Math.min(dist * 0.04 + 10, dist * 0.25);
    const naturalSag = Math.log10(Math.max(dist, 1)) * 17 - 16;
    // The logarithmic curve approaches (and for very short spans crosses)
    // zero. That made a short tie, including a system-edge fragment, look
    // like a straight tapered rule. Preserve a visible upward bow while
    // keeping the old geometry for normal and long spans.
    const minimumSag = Math.min(6, Math.max(4, dist * 0.16));
    const h = -Math.max(minimumSag, naturalSag);
    let p1 = new Point(xlen, h).rotate(cos, sin);
    let p2 = new Point(dist - xlen, h).rotate(cos, sin);
    p1 = p1.offset(xl, yl);
    p2 = p2.offset(xl, yl);
    return [p1, p2, cos];
  }

  init(pl: Point, pr: Point, thickness: number, clr: number): void {
    let [pt0, pt1, cos] = SlurTieBase.calcSlurPoints(pl, pr);
    const lw0 = thickness / cos;

    // (the "line" object is computed but not added in the original; skipped)

    const obj = new GraphicPath();
    obj.fill = true;
    obj.stroke = true;
    obj.strokeWidth = 1.0;
    obj.strokeColor = clr;
    obj.fillColor = clr;
    obj.moveTo(pl);
    obj.cubicTo(pt0, pt1, pr);
    pt0 = pt0.offset(lw0 / 2, 0);
    pt1 = pt1.offset(0, lw0 / 2);
    obj.cubicTo(pt1, pt0, pl);
    obj.close();

    const box = obj.computeTightBounds();
    obj.offset(-box.left, -box.top);
    obj.x = 0;
    obj.y = 0;
    obj.width = box.width;
    obj.height = box.height;

    this.add(obj);
    this.x = box.left;
    this.y = box.top;
    this.width = box.width;
    this.height = box.height;
  }
}
export class Tie extends SlurTieBase {}
export class Slur extends SlurTieBase {}

// ---------------- Entry hierarchy ----------------

export abstract class Entry {
  group = new Group();
  selected = false;
  line!: Line;
  /** Shared rhythmic anchor used to align right/left-hand piano entries. */
  syncMeasure = -1;
  /** Original score measure index, independent of repeat-flow position. */
  syncSourceMeasure = -1;
  syncTick = new Fraction(0);
  syncOrder = 0;
  syncBeats = 4;
  syncBeatType = 4;
  syncPickup = false;
  syncDisplayNumber: number | null = null;
  constructor() {
    this.group.classes.add("entry");
  }
  update(): void {
    this.group.update();
  }
  abstract entryItem(): PageItem | null;
  entryWidth(): number {
    return this.entryItem()?.width ?? 0;
  }
}

export class KeySig extends Entry {
  constructor(key: S.Key, opt: LayoutOptions) {
    super();
    const names = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
    const name = names[key.fifths + 7];
    const tf = new TextFrame();
    tf.color = opt.color;
    tf.y = -opt.numberSize;
    tf.text = `转1=${name}`;
    tf.font = opt.lrcFont.scaled(0.6);
    const w = tf.measureText();
    tf.x = -w / 2;
    this.group.add(tf);
    this.group.data = this;
  }
  entryItem(): PageItem | null {
    return null;
  }
  override entryWidth(): number {
    return 0;
  }
}

export class TimeSig extends Entry {
  hline!: GraphicLine;
  width = 0;
  beats: number;
  beatType: number;
  constructor(beats: number, beatType: number, opt: LayoutOptions) {
    super();
    this.beats = beats;
    this.beatType = beatType;
    this.layout(opt);
    this.group.data = this;
  }
  static fromTime(t: S.Time, opt: LayoutOptions): TimeSig {
    return new TimeSig(t.beats, t.beatType, opt);
  }
  entryItem(): PageItem | null {
    return this.hline;
  }
  override entryWidth(): number {
    return this.width;
  }
  layout(opt: LayoutOptions): void {
    const top = (-opt.numberSize * 23) / 28;
    const bot = (opt.numberSize * 5) / 28;
    const cy = (bot + top) / 2;
    const font = opt.numberFont.withBold().makeWithSize(opt.numberSize * 0.75);
    const tf1 = new TextFrame();
    tf1.color = opt.color;
    tf1.font = font;
    tf1.text = String(this.beats);
    const w1 = tf1.measureText();
    const tf2 = new TextFrame();
    tf2.font = font;
    tf2.color = opt.color;
    tf2.text = String(this.beatType);
    const w2 = tf2.measureText();
    this.width = Math.max(w1, w2);
    const ln = new GraphicLine();
    ln.strokeWidth = 1.5;
    ln.strokeColor = opt.color;
    const y = cy - ln.strokeWidth / 2;
    ln.p0 = new Point(0, y);
    ln.p1 = new Point(this.width, y);
    tf1.y = y - opt.numberSize * 0.1;
    tf1.x = (this.width - w1) / 2;
    tf2.y = y + opt.numberSize * 0.625;
    tf2.x = (this.width - w2) / 2;
    this.hline = ln;
    this.group.add(tf1);
    this.group.add(tf2);
    this.group.add(ln);
  }
}

export class NoteEntry extends Entry {
  chord!: S.Chord;
  verse = 0; // repeat pass / lyric verse this rendered entry belongs to
  lrc: Lyric | null = null;
  number: JpNumber | null = null;
  numbers: JpNumber[] = [];
  accidental: TextFrame | null = null;
  beams = 0;
  octaveDot: JpOctaveDot[] = [];
  notations: SmuflText[] = [];
  /** Selectable visual group for each non-metrical grace note. */
  graceItems = new Map<S.Note, Group>();
  private rowYs: number[] = [];

  constructor() {
    super();
    this.group.data = this;
  }
  get jpOctave(): number {
    return this.chord.notes[0].jpOctave;
  }
  get numberPos(): number {
    return this.number!.numberPos;
  }
  addAccidental(tf: TextFrame): void {
    this.accidental = tf;
    this.group.add(tf);
  }
  add(item: JpNumber | Lyric): void {
    if (item instanceof JpNumber) {
      if (this.number === null) this.number = item;
      this.numbers.push(item);
      this.group.add(item);
    } else {
      this.lrc = item;
      this.group.add(item);
    }
  }
  get left(): number {
    return this.number !== null ? this.number.left : 0;
  }
  get cx(): number {
    return this.number!.x + this.number!.cx;
  }
  get right(): number {
    return this.number?.right ?? 0;
  }
  entryItem(): TextFrame | null {
    return this.number;
  }
  get beginOfSlurTied(): boolean {
    if (this.chord.slurStart) return true;
    if (this.chord.notes.some((note) => note.tieStart)) return true;
    return false;
  }
  get endOfSlurTied(): boolean {
    if (this.chord.slurEnd) return true;
    if (this.chord.notes.some((note) => note.tieEnd)) return true;
    return false;
  }

  private static noteText(nt: S.Note): string {
    return nt.displayText ?? nt.number;
  }

  private static noteOctave(nt: S.Note): number {
    return nt.displayOctave ?? nt.jpOctave;
  }

  private static noteAlter(nt: S.Note): string {
    return nt.displayAlter ?? nt.jpAlter;
  }

  private static noteBaselineOffset(nt: S.Note, opt: LayoutOptions): number {
    // Q has a deep descender, so its uppercase body appears higher than the
    // surrounding keyboard letters on a shared typographic baseline.
    return NoteEntry.noteText(nt).substring(0, 1) === "Q"
      ? opt.numberSize * 0.05
      : 0;
  }

  private static noteTop(nt: S.Note, opt: LayoutOptions): number {
    const octave = NoteEntry.noteOctave(nt);
    const numberTop = opt.numberBound(NoteEntry.noteText(nt) || "1").top
      + NoteEntry.noteBaselineOffset(nt, opt);
    if (octave <= 0) return numberTop;
    const diameter = opt.octaveDotDiameter();
    const gap = opt.octaveDotGap();
    return numberTop - gap - octave * diameter - (octave - 1) * gap;
  }

  private static noteBottom(
    nt: S.Note,
    ch: S.Chord,
    opt: LayoutOptions,
    includeBeams = true,
  ): number {
    const octave = NoteEntry.noteOctave(nt);
    const numberBottom = opt.numberBound(NoteEntry.noteText(nt) || "1").bottom
      + NoteEntry.noteBaselineOffset(nt, opt);
    const rhythmicBottom = includeBeams
      ? Math.max(numberBottom, ch.beams * opt.jpBeamDist)
      : numberBottom;
    if (octave >= 0) return rhythmicBottom;
    const diameter = opt.octaveDotDiameter();
    const gap = opt.octaveDotGap();
    const count = -octave;
    return rhythmicBottom + gap + count * diameter + (count - 1) * gap;
  }

  /** Bottom chord tone stays on the rhythmic baseline; upper tones grow upward. */
  private static chordRowYs(notes: S.Note[], ch: S.Chord, opt: LayoutOptions): number[] {
    if (notes.length === 0) return [];
    const rows = [0];
    const baseGap = opt.numberSize * opt.engravingStyle.chordRowGap;
    // Keep an independently adjustable blank band between an octave dot and
    // the neighbouring chord tone.  The dot-to-owner gap stays small, while
    // this band makes it visually unambiguous which row owns the dot.
    const clearance = opt.numberSize * 0.12 * opt.engravingStyle.octaveDotClearance;
    for (let i = 1; i < notes.length; i++) {
      // Reduction beams belong to the bottom rhythmic baseline, not to every
      // upper chord row. Including them here made a tied chord change height
      // when its duration was split differently on the other side of a barline.
      const occupied = NoteEntry.noteBottom(notes[i - 1], ch, opt, false)
        - NoteEntry.noteTop(notes[i], opt)
        + clearance;
      rows.push(rows[i - 1] + Math.max(baseGap, occupied));
    }
    const bottomBaseline = rows[rows.length - 1];
    return rows.map((row) => row - bottomBaseline);
  }

  entryTop(opt: LayoutOptions): number {
    const bnd = opt.numberBound("1");
    if (this.numbers.length !== this.chord.notes.length) return bnd.top - opt.numberSize / 8;
    let ypos = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.chord.notes.length; i++) {
      const nt = this.chord.notes[i];
      const top = (this.rowYs[i] ?? 0) + NoteEntry.noteTop(nt, opt);
      ypos = Math.min(ypos, top);
    }
    if (!Number.isFinite(ypos)) ypos = bnd.top;
    return ypos - opt.numberSize / 8;
  }
  entryBottom(options: LayoutOptions): number {
    if (this.numbers.length !== this.chord.notes.length) {
      return Math.max(options.numberBound("1").bottom, this.chord.beams * options.jpBeamDist);
    }
    let y = this.chord.beams * options.jpBeamDist;
    for (let i = 0; i < this.chord.notes.length; i++) {
      const nt = this.chord.notes[i];
      const bottom = (this.rowYs[i] ?? 0) + NoteEntry.noteBottom(
        nt,
        this.chord,
        options,
        i === this.chord.notes.length - 1,
      );
      y = Math.max(y, bottom);
    }
    return y;
  }

  static addAccidental(
    it: JpNumber,
    options: LayoutOptions,
    nt: S.Note,
    ent: NoteEntry,
    rowY = 0,
  ): void {
    const alt = NoteEntry.noteAlter(nt);
    if (alt !== " ") {
      const tf = new SmuflText(options);
      tf.classes.add("jianpu-accidental");
      tf.classes.add(alt === "b"
        ? "jianpu-accidental-flat"
        : alt === "#"
          ? "jianpu-accidental-sharp"
          : "jianpu-accidental-natural");
      tf.color = continuationColor(options.color, fadeTiedContinuation(ent.chord, options, nt));
      if (nt.displayHidden) tf.classes.add("notation-hidden-label");
      if (options.smuflAsPath) tf.asPath = true;
      let smufl: string;
      switch (alt) {
        case "b": smufl = GlyphCodes.accidentalFlat; break;
        case "#": smufl = GlyphCodes.accidentalSharp; break;
        case "n": smufl = GlyphCodes.accidentalNatural; break;
        default: throw new Error("");
      }
      const yOffset = alt === "b" ? 0.1 : 0; // 简谱中降号下移
      tf.text = smufl;
      tf.font = tf.font.makeWithSize(tf.font.size * 0.8 * options.engravingStyle.accidentalScale);
      tf.update();
      const gap = options.numberSize * 0.14 * options.engravingStyle.accidentalGapScale;
      tf.x = it.x + it.bound.left - gap - tf.bound.right;
      const numBnd = options.numberBound("1");
      tf.y = rowY + numBnd.top + tf.font.size * yOffset;
      ent.addAccidental(tf);
    }
  }
  static octaveDot(
    nt: S.Note,
    ch: S.Chord,
    options: LayoutOptions,
    ent: NoteEntry,
    owner: JpNumber,
    rowY = 0,
    includeBeams = true,
  ): void {
    const oct = NoteEntry.noteOctave(nt);
    // Digits do not all share exactly the same tight top/bottom bounds.  Use
    // the owning digit instead of the former generic "1", so an upper or
    // lower dot hugs the number it actually belongs to.
    const numBound = options.numberBound(NoteEntry.noteText(nt) || "1");
    const diameter = options.octaveDotDiameter();
    const gap = options.octaveDotGap();
    for (let d = 0; d < Math.abs(oct); d++) {
      const color = continuationColor(options.color, fadeTiedContinuation(ent.chord, options, nt));
      const tf = new JpOctaveDot(diameter / 2, color);
      tf.owner = owner;
      if (nt.displayHidden) tf.classes.add("notation-hidden-label");
      tf.update();
      tf.x = owner.x + owner.cx - tf.width / 2;
      if (oct > 0) {
        tf.y = rowY + numBound.top - gap - diameter - d * (diameter + gap);
      } else {
        const anchor = includeBeams
          ? Math.max(numBound.bottom, ch.beams * options.jpBeamDist)
          : numBound.bottom;
        tf.y = rowY + anchor + gap + d * (diameter + gap);
      }
      ent.group.add(tf);
      ent.octaveDot.push(tf);
    }
  }
  static addLyric(ch: S.Chord, options: LayoutOptions, ent: NoteEntry, it: JpNumber, lrc: number): void {
    for (const l of ch.notes[0].lyrics) {
      if (!l.refrain) {
        if (l.number !== lrc) continue;
      }
      let text = l.text;
      if (options.ignoreVerseNumber) {
        for (let idx = 0; idx < l.text.length; idx++) {
          const _ch = l.text[idx];
          if ((_ch >= "0" && _ch <= "9") || _ch === ".") {
            // skip leading verse number/dot
          } else {
            text = l.text.substring(idx);
            break;
          }
        }
      }
      const lit = new Lyric();
      lit.font = options.lrcFont;
      lit.y = 1.0 * options.numberFont.size;
      lit.text = options.halfWidthPunct ? CJKUtil.toHalfWidth(text) : text;
      lit.color = options.color;
      lit.update();
      lit.x = it.left - lit.left;
      ent.add(lit);
    }
  }
  static addNotations(ch: S.Chord, options: LayoutOptions, ent: NoteEntry): void {
    if (ch.fermata) {
      const t = new SmuflText(options);
      t.color = options.color;
      t.text = GlyphCodes.fermataAbove;
      t.y = ent.entryTop(options);
      const hasSlurTied = ent.beginOfSlurTied || ent.endOfSlurTied;
      if (hasSlurTied) t.y -= options.smuflFont.size / 4;
      t.x += ent.numberPos / 2;
      t.x -= t.bound.width / 2;
      ent.group.add(t);
      ent.notations.push(t);
    }
  }

  private static addArpeggio(
    ch: S.Chord,
    options: LayoutOptions,
    ent: NoteEntry,
  ): number {
    const existingLeft = Math.min(0, ...ent.group.children.map((child) => child.x));
    if (!ch.arpeggio) return existingLeft;
    const pitchRange = ch.arpeggioPitches?.length
      ? new Set(ch.arpeggioPitches)
      : null;
    const coveredRows = ch.notes.flatMap((note, index) =>
      !note.rest && (!pitchRange || pitchRange.has(note.pitch)) ? [index] : []);
    if (coveredRows.length < 2) return existingLeft;

    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const index of coveredRows) {
      const note = ch.notes[index];
      const rowY = ent.rowYs[index] ?? 0;
      top = Math.min(top, rowY + NoteEntry.noteTop(note, options));
      bottom = Math.max(bottom, rowY + NoteEntry.noteBottom(note, ch, options));
    }
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) return existingLeft;
    if (bottom - top < options.numberSize * 0.72) {
      const center = (top + bottom) / 2;
      top = center - options.numberSize * 0.36;
      bottom = center + options.numberSize * 0.36;
    }

    const amplitude = Math.max(1.5, options.numberSize * 0.055);
    const halfWave = Math.max(3, options.numberSize * 0.12);
    const gap = options.numberSize * 0.12;
    const centerX = existingLeft - gap - amplitude;
    const path = new GraphicPath();
    path.classes.add("jianpu-arpeggio");
    path.stroke = true;
    path.fill = false;
    path.strokeColor = options.color;
    path.strokeWidth = Math.max(1, options.numberSize * 0.035);
    path.moveTo(centerX, top);
    let y = top;
    let direction = 1;
    while (y < bottom - 1e-6) {
      const next = Math.min(bottom, y + halfWave);
      const dy = next - y;
      path.cubicTo(
        centerX + amplitude * direction, y + dy * 0.22,
        centerX + amplitude * direction, y + dy * 0.78,
        centerX, next,
      );
      direction *= -1;
      y = next;
    }
    ent.group.add(path);
    return centerX - amplitude;
  }

  private static addGraceNotes(
    ch: S.Chord,
    options: LayoutOptions,
    ent: NoteEntry,
    leftEdge: number,
  ): void {
    if (ch.graceNotes.length === 0) return;
    const group = new Group();
    group.classes.add("jianpu-grace-group");
    const font = options.numberFont.scaled(0.56);
    const gap = options.numberSize * 0.08;
    const diameter = Math.max(0.5, options.octaveDotDiameter() * 0.62);
    const mainNumber = ent.number;
    if (!mainNumber) return;
    const mainPosition = mainNumber.pos(ent.group);
    const mainNote = ch.notes[0];
    const mainBound = options.numberBound(mainNote ? NoteEntry.noteText(mainNote) : "1");
    // Keep the small digit fully above the main note: its visual bottom sits
    // on the same horizontal line as the main digit's visual top.
    const graceBottom = mainPosition.y + mainBound.top;
    let cursor = 0;
    let firstBeamX = Number.POSITIVE_INFINITY;
    let lastBeamX = Number.NEGATIVE_INFINITY;
    let contentBottom = Number.NEGATIVE_INFINITY;
    const graceNumbers: JpNumber[] = [];

    ch.graceNotes.forEach((note, index) => {
      const noteGroup = new Group();
      noteGroup.data = note;
      noteGroup.selectable = true;
      noteGroup.classes.add("jianpu-grace-note");
      const number = new JpNumber();
      number.classes.add("jianpu-grace-number");
      number.text = NoteEntry.noteText(note);
      number.font = font;
      number.color = options.color;
      const numberBound = LayoutOptions.charBound(font, NoteEntry.noteText(note) || "1");
      number.y = graceBottom - numberBound.bottom;
      number.update();
      noteGroup.add(number);

      const displayAlter = NoteEntry.noteAlter(note);
      if (displayAlter !== " ") {
        const accidental = new SmuflText(options);
        accidental.classes.add("jianpu-grace-accidental");
        accidental.color = options.color;
        accidental.font = options.smuflFont.makeWithSize(font.size * 0.72);
        accidental.text = displayAlter === "b"
          ? GlyphCodes.accidentalFlat
          : displayAlter === "#"
            ? GlyphCodes.accidentalSharp
            : GlyphCodes.accidentalNatural;
        accidental.update();
        accidental.x = number.x - accidental.width - gap * 0.35;
        accidental.y = number.y;
        noteGroup.add(accidental);
      }

      const displayOctave = NoteEntry.noteOctave(note);
      for (let dotIndex = 0; dotIndex < Math.abs(displayOctave); dotIndex++) {
        const dot = new JpOctaveDot(diameter / 2, options.color);
        dot.owner = number;
        dot.update();
        dot.x = number.x + number.cx - dot.width / 2;
        const dotGap = Math.max(0.4, options.octaveDotGap() * 0.62);
        if (displayOctave > 0) {
          dot.y = number.y + numberBound.top -
            dotGap - diameter - dotIndex * (diameter + dotGap);
        } else {
          dot.y = number.y + numberBound.bottom +
            dotGap + dotIndex * (diameter + dotGap);
        }
        noteGroup.add(dot);
      }

      noteGroup.update();
      noteGroup.x = cursor;
      group.add(noteGroup);
      ent.graceItems.set(note, noteGroup);
      graceNumbers.push(number);
      const numberX = noteGroup.x + number.x;
      if (index === 0) firstBeamX = numberX;
      lastBeamX = numberX + number.width;
      contentBottom = Math.max(contentBottom, noteGroup.y + noteGroup.height);
      cursor += noteGroup.width + gap;
    });

    const beamGap = Math.max(1.4, options.jpBeamDist * 0.52);
    const firstBeamY = contentBottom + beamGap * 0.7;
    const graceBeams: GraphicLine[] = [];
    for (let level = 0; level < 2; level++) {
      const beam = new GraphicLine();
      beam.data = ch.graceNotes[ch.graceNotes.length - 1];
      beam.selectable = true;
      beam.classes.add("jianpu-grace-beam");
      beam.strokeColor = options.color;
      beam.strokeWidth = Math.max(1, options.numberSize * 0.032);
      beam.p0 = new Point(firstBeamX, firstBeamY + level * beamGap);
      beam.p1 = new Point(lastBeamX, firstBeamY + level * beamGap);
      group.add(beam);
      graceBeams.push(beam);
    }

    group.update();
    const graceToMainGap = options.numberSize * 0.42;
    group.x = leftEdge - graceToMainGap - group.width;
    ent.group.add(group);

    // Compact grace-note link: leave from beneath the grace digit's lower beam
    // and meet the vertical middle of the main digit.
    const lastNote = ch.graceNotes[ch.graceNotes.length - 1];
    const lastNumber = graceNumbers[graceNumbers.length - 1];
    const lowerBeam = graceBeams[graceBeams.length - 1];
    if (lastNote && lastNumber && lowerBeam && mainNumber) {
      const lowerBeamPosition = lowerBeam.pos(ent.group);
      const lastNumberPosition = lastNumber.pos(ent.group);
      const startX = Math.max(
        lowerBeamPosition.x + lowerBeam.width * 0.64,
        lastNumberPosition.x + lastNumber.width * 0.58,
      );
      const startY = lowerBeamPosition.y + lowerBeam.height +
        Math.max(0.45, options.numberSize * 0.025);
      const endX = mainPosition.x + mainNumber.bound.left - options.numberSize * 0.035;
      if (endX > startX + options.numberSize * 0.05) {
        const endY = mainPosition.y + (mainBound.top + mainBound.bottom) / 2;
        const span = endX - startX;
        const drop = Math.max(0, endY - startY);
        const radius = Math.min(
          options.numberSize * 0.09,
          span * 0.22,
          Math.max(options.numberSize * 0.035, drop * 0.42),
        );
        const link = new GraphicPath();
        link.data = lastNote;
        link.selectable = true;
        link.classes.add("jianpu-grace-link");
        link.stroke = true;
        link.fill = false;
        link.strokeColor = options.color;
        link.strokeWidth = Math.max(1, options.numberSize * 0.032);
        link.moveTo(startX, startY);
        // Curved L: descend first, then sweep right.  Both legs bow slightly
        // so the link reads as one continuous musical gesture rather than two
        // straight segments joined at a mechanical corner.
        link.cubicTo(
          startX - radius * 0.22, startY + drop * 0.44,
          startX - radius * 0.08, endY - radius * 0.72,
          startX + radius, endY - radius * 0.08,
        );
        link.cubicTo(
          startX + radius * 1.75, endY + radius * 0.18,
          endX - span * 0.28, endY + radius * 0.14,
          endX, endY,
        );
        ent.group.add(link);
      }
    }
  }

  static fromChord(res: Entry[], ch: S.Chord, lrc: number, options: LayoutOptions): void {
    let ent = new NoteEntry();
    ent.beams = ch.beams;
    ent.chord = ch;
    ent.verse = lrc;
    const notes = ch.notes.length > 0 ? ch.notes : [];
    ent.rowYs = NoteEntry.chordRowYs(notes, ch, options);
    const noteTexts = notes.map((note) => NoteEntry.noteText(note));
    // Chord rows used to share x=0, which left-aligned their glyphs. That is
    // barely visible for equal-width digits, but makes a narrow keyboard key
    // such as J sit conspicuously to the left of a wide W. Keep the widest
    // row at x=0 and align every first glyph by its advance-box centre.
    const chordCenter = noteTexts.reduce((center, text) =>
      Math.max(center, options.numberFont.measureText(text.substring(0, 1)) / 2), 0);
    let it: JpNumber | null = null;
    for (let i = 0; i < notes.length; i++) {
      const nt = notes[i];
      const num = new JpNumber();
      num.color = continuationColor(options.color, fadeTiedContinuation(ch, options, nt));
      num.text = noteTexts[i];
      num.font = options.numberFont;
      if (nt.displayHidden) num.classes.add("notation-hidden-label");
      num.x = chordCenter - num.cx;
      const rowY = ent.rowYs[i] ?? 0;
      const displayRowY = rowY + NoteEntry.noteBaselineOffset(nt, options);
      num.y = displayRowY;
      ent.add(num);
      NoteEntry.addAccidental(num, options, nt, ent, displayRowY);
      NoteEntry.octaveDot(
        nt,
        ch,
        options,
        ent,
        num,
        displayRowY,
        i === notes.length - 1,
      );
      if (i === 0) it = num;
    }
    if (!it) throw new Error("chord without notes");
    if (ch.dot > 0) {
      const augmentationDots = "·".repeat(ch.dot);
      for (const number of ent.numbers) number.text += augmentationDots;
    }
    NoteEntry.addLyric(ch, options, ent, it, lrc);
    NoteEntry.addNotations(ch, options, ent);
    const ornamentLeft = NoteEntry.addArpeggio(ch, options, ent);
    NoteEntry.addGraceNotes(ch, options, ent, ornamentLeft);
    ent.update();
    res.push(ent);
    for (let i = 1; i < ch.beats; i++) {
      ent = new NoteEntry();
      ent.chord = ch;
      ent.verse = lrc;
      const num = ch.rest ? "0" : "-";
      it = new JpNumber();
      it.text = num;
      it.color = continuationColor(options.color, fadeTiedContinuation(ch, options));
      it.font = options.numberFont;
      ent.add(it);
      ent.update();
      res.push(ent);
    }
  }
}

export class Barline extends Entry {
  constructor(final: boolean, opt: LayoutOptions) {
    super();
    this.group.data = this;
    const top = (-opt.numberSize * 23) / 28;
    const bot = (opt.numberSize * 5) / 28;
    const style = opt.engravingStyle;
    const heavyWidth = style.finalBarlineWidth;
    const res = this.group;
    const widths = final ? [heavyWidth, heavyWidth] : [style.barlineWidth];
    const dist = final ? style.finalBarlineGap : heavyWidth;
    let xpos = 0;
    for (const w of widths) {
      const l = new GraphicLine();
      l.strokeColor = opt.color;
      l.x = xpos + w / 2;
      l.p0 = new Point(0, top);
      l.p1 = new Point(0, bot);
      l.strokeWidth = w;
      xpos += w + dist;
      res.add(l);
    }
    res.update();
  }
  entryItem(): PageItem | null {
    return this.group.children[0];
  }
}

export class LineBreak extends Entry {
  newPage = false;
  constructor() {
    super();
    this.group.width = 0;
    this.group.height = 0;
    this.group.data = this;
  }
  entryItem(): PageItem | null {
    return null;
  }
}

export class BeamLine extends GraphicLine {
  level = 0;
  left: NoteEntry | null = null;
  right: NoteEntry | null = null;
  constructor(lev: number, l: NoteEntry, r: NoteEntry, opt: LayoutOptions) {
    super();
    this.selectable = true;
    this.level = lev;
    this.left = l;
    this.right = r;
    const grp = l.line.group;
    this.p0 = l.entryItem()!.pos(grp);
    this.p1 = r.entryItem()!.pos(grp);
    this.p1 = this.p1.offset(r.numberPos, 0);
    this.p0 = new Point(this.p0.x, opt.jpBeamDist * lev);
    this.p1 = new Point(this.p1.x, opt.jpBeamDist * lev);
    this.strokeWidth = 1.25;
    this.strokeColor = opt.color;
    this.x = this.p0.x;
    this.p1 = this.p1.offset(-this.p0.x, 0);
    this.p0 = new Point(0, this.p0.y);
  }
}

// ---------------- Line / layout ----------------

function entryRhythmAnchor(e: Entry): number {
  const item = e.entryItem();
  if (item === null) return e.group.width / 2;
  if (e instanceof NoteEntry && e.number) return item.x + e.number.cx;
  return item.x + item.width / 2;
}

function entryRhythmKind(e: Entry): RhythmColumnKind {
  if (e instanceof NoteEntry) return "note";
  if (e instanceof Barline) return "barline";
  if (e instanceof KeySig) return "key";
  if (e instanceof TimeSig) return "time";
  return "other";
}

function measuredRhythmItem(e: Entry): RhythmItem<Entry> {
  e.update();
  const anchor = entryRhythmAnchor(e);
  return {
    value: e,
    tickKey: e.syncTick.toString(),
    tick: e.syncTick.toFloat(),
    order: e.syncOrder,
    kind: entryRhythmKind(e),
    left: Math.max(0, anchor),
    right: Math.max(0, e.group.width - anchor),
  };
}

function horizontalMeasureOptions(opt: LayoutOptions) {
  const scale = opt.engravingStyle.noteGapScale;
  return {
    edgePadding: opt.numberSize * 0.12 * scale,
    normalClearance: opt.numberSize * 0.08 * scale,
    boundaryClearance: opt.numberSize * 0.16 * scale,
    minimumElasticUnit: opt.numberSize * 0.14 * scale,
    spacingExponent: opt.engravingStyle.rhythmicSpacingExponent,
  };
}

function addSystemMeasureNumber(
  target: Group,
  x: number,
  number: number | null,
  opt: LayoutOptions,
  contentTop = target.childrenBound.top,
): void {
  if (number === null) return;
  const label = new TextFrame();
  label.classes.add("measure-number");
  label.affectsLayout = false;
  label.text = `(${number})`;
  label.font = opt.numberFont.scaled(0.48);
  label.color = opt.color;
  label.update();
  label.x = x;
  label.y = contentTop - opt.numberSize * 0.12 - label.font.metrics.descent;
  target.add(label);
}

interface TempoPositionedEntry {
  entry: Entry;
  x: number;
}

function tempoMarkX(
  mark: S.TempoMark,
  positionedEntries: readonly TempoPositionedEntry[],
): number | null {
  const anchors = positionedEntries
    .filter(({ entry }) =>
      entry.syncSourceMeasure === mark.measure &&
      (entry instanceof NoteEntry || entry instanceof Barline))
    .map(({ entry, x }) => ({ tick: entry.syncTick.toFloat(), x }))
    .sort((left, right) => left.tick - right.tick || left.x - right.x);
  if (anchors.length === 0) return null;

  const unique: Array<{ tick: number; x: number }> = [];
  for (const anchor of anchors) {
    const previous = unique[unique.length - 1];
    if (previous && Math.abs(previous.tick - anchor.tick) < 1e-8) continue;
    unique.push(anchor);
  }
  const tick = mark.offset.toFloat();
  const exact = unique.find((anchor) => Math.abs(anchor.tick - tick) < 1e-8);
  if (exact) return exact.x;
  if (tick <= unique[0].tick) return unique[0].x;
  if (tick >= unique[unique.length - 1].tick) return unique[unique.length - 1].x;
  const rightIndex = unique.findIndex((anchor) => anchor.tick > tick);
  if (rightIndex <= 0) return unique[0].x;
  const left = unique[rightIndex - 1];
  const right = unique[rightIndex];
  const ratio = (tick - left.tick) / Math.max(1e-8, right.tick - left.tick);
  return left.x + (right.x - left.x) * ratio;
}

function makeTempoMarker(mark: S.TempoMark, opt: LayoutOptions): Group {
  const group = new Group();
  group.data = mark;
  group.selectable = true;
  group.classes.add("tempo-annotation");
  group.classes.add(`tempo-${mark.kind}`);
  if (mark.kind === "tempo") {
    const note = new SmuflText(opt);
    note.text = mark.beatUnit === "eighth"
      ? GlyphCodes.metNote8thUp
      : GlyphCodes.metNoteQuarterUp;
    // The publication header uses a full-height metronome note.  Keep later
    // tempo changes at the same visible stem height instead of shrinking the
    // SMuFL glyph together with the smaller BPM text.
    note.font = opt.smuflFont.makeWithSize(opt.numberSize * 0.88);
    note.color = opt.color;
    note.update();
    group.add(note);
    let symbolRight = note.bound.right;
    if (mark.beatUnit === "dotted-quarter") {
      const dot = new TextFrame();
      dot.text = "·";
      dot.font = opt.lrcFont.scaled(0.34).withBold();
      dot.color = opt.color;
      dot.x = symbolRight + opt.numberSize * 0.01;
      dot.y = -opt.numberSize * 0.01;
      dot.update();
      group.add(dot);
      symbolRight = dot.x + dot.bound.right;
    }

    const value = new TextFrame();
    value.text = `=${S.formatTempoBpm(S.tempoBpmForUnit(mark.bpm ?? 90, mark.beatUnit))}`;
    value.font = opt.lrcFont.scaled(0.46);
    value.color = opt.color;
    value.update();
    value.x = symbolRight + opt.numberSize * 0.08;
    value.y = -opt.numberSize * 0.02;
    group.add(value);
  } else {
    const text = new TextFrame();
    text.text = mark.kind === "accel" ? "accel." : "rit.";
    text.font = opt.lrcFont.scaled(0.46).withBold();
    text.color = opt.color;
    text.update();
    group.add(text);
  }
  group.update();
  return group;
}

function addTempoAnnotations(
  target: Group,
  marks: readonly S.TempoMark[],
  positionedEntries: readonly TempoPositionedEntry[],
  opt: LayoutOptions,
  topFor: (mark: S.TempoMark, marker: Group) => number,
): void {
  const canonical: S.TempoMark[] = [];
  for (const mark of marks) {
    const existing = canonical.findIndex((item) =>
      item.measure === mark.measure &&
      item.offset.equals(mark.offset) &&
      item.kind === mark.kind);
    if (existing >= 0) canonical[existing] = mark;
    else canonical.push(mark);
  }

  const placed: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  const horizontalGap = opt.numberSize * 0.1;
  const verticalGap = opt.numberSize * 0.08;
  for (const mark of canonical) {
    const x = tempoMarkX(mark, positionedEntries);
    if (x === null) continue;
    const marker = makeTempoMarker(mark, opt);
    marker.x = x - marker.width / 2;
    let top = topFor(mark, marker);
    for (let attempt = 0; attempt <= placed.length; attempt++) {
      const collisions = placed.filter((item) =>
        marker.x < item.right + horizontalGap &&
        marker.x + marker.width > item.left - horizontalGap &&
        top < item.bottom + verticalGap &&
        top + marker.height > item.top - verticalGap);
      if (collisions.length === 0) break;
      top = Math.min(...collisions.map((item) =>
        item.top - marker.height - verticalGap - 1e-6));
    }
    marker.y = top;
    target.add(marker);
    placed.push({
      left: marker.x,
      right: marker.x + marker.width,
      top,
      bottom: top + marker.height,
    });
  }
}

class EntryItemInfo {
  dist = 0;
  rate = 0;
  entry: Entry | null = null;
}

class Page {
  lines: Line[] = [];
}

export class Line {
  group = new Group();
  entries: Entry[] = [];
  beams: BeamLine[] = [];
  maxBeamLevel = 0;
  chordEntry = new Map<S.Chord, NoteEntry>();

  addEntry(e: Entry): void {
    if (e instanceof NoteEntry) {
      if (e.number?.text === "-") {
        // beat-extension dash: not a chord anchor
      } else {
        this.chordEntry.set(e.chord, e);
      }
    }
    this.entries.push(e);
    this.group.add(e.group);
    e.line = this;
  }

  addEntries(entries: Entry[]): void {
    for (const e of entries) this.addEntry(e);
  }

  private entryX(e: Entry): number {
    let res = e.group.x;
    const it = e.entryItem();
    if (it === null) return res;
    res += it.x;
    return res;
  }

  private adjust(width: number, maxHorizontalScale: number, noteGapScale = 1): void {
    const infos: EntryItemInfo[] = [];
    let idx = 0;
    for (const e of this.entries) {
      const next = getOrNull(this.entries, idx + 1);
      if (next === null) break;
      if (next instanceof LineBreak) break;
      const xx = this.entryX(e);
      const xxNext = this.entryX(next);
      const dist = xxNext - xx - e.entryWidth();
      if (dist < -1) throw new Error("neg dist");
      const smallDist = e instanceof NoteEntry && !(next instanceof Barline);
      const it = new EntryItemInfo();
      it.entry = e;
      it.dist = dist;
      it.rate = smallDist ? 2 * noteGapScale : 1;
      if (next instanceof TimeSig) it.rate = 0.1;
      infos.push(it);
      idx++;
      if (idx === this.entries.length - 1) break;
    }
    infos.sort((a, b) => {
      const diff = a.dist * b.rate - b.dist * a.rate;
      if (diff < 0) return -1;
      else if (diff === 0) return a.rate < b.rate ? -1 : a.rate > b.rate ? 1 : 0;
      else return 1;
    });

    let right = 0;
    let lastVisible: Entry | null = null;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!(e instanceof LineBreak)) {
        if (lastVisible === null) lastVisible = e;
      }
      const r = e.group.x + e.group.childrenBound.right;
      if (r > right) right = r;
      if (e instanceof NoteEntry) {
        if (e.lrc !== null) break;
      }
    }
    let extra = width - right;
    const maxExtra = maxHorizontalScale * right;
    let dontMoveLastBarline = false;
    if (extra > maxExtra) {
      extra = maxExtra;
      dontMoveLastBarline = true;
      // 非致命：某行内容远窄于可用宽度（如稀疏/末行），此处已 clamp 掉多余空白照常排版。
      // 仅调试时输出，避免污染控制台（识别出的谱常有短行会触发）。
      if ((globalThis as { __omrDebug?: boolean }).__omrDebug) console.debug("[layout] space too large (clamped)");
    }

    let totalDist = 0;
    let totalRate = 0;
    let end = 0;
    let share = 0;
    for (let i = 0; i <= infos.length; i++) {
      end = i;
      if (i === infos.length) break;
      const it = infos[i];
      const curShare = it.dist / it.rate;
      share = (extra + totalDist + it.dist) / (totalRate + it.rate);
      if (share < curShare) break;
      totalDist += it.dist;
      totalRate += it.rate;
    }
    share = (extra + totalDist) / totalRate;

    const offsets = new Map<Entry, number>();
    for (let i = 0; i < end; i++) {
      const it = infos[i];
      const dist = share * it.rate;
      offsets.set(it.entry!, dist - it.dist);
    }
    let offset = 0;
    for (const e of this.entries) {
      if (e instanceof NoteEntry) {
        for (const dot of e.octaveDot) {
          const owner = dot.owner ?? e.number!;
          dot.x = owner.x + owner.cx - dot.width / 2;
        }
      }
      e.group.x += offset;
      if (offsets.has(e)) offset += offsets.get(e)!;
    }
    if (!dontMoveLastBarline) this.adjustLastBarline(lastVisible, width);
  }

  private adjustLastBarline(lastVisible: Entry | null, width: number): void {
    if (!(lastVisible instanceof Barline)) return;
    const prev = this.entries.indexOf(lastVisible) - 1;
    const prevEnt = getOrNull(this.entries, prev);
    if (!(prevEnt instanceof NoteEntry)) return;
    const dx = lastVisible.group.x - (prevEnt.group.x + prevEnt.number!.right);
    const maxDx = prevEnt.number!.font.size * 3;
    const space = width - lastVisible.group.bound.right - lastVisible.group.x;
    if (space > 0) lastVisible.group.x += Math.min(space, maxDx - dx);
  }

  private calcXPos(opt: LayoutOptions): void {
    for (const e of this.entries) e.group.normalizeX();
    let curX = 0;
    this.entries.forEach((e, idx) => {
      const it = e.entryItem();
      let x = 0;
      let w = 0;
      if (it !== null) x = it.x;
      w = e.entryWidth();
      if (e instanceof Barline) {
        const next = getOrNull(this.entries, idx + 1);
        if (!(next instanceof TimeSig)) curX += it!.height / 5;
      }
      if (e instanceof TimeSig) curX += it!.height / 5;
      e.group.x = curX - x;
      curX += w;
      const next = getOrNull(this.entries, idx + 1);
      if (next && !(next instanceof LineBreak)) {
        // Give the global horizontal-spacing control a real geometric effect
        // in single-staff scores as well as paired piano systems. The previous
        // implementation only changed justification weights, which could look
        // identical once a line had already filled the page.
        const nearBoundary = e instanceof Barline || next instanceof Barline ||
          e instanceof TimeSig || next instanceof TimeSig || e instanceof KeySig || next instanceof KeySig;
        const gap = opt.numberSize * (nearBoundary ? 0.16 : 0.11) * opt.engravingStyle.noteGapScale;
        curX += gap;
      }
    });
    curX = 0;
    let offset = 0;
    for (const e of this.entries) {
      let lrc: Lyric | null = null;
      if (e instanceof NoteEntry) lrc = e.lrc;
      if (lrc === null) {
        e.group.x += offset;
        continue;
      }
      const xx = Math.max(curX - lrc.x, e.group.x + offset);
      offset = xx - e.group.x;
      e.group.x = xx;
      curX = xx + lrc.x + lrc.width;
    }
  }

  private doLineBreak(width: number): Line[] {
    const res: Line[] = [];
    let idx = 0;
    while (idx < this.entries.length) {
      let last = idx;
      let preferred = -1;
      const grp = this.entries[idx].group;
      const l = grp.x;
      while (last < this.entries.length) {
        const lastGrp = this.entries[last].group;
        if (this.entries[last] instanceof LineBreak) {
          last++;
          break;
        }
        const r = lastGrp.x + (lastGrp.maxX ?? 0);
        if (r - l < width) {
          if (this.entries[last] instanceof Barline) preferred = last + 1;
          last++;
          continue;
        }
        // Prefer a completed measure over breaking in the middle of one. A
        // genuinely over-wide single measure may still split as a fallback.
        if (preferred > idx) last = preferred;
        else if (last === idx) last++;
        break;
      }
      const line = new Line();
      for (let i = idx; i < last; i++) line.addEntry(this.entries[i]);
      res.push(line);
      idx = last;
    }
    return res;
  }

  private updateXPos(l: Line, width: number, maxHorizontalScale: number, noteGapScale: number): void {
    const first = l.entries[0];
    const dx = first.group.x;
    for (const e of l.entries) e.group.x -= dx;
    const last = l.entries[l.entries.length - 1];
    if (last.group.width < 0) throw new Error("");
    l.adjust(width, maxHorizontalScale, noteGapScale);
  }

  private layoutVertically(lines: Line[], opt: LayoutOptions, height: number, firstHeaderReserve = 0): Group[] {
    const top = opt.marginTop;
    const dist = opt.systemGap();
    const res: Page[] = [];
    let occupied = 0;
    let pageBreak = false;
    for (const l of lines) {
      l.group.update();
      const pageIndex = Math.max(0, res.length - 1);
      const reserve = pageIndex === 0 ? firstHeaderReserve : 0;
      const availableHeight = Math.max(0, height - reserve);
      const hasPrevious = res.length > 0 && res[res.length - 1].lines.length > 0;
      const needed = l.group.height + (hasPrevious ? dist : 0);
      const newPage = res.length === 0 || pageBreak || occupied + needed > availableHeight;
      if (newPage) {
        res.push(new Page());
        occupied = 0;
        pageBreak = false;
      }
      const pg = res[res.length - 1];
      if (pg.lines.length > 0) occupied += dist;
      l.group.y = occupied;
      occupied += l.group.height;
      pg.lines.push(l);
      const lst = l.entries[l.entries.length - 1];
      if (lst instanceof LineBreak) pageBreak = lst.newPage;
    }
    const grps: Group[] = [];
    let y = 0;
    res.forEach((pg, pageIndex) => {
      const grp = new Group();
      const reserve = pageIndex === 0 ? firstHeaderReserve : 0;
      y = top + reserve;
      for (const line of pg.lines) {
        const l = line.group;
        l.y = y;
        grp.add(l);
        y += l.height + dist;
      }
      grp.update();
      grps.push(grp);
    });
    return grps;
  }

  private addSlurTie(a: S.Note, b: S.Note, ypos: number, thickness: number, clr: number): void {
    const ena = this.chordEntry.get(a.chord);
    const enb = this.chordEntry.get(b.chord);
    const grp = new Tie();
    grp.classes.add("tie-span");
    let pl = new Point(ena!.cx, ypos);
    let pr = new Point(enb!.cx, ypos);
    const dx = ena!.number!.font.size / 14;
    if (a.tiePrev !== null || a.tupletEnd) pl = pl.offset(dx, 0);
    if (b.tieNext !== null) pr = pr.offset(-dx, 0);
    pr = pr.offset(enb!.group.x - ena!.group.x, 0);
    grp.init(pl, pr, thickness, clr);
    grp.x += ena!.group.x;
    grp.normalizeX();
    grp.normalizeY();
    this.group.add(grp);
  }

  private addSystemTieFragment(
    pl: Point,
    pr: Point,
    thickness: number,
    clr: number,
    side: "incoming" | "outgoing",
  ): void {
    if (pr.x <= pl.x + 1e-6) return;
    const grp = new Tie();
    grp.classes.add("tie-span");
    grp.classes.add(`tie-system-${side}`);
    grp.init(pl, pr, thickness, clr);
    this.group.add(grp);
  }

  private addTie(opt: LayoutOptions): void {
    const thickness = opt.slurTieThickness;
    const noteEntries = this.entries.filter((entry): entry is NoteEntry =>
      entry instanceof NoteEntry && this.chordEntry.get(entry.chord) === entry);
    if (noteEntries.length === 0) return;
    const firstNote = noteEntries[0];
    const lastNote = noteEntries[noteEntries.length - 1];
    const firstCenter = firstNote.group.x + firstNote.cx;
    const lastCenter = lastNote.group.x + lastNote.cx;
    const finalBarline = [...this.entries].reverse().find((entry): entry is Barline =>
      entry instanceof Barline);
    const finalBarlineItem = finalBarline?.entryItem();
    const finalBarlineCenter = finalBarline && finalBarlineItem
      ? finalBarline.group.x + finalBarlineItem.x + finalBarlineItem.width / 2
      : lastCenter + opt.numberSize * 0.62;
    // Piano/ensemble systems reserve roughly 0.62 number-heights between the
    // brace-side line and the first rhythmic anchor.  Starting half a number
    // to the left of that anchor keeps an incoming tie inside this reserved
    // strip instead of crossing the brace.
    const leftBoundary = firstCenter - opt.numberSize * 0.5;
    const rightBoundary = Math.max(
      lastCenter + opt.numberSize * 0.42,
      finalBarlineCenter - opt.numberSize * 0.1,
    );

    for (const e of noteEntries) {
      const nt = e.chord.notes.find((note) => note.tieStart && note.tieNext !== null);
      if (!nt) continue;
      const ent = this.chordEntry.get(nt.chord);
      if (!ent) {
        console.error("no entry for tied");
        continue;
      }
      const endCh = nt.tieNext?.chord;
      const endEntry = endCh ? this.chordEntry.get(endCh) : undefined;
      if (endEntry) {
        const ypos = Math.min(this.tiedTop(e, opt, true), this.tiedTop(endEntry, opt, false));
        this.addSlurTie(nt, nt.tieNext!, ypos, thickness, opt.color);
      } else if (nt.tieNext) {
        const dx = e.number!.font.size / 14;
        const startX = e.group.x + e.cx + (nt.tiePrev !== null ? dx : 0);
        const ypos = this.tiedTop(e, opt, true);
        this.addSystemTieFragment(
          new Point(startX, ypos),
          new Point(Math.max(rightBoundary, startX + opt.numberSize * 0.42), ypos),
          thickness,
          opt.color,
          "outgoing",
        );
      }
    }

    // The source note of a tie can live on the previous system or page.  Draw
    // the second fragment independently on the destination line; otherwise the
    // continuation is correctly grey and silent but appears to have no tie.
    for (const e of noteEntries) {
      const nt = e.chord.notes.find((note) =>
        note.tieEnd &&
        note.tiePrev !== null &&
        !this.chordEntry.has(note.tiePrev.chord));
      if (!nt || !nt.tiePrev) continue;
      const dx = e.number!.font.size / 14;
      const endX = e.group.x + e.cx - (nt.tieNext !== null ? dx : 0);
      const ypos = this.tiedTop(e, opt, false);
      this.addSystemTieFragment(
        new Point(Math.min(leftBoundary, endX - opt.numberSize * 0.42), ypos),
        new Point(endX, ypos),
        thickness,
        opt.color,
        "incoming",
      );
    }
  }
  private tiedTop(ent: NoteEntry, opt: LayoutOptions, left: boolean): number {
    let res = ent.entryTop(opt);
    const nt = ent.chord.notes[0];
    if (left) {
      if (nt.tupletBegin) res -= opt.numberSize / 2;
    } else {
      if (nt.tupletEnd) res -= opt.numberSize / 2;
    }
    return res;
  }
  private slurTop(ent: NoteEntry, opt: LayoutOptions, left: boolean): number {
    let res = ent.entryTop(opt);
    if (left) {
      if (ent.chord.notes.some((note) => note.tieStart)) res -= opt.numberSize / 8;
    } else {
      if (ent.chord.notes.some((note) => note.tieEnd)) res -= opt.numberSize / 8;
    }
    if (ent.chord.notes.some((note) => note.tupletEnd || note.tupletBegin)) {
      res -= opt.numberSize / 2;
    }
    return res;
  }
  private addSlur(opt: LayoutOptions): void {
    const thickness = opt.slurTieThickness;
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const nt = e.chord.notes[0];
      if (!e.chord.slurStart) continue;
      const endCh = e.chord.slurEndChord;
      const endEntry = endCh ? this.chordEntry.get(endCh) : undefined;
      if (!endEntry) continue;
      const ypos = Math.min(this.slurTop(e, opt, true), this.slurTop(endEntry, opt, false));
      const nb = endCh!.notes[0];
      this.addSlurTie(nt, nb, ypos, thickness, opt.color);
    }
  }

  private layoutRhythmically(
    width: number,
    height: number,
    opt: LayoutOptions,
    firstHeaderReserve: number,
    tempoMarks: readonly S.TempoMark[],
  ): Group[] {
    interface MeasureRecord {
      index: number;
      entries: Entry[];
      pickup: boolean;
      displayNumber: number | null;
      breakBefore: boolean;
      pageBefore: boolean;
      forceAfter: boolean;
      pageAfter: boolean;
    }

    const records: MeasureRecord[] = [];
    const byIndex = new Map<number, MeasureRecord>();
    const pendingBefore = new Map<number, boolean>();
    let current: MeasureRecord | null = null;
    for (const entry of this.entries) {
      if (entry instanceof LineBreak) {
        const target = entry.syncMeasure >= 0 ? byIndex.get(entry.syncMeasure) : current;
        if (target) {
          target.forceAfter = true;
          target.pageAfter ||= entry.newPage;
        } else if (entry.syncMeasure >= 0) {
          pendingBefore.set(entry.syncMeasure, entry.newPage);
        }
        continue;
      }
      let record = byIndex.get(entry.syncMeasure);
      if (!record) {
        record = {
          index: entry.syncMeasure,
          entries: [],
          pickup: entry.syncPickup,
          displayNumber: entry.syncDisplayNumber,
          breakBefore: pendingBefore.has(entry.syncMeasure),
          pageBefore: pendingBefore.get(entry.syncMeasure) ?? false,
          forceAfter: false,
          pageAfter: false,
        };
        records.push(record);
        byIndex.set(entry.syncMeasure, record);
      }
      record.entries.push(entry);
      current = record;
    }

    const measureOptions = horizontalMeasureOptions(opt);
    const measures: HorizontalMeasureLayout<Entry>[] = records.map((record) => {
      const barDuration = record.entries
        .filter((entry): entry is Barline => entry instanceof Barline)
        .reduce((duration, entry) => Math.max(duration, entry.syncTick.toFloat()), 0);
      const first = record.entries[0];
      const meterDuration = first ? first.syncBeats * 4 / first.syncBeatType : 4;
      const duration = record.pickup && barDuration > 1e-8
        ? barDuration
        : Math.max(barDuration, meterDuration);
      return buildMeasureLayout(
        record.index,
        duration,
        record.entries.map(measuredRhythmItem),
        measureOptions,
        {
          ...record,
          widthWeight: record.pickup ? Math.max(0.12, duration / Math.max(duration, meterDuration)) : 1,
          countInTarget: !record.pickup,
        },
      );
    });
    const systems = packMeasureSystems(
      measures,
      width,
      opt.engravingStyle.measuresPerSystem,
      opt.engravingStyle.justifyLastSystem,
    );

    const lines: Line[] = [];
    for (const system of systems) {
      const line = new Line();
      line.group.classes.add("rhythmic-system");
      for (const measure of system.measures) {
        for (const column of measure.columns) {
          for (const entry of column.items) {
            line.addEntry(entry);
            entry.group.x = measure.x + column.x - entryRhythmAnchor(entry);
          }
        }
      }
      const lastMeasure = system.measures[system.measures.length - 1];
      if (lastMeasure?.forceAfter || system.pageAfter) {
        const lineBreak = new LineBreak();
        lineBreak.newPage = system.pageAfter;
        line.addEntry(lineBreak);
      }
      const widthAnchor = new GraphicLine();
      widthAnchor.strokeColor = 0x00000000;
      widthAnchor.strokeWidth = 0;
      widthAnchor.p0 = new Point(0, 0);
      widthAnchor.p1 = new Point(system.width, 0);
      line.group.add(widthAnchor);

      line.addBeams(opt);
      line.addTuplet(opt);
      line.addTie(opt);
      line.addSlur(opt);
      line.updateLyricY(opt);
      line.addSingleTempoMarks(opt, tempoMarks);
      const numberedMeasure = system.measures.find((measure) => measure.displayNumber !== null);
      if (numberedMeasure) {
        addSystemMeasureNumber(line.group, numberedMeasure.x, numberedMeasure.displayNumber, opt);
      }
      line.group.normalizeY();
      line.group.update();
      line.addRhythmGuide(opt);
      lines.push(line);
    }
    return this.layoutVertically(lines, opt, height, firstHeaderReserve);
  }

  layout(
    width: number,
    height: number,
    opt: LayoutOptions,
    firstHeaderReserve = 0,
    tempoMarks: readonly S.TempoMark[] = [],
  ): Group[] {
    if (opt.engravingStyle.rhythmicSpacingEnabled) {
      return this.layoutRhythmically(width, height, opt, firstHeaderReserve, tempoMarks);
    }
    this.calcXPos(opt);
    const lines = this.doLineBreak(width);
    for (const l of lines) {
      this.updateXPos(l, width, opt.maxHorizontalScale, opt.engravingStyle.noteGapScale);
      l.addBeams(opt);
      l.addTuplet(opt);
      l.addTie(opt);
      l.addSlur(opt);
      l.updateLyricY(opt);
      l.addSingleTempoMarks(opt, tempoMarks);
      const numberedEntry = l.entries.find((entry) => entry.syncDisplayNumber !== null);
      if (numberedEntry) {
        addSystemMeasureNumber(
          l.group,
          numberedEntry.group.x + entryRhythmAnchor(numberedEntry),
          numberedEntry.syncDisplayNumber,
          opt,
        );
      }
      l.group.normalizeY();
      l.group.update();
      l.addRhythmGuide(opt);
    }
    return this.layoutVertically(lines, opt, height, firstHeaderReserve);
  }

  private rhythmAnchorX(entry: Entry): number {
    if (entry instanceof NoteEntry && entry.number) {
      return entry.group.x + entry.number.x + entry.number.cx;
    }
    const item = entry.entryItem();
    return entry.group.x + (item ? item.x + item.width / 2 : entry.group.width / 2);
  }

  private addSingleTempoMarks(opt: LayoutOptions, marks: readonly S.TempoMark[]): void {
    if (marks.length === 0) return;
    const positioned = this.entries
      .filter((entry) => entry.syncSourceMeasure >= 0)
      .map((entry) => ({ entry, x: this.rhythmAnchorX(entry) }));
    const contentTop = this.group.childrenBound.top;
    addTempoAnnotations(
      this.group,
      marks,
      positioned,
      opt,
      (_mark, marker) => contentTop - marker.height - opt.numberSize * 0.18,
    );
  }

  rhythmGuideEntries(offsetX = 0): Array<{ entry: Entry; x: number }> {
    return this.entries
      .filter((entry) => entry.syncMeasure >= 0 && (entry instanceof NoteEntry || entry instanceof Barline))
      .map((entry) => ({ entry, x: offsetX + this.rhythmAnchorX(entry) }));
  }

  addRhythmGuide(
    opt: LayoutOptions,
    positionedEntries: Array<{ entry: Entry; x: number }> = this.rhythmGuideEntries(),
    target: Group = this.group,
    baselineY = this.group.height + opt.numberSize * 0.46,
    updateTarget = true,
  ): void {
    const style = opt.engravingStyle;
    if (!style.rhythmGuideEnabled) return;
    const byMeasure = new Map<number, Array<{ entry: Entry; x: number }>>();
    for (const positioned of positionedEntries) {
      const list = byMeasure.get(positioned.entry.syncMeasure) ?? [];
      list.push(positioned);
      byMeasure.set(positioned.entry.syncMeasure, list);
    }
    if (byMeasure.size === 0) return;

    const strokeWidth = Math.max(0.8, opt.numberSize * 0.038);
    for (const [measureIndex, entries] of byMeasure) {
      const anchors = entries.map((positioned) => ({
        tick: positioned.entry.syncTick.toFloat(),
        x: positioned.x,
        entry: positioned.entry,
      })).sort((a, b) => a.tick - b.tick || a.x - b.x);
      const endAnchor = [...anchors].reverse().find((item) => item.entry instanceof Barline);
      if (!endAnchor || endAnchor.tick <= 1e-8 || anchors.length < 2) continue;

      const meterAnchor = anchors.find((anchor) =>
        anchor.entry.syncBeats > 0 && anchor.entry.syncBeatType > 0)?.entry;
      const beats = meterAnchor?.syncBeats ?? 4;
      const beatType = meterAnchor?.syncBeatType ?? 4;
      let minorDivision: number = Math.max(4, beatType);
      if (style.rhythmGuideMode === "manual") {
        minorDivision = Math.max(minorDivision, style.rhythmGuideDivision);
      } else {
        for (const anchor of anchors) {
          if (anchor.entry instanceof NoteEntry) {
            minorDivision = Math.max(minorDivision, Math.min(64, 4 * (1 << Math.max(0, anchor.entry.beams))));
          }
        }
      }
      const compound = beatType === 8 && beats >= 6 && beats % 3 === 0;
      const majorStep = compound ? 3 * 4 / beatType : 4 / beatType;
      const minorStep = 4 / minorDivision;
      const unique: Array<{ tick: number; x: number }> = [];
      for (const anchor of anchors) {
        const existing = unique.find((item) => Math.abs(item.tick - anchor.tick) < 1e-8);
        if (existing) existing.x = anchor.x;
        else unique.push({ tick: anchor.tick, x: anchor.x });
      }
      const xAt = (tick: number): number => {
        const exact = unique.find((item) => Math.abs(item.tick - tick) < 1e-8);
        if (exact) return exact.x;
        const rightIndex = unique.findIndex((item) => item.tick > tick);
        if (rightIndex <= 0) return unique[0].x;
        if (rightIndex < 0) return unique[unique.length - 1].x;
        const left = unique[rightIndex - 1], right = unique[rightIndex];
        const ratio = (tick - left.tick) / Math.max(1e-8, right.tick - left.tick);
        return left.x + (right.x - left.x) * ratio;
      };

      const baseline = new GraphicLine();
      baseline.classes.add("rhythm-guide-line");
      baseline.classes.add(`rhythm-guide-measure-${measureIndex}`);
      baseline.strokeColor = opt.color;
      baseline.strokeWidth = strokeWidth;
      baseline.p0 = new Point(xAt(0), baselineY);
      baseline.p1 = new Point(endAnchor.x, baselineY);
      target.add(baseline);

      const tickCount = Math.ceil(endAnchor.tick / minorStep - 1e-8);
      for (let index = 0; index < tickCount; index++) {
        const tick = index * minorStep;
        const majorRatio = tick / majorStep;
        const major = Math.abs(majorRatio - Math.round(majorRatio)) < 1e-7;
        const mark = new GraphicLine();
        mark.classes.add("rhythm-guide-tick");
        mark.classes.add(`rhythm-guide-measure-${measureIndex}`);
        mark.classes.add(major ? "rhythm-guide-major" : "rhythm-guide-minor");
        if (major) {
          mark.classes.add(`rhythm-guide-beat-${Math.round(majorRatio)}`);
        }
        mark.strokeColor = opt.color;
        mark.strokeWidth = strokeWidth;
        const x = xAt(tick);
        const height = opt.numberSize * (major ? 0.34 : 0.18);
        mark.p0 = new Point(x, baselineY);
        mark.p1 = new Point(x, baselineY - height);
        target.add(mark);
      }
    }
    if (updateTarget) target.update();
  }

  private getEntry(ch: S.Chord): NoteEntry | null {
    return this.chordEntry.get(ch) ?? null;
  }

  addTuplet(opt: LayoutOptions): void {
    const tuplets = new Set<S.Tuplet>();
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const t = e.chord.notes[0].tuplet;
      if (!t) continue;
      tuplets.add(t);
    }
    const numberSize = opt.numberFont.size;
    for (const t of tuplets) {
      const start = this.getEntry(t.first.chord);
      if (!start) {
        console.error("no begin entry for tuplet");
        continue;
      }
      const end = this.getEntry(t.last.chord);
      if (!end) {
        console.error("no end entry for tuplet");
        continue;
      }
      const leftItem = start.entryItem()! as JpNumber;
      const rightItem = end.entryItem()! as JpNumber;
      const left = leftItem.pos(this.group).x + leftItem.cx;
      let right = rightItem.pos(this.group).x + rightItem.cx;
      if (end.beginOfSlurTied) right -= opt.numberSize / 14;
      const width = right - left;
      const ypos = Math.min(start.entryTop(opt), end.entryTop(opt));
      const y = -numberSize * 0.25;
      const tupGrp = new Group();
      tupGrp.x = left;
      tupGrp.y = ypos;
      const path = new GraphicPath();
      path.strokeWidth = 1;
      path.fill = false;
      path.stroke = true;
      path.strokeColor = opt.color;
      path.moveTo(0, 0);
      path.lineTo(0, y);
      path.lineTo(width / 2 - numberSize / 3, y);
      path.moveTo(width, 0);
      path.lineTo(width, y);
      path.lineTo(width / 2 + numberSize / 3, y);
      const txt = new SmuflText(opt);
      txt.color = opt.color;
      txt.text = GlyphCodes.tuplet3;
      const w = txt.measureText();
      txt.x = width / 2 - w / 2;
      txt.y = -numberSize * 0.05;
      tupGrp.add(path);
      tupGrp.add(txt);
      this.group.add(tupGrp);
    }
  }

  addBeams(opt: LayoutOptions): void {
    const groups = new Set<S.BeamGroup>();
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const grp = e.chord.beamGroup;
      if (!grp) continue;
      groups.add(grp);
    }
    let maxLev = 0;
    for (const g of groups) {
      let level = 1;
      for (;;) {
        const pairs = new Map<NoteEntry, NoteEntry>();
        let start: NoteEntry | null = null;
        for (const ch of g.chords) {
          if (ch.beams < level) {
            start = null;
            continue;
          }
          if (start === null) start = this.getEntry(ch);
          if (start === null || this.getEntry(ch) === null) continue;
          pairs.set(start, this.getEntry(ch)!);
        }
        if (pairs.size === 0) break;
        maxLev = Math.max(maxLev, level);
        for (const [k, v] of pairs) {
          const l = new BeamLine(level, k, v, opt);
          this.beams.push(l);
          this.group.add(l);
        }
        level++;
      }
    }
    this.maxBeamLevel = maxLev;
  }

  updateLyricY(opt: LayoutOptions): void {
    let dy = opt.numberSize * 0.4;
    for (const e of this.entries) {
      if (e instanceof NoteEntry) {
        const ey = e.entryBottom(opt);
        dy = Math.max(dy, ey);
      }
    }
    for (const e of this.entries) {
      if (e instanceof NoteEntry) {
        if (e.lrc === null) continue;
        e.lrc.y += dy;
      }
    }
  }

  connectTextFrames(): void {
    const lrcs: Lyric[] = [];
    const numbers: TextFrame[] = [];
    for (const it of this.entries) {
      if (it instanceof Barline) {
        const tf = it.group.children[0];
        if (tf instanceof TextFrame) numbers.push(tf);
      }
      if (!(it instanceof NoteEntry)) continue;
      if (it.lrc) lrcs.push(it.lrc);
      if (it.number) numbers.push(it.number);
    }
    lrcs.forEach((it, idx) => {
      it.previous = getOrNull(lrcs, idx - 1);
      it.next = getOrNull(lrcs, idx + 1);
    });
    numbers.forEach((it, idx) => {
      it.previous = getOrNull(numbers, idx - 1);
      it.next = getOrNull(numbers, idx + 1);
    });
  }

  load(
    m: S.Measure,
    lrc: number,
    options: LayoutOptions,
    final: boolean,
    syncMeasure = m.index,
  ): void {
    const mark = (e: Entry, tick: Fraction, order: number): void => {
      e.syncMeasure = syncMeasure;
      e.syncSourceMeasure = m.index;
      e.syncTick = tick;
      e.syncOrder = order;
      e.syncBeats = m.time.beats;
      e.syncBeatType = m.time.beatType;
      e.syncPickup = m.pickup;
      e.syncDisplayNumber = m.displayNumber;
      e.group.classes.add(`measure-${syncMeasure}`);
      if (order === 3) e.group.classes.add("measure-barline");
    };
    if (m.timeChange && m.index !== 0) {
      const ts = TimeSig.fromTime(m.time, options);
      mark(ts, new Fraction(0), 1);
      this.entries.push(ts);
    }
    if (m.keyChange && m.index !== 0) {
      const key = new KeySig(m.key, options);
      mark(key, new Fraction(0), 0);
      const first = m.entries[0];
      if (first instanceof S.Chord) {
        if (first.slurStart) key.group.y -= options.numberSize / 4;
      }
      this.entries.push(key);
    }
    let hasBarline = false;
    for (const ch of m.entries) {
      if (ch instanceof S.LineBreak) {
        const ignore = ch.pass !== null && ch.pass !== lrc;
        if (!ignore) {
          const br = new LineBreak();
          br.newPage = ch.newPage;
          mark(br, ch.position, 4);
          this.entries.push(br);
        }
        continue;
      } else if (ch instanceof S.Chord) {
        const begin = this.entries.length;
        NoteEntry.fromChord(this.entries, ch, lrc, options);
        for (let i = begin; i < this.entries.length; i++) {
          mark(this.entries[i], ch.position.plus(new Fraction(i - begin)), 2);
        }
      } else if (ch instanceof S.BarlineEntry) {
        const ent = new Barline(final, options);
        ent.update();
        mark(ent, ch.position, 3);
        this.entries.push(ent);
        hasBarline = true;
      }
    }
    if (!hasBarline) {
      const ent = new Barline(final, options);
      ent.update();
      mark(ent, m.duration, 3);
      if (this.entries[this.entries.length - 1] instanceof LineBreak) {
        this.entries.splice(this.entries.length - 1, 0, ent);
      } else {
        this.entries.push(ent);
      }
    }
  }

  /** Add beams/slurs/lyrics after piano code has assigned shared x positions. */
  finishPiano(options: LayoutOptions): void {
    this.connectTextFrames();
    this.addBeams(options);
    this.addTuplet(options);
    this.addTie(options);
    this.addSlur(options);
    this.updateLyricY(options);
    this.group.normalizeY();
    this.group.update();
  }
}

// ---------------- options / CJK util ----------------

export class CJKUtil {
  static readonly halfPunctMap: Record<string, string> = {
    "。": "｡", "，": ",", "、": "､", "？": "?", "！": "!", "：": ":", "；": ";",
  };
  static toHalfWidth(s: string): string {
    let res = "";
    for (const c of s) res += CJKUtil.halfPunctMap[c] ?? c;
    return res;
  }
}

export class LayoutOptions {
  static charBound(font: Font, ch: string): Rect {
    return font.charBound(ch);
  }

  color = Colors.black;
  lrcFont: Font;
  numberFont: Font;
  smuflFont: Font;
  smuflMeta = new MetaData();
  titleSize = 48;
  creditSize = 36;

  smuflAsPath = false;
  halfWidthPunct = true;
  ignoreVerseNumber = true;
  slurTieThickness = 4;
  staffDist = 0;
  marginTop: number;
  marginBottom: number;
  marginLeft = 50;
  maxLineDist: number;
  maxHorizontalScale = 2.0;
  jpBeamDist: number;
  engravingStyle: EngravingStyle = normalizeEngravingStyle();

  constructor(public fontSize: number) {
    // Original used 苹方-简 / Microsoft YaHei; in the webview we rely on the
    // system CJK font via a CSS stack.
    const cjk = "PingFang SC, Microsoft YaHei, Microsoft YaHei UI, 微软雅黑, Source Han Sans SC, Noto Sans CJK SC, Yu Gothic UI, Meiryo, Malgun Gothic, Arial Unicode MS, SimSun, sans-serif";
    this.lrcFont = new Font(cjk, fontSize);
    this.numberFont = new Font(cjk, fontSize);
    this.smuflFont = new Font("Bravura", fontSize);
    this.marginTop = fontSize * 1.5;
    this.marginBottom = fontSize * 3;
    this.maxLineDist = fontSize * 0.75;
    this.jpBeamDist = fontSize / 8;
    this.applyEngravingStyle(this.engravingStyle);
  }

  get lrcSize(): number {
    return this.lrcFont.size;
  }
  set lrcSize(v: number) {
    this.lrcFont = this.lrcFont.makeWithSize(v);
  }
  get numberSize(): number {
    return this.numberFont.size;
  }
  set numberSize(v: number) {
    this.numberFont = this.numberFont.makeWithSize(v);
  }

  applyEngravingStyle(style: Partial<EngravingStyle>): void {
    this.engravingStyle = normalizeEngravingStyle(style);
    this.numberFont = new Font(
      this.lrcFont.family,
      this.fontSize * this.engravingStyle.numberScale,
      this.engravingStyle.numberBold,
    );
    this.jpBeamDist = this.numberSize / 8;
  }

  numberBound(ch: string): Rect {
    return LayoutOptions.charBound(this.numberFont, ch);
  }

  octaveDotDiameter(): number {
    return Math.max(0.5, this.numberSize * 0.16 * this.engravingStyle.octaveDotScale);
  }

  octaveDotGap(): number {
    return Math.max(0.35, this.numberSize * 0.055 * this.engravingStyle.octaveDotDistance);
  }

  /** Fixed blank space between notation systems; it also drives pagination. */
  systemGap(): number {
    return Math.max(this.staffDist, this.numberSize * 2 * this.engravingStyle.systemGapScale);
  }
}

interface PianoChunk {
  right: Entry[];
  left: Entry[];
  pickup: boolean;
  displayNumber: number | null;
  forceAfter: boolean;
  pageAfter: boolean;
  breakBefore: boolean;
  pageBefore: boolean;
}

interface PianoSystem {
  group: Group;
  pageAfter: boolean;
}

interface PianoSystemGeometry {
  systemLeftX: number;
  musicStart: number;
  braceWidth: number;
  braceLeft: number;
  instrumentFont: Font;
  instrumentX: number;
}

interface EnsembleChunk {
  rows: Entry[][];
  pickup: boolean;
  displayNumber: number | null;
  forceAfter: boolean;
  pageAfter: boolean;
  breakBefore: boolean;
  pageBefore: boolean;
}

interface EnsembleGroup {
  name: string;
  rows: number[];
}

interface EnsembleSystemGeometry {
  bracketLeft: number;
  labelX: number;
  braceLeft: number;
  braceWidth: number;
  systemLeftX: number;
  musicStart: number;
  instrumentFont: Font;
}

interface PianoSlot {
  measure: number;
  tick: Fraction;
  order: number;
  entries: Entry[];
  left: number;
  right: number;
  x: number;
}

function pianoEntryAnchor(e: Entry): number {
  const it = e.entryItem();
  if (it === null) return e.group.width / 2;
  if (e instanceof NoteEntry && e.number) return it.x + e.number.cx;
  return it.x + it.width / 2;
}

function pianoSlotKey(e: Entry): string {
  if (e instanceof Barline) return `${e.syncMeasure}|bar|${e.syncOrder}`;
  return `${e.syncMeasure}|${e.syncTick.toString()}|${e.syncOrder}`;
}

/** Assign one shared rhythmic x-axis to a right/left pair; returns used width. */
function alignPianoEntries(
  right: Entry[],
  left: Entry[],
  opt: LayoutOptions,
  targetWidth: number | null,
): number {
  const slotsByKey = new Map<string, PianoSlot>();
  for (const e of [...right, ...left]) {
    e.update();
    const key = pianoSlotKey(e);
    let slot = slotsByKey.get(key);
    if (!slot) {
      slot = {
        measure: e.syncMeasure,
        tick: e.syncTick,
        order: e.syncOrder,
        entries: [],
        left: 0,
        right: 0,
        x: 0,
      };
      slotsByKey.set(key, slot);
    } else if (e instanceof Barline && e.syncTick.compareTo(slot.tick) > 0) {
      slot.tick = e.syncTick;
    }
    slot.entries.push(e);
    const anchor = pianoEntryAnchor(e);
    slot.left = Math.max(slot.left, anchor);
    slot.right = Math.max(slot.right, Math.max(0, e.group.width - anchor));
  }
  const slots = [...slotsByKey.values()].sort((a, b) =>
    a.measure - b.measure || a.tick.compareTo(b.tick) || a.order - b.order,
  );
  if (slots.length === 0) return 0;

  slots[0].x = slots[0].left;
  for (let i = 1; i < slots.length; i++) {
    const prev = slots[i - 1];
    const cur = slots[i];
    const nearBarline = prev.order === 3 || cur.order <= 1;
    const gap = opt.numberSize * (nearBarline ? 0.62 : 0.5) * opt.engravingStyle.noteGapScale;
    cur.x = prev.x + prev.right + gap + cur.left;
  }
  let used = slots[slots.length - 1].x + slots[slots.length - 1].right;
  if (targetWidth !== null && slots.length > 1 && targetWidth > used) {
    // Publication-style piano numbered notation aligns every system, including
    // sparse final systems, to the same right edge (the final double barline).
    const extra = targetWidth - used;
    for (let i = 1; i < slots.length; i++) slots[i].x += (extra * i) / (slots.length - 1);
    used += extra;
  }
  for (const slot of slots) {
    for (const e of slot.entries) e.group.x = slot.x - pianoEntryAnchor(e);
  }
  return used;
}

export class Layout {
  options: LayoutOptions;
  pages: Group[] = [];
  constructor(public fontSize: number) {
    this.options = new LayoutOptions(fontSize);
  }

  private parseBreakDur(s: string): Map<string, number> {
    const pgs = s.replace(/\|/g, "\n").replace(/\./g, " ").split("\n");
    const res = new Map<string, number>();
    let last = new Fraction(0);
    for (const pg of pgs) {
      if (pg.length === 0) continue;
      const lines = pg.split(" ");
      for (const it of lines) {
        if (it.trim().length === 0) continue;
        let str = it.trim();
        let v = 1;
        if (str.includes("{")) {
          v = 0;
          str = str.replace(/\{/g, "").replace(/\}/g, "");
        }
        const dur = Fraction.fromString(str);
        last = last.plus(dur);
        res.set(last.toString(), v);
      }
      res.set(last.toString(), 2);
    }
    return res;
  }

  durationInfo(s: string, total: Fraction, pass: number | null): Map<string, number> {
    const durInfo = new Map<string, number>();
    const ss = substringAfter(s, "=").trim();
    if (s.includes("LinesPerPage")) {
      const arr = ss.split("|").map((x) => parseInt(x, 10));
      const lineCnt = arr.reduce((a, b) => a + b, 0);
      const dur = total.divInt(lineCnt);
      let pos = new Fraction(0);
      for (const it of arr) {
        for (let i = 0; i < it; i++) {
          const v = i === it - 1 ? 2 : 1;
          pos = pos.plus(dur);
          durInfo.set(pos.toString(), v);
        }
      }
    } else {
      for (const [k, v] of this.parseBreakDur(ss)) durInfo.set(k, v);
    }
    if (pass !== null) {
      const keys = [...durInfo.keys()];
      for (let i = 1; i < pass; i++) {
        for (const k of keys) {
          const t = Fraction.fromString(k).plus(total.timesInt(i));
          durInfo.set(t.toString(), durInfo.get(k)!);
        }
      }
    }
    return durInfo;
  }

  breakByDur(l: Line, s: string, total: Fraction, pass: number | null): void {
    const durInfo = this.durationInfo(s, total, pass);
    let tick = new Fraction(0);
    const newEnt: Entry[] = [];
    let lineBeg = 0;
    let lastChord: S.Chord | null = null;
    let lastTick: Fraction | null = null;
    for (const e of l.entries) {
      let isNote = false;
      let end = tick;
      if (e instanceof NoteEntry) {
        const ch = e.chord;
        if (ch !== lastChord) {
          isNote = true;
          end = end.plus(ch.duration!);
          lastChord = ch;
        }
      }
      let doBreak = durInfo.has(tick.toString());
      if (!(isNote || e instanceof KeySig)) doBreak = false;
      if (lastTick !== null && lastTick.equals(tick)) doBreak = false;
      if (doBreak) {
        if (durInfo.get(tick.toString()) === 0) {
          while (newEnt.length > lineBeg) newEnt.splice(lineBeg, 1);
        } else {
          const br = new LineBreak();
          br.newPage = durInfo.get(tick.toString()) === 2;
          newEnt.push(br);
          lineBeg = newEnt.length;
        }
        lastTick = tick;
      }
      newEnt.push(e);
      tick = end;
    }
    l.entries = newEnt;
  }

  private pianoChunks(scr: S.Score): PianoChunk[] {
    const rightPart = scr.parts[0];
    const leftPart = scr.parts[1];
    const ranges = scr.playData.measures.length > 0
      ? scr.playData.measures
      : [{ mid: 0, end: Math.max(rightPart.measures.length, leftPart.measures.length), pass: 1, endOfPass: false }];
    const sequence: Array<{ mid: number; pass: number; pageAfter: boolean }> = [];
    for (const range of ranges) {
      for (let mid = range.mid; mid < range.end; mid++) {
        sequence.push({
          mid,
          pass: range.pass,
          pageAfter: Boolean(range.endOfPass && mid === range.end - 1),
        });
      }
    }

    const chunks: PianoChunk[] = [];
    for (let flow = 0; flow < sequence.length; flow++) {
      const item = sequence[flow];
      const rm = rightPart.measures[item.mid];
      const lm = leftPart.measures[item.mid];
      const final = flow === sequence.length - 1;
      const make = (m: S.Measure | undefined, fallback: S.Measure | undefined): Entry[] => {
        if (m) {
          m.autoBeamGroup();
          const line = new Line();
          line.load(m, item.pass, this.options, final, flow);
          return line.entries;
        }
        // Keep a barline in a temporarily incomplete hand while the user is
        // typing, so the paired editor remains live instead of failing parse.
        const bar = new Barline(final, this.options);
        bar.update();
        bar.syncMeasure = flow;
        bar.syncSourceMeasure = item.mid;
        bar.syncTick = fallback?.duration ?? new Fraction(4);
        bar.syncOrder = 3;
        bar.syncBeats = fallback?.time.beats ?? 4;
        bar.syncBeatType = fallback?.time.beatType ?? 4;
        bar.syncPickup = fallback?.pickup ?? false;
        bar.syncDisplayNumber = fallback?.displayNumber ?? null;
        return [bar];
      };
      const rentries = make(rm, lm);
      const lentries = make(lm, rm);
      const breaks = [...rentries, ...lentries].filter((e): e is LineBreak => e instanceof LineBreak);
      chunks.push({
        right: rentries.filter((e) => !(e instanceof LineBreak)),
        left: lentries.filter((e) => !(e instanceof LineBreak)),
        pickup: Boolean(rm?.pickup || lm?.pickup),
        displayNumber: (rm ?? lm)?.displayNumber ?? null,
        forceAfter: breaks.length > 0 || item.pageAfter,
        pageAfter: breaks.some((e) => e.newPage) || item.pageAfter,
        breakBefore: Boolean(rm?.newSystem || lm?.newSystem),
        pageBefore: Boolean(rm?.newPage || lm?.newPage),
      });
    }
    return chunks;
  }

  private ensembleGroups(scr: S.Score): EnsembleGroup[] {
    const groups: EnsembleGroup[] = [];
    const byName = new Map<string, EnsembleGroup>();
    scr.parts.forEach((part, row) => {
      const name = part.instrumentName.trim() || `乐器 ${row + 1}`;
      let group = byName.get(name);
      if (!group) {
        group = { name, rows: [] };
        byName.set(name, group);
        groups.push(group);
      }
      group.rows.push(row);
    });
    return groups;
  }

  private ensembleChunks(scr: S.Score): EnsembleChunk[] {
    const measureCount = Math.max(0, ...scr.parts.map((part) => part.measures.length));
    const ranges = scr.playData.measures.length > 0
      ? scr.playData.measures
      : [{ mid: 0, end: measureCount, pass: 1, endOfPass: false }];
    const sequence: Array<{ mid: number; pass: number; pageAfter: boolean }> = [];
    for (const range of ranges) {
      for (let mid = range.mid; mid < range.end; mid++) {
        sequence.push({
          mid,
          pass: range.pass,
          pageAfter: Boolean(range.endOfPass && mid === range.end - 1),
        });
      }
    }

    const chunks: EnsembleChunk[] = [];
    for (let flow = 0; flow < sequence.length; flow++) {
      const item = sequence[flow];
      const measures = scr.parts.map((part) => part.measures[item.mid]);
      const fallback = measures.find((measure) => measure !== undefined);
      const final = flow === sequence.length - 1;
      const make = (measure: S.Measure | undefined): Entry[] => {
        if (measure) {
          measure.autoBeamGroup();
          const line = new Line();
          line.load(measure, item.pass, this.options, final, flow);
          return line.entries;
        }
        const bar = new Barline(final, this.options);
        bar.update();
        bar.syncMeasure = flow;
        bar.syncSourceMeasure = item.mid;
        bar.syncTick = fallback?.duration ?? new Fraction(4);
        bar.syncOrder = 3;
        bar.syncBeats = fallback?.time.beats ?? 4;
        bar.syncBeatType = fallback?.time.beatType ?? 4;
        bar.syncPickup = fallback?.pickup ?? false;
        bar.syncDisplayNumber = fallback?.displayNumber ?? null;
        return [bar];
      };
      const loaded = measures.map(make);
      const breaks = loaded.flat().filter((entry): entry is LineBreak => entry instanceof LineBreak);
      chunks.push({
        rows: loaded.map((entries) => entries.filter((entry) => !(entry instanceof LineBreak))),
        pickup: measures.some((measure) => measure?.pickup),
        displayNumber: fallback?.displayNumber ?? null,
        forceAfter: breaks.length > 0 || item.pageAfter,
        pageAfter: breaks.some((entry) => entry.newPage) || item.pageAfter,
        breakBefore: measures.some((measure) => measure?.newSystem),
        pageBefore: measures.some((measure) => measure?.newPage),
      });
    }
    return chunks;
  }

  private pianoSystemGeometry(instrumentName: string, continuationBraceLeft: number | null = null): PianoSystemGeometry {
    const style = this.options.engravingStyle;
    const numberSize = this.options.numberSize;
    const instrumentFont = this.options.lrcFont.scaled(0.56 / 1.5);
    // Width and weight are independent controls. The former 11-unit floor
    // swallowed most of the lower half of the width slider, while multiplying
    // weight into width made both controls change the same geometry.
    const braceWidth = Math.max(numberSize * 0.08, numberSize * 0.52 * style.braceWidthScale);
    const instrumentWidth = instrumentFont.measureText(instrumentName);
    const systemLeftX = continuationBraceLeft === null
      ? Math.max(68, 1 + instrumentWidth + numberSize * 0.25 + braceWidth + numberSize * 0.12)
      : Math.max(1, continuationBraceLeft) + braceWidth + numberSize * 0.12;
    const braceLeft = continuationBraceLeft === null
      ? systemLeftX - numberSize * 0.12 - braceWidth
      : Math.max(1, continuationBraceLeft);
    const instrumentX = Math.max(1, braceLeft - numberSize * 0.22 - instrumentWidth);
    return {
      systemLeftX,
      musicStart: systemLeftX + numberSize * 0.62,
      braceWidth,
      braceLeft,
      instrumentFont,
      instrumentX,
    };
  }

  private ensembleSystemGeometry(groups: EnsembleGroup[]): EnsembleSystemGeometry {
    const style = this.options.engravingStyle;
    const numberSize = this.options.numberSize;
    const instrumentFont = this.options.lrcFont.scaled(0.56 / 1.5);
    const bracketLeft = 1;
    const labelX = groups.length >= 2 ? bracketLeft + numberSize * 0.42 : bracketLeft;
    const labelWidth = Math.max(0, ...groups.map((group) => instrumentFont.measureText(group.name)));
    const braceWidth = Math.max(numberSize * 0.08, numberSize * 0.52 * style.braceWidthScale);
    const braceLeft = labelX + labelWidth + numberSize * 0.18;
    const hasMultiVoiceInstrument = groups.some((group) => group.rows.length >= 2);
    const systemLeftX = hasMultiVoiceInstrument
      ? braceLeft + braceWidth + numberSize * 0.12
      : labelX + labelWidth + numberSize * 0.38;
    return {
      bracketLeft,
      labelX,
      braceLeft,
      braceWidth,
      systemLeftX,
      musicStart: systemLeftX + numberSize * 0.62,
      instrumentFont,
    };
  }

  private makePianoSystem(
    chunks: PianoChunk[],
    width: number,
    pageAfter: boolean,
    instrumentName: string,
    showInstrument: boolean,
    geometry: PianoSystemGeometry,
    tempoMarks: readonly S.TempoMark[],
    horizontalMeasures: readonly HorizontalMeasureLayout<Entry>[] | null = null,
  ): PianoSystem {
    const rightEntries = chunks.flatMap((c) => c.right);
    const leftEntries = chunks.flatMap((c) => c.left);
    const right = new Line();
    const left = new Line();
    right.addEntries(rightEntries);
    left.addEntries(leftEntries);

    const style = this.options.engravingStyle;
    const { systemLeftX, musicStart, braceWidth, braceLeft, instrumentFont, instrumentX } = geometry;
    if (horizontalMeasures) {
      for (const measure of horizontalMeasures) {
        for (const column of measure.columns) {
          for (const entry of column.items) {
            entry.group.x = measure.x + column.x - entryRhythmAnchor(entry);
          }
        }
      }
    } else {
      const musicWidth = Math.max(this.options.numberSize * 4, width - musicStart);
      alignPianoEntries(rightEntries, leftEntries, this.options, musicWidth);
    }
    right.finishPiano(this.options);
    left.finishPiano(this.options);

    const pair = new Group();
    pair.classes.add("piano-system");
    if (horizontalMeasures) pair.classes.add("rhythmic-system");
    const handGap = this.options.numberSize * style.pianoHandGap;
    right.group.x += musicStart;
    right.group.y = 0;
    left.group.x += musicStart;
    left.group.y = right.group.height + handGap;
    pair.add(right.group);
    pair.add(left.group);

    // Keep every system on the same left edge even though only the first one
    // prints the instrument name.
    const leftAnchor = new GraphicLine();
    leftAnchor.strokeColor = 0x00000000;
    leftAnchor.strokeWidth = 0;
    leftAnchor.p0 = new Point(0, 0);
    leftAnchor.p1 = new Point(1, 1);
    pair.add(leftAnchor);

    const y0 = 0;
    const y1 = left.group.y + left.group.height;
    const tempoEntries = (right.entries.length > 0 ? right.entries : left.entries)
      .map((entry) => ({
        entry,
        x: (right.entries.length > 0 ? right.group.x : left.group.x) +
          entry.group.x + pianoEntryAnchor(entry),
      }));
    addTempoAnnotations(
      pair,
      tempoMarks,
      tempoEntries,
      this.options,
      (mark, marker) => mark.kind === "tempo"
        // Leave the compact measure number sitting directly above the brace;
        // a tempo change on the first beat belongs in the next tier above it.
        ? y0 - marker.height - this.options.numberSize * 0.42
        : right.group.y + right.group.height + (handGap - marker.height) / 2,
    );
    if (style.rhythmGuideEnabled) {
      const positioned = [
        ...right.rhythmGuideEntries(right.group.x),
        ...left.rhythmGuideEntries(left.group.x),
      ];
      // One shared ruler below the lower hand uses the already synchronized
      // piano x-axis. The brace and connecting barlines still end at the hand
      // rows; the ruler occupies its own additional row underneath.
      left.addRhythmGuide(
        this.options,
        positioned,
        pair,
        y1 + this.options.numberSize * 0.46,
        false,
      );
    }
    if (showInstrument && instrumentName.trim()) {
      const tf = new TextFrame();
      tf.text = instrumentName;
      tf.font = instrumentFont;
      tf.color = this.options.color;
      tf.update();
      tf.x = instrumentX;
      const metrics = instrumentFont.metrics;
      tf.y = (y0 + y1) / 2 - (metrics.ascent + metrics.descent) / 2;
      pair.add(tf);
    }

    // Use Bravura's actual SMuFL staff brace and scale it to the paired rows.
    // This preserves the familiar engraved thick/thin silhouette instead of
    // approximating it with a single stroked bezier curve.
    const braceBox = this.options.smuflMeta.getBBox(GlyphCodes.brace);
    const baseWidth = braceBox
      ? Math.max(0.1, (braceBox.bBoxNE[0] - braceBox.bBoxSW[0]) * this.options.smuflFont.size / 4)
      : this.options.smuflFont.size * 0.08;
    const baseHeight = braceBox
      ? Math.max(0.1, (braceBox.bBoxNE[1] - braceBox.bBoxSW[1]) * this.options.smuflFont.size / 4)
      : this.options.smuflFont.size;
    // A non-scaling outline changes the filled SMuFL brace's visual weight.
    // Compress the fill by the same amount so braceWidth remains the requested
    // outer width instead of growing when only the weight slider is moved.
    const braceGlyphWidth = Math.max(braceWidth * 0.2, braceWidth - style.braceStrokeWidth);
    const braceGroup = new Group();
    braceGroup.classes.add("piano-brace");
    const braceMatrix = new Matrix33();
    braceMatrix.setAffine([braceGlyphWidth / baseWidth, 0, 0, (y1 - y0) / baseHeight, braceLeft + style.braceStrokeWidth / 2, y1]);
    braceGroup.matrix = braceMatrix;
    const braceGlyph = new SmuflText(this.options);
    braceGlyph.classes.add("piano-brace-glyph");
    braceGlyph.text = GlyphCodes.brace;
    braceGlyph.color = this.options.color;
    braceGlyph.strokeColor = this.options.color;
    braceGlyph.strokeWidth = style.braceStrokeWidth;
    braceGlyph.nonScalingStroke = true;
    braceGroup.add(braceGlyph);
    pair.add(braceGroup);

    // Piano-system left edge: the brace terminates on one continuous vertical
    // line, matching conventional paired numbered-notation engraving.
    const systemLeft = new GraphicLine();
    systemLeft.classes.add("piano-system-left");
    systemLeft.strokeColor = this.options.color;
    systemLeft.strokeWidth = style.pianoLeftLineWidth;
    systemLeft.p0 = new Point(systemLeftX, y0);
    systemLeft.p1 = new Point(systemLeftX, y1);
    pair.add(systemLeft);

    // Join matching measure barlines through the gap.  Their x coordinates
    // already come from the shared rhythmic axis, so this also makes alignment
    // visually obvious when editing either hand.
    const leftBars = new Map<string, Barline>();
    for (const e of left.entries) if (e instanceof Barline) leftBars.set(pianoSlotKey(e), e);
    const extendBarline = (x: number, fromY: number, toY: number, strokeWidth: number): void => {
      if (toY - fromY <= 0.01) return;
      const extension = new GraphicLine();
      extension.classes.add("piano-barline-extension");
      extension.strokeColor = this.options.color;
      extension.strokeWidth = strokeWidth;
      extension.p0 = new Point(x, fromY);
      extension.p1 = new Point(x, toY);
      pair.add(extension);
    };
    for (const rb of right.entries) {
      if (!(rb instanceof Barline)) continue;
      const lb = leftBars.get(pianoSlotKey(rb));
      if (!lb) continue;
      const rlines = rb.group.children.filter((x): x is GraphicLine => x instanceof GraphicLine);
      const llines = lb.group.children.filter((x): x is GraphicLine => x instanceof GraphicLine);
      for (let i = 0; i < Math.min(rlines.length, llines.length); i++) {
        const ri = rlines[i], li = llines[i];
        const rp = ri.pos(pair);
        const lp = li.pos(pair);
        const connector = new GraphicLine();
        connector.classes.add("piano-barline-connector");
        connector.strokeColor = this.options.color;
        connector.strokeWidth = Math.max(ri.strokeWidth, li.strokeWidth) * style.pianoConnectorScale;
        connector.p0 = new Point(rp.x, rp.y + ri.height);
        connector.p1 = new Point(lp.x, lp.y);
        pair.add(connector);

        // A hand-local barline only spans the number row. Chords and octave
        // dots can make the brace-side system line taller, so extend every
        // matched barline to the exact same y0/y1 limits. Keep the middle
        // connector separate so its user-adjustable weight still applies.
        extendBarline(rp.x, y0, rp.y, ri.strokeWidth);
        extendBarline(lp.x, lp.y + li.height, y1, li.strokeWidth);
      }
    }
    if (horizontalMeasures) {
      const numberedMeasure = horizontalMeasures.find((measure) => measure.displayNumber !== null);
      if (numberedMeasure) {
        addSystemMeasureNumber(
          pair,
          braceLeft,
          numberedMeasure.displayNumber,
          this.options,
          y0,
        );
      }
    } else {
      const numberedEntry = [...rightEntries, ...leftEntries]
        .find((entry) => entry.syncDisplayNumber !== null);
      if (numberedEntry) {
        addSystemMeasureNumber(pair, braceLeft, numberedEntry.syncDisplayNumber, this.options, y0);
      }
    }
    pair.update();
    return { group: pair, pageAfter };
  }

  private makeEnsembleSystem(
    chunks: EnsembleChunk[],
    width: number,
    pageAfter: boolean,
    groups: EnsembleGroup[],
    geometry: EnsembleSystemGeometry,
    tempoMarks: readonly S.TempoMark[],
    horizontalMeasures: readonly HorizontalMeasureLayout<Entry>[] | null = null,
  ): PianoSystem {
    const rowCount = chunks[0]?.rows.length ?? 0;
    const rowEntries = Array.from({ length: rowCount }, (_unused, row) =>
      chunks.flatMap((chunk) => chunk.rows[row] ?? []),
    );
    const lines = rowEntries.map((entries) => {
      const line = new Line();
      line.addEntries(entries);
      return line;
    });
    if (horizontalMeasures) {
      for (const measure of horizontalMeasures) {
        for (const column of measure.columns) {
          for (const entry of column.items) {
            entry.group.x = measure.x + column.x - entryRhythmAnchor(entry);
          }
        }
      }
    } else {
      const musicWidth = Math.max(this.options.numberSize * 4, width - geometry.musicStart);
      alignPianoEntries(rowEntries.flat(), [], this.options, musicWidth);
    }
    for (const line of lines) line.finishPiano(this.options);

    const system = new Group();
    system.classes.add("ensemble-system");
    if (horizontalMeasures) system.classes.add("rhythmic-system");
    const rowToGroup = new Map<number, number>();
    groups.forEach((group, groupIndex) => group.rows.forEach((row) => rowToGroup.set(row, groupIndex)));
    const intraGroupGap = this.options.numberSize * this.options.engravingStyle.pianoHandGap;
    const interGroupGap = intraGroupGap + Math.max(this.options.numberSize * 1.1, intraGroupGap * 0.75);
    // A rhythm guide belongs to one complete instrument group.  Reserve its
    // baseline below the group's bottom voice before positioning the next
    // instrument, so guides never collide with the following staff group and
    // pagination sees their real height.
    const guideReserve = this.options.engravingStyle.rhythmGuideEnabled
      ? this.options.numberSize * 0.58
      : 0;
    const rowTops: number[] = [];
    const rowBottoms: number[] = [];
    let y = 0;
    for (let row = 0; row < lines.length; row++) {
      const line = lines[row];
      line.group.x += geometry.musicStart;
      line.group.y = y;
      rowTops[row] = y;
      rowBottoms[row] = y + line.group.height;
      system.add(line.group);
      if (row + 1 < lines.length) {
        const sameInstrument = rowToGroup.get(row) === rowToGroup.get(row + 1);
        y = rowBottoms[row] + (sameInstrument ? intraGroupGap : interGroupGap + guideReserve);
      }
    }
    const y0 = rowTops[0] ?? 0;
    const y1 = rowBottoms[rowBottoms.length - 1] ?? 0;
    const tempoEntries = (lines[0]?.entries ?? []).map((entry) => ({
      entry,
      x: (lines[0]?.group.x ?? 0) + entry.group.x + pianoEntryAnchor(entry),
    }));
    addTempoAnnotations(
      system,
      tempoMarks,
      tempoEntries,
      this.options,
      (_mark, marker) => y0 - marker.height - this.options.numberSize * 0.18,
    );

    const style = this.options.engravingStyle;
    const braceBox = this.options.smuflMeta.getBBox(GlyphCodes.brace);
    const braceBaseWidth = braceBox
      ? Math.max(0.1, (braceBox.bBoxNE[0] - braceBox.bBoxSW[0]) * this.options.smuflFont.size / 4)
      : this.options.smuflFont.size * 0.08;
    const braceBaseHeight = braceBox
      ? Math.max(0.1, (braceBox.bBoxNE[1] - braceBox.bBoxSW[1]) * this.options.smuflFont.size / 4)
      : this.options.smuflFont.size;
    for (const group of groups) {
      const firstRow = group.rows[0];
      const lastRow = group.rows[group.rows.length - 1];
      const top = rowTops[firstRow] ?? y0;
      const bottom = rowBottoms[lastRow] ?? top;

      // One guide per instrument: all of that instrument's voices contribute
      // their rhythmic anchors, while the guide is drawn below its bottom row.
      if (style.rhythmGuideEnabled) {
        const groupLines = group.rows.map((row) => lines[row]).filter((line) => line !== undefined);
        if (groupLines.length > 0) {
          const positioned = groupLines.flatMap((line) => line.rhythmGuideEntries(line.group.x));
          groupLines[groupLines.length - 1].addRhythmGuide(
            this.options,
            positioned,
            system,
            bottom + this.options.numberSize * 0.46,
            false,
          );
        }
      }

      const label = new TextFrame();
      label.classes.add("ensemble-instrument-label");
      label.text = group.name;
      label.font = geometry.instrumentFont;
      label.color = this.options.color;
      label.update();
      label.x = geometry.labelX;
      const metrics = geometry.instrumentFont.metrics;
      label.y = (top + bottom) / 2 - (metrics.ascent + metrics.descent) / 2;
      system.add(label);

      if (group.rows.length >= 2) {
        const braceGlyphWidth = Math.max(
          geometry.braceWidth * 0.2,
          geometry.braceWidth - style.braceStrokeWidth,
        );
        const braceGroup = new Group();
        braceGroup.classes.add("ensemble-instrument-brace");
        const braceMatrix = new Matrix33();
        braceMatrix.setAffine([
          braceGlyphWidth / braceBaseWidth,
          0,
          0,
          (bottom - top) / braceBaseHeight,
          geometry.braceLeft + style.braceStrokeWidth / 2,
          bottom,
        ]);
        braceGroup.matrix = braceMatrix;
        const braceGlyph = new SmuflText(this.options);
        braceGlyph.classes.add("ensemble-instrument-brace-glyph");
        braceGlyph.text = GlyphCodes.brace;
        braceGlyph.color = this.options.color;
        braceGlyph.strokeColor = this.options.color;
        braceGlyph.strokeWidth = style.braceStrokeWidth;
        braceGlyph.nonScalingStroke = true;
        braceGroup.add(braceGlyph);
        system.add(braceGroup);
      }

      const groupLine = new GraphicLine();
      groupLine.classes.add("ensemble-group-line");
      groupLine.strokeColor = this.options.color;
      groupLine.strokeWidth = style.pianoLeftLineWidth;
      groupLine.p0 = new Point(geometry.systemLeftX, top);
      groupLine.p1 = new Point(geometry.systemLeftX, bottom);
      system.add(groupLine);

      const referenceBars = rowEntries[firstRow]?.filter((entry): entry is Barline => entry instanceof Barline) ?? [];
      for (const bar of referenceBars) {
        const linesInBar = bar.group.children.filter((item): item is GraphicLine => item instanceof GraphicLine);
        for (const barLine of linesInBar) {
          const pos = barLine.pos(system);
          const connector = new GraphicLine();
          connector.classes.add("ensemble-barline-connector");
          connector.strokeColor = this.options.color;
          connector.strokeWidth = barLine.strokeWidth * style.pianoConnectorScale;
          connector.p0 = new Point(pos.x, top);
          connector.p1 = new Point(pos.x, bottom);
          system.add(connector);
        }
      }
    }

    // A full-score bracket describes a relationship between instrument
    // groups.  One instrument (even with several internal voices) keeps its
    // own brace but must not receive a redundant outer square bracket.
    if (groups.length >= 2) {
      const bracketWidth = Math.max(1.2, this.options.engravingStyle.pianoLeftLineWidth);
      const hook = Math.max(5, this.options.numberSize * 0.24);
      // GraphicLine coordinates run along the stroke centre.  Start the hooks at
      // the vertical stroke's outer-left edge so their visible left edges align
      // and the square 90-degree joint has no half-stroke-width step.
      const hookLeft = geometry.bracketLeft - bracketWidth / 2;
      const bracket = new GraphicLine();
      bracket.classes.add("ensemble-bracket");
      bracket.strokeColor = this.options.color;
      bracket.strokeWidth = bracketWidth;
      bracket.p0 = new Point(geometry.bracketLeft, y0);
      bracket.p1 = new Point(geometry.bracketLeft, y1);
      system.add(bracket);
      const topHook = new GraphicLine();
      topHook.classes.add("ensemble-bracket-hook");
      topHook.strokeColor = this.options.color;
      topHook.strokeWidth = bracketWidth;
      topHook.p0 = new Point(hookLeft, y0);
      topHook.p1 = new Point(geometry.bracketLeft + hook, y0);
      system.add(topHook);
      const bottomHook = new GraphicLine();
      bottomHook.classes.add("ensemble-bracket-hook");
      bottomHook.strokeColor = this.options.color;
      bottomHook.strokeWidth = bracketWidth;
      bottomHook.p0 = new Point(hookLeft, y1);
      bottomHook.p1 = new Point(geometry.bracketLeft + hook, y1);
      system.add(bottomHook);
    }

    if (horizontalMeasures) {
      const numberedMeasure = horizontalMeasures.find((measure) => measure.displayNumber !== null);
      if (numberedMeasure) {
        addSystemMeasureNumber(
          system,
          geometry.musicStart + numberedMeasure.x,
          numberedMeasure.displayNumber,
          this.options,
          y0,
        );
      }
    }
    system.update();
    return { group: system, pageAfter };
  }

  private pianoLineLimits(dur: string | null): number[] | null {
    if (!dur || !/LinesPerPage/i.test(dur)) return null;
    const rhs = substringAfter(dur, "=").trim();
    const values = rhs.split("|").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
    return values.length > 0 ? values : null;
  }

  private publicationHeaderReserve(scr: S.Score): number {
    const hasTitleText = Boolean(scr.title.trim() || scr.subtitle.trim());
    const hasTitleBlock = Boolean(scr.title.trim() || scr.subtitle.trim() || scr.composer.trim() || scr.arranger.trim() || scr.lyricist.trim());
    const style = this.options.engravingStyle;
    const titleFontSize = Math.min(this.options.titleSize, this.options.numberSize * 1.25)
      * style.publicationTitleScale;
    const titleShift = hasTitleText ? titleFontSize : 0;
    const baseReserve = this.options.numberSize * (hasTitleBlock ? 3.85 : 2.35)
      + titleShift
      + this.options.numberSize * 0.35;
    // Keep metadata vertical movement and the requested metadata→first-system
    // gap independent. Defaults reproduce the historical 0.88-number gap.
    return Math.max(
      this.options.numberSize * 0.5,
      baseReserve
        + this.options.numberSize * style.publicationMetaYOffset
        + this.options.numberSize * (style.publicationFirstSystemGap - 0.88),
    );
  }

  private addPublicationHeader(page: Group, scr: S.Score, width: number, reserve: number): void {
    const opt = this.options;
    const style = opt.engravingStyle;
    // paginatePiano normalizes each page group and stores the first system's
    // absolute y in page.y. Move that offset back into the music children so
    // header items and systems share one page-local coordinate system.
    if (page.y !== 0) {
      for (const child of page.children) child.y += page.y;
      page.y = 0;
    }
    const addText = (
      text: string,
      font: Font,
      x: number,
      y: number,
      align: "left" | "center" | "right" = "left",
      className = "",
    ): void => {
      if (!text.trim()) return;
      const tf = new TextFrame();
      tf.text = text;
      tf.font = font;
      tf.color = opt.color;
      tf.classes.add("publication-header");
      if (className) tf.classes.add(className);
      const measured = tf.measureText();
      tf.x = align === "center" ? x - measured / 2 : align === "right" ? x - measured : x;
      tf.y = y;
      tf.update();
      page.add(tf);
    };

    const titleFont = opt.lrcFont.makeWithSize(
      Math.min(opt.titleSize, opt.numberSize * 1.25) * style.publicationTitleScale,
    );
    const subtitleFont = opt.lrcFont.makeWithSize(
      opt.numberSize * 0.62 * style.publicationSubtitleScale,
    );
    const metaFont = opt.lrcFont.makeWithSize(
      opt.numberSize * 0.87 * style.publicationMetaScale,
    );
    const creditFont = opt.lrcFont.makeWithSize(
      opt.numberSize * 0.52 * style.publicationCreditScale,
    );
    // Use the title font's own ascent, not the number size, to keep larger
    // publication titles fully inside the page instead of clipping their top.
    const titleY = titleFont.size * 2.2
      + opt.numberSize * (0.35 + style.publicationTitleYOffset);
    const subtitleY = titleY
      + opt.numberSize * (0.9 + style.publicationSubtitleYOffset);
    addText(
      scr.title,
      titleFont,
      width * style.publicationTitleX,
      titleY,
      "center",
      "publication-title",
    );
    addText(
      scr.subtitle,
      subtitleFont,
      width * style.publicationSubtitleX,
      subtitleY,
      "center",
      "publication-subtitle",
    );

    const first = scr.parts[0]?.measures[0];
    const metaY = opt.marginTop + reserve
      - opt.numberSize * style.publicationFirstSystemGap;
    if (first) {
      const rawKey = first.key.name;
      const displayKey = rawKey.startsWith("#") ? `${rawKey.slice(1)}♯` : rawKey.startsWith("b") ? `${rawKey.slice(1)}♭` : rawKey;
      const tempoSymbol = scr.tempoBeatUnit === "eighth"
        ? "♪"
        : scr.tempoBeatUnit === "dotted-quarter" ? "♩." : "♩";
      const displayTempo = S.tempoBpmForUnit(scr.tempoBpm, scr.tempoBeatUnit);
      const meta = `1=${displayKey}   ${first.time.beats}/${first.time.beatType}   ${tempoSymbol}=${S.formatTempoBpm(displayTempo)}`;
      addText(
        meta,
        metaFont,
        width * style.publicationMetaX,
        metaY,
        "left",
        "publication-meta",
      );
    }

    const explicitCredits = [
      scr.lyricist.trim() ? `作词：${scr.lyricist.trim()}` : "",
      scr.composer.trim() ? `作曲：${scr.composer.trim()}` : "",
      scr.arranger.trim() ? `编曲：${scr.arranger.trim()}` : "",
    ].filter(Boolean);
    const credits = explicitCredits.length > 0
      ? explicitCredits
      : scr.credit.filter((x) => x.type !== "title").flatMap((x) => x.text.split("\n").map((s) => s.trim()).filter(Boolean));
    const creditGap = creditFont.size * 1.18;
    const creditBottom = metaY + opt.numberSize * style.publicationCreditYOffset;
    credits.forEach((text, index) => {
      const y = creditBottom - (credits.length - 1 - index) * creditGap;
      addText(
        text,
        creditFont,
        width * style.publicationCreditX,
        y,
        "right",
        "publication-credit",
      );
    });
  }

  private paginatePiano(systems: PianoSystem[], height: number, dur: string | null, firstHeaderReserve = 0): Group[] {
    const pages: PianoSystem[][] = [];
    const limits = this.pianoLineLimits(dur);
    const systemGap = this.options.systemGap();
    let forcePage = false;
    for (const sys of systems) {
      let page = pages[pages.length - 1];
      const pageIndex = Math.max(0, pages.length - 1);
      const headerReserve = pageIndex === 0 ? firstHeaderReserve : 0;
      const limit = limits?.[Math.min(pageIndex, limits.length - 1)] ?? Number.POSITIVE_INFINITY;
      const occupied = page?.reduce((sum, s) => sum + s.group.height, 0) ?? 0;
      const gaps = page ? page.length * systemGap : 0;
      const availableHeight = Math.max(0, height - headerReserve);
      const overflow = Boolean(page && occupied + gaps + sys.group.height > availableHeight);
      if (!page || forcePage || overflow || page.length >= limit) {
        page = [];
        pages.push(page);
        forcePage = false;
      }
      page.push(sys);
      if (sys.pageAfter) forcePage = true;
    }

    return pages.map((page, pageIndex) => {
      const grp = new Group();
      let y = this.options.marginTop + (pageIndex === 0 ? firstHeaderReserve : 0);
      for (const sys of page) {
        sys.group.x = 0;
        sys.group.y = y;
        grp.add(sys.group);
        y += sys.group.height + systemGap;
      }
      grp.update();
      return grp;
    });
  }

  private fromEnsembleScore(scr: S.Score, dur: string | null, width: number, height: number, showPublicationHeader: boolean): void {
    const cw = width - this.options.marginLeft * 2;
    const ch = height - this.options.marginTop - this.options.marginBottom;
    if (dur !== null) scr.clearSystemBreak();
    const chunks = this.ensembleChunks(scr);
    const groups = this.ensembleGroups(scr);
    const geometry = this.ensembleSystemGeometry(groups);
    const systems: PianoSystem[] = [];
    if (this.options.engravingStyle.rhythmicSpacingEnabled) {
      const measureOptions = horizontalMeasureOptions(this.options);
      const measureLayouts = chunks.map((chunk, index) => {
        const entries = chunk.rows.flat();
        const barDuration = entries
          .filter((entry): entry is Barline => entry instanceof Barline)
          .reduce((duration, entry) => Math.max(duration, entry.syncTick.toFloat()), 0);
        const first = entries[0];
        const meterDuration = first ? first.syncBeats * 4 / first.syncBeatType : 4;
        const duration = chunk.pickup && barDuration > 1e-8
          ? barDuration
          : Math.max(barDuration, meterDuration);
        return buildMeasureLayout(
          index,
          duration,
          entries.map(measuredRhythmItem),
          measureOptions,
          {
            ...chunk,
            widthWeight: chunk.pickup ? Math.max(0.12, duration / Math.max(duration, meterDuration)) : 1,
            countInTarget: !chunk.pickup,
          },
        );
      });
      const packed = packMeasureSystems(
        measureLayouts,
        Math.max(this.options.numberSize * 4, cw - geometry.musicStart),
        this.options.engravingStyle.measuresPerSystem,
        this.options.engravingStyle.justifyLastSystem,
      );
      for (const packedSystem of packed) {
        const systemChunks = packedSystem.measures.map((measure) => chunks[measure.index]);
        systems.push(this.makeEnsembleSystem(
          systemChunks,
          cw,
          packedSystem.pageAfter,
          groups,
          geometry,
          scr.tempoMarks,
          packedSystem.measures,
        ));
      }
    } else {
      let current: EnsembleChunk[] = [];
      let currentPageAfter = false;
      const flush = (): void => {
        if (current.length === 0) return;
        systems.push(this.makeEnsembleSystem(
          current,
          cw,
          currentPageAfter,
          groups,
          geometry,
          scr.tempoMarks,
        ));
        current = [];
        currentPageAfter = false;
      };
      for (const chunk of chunks) {
        if (chunk.breakBefore && current.length > 0) {
          currentPageAfter = chunk.pageBefore;
          flush();
        }
        const candidate = [...current, chunk];
        const entries = candidate.flatMap((item) => item.rows.flat());
        const natural = alignPianoEntries(entries, [], this.options, null) + geometry.musicStart;
        if (natural > cw && current.length > 0) flush();
        current.push(chunk);
        if (chunk.forceAfter) {
          currentPageAfter = chunk.pageAfter;
          flush();
        }
      }
      flush();
    }
    const headerReserve = showPublicationHeader ? this.publicationHeaderReserve(scr) : 0;
    const pages = this.paginatePiano(systems, ch, dur, headerReserve);
    if (showPublicationHeader && pages[0]) this.addPublicationHeader(pages[0], scr, cw, headerReserve);
    this.pages.push(...pages);
    this.titleAndPageNumber("", width, height, cw);
  }

  private fromPianoScore(scr: S.Score, dur: string | null, width: number, height: number, showPublicationHeader: boolean): void {
    const cw = width - this.options.marginLeft * 2;
    const ch = height - this.options.marginTop - this.options.marginBottom;
    const chunks = this.pianoChunks(scr);
    const systems: PianoSystem[] = [];
    const instrumentName = scr.instrumentName.trim() || "钢琴";
    const firstGeometry = this.pianoSystemGeometry(instrumentName);
    const continuationGeometry = this.pianoSystemGeometry(instrumentName, firstGeometry.instrumentX);
    if (this.options.engravingStyle.rhythmicSpacingEnabled) {
      const measureOptions = horizontalMeasureOptions(this.options);
      const measureLayouts = chunks.map((chunk, index) => {
        const entries = [...chunk.right, ...chunk.left];
        const barDuration = entries
          .filter((entry): entry is Barline => entry instanceof Barline)
          .reduce((duration, entry) => Math.max(duration, entry.syncTick.toFloat()), 0);
        const first = entries[0];
        const meterDuration = first ? first.syncBeats * 4 / first.syncBeatType : 4;
        const duration = chunk.pickup && barDuration > 1e-8
          ? barDuration
          : Math.max(barDuration, meterDuration);
        return buildMeasureLayout(
          index,
          duration,
          entries.map(measuredRhythmItem),
          measureOptions,
          {
            ...chunk,
            widthWeight: chunk.pickup ? Math.max(0.12, duration / Math.max(duration, meterDuration)) : 1,
            countInTarget: !chunk.pickup,
          },
        );
      });
      const packed = packMeasureSystems(
        measureLayouts,
        (systemIndex) => {
          const geometry = systemIndex === 0 ? firstGeometry : continuationGeometry;
          return Math.max(this.options.numberSize * 4, cw - geometry.musicStart);
        },
        this.options.engravingStyle.measuresPerSystem,
        this.options.engravingStyle.justifyLastSystem,
      );
      for (const system of packed) {
        const firstSystem = systems.length === 0;
        const geometry = firstSystem ? firstGeometry : continuationGeometry;
        const systemChunks = system.measures.map((measure) => chunks[measure.index]);
        systems.push(this.makePianoSystem(
          systemChunks,
          cw,
          system.pageAfter,
          instrumentName,
          firstSystem,
          geometry,
          scr.tempoMarks,
          system.measures,
        ));
      }
    } else {
      let current: PianoChunk[] = [];
      let currentPageAfter = false;
      const flush = (): void => {
        if (current.length === 0) return;
        const firstSystem = systems.length === 0;
        const geometry = firstSystem ? firstGeometry : continuationGeometry;
        systems.push(this.makePianoSystem(
          current,
          cw,
          currentPageAfter,
          instrumentName,
          firstSystem,
          geometry,
          scr.tempoMarks,
        ));
        current = [];
        currentPageAfter = false;
      };
      for (const chunk of chunks) {
        if (chunk.breakBefore && current.length > 0) {
          currentPageAfter = chunk.pageBefore;
          flush();
        }
        const candidate = [...current, chunk];
        const r = candidate.flatMap((c) => c.right);
        const l = candidate.flatMap((c) => c.left);
        const geometry = systems.length === 0 ? firstGeometry : continuationGeometry;
        const natural = alignPianoEntries(r, l, this.options, null) + geometry.musicStart;
        if (natural > cw && current.length > 0) flush();
        current.push(chunk);
        if (chunk.forceAfter) {
          currentPageAfter = chunk.pageAfter;
          flush();
        }
      }
      flush();
    }
    const headerReserve = showPublicationHeader ? this.publicationHeaderReserve(scr) : 0;
    const pages = this.paginatePiano(systems, ch, dur, headerReserve);
    if (showPublicationHeader && pages[0]) this.addPublicationHeader(pages[0], scr, cw, headerReserve);
    this.pages.push(...pages);
    this.titleAndPageNumber("", width, height, cw);
  }

  fromScore(scr: S.Score, dur: string | null, width: number, height: number, showPublicationHeader = true): void {
    S.normalizeOpeningPickup(scr);
    for (const mark of scr.tempoMarks) mark.beatUnit = scr.tempoBeatUnit;
    this.pages = [];
    if (scr.ensemble && scr.parts.length > 0) {
      this.fromEnsembleScore(scr, dur, width, height, showPublicationHeader);
      return;
    }
    if (scr.piano && scr.parts.length >= 2) {
      this.fromPianoScore(scr, dur, width, height, showPublicationHeader);
      return;
    }
    const cw = width - this.options.marginLeft * 2;
    const ch = height - this.options.marginTop - this.options.marginBottom;
    const p = scr.parts[0];
    if (dur !== null) scr.clearSystemBreak();
    const l = new Line();
    const repMeasures = scr.playData.measures;
    let flowMeasure = 0;
    repMeasures.forEach((it, idx) => {
      for (let mid = it.mid; mid < it.end; mid++) {
        const m = p.measures[mid];
        const pass = it.pass;
        if (m.newSystem && l.entries.length > 0) {
          const last = l.entries[l.entries.length - 1];
          if (last instanceof LineBreak) {
            if (m.newPage) last.newPage = true;
          } else {
            const br = new LineBreak();
            br.newPage = m.newPage;
            l.entries.push(br);
          }
        }
        m.autoBeamGroup();
        const final = mid === it.end - 1 && idx === repMeasures.length - 1;
        l.load(m, pass, this.options, final, flowMeasure++);
      }
      if (it.endOfPass && dur === null) {
        const lst = l.entries[l.entries.length - 1];
        if (!(lst instanceof LineBreak)) l.entries.push(new LineBreak());
        (l.entries[l.entries.length - 1] as LineBreak).newPage = true;
      }
    });
    if (dur !== null) {
      const part = scr.parts[0];
      const mea = part.measures[part.measures.length - 1];
      const total = mea.position.plus(mea.duration);
      let pass: number | null = null;
      if (scr.playData.isSimpple) pass = scr.playData.measures.length;
      this.breakByDur(l, dur, total, pass);
    }
    l.connectTextFrames();
    const headerReserve = showPublicationHeader ? this.publicationHeaderReserve(scr) : 0;
    for (const g of l.layout(cw, ch, this.options, headerReserve, scr.tempoMarks)) this.pages.push(g);
    if (showPublicationHeader && this.pages[0]) this.addPublicationHeader(this.pages[0], scr, cw, headerReserve);
    this.titleAndPageNumber("", width, height, cw);
  }

  titleAndPageNumber(title: string, _width: number, height: number, cw: number): void {
    this.pages.forEach((pg, idx) => {
      pg.x += this.options.marginLeft;
      const tf = new TextFrame();
      tf.font = this.options.lrcFont.scaled(0.8);
      tf.text = title.split("\n")[0];
      tf.color = this.options.color;
      tf.x = (cw - tf.measureText()) / 2;
      tf.y = height - this.options.marginBottom * 0.5 - pg.y;
      tf.update();
      const tf1 = new TextFrame();
      tf1.text = `${idx + 1}/${this.pages.length}`;
      tf1.color = this.options.color;
      tf1.y = tf.y;
      tf1.font = this.options.lrcFont.scaled(0.8 / 3);
      tf1.update();
      tf1.x = cw - tf1.width;
      pg.add(tf);
      pg.add(tf1);
    });
  }
}

function substringAfter(s: string, delim: string): string {
  const i = s.indexOf(delim);
  return i < 0 ? s : s.substring(i + delim.length);
}
