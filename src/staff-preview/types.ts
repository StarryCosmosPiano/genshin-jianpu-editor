import type { Chord, Note, Score } from "../score/score";
import type { JpwSourceNote } from "../editor/note-selection";
import type { EngravingStyle } from "../layout/style";

/** References are valid only for one successfully laid-out source model. */
export interface StaffNoteRef { revision: number; id: string }
export interface StaffNoteTarget {
  ref: StaffNoteRef;
  note: Note;
  source: JpwSourceNote | null;
  partIndex: number;
  measureIndex: number;
  entryIndex: number;
  noteIndex: number;
  grace: boolean;
}
export interface StaffNoteRegistry {
  refFor(note: Note): StaffNoteRef | null;
  resolve(ref: StaffNoteRef): StaffNoteTarget | null;
  targets: readonly StaffNoteTarget[];
}
/** Consumers must never mutate the source model or its source ranges. */
export interface StaffPreviewSnapshot {
  revision: number;
  score: Score;
  sources: readonly JpwSourceNote[];
  registry: StaffNoteRegistry;
  current: boolean;
  engravingStyle?: Readonly<EngravingStyle>;
}
export interface StaffSelectionState {
  revision: number;
  notes: readonly Note[];
  primary: Note | null;
  origin: "score" | "text" | "staff";
}
export interface StaffPlaybackState {
  revision: number;
  chords: readonly Chord[] | null;
  pass: number;
  state: "stopped" | "loading" | "playing";
}
export interface StaffRenderedNote {
  ref: StaffNoteRef;
  chord: Chord;
  element: SVGElement;
  hitElement: SVGElement;
}
export interface StaffRenderedPage {
  svg: SVGSVGElement;
  notes: StaffRenderedNote[];
}
export interface StaffPreviewDocument {
  revision: number;
  pageWidth: number;
  pageHeight: number;
  pageCount: number;
  diagnostics: readonly string[];
  renderPage(index: number): StaffRenderedPage;
  pageForRef(ref: StaffNoteRef): number | null;
  pagesForChords(chords: readonly Chord[]): number[];
  dispose(): void;
}
export type StaffViewMode = "jianpu" | "compare" | "staff";
export type ScoreSurface = "jianpu" | "staff";
export interface StaffPreviewNavigation {
  readonly activeSurface: ScoreSurface;
  readonly staffVisible: boolean;
  getPageSummary(): { page: number; pages: number; zoom: number };
  goToPage(index: number): void;
  zoomBy(factor: number): void;
  resetZoom(): void;
  /** Render all pages independently of the virtualized on-screen viewport. */
  getExportPages(): Promise<{ currentPage: number; pages: Array<{ page: number; svg: SVGSVGElement }> }>;
  /** Returning true consumes a wheel gesture in the staff surface. */
  handleWheel?(event: WheelEvent): boolean;
}
