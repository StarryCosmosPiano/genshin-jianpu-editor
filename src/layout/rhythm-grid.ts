import type { RhythmGuideDivision } from "./style";

export interface RhythmAnchor { tick: number; x: number }
export interface RhythmGridInput {
  /** Real engraved columns, including the start and end of the measure. */
  anchors: readonly RhythmAnchor[];
  endTick: number;
  beats: number;
  beatType: number;
  mode?: "auto" | "manual";
  manualDivision?: RhythmGuideDivision;
  automaticDivisions?: readonly number[];
  dotted?: boolean;
}
export interface RhythmGridGeometry {
  endTick: number;
  endX: number;
  division: RhythmGuideDivision;
  majorStep: number;
  anchors: RhythmAnchor[];
  gridAnchors: Array<RhythmAnchor & { muted?: boolean }>;
}

/** Shared musical ruler math. Each renderer supplies its own engraved x positions. */
export function buildRhythmGrid(input: RhythmGridInput): RhythmGridGeometry | null {
  if (!Number.isFinite(input.endTick) || input.endTick <= 1e-8 || input.anchors.length < 2) return null;
  const buckets = new Map<number, { sum: number; count: number }>();
  for (const anchor of input.anchors) {
    if (!Number.isFinite(anchor.tick) || !Number.isFinite(anchor.x)) continue;
    const key = [...buckets.keys()].find(tick => Math.abs(tick - anchor.tick) < 1e-8) ?? anchor.tick;
    const bucket = buckets.get(key) ?? { sum: 0, count: 0 };
    bucket.sum += anchor.x; bucket.count++;
    buckets.set(key, bucket);
  }
  const anchors = [...buckets].map(([tick, value]) => ({ tick, x: value.sum / value.count })).sort((a, b) => a.tick - b.tick);
  if (anchors.length < 2) return null;
  const xAt = (tick: number): number => {
    const exact = anchors.find(anchor => Math.abs(anchor.tick - tick) < 1e-8);
    if (exact) return exact.x;
    const rightIndex = anchors.findIndex(anchor => anchor.tick > tick);
    if (rightIndex === 0) return anchors[0].x;
    if (rightIndex < 0) return anchors[anchors.length - 1].x;
    const left = anchors[rightIndex - 1], right = anchors[rightIndex];
    return left.x + (right.x - left.x) * (tick - left.tick) / Math.max(1e-8, right.tick - left.tick);
  };
  let requestedDivision = Math.max(4, input.beatType);
  if (input.mode === "manual") requestedDivision = Math.max(requestedDivision, input.manualDivision ?? 4);
  else for (const division of input.automaticDivisions ?? []) if (Number.isFinite(division)) requestedDivision = Math.max(requestedDivision, division);
  const allowed = [1, 2, 4, 8, 16, 32, 64] as const;
  const division = allowed.find(value => value >= Math.min(64, requestedDivision)) ?? 64;
  const compound = input.beatType === 8 && input.beats >= 6 && input.beats % 3 === 0;
  const majorStep = compound ? 3 * 4 / input.beatType : 4 / input.beatType;
  const minorStep = 4 / (input.dotted ? Math.min(128, division * 2) : division);
  const dottedStep = 6 / division;
  const tickCount = Math.ceil(input.endTick / minorStep - 1e-8);
  const gridAnchors = Array.from({ length: tickCount }, (_, index) => {
    const tick = index * minorStep;
    const muted = Boolean(input.dotted && Math.abs(tick / dottedStep - Math.round(tick / dottedStep)) >= 1e-7);
    return { tick, x: xAt(tick), muted };
  });
  return { endTick: input.endTick, endX: xAt(input.endTick), division, majorStep, anchors, gridAnchors };
}
