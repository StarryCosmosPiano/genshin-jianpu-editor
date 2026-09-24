// Ported from mp/layout/draw.kt (JinpuPainter). Renders the page tree to SVG
// (replacing Skija Canvas drawing) and provides resize/title-page/pick.

import { Point, Rect, colorToCss } from "../common/geom";
import { Font } from "./font";
import {
  GraphicLine,
  GraphicPath,
  Group,
  Layout,
  NoteEntry,
  PageItem,
  TextFrame,
  SmuflText,
  type RhythmInputSpan,
} from "./layout";
import { Chord, type Note, Score } from "../score/score";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface RhythmInputHitSpan extends RhythmInputSpan {
  item: PageItem;
  svgRect: Rect;
  screenRect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
}

interface CachedPageItem {
  item: PageItem;
  group: SVGGElement;
  self: SVGElement | null;
  hit: SVGRectElement | null;
  visualKey: string;
  children: CachedPageItem[];
}

interface CachedPage {
  svg: SVGSVGElement;
  root: CachedPageItem;
}

export class JinpuPainter {
  layout: Layout;
  score = new Score();
  pageWidth = 0;
  pageHeight = 0;
  /** PageItem -> rendered <g>, populated each renderPage (for DOM picking). */
  nodeMap = new WeakMap<PageItem, SVGGElement>();
  /** Rendered SVG node -> PageItem, so semantic marks are not obscured by a
   * nearby note when a browser click is converted back through geometry. */
  private itemMap = new WeakMap<Element, PageItem>();
  /** Chord -> its note-entry groups (one per rendered verse/pass), for playback cursor. */
  private chordItem = new Map<Chord, { page: number; item: PageItem; verse: number }[]>();
  private highlighted: PageItem[] = [];
  private pageCache: CachedPage[] = [];
  /** Model-only subtree bounds, built lazily after layout and reused per hit. */
  private hitTreeBounds = new WeakMap<PageItem, Rect | null>();

  constructor(fontSize: number) {
    this.layout = new Layout(fontSize);
  }

  resize(w: number, h: number, dur: string | null): void {
    this.pageWidth = w;
    this.pageHeight = h;
    this.layout.fromScore(this.score, dur, w, h);
    // Single- and double-staff scores now share the compact publication header
    // on the first music page. titlePage() remains available for the dedicated
    // title-layout example in the help panel, but is no longer inserted here.
    for (const p of this.layout.pages) p.update();
    this.pageCache.length = this.layout.pages.length;
    // A relayout replaces PageItem and often Chord objects. Cached DOM groups
    // are rebound as their pages render; old object lookups must stop here.
    this.nodeMap = new WeakMap<PageItem, SVGGElement>();
    this.itemMap = new WeakMap<Element, PageItem>();
    this.hitTreeBounds = new WeakMap<PageItem, Rect | null>();
    this.buildChordIndex();
  }

  /** Walk each page tree, mapping every Chord to its note-entry group(s). */
  private buildChordIndex(): void {
    this.chordItem.clear();
    this.highlighted = [];
    const walk = (item: PageItem, page: number): void => {
      if (item.data instanceof NoteEntry) {
        const ch = item.data.chord;
        if (ch) {
          const list = this.chordItem.get(ch) ?? [];
          list.push({ page, item, verse: item.data.verse });
          this.chordItem.set(ch, list);
        }
      }
      for (const c of item.children) walk(c, page);
    };
    this.layout.pages.forEach((pg, i) => walk(pg, i));
  }

  /** The rendered entry for a chord at a given pass/verse (falls back to first). */
  private hitFor(chord: Chord, pass: number): { page: number; item: PageItem } | null {
    const list = this.chordItem.get(chord);
    if (!list || list.length === 0) return null;
    return list.find((h) => h.verse === pass) ?? list[0];
  }

  /** Highlight the note of `chord` at `pass` (clearing any previous). Returns page index. */
  highlightChord(chord: Chord | null, pass = 0): number | null {
    return this.highlightChords(chord ? [chord] : null, pass);
  }

