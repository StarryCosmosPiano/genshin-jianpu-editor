// Structural parity for cached piano layout against a fresh Layout instance.
// The measurement shim matches piano-check.ts; no browser is required.
import { readFileSync } from "node:fs";
import { DOMParser as XmlDomParser } from "@xmldom/xmldom";
import type { EngravingStyle } from "./src/layout/style";

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
      const xs = nums.filter((_n, index) => index % 2 === 0);
      const ys = nums.filter((_n, index) => index % 2 === 1);
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
}

const body = new FakeElement("body");
(globalThis as { document?: unknown }).document = {
  body,
  getElementById: (_id: string) => null,
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
};
(globalThis as { DOMParser?: unknown }).DOMParser = XmlDomParser;
const xmlProbe = new XmlDomParser().parseFromString("<root><child/></root>", "application/xml");
const elementProto = Object.getPrototypeOf(xmlProbe.documentElement) as Record<string, unknown>;
if (!("children" in elementProto)) {
  Object.defineProperty(elementProto, "children", {
    get(this: { childNodes: ArrayLike<{ nodeType: number }> }) {
      return Array.from(this.childNodes).filter((node) => node.nodeType === 1);
    },
  });
}

const [{ JpwFile }, { fromJpw }, layoutMod, scoreMod, { MetaData }] = await Promise.all([
  import("./src/jpword/jpwfile"),
  import("./src/score/jpwimport"),
  import("./src/layout/layout"),
  import("./src/score/score"),
  import("./src/smufl/smufl"),
]);
type Layout = InstanceType<typeof layoutMod.Layout>;
type Score = InstanceType<typeof scoreMod.Score>;
type PageItem = InstanceType<typeof layoutMod.PageItem>;
const meta = MetaData.fromJson(JSON.parse(readFileSync("public/redist/bravura_metadata.json", "utf8")));

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const initialRight = Array(12).fill("1 2 3 4") as string[];
const initialLeft = Array(12).fill("1, 2, 3, 4,") as string[];
const voice = (rows: readonly string[]): string => rows.map((row, index) =>
  `${row} ${index === rows.length - 1 ? "|]" : "|"}`).join("\n");
function jpw(right: readonly string[], left: readonly string[], titleFields = ""): string {
  return `.Title
Title = {增量排版回归}
Instrument = {钢琴}
KeyAndMeters = {1=C,4/4}
${titleFields}
.Voice.RH
${voice(right)}
.Voice.LH
${voice(left)}
`;
}
const baseline = jpw(initialRight, initialLeft);
function parsedScore(text: string): Score {
  const file = JpwFile.fromString(text);
  check(file, "incremental-layout fixture did not parse");
  const score = fromJpw(file);
  check(score?.piano && score.parts.length === 2 && score.playData.measures.length > 0,
    "incremental-layout fixture did not form a playable piano score");
  return score;
}

const style: Partial<EngravingStyle> = {
  rhythmicSpacingEnabled: true,
  measuresPerSystem: 3,
  rhythmGuideEnabled: true,
};
function newLayout(engraving: Partial<EngravingStyle>): Layout {
  const layout = new layoutMod.Layout(24);
  layout.options.smuflMeta = meta;
  layout.options.applyEngravingStyle(engraving);
  return layout;
}
function runLayout(
  layout: Layout,
  score: Score,
  width: number,
  height: number,
): { beforeUpdate: unknown; afterUpdate: unknown } {
  layout.fromScore(score, null, width, height);
  const beforeUpdate = snapshot(layout, score);
  for (const page of layout.pages) page.update();
  const afterUpdate = snapshot(layout, score);
  for (const page of layout.pages) page.update();
  const drift = firstDifference(afterUpdate, snapshot(layout, score));
  check(!drift, `page.update() moved existing geometry at ${drift}`);
  return { beforeUpdate, afterUpdate };
}
function walk(items: readonly PageItem[], visit: (item: PageItem, path: string) => void): void {
  const scan = (item: PageItem, path: string): void => {
    visit(item, path);
    item.children.forEach((child, index) => scan(child, `${path}.${index}`));
  };
  items.forEach((item, index) => scan(item, `${index}`));
}
function systems(layout: Layout): PageItem[] {
  const result: PageItem[] = [];
  walk(layout.pages, (item) => {
    if (item.classes.has("piano-system")) result.push(item);
  });
  return result;
}

