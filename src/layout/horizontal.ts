/**
 * Deterministic horizontal layout for numbered notation.
 *
 * This module deliberately contains no SVG or score-model code.  It builds an
 * in-memory measure/system plan from already measured symbols.  The caller
 * writes the resulting x positions into PageItems; no computed coordinates are
 * serialized into the score file.
 */

export type RhythmColumnKind = "note" | "barline" | "key" | "time" | "other";

export interface RhythmItem<T> {
  value: T;
  /** Stable exact key (normally Fraction.toString()). */
  tickKey: string;
  /** Quarter-note units, used only for rhythmic spacing. */
  tick: number;
  /** Key/time before notes, barline after notes at an identical tick. */
  order: number;
  kind: RhythmColumnKind;
  /** Measured extents from the item's rhythmic anchor. */
  left: number;
  right: number;
}

export interface RhythmColumn<T> {
  tickKey: string;
  tick: number;
  order: number;
  kind: RhythmColumnKind;
  items: T[];
  left: number;
  right: number;
  /** Minimum advance from the preceding boundary/column to this anchor. */
  minAdvance: number;
  /** Elastic share carried by the preceding rhythmic interval. */
  rhythmWeight: number;
  /** Position relative to the owning measure. */
  x: number;
}

export interface MeasureLayout<T> {
  index: number;
  duration: number;
  /** Relative share of spare system width (a pickup is normally below 1). */
  widthWeight: number;
  /** Whether this measure consumes one slot of the preferred per-system count. */
  countInTarget: boolean;
  /** Printed measure number; null suppresses numbering for a pickup. */
  displayNumber: number | null;
  columns: RhythmColumn<T>[];
  collisionWidth: number;
  minimumWidth: number;
  rhythmWeight: number;
  trailingMinimum: number;
  trailingWeight: number;
  x: number;
  width: number;
  breakBefore: boolean;
  pageBefore: boolean;
  forceAfter: boolean;
  pageAfter: boolean;
}

export interface MeasureLayoutOptions {
  edgePadding: number;
  normalClearance: number;
  boundaryClearance: number;
  /** Smallest comfortable elastic space per rhythmic-weight unit. */
  minimumElasticUnit: number;
  /** 1 is linear; values below 1 keep very short values readable. */
  spacingExponent: number;
}

export interface MeasureFlowFlags {
  breakBefore?: boolean;
  pageBefore?: boolean;
  forceAfter?: boolean;
  pageAfter?: boolean;
  widthWeight?: number;
  countInTarget?: boolean;
  displayNumber?: number | null;
}

export interface SystemLayout<T> {
  measures: MeasureLayout<T>[];
  width: number;
  pageAfter: boolean;
  overflow: boolean;
}

function columnKind(kinds: RhythmColumnKind[]): RhythmColumnKind {
  if (kinds.includes("barline")) return "barline";
  if (kinds.includes("time")) return "time";
  if (kinds.includes("key")) return "key";
  if (kinds.includes("note")) return "note";
  return "other";
}

function boundaryKind(kind: RhythmColumnKind): boolean {
  return kind === "barline" || kind === "key" || kind === "time";
}

function rhythmicWeight(delta: number, exponent: number): number {
  if (!(delta > 1e-9)) return 0;
  return Math.pow(delta, exponent);
}

/** Build measured rhythmic columns for one measure. */
export function buildMeasureLayout<T>(
  index: number,
  duration: number,
  inputs: readonly RhythmItem<T>[],
  options: MeasureLayoutOptions,
  flags: MeasureFlowFlags = {},
): MeasureLayout<T> {
  const grouped = new Map<string, RhythmItem<T>[]>();
  for (const input of inputs) {
    const key = `${input.tickKey}|${input.order}`;
    const values = grouped.get(key) ?? [];
    values.push(input);
    grouped.set(key, values);
  }

  const columns: RhythmColumn<T>[] = [...grouped.values()].map((items) => ({
    tickKey: items[0].tickKey,
    tick: items[0].tick,
    order: items[0].order,
    kind: columnKind(items.map((item) => item.kind)),
    items: items.map((item) => item.value),
    left: Math.max(...items.map((item) => Math.max(0, item.left))),
    right: Math.max(...items.map((item) => Math.max(0, item.right))),
    minAdvance: 0,
    rhythmWeight: 0,
    x: 0,
  })).sort((a, b) => a.tick - b.tick || a.order - b.order);

  let collisionWidth = 0;
  let rhythmWeightTotal = 0;
  let previous: RhythmColumn<T> | null = null;
  for (const column of columns) {
    const delta = Math.max(0, column.tick - (previous?.tick ?? 0));
    column.rhythmWeight = rhythmicWeight(delta, options.spacingExponent);
    if (previous === null) {
      column.minAdvance = options.edgePadding + column.left;
    } else {
      const clearance = boundaryKind(previous.kind) || boundaryKind(column.kind)
        ? options.boundaryClearance
        : options.normalClearance;
      column.minAdvance = previous.right + clearance + column.left;
    }
    collisionWidth += column.minAdvance;
    rhythmWeightTotal += column.rhythmWeight;
    previous = column;
  }

  const last = columns[columns.length - 1];
  const trailingMinimum = last
    ? last.right + (last.kind === "barline" ? 0 : options.edgePadding)
    : options.edgePadding * 2;
  const trailingDelta = last ? Math.max(0, duration - last.tick) : Math.max(0, duration);
  const trailingWeight = rhythmicWeight(trailingDelta, options.spacingExponent);
  collisionWidth += trailingMinimum;
  rhythmWeightTotal += trailingWeight;
  const minimumWidth = collisionWidth + rhythmWeightTotal * options.minimumElasticUnit;

  return {
    index,
    duration,
    widthWeight: Math.max(0.05, flags.widthWeight ?? 1),
    countInTarget: flags.countInTarget ?? true,
    displayNumber: flags.displayNumber === undefined ? index + 1 : flags.displayNumber,
    columns,
    collisionWidth,
    minimumWidth,
    rhythmWeight: rhythmWeightTotal,
    trailingMinimum,
    trailingWeight,
    x: 0,
    width: minimumWidth,
    breakBefore: Boolean(flags.breakBefore),
    pageBefore: Boolean(flags.pageBefore),
    forceAfter: Boolean(flags.forceAfter),
    pageAfter: Boolean(flags.pageAfter),
  };
}