  /** Highlight every hand/part chord sounding at the same playback instant. */
  highlightChords(chords: Chord[] | null, pass = 0): number | null {
    for (const item of this.highlighted) this.nodeMap.get(item)?.classList.remove("playing");
    this.highlighted = [];
    if (!chords || chords.length === 0) return null;
    let page: number | null = null;
    for (const chord of chords) {
      const hit = this.hitFor(chord, pass);
      if (!hit) continue;
      this.nodeMap.get(hit.item)?.classList.add("playing");
      this.highlighted.push(hit.item);
      if (page === null) page = hit.page;
    }
    return page;
  }

  /** SVG <g> for a chord's note at `pass` (for scroll-into-view); null if not rendered. */
  chordGroupEl(chord: Chord, pass = 0): SVGGElement | null {
    const hit = this.hitFor(chord, pass);
    return hit ? this.nodeMap.get(hit.item) ?? null : null;
  }

  /** SVG group for one tone inside a vertical chord, falling back to its entry. */
  noteGroupEl(chord: Chord, note: Note, pass = 0): SVGGElement | null {
    const hit = this.hitFor(chord, pass);
    if (!hit) return null;
    const entry = hit.item.data;
    if (entry instanceof NoteEntry) {
      const index = chord.notes.indexOf(note);
      const number = index >= 0 ? entry.numbers[index] : null;
      const item = number ?? entry.graceItems.get(note);
      if (item) return this.nodeMap.get(item) ?? this.nodeMap.get(hit.item) ?? null;
    }
    return this.nodeMap.get(hit.item) ?? null;
  }

  /** Every rendered occurrence of one tone, including repeated passes/verses. */
  noteGroupEls(
    chord: Chord,
    note: Note,
  ): Array<{ page: number; verse: number; element: SVGGElement }> {
    const result: Array<{ page: number; verse: number; element: SVGGElement }> = [];
    const index = chord.notes.indexOf(note);
    for (const hit of this.chordItem.get(chord) ?? []) {
      const entry = hit.item.data;
      let element = this.nodeMap.get(hit.item) ?? null;
      if (entry instanceof NoteEntry) {
        const item = index >= 0 ? entry.numbers[index] : entry.graceItems.get(note);
        if (item) element = this.nodeMap.get(item) ?? element;
      }
      if (element) result.push({ page: hit.page, verse: hit.verse, element });
    }
    return result;
  }

  /** Rendered groups whose layout item carries the given score-model object. */
  itemGroupsForData(
    data: unknown,
  ): Array<{ page: number; item: PageItem; element: SVGGElement }> {
    const result: Array<{ page: number; item: PageItem; element: SVGGElement }> = [];
    const walk = (item: PageItem, page: number): void => {
      if (item.data === data) {
        const element = this.nodeMap.get(item);
        if (element) result.push({ page, item, element });
      }
      for (const child of item.children) walk(child, page);
    };
    this.layout.pages.forEach((page, index) => walk(page, index));
    return result;
  }

  private multipleLineText(str: string, fnt: Font, w: number, clr: number): PageItem {
    const arr = str.split("\n");
    const grp = new Group();
    let ypos = 0;
    const fm = fnt.metrics;
    const height = fm.descent - fm.ascent;
    for (const it of arr) {
      const tf = new TextFrame();
      tf.color = clr;
      tf.font = fnt;
      tf.text = it;
      const ww = tf.measureText();
      tf.x = (w - ww) / 2;
      tf.y = ypos;
      ypos += height;
      if (arr.length === 1) return tf;
      grp.add(tf);
    }
    return grp;
  }

  titlePage(w: number, h: number): Group {
    const opt = this.layout.options;
    const fnt = opt.lrcFont;
    const pg = new Group();
    let titleCount = 0;
    const texts: string[] = [];
    const fonts: Font[] = [];
    for (const it of this.score.credit) {
      const isTitle = it.type === "title";
      const sz = isTitle ? opt.titleSize : opt.creditSize;
      if (isTitle) {
        titleCount++;
        texts.unshift(it.text);
        fonts.unshift(fnt.makeWithSize(sz));
      } else {
        texts.push(it.text);
        fonts.push(fnt.makeWithSize(sz));
      }
    }
    if (titleCount === 0) {
      if (this.score.title.trim().length > 0) {
        titleCount = 1;
        texts.unshift(this.score.title);
        fonts.unshift(fnt.makeWithSize(opt.titleSize));
      }
    }
    if (titleCount !== 1) console.error("title count error!");
    let ypos = 0.3 * h;
    texts.forEach((text, idx) => {
      const font = fonts[idx];
      const obj = this.multipleLineText(text, font, w, opt.color);
      obj.y = ypos;
      obj.update();
      pg.add(obj);
      ypos += obj.height;
    });
    return pg;
  }