function modelKeys(score: Score): WeakMap<object, string> {
  const keys = new WeakMap<object, string>();
  const add = (value: object | null | undefined, key: string): void => {
    if (value && !keys.has(value)) keys.set(value, key);
  };
  add(score, "score");
  score.parts.forEach((part, partIndex) => {
    add(part, `part:${partIndex}`);
    part.measures.forEach((measure, measureIndex) => {
      add(measure, `part:${partIndex}:measure:${measureIndex}`);
      measure.entries.forEach((entry, entryIndex) => {
        const entryKey = `part:${partIndex}:measure:${measureIndex}:entry:${entryIndex}`;
        add(entry, entryKey);
        if (entry instanceof scoreMod.Chord) {
          entry.notes.forEach((note, noteIndex) => {
            add(note, `${entryKey}:note:${noteIndex}`);
            add(note.tuplet, `${entryKey}:note:${noteIndex}:tuplet`);
          });
          entry.graceNotes.forEach((note, noteIndex) => add(note, `${entryKey}:grace:${noteIndex}`));
          entry.ornaments.forEach((ornament, ornamentIndex) =>
            add(ornament, `${entryKey}:ornament:${ornamentIndex}`));
        }
      });
    });
  });
  score.tempoMarks.forEach((mark, index) => add(mark, `tempo:${index}`));
  score.keyMarks.forEach((mark, index) => add(mark, `key:${index}`));
  score.textMarks.forEach((mark, index) => add(mark, `text:${index}`));
  score.crossPartArpeggios.forEach((mark, index) => add(mark, `arpeggio:${index}`));
  return keys;
}

const rounded = (value: number): number | string => Number.isFinite(value)
  ? Math.round(value * 1e6) / 1e6
  : String(value);
function normalized(value: unknown): unknown {
  if (typeof value === "number") return rounded(value);
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalized(item)]));
  }
  return value;
}
function firstDifference(left: unknown, right: unknown, path = "root"): string | null {
  if (Object.is(left, right)) return null;
  if (typeof left !== typeof right || left === null || right === null) return path;
  if (typeof left !== "object") return path;
  const l = left as Record<string, unknown>;
  const r = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(l), ...Object.keys(r)]);
  for (const key of keys) {
    if (!(key in l) || !(key in r)) return `${path}.${key}`;
    const difference = firstDifference(l[key], r[key], `${path}.${key}`);
    if (difference) return difference;
  }
  return null;
}

function snapshot(layout: Layout, score: Score): unknown {
  const keys = modelKeys(score);
  const paths = new WeakMap<object, string>();
  walk(layout.pages, (item, path) => paths.set(item, path));
  const itemView = (item: PageItem): unknown => {
    const scalars = Object.fromEntries(Object.entries(item)
      .filter(([key, value]) => key !== "retainedBounds"
        && (value === null || ["number", "string", "boolean"].includes(typeof value)))
      .sort(([left], [right]) => left.localeCompare(right)));
    const data = item.data;
    const dataObject = data && typeof data === "object" ? data as Record<string, unknown> : null;
    const dataKey = dataObject ? keys.get(dataObject) : undefined;
    const entry = dataObject && "syncMeasure" in dataObject ? {
      kind: dataObject.constructor.name,
      syncMeasure: dataObject.syncMeasure,
      syncSourceMeasure: dataObject.syncSourceMeasure,
      syncTick: String(dataObject.syncTick),
      syncOrder: dataObject.syncOrder,
      sourcePartIndex: dataObject.sourcePartIndex,
      chord: dataObject.chord && typeof dataObject.chord === "object"
        ? keys.get(dataObject.chord) : undefined,
    } : undefined;
    return {
      kind: item.constructor.name,
      scalars,
      matrix: item.matrix.mat,
      classes: [...item.classes].sort(),
      data: dataKey ?? entry ?? (dataObject?.constructor.name ?? data),
      font: item instanceof layoutMod.TextFrame
        ? [item.font?.family, item.font?.size, item.font?.bold] : undefined,
      line: item instanceof layoutMod.GraphicLine
        ? [item.p0.x, item.p0.y, item.p1.x, item.p1.y] : undefined,
      path: item instanceof layoutMod.GraphicPath
        ? item.segs.map((segment) => [segment.op, ...segment.pts]) : undefined,
      lyricWidths: item instanceof layoutMod.Lyric ? item._widths : undefined,
      children: item.children.map(itemView),
    };
  };
  const spans = layout.rhythmInputSpans.map((span) => ({
    ...span,
    owner: span.owner ? paths.get(span.owner) : undefined,
  }));
  return normalized({ pages: layout.pages.map(itemView), spans });
}