/**
 * Assign widths with a water-filling rule: ordinary measures stay equal, while
 * a dense measure may claim its minimum and the remaining measures shrink by
 * the same amount.  The sum is always exactly targetWidth (within floating
 * point precision).
 */
export function allocateMeasureWidths<T>(
  measures: readonly MeasureLayout<T>[],
  targetWidth: number,
): boolean {
  if (measures.length === 0) return true;
  const required = measures.reduce((sum, measure) => sum + measure.minimumWidth, 0);
  if (required > targetWidth + 1e-7) return false;

  let low = 0;
  let high = targetWidth;
  for (let iteration = 0; iteration < 64; iteration++) {
    const level = (low + high) / 2;
    const used = measures.reduce(
      (sum, measure) => sum + Math.max(measure.minimumWidth, level * measure.widthWeight),
      0,
    );
    if (used > targetWidth) high = level;
    else low = level;
  }

  let x = 0;
  for (let i = 0; i < measures.length; i++) {
    const measure = measures[i];
    const width = i === measures.length - 1
      ? targetWidth - x
      : Math.max(measure.minimumWidth, low * measure.widthWeight);
    measure.x = x;
    measure.width = width;
    x += width;
  }
  return true;
}

/** Resolve every rhythmic anchor inside an already sized measure. */
export function placeMeasureColumns<T>(measure: MeasureLayout<T>): void {
  const extra = Math.max(0, measure.width - measure.collisionWidth);
  const elasticUnit = measure.rhythmWeight > 1e-9 ? extra / measure.rhythmWeight : 0;
  const fallback = measure.rhythmWeight <= 1e-9 && measure.columns.length > 0
    ? extra / measure.columns.length
    : 0;
  let cursor = 0;
  for (const column of measure.columns) {
    cursor += column.minAdvance + column.rhythmWeight * elasticUnit + fallback;
    column.x = cursor;
  }
}

/** Greedily pack measures into systems around a target count. */
export function packMeasureSystems<T>(
  measures: readonly MeasureLayout<T>[],
  usableWidth: number | ((systemIndex: number) => number),
  targetMeasureCount: number,
  justifyLastSystem: boolean,
): SystemLayout<T>[] {
  const systems: SystemLayout<T>[] = [];
  const target = Math.max(1, Math.round(targetMeasureCount));
  let index = 0;

  while (index < measures.length) {
    const systemWidth = typeof usableWidth === "function" ? usableWidth(systems.length) : usableWidth;
    const start = index;
    const selected: MeasureLayout<T>[] = [];
    let selectedTargetCount = 0;
    if (measures[index].pageBefore && systems.length > 0) systems[systems.length - 1].pageAfter = true;

    while (index < measures.length && selectedTargetCount < target) {
      const measure = measures[index];
      if (selected.length > 0 && measure.breakBefore) break;
      selected.push(measure);
      if (measure.countInTarget) selectedTargetCount++;
      index++;
      if (measure.forceAfter) break;
    }

    while (selected.length > 1) {
      const required = selected.reduce((sum, measure) => sum + measure.minimumWidth, 0);
      if (required <= systemWidth + 1e-7) break;
      const removed = selected.pop();
      if (removed?.countInTarget) selectedTargetCount--;
      index--;
    }

    const isLast = index >= measures.length;
    const minimumTotal = selected.reduce((sum, measure) => sum + measure.minimumWidth, 0);
    const shouldJustify = justifyLastSystem || !isLast;
    const layoutWidth = shouldJustify ? systemWidth : Math.min(systemWidth, minimumTotal);
    const fits = allocateMeasureWidths(selected, layoutWidth);
    if (!fits) {
      // A single measure can be wider than the page. Keep it on its own system
      // and preserve the collision-safe geometry so no notes are overlapped.
      const measure = selected[0];
      measure.x = 0;
      measure.width = measure.minimumWidth;
    }
    for (const measure of selected) placeMeasureColumns(measure);

    systems.push({
      measures: selected,
      width: fits ? layoutWidth : Math.max(layoutWidth, minimumTotal),
      pageAfter: Boolean(selected[selected.length - 1]?.pageAfter),
      overflow: !fits,
    });
    if (index === start) throw new Error("horizontal layout made no progress");
  }
  return systems;
}