  // ---------------- SVG rendering ----------------

  /** Render one page group into a standalone <svg> of pageWidth x pageHeight. */
  renderPage(pageIndex: number): SVGSVGElement {
    this.hitTreeBounds = new WeakMap<PageItem, Rect | null>();
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "score-page");
    svg.setAttribute("viewBox", `0 0 ${this.pageWidth} ${this.pageHeight}`);
    const pg = this.layout.pages[pageIndex];
    svg.appendChild(renderPageItem(pg, this.nodeMap, this.itemMap));
    return svg;
  }

  /** Reconcile an interactive page with its previous SVG without detaching it. */
  renderCachedPage(pageIndex: number): SVGSVGElement {
    // Incremental layout can retain PageItem identities while changing their
    // positions or children. Rebuild lazily on the next pointer event.
    this.hitTreeBounds = new WeakMap<PageItem, Rect | null>();
    const page = this.layout.pages[pageIndex];
    if (!page) throw new RangeError(`Page ${pageIndex} does not exist`);
    let cached = this.pageCache[pageIndex];
    if (!cached) {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "score-page");
      svg.setAttribute("viewBox", `0 0 ${this.pageWidth} ${this.pageHeight}`);
      const group = renderPageItem(page, this.nodeMap, this.itemMap);
      svg.appendChild(group);
      cached = { svg, root: indexCachedPageItem(page, group) };
      this.pageCache[pageIndex] = cached;
      return svg;
    }
    syncAttribute(cached.svg, "class", "score-page");
    syncAttribute(cached.svg, "viewBox", `0 0 ${this.pageWidth} ${this.pageHeight}`);
    cached.root = this.reconcilePageItem(page, cached.root);
    if (cached.root.group.parentNode !== cached.svg) {
      cached.svg.insertBefore(cached.root.group, cached.svg.firstChild);
    }
    return cached.svg;
  }

  private reconcilePageItem(item: PageItem, cached: CachedPageItem): CachedPageItem {
    if (item.constructor !== cached.item.constructor) {
      const group = renderPageItem(item, this.nodeMap, this.itemMap);
      return indexCachedPageItem(item, group);
    }
    const group = cached.group;
    const classes = [...item.classes].join(" ");
    syncAttribute(group, "class", classes || null);
    syncAttribute(group, "transform", item.matrix.isIdentity ? null : item.matrix.toSvg());
    // Voice coloring, selection, playback and input focus are applied after
    // rendering. Reset them before the editor reapplies the current model.
    if (group.style.getPropertyValue("--score-voice-color")) {
      group.style.removeProperty("--score-voice-color");
      if (!group.getAttribute("style")) group.removeAttribute("style");
    }
    const visualKey = pageItemVisualKey(item);
    if (visualKey !== cached.visualKey) {
      cached.self?.remove();
      cached.hit?.remove();
      cached.self = renderSelf(item);
      if (cached.self) {
        if (item.classes.has("notation-hidden-label")) {
          cached.self.setAttribute("visibility", "hidden");
        }
        group.insertBefore(cached.self, group.firstChild);
      }
      cached.hit = cached.self && needsTextHit(item)
        ? createTextHit(item, cached.self, group) : null;
      cached.visualKey = visualKey;
    } else {
      // applyScoreVoiceColors changes presentation attributes directly.
      // Restore their canonical value even when the notation is unchanged.
      restoreSelfPaint(item, cached.self, cached.hit);
    }
    this.nodeMap.set(item, group);
    this.itemMap.set(group, item);
    if (cached.self) this.itemMap.set(cached.self, item);
    if (cached.hit) this.itemMap.set(cached.hit, item);

    const previous = cached.children;
    const children = item.children.map((child, index) => previous[index]
      ? this.reconcilePageItem(child, previous[index])
      : indexCachedPageItem(child, renderPageItem(child, this.nodeMap, this.itemMap)));
    const retained = new Set(children.map((child) => child.group));
    for (const old of previous) {
      if (!retained.has(old.group)) old.group.remove();
    }
    // Keep unchanged groups mounted. Only inserted/replaced/moved children
    // touch the DOM; a note edit does not rebuild the rest of the page.
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index].group;
      const next = children[index + 1]?.group ?? null;
      if (child.parentNode !== group || child.nextSibling !== next) group.insertBefore(child, next);
    }
    cached.item = item;
    cached.children = children;
    return cached;
  }

  /** Resolve the innermost rendered PageItem that owns an event target. */
  pageItemForTarget(target: EventTarget | null): PageItem | null {
    if (!(target instanceof Element)) return null;
    let element: Element | null = target;
    while (element) {
      const item = this.itemMap.get(element);
      if (item) return item;
      element = element.parentElement;
    }
    return null;
  }

  /**
   * Enumerate invisible rhythm hit regions for one rendered page. The SVG
   * rectangle is in viewBox coordinates; screenRect uses the SVG's current
   * screen CTM when the element is mounted, so callers can use either direct
   * score-space hit testing or browser pointer coordinates.
   */
  rhythmInputSpansForPage(pageIndex: number, svg?: SVGSVGElement): RhythmInputHitSpan[] {
    const matrix = svg?.getScreenCTM() ?? null;
    const transform = (x: number, y: number): { x: number; y: number } => {
      if (!matrix || typeof DOMPoint === "undefined") return { x, y };
      const point = new DOMPoint(x, y).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    };
    return this.layout.rhythmInputSpans
      .filter((span) => span.pageIndex === pageIndex)
      .map((span): RhythmInputHitSpan => {
        const item = span.owner ?? this.layout.pages[pageIndex];
        const svgRect = new Rect(span.xStart, span.yTop, span.xEnd, span.yBottom);
        const corners = [
          transform(svgRect.left, svgRect.top),
          transform(svgRect.right, svgRect.top),
          transform(svgRect.left, svgRect.bottom),
          transform(svgRect.right, svgRect.bottom),
        ];
        const left = Math.min(...corners.map((point) => point.x));
        const right = Math.max(...corners.map((point) => point.x));
        const top = Math.min(...corners.map((point) => point.y));
        const bottom = Math.max(...corners.map((point) => point.y));
        return {
          ...span,
          item,
          svgRect,
          screenRect: { left, top, right, bottom, width: right - left, height: bottom - top },
        };
      });
  }

  /** Walk up from a picked item to its enclosing "entry" group (else the item). */
  entryGroupOf(item: PageItem): PageItem {
    let cur: PageItem | null = item;
    while (cur) {
      if (cur.classes.has("entry")) return cur;
      cur = cur.parent;
    }
    return item;
  }

  get pageCount(): number {
    return this.layout.pages.length;
  }

  // ---------------- SVG picking ----------------

  private hitTreeBound(item: PageItem): Rect | null {
    const cached = this.hitTreeBounds.get(item);
    if (cached !== undefined) return cached;
    let area = itemHitBounds(item);
    for (const child of item.children) {
      const childArea = this.hitTreeBound(child)?.offset(child.x, child.y);
      if (childArea) area = area ? area.union(childArea) : childArea;
    }
    this.hitTreeBounds.set(item, area);
    return area;
  }

  /** Candidate distance uses measured ink rather than SVG text's line box. */
  private hitDistance(item: PageItem, localX: number, localY: number,
    maxDistance: number): { distance: number; area: number } | null {
    const bounds = itemHitBounds(item);
    if (!bounds) return null;
    const dx = Math.max(bounds.left - localX, 0, localX - bounds.right);
    const dy = Math.max(bounds.top - localY, 0, localY - bounds.bottom);
    const distance = Math.hypot(dx, dy);
    if (distance > maxDistance) return null;
    const paintDistance = item instanceof GraphicPath || item instanceof GraphicLine
      ? this.geometryHit(item, localX, localY, maxDistance) : 0;
    if (paintDistance === null) return null;
    return { distance: Math.max(distance, paintDistance),
      area: Math.max(0, bounds.width * bounds.height) };
  }

  /** SVG path bounds can contain a large empty interior (a slur, for example).
   * Ask the already-mounted shape whether its paint is actually near the hit. */
  private geometryHit(item: GraphicPath | GraphicLine, x: number, y: number,
    maxDistance: number): number | null {
    const self = this.nodeMap.get(item)?.firstElementChild as SVGGeometryElement | null;
    if (!self || typeof self.isPointInStroke !== "function") return 0;
    const painted = (px: number, py: number): boolean => {
      const point = new DOMPoint(px, py);
      return (item instanceof GraphicPath && item.fill && self.isPointInFill(point))
        || ((item instanceof GraphicLine || item.stroke) && self.isPointInStroke(point));
    };
    if (painted(x, y)) return 0;
    if (maxDistance <= 0) return null;
    // A few local probes give narrow strokes a modest click tolerance without
    // admitting the entire path bounding box as a hit region.
    for (const radius of [maxDistance / 2, maxDistance]) {
      for (let index = 0; index < 8; index++) {
        const angle = index * Math.PI / 4;
        if (painted(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius)) return radius;
      }
    }
    return null;
  }

  /** Find the nearest painted item within a score-space tolerance. Zero means
   * strict ink hit; empty layout groups never become candidates. */
  pickPage(page: number, pos: Point, maxDistance = 3): PageItem | null {
    const root = this.layout.pages[page];
    if (!root) return null;
    let bestItem: PageItem | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestArea = Number.POSITIVE_INFINITY;
    const walk = (item: PageItem, x: number, y: number): void => {
      const localX = x - item.x;
      const localY = y - item.y;
      const treeBound = this.hitTreeBound(item);
      if (!treeBound || !treeBound.inset(-maxDistance, -maxDistance).contains(localX, localY)) return;
      const hit = this.hitDistance(item, localX, localY, maxDistance);
      if (hit && (hit.distance < bestDistance - 1e-8
        || (Math.abs(hit.distance - bestDistance) <= 1e-8 && hit.area < bestArea))) {
        bestItem = item;
        bestDistance = hit.distance;
        bestArea = hit.area;
      }
      for (const child of item.children) walk(child, localX, localY);
    };
    walk(root, pos.x, pos.y);
    return bestItem;
  }

  /** DOM target breaks ties only after passing the same measured-ink test as
   * geometric candidates. Browser text line-box targets cannot steal notes. */
  pickPageAtPointer(page: number, pos: Point, target: EventTarget | null,
    maxDistance = 3): PageItem | null {
    const geometric = this.pickPage(page, pos, maxDistance);
    const direct = this.pageItemForTarget(target);
    const root = this.layout.pages[page];
    if (!direct || !root) return geometric;
    if (direct === root) return geometric;
    let ancestor: PageItem | null = direct;
    while (ancestor && ancestor !== root) ancestor = ancestor.parent;
    if (ancestor !== root) return geometric;
    const origin = direct.pos(root);
    const directHit = this.hitDistance(direct,
      pos.x - root.x - origin.x, pos.y - root.y - origin.y, maxDistance);
    if (!directHit) return geometric;
    if (!geometric) return direct;
    const geoOrigin = geometric.pos(root);
    const geoHit = this.hitDistance(geometric,
      pos.x - root.x - geoOrigin.x, pos.y - root.y - geoOrigin.y, maxDistance);
    return !geoHit || directHit.distance <= geoHit.distance + 1e-8 ? direct : geometric;
  }
}