function checkReferences(layout: Layout, previous: Score, current: Score, label: string): void {
  const oldKeys = modelKeys(previous);
  const newKeys = modelKeys(current);
  const pageItems = new Set<PageItem>();
  walk(layout.pages, (item) => pageItems.add(item));
  walk(layout.pages, (item, path) => {
    const data = item.data;
    if (!data || typeof data !== "object") return;
    if (previous !== current) check(!oldKeys.has(data), `${label}: stale PageItem.data at ${path}`);
    if (data instanceof layoutMod.NoteEntry) {
      check(newKeys.has(data.chord), `${label}: NoteEntry.chord points outside the new Score at ${path}`);
      for (const note of data.graceItems.keys()) {
        check(newKeys.has(note), `${label}: grace-note hit points outside the new Score at ${path}`);
      }
    }
    if (data instanceof scoreMod.Chord || data instanceof scoreMod.Note
      || data instanceof scoreMod.Tuplet || data instanceof scoreMod.TempoMark
      || data instanceof scoreMod.KeyMark || data instanceof scoreMod.ScoreTextMark) {
      check(newKeys.has(data), `${label}: PageItem.data points outside the new Score at ${path}`);
    }
  });
  for (const span of layout.rhythmInputSpans) {
    check(!span.owner || pageItems.has(span.owner), `${label}: rhythm span owner is detached`);
  }
}

type IdentityExpectation = "all" | "mixed" | "none" | "any";
function caseCheck(
  label: string,
  editedText: string,
  options: {
    initialText?: string;
    width?: number;
    height?: number;
    style?: Partial<EngravingStyle>;
    sameScore?: boolean;
    identity?: IdentityExpectation;
    alterScore?: (score: Score) => void;
  } = {},
): void {
  const cached = newLayout(style);
  const original = parsedScore(options.initialText ?? baseline);
  runLayout(cached, original, 595, 842);
  const oldSystems = systems(cached);
  check(oldSystems.length >= 3, `${label}: fixture did not generate multiple systems`);

  const updated = options.sameScore ? original : parsedScore(editedText);
  options.alterScore?.(updated);
  const changedStyle = options.style ?? style;
  cached.options.applyEngravingStyle(changedStyle);
  const cachedViews = runLayout(cached, updated, options.width ?? 595, options.height ?? 842);

  const freshScore = parsedScore(editedText);
  options.alterScore?.(freshScore);
  const fresh = newLayout(changedStyle);
  const freshViews = runLayout(fresh, freshScore, options.width ?? 595, options.height ?? 842);
  const beforeDifference = firstDifference(cachedViews.beforeUpdate, freshViews.beforeUpdate);
  check(!beforeDifference, `${label}: cached layout differs before page.update at ${beforeDifference}`);
  const difference = firstDifference(cachedViews.afterUpdate, freshViews.afterUpdate);
  check(!difference, `${label}: cached layout differs after page.update at ${difference}`);
  checkReferences(cached, original, updated, label);

  const updatedSystems = systems(cached);
  const kept = updatedSystems.filter((system, index) => system === oldSystems[index]).length;
  const expectation = options.identity ?? "any";
  if (expectation === "all") check(kept === oldSystems.length && kept === updatedSystems.length,
    `${label}: unchanged systems were not retained`);
  if (expectation === "mixed") check(kept > 0 && kept < Math.min(oldSystems.length, updatedSystems.length),
    `${label}: local edit did not retain unaffected systems and rebuild its affected system (${kept}/${oldSystems.length})`);
  if (expectation === "none") check(kept === 0, `${label}: invalidated systems were reused`);
  console.log(`${label}: pages=${cached.pages.length}, systems=${updatedSystems.length}, reused=${kept}`);
}

const changed = (rows: readonly string[], at: number, value: string): string[] =>
  rows.map((row, index) => index === at ? value : row);
caseCheck("same Score twice", baseline, { sameScore: true, identity: "all" });
caseCheck("new Score same text", baseline, { identity: "all" });
caseCheck("pitch", jpw(changed(initialRight, 5, "1 2 5 4"), initialLeft), { identity: "mixed" });
caseCheck("duration", jpw(changed(initialRight, 5, "1- 3 4"), initialLeft), { identity: "mixed" });
const tiedRight = changed(changed(initialRight, 5, "1 2 3 (4"), 6, "4) 2 3 4");
const tiedScore = parsedScore(jpw(tiedRight, initialLeft));
const tieStarts = tiedScore.parts[0].measures[5].entries
  .filter((entry): entry is InstanceType<typeof scoreMod.Chord> => entry instanceof scoreMod.Chord)
  .some((chord) => chord.notes.some((note) => note.tieStart));
const tieEnds = tiedScore.parts[0].measures[6].entries
  .filter((entry): entry is InstanceType<typeof scoreMod.Chord> => entry instanceof scoreMod.Chord)
  .some((chord) => chord.notes.some((note) => note.tieEnd));
