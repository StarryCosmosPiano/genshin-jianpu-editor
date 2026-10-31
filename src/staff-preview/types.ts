import type { Chord, Note, Score } from "../score/score";
import type { JpwSourceNote } from "../editor/note-selection";
import type { EngravingStyle } from "../layout/style";
import type { HeaderTextField } from "../score/header-typography";
import type { NoteTimingDivision } from "../score/note-timing";

export type StaffHeaderField = HeaderTextField;
export interface StaffInputPosition {
  partIndex: number;
  measureIndex: number;
  /** Local quarter-note position, encoded as an exact Fraction. */
  offset: string;
  midi: number;
  step: string;
  octave: number;
  /** The effective visible grid can be finer than the requested coarse ruler. */
  gridDivision?: NoteTimingDivision;
}
export interface StaffEditorState {
  inputEnabled: boolean;
  cursor: { partIndex: number; measureIndex: number; offset: string; focusPitch: number | null;
    step?: string; octave?: number } | null;
  durationDivision: NoteTimingDivision;
  dotted: boolean;
  gridDivision: NoteTimingDivision;
  gridDotted: boolean;
  gridMode: "auto" | "manual";
  rhythmGuideEnabled: boolean;
}
/** Geometry is in the page's SVG coordinates, never in the hidden jianpu pane. */
export interface StaffInputSpan {
  partIndex: number;
  measureIndex: number;
  clef: "treble" | "bass";
  fifths: number;
  keyChanges: Array<{ tick: number; fifths: number }>;
  xStart: number;
  xEnd: number;
  yTop: number;
  yBottom: number;
  bottomLineY: number;
  lineSpacing: number;
  rulerY: number;
  division: NoteTimingDivision;
  anchors: Array<{ tick: number; x: number }>;
  gridAnchors: Array<{ tick: number; x: number; muted?: boolean }>;
  tupletGroups: Array<{ startTick: number; endTick: number; anchors: Array<{ tick: number; x: number }> }>;
}

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
  paper?: { widthPt: number; heightPt: number };
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
  /** Present for bounded selection playback; tone identity limits highlighting. */
  notes?: readonly Note[];
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
  inputSpans: StaffInputSpan[];
}
export interface StaffPreviewDocument {
  revision: number;
  pageWidth: number;
  pageHeight: number;
  pageCount: number;
  diagnostics: readonly string[];
  renderPage(index: number): StaffRenderedPage;
  pageForRef(ref: StaffNoteRef): number | null;
  /** Empty projected measures have no source chord to use as a page anchor. */
  pageForMeasure?(partIndex: number, measureIndex: number): number | null;
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
  /** Reveal the current semantic note or pending input after viewport changes. */
  revealEditorTarget?(): void;
  /** Move along actual rendered snap positions, including tuplet member columns. */
  moveInputCursor?(direction: -1 | 1): boolean;
  /** Render all pages independently of the virtualized on-screen viewport. */
  getExportPages(options?: { includeRhythmGuides?: boolean }): Promise<{ currentPage: number; pages: Array<{ page: number; svg: SVGSVGElement }> }>;
  /** Returning true consumes a wheel gesture in the staff surface. */
  handleWheel?(event: WheelEvent): boolean;
}