// Recursively build an SVG <g> for a PageItem (matrix transform + self shape +
// children), mirroring draw.kt's drawPageItem (save/concat/drawTo/recurse).
function syncAttribute(element: Element, name: string, value: string | null): void {
  if (value === null) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
  } else if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

function pageItemVisualKey(item: PageItem): string {
  const hidden = item.classes.has("notation-hidden-label");
  const textBounds = needsTextHit(item) ? textHitBounds(item) : null;
  const hitBounds = textBounds
    ? [textBounds.left, textBounds.top, textBounds.width, textBounds.height] : null;
  if (item instanceof GraphicPath) {
    return JSON.stringify(["path", item.d, item.fill, item.fill ? colorToCss(item.fillColor) : null,
      item.stroke, item.stroke ? colorToCss(item.strokeColor) : null,
      item.stroke ? item.strokeWidth : null, hidden, hitBounds]);
  }
  if (item instanceof GraphicLine) {
    return JSON.stringify(["line", item.p0.x, item.p0.y, item.p1.x, item.p1.y,
      colorToCss(item.strokeColor), item.strokeWidth, hidden, hitBounds]);
  }
  if (item instanceof TextFrame) {
    return JSON.stringify(["text", item.text,
      item instanceof SmuflText ? "Bravura" : item.font.family,
      item.font.size, item.font.bold, colorToCss(item.color),
      item.strokeWidth > 0 ? colorToCss(item.strokeColor) : null,
      item.strokeWidth, item.strokeWidth > 0 && item.nonScalingStroke,
      hidden, hitBounds]);
  }
  return "group";
}