check(tieStarts && tieEnds, "cross-measure tie fixture has no actual link");
caseCheck("cross-measure tie", jpw(tiedRight, initialLeft));
caseCheck("unchanged cross-measure tie", jpw(changed(tiedRight, 9, "1 2 5 4"), initialLeft), {
  initialText: jpw(tiedRight, initialLeft),
  identity: "mixed",
});
const tupletRight = changed(initialRight, 5, "{(3}1_ 2_ 3_) 4 5 6");
const tupletScore = parsedScore(jpw(tupletRight, initialLeft));
check(tupletScore.parts[0].measures[5].entries.some((entry) =>
  entry instanceof scoreMod.Chord && entry.notes.some((note) => note.tuplet !== null)),
"tuplet fixture has no real Tuplet");
caseCheck("tuplet", jpw(tupletRight, initialLeft), { identity: "mixed" });
caseCheck("unchanged tuplet", jpw(changed(tupletRight, 9, "1 2 5 4"), initialLeft), {
  initialText: jpw(tupletRight, initialLeft),
  identity: "mixed",
});
caseCheck("page height", baseline, { height: 650, identity: "all" });
caseCheck("page width", baseline, { width: 520, identity: "none" });
caseCheck("engraving style", baseline, {
  style: { ...style, numberScale: 0.8, rhythmGuideDivision: 8 },
  identity: "none",
});
const insertedRight = [...initialRight];
const insertedLeft = [...initialLeft];
insertedRight.splice(6, 0, "5 4 3 2");
insertedLeft.splice(6, 0, "5, 4, 3, 2,");
caseCheck("insert measure", jpw(insertedRight, insertedLeft));
const deletedRight = [...initialRight];
const deletedLeft = [...initialLeft];
deletedRight.splice(6, 1);
deletedLeft.splice(6, 1);
caseCheck("delete measure", jpw(deletedRight, deletedLeft));
caseCheck("new key mark", jpw(initialRight, initialLeft, "KeyChanges = {7=Eb}"), { identity: "none" });
caseCheck("new tempo mark", baseline, {
  identity: "none",
  alterScore(score) {
    const mark = new scoreMod.TempoMark();
    mark.measure = 6;
    mark.bpm = 120;
    score.tempoMarks.push(mark);
  },
});

// An exception after earlier systems were reused must discard the partial
// cache. The next successful parse is a new model, even if the text returns
// to its original spelling; no pre-failure system may survive that recovery.
const recovering = newLayout(style);
const beforeFailure = parsedScore(baseline);
runLayout(recovering, beforeFailure, 595, 842);
const beforeFailureSystems = systems(recovering);
const failedText = jpw(changed(initialRight, 5, "1 2 5 4"), initialLeft);
const failedScore = parsedScore(failedText);
const controlledError = "controlled incremental system failure";
const systemBuilder = recovering as unknown as {
  makePianoSystem: (...args: unknown[]) => unknown;
};
const originalBuilder = systemBuilder.makePianoSystem;
let injected = false;
systemBuilder.makePianoSystem = function (this: typeof systemBuilder, ...args: unknown[]): unknown {
  if (!injected) {
    injected = true;
    throw new Error(controlledError);
  }
  return originalBuilder.apply(this, args);
};
let failedAsExpected = false;
try {
  recovering.fromScore(failedScore, null, 595, 842);
} catch (error) {
  failedAsExpected = error instanceof Error && error.message === controlledError;
} finally {
  systemBuilder.makePianoSystem = originalBuilder;
}
check(injected && failedAsExpected, "controlled system-build error did not reach the cache recovery path");
const restoredScore = parsedScore(baseline);
const restoredViews = runLayout(recovering, restoredScore, 595, 842);
const freshRestoredScore = parsedScore(baseline);
const freshRestored = newLayout(style);
const freshRestoredViews = runLayout(freshRestored, freshRestoredScore, 595, 842);
check(!firstDifference(restoredViews.beforeUpdate, freshRestoredViews.beforeUpdate)
  && !firstDifference(restoredViews.afterUpdate, freshRestoredViews.afterUpdate),
"failed incremental build left geometry or data different from a fresh layout");
checkReferences(recovering, beforeFailure, restoredScore, "failure recovery");
const restoredSystems = systems(recovering);
check(restoredSystems.length === beforeFailureSystems.length
  && restoredSystems.every((system, index) => system !== beforeFailureSystems[index]),
"failed incremental build reused a pre-failure or partial piano system");
console.log(`failure recovery: systems=${restoredSystems.length}, reused=0`);
console.log("incremental-layout-check: ok");
