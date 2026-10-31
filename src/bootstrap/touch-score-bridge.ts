import type { ScoreSelectionMode, ScoreSurface, ScoreTouchCandidate } from "../editor/score-commands";
import type { TouchPoint, TouchRect } from "./touch-gesture-state";

/** A surface supplies geometry and delegates all editing to the shared editor. */
export interface TouchScoreSurface {
  activate(): void;
  zoom(): number;
  setZoom(zoom: number): void;
  pageAt(point: TouchPoint): HTMLElement | null;
  candidates(point: TouchPoint): ScoreTouchCandidate[];
  tap(point: TouchPoint, selection: ScoreSelectionMode, candidate?: ScoreTouchCandidate): void;
  marquee(rect: TouchRect, additive: boolean): void;
  context(point: TouchPoint): void;
}

const surfaces = new Map<ScoreSurface, TouchScoreSurface>();
export function registerTouchScoreSurface(id: ScoreSurface, surface: TouchScoreSurface): () => void {
  surfaces.set(id, surface);
  return () => { if (surfaces.get(id) === surface) surfaces.delete(id); };
}
export function touchScoreSurface(id: ScoreSurface): TouchScoreSurface | undefined { return surfaces.get(id); }