function textHitBounds(item: PageItem): Rect | null {
  if (!(item instanceof TextFrame) || !item.text || item.classes.has("notation-hidden-label")) return null;
  // SMuFL bounds use a font baseline with positive Y pointing UP, while SVG
  // text is painted with positive Y pointing DOWN. Layout retains the legacy
  // metric box, so convert it here for both pointer geometry and the DOM hit
  // rectangle. Using it unchanged puts a tuplet 3 / mordent's target below
  // the visible ink. Do not move the glyph or change score spacing.
  if (item instanceof SmuflText) {
    const fontBounds = item.bound;
    return new Rect(fontBounds.left, -fontBounds.bottom, fontBounds.right, -fontBounds.top);
  }
  // SVG getBBox is a full line box for many CJK fonts. Ordinary text uses
  // layout's cached tight vertical ink measurement, already in SVG space.
  return item.font.charBound(item.text);
}

/** Only Bravura's large SVG line box needs an extra DOM hit surface. Plain
 * note text keeps its original DOM shape for large scores and uses the tight
 * model bound only when the picker validates a candidate. */
function needsTextHit(item: PageItem): boolean {
  return item instanceof SmuflText && !!textHitBounds(item);
}

function itemHitBounds(item: PageItem): Rect | null {
  const textBounds = textHitBounds(item);
  if (textBounds) return textBounds;
  if (item instanceof GraphicPath) {
    if (!item.fill && !item.stroke) return null;
    return item.stroke ? item.bound.inset(-item.strokeWidth / 2, -item.strokeWidth / 2) : item.bound;
  }
  if (item instanceof GraphicLine) {
    return item.bound.inset(-item.strokeWidth / 2, -item.strokeWidth / 2);
  }
  return null;
}

function createTextHit(item: PageItem, self: SVGElement, group: SVGGElement): SVGRectElement {
  self.setAttribute("pointer-events", "none");
  const hit = document.createElementNS(SVG_NS, "rect");
  const bounds = textHitBounds(item)!;
  hit.setAttribute("x", String(bounds.left));
  hit.setAttribute("y", String(bounds.top));
  hit.setAttribute("width", String(bounds.width));
  hit.setAttribute("height", String(bounds.height));
  hit.setAttribute("fill", "transparent");
  hit.setAttribute("pointer-events", "all");
  if (self.nextSibling) group.insertBefore(hit, self.nextSibling);
  else group.appendChild(hit);
  return hit;
}

function restoreSelfPaint(item: PageItem, self: SVGElement | null, hit: SVGRectElement | null): void {
  if (self) {
    if (item instanceof GraphicPath) {
      syncAttribute(self, "fill", item.fill ? colorToCss(item.fillColor) : "none");
      syncAttribute(self, "stroke", item.stroke ? colorToCss(item.strokeColor) : null);
    } else if (item instanceof GraphicLine) {
      syncAttribute(self, "stroke", colorToCss(item.strokeColor));
    } else if (item instanceof TextFrame) {
      syncAttribute(self, "fill", colorToCss(item.color));
      syncAttribute(self, "stroke", item.strokeWidth > 0 ? colorToCss(item.strokeColor) : null);
    }
  }
  if (hit) syncAttribute(hit, "fill", "transparent");
}

function indexCachedPageItem(item: PageItem, group: SVGGElement): CachedPageItem {
  const elements = Array.from(group.children);
  const drawsSelf = item instanceof GraphicPath || item instanceof GraphicLine || item instanceof TextFrame;
  const self = drawsSelf ? elements.shift() as SVGElement : null;
  const hit = self && needsTextHit(item)
    ? elements.shift() as SVGRectElement : null;
  return {
    item,
    group,
    self,
    hit,
    visualKey: pageItemVisualKey(item),
    children: item.children.map((child, index) =>
      indexCachedPageItem(child, elements[index] as SVGGElement)),
  };
}

export function renderPageItem(
  item: PageItem,
  nodeMap?: WeakMap<PageItem, SVGGElement>,
  itemMap?: WeakMap<Element, PageItem>,
): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  if (item.classes.size > 0) g.setAttribute("class", [...item.classes].join(" "));
  if (!item.matrix.isIdentity) g.setAttribute("transform", item.matrix.toSvg());
  const self = renderSelf(item);
  if (self) {
    // A notation-only hidden label keeps its measured PageItem in the layout
    // tree; only the emitted SVG shape is suppressed. This makes toggling
    // hidden tied keyboard letters geometrically stable.
    if (item.classes.has("notation-hidden-label")) {
      self.setAttribute("visibility", "hidden");
    }
    g.appendChild(self);
    if (needsTextHit(item)) {
      // Bravura's SVG line box can overlap nearby notes. Only its symbols
      // need an extra tight target; ordinary text keeps the original DOM.
      const hit = createTextHit(item, self, g);
      itemMap?.set(hit, item);
    }
  }
  for (const ch of item.children) g.appendChild(renderPageItem(ch, nodeMap, itemMap));
  nodeMap?.set(item, g);
  itemMap?.set(g, item);
  if (self) itemMap?.set(self, item);
  return g;
}

function renderSelf(item: PageItem): SVGElement | null {
  if (item instanceof GraphicPath) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", item.d);
    if (item.fill) p.setAttribute("fill", colorToCss(item.fillColor));
    else p.setAttribute("fill", "none");
    if (item.stroke) {
      p.setAttribute("stroke", colorToCss(item.strokeColor));
      p.setAttribute("stroke-width", String(item.strokeWidth));
    }
    return p;
  }
  if (item instanceof GraphicLine) {
    const l = document.createElementNS(SVG_NS, "line");
    l.setAttribute("x1", String(item.p0.x));
    l.setAttribute("y1", String(item.p0.y));
    l.setAttribute("x2", String(item.p1.x));
    l.setAttribute("y2", String(item.p1.y));
    l.setAttribute("stroke", colorToCss(item.strokeColor));
    l.setAttribute("stroke-width", String(item.strokeWidth));
    l.setAttribute("stroke-linecap", "butt");
    return l;
  }
  if (item instanceof TextFrame) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", "0");
    t.setAttribute("y", "0");
    const family = item instanceof SmuflText ? "Bravura" : item.font.family;
    t.setAttribute("font-family", family);
    t.setAttribute("font-size", String(item.font.size));
    if (item.font.bold) t.setAttribute("font-weight", "bold");
    t.setAttribute("fill", colorToCss(item.color));
    if (item.strokeWidth > 0) {
      t.setAttribute("stroke", colorToCss(item.strokeColor));
      t.setAttribute("stroke-width", String(item.strokeWidth));
      t.setAttribute("stroke-linejoin", "round");
      t.setAttribute("paint-order", "stroke fill");
      if (item.nonScalingStroke) t.setAttribute("vector-effect", "non-scaling-stroke");
    }
    t.textContent = item.text;
    return t;
  }
  return null; // Group / bare PageItem: children only
}
