// App controller: CodeMirror editor <-> live relayout/render <-> paging <-> file I/O.
// Mirrors EditorController in CodeEditor.kt (doBind/tryLoad/updateLayout/paint/load/doSave).

import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState, EditorSelection, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
import { handleTextShortcut, remapShortcutEvent } from "./shortcuts";
import { positiveNumberError, showConfirmDialog, showInputDialog, showTextInput } from "../ui/app-dialog";
import {
  jpwHighlighter,
  scoreSourceHighlighter,
  setScoreSourceHighlights,
  setSlashTimingDiagnostics,
  setSlashVoiceHighlights,
  slashTimingDiagnosticHighlighter,
  slashVoiceHighlighter,
} from "./highlight";
import { JpwFile, LayoutSection } from "../jpword/jpwfile";
import { fromJpw } from "../score/jpwimport";
import {
  Chord,
  CrossPartArpeggio,
  KeyMark,
  MusicCommon,
  Note as ScoreNote,
  PlayItem,
  Score,
  ScoreTextMark,
  TempoMark,
  Time,
  Tuplet,
} from "../score/score";
import { JinpuPainter } from "../layout/painter";
import {
  JpNumber,
  JpOctaveDot,
  KeySig,
  Lyric as LayoutLyric,
  NoteEntry,
  TextFrame,
  TimeSig,
  type PageItem,
} from "../layout/layout";
import {
  ENGRAVING_STYLE_SETTINGS_VERSION,
  normalizeEngravingStyle,
  restorePersistedEngravingStyle,
  type EngravingStyle,
  type RhythmGuideDivision,
} from "../layout/style";
import { Point } from "../common/geom";
import { Fraction } from "../common/fraction";
import { inputEntryFromNote, sourceAtActiveEnd } from "./input-entry";
import { keyboardNoteForKey } from "./keyboard-note";
import { replaceOpeningMeterDirective, scoreHeaderTarget, scoreHeaderValues, showScoreHeaderEditor, type HeaderTarget } from "./score-header";
import { MetaData } from "../smufl/smufl";
import { isPianoMusicXml, loadMusicXml } from "../score/musicxml";
import { abcToMusicXml } from "../abc/abc2xml";
import { scoreToJpwabc, scoreToJpwabcWithMeta, type JpwMeta, type JpwRange } from "../score/jpscore";
import { decodeJpwabc, encodeJpwabc, isTauriRuntime } from "./fileio";
import {
  classifyImportFile,
  editableDocumentFileInfo,
  fileStem,
  isJpwFile,
  isMidiFile,
  isSlashFile,
  replaceFileExtension,
  SCORE_OPEN_DESCRIPTION,
  SCORE_OPEN_INPUT_ACCEPT,
  SCORE_OPEN_PICKER_ACCEPT,
  SCORE_OPEN_TAURI_EXTENSIONS,
  slashKindHint,
} from "./file-format";
import { parseEditableDocument } from "./document-parser";
import { preserveUnchangedSlashGroups } from "./preserve-slash-delimiters";
import { documentContextHistory } from "./document-history";
import { MixedPainter } from "../mixed/painter";
import { ScorePlayer, type InputAuditionNote, type PlayState, type Sf2PlaybackOptions } from "./player";
import { buildTimeline, quarterToSeconds } from "../score/timeline";
import {
  openSoundfontDirectory,
  readSoundfontCatalog,
  type SoundfontCatalogEntry,
} from "./soundfonts";
import { recognizeImage, recognizeMusicppDetailed, agyAvailable, renderRecognitionSvg, renderRowPopup, renderHeaderPopup, type OmrMethod, type RecogView } from "../omr";
import type { Binary, RecognizedScore } from "../omr";
import { analyzeMidi, midiToScore, parseMidi } from "../midi";
import { showMidiImportDialog } from "./midi-dialog";
import {
  showImportFailureDialog,
  showMusicXmlImportDialog,
  type MusicXmlImportOptions,
} from "./musicxml-dialog";
import {
  analyzeSlashScore,
  defaultSlashScoreOptions,
  embedSlashScoreOptions,
  embedSlashScoreOptionsFromScore,
  hasSlashScoreLines,
  MAX_SLASH_VOICES,
  migrateSlashVoiceCount,
  migrateSlashDelimiters,
  notationAnnotationsFromScore,
  parseSlashScore,
  replaceSlashScoreLines,
  rewriteSlashDurationDirectives,
  scoreToSlashScore,
  SLASH_VOICE_SEPARATOR,
  slashPitchSources,
  slashVoiceMarker,
  slashScoreTemplate,
  stripSlashScoreOptions,
  stripSlashVoiceMarkers,
  type SlashDurationDivision,
  type SlashScoreDiagnostic,
  type SlashScoreKind,
  type SlashScoreOptions,
} from "../slashscore";
import { showSlashScoreImportDialog, showSlashScoreSettingsDialog } from "./slash-dialog";
import {
  buildJpwSourceNotes,
  buildSlashSourceNotes,
  editJpwPitch,
  editSlashPitch,
  type JpwSourceNote,
  type PitchEdit,
} from "./note-selection";
import {
  mergeDuplicateChordPitches,
  normalizeNoteTimingEdits,
  moveScoreNotesOnTimeline,
  noteTimingStep,
  resizeScoreNoteSegmentsWithRests,
  serializeJpwNoteTimingEdits,
  type NoteTimingDivision,
} from "../score/note-timing";
import {
  applyInputTimeSignature,
  completeInputMeasure,
  createInputTriplet,
  deleteInputMeasures as deleteScoreInputMeasures,
  ensureInputMeasure,
  inputChordDegreeAtCursor,
  inputNoteAtCursor,
  inputRestAtCursor,
  inputTripletCursorDelta,
  inputTupletAtCursor,
  insertInputMeasureAfter,
  insertInputMeasureBefore,
  moveInputNoteToPart,
  moveInputTieChainByNotationDomain,
  removeInputTriplet,
  resizeInputTuplet,
  isInputMeasureEmpty,
  replaceInputContinuationAtCursor,
  tupletActualToWritten,
  tupletWrittenToActual,
} from "../score/input-edit";
import {
  inputChordAt,
  inputDegreeSpec,
  inputKeyAt,
  inputNoteClosestToPitch,
  ScoreInputSession,
  type InputCursorSnapshot,
} from "./input-mode";
import { applyKeyChangeKeepingDegrees } from "../score/key-edit";
import {
  showKeyCircleDialog,
  showTimeSignatureDialog,
} from "./notation-input-dialog";

interface SelectedScoreNote {
  source: JpwSourceNote;
  /** The exact rendered segment that was clicked (it may be a gray tie continuation). */
  visualNote: ScoreNote;
  verse: number;
  element: SVGGElement;
}

interface SelectedScoreObject {
  kind: "tempo" | "key" | "meter" | "text" | "ornament" | "fermata" | "grace" | "arpeggio" | "cross-arpeggio" | "tuplet";
  mark: TempoMark | KeyMark | Time | ScoreTextMark | Chord | ScoreNote | CrossPartArpeggio | Tuplet;
  element: SVGGElement;
  measureIndex?: number;
  partIndex?: number;
}

interface SelectionAnchor {
  position: number;
  verse: number;
  partIndex?: number;
  chordIndex?: number;
  grace?: boolean;
  toneIndex?: number;
  pitch?: number;
  absoluteTick?: string;
  visualTick?: string;
}

interface ScoreDeleteAction {
  notes: JpwRange[];
  tempoKeys: string[];
}

interface ScoreDragSelection {
  page: number;
  svg: SVGSVGElement;
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  additive: boolean;
  moved: boolean;
}

interface BrowserWritableFile {
  write(data: Uint8Array | Blob): Promise<void>;
  close(): Promise<void>;
}

interface BrowserFileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<BrowserWritableFile>;
}

export type PlaybackSoundSource = "default" | "sf2";

export interface PageRenderSettings {
  pageW: number;
  pageH: number;
  fontSize: number;
  titleSize: number;
  creditSize: number;
  color: number;
}

export interface PlaybackInstrumentGroup {
  key: string;
  label: string;
  parts: number[];
}

const ENGRAVING_STYLE_PREVIEW_JPW = `.Title
Title = {全功能排版预览}
SubTitle = {升降号、倚音、和弦、连音与下一谱行}
Composer = {示例作曲}
Arranger = {示例编曲}
Instrument = {钢琴}
KeyAndMeters = {1=C,4/4}
Tempo = {90}
TempoMarks = {2@0=rit;2@3=tempo:72}
Arpeggios = {1:1@2;2:1@0}
.Voice.RH
{2'}3'_ #4'_ b5'_ #b6'_ [1'3'5']- |$(true)
{(3}1'_ 2'_ 3'_) (5' 5') 0 |]$(true,0,0,true)
.Voice.LH
[1,3,5,]--- |$(true)
[b1,,3,#5,] 0 2, 3, |]$(true,0,0,true)
`;

// Default TXT voice palette deliberately omits blue because blue is reserved
// for score/editor selection. The last enabled voice is always the uncoloured
// default row; V5+ require an explicit user-selected colour.
const DEFAULT_SLASH_VOICE_COLORS = [
  "#dc2626", // V1 red
  "#eab308", // V2 yellow
  "#16a34a", // V3 green
  "#9333ea", // V4 purple
  "", "", "", "", "",
];

export class App {
  painter: JinpuPainter;
  view!: EditorView;
  scorePane: HTMLElement;
  pageEls: HTMLElement[] = [];
  private wiredScorePages = new WeakSet<SVGSVGElement>();
  pageIndex = 0;
  filePath: string | null = null;
  /** The editor may keep native JPW text or an editable slash-score `.txt` source. */
  documentFormat: "jpw" | SlashScoreKind = "jpw";
  slashOptions: SlashScoreOptions | null = null;
  slashVoiceColors = [...DEFAULT_SLASH_VOICE_COLORS];
  textVoiceColoring = true;
  scoreVoiceColoring = false;
  showInvisibleVoiceMarkers = false;
  mode: "jp" | "mixed" | "recognize" = "jp";
  mixedXmlText: string | null = null;
  private _mixedPainter: MixedPainter | null = null;
  private _mixedBtnEl: HTMLButtonElement | null = null;
  // 识别模式：二值图 + 带源图坐标的识别结果（仅 musicpp 本地路产出），供叠加核对。
  private _recogBin: Binary | null = null;
  private _recogScore: RecognizedScore | null = null;
  private _recognizeBtnEl: HTMLButtonElement | null = null;
  // 识别视图（原位叠加/附近浮窗/仅原图）+ 下拉选择器 + 悬停浮窗 div。
  recogView: RecogView = "floating";
  private _recogViewSelectEl: HTMLSelectElement | null = null;
  private _recogPopupEl: HTMLDivElement | null = null;
  // 识别对象 → jpwabc 代码区间映射（导入时序列化产出，随编辑经 mapPos 迁移）。
  private _recogMeta: JpwMeta | null = null;
  private _lastImportMeta: JpwMeta | null = null; // 最近一次 xml 导入的序列化映射，供 recognizeBytes 接管
  // 乐句排版：缓存导入时的「原始排版」文本以便无损切回；_phraseOn 记当前是否乐句排版。
  private _phraseBtnEl: HTMLButtonElement | null = null;
  private _origLayoutText: string | null = null;
  private _phraseOn = false;
  private _readOnlyCompartment = new Compartment();
  private _historyCompartment = new Compartment();
  // render settings (app-level, not part of the .jpwabc document)
  pageW = 595;
  pageH = 842;
  fontSize = 28;
  titleSize = 48;
  creditSize = 36;
  color = 0xff000000; // ARGB
  engravingStyle: EngravingStyle = normalizeEngravingStyle();
  private _engravingPreview: EngravingStyle | null = null;
  private _pagePreview: PageRenderSettings | null = null;
  private _layoutBreakDescription: string | null = null;
  mixedHideBarNumber = false; // 混排：隐藏小节号
  zoom = 1; // 谱面显示缩放（应用到 #score-pane 的 --score-zoom）
  previewLocked = false;
  codePaneSide: "left" | "right" = "left";
  codePaneCollapsed = false;
  codePaneWidth = 320;
  beatPositionFormat: "fraction" | "decimal" = "fraction";
  showTextOnStartup = true;
  restoreLastFileOnStartup = false;
  private _lastInteraction: "score" | "text" | null = null;
  private _workspaceChangeQueued = false;
  private meta: MetaData;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private previewDirty = false;
  private zoomSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private selectedEls = new Set<SVGGElement>();
  private _sourceNotes: JpwSourceNote[] = [];
  private _slashTimingDiagnostics: SlashScoreDiagnostic[] = [];
  private _selectedNotes: SelectedScoreNote[] = [];
  private _selectedObjects: SelectedScoreObject[] = [];
  private _pendingSelectionAnchors: SelectionAnchor[] | null = null;
  private _mergeDuplicatePitchesOnSelectionRelease = false;
  private _duplicatePitchMergeQueued = false;
  private _rangeAnchorPosition: number | null = null;
  private _softDeletedNotes: JpwRange[] = [];
  private _softDeletedTempoKeys = new Set<string>();
  private _scoreUndoStack: ScoreDeleteAction[] = [];
  private _syncingCodeSelection = false;
  private _dragSelection: ScoreDragSelection | null = null;
  private _suppressPageClick = false;
  statusEl: HTMLElement | null = null;
  private _player: ScorePlayer | null = null;
  private _playBtnEl: HTMLButtonElement | null = null;
  private _stopBtnEl: HTMLButtonElement | null = null;
  private _previewLockBtnEl: HTMLButtonElement | null = null;
  private _inputModeBtnEl: HTMLButtonElement | null = null;
  private readonly _input = new ScoreInputSession();
  private _inputCursorOverlay: SVGGElement | null = null;
  private _inputFocusedEl: SVGGElement | null = null;
  /** True when the final synchronized rest bar was created by this input
   * session and may therefore be removed again if it remains untouched. */
  private _inputTailCreated = false;
  /** Exact rendered system chosen by the last pointer hit. It prevents an
   * up/down placeholder from jumping to another overlapping score group. */
  private _inputSpanOwner: PageItem | null = null;
  private _inputContextMenu: HTMLDivElement | null = null;
  /** The writing/resize step is independent from the cursor snap grid. */
  private _inputDurationDivision: NoteTimingDivision | null = null;
  /** Augment the selected writing value without changing its base division. */
  private _inputDurationDotted = false;
  /** Per-part linear volume in [0,1]; index = part index. Missing = 1 (full). */
  partVolumes: number[] = [];
  playbackSoundSource: PlaybackSoundSource = "default";
  selectedSoundfontId = "";
  soundfontInstrumentByGroup: Record<string, string> = {};
  soundfontCatalog: SoundfontCatalogEntry[] = [];
  private _hasSavedCurrent = false;
  private _suggestedSavePath: string | null = null;
  private _browserSaveHandle: BrowserFileHandle | null = null;
  private _browserOpenHandle: BrowserFileHandle | null = null;
  private static readonly SETTINGS_KEY = "jpeditor-render-settings";
  private static readonly LAST_FILE_KEY = "jpeditor-last-file";

  constructor(meta: MetaData, scorePane: HTMLElement) {
    this.meta = meta;
    this.painter = new JinpuPainter(this.fontSize);
    this.configurePainter(this.painter);
    this.scorePane = scorePane;
    this.scorePane.tabIndex = 0;
    this.scorePane.addEventListener("pointerdown", () => { this._lastInteraction = "score"; });
    this.scorePane.addEventListener("keydown", (event) => this.onScoreKeyDown(event));
    document.addEventListener("pointerdown", (event) => {
      if (this._inputContextMenu && !this._inputContextMenu.contains(event.target as Node)) {
        this.closeInputContextMenu();
      }
    });
  }

  private configurePainter(painter: JinpuPainter, color = this._pagePreview?.color ?? this.color): void {
    painter.layout.options.smuflMeta = this.meta;
    painter.layout.options.color = color;
    painter.layout.options.titleSize = this._pagePreview?.titleSize ?? this.titleSize;
    painter.layout.options.creditSize = this._pagePreview?.creditSize ?? this.creditSize;
    painter.layout.options.applyEngravingStyle(this._engravingPreview ?? this.engravingStyle);
  }

  /** Apply page-size / font-size / title-size / credit-size / color render settings and re-render. */
  applyRenderSettings(opts: { pageW?: number; pageH?: number; fontSize?: number; titleSize?: number; creditSize?: number; color?: number }): void {
    if (opts.pageW) this.pageW = opts.pageW;
    if (opts.pageH) this.pageH = opts.pageH;
    if (opts.color !== undefined) this.color = opts.color;
    if (opts.titleSize !== undefined) this.titleSize = opts.titleSize;
    if (opts.creditSize !== undefined) this.creditSize = opts.creditSize;
    if (opts.fontSize && opts.fontSize !== this.fontSize) {
      this.fontSize = opts.fontSize;
      const score = this.painter.score;
      this.painter = new JinpuPainter(this.fontSize);
      this.configurePainter(this.painter);
      this.painter.score = score;
    }
    this.configurePainter(this.painter);
    this.saveSettings();
    this.reload(this.getText());
  }

  /** Apply a numbered-notation engraving style; preview changes need not persist. */
  setEngravingStyle(style: Partial<EngravingStyle>, persist = true, render?: Partial<PageRenderSettings>): void {
    this.engravingStyle = normalizeEngravingStyle(style);
    this._engravingPreview = null;
    this._pagePreview = null;
    if (render) Object.assign(this, this.normalizedPageSettings(render));
    this.preparePreviewPainter();
    this.syncRhythmGridToolbar();
    if (persist) this.saveSettings();
    if (this.view && this.mode === "jp") this.relayoutCurrentScoreModel();
  }

  /** Preview is application state: no source edits, parsing or persistence. */
  setEngravingPreview(style: Partial<EngravingStyle> | null, render?: Partial<PageRenderSettings>): void {
    if (style === null && this._engravingPreview === null && this._pagePreview === null) return;
    this._engravingPreview = style === null ? null : normalizeEngravingStyle(style);
    this._pagePreview = style === null || !render ? null : this.normalizedPageSettings(render);
    this.preparePreviewPainter();
    if (this.view && this.mode === "jp") this.relayoutCurrentScoreModel();
  }

  private normalizedPageSettings(render: Partial<PageRenderSettings>): PageRenderSettings {
    const bounded = (value: number | undefined, fallback: number, min: number, max: number): number =>
      value !== undefined && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    return {
      pageW: bounded(render.pageW, this.pageW, 100, 4000),
      pageH: bounded(render.pageH, this.pageH, 100, 4000),
      fontSize: bounded(render.fontSize, this.fontSize, 8, 96),
      titleSize: bounded(render.titleSize, this.titleSize, 8, 144),
      creditSize: bounded(render.creditSize, this.creditSize, 8, 144),
      color: render.color ?? this.color,
    };
  }

  private preparePreviewPainter(): void {
    const size = this._pagePreview?.fontSize ?? this.fontSize;
    if (this.painter.layout.fontSize !== size) {
      const score = this.painter.score;
      this.painter = new JinpuPainter(size);
      this.painter.score = score;
    }
    this.configurePainter(this.painter);
  }

  /** Select one direct-edit grid; selecting the active value again restores auto. */
  setRhythmEditDivision(division: NoteTimingDivision | null): void {
    if (division !== null && this.documentFormat !== "jpw") {
      const limits = this.slashTimingGridLimits();
      if (division > limits.enabledMaximum) {
        this.showToolbarNotice(
          `当前文本谱最细只能写到 ${limits.enabledMaximum} 分音符；请先映射对应的时值符号或设置音符自身时值`,
        );
        this.syncRhythmGridToolbar();
        return;
      }
    }
    const next = division === null
      ? { ...this.engravingStyle, rhythmGuideMode: "auto" as const }
      : {
        ...this.engravingStyle,
        rhythmGuideMode: "manual" as const,
        rhythmGuideDivision: division as RhythmGuideDivision,
      };
    this.setEngravingStyle(next, true);
    this._input.setDivision(division ?? this.activeTimingDivision());
    this.renderInputCursor();
    this.setStatus(division === null
      ? "节奏编辑刻度已恢复自动；方向键会采用所选音符所在小节的最短网格"
      : `节奏编辑刻度已设为${division === 1 ? "全音符" : `${division} 分音符`}；左右方向键按此步长移动`);
  }

  /** Select the duration used when entering, moving, or resizing a note.
   * Leaving it automatic follows the current cursor grid. */
  setInputDurationDivision(division: NoteTimingDivision | null): void {
    if (division !== null && this.documentFormat !== "jpw") {
      const limits = this.slashTimingGridLimits();
      if (division > limits.enabledMaximum) {
        this.showToolbarNotice(
          `当前文本谱最细只能写到 ${limits.enabledMaximum} 分音符；请先映射对应的时值符号或设置音符自身时值`,
        );
        return;
      }
    }
    this._inputDurationDivision = division;
    if (!this.inputDurationDotAvailable()) this._inputDurationDotted = false;
    this.saveSettings();
    this.syncRhythmGridToolbar();
    const dotUnavailable = !this.inputDurationDotAvailable();
    this.setStatus(division === null
      ? "书写时值已跟随光标刻度"
      : `书写时值已设为${division === 1 ? "全音符" : `${division} 分音符`}；光标仍按刻度移动${dotUnavailable ? "；当前已是最细时值，附点不可用" : ""}`);
  }

  /** Toggle the augmentation dot for the currently visible half of the
   * compact timing toolbar. Grid and writing value keep independent states. */
  toggleTimingDot(mode?: "grid" | "duration"): void {
    const control = document.getElementById("rhythm-grid-control");
    const durationMode = (mode ?? control?.dataset.toolbarMode) === "duration";
    if (durationMode) {
      if (!this.inputDurationDotAvailable()) {
        if (this._inputDurationDotted) {
          this._inputDurationDotted = false;
          this.saveSettings();
        }
        this.syncRhythmGridToolbar();
        this.setStatus("当前书写时值已经是可用的最细时值，不能再启用附点");
        return;
      }
      this._inputDurationDotted = !this._inputDurationDotted;
      this.saveSettings();
      this.syncRhythmGridToolbar();
      this.setStatus(this._inputDurationDotted
        ? "书写时值已启用附点；输入、空格前进和时值调整使用 1.5 倍时值"
        : "书写时值已取消附点");
      return;
    }
    const dotted = !this.engravingStyle.rhythmGuideDotted;
    this.setEngravingStyle({ ...this.engravingStyle, rhythmGuideDotted: dotted }, true);
    this._input.setDivision(this.activeTimingDivision());
    this.renderInputCursor();
    this.setStatus(dotted
      ? "刻度已启用附点；非附点的二进制刻度保留为灰色参考线"
      : "刻度已取消附点");
  }

  private inputDurationStep(): Fraction {
    const division = this._inputDurationDivision
      ?? this._input.cursor?.division
      ?? this.activeTimingDivision();
    const step = noteTimingStep(division);
    return this._inputDurationDotted && this.inputDurationDotAvailable(division)
      ? step.timesInt(3).divInt(2)
      : step;
  }

  /** Inside a Tuplet, its written member value is the only legal edit/input
   * step.  The global duration selector resumes as soon as the cursor leaves
   * the fixed 3:2 domain. */
  private inputDurationAtCursor(): Fraction {
    const cursor = this._input.cursor;
    if (cursor) {
      const tuplet = inputTupletAtCursor(this.painter.score, cursor);
      if (tuplet?.writtenUnit && tuplet.writtenUnit.compareTo(new Fraction(0)) > 0) {
        return tuplet.writtenUnit;
      }
    }
    return this.inputDurationStep();
  }

  private inputDurationDotAvailable(
    division: NoteTimingDivision = this._inputDurationDivision
      ?? this._input.cursor?.division
      ?? this.activeTimingDivision(),
    maximum?: number,
  ): boolean {
    const finest = maximum ?? (this.documentFormat === "jpw"
      ? 64
      : this.slashTimingGridLimits().enabledMaximum);
    // A dotted value needs one additional half-cell. At the finest writable
    // division that cell cannot be represented without silently quantizing it.
    return division < finest;
  }

  private inputGridStep(): Fraction {
    const division = this._input.cursor?.division ?? this.activeTimingDivision();
    const step = noteTimingStep(division);
    return this.engravingStyle.rhythmGuideDotted ? step.timesInt(3).divInt(2) : step;
  }

  syncRhythmGridToolbar(): void {
    const limits = this.documentFormat === "jpw"
      ? { base: 64, visibleMaximum: 64, enabledMaximum: 64, implicitCompact: false }
      : this.slashTimingGridLimits();
    // The writing value is shared by JPW and TXT views.  JPW can expose a
    // 64th-note value that the current TXT duration alphabet cannot encode.
    // Clamp it at the same boundary as the visible rhythm grid when changing
    // formats, instead of leaving a hidden 64th-note edit value active.
    if (this.documentFormat !== "jpw"
      && this._inputDurationDivision !== null
      && this._inputDurationDivision > limits.enabledMaximum) {
      this._inputDurationDivision = limits.enabledMaximum as NoteTimingDivision;
      this._inputDurationDotted = false;
      this.saveSettings();
    }
    let selected = this.engravingStyle.rhythmGuideMode === "manual"
      ? this.engravingStyle.rhythmGuideDivision
      : null;
    if (this.documentFormat !== "jpw"
      && selected !== null
      && selected > limits.enabledMaximum) {
      const clamped = limits.enabledMaximum as RhythmGuideDivision;
      selected = clamped;
      this.engravingStyle = normalizeEngravingStyle({
        ...this.engravingStyle,
        rhythmGuideMode: "manual",
        rhythmGuideDivision: clamped,
      });
      this.painter.layout.options.applyEngravingStyle(this.engravingStyle);
      this.saveSettings();
    }
    const control = document.getElementById("rhythm-grid-control");
    if (control) {
      const toolbarMode = control.dataset.toolbarMode === "duration" ? "duration" : "grid";
      control.dataset.mode = (toolbarMode === "duration" ? this._inputDurationDivision : selected) === null ? "auto" : "manual";
      control.querySelectorAll<HTMLButtonElement>("button[data-rhythm-division]").forEach((button) => {
        const division = parseInt(button.dataset.rhythmDivision ?? "", 10);
        const active = selected !== null && division === selected;
        const unavailable = division > limits.enabledMaximum;
        button.hidden = division > limits.visibleMaximum;
        button.classList.toggle("grid-unavailable", unavailable);
        button.dataset.gridUnavailable = String(unavailable);
        button.setAttribute("aria-disabled", "false");
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
        if (unavailable) {
          button.title = `${division} 分音符需要先设置音符自身时值或映射更细的时值符号`;
        } else {
          button.title = `${division === 1 ? "全音符" : `${division} 分音符`}刻度；再次点击恢复自动`;
        }
      });
      const durationControl = control.querySelector<HTMLElement>(".rhythm-grid-options[data-rhythm-mode=\"duration\"]");
      if (durationControl) {
        const duration = this._inputDurationDivision;
        durationControl.dataset.mode = duration === null ? "auto" : "manual";
        durationControl.querySelectorAll<HTMLButtonElement>("button[data-input-duration-division]").forEach((button) => {
          const value = parseInt(button.dataset.inputDurationDivision ?? "", 10);
          const active = duration !== null && value === duration;
          const unavailable = value > limits.enabledMaximum;
          button.hidden = value > limits.visibleMaximum;
          button.classList.toggle("grid-unavailable", unavailable);
          button.dataset.gridUnavailable = String(unavailable);
          button.setAttribute("aria-disabled", "false");
          button.classList.toggle("active", active);
          button.setAttribute("aria-pressed", String(active));
          button.title = unavailable
            ? `${value} 分音符需要先设置音符自身时值或映射更细的时值符号`
            : `${value === 1 ? "全音符" : `${value} 分音符`}时值`;
        });
      }
      for (const dotButton of control.querySelectorAll<HTMLButtonElement>("#rhythm-dot-toggle, #rhythm-grid-dot-toggle, #input-duration-dot-toggle")) {
        const dotMode = dotButton.id === "input-duration-dot-toggle" ? "duration"
          : dotButton.id === "rhythm-grid-dot-toggle" ? "grid" : toolbarMode;
        const dotAvailable = dotMode !== "duration"
          || this.inputDurationDotAvailable(undefined, limits.enabledMaximum);
        if (!dotAvailable && this._inputDurationDotted) {
          this._inputDurationDotted = false;
          this.saveSettings();
        }
        const dotted = dotMode === "duration"
          ? this._inputDurationDotted
          : this.engravingStyle.rhythmGuideDotted;
        dotButton.classList.toggle("active", dotted);
        dotButton.setAttribute("aria-pressed", String(dotted));
        dotButton.disabled = !dotAvailable;
        dotButton.setAttribute("aria-disabled", String(!dotAvailable));
        dotButton.title = !dotAvailable
          ? "当前书写时值已经是可用的最细时值，不能使用附点"
          : dotMode === "duration"
            ? `${dotted ? "取消" : "启用"}书写时值附点`
          : `${dotted ? "取消" : "启用"}附点刻度；非主刻度会保留为灰色`;
        control.dataset.dotted = String(dotted);
      }
      for (const [id, active] of [["rhythm-grid-auto", selected === null], ["input-duration-auto", this._inputDurationDivision === null]] as const) {
        const button = document.getElementById(id);
        button?.classList.toggle("active", active);
        button?.setAttribute("aria-pressed", String(active));
      }
    }
  }

  private slashTimingGridLimits(): {
    base: SlashDurationDivision;
    visibleMaximum: SlashDurationDivision;
    enabledMaximum: SlashDurationDivision;
    implicitCompact: boolean;
  } {
    const values = [
      this.slashOptions?.noteDivision ?? 4,
      this.slashOptions?.spaceDivision ?? 4,
      ...Object.values(this.slashOptions?.symbolDurations ?? {}),
    ];
    const base = ([4, 8, 16, 32, 64] as SlashDurationDivision[])
      .find((division) => division >= Math.min(64, Math.max(4, ...values))) ?? 64;
    // Ordinary adjacent TXT atoms never create a hidden finer grid.  A finer
    // editable value must have its own duration mapping (or intrinsic note
    // value); marker-only adjacency is reserved for grace-note spelling.
    const implicitCompact = false;
    const visibleMaximum = base;
    const enabledMaximum = base;
    return { base, visibleMaximum, enabledMaximum, implicitCompact };
  }

  /** Restore persisted render settings; call before mountEditor() so first render uses them. */
  loadSettings(): void {
    try {
      const raw = localStorage.getItem(App.SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<{
        pageW: number; pageH: number; fontSize: number;
        titleSize: number; creditSize: number; color: number; zoom: number;
        mixedHideBarNumber: boolean;
        pageOrientationVersion: number;
        engravingStyleVersion: number;
        engravingStyle: Partial<EngravingStyle>;
        slashVoiceColors: string[];
        slashVoiceColorVersion: number;
        textVoiceColoring: boolean;
        scoreVoiceColoring: boolean;
        showInvisibleVoiceMarkers: boolean;
        codePaneSide: "left" | "right";
        codePaneCollapsed: boolean;
        codePaneWidth: number;
        workspaceLayoutVersion: number;
        beatPositionFormat: "fraction" | "decimal";
        showTextOnStartup: boolean;
        restoreLastFileOnStartup: boolean;
        partVolumes: number[];
        playbackSoundSource: PlaybackSoundSource;
        selectedSoundfontId: string;
        soundfontInstrumentByGroup: Record<string, string>;
        inputDurationDivision: NoteTimingDivision | null;
        inputDurationDotted: boolean;
      }>;
      if (s.mixedHideBarNumber !== undefined) this.mixedHideBarNumber = s.mixedHideBarNumber;
      // Older settings always stored the former 16:9 default even when the
      // user never selected a direction. Migrate those installations to the
      // new portrait default; subsequent explicit choices carry version 1.
      if (s.pageOrientationVersion === 1) {
        if (s.pageW) this.pageW = s.pageW;
        if (s.pageH) this.pageH = s.pageH;
      }
      if (s.titleSize !== undefined) this.titleSize = s.titleSize;
      if (s.creditSize !== undefined) this.creditSize = s.creditSize;
      if (s.color !== undefined) this.color = s.color;
      const restoredStyle = restorePersistedEngravingStyle(
        s.engravingStyle, s.engravingStyleVersion,
      );
      this.engravingStyle = restoredStyle.style;
      if (s.slashVoiceColorVersion === 2 && Array.isArray(s.slashVoiceColors)) {
        this.slashVoiceColors = this.slashVoiceColors.map((fallback, index) => {
          const value = s.slashVoiceColors?.[index];
          return value === "" || (typeof value === "string" && /^#[\da-f]{6}$/i.test(value))
            ? value
            : fallback;
        });
      }
      if (s.textVoiceColoring !== undefined) this.textVoiceColoring = s.textVoiceColoring;
      if (s.scoreVoiceColoring !== undefined) this.scoreVoiceColoring = s.scoreVoiceColoring;
      if (s.showInvisibleVoiceMarkers !== undefined) {
        this.showInvisibleVoiceMarkers = s.showInvisibleVoiceMarkers;
      }
      if (s.workspaceLayoutVersion === 2 && (s.codePaneSide === "left" || s.codePaneSide === "right")) {
        this.codePaneSide = s.codePaneSide;
      }
      if (s.workspaceLayoutVersion === 2 && typeof s.codePaneCollapsed === "boolean") {
        this.codePaneCollapsed = s.codePaneCollapsed;
      }
      if (Number.isFinite(s.codePaneWidth)) {
        this.codePaneWidth = Math.max(220, Math.min(720, s.codePaneWidth!));
      }
      if (s.beatPositionFormat === "fraction" || s.beatPositionFormat === "decimal") this.beatPositionFormat = s.beatPositionFormat;
      if (typeof s.showTextOnStartup === "boolean") this.showTextOnStartup = s.showTextOnStartup;
      if (typeof s.restoreLastFileOnStartup === "boolean") this.restoreLastFileOnStartup = s.restoreLastFileOnStartup;
      if (Array.isArray(s.partVolumes)) {
        this.partVolumes = s.partVolumes.map((value) =>
          Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1);
      }
      if (s.playbackSoundSource === "default" || s.playbackSoundSource === "sf2") {
        this.playbackSoundSource = s.playbackSoundSource;
      }
      if (typeof s.selectedSoundfontId === "string") {
        this.selectedSoundfontId = s.selectedSoundfontId;
      }
      if (s.soundfontInstrumentByGroup && typeof s.soundfontInstrumentByGroup === "object") {
        this.soundfontInstrumentByGroup = Object.fromEntries(
          Object.entries(s.soundfontInstrumentByGroup)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
      }
      if (s.inputDurationDivision === null
        || (typeof s.inputDurationDivision === "number"
          && [1, 2, 4, 8, 16, 32, 64].includes(s.inputDurationDivision))) {
        this._inputDurationDivision = s.inputDurationDivision;
      }
      if (typeof s.inputDurationDotted === "boolean") {
        this._inputDurationDotted = s.inputDurationDotted;
      }
      if (s.zoom) this.zoom = s.zoom;
      this._applyZoom();
      if (s.fontSize && s.fontSize !== this.fontSize) {
        this.fontSize = s.fontSize;
        const score = this.painter.score;
        this.painter = new JinpuPainter(this.fontSize);
        this.configurePainter(this.painter);
        this.painter.score = score;
      }
      this.configurePainter(this.painter);
      this.syncRhythmGridToolbar();
      this.syncCodePaneLayout();
      // Persist the version only after every legacy setting has been read;
      // an earlier write would replace unread fields with constructor defaults.
      if (restoredStyle.needsVersionSave) this.saveSettings();
    } catch {
      // corrupt storage — ignore
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(App.SETTINGS_KEY, JSON.stringify({
        pageW: this.pageW,
        pageH: this.pageH,
        pageOrientationVersion: 1,
        fontSize: this.fontSize,
        titleSize: this.titleSize,
        creditSize: this.creditSize,
        color: this.color,
        engravingStyleVersion: ENGRAVING_STYLE_SETTINGS_VERSION,
        engravingStyle: this.engravingStyle,
        slashVoiceColors: this.slashVoiceColors,
        slashVoiceColorVersion: 2,
        textVoiceColoring: this.textVoiceColoring,
        scoreVoiceColoring: this.scoreVoiceColoring,
        showInvisibleVoiceMarkers: this.showInvisibleVoiceMarkers,
        codePaneSide: this.codePaneSide,
        codePaneCollapsed: this.codePaneCollapsed,
        codePaneWidth: this.codePaneWidth,
        workspaceLayoutVersion: 2,
        beatPositionFormat: this.beatPositionFormat,
        showTextOnStartup: this.showTextOnStartup,
        restoreLastFileOnStartup: this.restoreLastFileOnStartup,
        partVolumes: this.partVolumes,
        playbackSoundSource: this.playbackSoundSource,
        selectedSoundfontId: this.selectedSoundfontId,
        soundfontInstrumentByGroup: this.soundfontInstrumentByGroup,
        inputDurationDivision: this._inputDurationDivision,
        inputDurationDotted: this._inputDurationDotted,
        zoom: this.zoom,
        mixedHideBarNumber: this.mixedHideBarNumber,
      }));
    } catch {
      // storage unavailable — ignore
    }
  }

  // ---------------- zoom ----------------
  /** 设置谱面缩放（夹在 [0.25, 4]），持久化。 */
  setZoom(z: number): void {
    this.zoom = Math.min(4, Math.max(0.25, z));
    this._applyZoom();
    // 连续缩放（滚轮/捏合）期间不每帧写盘，停止后再持久化一次。
    clearTimeout(this.zoomSaveTimer);
    this.zoomSaveTimer = setTimeout(() => this.saveSettings(), 400);
  }
  zoomBy(factor: number): void {
    this.setZoom(this.zoom * factor);
  }
  resetZoom(): void {
    this.setZoom(1);
  }
  private _applyZoom(): void {
    this.scorePane.style.setProperty("--score-zoom", String(this.zoom));
    this.notifyWorkspaceChange();
  }

  setPreviewLockBtn(element: HTMLButtonElement): void {
    this._previewLockBtnEl = element;
    this.syncPreviewLockButton();
  }

  togglePreviewLock(): void {
    this.previewLocked = !this.previewLocked;
    clearTimeout(this.debounceTimer);
    this.syncPreviewLockButton();
    if (this.previewLocked) {
      this.setStatus("谱面已锁定：继续编辑文本不会触发实时重排");
      return;
    }
    const needsReload = this.previewDirty;
    this.previewDirty = false;
    if (needsReload) {
      const ok = this.reload(this.getText());
      this.setStatus(ok ? "谱面已解锁并更新到最新文本" : "谱面已解锁，但最新文本暂时无法解析");
    } else {
      this.setStatus("谱面已解锁：恢复实时预览");
    }
  }

  private syncPreviewLockButton(): void {
    const button = this._previewLockBtnEl ?? document.getElementById("btn-preview-lock") as HTMLButtonElement | null;
    if (!button) return;
    button.classList.toggle("active", this.previewLocked);
    button.setAttribute("aria-pressed", String(this.previewLocked));
    button.textContent = this.previewLocked ? "解锁谱面" : "锁定谱面";
    button.title = this.previewLocked
      ? "当前停止文本实时重排；点击后更新并恢复预览"
      : "暂停文本编辑引起的实时重排，便于流畅录入";
  }

  setCodePaneSide(side: "left" | "right"): void {
    if (this.codePaneSide === side) return;
    this.codePaneSide = side;
    this.syncCodePaneLayout();
    this.saveSettings();
  }

  toggleCodePane(): void {
    this.codePaneCollapsed = !this.codePaneCollapsed;
    this.syncCodePaneLayout();
    this.saveSettings();
  }

  private syncCodePaneLayout(): void {
    const body = document.getElementById("body");
    const toggle = document.getElementById("code-pane-toggle") as HTMLButtonElement | null;
    if (!body) return;
    body.dataset.codePaneSide = this.codePaneSide;
    body.style.setProperty("--code-pane-width", `${this.codePaneWidth}px`);
    body.classList.toggle("code-pane-collapsed", this.codePaneCollapsed);
    if (toggle) {
      const pointsTowardPane = this.codePaneSide === "left" ? "▶" : "◀";
      const pointsTowardScore = this.codePaneSide === "left" ? "◀" : "▶";
      toggle.textContent = this.codePaneCollapsed ? pointsTowardPane : pointsTowardScore;
      toggle.title = this.codePaneCollapsed ? "展开文本编辑器" : "隐藏文本编辑器";
      toggle.setAttribute("aria-expanded", String(!this.codePaneCollapsed));
      toggle.setAttribute("aria-label", toggle.title);
    }
    this.notifyWorkspaceChange();
    if (this.view) requestAnimationFrame(() => this.view.requestMeasure());
  }

  mountEditor(parent: HTMLElement, initialText: string): void {
    const contextHistory = documentContextHistory(() => ({
      format: this.documentFormat,
      options: this.slashOptions,
    }));
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        const context = u.state.field(contextHistory.field);
        this.documentFormat = context.format;
        this.slashOptions = structuredClone(context.options);
        // 识别映射随用户编辑迁移偏移，保持点选仍落在正确 token。
        if (this._recogMeta) this._recogMeta = mapMeta(this._recogMeta, u.changes);
        if (this._selectedNotes.length > 0) {
          this._pendingSelectionAnchors = this._selectedNotes.map((selection) => ({
            ...this.selectionAnchor(selection),
            position: u.changes.mapPos(selection.source.from, -1),
          }));
        }
        if (this._rangeAnchorPosition !== null) {
          this._rangeAnchorPosition = u.changes.mapPos(this._rangeAnchorPosition, -1);
        }
        this._softDeletedNotes = this._softDeletedNotes.map((range) => ({
          from: u.changes.mapPos(range.from, -1),
          to: u.changes.mapPos(range.to, 1),
        }));
        this._scoreUndoStack = [];
        this.scheduleReload();
      } else if (u.selectionSet && !this._syncingCodeSelection) {
        this._lastInteraction = "text";
        this.syncScoreSelectionsFromCode();
      }
    });
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          lineNumbers(),
          this._historyCompartment.of(history()),
          contextHistory.extension,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorState.allowMultipleSelections.of(true),
          jpwHighlighter,
          scoreSourceHighlighter,
          slashTimingDiagnosticHighlighter,
          slashVoiceHighlighter,
          Prec.high(EditorView.domEventHandlers({
            keydown: (event) => this.onEditorKeyDown(event),
            pointerdown: () => { this._lastInteraction = "text"; return false; },
            focus: () => { this._lastInteraction = "text"; return false; },
          })),
          updateListener,
          this._readOnlyCompartment.of(EditorState.readOnly.of(false)),
          EditorView.lineWrapping,
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-content": { fontFamily: "ui-monospace, Menlo, Consolas, monospace" },
          }),
        ],
      }),
    });
    this.syncCodePaneLayout();
    this.reload(initialText);
  }

  getText(): string {
    return this.view.state.doc.toString();
  }

  setText(text: string): void {
    this.deselect(false);
    this.resetSoftDeletedState();
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
    });
    // dispatch triggers updateListener -> scheduleReload, but reload now for snappiness
    this.reload(text);
  }

  /** A newly opened score starts its own undo history. Keeping the previous
   * document here could write its notes into the new file after Ctrl+Z. */
  private resetDocumentUndo(): void {
    this._lastInteraction = null;
    this._input.setEnabled(this.painter.score, false, this.activeTimingDivision());
    this._inputSpanOwner = null;
    this._inputTailCreated = false;
    this._pendingSelectionAnchors = null;
    this.deselect(false);
    this.stopInputAudition();
    this.syncInputModeUi();
    this.renderInputCursor();
    document.dispatchEvent(new CustomEvent("editor:document-replaced"));
    this.view.dispatch({ effects: this._historyCompartment.reconfigure([]) });
    this.view.dispatch({ effects: this._historyCompartment.reconfigure(history()) });
  }

  private resetSoftDeletedState(): void {
    this._softDeletedNotes = [];
    this._softDeletedTempoKeys.clear();
    this._scoreUndoStack = [];
  }

  private scheduleReload(): void {
    clearTimeout(this.debounceTimer);
    if (this.previewLocked) {
      this.previewDirty = true;
      this.syncPreviewLockButton();
      return;
    }
    this.debounceTimer = setTimeout(() => this.reload(this.getText()), 200);
  }

  /** parse -> import -> layout -> render. Returns false on parse failure (text kept). */
  reload(text: string): boolean {
    // Programmatic edits render immediately. Cancel the text listener's
    // pending parse so it cannot repeat the same full-score work afterwards.
    clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.syncScoreSettingsButton();
    // 混排/识别模式：谱面区显示各自专属视图，编辑文本不重排冲掉它。
    if (this.mode !== "jp") return true;
    const previousHeader = scoreHeaderValues(this.painter.score);
    if (this._pendingSelectionAnchors === null && this._selectedNotes.length > 0) {
      this._pendingSelectionAnchors = this._selectedNotes.map((selection) =>
        this.selectionAnchor(selection));
    }
    let parsedDocument;
    try {
      parsedDocument = parseEditableDocument(text, this.documentFormat, this.slashOptions);
    } catch (e) {
      console.error(`${this.documentFormat === "jpw" ? "JPW" : "slash-score"} import failed`, e);
      return false;
    }
    if (!parsedDocument) return false;
    const score = parsedDocument.score;
    const slashTimingDiagnostics: SlashScoreDiagnostic[] = parsedDocument.slashTimingDiagnostics;
    const breakDesc = parsedDocument.breakDescription;
    this._layoutBreakDescription = breakDesc;
    if (parsedDocument.slashOptions) this.slashOptions = parsedDocument.slashOptions;

    this.painter.score = score;
    if (this._input.enabled) this._input.restore(score, this._input.snapshot());
    this._slashTimingDiagnostics = slashTimingDiagnostics;
    this._sourceNotes = this.documentFormat === "jpw"
      ? buildJpwSourceNotes(text, score)
      : buildSlashSourceNotes(text, this.slashOptions!, score, parsedDocument.slashSources ?? undefined);
    this.syncRhythmGridToolbar();
    this.updateSlashTimingDiagnostics();
    this.updateSlashVoiceHighlights(parsedDocument.slashSources ?? undefined);
    this.applySoftDeletedModelState();
    try {
      this.painter.resize(this._pagePreview?.pageW ?? this.pageW, this._pagePreview?.pageH ?? this.pageH, breakDesc);
    } catch (e) {
      console.error("layout failed", e);
      return false;
    }
    this.renderPages();
    this.applyScoreVoiceColors();
    // Propagate header-only changes from text edits and undo/redo without
    // replacing unrelated pending fields in an already-open inspector.
    const header = scoreHeaderValues(score);
    const headerChanges = Object.fromEntries((Object.keys(header) as Array<keyof typeof header>)
      .filter(key => header[key] !== previousHeader[key]).map(key => [key, header[key]]));
    if (Object.keys(headerChanges).length) {
      document.dispatchEvent(new CustomEvent("editor:header-changed", { detail: headerChanges }));
    }
    const timingErrors = this._slashTimingDiagnostics.filter((item) =>
      item.severity === "error");
    if (timingErrors.length > 0) {
      this.setStatus(
        `发现 ${timingErrors.length} 行小节时值错误：`
        + `${timingErrors.map((item) => `第 ${item.line} 行`).join("、")}；`
        + "文本行和对应谱面小节已标红，悬停行尾警告可查看原因",
      );
    }
    this.previewDirty = false;
    this.notifyWorkspaceChange();
    return true;
  }

  private updateSlashTimingDiagnostics(): void {
    if (!this.view) return;
    const diagnostics = this.documentFormat === "jpw"
      ? []
      : this._slashTimingDiagnostics;
    this.view.dispatch({
      effects: setSlashTimingDiagnostics.of(diagnostics.map((item) => ({
        severity: item.severity,
        line: item.line,
        from: item.from,
        to: item.to,
        message: item.message,
      }))),
    });
  }

  private updateSlashVoiceHighlights(scannedSources?: ReturnType<typeof slashPitchSources>): void {
    if (!this.view) return;
    if (this.documentFormat === "jpw"
      || (!this.textVoiceColoring && !this.showInvisibleVoiceMarkers)) {
      this.view.dispatch({ effects: setSlashVoiceHighlights.of([]) });
      return;
    }
    // Voice colouring is a lexical property of U+2063 and must survive even
    // when a malformed triplet cannot be mapped to a rendered Score chord.
    // Score-note mapping remains responsible only for click/highlight sync.
    const sources = scannedSources ?? (this.slashOptions
      ? slashPitchSources(this.getText(), this.slashOptions)
      : []);
    this.view.dispatch({
      effects: setSlashVoiceHighlights.of(sources.flatMap((source) => {
        if (!source.voiceIndex) return [];
        const color = this.activeSlashVoiceColor(source.voiceIndex);
        if (!color) return [];
        return [{
          from: source.from,
          to: source.to,
          markerFrom: source.markerFrom,
          voiceIndex: source.voiceIndex,
          color,
          decorateText: this.textVoiceColoring,
          showMarker: this.showInvisibleVoiceMarkers,
        }];
      })),
    });
  }

  /** The last/default TXT voice is intentionally uncoloured. */
  private activeSlashVoiceColor(voiceIndex: number): string | null {
    const count = this.slashOptions?.voiceCount ?? 1;
    if (voiceIndex >= count) return null;
    const color = this.slashVoiceColors[voiceIndex - 1] ?? "";
    return /^#[\da-f]{6}$/i.test(color) ? color : null;
  }

  private applyScoreVoiceColors(): void {
    if (!this.scoreVoiceColoring || this.documentFormat === "jpw") return;
    for (const source of this._sourceNotes) {
      if (!source.voiceIndex) continue;
      const color = this.activeSlashVoiceColor(source.voiceIndex);
      if (!color) continue;
      for (const rendered of this.painter.noteGroupEls(source.chord, source.note)) {
        rendered.element.classList.add("score-voice-colored");
        rendered.element.style.setProperty("--score-voice-color", color);
        rendered.element.querySelectorAll<SVGElement>("[fill]").forEach((element) => {
          if (element.getAttribute("fill") !== "none") element.setAttribute("fill", color);
        });
        rendered.element.querySelectorAll<SVGElement>("[stroke]").forEach((element) => {
          if (element.getAttribute("stroke") !== "none") element.setAttribute("stroke", color);
        });
      }
    }
  }

  /**
   * Render the current score through the production layout path for the
   * engraving dialog. A fixed two-system feature score keeps every formatting
   * control visible even when the open document does not contain that symbol.
   */
  renderEngravingStylePreview(style: Partial<EngravingStyle>): SVGSVGElement | null {
    const previewFile = JpwFile.fromString(ENGRAVING_STYLE_PREVIEW_JPW);
    if (!previewFile) return null;
    const previewScore = fromJpw(previewFile);
    if (!previewScore) return null;
    const fontSize = this._pagePreview?.fontSize ?? this.fontSize;
    const pageW = this._pagePreview?.pageW ?? this.pageW;
    const pageH = this._pagePreview?.pageH ?? this.pageH;
    const previewPainter = new JinpuPainter(fontSize);
    this.configurePainter(previewPainter);
    previewPainter.layout.options.applyEngravingStyle(style);
    previewPainter.score = previewScore;
    const previewPageHeight = Math.max(pageH, fontSize * 44);
    try {
      previewPainter.resize(
        pageW,
        previewPageHeight,
        previewFile.getSection(LayoutSection)?.desc ?? null,
      );
    } catch {
      return null;
    }
    if (previewPainter.pageCount === 0) return null;

    const page = previewPainter.layout.pages[0];
    const systems: Array<{ item: PageItem; y: number }> = [];
    const walk = (item: PageItem): void => {
      if (item.classes.has("rhythmic-system") || item.classes.has("piano-system") || item.classes.has("ensemble-system")) {
        systems.push({ item, y: item.pos(page).y });
      }
      for (const child of item.children) walk(child);
    };
    walk(page);
    systems.sort((left, right) => left.y - right.y);

    const finalVisibleSystem = systems[Math.min(1, systems.length - 1)];
    const notationBottom = finalVisibleSystem
      ? finalVisibleSystem.y + finalVisibleSystem.item.height + previewPainter.layout.options.numberSize * 1.3
      : previewPageHeight * 0.42;
    const cropHeight = Math.min(
      previewPageHeight,
      Math.max(fontSize * 8, notationBottom),
    );
    const svg = previewPainter.renderPage(0);
    svg.setAttribute("viewBox", `0 0 ${pageW} ${cropHeight}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMin meet");
    svg.dataset.actualLayoutPreview = "true";
    return svg;
  }

  /**
   * Render a standalone `.jpwabc` snippet to its own `<svg>` for the help /
   * notation documentation examples. Uses a throwaway painter (does not touch
   * the live score) sharing this app's SMuFL metadata. Returns null on parse/
   * layout failure so the caller can silently drop unsupported examples.
   * The svg keeps the full page viewBox; crop to content via getBBox after it
   * is attached to the DOM.
   *
   * `titlePage: true` renders the real first music page with its publication
   * header; otherwise the header is disabled and the page footer is stripped
   * so only the notation example remains.
   */
  renderExampleSvg(jpwabc: string, opts: { width?: number; height?: number; titlePage?: boolean } = {}): SVGSVGElement | null {
    const width = opts.width ?? 1600;
    const height = opts.height ?? 540;
    let f: JpwFile | null;
    try {
      f = JpwFile.fromString(jpwabc);
    } catch {
      return null;
    }
    if (!f) return null;
    let score;
    try {
      score = fromJpw(f);
    } catch {
      return null;
    }
    if (!score) return null;
    // Lyric-less snippets get pass=0 → empty playData → blank layout. Synthesize
    // a single play pass over all measures so examples without .Words still render.
    if (score.playData.measures.length === 0 && score.parts[0]) {
      const pi = new PlayItem();
      pi.pass = 1;
      pi.mid = 0;
      pi.end = score.parts[0].measures.length;
      score.playData.measures.push(pi);
      score.playData.isSimpple = true;
    }
    const p = new JinpuPainter(this.fontSize);
    this.configurePainter(p, 0xff000000);
    p.score = score;
    const breakDesc = f.getSection(LayoutSection)?.desc ?? null;
    try {
      if (opts.titlePage) {
        p.resize(width, height, breakDesc);
        return p.renderPage(0);
      }
      p.pageWidth = width;
      p.pageHeight = height;
      p.layout.fromScore(score, breakDesc, width, height, false);
      const pg = p.layout.pages[0];
      if (!pg) return null;
      // fromScore appends the page-number footer as the last two children;
      // drop both footer frames so examples show only the music.
      if (pg.children.length > 2) pg.children.splice(pg.children.length - 2, 2);
      pg.update();
      return p.renderPage(0);
    } catch {
      return null;
    }
  }

  private renderPages(): void {
    this._player?.stop(); // relayout invalidates chord objects / highlight
    const previousPages = this.pageEls;
    this.pageEls = [];
    this.selectedEls.clear();
    for (let i = 0; i < this.painter.pageCount; i++) {
      const svg = this.painter.renderCachedPage(i);
      svg.querySelectorAll(".slash-measure-diagnostics, .score-input-cursor, .score-input-draft")
        .forEach((overlay) => overlay.remove());
      const existing = previousPages[i];
      const reused = existing?.firstElementChild === svg;
      const wrap = reused ? existing : document.createElement("div");
      wrap.className = "score-page-wrap";
      wrap.style.aspectRatio = `${this.painter.pageWidth} / ${this.painter.pageHeight}`;
      const maxWidth = this.painter.pageHeight > this.painter.pageWidth ? 720 : 960;
      wrap.style.width = `calc(min(${maxWidth}px, 100%) * var(--score-zoom, 1))`;
      if (!reused) wrap.appendChild(svg);
      if (!this.wiredScorePages.has(svg)) {
        this.wiredScorePages.add(svg);
        const idx = i;
        svg.addEventListener("click", (e) => this.onPageClick(idx, svg, e));
        svg.addEventListener("dblclick", (e) => this.onPageDoubleClick(idx, svg, e));
        svg.addEventListener("contextmenu", (e) => this.onInputContextMenu(idx, svg, e));
        svg.addEventListener("pointerdown", (e) => this.onPagePointerDown(idx, svg, e));
        svg.addEventListener("pointermove", (e) => this.onPagePointerMove(e));
        svg.addEventListener("pointerup", (e) => this.onPagePointerUp(e));
        svg.addEventListener("pointercancel", (e) => this.onPagePointerCancel(e));
      }
      if (this.scorePane.children[i] !== wrap) {
        this.scorePane.insertBefore(wrap, this.scorePane.children[i] ?? null);
      }
      this.pageEls.push(wrap);
    }
    while (this.scorePane.children.length > this.pageEls.length) {
      this.scorePane.lastElementChild!.remove();
    }
    this.applySlashMeasureDiagnostics();
    this.pageIndex = Math.min(this.pageIndex, Math.max(0, this.pageEls.length - 1));
    this.applySoftDeletedClasses();
    this.restoreScoreSelections();
    this.renderInputCursor();
  }

  private applySlashMeasureDiagnostics(): void {
    if (this.documentFormat === "jpw") return;
    const invalidLocations = new Map<number, Array<{
      beatIndex: number | null;
      beatCount: number;
    }>>();
    for (const diagnostic of this._slashTimingDiagnostics) {
      if (diagnostic.severity !== "error") continue;
      const locations = diagnostic.beatLocations.length > 0
        ? diagnostic.beatLocations
        : diagnostic.measureIndices.map((measureIndex) => ({
          measureIndex,
          beatIndex: null,
          beatCount: 1,
        }));
      for (const location of locations) {
        const values = invalidLocations.get(location.measureIndex) ?? [];
        if (!values.some((value) =>
          value.beatIndex === location.beatIndex
          && value.beatCount === location.beatCount)) {
          values.push({
            beatIndex: location.beatIndex,
            beatCount: Math.max(1, location.beatCount),
          });
        }
        invalidLocations.set(location.measureIndex, values);
      }
    }
    if (invalidLocations.size === 0) return;
    const namespace = "http://www.w3.org/2000/svg";

    for (const wrap of this.pageEls) {
      const svg = wrap.querySelector<SVGSVGElement>("svg");
      if (!svg) continue;
      const rootMatrix = svg.getCTM();
      if (!rootMatrix) continue;
      const rootInverse = rootMatrix.inverse();
      const boxInPage = (element: SVGGraphicsElement): DOMRect | null => {
        const matrix = element.getCTM();
        if (!matrix) return null;
        const transform = rootInverse.multiply(matrix);
        const box = element.getBBox();
        const points = [
          new DOMPoint(box.x, box.y),
          new DOMPoint(box.x + box.width, box.y),
          new DOMPoint(box.x + box.width, box.y + box.height),
          new DOMPoint(box.x, box.y + box.height),
        ].map((point) => point.matrixTransform(transform));
        const xs = points.map((point) => point.x);
        const ys = points.map((point) => point.y);
        const left = Math.min(...xs);
        const top = Math.min(...ys);
        return new DOMRect(
          left,
          top,
          Math.max(...xs) - left,
          Math.max(...ys) - top,
        );
      };

      const overlay = document.createElementNS(namespace, "g");
      overlay.setAttribute("class", "slash-measure-diagnostics");
      overlay.setAttribute("pointer-events", "none");
      for (const [measureIndex, locations] of invalidLocations) {
        const entries = [...svg.querySelectorAll<SVGGElement>(`.measure-${measureIndex}`)];
        const systems = new Map<SVGGElement, SVGGElement[]>();
        for (const entry of entries) {
          const system = entry.closest<SVGGElement>(
            ".rhythmic-system, .piano-system, .ensemble-system",
          );
          if (!system) continue;
          const group = systems.get(system) ?? [];
          group.push(entry);
          systems.set(system, group);
        }
        for (const [system, measureEntries] of systems) {
          const entryBoxes = measureEntries
            .map((entry) => boxInPage(entry))
            .filter((box): box is DOMRect => box !== null);
          if (entryBoxes.length === 0) continue;
          let left = Math.min(...entryBoxes.map((box) => box.x));
          let right = Math.max(...entryBoxes.map((box) => box.x + box.width));
          const currentBars = measureEntries
            .filter((entry) => entry.classList.contains("measure-barline"))
            .map((entry) => boxInPage(entry))
            .filter((box): box is DOMRect => box !== null);
          if (currentBars.length > 0) {
            right = Math.max(...currentBars.map((box) => box.x + box.width / 2));
          }
          const previousBar = system.querySelector<SVGGElement>(
            `.measure-${measureIndex - 1}.measure-barline`,
          );
          const previousBox = previousBar ? boxInPage(previousBar) : null;
          if (previousBox) left = previousBox.x + previousBox.width / 2;
          const systemBars = [...system.querySelectorAll<SVGGElement>(".measure-barline")]
            .map((entry) => boxInPage(entry))
            .filter((box): box is DOMRect => box !== null);
          const dynamicBarlineSelectors = system.classList.contains("piano-system")
            ? [".piano-system-left"]
            : system.classList.contains("ensemble-system")
              ? [".ensemble-bracket", ".ensemble-group-line"]
              : [];
          const dynamicBars = dynamicBarlineSelectors.flatMap((selector) =>
            [...system.querySelectorAll<SVGGraphicsElement>(selector)])
            .map((entry) => boxInPage(entry))
            .filter((box): box is DOMRect => box !== null);
          // Piano/ensemble barlines are extended after every row has been
          // normalized. Their final span follows the tallest upper chord and
          // lowest lower chord; the hand-local Barline groups retain only the
          // default number-row height and are therefore too short here.
          const heightBars = dynamicBars.length > 0
            ? dynamicBars
            : currentBars.length > 0 ? currentBars : systemBars;
          if (heightBars.length === 0) continue;
          const staffTop = Math.min(...heightBars.map((box) => box.y));
          const staffBottom = Math.max(...heightBars.map((box) => box.y + box.height));
          const measureWidth = Math.max(1, right - left);
          const rhythmBeatXs = [
            ...system.querySelectorAll<SVGGraphicsElement>(
              `.rhythm-guide-measure-${measureIndex}.rhythm-guide-major`,
            ),
          ]
            .map((tick) => boxInPage(tick))
            .filter((box): box is DOMRect => box !== null)
            .map((box) => box.x + box.width / 2)
            .sort((a, b) => a - b)
            .filter((x, index, values) =>
              index === 0 || Math.abs(x - values[index - 1]) > 0.5);
          const numberWidths = measureEntries.flatMap((entry) =>
            [...entry.querySelectorAll<SVGTextElement>("text")]
              .filter((text) => /^[0-7]$/.test(text.textContent ?? ""))
              .map((text) => boxInPage(text)?.width ?? 0))
            .filter((width) => width > 0);
          // Leave one full number-glyph width on either side of the exact
          // beat span. This follows zoom/font changes because it is measured
          // from the rendered notation rather than estimated from CSS pixels.
          const horizontalPadding = numberWidths.length > 0
            ? Math.max(...numberWidths)
            : Math.max(1, this.fontSize * 0.55);
          for (const location of locations) {
            const beatCount = Math.max(1, location.beatCount);
            const beatIndex = location.beatIndex;
            const proportionalLeft = beatIndex === null
              ? left
              : left + measureWidth * beatIndex / beatCount;
            const proportionalRight = beatIndex === null
              ? right
              : left + measureWidth * (beatIndex + 1) / beatCount;
            const beatLeft = beatIndex === null
              ? (rhythmBeatXs[0] ?? proportionalLeft)
              : (rhythmBeatXs[beatIndex] ?? proportionalLeft);
            const beatRight = beatIndex === null
              ? right
              : (rhythmBeatXs[beatIndex + 1]
                ?? (beatIndex === beatCount - 1 ? right : proportionalRight));
            const rectangle = document.createElementNS(namespace, "rect");
            rectangle.setAttribute("class", "slash-measure-error-box");
            rectangle.setAttribute("data-measure-index", String(measureIndex));
            rectangle.setAttribute(
              "data-beat-index",
              beatIndex === null ? "all" : String(beatIndex),
            );
            rectangle.setAttribute("x", String(beatLeft - horizontalPadding));
            rectangle.setAttribute("y", String(staffTop));
            rectangle.setAttribute("width", String(Math.max(
              horizontalPadding * 2,
              beatRight - beatLeft + horizontalPadding * 2,
            )));
            // A diagnostic occupies exactly the staff/barline span. Tempo,
            // measure numbers, headers and inter-system gaps stay outside.
            rectangle.setAttribute("height", String(Math.max(1, staffBottom - staffTop)));
            rectangle.setAttribute("rx", String(Math.max(2, this.fontSize * 0.08)));
            overlay.appendChild(rectangle);
          }
        }
      }
      // Beat diagnostics deliberately include one glyph of horizontal
      // breathing room. Adjacent bad beats therefore touch or overlap; merge
      // those intervals after geometry is known so the page shows one clean
      // continuous warning band instead of several stacked red outlines.
      const boxes = [...overlay.querySelectorAll<SVGRectElement>(
        ".slash-measure-error-box",
      )].sort((leftBox, rightBox) =>
        Number(leftBox.getAttribute("y")) - Number(rightBox.getAttribute("y"))
        || Number(leftBox.getAttribute("x")) - Number(rightBox.getAttribute("x")));
      let previous: SVGRectElement | null = null;
      for (const box of boxes) {
        if (!previous) {
          previous = box;
          continue;
        }
        const previousTop = Number(previous.getAttribute("y"));
        const previousHeight = Number(previous.getAttribute("height"));
        const top = Number(box.getAttribute("y"));
        const height = Number(box.getAttribute("height"));
        const previousLeft = Number(previous.getAttribute("x"));
        const previousRight = previousLeft + Number(previous.getAttribute("width"));
        const left = Number(box.getAttribute("x"));
        const right = left + Number(box.getAttribute("width"));
        const sameStaff = Math.abs(previousTop - top) <= 0.5
          && Math.abs(previousHeight - height) <= 0.5;
        if (sameStaff && left <= previousRight + 0.5) {
          const mergedLeft = Math.min(previousLeft, left);
          const mergedRight = Math.max(previousRight, right);
          previous.setAttribute("x", String(mergedLeft));
          previous.setAttribute("width", String(mergedRight - mergedLeft));
          previous.setAttribute("data-beat-index", "merged");
          box.remove();
        } else {
          previous = box;
        }
      }
      if (overlay.childElementCount > 0) svg.appendChild(overlay);
    }
  }

  // ---------------- notation input mode ----------------
  get inputModeEnabled(): boolean {
    return this._input.enabled;
  }

  setInputModeBtn(element: HTMLButtonElement): void {
    this._inputModeBtnEl = element;
    this.syncInputModeUi();
  }

  toggleInputMode(): void {
    this.setInputMode(!this._input.enabled);
  }

  private relayoutCurrentScoreModel(): void {
    const { scrollTop, scrollLeft } = this.scorePane;
    if (this._selectedNotes.length && this._pendingSelectionAnchors === null) {
      this._pendingSelectionAnchors = this._selectedNotes.map((selection) => this.selectionAnchor(selection));
    }
    try {
      this.painter.resize(this._pagePreview?.pageW ?? this.pageW, this._pagePreview?.pageH ?? this.pageH, this._layoutBreakDescription);
      this.renderPages();
      this.applyScoreVoiceColors();
    } catch (error) {
      console.error("input-mode relayout failed", error);
    } finally {
      this.scorePane.scrollTop = scrollTop;
      this.scorePane.scrollLeft = scrollLeft;
      this.notifyWorkspaceChange();
    }
  }

  setInputMode(enabled: boolean): void {
    if (enabled === this._input.enabled) return;
    const { scrollTop, scrollLeft } = this.scorePane;
    const primary = this.view.state.selection.main;
    const origin = this._lastInteraction;
    // Flush a pending text edit before resolving its active caret against notes.
    if (enabled && (this.debounceTimer !== undefined || this.previewDirty)) {
      if (!this.reload(this.getText())) {
        this.setStatus("当前文本尚不能解析，请先修正后再进入打谱");
        return;
      }
    }
    if (enabled && (this.mode !== "jp" || this.painter.score.parts.length === 0)) {
      this.setStatus("当前视图没有可输入的简谱声部");
      return;
    }
    const active = this._selectedNotes[this._selectedNotes.length - 1];
    const textSource = origin === "text"
      ? sourceAtActiveEnd(this._sourceNotes, primary.head, primary.anchor) : null;
    const entry = enabled && origin === "text"
      ? textSource && inputEntryFromNote(textSource, textSource.note, this.activeTimingDivision())
      : enabled && active
        ? inputEntryFromNote(active.source, active.visualNote, this.activeTimingDivision()) : null;
    this.deselect(false);
    this._pendingSelectionAnchors = null;
    if (!enabled) {
      this._inputSpanOwner = null;
      this.stopInputAudition();
    }
    const wasEnabled = this._input.enabled;
    this._input.setEnabled(this.painter.score, enabled, this.activeTimingDivision(), entry);
    if (!enabled) {
      const foldImplicitRests = wasEnabled
        && this.documentFormat !== "jpw"
        && this.slashOptions?.showExplicitRests === false;
      if (foldImplicitRests) {
        for (let partIndex = 0; partIndex < this.painter.score.parts.length; partIndex++) {
          const measureCount = this.painter.score.parts[partIndex]?.measures.length ?? 0;
          for (let measureIndex = 0; measureIndex < measureCount; measureIndex++) {
            completeInputMeasure(
              this.painter.score,
              { partIndex, measureIndex },
              false,
            );
          }
        }
      }
      const tailIndex = Math.max(0, ...this.painter.score.parts.map((part) => part.measures.length)) - 1;
      const removed = this._inputTailCreated
        && tailIndex > 0
        && isInputMeasureEmpty(this.painter.score, tailIndex)
        ? deleteScoreInputMeasures(this.painter.score, [tailIndex])
        : 0;
      this._inputTailCreated = false;
      if (removed > 0 || foldImplicitRests) {
        this.painter.score.parseRepeatInf();
        this.commitInputMutation(
          removed > 0
            ? `已清理 ${removed} 个全休止小节并完成隐藏休止符`
            : "已按前一音补齐并隐藏打谱空位中的休止符",
          null,
          false,
        );
      }
    }
    if (enabled) this.relayoutCurrentScoreModel();
    this.syncInputModeUi();
    this.renderInputCursor();
    this.scorePane.focus({ preventScroll: true });
    this.scorePane.scrollTop = scrollTop;
    this.scorePane.scrollLeft = scrollLeft;
    this.setStatus(enabled
      ? entry
        ? "已进入打谱模式：左右移动光标，上下选择和弦位置，1–7 输入；Ctrl 调时值/八度，Alt 移动音符/声部"
        : "打谱已启用：请点击谱面选择输入起点"
      : "已退出打谱模式，恢复普通选择与编辑");
  }

  /** Used by the touch keypad. */
  inputDegree(degree: number): void {
    if (!this._input.enabled || degree < 0 || degree > 7) return;
    if (!this._input.cursor) { this.setStatus("请先点击谱面选择输入起点"); return; }
    if (degree === 0) { this.typeInputRest(); return; }
    this.typeInputDegree(degree as 1 | 2 | 3 | 4 | 5 | 6 | 7);
  }

  setInputLane(lane: "rest" | "above" | "below"): void {
    if (!this._input.enabled) return;
    this._input.setLane(lane);
    this.renderInputCursor();
  }

  private syncInputModeUi(): void {
    const enabled = this._input.enabled;
    const durationControl = document.querySelector<HTMLElement>("#rhythm-grid-control .rhythm-grid-options[data-rhythm-mode=\"duration\"]");
    if (durationControl) {
      durationControl.hidden = false;
    }
    if (this._inputModeBtnEl) {
      this._inputModeBtnEl.classList.toggle("active", enabled);
      this._inputModeBtnEl.setAttribute("aria-pressed", String(enabled));
      const label = this._inputModeBtnEl.querySelector(".button-label, span:last-child");
      if (label) label.textContent = "打谱";
      else this._inputModeBtnEl.textContent = "打谱";
    }
    document.getElementById("btn-select-mode")?.setAttribute("aria-pressed", String(!enabled));
    document.body.classList.toggle("score-input-mode", enabled);
    const keypad = document.getElementById("score-input-keypad");
    if (keypad) keypad.hidden = !enabled;
    this.notifyWorkspaceChange();
  }

  private inputMeasureLength(partIndex: number, measureIndex: number): Fraction {
    const part = this.painter.score.parts[partIndex] ?? this.painter.score.parts[0];
    const measure = part?.measures[measureIndex]
      ?? part?.measures[Math.max(0, (part?.measures.length ?? 1) - 1)];
    return measure
      ? new Fraction(measure.time.beats * 4, measure.time.beatType)
      : new Fraction(4);
  }

  /** Keep exactly one synchronized, fully notated rest measure after the
   * latest sounding material. It is a real Score measure, not an HTML-only
   * draft, so barlines, picking, serialization and cross-bar extension all
   * use the production layout path. */
  private ensureFormalInputTail(forceAppend = false): boolean {
    const score = this.painter.score;
    if (score.parts.length === 0) return false;
    const count = Math.max(0, ...score.parts.map((part) => part.measures.length));
    const hasSharedEmptyTail = count > 0 && score.parts.every((part) => {
      const measure = part.measures[count - 1];
      if (!measure) return false;
      const chords = measure.entries.filter((entry): entry is Chord => entry instanceof Chord);
      return chords.length > 0 && chords.every((chord) => chord.rest);
    });
    if (hasSharedEmptyTail && !forceAppend) return false;
    const targetIndex = count;
    for (let partIndex = 0; partIndex < score.parts.length; partIndex++) {
      ensureInputMeasure(score, partIndex, targetIndex);
    }
    // Layout follows the repeat/play sequence when one already exists. Keep
    // that range synchronized so an in-memory TXT draft bar is immediately
    // visible before it has been written back to the source document.
    score.parseRepeatInf();
    this._inputTailCreated = true;
    return true;
  }

  /** Append measures only when an actual edit must extend sounding material
   * beyond the current score end. Merely entering input mode never calls this
   * path, so no independent draft bar appears. */
  private ensureInputTimelineThrough(partIndex: number, requiredEnd: Fraction): boolean {
    let created = false;
    for (let guard = 0; guard < 32; guard++) {
      const part = this.painter.score.parts[partIndex] ?? this.painter.score.parts[0];
      const last = part?.measures[part.measures.length - 1];
      const currentEnd = last
        ? last.position.plus(new Fraction(last.time.beats * 4, last.time.beatType))
        : new Fraction(0);
      if (currentEnd.compareTo(requiredEnd) >= 0) break;
      if (!this.ensureFormalInputTail(true)) break;
      created = true;
    }
    return created;
  }

  /** Keep the click tolerance constant on screen at every score zoom. */
  private pickScoreAtPointer(
    pageIndex: number,
    ctm: DOMMatrix,
    ev: MouseEvent,
    tolerancePixels = 3,
  ): PageItem | null {
    const point = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
    const scale = Math.max(0.01, Math.min(Math.hypot(ctm.a, ctm.b), Math.hypot(ctm.c, ctm.d)));
    return this.painter.pickPageAtPointer(pageIndex, new Point(point.x, point.y),
      ev.target, tolerancePixels / scale);
  }

  private inputHitFromPage(
    pageIndex: number,
    svg: SVGSVGElement,
    ev: MouseEvent,
  ): boolean {
    if (!this._input.enabled) return false;
    const ctm = svg.getScreenCTM();
    const inverse = ctm?.inverse() ?? null;
    const scorePoint = inverse
      ? new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inverse)
      : new DOMPoint(ev.clientX, ev.clientY);
    const screenY = (y: number): number => ctm
      ? new DOMPoint(0, y).matrixTransform(ctm).y
      : y;
    const exactPicked = ctm ? this.pickScoreAtPointer(pageIndex, ctm, ev, 0) : null;
    // An annotation/ornament click in input mode is an object selection, not
    // an attempt to move the rhythmic cursor to the nearest grid slot.
    if (ctm) {
      const picked = exactPicked ?? this.pickScoreAtPointer(pageIndex, ctm, ev);
      const object = picked ? this.scoreObjectHit(picked) : null;
      // A grace beam should select its source pitch just like the grace
      // number. The number itself remains a semantic grace-edit target in
      // input mode, because digit/octave commands operate on that object.
      if (object?.kind === "grace"
        && ev.target instanceof Element
        && ev.target.closest(".jianpu-grace-beam")) return false;
      // Picking verifies painted geometry, including the separate numeral
      // and bracket strokes, so their enclosing blank rectangle cannot win.
      if (object) {
        this.selectScoreObject(object, ev.ctrlKey || ev.metaKey || ev.shiftKey);
        ev.preventDefault();
        this.scorePane.focus({ preventScroll: true });
        return true;
      }
    }
    const spans = this.painter.rhythmInputSpansForPage(pageIndex, svg)
      .filter((span) => ev.clientY >= span.screenRect.top - 3
        && ev.clientY <= span.screenRect.bottom + 3
        && ev.clientX >= span.screenRect.left - 8
        && ev.clientX <= span.screenRect.right + 8);
    if (spans.length === 0) return false;
    const span = spans.sort((left, right) => {
      const rowDistance = (candidate: typeof left): number => {
        const rows = candidate.partRows ?? [];
        if (rows.length === 0) {
          if (ev.clientY < candidate.screenRect.top) return candidate.screenRect.top - ev.clientY;
          if (ev.clientY > candidate.screenRect.bottom) return ev.clientY - candidate.screenRect.bottom;
          return 0;
        }
        return Math.min(...rows.map((row) => {
          const top = screenY(row.yTop), bottom = screenY(row.yBottom);
          if (ev.clientY < top) return top - ev.clientY;
          if (ev.clientY > bottom) return ev.clientY - bottom;
          return 0;
        }));
      };
      const dx = (candidate: typeof left): number => {
        if (ev.clientX < candidate.screenRect.left) return candidate.screenRect.left - ev.clientX;
        if (ev.clientX > candidate.screenRect.right) return ev.clientX - candidate.screenRect.right;
        return 0;
      };
      return rowDistance(left) - rowDistance(right)
        || dx(left) - dx(right)
        || left.screenRect.height - right.screenRect.height;
    })[0];
    const partRows = span.partRows ?? [];
    const row = partRows.length > 0
      ? Math.max(0, partRows.reduce((best, candidate, index, rows) => {
        const bestRow = rows[best];
        const distanceToRow = (item: typeof candidate): number => {
          const top = screenY(item.yTop), bottom = screenY(item.yBottom);
          if (ev.clientY < top) return top - ev.clientY;
          if (ev.clientY > bottom) return ev.clientY - bottom;
          return 0;
        };
        const distance = distanceToRow(candidate);
        const bestDistance = distanceToRow(bestRow);
        if (distance !== bestDistance) return distance < bestDistance ? index : best;
        const center = (screenY(candidate.yTop) + screenY(candidate.yBottom)) / 2;
        const bestCenter = (screenY(bestRow.yTop) + screenY(bestRow.yBottom)) / 2;
        return Math.abs(ev.clientY - center) < Math.abs(ev.clientY - bestCenter) ? index : best;
      }, 0))
      : Math.max(0, Math.min(span.partIndexes.length - 1, Math.floor(
        ((ev.clientY - span.screenRect.top) / Math.max(1, span.screenRect.height)) * span.partIndexes.length,
      )));
    let partIndex = partRows[row]?.partIndex ?? span.partIndexes[row] ?? span.partIndexes[0] ?? 0;
    const division = Math.max(1, Math.min(64, span.division)) as NoteTimingDivision;
    const length = this.inputMeasureLength(partIndex, span.measureIndex);
    const step = this.engravingStyle.rhythmGuideDotted
      ? noteTimingStep(division).timesInt(3).divInt(2)
      : noteTimingStep(division);
    const anchors = span.anchors ?? [];
    const gridAnchors = span.gridAnchors ?? [];
    // Empty cells use the voice-local tuplet ruler only inside that group's
    // visible range. An unrelated ordinary note later in the measure must
    // never snap backwards into the nearest triplet.
    const tupletsForPart = (span.tupletGroups ?? [])
      .filter((group) => group.partIndex === partIndex && group.anchors.length > 0);
    const screenX = (x: number): number => ctm
      ? new DOMPoint(x, 0).matrixTransform(ctm).x
      : x;
    const distanceToTuplet = (group: (typeof tupletsForPart)[number]): number => {
      const left = Math.min(screenX(group.startX), screenX(group.endX));
      const right = Math.max(screenX(group.startX), screenX(group.endX));
      if (ev.clientX < left) return left - ev.clientX;
      if (ev.clientX > right) return ev.clientX - right;
      return 0;
    };
    const tupletGroup = tupletsForPart
      .filter((group) => distanceToTuplet(group) <= 3)
      .sort((left, right) => distanceToTuplet(left) - distanceToTuplet(right)
        || Math.abs(left.endX - left.startX) - Math.abs(right.endX - right.startX))[0];
    let rawOffset = Math.max(0, Math.min(length.toFloat(), scorePoint.x - span.svgRect.left));
    let offset: Fraction;
    if (tupletGroup && tupletGroup.anchors.length > 0) {
      // A 3:2 member does not lie on the surrounding binary ruler.  Snap the
      // whole tuplet range to its real rendered member columns, including an
      // explicit rest member whose glyph may not be the browser event target.
      const nearest = tupletGroup.anchors.reduce((best, anchor) =>
        Math.abs(screenX(anchor.x) - ev.clientX) < Math.abs(screenX(best.x) - ev.clientX)
          ? anchor
          : best, tupletGroup.anchors[0]);
      offset = new Fraction(Math.round(nearest.tick * 192), 192);
    } else if (gridAnchors.length > 0) {
      const activeGridAnchors = gridAnchors.some((anchor) => !anchor.muted)
        ? gridAnchors.filter((anchor) => !anchor.muted)
        : gridAnchors;
      const nearestIndex = activeGridAnchors.reduce((best, anchor, index, list) =>
        Math.abs(anchor.x - scorePoint.x) < Math.abs(list[best].x - scorePoint.x)
          ? index
          : best, 0);
      const tick = activeGridAnchors[nearestIndex]?.tick ?? 0;
      offset = new Fraction(Math.round(tick * 192), 192);
    } else {
      if (anchors.length > 0) {
        const left = [...anchors].reverse().find((anchor) => anchor.x <= scorePoint.x);
        const right = anchors.find((anchor) => anchor.x >= scorePoint.x);
        if (left && right && right.x > left.x) {
          rawOffset = left.tick + (scorePoint.x - left.x) / (right.x - left.x) * (right.tick - left.tick);
        } else if (left) rawOffset = left.tick;
        else if (right) rawOffset = right.tick;
      } else {
        rawOffset = Math.max(0, Math.min(length.toFloat(),
          (scorePoint.x - span.svgRect.left) / Math.max(1, span.svgRect.width) * length.toFloat()));
      }
      const slot = Math.max(0, Math.min(
        Math.max(1, Math.round(length.toFloat() / step.toFloat())) - 1,
        Math.round(rawOffset / step.toFloat()),
      ));
      offset = step.timesInt(slot);
    }

    let targetMeasureIndex = span.measureIndex;
    let focusPitch: number | null = null;
    if (exactPicked) {
      const hit = this.scoreNoteHit(exactPicked);
      if (hit && span.partIndexes.includes(hit.source.partIndex)
        && hit.visualNote.chord.measure.index === span.measureIndex) {
        // A directly clicked glyph wins over grid snapping. This preserves
        // exact tuplets and other non-grid attacks while empty space still
        // snaps to the visible ruler below the staff.
        partIndex = hit.source.partIndex;
        // In input mode a gray continuation is an editable rhythmic slot of
        // its own: typing over it creates a new attack and breaks the incoming
        // tie. Ordinary selection mode still maps it back to the source note.
        const visualChord = hit.visualNote.chord;
        const hitChord = this.isInputContinuationChord(visualChord)
          ? visualChord
          : hit.source.note.chord;
        offset = hitChord.position;
        targetMeasureIndex = hitChord.measure.index;
        focusPitch = hit.visualNote.pitch;
      }
    }
    const chord = this.painter.score.parts[partIndex]?.measures[targetMeasureIndex]
      ?.entries.find((entry): entry is Chord => entry instanceof Chord
        && entry.position.equals(offset)
        && (!entry.generatedTimingContinuation || this.isInputContinuationChord(entry))) ?? null;
    if (focusPitch === null) {
      focusPitch = inputNoteClosestToPitch(chord, this._input.focusPitch)?.pitch ?? null;
    }
    this._input.setCursor(this.painter.score, {
      partIndex,
      measureIndex: targetMeasureIndex,
      offset,
      division,
      lane: "rest",
    }, focusPitch);
    this._inputSpanOwner = targetMeasureIndex === span.measureIndex ? span.owner ?? null : null;
    const clickedNotes = chord?.notes.filter((note) => !note.rest)
      .sort((left, right) => left.pitch - right.pitch) ?? [];
    if (this._input.cursor) {
      this._input.cursor.verticalIndex = Math.max(0,
        clickedNotes.findIndex((note) => note.pitch === focusPitch));
    }
    this.selectInputFocus(ev.ctrlKey || ev.metaKey || ev.shiftKey);
    this.renderInputCursor();
    this.auditionInputCursor(ev.ctrlKey || ev.metaKey);
    this.setStatus(`打谱光标：${this.getPartLabel(partIndex)}，第 ${targetMeasureIndex + 1} 小节，${offset.toString()} 拍`);
    this.scorePane.focus({ preventScroll: true });
    ev.preventDefault();
    return true;
  }

  private renderInputCursor(): void {
    this.notifyWorkspaceChange();
    this._inputCursorOverlay?.remove();
    this._inputCursorOverlay = null;
    this._inputFocusedEl?.classList.remove("input-focused");
    this._inputFocusedEl = null;
    document.querySelector(".score-input-draft")?.remove();
    if (!this._input.enabled || !this._input.cursor) return;
    const cursor = this._input.cursor;
    // Looking up screen CTMs on every page forces content-visibility:auto
    // to lay out offscreen SVGs. Find the relevant pages in score coordinates
    // first; only the cursor's page needs a browser geometry measurement.
    const cursorPages = [...new Set(this.painter.layout.rhythmInputSpans
      .filter((span) => span.measureIndex === cursor.measureIndex
        && span.partIndexes.includes(cursor.partIndex))
      .map((span) => span.pageIndex))].sort((a, b) => a - b);
    for (const pageIndex of cursorPages) {
      if (!this.pageEls[pageIndex]) continue;
      const svg = this.pageEls[pageIndex].querySelector<SVGSVGElement>("svg");
      if (!svg) continue;
      const candidates = this.painter.rhythmInputSpansForPage(pageIndex, svg).filter((candidate) =>
        candidate.measureIndex === cursor.measureIndex
        && candidate.partIndexes.includes(cursor.partIndex));
      const span = candidates.find((candidate) => candidate.owner === this._inputSpanOwner)
        ?? candidates[0];
      if (!span) continue;
      this._inputSpanOwner = span.owner ?? null;
      const length = this.inputMeasureLength(cursor.partIndex, cursor.measureIndex);
      const tick = cursor.offset.toFloat();
      const anchors = span.anchors ?? [];
      const gridAnchors = span.gridAnchors ?? [];
      let x = span.svgRect.left + (span.svgRect.right - span.svgRect.left)
        * Math.max(0, Math.min(1, tick / Math.max(0.0001, length.toFloat())));
      const exactGrid = gridAnchors.find((anchor) => Math.abs(anchor.tick - tick) < 1e-8);
      if (exactGrid) {
        x = exactGrid.x;
      } else if (anchors.length > 0) {
        const right = anchors.find((anchor) => anchor.tick >= tick);
        const left = [...anchors].reverse().find((anchor) => anchor.tick <= tick);
        if (left && right && right.tick > left.tick) {
          const ratio = (tick - left.tick) / (right.tick - left.tick);
          x = left.x + (right.x - left.x) * ratio;
        } else if (left) x = left.x;
        else if (right) x = right.x;
      }
      const row = span.partRows?.find((item) => item.partIndex === cursor.partIndex);
      const rowTop = row?.yTop ?? span.svgRect.top;
      const rowBottom = row?.yBottom ?? span.svgRect.bottom;
      const rowHeight = Math.max(1, rowBottom - rowTop);
      const namespace = "http://www.w3.org/2000/svg";
      const overlay = document.createElementNS(namespace, "g");
      overlay.setAttribute("class", `score-input-cursor input-lane-${cursor.lane}`);
      overlay.setAttribute("pointer-events", "none");
      const chord = this.inputChordAtCursorIncludingContinuation();
      const focusedNote = inputNoteClosestToPitch(chord, this._input.focusPitch);
      const screenToSvgRect = (element: SVGGraphicsElement): {
        left: number; right: number; top: number; bottom: number;
      } | null => {
        const matrix = svg.getScreenCTM();
        if (!matrix) return null;
        const inverse = matrix.inverse();
        const rect = element.getBoundingClientRect();
        const corners = [
          new DOMPoint(rect.left, rect.top).matrixTransform(inverse),
          new DOMPoint(rect.right, rect.top).matrixTransform(inverse),
          new DOMPoint(rect.left, rect.bottom).matrixTransform(inverse),
          new DOMPoint(rect.right, rect.bottom).matrixTransform(inverse),
        ];
        return {
          left: Math.min(...corners.map((point) => point.x)),
          right: Math.max(...corners.map((point) => point.x)),
          top: Math.min(...corners.map((point) => point.y)),
          bottom: Math.max(...corners.map((point) => point.y)),
        };
      };
      const toneRects = chord?.notes.filter((note) => !note.rest).flatMap((note) => {
        const rendered = this.painter.noteGroupEls(chord, note)
          .find((item) => item.page === pageIndex);
        const rect = rendered ? screenToSvgRect(rendered.element) : null;
        return rect ? [{ note, element: rendered!.element, rect }] : [];
      }) ?? [];
      const focused = focusedNote
        ? toneRects.find(({ note }) => note === focusedNote)
        : null;
      // Keep every vertical lane on the exact rendered rhythm column.  The
      // engraving layout can place a glyph away from the raw ruler anchor
      // (most visibly around ties/continuations), so reverting to the grid x
      // when moving to the empty slot above or below makes the placeholder
      // jump sideways even though the focused note has not changed.
      if (focused) x = (focused.rect.left + focused.rect.right) / 2;
      if (cursor.lane === "rest" && focused) {
        focused.element.classList.add("input-focused");
        this._inputFocusedEl = focused.element;
      } else if (cursor.lane !== "rest" && toneRects.length > 0) {
        const numberSize = this.painter.layout.options.numberSize;
        const top = Math.min(...toneRects.map((item) => item.rect.top));
        const bottom = Math.max(...toneRects.map((item) => item.rect.bottom));
        const visualWidth = Math.max(...toneRects.map((item) => item.rect.right - item.rect.left));
        const width = Math.max(numberSize * 0.52, visualWidth);
        const height = Math.max(numberSize * 0.82,
          Math.min(numberSize * 1.12, ...toneRects.map((item) => item.rect.bottom - item.rect.top)));
        const gap = numberSize * 0.18;
        const y = cursor.lane === "above" ? top - gap - height : bottom + gap;
        const placeholder = document.createElementNS(namespace, "rect");
        placeholder.setAttribute("x", String(x - width / 2));
        placeholder.setAttribute("y", String(y));
        placeholder.setAttribute("width", String(width));
        placeholder.setAttribute("height", String(height));
        placeholder.setAttribute("rx", String(Math.max(1, numberSize * 0.08)));
        placeholder.setAttribute("class", "score-input-cell score-input-note-placeholder");
        overlay.append(placeholder);
      }
      const caret = document.createElementNS(namespace, "line");
      caret.setAttribute("x1", String(x));
      caret.setAttribute("x2", String(x));
      const caretHalf = Math.max(3, Math.min(rowHeight * 0.12,
        this.painter.layout.options.numberSize * 0.34));
      caret.setAttribute("y1", String(rowBottom - caretHalf));
      caret.setAttribute("y2", String(rowBottom + caretHalf * 0.55));
      caret.setAttribute("class", "score-input-caret");
      overlay.append(caret);
      const triangle = document.createElementNS(namespace, "path");
      const marker = Math.max(2.5, Math.min(5, rowHeight * 0.025));
      triangle.setAttribute("d", `M ${x - marker} ${rowBottom + caretHalf * 0.55} L ${x + marker} ${rowBottom + caretHalf * 0.55} L ${x} ${rowBottom + caretHalf * 0.55 + marker} Z`);
      triangle.setAttribute("class", "score-input-triangle");
      overlay.append(triangle);
      svg.append(overlay);
      this._inputCursorOverlay = overlay;
      break;
    }
  }

  private isInputContinuationChord(chord: Chord): boolean {
    const sounding = chord.notes.filter((note) => !note.rest);
    return chord.generatedTimingContinuation
      || chord.transparentContinuation
      || (sounding.length > 0 && sounding.every((note) => note.tiePrev !== null && note.tieEnd));
  }

  private inputChordAtCursorIncludingContinuation(): Chord | null {
    const cursor = this._input.cursor;
    if (!cursor) return null;
    const direct = inputChordAt(this.painter.score, cursor);
    if (direct) return direct;
    const measure = this.painter.score.parts[cursor.partIndex]?.measures[cursor.measureIndex];
    return measure?.entries.find((entry): entry is Chord =>
      entry instanceof Chord
      && entry.position.equals(cursor.offset)
      && this.isInputContinuationChord(entry)) ?? null;
  }

  private inputFocus(): { chord: Chord; note: ScoreNote } | null {
    const cursor = this._input.cursor;
    if (!cursor) return null;
    const chord = this.inputChordAtCursorIncludingContinuation();
    const note = inputNoteClosestToPitch(chord, this._input.focusPitch);
    return chord && note ? { chord, note } : null;
  }

  /** Make the input cursor use the same semantic note selection as normal
   * score editing, so the number turns blue and its exact TXT/JPW source span
   * is highlighted as well. */
  private selectInputFocus(additive: boolean): void {
    const focus = this.inputFocus();
    if (!additive) this.deselect(false);
    if (!focus) return;
    let source = this._sourceNotes.find((candidate) => candidate.note === focus.note)
      ?? this._sourceNotes.find((candidate) => candidate.chord === focus.chord
        && candidate.note.pitch === focus.note.pitch);
    if (!source && focus.note.tiePrev) {
      // Generated gray TXT continuations intentionally have no independent
      // source token. Select the black attack's token while keeping the gray
      // rendered segment as the visual selection target.
      let root = focus.note;
      const seen = new Set<ScoreNote>();
      while (root.tiePrev && !seen.has(root)) {
        seen.add(root);
        root = root.tiePrev;
      }
      source = this._sourceNotes.find((candidate) => candidate.note === root)
        ?? this._sourceNotes.find((candidate) => candidate.chord === root.chord
          && candidate.note.pitch === root.pitch);
    }
    if (!source) return;
    const rendered = this.painter.noteGroupEls(focus.chord, focus.note)[0];
    if (!rendered) return;
    this.addScoreSelection(source, rendered.verse, rendered.element, focus.note);
    this.syncCodeSelections(false);
  }

  private typeInputDegree(degree: 1 | 2 | 3 | 4 | 5 | 6 | 7): void {
    const cursor = this._input.cursor;
    if (!cursor) return;
    const score = this.painter.score;
    for (let partIndex = 0; partIndex < score.parts.length; partIndex++) {
      ensureInputMeasure(score, partIndex, cursor.measureIndex);
    }
    const spec = inputDegreeSpec(score, cursor, degree);
    const tiedFocus = this.inputFocus();
    if (cursor.lane === "rest"
      && tiedFocus
      && (tiedFocus.note.tiePrev !== null || tiedFocus.note.tieNext !== null)) {
      const tiedSpec = inputDegreeSpec(score, cursor, degree, tiedFocus.note.jpOctave);
      const chain = this.inputTieRootAndDuration(tiedFocus.note).notes;
      for (const member of chain) this.applyInputPitchSpec(member, tiedSpec);
      this._input.focusPitch = tiedSpec.pitch;
      this._input.setLane("rest");
      // A pitch-only edit must not materialize the cursor measure's implicit
      // TXT sustain as draft rests. Doing so changed the following gray tie
      // segments into 0 on the save/reparse round-trip.
      this.commitInputMutation(`已把整条延音同步改为 ${degree}`, undefined, false);
      this.selectInputFocus(false);
      this.auditionInputCursor(false);
      return;
    }
    const replacedContinuation = replaceInputContinuationAtCursor(
      score,
      cursor,
      spec,
      this._input.focusPitch,
    );
    if (replacedContinuation.changed && replacedContinuation.note && replacedContinuation.chord) {
      this._input.focusPitch = replacedContinuation.note.pitch;
      this._input.setLane("rest");
      this.commitInputMutation(`已把延音续音替换为新的 ${degree}`);
      this.selectInputFocus(false);
      this.auditionInputCursor(false);
      return;
    }
    const currentChord = inputChordAt(score, cursor);
    const freshAttack = !currentChord || currentChord.rest;
    const requestedDuration = this.inputDurationAtCursor();
    const anchor = inputNoteClosestToPitch(currentChord, this._input.focusPitch);
    let note: ScoreNote | null = null;
    let chord: Chord | null = currentChord;
    let fixedTupletCell = false;
    if (currentChord && !currentChord.rest && anchor && cursor.lane === "rest") {
      const spec = inputDegreeSpec(score, cursor, degree, anchor.jpOctave);
      anchor.pitch = spec.pitch;
      anchor.number = spec.number ?? String(degree);
      anchor.jpOctave = spec.jpOctave ?? anchor.jpOctave;
      anchor.jpAlter = spec.jpAlter ?? " ";
      note = anchor;
    } else if (currentChord && !currentChord.rest && anchor && cursor.lane !== "rest") {
      const result = inputChordDegreeAtCursor(
        score,
        cursor,
        anchor,
        degree,
        requestedDuration,
      );
      chord = result.chord;
      note = result.note;
      fixedTupletCell = result.fixedTupletCell === true;
      if (note) {
        const middle = inputDegreeSpec(score, cursor, degree, 0).pitch;
        note.jpOctave = Math.round((note.pitch - middle) / 12);
        note.jpAlter = " ";
      }
    } else {
      const result = inputNoteAtCursor(score, cursor, spec, requestedDuration);
      chord = result.chord;
      note = result.note;
      fixedTupletCell = result.fixedTupletCell === true;
    }
    if (!note || !chord) return;
    if (freshAttack && note.tuplet && chord.duration && !fixedTupletCell) {
      this.resizeTupletAttackToWrittenDuration(note, requestedDuration);
    } else if (freshAttack && !note.tuplet && chord.duration && chord.duration.compareTo(requestedDuration) < 0) {
      this.ensureFormalInputTail();
      let remaining = requestedDuration.minus(chord.duration);
      const beatStep = new Fraction(4, chord.measure.time.beatType);
      while (remaining.compareTo(new Fraction(0)) > 0) {
        const amount = remaining.compareTo(beatStep) < 0 ? remaining : beatStep;
        const extended = resizeScoreNoteSegmentsWithRests(
          score,
          [{ partIndex: cursor.partIndex, note, grace: false }],
          amount,
        );
        if (extended.changed === 0) break;
        remaining = remaining.minus(amount);
      }
    }
    if (chord.notes.filter((candidate) => !candidate.rest).length > 1) {
      chord.ornaments = chord.ornaments.filter((ornament) =>
        ornament.kind !== "upper-mordent"
        && ornament.kind !== "lower-mordent"
        && ornament.kind !== "trill");
    }
    if (this.documentFormat !== "jpw") {
      // The active TXT measure is an editable draft even when the document
      // normally hides rests. After splitting an implicit whole-note sustain
      // with a new quarter-note attack, materialize the remaining silence so
      // the immediate save/reload cannot stretch that new attack to the bar.
      // Once the cursor leaves this measure, ordinary hidden-rest
      // serialization is free to collapse the draft rests again.
      completeInputMeasure(score, cursor, true);
    }
    this._input.focusPitch = note.pitch;
    this._input.setLane("rest");
    this.commitInputMutation(`已输入 ${degree}${note.jpOctave > 0 ? "（高八度）" : note.jpOctave < 0 ? "（低八度）" : ""}`);
    this.selectInputFocus(false);
    this.auditionInputCursor(false);
  }

  /** Input-mode Delete/Backspace: turn the focused column into a rest. */
  private deleteInputFocus(): void {
    const cursor = this._input.cursor;
    if (!cursor) return;
    const focus = this.inputFocus();
    const result = inputRestAtCursor(
      this.painter.score,
      cursor,
      focus?.chord.duration ?? noteTimingStep(cursor.division),
      focus?.note ?? null,
    );
    if (!result.changed) {
      this.setStatus("当前光标没有可删除的音符");
      return;
    }
    this._input.setLane("rest");
    this._input.focusPitch = null;
    this.commitInputMutation("已将当前音符变为休止符");
  }

  /** Input-mode 0: insert only one grid-sized rest and preserve the tail. */
  private typeInputRest(): void {
    const cursor = this._input.cursor;
    if (!cursor) return;
    const result = inputRestAtCursor(
      this.painter.score,
      cursor,
      this.inputDurationAtCursor(),
    );
    if (!result.changed) {
      this.setStatus("当前位置不能插入休止符");
      return;
    }
    const tupleRest = result.rest?.notes.find((note) => note.tuplet !== null);
    if (tupleRest) this.resizeTupletAttackToWrittenDuration(tupleRest, this.inputDurationAtCursor());
    this._input.setLane("rest");
    this._input.focusPitch = null;
    this.commitInputMutation("已插入一个休止符");
  }

  private commitInputMutation(
    message: string,
    snapshot?: InputCursorSnapshot | null,
    preserveInputDraftRests = true,
  ): boolean {
    const cursor = snapshot ?? this._input.snapshot();
    const next = this.serializeCurrentScoreDocument(preserveInputDraftRests);
    if (next === null) {
      this.setStatus("当前时值无法写回这种文本谱；请映射对应的时值符号或设置音符自身时值");
      return false;
    }
    const ok = this.replaceDocumentText(next);
    if (ok) {
      this._input.restore(this.painter.score, cursor);
    }
    this.renderInputCursor();
    this.setStatus(ok ? message : "输入后的谱面暂时无法重新解析");
    return ok;
  }

  private insertInputMeasureAt(referenceIndex: number, side: "before" | "after"): void {
    const score = this.painter.score;
    const inserted = side === "before"
      ? insertInputMeasureBefore(score, referenceIndex)
      : insertInputMeasureAfter(score, referenceIndex);
    if (inserted.length === 0) {
      this.setStatus("当前位置不能插入小节");
      return;
    }
    const targetIndex = side === "before" ? referenceIndex : referenceIndex + 1;
    this._input.setCursor(score, {
      partIndex: this._input.cursor?.partIndex ?? 0,
      measureIndex: Math.min(targetIndex, Math.max(0, (score.parts[0]?.measures.length ?? 1) - 1)),
      offset: new Fraction(0),
      division: this.activeTimingDivision(),
      lane: "rest",
    });
    this.commitInputMutation(
      `已在第 ${referenceIndex + 1} 小节${side === "before" ? "前" : "后"}插入小节`,
    );
  }

  private deleteInputMeasureSelection(indices: number[]): void {
    const score = this.painter.score;
    const unique = [...new Set(indices)]
      .filter((index) => Number.isInteger(index) && index >= 0)
      .sort((left, right) => left - right);
    if (unique.length === 0) return;
    const deleted = deleteScoreInputMeasures(score, unique);
    if (deleted === 0) {
      this.setStatus("乐谱至少需要保留一个小节");
      return;
    }
    const targetIndex = Math.min(unique[0] ?? 0, Math.max(0, (score.parts[0]?.measures.length ?? 1) - 1));
    this._input.setCursor(score, {
      partIndex: this._input.cursor?.partIndex ?? 0,
      measureIndex: targetIndex,
      offset: new Fraction(0),
      division: this.activeTimingDivision(),
      lane: "rest",
    });
    this.deselect(false);
    this.commitInputMutation(`已删除第 ${unique.map((index) => index + 1).join("、")} 小节`);
  }

  private inputSelectedMeasureIndices(cursor: NonNullable<ScoreInputSession["cursor"]>): number[] {
    const selected = this._selectedNotes
      .map(({ source }) => source.note.chord.measure.index)
      .filter((index) => Number.isFinite(index));
    return [...new Set(selected.length > 0 ? selected : [cursor.measureIndex])];
  }

  private moveInputCursor(direction: -1 | 1): void {
    const cursor = this._input.cursor;
    const tripletDelta = cursor
      ? inputTripletCursorDelta(this.painter.score, cursor, direction)
      : null;
    this._input.moveByDuration(
      this.painter.score,
      tripletDelta ?? this.inputGridStep().timesInt(direction),
    );
    this.selectInputFocus(false);
    this.renderInputCursor();
  }

  /** Apply one written value inside a 3:2 container.  The member itself keeps
   * Tuplet timing; any remainder beyond the closing bracket becomes an
   * ordinary tied continuation. */
  private resizeTupletAttackToWrittenDuration(note: ScoreNote, written: Fraction): boolean {
    const tuplet = note.tuplet;
    const duration = note.chord.duration;
    if (!tuplet || !duration || written.compareTo(new Fraction(0)) <= 0) return false;
    const target = tupletWrittenToActual(written, tuplet);
    const comparison = target.compareTo(duration);
    if (comparison === 0) return true;
    if (comparison < 0) {
      return resizeInputTuplet(
        this.painter.score,
        note,
        target.minus(duration),
      ).changed;
    }

    let remaining = target.minus(duration);
    let changed = false;
    while (remaining.compareTo(new Fraction(0)) > 0) {
      const resized = resizeInputTuplet(this.painter.score, note, remaining);
      if (resized.changed) {
        const consumed = resized.consumed ?? remaining;
        if (consumed.compareTo(new Fraction(0)) <= 0) break;
        remaining = remaining.minus(consumed);
        changed = true;
        continue;
      }
      // A Tuplet is a closed notation domain.  Reaching its final member is
      // the hard limit; Ctrl+Right must never manufacture an ordinary tied
      // continuation outside the bracket.
      break;
    }
    return changed;
  }

  private resizeInputFocus(direction: -1 | 1): void {
    const focus = this.inputFocus();
    const cursor = this._input.cursor;
    if (!focus || !cursor) return;
    const chain = this.inputTieRootAndDuration(focus.note);
    let tail = chain.root;
    const visited = new Set<ScoreNote>();
    while (tail.tieNext && !visited.has(tail)) {
      visited.add(tail);
      tail = tail.tieNext;
    }
    if (tail.tuplet && tail.chord.duration) {
      const currentWritten = tupletActualToWritten(tail.chord.duration, tail.tuplet);
      const memberStep = tail.tuplet.writtenUnit ?? currentWritten;
      const targetWritten = currentWritten.plus(memberStep.timesInt(direction));
      if (targetWritten.compareTo(new Fraction(0)) <= 0
        || !this.resizeTupletAttackToWrittenDuration(tail, targetWritten)) {
        this.setStatus(direction > 0
          ? "三连音后方没有足够休止时值，不能继续延长"
          : "当前三连音已经达到所选时值的最短长度");
        return;
      }
      this.commitInputMutation(direction > 0
        ? "已按三连音时值延长当前音"
        : "已按三连音时值缩短当前音并补入休止");
      return;
    }
    const result = resizeScoreNoteSegmentsWithRests(
      this.painter.score,
      [{ partIndex: cursor.partIndex, note: chain.root, grace: false }],
      this.inputDurationStep().timesInt(direction),
    );
    if (result.changed === 0) {
      this.setStatus(direction > 0
        ? "后方没有足够休止时值，不能继续延长"
        : "当前音已经达到所选刻度的最短时值");
      return;
    }
    this.commitInputMutation(direction > 0 ? "已延长当前音" : "已缩短当前音并补入休止");
  }

  private moveInputFocusTiming(direction: -1 | 1): void {
    const focus = this.inputFocus();
    const cursor = this._input.cursor;
    if (!focus || !cursor) return;
    const chain = this.inputTieRootAndDuration(focus.note);
    const root = chain.root;
    const writtenStep = focus.note.tuplet?.writtenUnit ?? this.inputDurationStep();
    if (direction > 0) {
      const start = root.chord.measure.position.plus(root.chord.position);
      this.ensureInputTimelineThrough(
        cursor.partIndex,
        start.plus(chain.duration).plus(writtenStep),
      );
    }
    const domainMove = moveInputTieChainByNotationDomain(
      this.painter.score,
      cursor.partIndex,
      focus.note,
      writtenStep,
      direction,
    );
    if (domainMove.handled) {
      if (!domainMove.changed || !domainMove.note) {
        this.setStatus("当前音不能跨越这个三连音边界继续移动");
        return;
      }
      cursor.measureIndex = domainMove.note.chord.measure.index;
      cursor.offset = domainMove.note.chord.position;
      this._input.focusPitch = domainMove.note.pitch;
      const committed = this.commitInputMutation(
        direction > 0
          ? "已按目标位置的三连音/普通时值右移完整延音"
          : "已按目标位置的三连音/普通时值左移完整延音",
      );
      if (committed) {
        this.selectInputFocus(false);
        if (this.scoreHasDuplicateChordPitches()) {
          this._mergeDuplicatePitchesOnSelectionRelease = true;
        }
      }
      return;
    }
    const delta = writtenStep.timesInt(direction);
    const result = moveScoreNotesOnTimeline(
      this.painter.score,
      [{ partIndex: cursor.partIndex, note: root, grace: false }],
      delta,
      {
        preserveRests: this.shouldPreserveTimelineRests(),
        moveWholeTieChain: true,
      },
    );
    if (result.changed === 0) {
      this.setStatus("当前音不能按所选刻度继续移动");
      return;
    }
    cursor.measureIndex = root.chord.measure.index;
    cursor.offset = root.chord.position;
    this._input.focusPitch = root.pitch;
    const committed = this.commitInputMutation(
      direction > 0 ? "已把当前音及其完整延音右移" : "已把当前音及其完整延音左移",
    );
    if (committed) {
      this.selectInputFocus(false);
      if (this.scoreHasDuplicateChordPitches()) {
        this._mergeDuplicatePitchesOnSelectionRelease = true;
      }
    }
  }

  /** Keep timeline gaps explicit whenever the current notation format asks to
   * retain written rests.  JPW always has explicit rests; compact TXT scores
   * may intentionally let the preceding attack sustain across a gap. */
  private shouldPreserveTimelineRests(): boolean {
    return this.documentFormat === "jpw"
      || (this.slashOptions?.showExplicitRests ?? true);
  }

  private moveInputFocusToPart(direction: -1 | 1): void {
    const focus = this.inputFocus();
    const cursor = this._input.cursor;
    if (!focus || !cursor) return;
    const targetPart = cursor.partIndex + direction;
    if (targetPart < 0 || targetPart >= this.painter.score.parts.length) {
      this.setStatus(direction < 0 ? "已经是最上方声部" : "已经是最下方声部");
      return;
    }
    const result = moveInputNoteToPart(
      this.painter.score,
      cursor.partIndex,
      focus.chord,
      focus.note,
      targetPart,
    );
    if (!result.changed || !result.targetChord || !result.note) {
      this.setStatus("目标声部在这个时间位置不可用");
      return;
    }
    cursor.partIndex = targetPart;
    cursor.measureIndex = result.targetChord.measure.index;
    cursor.offset = result.targetChord.position;
    this._input.focusPitch = result.note.pitch;
    this.commitInputMutation(`已把当前音移动到${this.getPartLabel(targetPart)}`);
    this.auditionInputCursor(false);
  }

  private octaveInputFocus(direction: -1 | 1): void {
    const focus = this.inputFocus();
    const editsTieChain = Boolean(focus
      && (focus.note.tiePrev !== null || focus.note.tieNext !== null));
    if (focus && editsTieChain) {
      const chain = this.inputTieRootAndDuration(focus.note).notes;
      const spec = {
        pitch: focus.note.pitch + direction * 12,
        number: focus.note.number,
        jpOctave: focus.note.jpOctave + direction,
        jpAlter: focus.note.jpAlter,
      };
      for (const member of chain) this.applyInputPitchSpec(member, spec);
      this._input.focusPitch = spec.pitch;
    } else {
      const note = this._input.octaveFocus(this.painter.score, direction);
      if (!note) return;
    }
    this.commitInputMutation(
      direction > 0 ? "当前音升高一个八度" : "当前音降低一个八度",
      undefined,
      !editsTieChain,
    );
    this.selectInputFocus(false);
    this.auditionInputCursor(false);
  }

  /** Move within a chord one rendered pitch row at a time.  One empty slot is
   * intentionally available above and below the chord; only the next move
   * crosses to the adjacent score part. */
  private moveInputVertical(direction: -1 | 1): void {
    const cursor = this._input.cursor;
    if (!cursor) return;
    const partDirection = direction < 0 ? -1 : 1;
    const canMoveToAdjacentPart = (): boolean => {
      const targetPart = cursor.partIndex + partDirection;
      if (targetPart >= 0 && targetPart < this.painter.score.parts.length) return true;
      this.setStatus(direction < 0 ? "已经是最上方声部" : "已经是最下方声部");
      return false;
    };
    const chord = this.inputChordAtCursorIncludingContinuation();
    const notes = chord?.notes.filter((note) => !note.rest)
      .sort((left, right) => left.pitch - right.pitch) ?? [];
    if (notes.length === 0) {
      if (!canMoveToAdjacentPart()) return;
      this._input.movePart(this.painter.score, partDirection);
      this.selectInputFocus(false);
      this.renderInputCursor();
      this.auditionInputCursor(false);
      return;
    }
    // Editing fills the placeholder and may reorder the chord. Resolve the
    // current row from the same lane/focus that paints the cursor, rather than
    // reusing the former placeholder index and skipping to another part.
    const focusedNote = inputNoteClosestToPitch(chord, this._input.focusPitch);
    const currentIndex = cursor.lane === "above" ? notes.length
      : cursor.lane === "below" ? -1
        : Math.max(0, notes.findIndex((note) => note === focusedNote));
    const nextIndex = currentIndex + (direction < 0 ? 1 : -1);
    if (nextIndex > notes.length || nextIndex < -1) {
      if (!canMoveToAdjacentPart()) return;
      this._input.movePart(this.painter.score, partDirection);
      if (this._input.cursor) this._input.cursor.verticalIndex = 0;
      this.selectInputFocus(false);
      this.renderInputCursor();
      this.auditionInputCursor(false);
      return;
    }
    cursor.verticalIndex = nextIndex;
    if (nextIndex >= notes.length) {
      cursor.lane = "above";
    } else if (nextIndex < 0) {
      cursor.lane = "below";
    } else {
      cursor.lane = "rest";
      this._input.focusPitch = notes[nextIndex].pitch;
    }
    this.selectInputFocus(false);
    this.renderInputCursor();
    this.auditionInputCursor(false);
  }

  private auditionInputCursor(_includeAlignedParts: boolean): void {
    const cursor = this._input.cursor;
    if (!cursor) return;

    // `selectInputFocus()` keeps the exact clicked tone in `_selectedNotes`.
    // Use that semantic selection verbatim: Ctrl-selecting 5 and 6 must sound
    // only 5+6, and adding a 4 in another row must sound 4+5+6.  Do not infer
    // the rest of a vertical chord or every aligned score part here.
    let selections = [...new Map(this._selectedNotes.map((selection) => [
      `${selection.source.partIndex}:${selection.source.from}:${selection.source.to}:${selection.visualNote.pitch}`,
      selection,
    ])).values()];
    if (selections.length === 0) {
      const focus = this.inputFocus();
      const source = focus
        ? this._sourceNotes.find((candidate) => candidate.note === focus.note)
          ?? this._sourceNotes.find((candidate) => candidate.chord === focus.chord
            && candidate.note.pitch === focus.note.pitch)
        : null;
      const element = source && focus
        ? this.painter.noteGroupEl(focus.chord, focus.note) ?? undefined
        : undefined;
      if (source && focus && element) {
        selections = [{ source, visualNote: focus.note, verse: 0, element }];
      }
    }
    if (selections.length === 0) return;

    const timeline = buildTimeline(this.painter.score);
    const notes: InputAuditionNote[] = selections.map((selection) => {
      const source = selection.source;
      const matches = timeline.notes.filter((note) =>
        note.part === source.partIndex
        && note.pitch === selection.visualNote.pitch
        && note.chord === source.note.chord);
      const timed = matches.sort((left, right) => {
        const leftDuration = left.t1 - left.t0;
        const rightDuration = right.t1 - right.t0;
        return source.grace
          ? leftDuration - rightDuration
          : rightDuration - leftDuration;
      })[0];
      let durationSeconds: number;
      if (timed) {
        durationSeconds = quarterToSeconds(timeline.tempo, timed.t1)
          - quarterToSeconds(timeline.tempo, timed.t0);
      } else {
        let duration = selection.visualNote.chord.duration?.toFloat() ?? 0.5;
        let next = selection.visualNote.tieNext;
        const visited = new Set<ScoreNote>();
        while (next && !visited.has(next)) {
          visited.add(next);
          duration += next.chord.duration?.toFloat() ?? 0;
          next = next.tieNext;
        }
        durationSeconds = duration * 60 / Math.max(1, this.painter.score.tempoBpm);
      }
      return {
        pitch: selection.visualNote.pitch,
        part: source.partIndex,
        durationSeconds: Math.max(0.05, durationSeconds),
      };
    });
    void this.player().audition(notes, this.sf2PlaybackOptions());
  }

  private stopInputAudition(): void {
    this._player?.stopAudition();
  }

  private inputTieRootAndDuration(note: ScoreNote): {
    root: ScoreNote;
    duration: Fraction;
    notes: ScoreNote[];
  } {
    let root = note;
    const backwards = new Set<ScoreNote>();
    while (root.tiePrev && !backwards.has(root)) {
      backwards.add(root);
      root = root.tiePrev;
    }
    let duration = new Fraction(0);
    let cursor: ScoreNote | null = root;
    const forwards = new Set<ScoreNote>();
    const notes: ScoreNote[] = [];
    while (cursor && !forwards.has(cursor)) {
      forwards.add(cursor);
      notes.push(cursor);
      duration = duration.plus(cursor.chord.duration ?? new Fraction(0));
      cursor = cursor.tieNext;
    }
    return { root, duration, notes };
  }

  /** Apply one numbered pitch without touching its rhythmic/tie identity.
   * Every member of a semantic tie chain calls this helper, so editing either
   * the black attack or a gray continuation keeps all printed segments equal
   * and leaves the existing tie pointers intact. */
  private applyInputPitchSpec(
    note: ScoreNote,
    spec: ReturnType<typeof inputDegreeSpec>,
  ): void {
    const oldPitch = note.pitch;
    note.pitch = spec.pitch;
    note.number = spec.number ?? note.number;
    note.jpOctave = spec.jpOctave ?? note.jpOctave;
    note.jpAlter = spec.jpAlter ?? note.jpAlter;
    note.octave = Math.floor(note.pitch / 12) - 1;
    if (note.displayOctave !== null) note.displayOctave = note.jpOctave;
    if (note.displayAlter !== null) note.displayAlter = note.jpAlter;
    const arpeggio = note.chord.arpeggioPitches;
    if (arpeggio?.includes(oldPitch)) {
      note.chord.arpeggioPitches = [...new Set(arpeggio.map((pitch) =>
        pitch === oldPitch ? note.pitch : pitch))].sort((left, right) => left - right);
    }
    note.chord.timingOriginal = null;
    note.chord.timingSourceIndex = null;
  }

  private inputMordentAvailability(note: ScoreNote): { allowed: boolean; hint: string } {
    if (note.tuplet !== null) {
      return { allowed: false, hint: "三连音成员不能再添加上波音或下波音" };
    }
    if (this.documentFormat === "jpw") return { allowed: true, hint: "只能用于单音" };
    const hasTriplet = (this.slashOptions?.bracketMode ?? "triplet") === "triplet";
    if (!hasTriplet) {
      return { allowed: false, hint: "文本谱需先把方括号设为三连音" };
    }
    const limits = this.slashTimingGridLimits();
    // Ornament helper pitches are semantic metadata inside `[ABA]`; they may
    // use the next finer playback subdivision without exposing that value as
    // an ordinary editable TXT grid.
    const memberDivision = Math.min(128, limits.base * 2);
    const member = new Fraction(4, memberDivision);
    const duration = this.inputTieRootAndDuration(note).duration;
    const allowed = duration.compareTo(member.timesInt(2)) >= 0;
    const minimumSourceDivision = Math.max(4, memberDivision / 2);
    return {
      allowed,
      hint: allowed
        ? `使用${memberDivision}分音符三连音装饰；只能用于单音`
        : `当前装饰三连音成员为 ${memberDivision} 分音符；单音至少需要一个 ${minimumSourceDivision} 分音符的时值`,
    };
  }

  private handleInputKeyDown(event: KeyboardEvent): boolean {
    if (!this._input.enabled) return false;
    const ctrl = event.ctrlKey || event.metaKey;
    const stop = (): true => {
      event.preventDefault();
      event.stopPropagation();
      return true;
    };
    if (event.key === "Escape") {
      this.setInputMode(false);
      return stop();
    }
    if (!this._input.cursor && /^(?:[0-7]|ArrowLeft|ArrowRight|ArrowUp|ArrowDown| |Delete|Backspace)$/.test(event.key)) {
      this.setStatus("请先点击谱面选择输入起点");
      return stop();
    }
    if (/^[1-7]$/.test(event.key) && !ctrl && !event.altKey) {
      this.typeInputDegree(parseInt(event.key, 10) as 1 | 2 | 3 | 4 | 5 | 6 | 7);
      return stop();
    }
    if (event.key === "0" && !ctrl && !event.altKey) {
      this.typeInputRest();
      return stop();
    }
    if (event.key === " " && !ctrl && !event.altKey) {
      const cursor = this._input.cursor;
      let step = this.inputDurationAtCursor();
      if (cursor) {
        const tuplet = inputTupletAtCursor(this.painter.score, cursor);
        if (tuplet) {
          step = tupletWrittenToActual(tuplet.writtenUnit ?? step, tuplet);
          const end = tuplet.actualEnd;
          if (end) {
            const remaining = end.minus(cursor.offset);
            if (remaining.compareTo(new Fraction(0)) > 0 && step.compareTo(remaining) > 0) {
              step = remaining;
            }
          }
        }
      }
      this._input.moveByDuration(this.painter.score, step);
      this.selectInputFocus(false);
      this.renderInputCursor();
      return stop();
    }
    if ((event.key === "Delete" || event.key === "Backspace") && !ctrl && !event.altKey) {
      if (this._selectedObjects.length > 0) this.deleteSelectedScoreItems();
      else this.deleteInputFocus();
      return stop();
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const direction = event.key === "ArrowRight" ? 1 : -1;
      if (ctrl) this.resizeInputFocus(direction);
      else if (event.altKey) this.moveInputFocusTiming(direction);
      else this.moveInputCursor(direction);
      return stop();
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (ctrl) this.octaveInputFocus(direction === -1 ? 1 : -1);
      else if (event.altKey) this.moveInputFocusToPart(direction);
      else this.moveInputVertical(direction);
      return stop();
    }
    return false;
  }

  private closeInputContextMenu(): void {
    this._inputContextMenu?.remove();
    this._inputContextMenu = null;
  }

  private openInputPositionContextMenu(
    cursor: NonNullable<ScoreInputSession["cursor"]>,
    event: MouseEvent,
  ): void {
    this.closeInputContextMenu();
    const menu = document.createElement("div");
    menu.className = "score-input-context-menu score-input-position-menu";
    menu.setAttribute("role", "menu");
    const title = document.createElement("div");
    title.className = "score-input-context-title";
    title.textContent = `空音位 · 第 ${cursor.measureIndex + 1} 小节 · ${this.getPartLabel(cursor.partIndex)}`;
    menu.append(title);
    const add = (label: string, action: () => void): void => {
      const button = document.createElement("button");
      button.type = "button";
      button.role = "menuitem";
      button.textContent = label;
      button.addEventListener("click", () => {
        this.closeInputContextMenu();
        action();
        this.scorePane.focus({ preventScroll: true });
      });
      menu.append(button);
    };
    const supportsTriplet = this.documentFormat === "jpw"
      || this.slashOptions?.braceMode === "triplet"
      || (this.slashOptions?.bracketMode ?? "triplet") === "triplet"
      || this.slashOptions?.barMode === "triplet"
      || this.slashOptions?.angleMode === "triplet"
      || this.slashOptions?.parenMode === "triplet";
    if (supportsTriplet) add("在光标处创建三连音", () => this.addInputTriplet(cursor));
    add("设置当前位置速度…", () => this.setInputTempo(cursor));
    add("渐快到…", () => this.setInputTempoRamp(cursor, "accel"));
    add("渐慢到…", () => this.setInputTempoRamp(cursor, "rit"));
    add("从这里换调…", () => { void this.setInputKey(cursor); });
    add("从本小节更换拍号…", () => { void this.setInputTimeSignature(cursor); });
    add("添加文本…", () => this.setInputText(cursor));
    this.addInputMeasureMenuItems(add, cursor);
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - 230)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - 250)}px`;
    document.body.append(menu);
    this._inputContextMenu = menu;
    menu.querySelector<HTMLButtonElement>("button")?.focus();
  }

  private onInputContextMenu(
    _pageIndex: number,
    _svg: SVGSVGElement,
    event: MouseEvent,
  ): void {
    if (!this._input.enabled) return;
    event.preventDefault();
    event.stopPropagation();
    const focus = this.inputFocus();
    const cursor = this._input.cursor;
    if (!cursor) return;
    if (!focus || focus.chord.rest) {
      this.openInputPositionContextMenu(cursor, event);
      return;
    }
    this.closeInputContextMenu();
    const menu = document.createElement("div");
    menu.className = "score-input-context-menu";
    menu.setAttribute("role", "menu");
    const title = document.createElement("div");
    title.className = "score-input-context-title";
    title.textContent = `第 ${cursor.measureIndex + 1} 小节 · ${this.getPartLabel(cursor.partIndex)}`;
    menu.append(title);
    const add = (
      label: string,
      action: () => void,
      enabled = true,
      hint = "",
    ): void => {
      const button = document.createElement("button");
      button.type = "button";
      button.role = "menuitem";
      button.textContent = label;
      button.disabled = !enabled;
      if (hint) button.title = hint;
      button.addEventListener("click", () => {
        this.closeInputContextMenu();
        action();
        this.scorePane.focus({ preventScroll: true });
      });
      menu.append(button);
    };
    const ornamentFocus = this.inputTieRootAndDuration(focus.note).root;
    const ornamentChord = ornamentFocus.chord;
    const oneTone = ornamentChord.notes.filter((note) => !note.rest).length === 1;
    const mordentAvailability = this.inputMordentAvailability(ornamentFocus);
    const textGroupSupports = (mode: "arpeggio" | "grace" | "triplet" | "subdivide" | "trill"): boolean =>
      this.documentFormat === "jpw"
      || this.slashOptions?.braceMode === mode
      || (this.slashOptions?.bracketMode ?? "triplet") === mode
      || this.slashOptions?.barMode === mode
      || this.slashOptions?.angleMode === mode
      || this.slashOptions?.parenMode === mode;
    add("琶音", () => {
      focus.chord.arpeggio = !focus.chord.arpeggio;
      focus.chord.arpeggioPitches = focus.chord.arpeggio
        ? focus.chord.notes.filter((note) => !note.rest).map((note) => note.pitch)
        : null;
      this.commitInputMutation(focus.chord.arpeggio ? "已添加琶音" : "已移除琶音");
    }, focus.chord.notes.filter((note) => !note.rest).length >= 2 && textGroupSupports("arpeggio"),
    "文本谱需先在乐谱设置中给任一种括号分配琶音功能");
    const alignedParts = this.inputAlignedInstrumentChords(cursor);
    add("跨谱行琶音", () => {
      const score = this.painter.score;
      const existing = score.crossPartArpeggios.find((mark) =>
        mark.measure === cursor.measureIndex && mark.offset.equals(cursor.offset));
      if (existing) {
        score.crossPartArpeggios = score.crossPartArpeggios.filter((mark) => mark !== existing);
        this.commitInputMutation("已移除跨谱行琶音");
        return;
      }
      const mark = new CrossPartArpeggio();
      mark.measure = cursor.measureIndex;
      mark.offset = cursor.offset;
      mark.parts = alignedParts.map(({ partIndex }) => partIndex);
      mark.pitches = alignedParts.flatMap(({ partIndex, chord }) =>
        chord.notes.filter((note) => !note.rest).map((note) => ({ part: partIndex, pitch: note.pitch })));
      score.crossPartArpeggios.push(mark);
      this.commitInputMutation("已添加同乐器跨谱行琶音");
    }, alignedParts.length >= 2 && textGroupSupports("arpeggio"),
    "同一时刻至少需要同一乐器的两个声部有音，并配置琶音括号");
    add("上波音", () => this.setInputOrnament(ornamentChord, "upper-mordent"),
      oneTone && mordentAvailability.allowed, mordentAvailability.hint);
    add("下波音", () => this.setInputOrnament(ornamentChord, "lower-mordent"),
      oneTone && mordentAvailability.allowed, mordentAvailability.hint);
    const trillConfigured = this.documentFormat === "jpw" || textGroupSupports("trill");
    const trillDivision = this.documentFormat === "jpw"
      ? 32
      : (this.slashTimingGridLimits().implicitCompact
        ? Math.min(128, this.slashTimingGridLimits().base * 2)
        : this.slashTimingGridLimits().base);
    const trillStep = new Fraction(4, trillDivision);
    const trillDuration = this.inputTieRootAndDuration(ornamentFocus).duration;
    const trillAllowed = ornamentFocus.tuplet === null
      && trillConfigured
      && (this.documentFormat === "jpw" || trillDuration.compareTo(trillStep.timesInt(2)) >= 0);
    add("Tr 颤音", () => {
      focus.chord.ornaments = [
        ...focus.chord.ornaments.filter((ornament) => ornament.kind !== "trill"),
        // 128 is an internal semantic value for 64th-note + subdivision;
        // it is not exposed as a normal toolbar division.
        { kind: "trill", subdivision: trillDivision as 8 | 16 | 32 | 64 | 128 },
      ];
      this.commitInputMutation(`已添加 ${trillDivision} 分音符 Tr 颤音`);
    }, oneTone && trillAllowed,
    this.documentFormat === "jpw"
      ? "只能用于非三连音单音"
      : `需给一种括号分配颤音；只能用于非三连音单音，且当前音符至少容纳两个 ${trillDivision} 分音符成员`);
    add("在光标处创建三连音", () => this.addInputTriplet(cursor),
      textGroupSupports("triplet"), "文本谱需先配置三连音括号");
    const implicitTextGrace = this.documentFormat !== "jpw"
      && this.slashOptions?.noteDivision == null;
    add("倚音…", () => this.addInputGraceNotes(cursor, focus.chord),
      implicitTextGrace || textGroupSupports("grace"),
      implicitTextGrace
        ? "倚音会直接贴写在主音之前且不占时值"
        : "启用音符自身时值后，文本谱需先配置倚音括号");
    const selectedSlur = this.selectedInputSlurRange();
    add("连接选中的两个音", () => this.slurSelectedInputNotes(), selectedSlur !== null,
      "请用 Ctrl/Cmd 或 Shift 选择同一谱行中的至少两个不同时刻音符");
    if (this.documentFormat === "jpw") {
      add("延长号", () => {
        focus.chord.fermata = !focus.chord.fermata;
        this.commitInputMutation(focus.chord.fermata ? "已添加延长号" : "已移除延长号");
      });
    }
    add("设置当前位置速度…", () => this.setInputTempo(cursor));
    add("渐快到…", () => this.setInputTempoRamp(cursor, "accel"));
    add("渐慢到…", () => this.setInputTempoRamp(cursor, "rit"));
    add("从这里换调…", () => { void this.setInputKey(cursor); });
    add("从本小节更换拍号…", () => { void this.setInputTimeSignature(cursor); });
    add("添加文本…", () => this.setInputText(cursor));
    this.addInputMeasureMenuItems(add, cursor);
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - 230)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - 410)}px`;
    document.body.append(menu);
    this._inputContextMenu = menu;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }

  private addInputMeasureMenuItems(
    add: (label: string, action: () => void, enabled?: boolean, hint?: string) => void,
    cursor: NonNullable<ScoreInputSession["cursor"]>,
  ): void {
    const measureCount = this.painter.score.parts[0]?.measures.length ?? 0;
    add("在当前小节前插入小节", () => this.insertInputMeasureAt(cursor.measureIndex, "before"));
    add("在当前小节后插入小节", () => this.insertInputMeasureAt(cursor.measureIndex, "after"));
    add("删除当前/选中音符所在小节", () => {
      this.deleteInputMeasureSelection(this.inputSelectedMeasureIndices(cursor));
    }, measureCount > 1, "有多个选中音符时，会一次删除它们所在的全部小节");
  }

  private setInputOrnament(
    chord: Chord,
    kind: "upper-mordent" | "lower-mordent",
  ): void {
    if (chord.notes.some((note) => note.tuplet !== null)) {
      this.setStatus("三连音成员不能添加上波音或下波音");
      return;
    }
    const exists = chord.ornaments.some((ornament) => ornament.kind === kind);
    if (exists) this.collapseTextMordentRealization(chord);
    chord.ornaments = chord.ornaments.filter((ornament) => ornament.kind !== kind);
    if (!exists) chord.ornaments.push({ kind });
    this.commitInputMutation(exists ? "已移除波音" : kind === "upper-mordent" ? "已添加上波音" : "已添加下波音");
  }

  private inputAlignedInstrumentChords(cursor: NonNullable<ScoreInputSession["cursor"]>): Array<{
    partIndex: number;
    chord: Chord;
  }> {
    const score = this.painter.score;
    const source = score.parts[cursor.partIndex];
    const instrument = source?.instrumentName.trim() || score.instrumentName.trim();
    return score.parts.flatMap((part, partIndex) => {
      const name = part.instrumentName.trim() || score.instrumentName.trim();
      if (instrument && name !== instrument) return [];
      const chord = inputChordAt(score, { ...cursor, partIndex });
      return chord && !chord.rest ? [{ partIndex, chord }] : [];
    });
  }

  private addInputTriplet(cursor: NonNullable<ScoreInputSession["cursor"]>): void {
    const selectedDuration = this.inputDurationStep();
    const result = createInputTriplet(
      this.painter.score,
      cursor,
      selectedDuration,
    );
    if (!result.changed) {
      this.setStatus(result.reason === "cross-measure"
        ? "三连音不能跨小节；请缩短当前时值或把光标前移"
        : result.reason === "overlapping-tuplet"
          ? "光标时域已经包含三连音，请先删除原三连音"
          : result.reason === "finer-rhythm"
            ? "所选三连音时值覆盖了更细的起音；请把时值切换到这些音的最短时值后再创建"
          : "当前时值不能创建三连音");
      return;
    }
    // Tuplet membership and single-note ornaments are mutually exclusive.
    // Remove an existing mordent/trill from every chord absorbed into the new
    // 3:2 container so metadata cannot render both symbols at once.
    for (const chord of result.chords) chord.ornaments = [];
    const tuplet = result.chords[0]?.notes.find((note) => note.tuplet)?.tuplet ?? null;
    const memberDivision = Math.max(1, Math.round(
      4 / Math.max(1e-8, tuplet?.writtenUnit?.toFloat() ?? selectedDuration.divInt(2).toFloat()),
    ));
    const sourceDivision = Math.max(1, Math.round(
      4 / Math.max(1e-8, tuplet?.binaryRestoreUnit?.toFloat() ?? selectedDuration.toFloat()),
    ));
    this.commitInputMutation(
      `已创建 ${memberDivision === 1 ? "全音符" : `${memberDivision} 分音符`}三连音`
        + `（只占用当前${sourceDivision === 1 ? "全音符" : `${sourceDivision} 分音符`}的完整时值）`,
    );
  }

  private async addInputGraceNotes(
    cursor: NonNullable<ScoreInputSession["cursor"]>,
    chord: Chord,
  ): Promise<void> {
    const score = this.painter.score;
    const value = await showTextInput({ title: "添加倚音", label: "倚音数字（1–7，可连续输入，例如 23）", value: "2",
      validate: (text) => /^[1-7]+$/.test(text.trim()) ? null : "请输入 1–7 的音级，例如 23" });
    if (this.painter.score !== score) return;
    if (!value) return;
    const degrees = [...value].filter((char) => /^[1-7]$/.test(char));
    if (degrees.length === 0) {
      this.setStatus("没有输入有效的 1–7 倚音");
      return;
    }
    chord.graceNotes = degrees.map((char) => {
      const degree = parseInt(char, 10) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
      const spec = inputDegreeSpec(this.painter.score, cursor, degree);
      const note = new ScoreNote(chord);
      note.pitch = spec.pitch;
      note.number = spec.number ?? char;
      note.jpOctave = spec.jpOctave ?? 0;
      note.jpAlter = spec.jpAlter ?? " ";
      return note;
    });
    this.commitInputMutation(`已添加 ${degrees.length} 个倚音`);
  }

  private selectedInputSlurRange(): { partIndex: number; start: Chord; end: Chord } | null {
    const selected = [...new Map(this._selectedNotes.map((item) => [
      item.visualNote.chord,
      { partIndex: item.source.partIndex, chord: item.visualNote.chord },
    ])).values()];
    if (selected.length < 2) return null;
    const partIndex = selected[0].partIndex;
    if (selected.some((item) => item.partIndex !== partIndex)) return null;
    selected.sort((left, right) =>
      left.chord.measure.position.plus(left.chord.position)
        .compareTo(right.chord.measure.position.plus(right.chord.position)));
    const start = selected[0].chord;
    const end = selected[selected.length - 1].chord;
    return start === end ? null : { partIndex, start, end };
  }

  private slurSelectedInputNotes(): void {
    const range = this.selectedInputSlurRange();
    if (!range) {
      this.setStatus("请先在同一谱行选择至少两个不同时刻的音符");
      return;
    }
    range.start.slurStart = true;
    range.start.slurEndChord = range.end;
    range.end.slurEnd = true;
    this.commitInputMutation("已连接选中音符；曲线会避开跨度内最高的和弦");
  }

  private async setInputTempo(cursor: NonNullable<ScoreInputSession["cursor"]>): Promise<void> {
    const score = this.painter.score;
    const value = await showTextInput({ title: "设置速度", label: "当前位置四分音符速度（BPM）",
      value: String(score.tempoBpm), inputMode: "decimal", validate: positiveNumberError });
    if (this.painter.score !== score) return;
    const bpm = value ? Number(value) : NaN;
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    const mark = new TempoMark();
    mark.measure = cursor.measureIndex;
    mark.offset = cursor.offset;
    mark.kind = "tempo";
    mark.bpm = Math.round(bpm * 10) / 10;
    this.painter.score.tempoMarks = this.painter.score.tempoMarks.filter((item) =>
      !(item.measure === mark.measure && item.offset.equals(mark.offset) && item.kind === "tempo"));
    this.painter.score.tempoMarks.push(mark);
    this.commitInputMutation(`已设置当前位置速度为 ♩=${mark.bpm}`);
  }

  private async setInputTempoRamp(
    cursor: NonNullable<ScoreInputSession["cursor"]>,
    kind: "accel" | "rit",
  ): Promise<void> {
    const score = this.painter.score;
    const selectedPositions = this._selectedNotes.map(({ source }) => ({
      measure: source.note.chord.measure.index,
      offset: source.note.chord.position,
    })).sort((left, right) => left.measure - right.measure || left.offset.compareTo(right.offset));
    const rangeStart = selectedPositions.length >= 2 ? selectedPositions[0] : {
      measure: cursor.measureIndex,
      offset: cursor.offset,
    };
    let rangeEnd = selectedPositions.length >= 2
      ? selectedPositions[selectedPositions.length - 1]
      : null;
    const result = await showInputDialog({ title: kind === "accel" ? "添加渐快" : "添加渐慢",
      message: rangeEnd ? "范围使用当前选中的首尾音符。" : "从当前位置开始，在指定小节达到目标速度。",
      fields: [{ name: "bpm", label: "目标速度（BPM）", inputMode: "decimal", validate: positiveNumberError },
        ...(!rangeEnd ? [{ name: "end", label: "终点小节号（从 1 开始）", value: String(cursor.measureIndex + 2),
          inputMode: "numeric" as const, validate: (value: string) => /^\d+$/.test(value.trim()) && Number(value) > 0
            ? null : "请输入从 1 开始的小节号" }] : [])] });
    if (!result || this.painter.score !== score) return;
    const targetBpm = Number(result.bpm);
    if (!rangeEnd) {
      const endText = result.end;
      const endMeasure = Math.max(cursor.measureIndex,
        (parseInt(endText ?? "", 10) || cursor.measureIndex + 2) - 1);
      rangeEnd = { measure: endMeasure, offset: new Fraction(0) };
    }
    const start = new TempoMark();
    start.measure = rangeStart.measure;
    start.offset = rangeStart.offset;
    start.kind = kind;
    const end = new TempoMark();
    end.measure = Math.min(
      Math.max(0, ...this.painter.score.parts.map((part) => part.measures.length - 1)),
      rangeEnd.measure,
    );
    end.offset = rangeEnd.offset;
    end.kind = "tempo";
    end.bpm = Math.round(targetBpm * 10) / 10;
    this.painter.score.tempoMarks.push(start, end);
    this.commitInputMutation(`已添加 ${kind === "accel" ? "渐快" : "渐慢"}至 ♩=${end.bpm}`);
  }

  private async setInputKey(cursor: NonNullable<ScoreInputSession["cursor"]>): Promise<void> {
    const current = inputKeyAt(this.painter.score, cursor.partIndex, cursor.measureIndex, cursor.offset);
    const fifths = await showKeyCircleDialog(current.fifths);
    if (fifths === null) return;
    applyKeyChangeKeepingDegrees(
      this.painter.score,
      cursor.partIndex,
      cursor.measureIndex,
      cursor.offset,
      fifths,
    );
    const rawName = MusicCommon.keys[fifths + 7] ?? "C";
    const displayName = rawName.startsWith("b")
      ? `${rawName.slice(1)}♭`
      : rawName.startsWith("#") ? `${rawName.slice(1)}♯` : rawName;
    this.commitInputMutation(`已从当前位置换为 1=${displayName}，数字级数保持不变`);
  }

  private async setInputTimeSignature(
    cursor: NonNullable<ScoreInputSession["cursor"]>,
  ): Promise<void> {
    const measure = this.painter.score.parts[cursor.partIndex]?.measures[cursor.measureIndex];
    if (!measure) return;
    const choice = await showTimeSignatureDialog(measure.time.beats, measure.time.beatType);
    if (!choice) return;
    const explicitRests = this.documentFormat === "jpw"
      || (this.slashOptions?.showExplicitRests ?? true);
    if (!applyInputTimeSignature(
      this.painter.score,
      cursor.measureIndex,
      choice.beats,
      choice.beatType,
      explicitRests,
    )) return;
    const newLength = new Fraction(choice.beats * 4, choice.beatType);
    if (cursor.offset.compareTo(newLength) >= 0) {
      cursor.offset = newLength.minus(noteTimingStep(cursor.division));
      if (cursor.offset.compareTo(new Fraction(0)) < 0) cursor.offset = new Fraction(0);
    }
    this.commitInputMutation(`第 ${cursor.measureIndex + 1} 小节起已更换为 ${choice.beats}/${choice.beatType} 拍`);
  }

  private async setInputText(cursor: NonNullable<ScoreInputSession["cursor"]>): Promise<void> {
    const score = this.painter.score;
    const value = await showTextInput({ title: "添加谱面文本", label: "谱面文本", multiline: true });
    if (this.painter.score !== score) return;
    if (!value?.trim()) return;
    const mark = new ScoreTextMark();
    mark.partIndex = cursor.partIndex;
    mark.measure = cursor.measureIndex;
    mark.offset = cursor.offset;
    mark.text = value.trim();
    this.painter.score.textMarks.push(mark);
    this.commitInputMutation("已添加谱面文本");
  }

  // ---------------- picking / selection ----------------
  private selectionAnchor(selection: SelectedScoreNote): SelectionAnchor {
    const source = selection.source;
    const tones = this._sourceNotes.filter((candidate) =>
      candidate.partIndex === source.partIndex
      && candidate.chordIndex === source.chordIndex
      && candidate.grace === source.grace);
    return {
      position: source.from,
      verse: selection.verse,
      partIndex: source.partIndex,
      chordIndex: source.chordIndex,
      grace: source.grace,
      toneIndex: Math.max(0, tones.indexOf(source)),
      pitch: source.note.pitch,
      absoluteTick: source.note.absoluteTick.toString(),
      visualTick: selection.visualNote.absoluteTick.toString(),
    };
  }

  private onPageClick(pageIndex: number, svg: SVGSVGElement, ev: MouseEvent): void {
    if (this._suppressPageClick) {
      this._suppressPageClick = false;
      ev.preventDefault();
      return;
    }
    const headerTarget = scoreHeaderTarget(ev.target);
    if (headerTarget) {
      ev.preventDefault();
      ev.stopPropagation();
      this.scorePane.focus({ preventScroll: true });
      void this.editScoreHeader(headerTarget);
      return;
    }
    if (this.inputHitFromPage(pageIndex, svg, ev)) return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const picked = this.pickScoreAtPointer(pageIndex, ctm, ev);
    const directObject = picked ? this.scoreObjectHit(picked) : null;
    const additive = ev.ctrlKey || ev.metaKey;
    // Grace-note glyphs remain pitch selections (including clicks on their
    // tiny beams); standalone semantic marks use the same precise picker.
    if (directObject && directObject.kind !== "grace") {
      const existing = this._selectedObjects.findIndex((selection) =>
        selection.mark === directObject.mark);
      if (additive) {
        if (existing >= 0) this.removeScoreObjectSelection(existing);
        else this.addScoreObjectSelection(directObject);
      } else {
        this.clearSelectedItems();
        this.addScoreObjectSelection(directObject);
      }
      this._pendingSelectionAnchors = null;
      this.syncCodeSelections(false);
      this.setStatus(this.selectionStatus());
      this.scorePane.focus({ preventScroll: true });
      return;
    }
    if (!picked) {
      if (additive) {
        this.scorePane.focus({ preventScroll: true });
        return;
      }
      this.deselect();
      this.setStatus("");
      return;
    }

    const hit = this.scoreNoteHit(picked);
    if (!hit) {
      const object = this.scoreObjectHit(picked);
      if (object) {
        const existing = this._selectedObjects.findIndex((selection) =>
          selection.mark === object.mark);
        if (additive) {
          if (existing >= 0) this.removeScoreObjectSelection(existing);
          else this.addScoreObjectSelection(object);
        } else {
          this.clearSelectedItems();
          this.addScoreObjectSelection(object);
        }
        this._pendingSelectionAnchors = null;
        this.syncCodeSelections(false);
        this.setStatus(this.selectionStatus());
        this.scorePane.focus({ preventScroll: true });
        return;
      }
      if (additive) {
        this.scorePane.focus({ preventScroll: true });
        return;
      }
      this.deselect();
      const target = picked.selectable ? picked : this.painter.entryGroupOf(picked);
      const el = this.painter.nodeMap.get(target);
      if (el) {
        el.classList.add("selected");
        this.selectedEls.add(el);
      }
      this.setStatus(describePick(picked));
      this.scorePane.focus({ preventScroll: true });
      return;
    }

    if (ev.shiftKey && this._rangeAnchorPosition !== null) {
      const anchorIndex = this._sourceNotes.findIndex((source) =>
        source.from === this._rangeAnchorPosition
        || (this._rangeAnchorPosition! >= source.from && this._rangeAnchorPosition! < source.to));
      const targetIndex = this._sourceNotes.indexOf(hit.source);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const anchorPosition = this._rangeAnchorPosition;
        this.clearSelectedItems();
        const from = Math.min(anchorIndex, targetIndex);
        const to = Math.max(anchorIndex, targetIndex);
        const range = this._sourceNotes.slice(from, to + 1);
        for (const source of range) {
          if (source !== hit.source) this.addScoreSelection(source, hit.verse);
        }
        this.addScoreSelection(hit.source, hit.verse, hit.element, hit.visualNote);
        this._rangeAnchorPosition = anchorPosition;
      }
    } else if (additive) {
      const existing = this._selectedNotes.findIndex((selection) =>
        selection.source.from === hit.source.from && selection.source.to === hit.source.to);
      if (existing >= 0) this.removeScoreSelection(existing);
      else this.addScoreSelection(hit.source, hit.verse, hit.element, hit.visualNote);
      this._rangeAnchorPosition = hit.source.from;
    } else {
      this.clearSelectedItems();
      this.addScoreSelection(hit.source, hit.verse, hit.element, hit.visualNote);
      this._rangeAnchorPosition = hit.source.from;
    }
    this._pendingSelectionAnchors = null;
    this.syncCodeSelections(true);
    this.setStatus(this.selectionStatus());
    this.scorePane.focus({ preventScroll: true });
  }

  private scoreNoteHit(picked: PageItem): SelectedScoreNote | null {
    if (picked instanceof LayoutLyric) return null;
    const entryItem = this.painter.entryGroupOf(picked);
    const entry = entryItem.data;
    if (!(entry instanceof NoteEntry)) return null;
    let graceVisual: PageItem | null = null;
    let graceNote: ScoreNote | null = null;
    let cursor: PageItem | null = picked;
    while (cursor && cursor !== entryItem) {
      if (cursor.data instanceof ScoreNote) {
        graceNote = cursor.data;
        graceVisual = entry.graceItems.get(graceNote) ?? cursor;
        break;
      }
      cursor = cursor.parent;
    }
    let number: JpNumber | null = null;
    if (picked instanceof JpNumber) number = picked;
    else if (picked instanceof JpOctaveDot) number = picked.owner;
    if (!graceNote && number) {
      const grace = [...entry.graceItems.entries()].find(([, item]) => {
        let parent: PageItem | null = number;
        while (parent && parent !== entryItem) {
          if (parent === item) return true;
          parent = parent.parent;
        }
        return false;
      });
      graceNote = grace?.[0] ?? null;
      graceVisual = grace?.[1] ?? null;
    }
    const noteIndex = number ? Math.max(0, entry.numbers.indexOf(number)) : 0;
    const note = graceNote ?? entry.chord.notes[noteIndex] ?? entry.chord.notes[0];
    if (!note) return null;
    let sourceNote = note;
    const visited = new Set<ScoreNote>();
    while (sourceNote.tiePrev && !visited.has(sourceNote)) {
      visited.add(sourceNote);
      sourceNote = sourceNote.tiePrev;
    }
    const source = this._sourceNotes.find((candidate) => candidate.note === sourceNote)
      ?? this._sourceNotes.find((candidate) => candidate.note === note);
    if (!source) return null;
    const visualItem = graceVisual ?? number ?? entryItem;
    const element = this.painter.nodeMap.get(visualItem)
      ?? this.painter.noteGroupEl(note.chord, note, entry.verse)
      ?? this.painter.noteGroupEl(source.chord, source.note, entry.verse);
    return element ? {
      source,
      visualNote: note,
      verse: entry.verse,
      element,
    } : null;
  }

  private scoreObjectHit(picked: PageItem): SelectedScoreObject | null {
    let item: PageItem | null = picked;
    while (item) {
      if (item.data instanceof Tuplet) {
        const element = this.painter.nodeMap.get(item);
        return element ? {
          kind: "tuplet",
          mark: item.data,
          element,
          measureIndex: item.data.first.chord.measure.index,
        } : null;
      }
      if (item.data instanceof TempoMark) {
        const element = this.painter.nodeMap.get(item);
        return element ? { kind: "tempo", mark: item.data, element } : null;
      }
      if (item.data instanceof KeySig) {
        const element = this.painter.nodeMap.get(item);
        const mark = item.data;
        let key = this.painter.score.keyMarks.find((candidate) =>
          candidate.measure === mark.sourceMeasureIndex && candidate.offset.equals(mark.syncTick));
        if (!key && mark.sourceMeasureIndex >= 0) {
          const fifths = this.painter.score.parts[0]?.measures[mark.sourceMeasureIndex]?.key.fifths ?? 0;
          key = new KeyMark(mark.sourceMeasureIndex, mark.syncTick, fifths);
          this.painter.score.keyMarks.push(key);
        }
        return element ? {
          kind: "key",
          mark: key ?? new KeyMark(mark.sourceMeasureIndex, mark.syncTick, 0),
          element,
          measureIndex: mark.sourceMeasureIndex,
        } : null;
      }
      if (item.data instanceof TimeSig) {
        const element = this.painter.nodeMap.get(item);
        return element ? {
          kind: "meter",
          mark: new Time(item.data.beats, item.data.beatType),
          element,
          measureIndex: item.data.sourceMeasureIndex,
        } : null;
      }
      if (item.data instanceof ScoreTextMark) {
        const element = this.painter.nodeMap.get(item);
        return element ? { kind: "text", mark: item.data, element } : null;
      }
      if (item.data instanceof CrossPartArpeggio) {
        const element = this.painter.nodeMap.get(item);
        return element ? {
          kind: "cross-arpeggio",
          mark: item.data,
          element,
          measureIndex: item.data.measure,
        } : null;
      }
      if (item.data instanceof ScoreNote && item.data.chord.graceNotes.includes(item.data)) {
        const element = this.painter.nodeMap.get(item);
        return element ? {
          kind: "grace",
          mark: item.data,
          element,
          measureIndex: item.data.chord.measure.index,
        } : null;
      }
      if (item.data instanceof Chord) {
        const chord = item.data;
        if (item.classes.has("jianpu-fermata") && chord.fermata) {
          const element = this.painter.nodeMap.get(item);
          return element ? {
            kind: "fermata",
            mark: chord,
            element,
            measureIndex: chord.measure.index,
          } : null;
        }
        const isArpeggio = item.classes.has("jianpu-arpeggio") && chord.arpeggio;
        if (isArpeggio) {
          const element = this.painter.nodeMap.get(item);
          return element ? {
            kind: "arpeggio",
            mark: chord,
            element,
            measureIndex: chord.measure.index,
          } : null;
        }
      }
      if (item.data && typeof item.data === "object"
        && (item.data as { kind?: string }).kind
        && ["upper-mordent", "lower-mordent", "trill"].includes((item.data as { kind: string }).kind)) {
        const entry = item.parent?.data instanceof NoteEntry ? item.parent.data : null;
        const element = this.painter.nodeMap.get(item);
        if (entry && element) {
          return {
            kind: "ornament",
            mark: entry.chord,
            element,
            measureIndex: entry.chord.measure.index,
          };
        }
      }
      item = item.parent;
    }
    return null;
  }

  private addScoreSelection(
    source: JpwSourceNote,
    verse: number,
    element?: SVGGElement,
    visualNote: ScoreNote = source.note,
  ): void {
    if (this._selectedNotes.some((selection) =>
      selection.source.from === source.from && selection.source.to === source.to)) return;
    const el = element ?? this.painter.noteGroupEl(source.chord, source.note, verse);
    if (!el) return;
    el.classList.add("selected");
    this.selectedEls.add(el);
    this._selectedNotes.push({ source, visualNote, verse, element: el });
  }

  private removeScoreSelection(index: number): void {
    const selection = this._selectedNotes[index];
    if (!selection) return;
    selection.element.classList.remove("selected");
    this.selectedEls.delete(selection.element);
    this._selectedNotes.splice(index, 1);
    if (this._selectedNotes.length === 0) this.queueDuplicatePitchMerge();
  }

  private addScoreObjectSelection(selection: SelectedScoreObject): void {
    if (this._selectedObjects.some((item) => item.mark === selection.mark && item.kind === selection.kind)) return;
    selection.element.classList.add("selected");
    this.selectedEls.add(selection.element);
    this._selectedObjects.push(selection);
  }

  private selectScoreObject(selection: SelectedScoreObject, additive: boolean): void {
    const existing = this._selectedObjects.findIndex((item) =>
      item.mark === selection.mark && item.kind === selection.kind);
    if (additive) {
      if (existing >= 0) this.removeScoreObjectSelection(existing);
      else this.addScoreObjectSelection(selection);
    } else {
      this.clearSelectedItems();
      this.addScoreObjectSelection(selection);
    }
    this._pendingSelectionAnchors = null;
    this.syncCodeSelections(false);
    this.setStatus(this.selectionStatus());
  }

  private removeScoreObjectSelection(index: number): void {
    const selection = this._selectedObjects[index];
    if (!selection) return;
    selection.element.classList.remove("selected");
    this.selectedEls.delete(selection.element);
    this._selectedObjects.splice(index, 1);
  }

  private commitObjectMutation(message: string): void {
    const next = this.serializeCurrentScoreDocument();
    if (next === null) {
      this.setStatus("当前对象无法写回当前谱面格式");
      return;
    }
    const ok = this.replaceDocumentText(next);
    this.setStatus(ok ? message : "对象修改后暂时无法重新解析");
  }

  private setGraceDegree(note: ScoreNote, degree: 1 | 2 | 3 | 4 | 5 | 6 | 7): void {
    const measureIndex = note.chord.measure.index;
    const partIndex = Math.max(0, this.painter.score.parts.findIndex((part) =>
      part.measures[measureIndex]?.entries.includes(note.chord)));
    const spec = inputDegreeSpec(
      this.painter.score,
      { partIndex, measureIndex, offset: note.chord.position },
      degree,
      note.jpOctave,
    );
    note.pitch = spec.pitch;
    note.number = spec.number ?? String(degree);
    note.jpOctave = spec.jpOctave ?? note.jpOctave;
    note.jpAlter = spec.jpAlter ?? " ";
  }

  private setObjectChordDuration(chord: Chord, duration: Fraction): void {
    const values = [
      { value: new Fraction(4), beats: 4, beams: 0, dot: 0 },
      { value: new Fraction(3), beats: 2, beams: 0, dot: 1 },
      { value: new Fraction(2), beats: 2, beams: 0, dot: 0 },
      { value: new Fraction(3, 2), beats: 1, beams: 0, dot: 1 },
      { value: new Fraction(1), beats: 1, beams: 0, dot: 0 },
      { value: new Fraction(3, 4), beats: 1, beams: 1, dot: 1 },
      { value: new Fraction(1, 2), beats: 1, beams: 1, dot: 0 },
      { value: new Fraction(3, 8), beats: 1, beams: 2, dot: 1 },
      { value: new Fraction(1, 4), beats: 1, beams: 2, dot: 0 },
      { value: new Fraction(1, 8), beats: 1, beams: 3, dot: 0 },
      { value: new Fraction(1, 16), beats: 1, beams: 4, dot: 0 },
    ];
    const exact = values.find((item) => item.value.equals(duration));
    chord.duration = duration;
    chord.beamGroup = null;
    chord.beats = exact?.beats ?? 1;
    chord.beams = exact?.beams ?? Math.max(0, Math.min(6,
      Math.round(Math.log2(1 / Math.max(1 / 64, duration.toFloat())))));
    chord.dot = exact?.dot ?? 0;
  }

  /** Collapse the explicit 3:2 spelling that stores a TXT mordent back into
   * its original held pitch before changing or deleting the semantic mark. */
  private collapseTextMordentRealization(chord: Chord): boolean {
    if (this.documentFormat === "jpw") return false;
    const begin = chord.notes.find((note) => note.tuplet !== null
      && (note.tupletBegin
        || (note.tuplet.ornamentProxy && note.tuplet.first === note)));
    const tuple = begin?.tuplet;
    if (!begin || !tuple || tuple.first.chord !== chord) return false;
    let tail = tuple.last;
    const visited = new Set<ScoreNote>();
    while (tail.tieNext && !visited.has(tail)) {
      visited.add(tail);
      tail = tail.tieNext;
    }
    const start = chord.measure.position.plus(chord.position);
    const tailDuration = tail.chord.duration ?? new Fraction(0);
    const end = tail.chord.measure.position.plus(tail.chord.position).plus(tailDuration);
    if (end.compareTo(start) <= 0) return false;
    const measureIndex = chord.measure.index;
    const partIndex = this.painter.score.parts.findIndex((part) =>
      part.measures[measureIndex]?.entries.includes(chord));
    const part = this.painter.score.parts[partIndex];
    if (!part) return false;
    for (const measure of part.measures) {
      measure.entries = measure.entries.filter((entry) => {
        if (!(entry instanceof Chord) || entry === chord) return true;
        const absolute = measure.position.plus(entry.position);
        if (absolute.compareTo(start) < 0 || absolute.compareTo(end) >= 0) return true;
        for (const note of entry.notes) {
          if (note.tiePrev) {
            note.tiePrev.tieNext = null;
            note.tiePrev.tieStart = false;
          }
          if (note.tieNext) {
            note.tieNext.tiePrev = null;
            note.tieNext.tieEnd = false;
          }
        }
        return false;
      });
    }
    for (const note of chord.notes) {
      note.tuplet = null;
      note.tupletBegin = false;
      note.tupletEnd = false;
      note.tieStart = false;
      note.tieEnd = false;
      note.tiePrev = null;
      note.tieNext = null;
    }
    this.setObjectChordDuration(chord, end.minus(start));
    return true;
  }

  private async editSelectedObjects(): Promise<boolean> {
    const selected = this._selectedObjects[this._selectedObjects.length - 1];
    if (!selected) return false;
    const score = this.painter.score;
    if (selected.kind === "grace") {
      const note = selected.mark as ScoreNote;
      const value = await showTextInput({ title: "修改倚音", label: "倚音音高（1–7）", value: note.number,
        validate: (text) => /^[1-7]$/.test(text) ? null : "请输入一个 1–7 的音级" });
      if (this.painter.score !== score) return true;
      if (!value || !/^[1-7]$/.test(value)) return true;
      this.setGraceDegree(note, parseInt(value, 10) as 1 | 2 | 3 | 4 | 5 | 6 | 7);
      this.commitObjectMutation(`已将倚音改为 ${value}`);
      return true;
    }
    if (selected.kind === "ornament") {
      const chord = selected.mark as Chord;
      const result = await showInputDialog({ title: "修改装饰音", fields: [{ name: "kind", label: "装饰音类型",
        value: chord.ornaments[0]?.kind ?? "upper-mordent", choices: [
          { value: "upper-mordent", label: "上波音" }, { value: "lower-mordent", label: "下波音" },
          { value: "trill", label: "颤音（Tr）" }] }] });
      if (this.painter.score !== score) return true;
      const value = result?.kind;
      if (!value || !["upper-mordent", "lower-mordent", "trill"].includes(value)) return true;
      this.collapseTextMordentRealization(chord);
      chord.ornaments = value === "trill"
        ? [{ kind: "trill", subdivision: 32 }]
        : [{ kind: value as "upper-mordent" | "lower-mordent" }];
      this.commitObjectMutation("已修改装饰音");
      return true;
    }
    if (selected.kind === "fermata") {
      const chord = selected.mark as Chord;
      chord.fermata = false;
      this.commitObjectMutation("已移除延长号");
      return true;
    }
    if (selected.kind === "cross-arpeggio") {
      const mark = selected.mark as CrossPartArpeggio;
      const result = await showInputDialog({ title: "修改跨谱行琶音", fields: [{ name: "direction", label: "琶音方向",
        value: mark.direction, choices: [{ value: "up", label: "向上" }, { value: "down", label: "向下" }] }] });
      if (this.painter.score !== score) return true;
      const value = result?.direction;
      if (value === "up" || value === "down") {
        mark.direction = value;
        this.commitObjectMutation("已修改跨谱行琶音方向");
      }
      return true;
    }
    if (selected.kind === "text") {
      const mark = selected.mark as ScoreTextMark;
      const value = await showTextInput({ title: "修改谱面文本", label: "谱面文本", value: mark.text,
        message: "留空可删除这段文本。", multiline: true });
      if (this.painter.score !== score) return true;
      if (value === null) return true;
      mark.text = value;
      this.commitObjectMutation(value.trim() ? "已修改谱面文本" : "已删除谱面文本");
      return true;
    }
    if (selected.kind === "tempo") {
      const mark = selected.mark as TempoMark;
      const rampTarget = this.tempoRampTarget(mark);
      const kindLabel = mark.kind === "accel" ? "渐快" : mark.kind === "rit" ? "渐慢" : "速度";
      const value = await showTextInput({ title: `修改${kindLabel}`, label: mark.kind === "tempo" ? "速度（BPM）" : "目标速度（BPM）",
        message: mark.kind === "tempo" ? "留空可删除速度记号。" : `留空可删除整段${kindLabel}。`,
        value: String(rampTarget?.bpm ?? mark.bpm ?? score.tempoBpm), inputMode: "decimal",
        validate: (text) => text.trim() ? positiveNumberError(text) : null });
      if (this.painter.score !== score) return true;
      if (value === null) return true;
      if (!value.trim()) {
        this.deleteSelectedScoreItems();
        return true;
      }
      const bpm = Number(value);
      if (Number.isFinite(bpm) && bpm > 0) {
        if (mark.kind === "accel" || mark.kind === "rit") {
          if (rampTarget) rampTarget.bpm = bpm;
          this.commitObjectMutation(`已修改${mark.kind === "accel" ? "渐快" : "渐慢"}目标速度`);
        } else {
          mark.bpm = bpm;
          this.commitObjectMutation("已修改速度");
        }
      }
      return true;
    }
    if (selected.kind === "key") {
      const mark = selected.mark as KeyMark;
      void showKeyCircleDialog(mark.fifths).then((fifths) => {
        if (fifths === null) return;
        applyKeyChangeKeepingDegrees(
          this.painter.score,
          0,
          mark.measure,
          mark.offset,
          fifths,
        );
        this.commitObjectMutation("已修改调号");
      });
      return true;
    }
    if (selected.kind === "meter") {
      const measureIndex = selected.measureIndex ?? 0;
      const measure = this.painter.score.parts[0]?.measures[measureIndex];
      if (!measure) return true;
      void showTimeSignatureDialog(measure.time.beats, measure.time.beatType).then((choice) => {
        if (!choice) return;
        measure.time.beats = choice.beats;
        measure.time.beatType = choice.beatType;
        measure.timeChange = true;
        this.commitObjectMutation("已修改拍号");
      });
      return true;
    }
    return false;
  }

  private selectionStatus(): string {
    const noteCount = this._selectedNotes.length;
    const objectCount = this._selectedObjects.length;
    if (noteCount + objectCount === 0) {
      return "已清除谱面选择；播放将从开头开始";
    }
    const parts = [
      noteCount > 0 ? `${noteCount} 个音符` : "",
      objectCount > 0 ? `${objectCount} 个谱面对象` : "",
    ].filter(Boolean);
    return `已选择 ${parts.join("、")}；Del/退格软删除，双击半透明项目恢复`;
  }

  private tempoMarkKey(mark: TempoMark): string {
    return `${mark.measure}:${mark.offset.toString()}:${mark.kind}:${mark.bpm ?? ""}`;
  }

  private tempoRampTarget(mark: TempoMark): TempoMark | null {
    if (mark.kind !== "accel" && mark.kind !== "rit") return null;
    return [...this.painter.score.tempoMarks]
      .filter((candidate) => candidate !== mark
        && candidate.kind === "tempo"
        && candidate.bpm !== null
        && (candidate.measure > mark.measure
          || candidate.measure === mark.measure && candidate.offset.compareTo(mark.offset) > 0))
      .sort((left, right) => left.measure - right.measure || left.offset.compareTo(right.offset))[0]
      ?? null;
  }

  private sameRange(left: JpwRange, right: JpwRange): boolean {
    return left.from === right.from && left.to === right.to;
  }

  private applySoftDeletedModelState(): void {
    for (const source of this._sourceNotes) source.note.softDeleted = false;
    for (const mark of this.painter.score.tempoMarks) mark.softDeleted = false;
    for (const source of this._sourceNotes) {
      if (this._softDeletedNotes.some((range) => this.sameRange(range, source))) {
        source.note.softDeleted = true;
      }
    }
    for (const mark of this.painter.score.tempoMarks) {
      mark.softDeleted = this._softDeletedTempoKeys.has(this.tempoMarkKey(mark));
    }
  }

  private applySoftDeletedClasses(): void {
    for (const source of this._sourceNotes) {
      if (!source.note.softDeleted) continue;
      for (const rendered of this.painter.noteGroupEls(source.chord, source.note)) {
        rendered.element.classList.add("soft-deleted");
      }
    }
    for (const mark of this.painter.score.tempoMarks) {
      if (!mark.softDeleted) continue;
      for (const rendered of this.painter.itemGroupsForData(mark)) {
        rendered.element.classList.add("soft-deleted");
      }
    }
  }

  private deleteSelectedScoreItems(): void {
    const notes = [...new Map(this._selectedNotes.map(({ source }) => [
      `${source.from}:${source.to}`,
      { from: source.from, to: source.to },
    ])).values()].filter((range) =>
      !this._softDeletedNotes.some((item) => this.sameRange(item, range)));
    const selectedTempoMarks = this._selectedObjects
      .filter(({ kind }) => kind === "tempo")
      .map(({ mark }) => mark as TempoMark);
    const tempoKeys = [...new Set(selectedTempoMarks
      .flatMap((mark) => [mark, this.tempoRampTarget(mark)].filter(
        (candidate): candidate is TempoMark => candidate !== null,
      ))
      .map((mark) => this.tempoMarkKey(mark))
      .filter((key) => !this._softDeletedTempoKeys.has(key)))];
    const hardObjects = this._selectedObjects.filter(({ kind }) => kind !== "tempo");
    if (notes.length === 0 && tempoKeys.length === 0 && hardObjects.length === 0) return;

    for (const object of hardObjects) {
      if (object.kind === "key") {
        const mark = object.mark as KeyMark;
        const previous = [...this.painter.score.keyMarks]
          .filter((candidate) => candidate !== mark
            && (candidate.measure < mark.measure
              || candidate.measure === mark.measure && candidate.offset.compareTo(mark.offset) < 0))
          .sort((left, right) => left.measure - right.measure || left.offset.compareTo(right.offset))
          .pop();
        const openingFifths = this.painter.score.parts[0]?.measures[0]?.key.fifths ?? 0;
        // Deleting a modulation must undo its sounding transposition as well
        // as its label. Reusing the degree-preserving edit keeps every visible
        // number/octave/accidental unchanged, then the obsolete marker itself
        // is removed below.
        applyKeyChangeKeepingDegrees(
          this.painter.score,
          0,
          mark.measure,
          mark.offset,
          previous?.fifths ?? openingFifths,
        );
        this.painter.score.keyMarks = this.painter.score.keyMarks.filter((candidate) => candidate !== mark);
        const measure = this.painter.score.parts[0]?.measures[object.measureIndex ?? mark.measure];
        if (measure) measure.keyChange = false;
      } else if (object.kind === "meter") {
        const measure = this.painter.score.parts[0]?.measures[object.measureIndex ?? 0];
        if (measure) {
          const previous = this.painter.score.parts[0]?.measures[Math.max(0, measure.index - 1)];
          if (previous) measure.time = new Time(previous.time.beats, previous.time.beatType);
          measure.timeChange = false;
        }
      } else if (object.kind === "text") {
        const mark = object.mark as ScoreTextMark;
        this.painter.score.textMarks = this.painter.score.textMarks.filter((candidate) => candidate !== mark);
      } else if (object.kind === "grace") {
        const note = object.mark as ScoreNote;
        note.chord.graceNotes = note.chord.graceNotes.filter((candidate) => candidate !== note);
      } else if (object.kind === "ornament") {
        const chord = object.mark as Chord;
        this.collapseTextMordentRealization(chord);
        chord.ornaments = [];
      } else if (object.kind === "fermata") {
        const chord = object.mark as Chord;
        chord.fermata = false;
      } else if (object.kind === "arpeggio") {
        const chord = object.mark as Chord;
        chord.arpeggio = false;
        chord.arpeggioPitches = null;
      } else if (object.kind === "cross-arpeggio") {
        const mark = object.mark as CrossPartArpeggio;
        this.painter.score.crossPartArpeggios = this.painter.score.crossPartArpeggios.filter(
          (candidate) => candidate !== mark,
        );
      } else if (object.kind === "tuplet") {
        removeInputTriplet(this.painter.score, object.mark as Tuplet);
      }
    }

    // Hard-deleted annotations are written through CodeMirror so its normal
    // history can restore them; reserve the score soft-delete stack for notes
    // and tempo marks only.
    if (notes.length > 0 || tempoKeys.length > 0) {
      this._scoreUndoStack.push({ notes, tempoKeys });
    }
    this._softDeletedNotes.push(...notes);
    for (const key of tempoKeys) this._softDeletedTempoKeys.add(key);
    this.applySoftDeletedModelState();
    this.applySoftDeletedClasses();
    this.clearSelectedItems();
    this.syncCodeSelections(false);
    if (hardObjects.length > 0) {
      this.commitObjectMutation(`已删除 ${hardObjects.length} 个谱面对象`);
      return;
    }
    this.setStatus(`已软删除 ${notes.length + tempoKeys.length} 项；双击半透明项目恢复，Ctrl+Z 撤回`);
  }

  private undoScoreDelete(): boolean {
    const action = this._scoreUndoStack.pop();
    if (!action) return false;
    this._softDeletedNotes = this._softDeletedNotes.filter((range) =>
      !action.notes.some((item) => this.sameRange(item, range)));
    for (const key of action.tempoKeys) this._softDeletedTempoKeys.delete(key);
    this.applySoftDeletedModelState();
    for (const source of this._sourceNotes) {
      if (source.note.softDeleted) continue;
      for (const rendered of this.painter.noteGroupEls(source.chord, source.note)) {
        rendered.element.classList.remove("soft-deleted");
      }
    }
    for (const mark of this.painter.score.tempoMarks) {
      if (mark.softDeleted) continue;
      for (const rendered of this.painter.itemGroupsForData(mark)) {
        rendered.element.classList.remove("soft-deleted");
      }
    }
    this.setStatus(`已撤回谱面删除：恢复 ${action.notes.length + action.tempoKeys.length} 项`);
    return true;
  }

  private discardRestoredUndo(
    restoredRange: JpwRange | null,
    restoredTempoKey: string | null,
  ): void {
    this._scoreUndoStack = this._scoreUndoStack.map((action) => ({
      notes: restoredRange
        ? action.notes.filter((range) => !this.sameRange(range, restoredRange))
        : action.notes,
      tempoKeys: restoredTempoKey
        ? action.tempoKeys.filter((key) => key !== restoredTempoKey)
        : action.tempoKeys,
    })).filter((action) => action.notes.length > 0 || action.tempoKeys.length > 0);
  }

  private onPageDoubleClick(pageIndex: number, svg: SVGSVGElement, ev: MouseEvent): void {
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const picked = this.pickScoreAtPointer(pageIndex, ctm, ev);
    if (!picked) return;
    const hit = this.scoreNoteHit(picked);
    if (hit && hit.source.note.softDeleted) {
      const range = { from: hit.source.from, to: hit.source.to };
      this._softDeletedNotes = this._softDeletedNotes.filter((item) =>
        !this.sameRange(item, range));
      hit.source.note.softDeleted = false;
      for (const rendered of this.painter.noteGroupEls(hit.source.chord, hit.source.note)) {
        rendered.element.classList.remove("soft-deleted");
      }
      this.discardRestoredUndo(range, null);
      this.setStatus("已恢复音符");
      ev.preventDefault();
      return;
    }
    const object = this.scoreObjectHit(picked);
    if (object?.kind === "tempo" && (object.mark as TempoMark).softDeleted) {
      const tempo = object.mark as TempoMark;
      const key = this.tempoMarkKey(tempo);
      this._softDeletedTempoKeys.delete(key);
      tempo.softDeleted = false;
      for (const rendered of this.painter.itemGroupsForData(tempo)) {
        rendered.element.classList.remove("soft-deleted");
      }
      this.discardRestoredUndo(null, key);
      this.setStatus("已恢复速度标记");
      ev.preventDefault();
      return;
    }
    if (object) {
      this.selectScoreObject(object, false);
      this.editSelectedObjects();
      ev.preventDefault();
    }
  }

  private onPagePointerDown(
    page: number,
    svg: SVGSVGElement,
    ev: PointerEvent,
  ): void {
    if (ev.button !== 0) return;
    // Header clicks open editors; pointer capture for rubber-band selection
    // would retarget the subsequent click to the SVG instead of its text.
    if (scoreHeaderTarget(ev.target)) return;
    if (this._input.enabled && !ev.shiftKey) return;
    ev.preventDefault();
    window.getSelection()?.removeAllRanges();
    this._dragSelection = {
      page,
      svg,
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      currentX: ev.clientX,
      currentY: ev.clientY,
      additive: ev.ctrlKey || ev.metaKey,
      moved: false,
    };
    svg.setPointerCapture(ev.pointerId);
  }

  private onPagePointerMove(ev: PointerEvent): void {
    const drag = this._dragSelection;
    if (!drag || drag.pointerId !== ev.pointerId) return;
    drag.currentX = ev.clientX;
    drag.currentY = ev.clientY;
    if (Math.hypot(drag.currentX - drag.startX, drag.currentY - drag.startY) >= 4) {
      drag.moved = true;
    }
    if (drag.moved) ev.preventDefault();
  }

  private onPagePointerUp(ev: PointerEvent): void {
    const drag = this._dragSelection;
    if (!drag || drag.pointerId !== ev.pointerId) return;
    drag.currentX = ev.clientX;
    drag.currentY = ev.clientY;
    this._dragSelection = null;
    if (drag.svg.hasPointerCapture(ev.pointerId)) drag.svg.releasePointerCapture(ev.pointerId);
    if (!drag.moved) return;
    ev.preventDefault();
    this.selectNotesInDragRect(drag);
    this._suppressPageClick = true;
    setTimeout(() => {
      this._suppressPageClick = false;
    }, 0);
  }

  private onPagePointerCancel(ev: PointerEvent): void {
    const drag = this._dragSelection;
    if (!drag || drag.pointerId !== ev.pointerId) return;
    this._dragSelection = null;
    if (drag.svg.hasPointerCapture(ev.pointerId)) drag.svg.releasePointerCapture(ev.pointerId);
  }

  private selectNotesInDragRect(drag: ScoreDragSelection): void {
    const left = Math.min(drag.startX, drag.currentX);
    const right = Math.max(drag.startX, drag.currentX);
    const top = Math.min(drag.startY, drag.currentY);
    const bottom = Math.max(drag.startY, drag.currentY);
    if (!drag.additive) this.clearSelectedItems();
    for (const source of this._sourceNotes) {
      const rendered = this.painter.noteGroupEls(source.chord, source.note)
        .find((item) => item.page === drag.page && (() => {
          const rect = item.element.getBoundingClientRect();
          return rect.left <= right && rect.right >= left
            && rect.top <= bottom && rect.bottom >= top;
        })());
      if (rendered) this.addScoreSelection(source, rendered.verse, rendered.element);
    }
    const last = this._selectedNotes[this._selectedNotes.length - 1];
    this._rangeAnchorPosition = last?.source.from ?? this._rangeAnchorPosition;
    this._pendingSelectionAnchors = null;
    this.syncCodeSelections(true);
    this.setStatus(this.selectionStatus());
    this.scorePane.focus({ preventScroll: true });
  }

  private clearSelectedItems(): void {
    const releasedNotes = this._selectedNotes.length > 0;
    for (const element of this.selectedEls) element.classList.remove("selected");
    this.selectedEls.clear();
    this._selectedNotes = [];
    this._selectedObjects = [];
    this._pendingSelectionAnchors = null;
    if (releasedNotes) this.queueDuplicatePitchMerge();
  }

  private scoreHasDuplicateChordPitches(): boolean {
    return this.painter.score.parts.some((part) => part.measures.some((measure) =>
      measure.entries.some((entry) => {
        if (!(entry instanceof Chord) || entry.rest || entry.generatedTimingContinuation) return false;
        const pitches = entry.notes.filter((note) => !note.rest).map((note) => note.pitch);
        return new Set(pitches).size < pitches.length;
      })));
  }

  private queueDuplicatePitchMerge(): void {
    if (!this._mergeDuplicatePitchesOnSelectionRelease || this._duplicatePitchMergeQueued) return;
    this._duplicatePitchMergeQueued = true;
    queueMicrotask(() => {
      this._duplicatePitchMergeQueued = false;
      this.commitDuplicateChordPitches();
    });
  }

  private commitDuplicateChordPitches(): void {
    if (!this._mergeDuplicatePitchesOnSelectionRelease) return;
    this._mergeDuplicatePitchesOnSelectionRelease = false;
    const removed = mergeDuplicateChordPitches(this.painter.score);
    if (removed === 0) return;
    const anchors = this._selectedNotes.map((selection) => this.selectionAnchor(selection));
    const next = this.serializeCurrentScoreDocument();
    if (next === null || !this.replaceDocumentText(next, anchors)) {
      this._mergeDuplicatePitchesOnSelectionRelease = true;
    }
  }

  private deselect(syncCode = true): void {
    this.clearSelectedItems();
    this._rangeAnchorPosition = null;
    if (!this.view) return;
    if (syncCode) this.syncCodeSelections(false);
    else this.view.dispatch({ effects: setScoreSourceHighlights.of([]) });
  }

  private syncCodeSelections(scroll: boolean): void {
    if (!this.view) return;
    this.notifyWorkspaceChange();
    if (this._selectedNotes.length === 0) {
      const head = this.view.state.selection.main.head;
      this._syncingCodeSelection = true;
      try {
        this.view.dispatch({
          selection: EditorSelection.single(head),
          effects: setScoreSourceHighlights.of([]),
        });
      } finally {
        this._syncingCodeSelection = false;
      }
      return;
    }
    const primary = this._selectedNotes[this._selectedNotes.length - 1].source;
    const unique = [...new Map(this._selectedNotes.map((selection) => [
      `${selection.source.from}:${selection.source.to}`,
      selection.source,
    ])).values()].sort((a, b) => a.from - b.from || a.to - b.to);
    const mainIndex = Math.max(0, unique.findIndex((source) => source === primary));
    this._syncingCodeSelection = true;
    try {
      this.view.dispatch({
        selection: EditorSelection.create(
          unique.map((source) => EditorSelection.range(source.from, source.to)),
          mainIndex,
        ),
        effects: [
          setScoreSourceHighlights.of(unique.map((source) => ({ from: source.from, to: source.to }))),
          ...(scroll ? [EditorView.scrollIntoView(primary.from, { y: "center" })] : []),
        ],
      });
    } finally {
      this._syncingCodeSelection = false;
    }
  }

  /** Mirror a keyboard/number/JPW source selection back onto rendered notes. */
  private syncScoreSelectionsFromCode(): void {
    if (!this.view || this.mode !== "jp") return;
    const ranges = this.view.state.selection.ranges;
    const sources = this._sourceNotes.filter((source) => ranges.some((range) =>
      range.empty
        // A caret is a position between characters, not a text selection.
        // Do not select a one-character score note merely because the caret
        // sits on its left edge after crossing an invisible voice marker.
        ? range.head > source.from && range.head < source.to
        : range.from < source.to && range.to > source.from));
    this.clearSelectedItems();
    for (const source of sources) {
      const rendered = this.painter.noteGroupEls(source.chord, source.note)[0];
      if (rendered) this.addScoreSelection(source, rendered.verse, rendered.element);
    }
    const last = sources[sources.length - 1];
    this._rangeAnchorPosition = last?.from ?? null;
    this.view.dispatch({
      effects: setScoreSourceHighlights.of(sources.map((source) => ({
        from: source.from,
        to: source.to,
      }))),
    });
    this.notifyWorkspaceChange();
  }

  private restoreScoreSelections(): void {
    const anchors = this._pendingSelectionAnchors
      ?? this._selectedNotes.map((selection) => this.selectionAnchor(selection));
    this._selectedNotes = [];
    this._selectedObjects = [];
    this._pendingSelectionAnchors = null;
    for (const anchor of anchors) {
      const temporal = anchor.partIndex === undefined
        || anchor.pitch === undefined
        || anchor.absoluteTick === undefined
        ? null
        : this._sourceNotes.find((candidate) =>
          candidate.partIndex === anchor.partIndex
          && candidate.note.pitch === anchor.pitch
          && candidate.grace === anchor.grace
          && candidate.note.absoluteTick.toString() === anchor.absoluteTick);
      const semantic = anchor.partIndex === undefined || anchor.chordIndex === undefined
        ? []
        : this._sourceNotes.filter((candidate) =>
          candidate.partIndex === anchor.partIndex
          && candidate.chordIndex === anchor.chordIndex
          && candidate.grace === anchor.grace);
      const source = temporal ?? semantic[anchor.toneIndex ?? 0] ?? this._sourceNotes.find((candidate) =>
        anchor.position === candidate.from
        || (anchor.position >= candidate.from && anchor.position < candidate.to));
      if (source) {
        let visual = source.note;
        const visited = new Set<ScoreNote>();
        while (anchor.visualTick && visual.absoluteTick.toString() !== anchor.visualTick
          && visual.tieNext && !visited.has(visual)) {
          visited.add(visual);
          visual = visual.tieNext;
        }
        if (visual.absoluteTick.toString() !== anchor.visualTick) visual = source.note;
        const element = this.painter.noteGroupEl(visual.chord, visual, anchor.verse);
        this.addScoreSelection(source, anchor.verse, element ?? undefined, visual);
      }
    }
    if (anchors.length > 0) this.syncCodeSelections(false);
  }

  private onEditorKeyDown(event: KeyboardEvent): boolean {
    if (handleTextShortcut(event, this.view, (mapped) => this.handleInvisibleVoiceMarkerKey(mapped))) return true;
    const mapped = remapShortcutEvent(event, "text");
    if (!mapped) return true;
    event = mapped;
    if (this.handleVoiceShortcut(event)) return true;
    return this.handleInvisibleVoiceMarkerKey(event);
  }

  /** Treat U+2063 prefixes as part of the following pitch. Cursor movement
   *  skips the invisible run in one press, and deleting a marked pitch removes
   *  its prefix at the same time instead of leaving orphan markers behind. */
  private handleInvisibleVoiceMarkerKey(event: KeyboardEvent): boolean {
    if (this.documentFormat === "jpw" || !this.slashOptions
      || event.altKey || event.ctrlKey || event.metaKey) return false;
    const selection = this.view.state.selection;
    const doc = this.view.state.doc;
    const markedSources = this._sourceNotes.filter((source) =>
      (source.markerCount ?? 0) > 0 && source.markerFrom !== undefined);
    const nextCodePoint = (position: number): number => {
      if (position >= doc.length) return doc.length;
      const first = doc.sliceString(position, Math.min(doc.length, position + 1))
        .charCodeAt(0);
      const second = position + 1 < doc.length
        ? doc.sliceString(position + 1, position + 2).charCodeAt(0)
        : 0;
      return position + (first >= 0xd800 && first <= 0xdbff
        && second >= 0xdc00 && second <= 0xdfff ? 2 : 1);
    };
    const previousCodePoint = (position: number): number => {
      if (position <= 0) return 0;
      const last = doc.sliceString(position - 1, position).charCodeAt(0);
      const before = position > 1
        ? doc.sliceString(position - 2, position - 1).charCodeAt(0)
        : 0;
      return position - (last >= 0xdc00 && last <= 0xdfff
        && before >= 0xd800 && before <= 0xdbff ? 2 : 1);
    };
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight")
      && !event.shiftKey && selection.ranges.every((range) => range.empty)) {
      const direction = event.key === "ArrowRight" ? 1 : -1;
      let changed = false;
      const ranges = selection.ranges.map((range) => {
        let head = range.head;
        const source = markedSources.find((candidate) => {
          const firstVisibleEnd = Math.min(
            candidate.to,
            nextCodePoint(candidate.from),
          );
          return direction > 0
            ? head >= candidate.markerFrom! && head <= candidate.from
            : head > candidate.markerFrom! && head <= firstVisibleEnd;
        });
        if (source) {
          head = direction > 0
            ? Math.min(source.to, nextCodePoint(source.from))
            : head <= source.from
              ? previousCodePoint(source.markerFrom!)
              : source.markerFrom!;
        } else if (direction > 0) {
          while (head < doc.length
            && doc.sliceString(head, head + 1) === SLASH_VOICE_SEPARATOR) head++;
        } else {
          while (head > 0
            && doc.sliceString(head - 1, head) === SLASH_VOICE_SEPARATOR) head--;
        }
        changed ||= head !== range.head;
        return EditorSelection.cursor(head);
      });
      if (!changed) return false;
      event.preventDefault();
      event.stopPropagation();
      this.view.dispatch({
        selection: EditorSelection.create(ranges, selection.mainIndex),
      });
      return true;
    }
    if ((event.key !== "Delete" && event.key !== "Backspace") || event.shiftKey) return false;

    const requested: Array<{ from: number; to: number }> = [];
    let markerOnlySelection = false;
    let needsAtomicHandling = false;
    for (const range of selection.ranges) {
      if (!range.empty) {
        const selectedSources = markedSources.filter((source) =>
          range.from < source.to && range.to > source.from);
        const intersectsMarker = markedSources.some((source) =>
          range.from < source.from && range.to > source.markerFrom!);
        needsAtomicHandling ||= selectedSources.length > 0 || intersectsMarker;
        const selectedAtoms = new Set(selectedSources);
        const expanded = {
          from: selectedSources.length > 0
            ? Math.min(range.from, ...selectedSources.map((source) => source.markerFrom!))
            : range.from,
          to: selectedSources.length > 0
            ? Math.max(range.to, ...selectedSources.map((source) => source.to))
            : range.to,
        };
        let cursor = expanded.from;
        const protectedMarkers = markedSources
          .filter((source) => !selectedAtoms.has(source)
            && source.markerFrom! < expanded.to && source.from > expanded.from)
          .map((source) => ({
            from: Math.max(expanded.from, source.markerFrom!),
            to: Math.min(expanded.to, source.from),
          }))
          .filter((marker) => marker.to > marker.from)
          .sort((left, right) => left.from - right.from);
        for (const marker of protectedMarkers) {
          if (cursor < marker.from) requested.push({ from: cursor, to: marker.from });
          cursor = Math.max(cursor, marker.to);
          markerOnlySelection = true;
        }
        if (cursor < expanded.to) requested.push({ from: cursor, to: expanded.to });
        continue;
      }

      const head = range.head;
      const markerAtCaret = markedSources.find((candidate) =>
        head > candidate.markerFrom! && head <= candidate.from);
      if (event.key === "Backspace" && markerAtCaret) {
        event.preventDefault();
        event.stopPropagation();
        const previous = previousCodePoint(markerAtCaret.markerFrom!);
        if (previous < markerAtCaret.markerFrom!) {
          this.view.dispatch({
            changes: {
              from: previous,
              to: markerAtCaret.markerFrom!,
              insert: "",
            },
            selection: EditorSelection.cursor(previous),
          });
        } else {
          this.view.dispatch({
            selection: EditorSelection.cursor(markerAtCaret.markerFrom!),
          });
        }
        return true;
      }
      const source = markedSources.find((candidate) => event.key === "Backspace"
        ? head > candidate.from && head <= candidate.to
        : head >= candidate.markerFrom! && head < candidate.to);
      if (source) {
        needsAtomicHandling = true;
        requested.push({ from: source.markerFrom!, to: source.to });
      }
    }
    if (!needsAtomicHandling) return false;
    if (requested.length === 0) {
      if (!markerOnlySelection) return false;
      event.preventDefault();
      event.stopPropagation();
      this.setStatus("声部隐形标记会随对应音符一起删除，不能单独删除");
      return true;
    }

    const merged: Array<{ from: number; to: number }> = [];
    for (const range of requested
      .filter((item) => item.to > item.from)
      .sort((left, right) => left.from - right.from || left.to - right.to)) {
      const previous = merged[merged.length - 1];
      if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
      else merged.push({ ...range });
    }
    event.preventDefault();
    event.stopPropagation();
    this.view.dispatch({
      changes: merged.map((range) => ({ ...range, insert: "" })),
    });
    this.setStatus(`已删除 ${requested.length} 个音符及其声部隐形标记`);
    return true;
  }

  private handleVoiceShortcut(event: KeyboardEvent): boolean {
    if (this.documentFormat === "jpw" || !this.slashOptions || !event.altKey
      || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
    const targetVoice = match ? parseInt(match[1], 10) : /^[1-9]$/.test(event.key)
      ? parseInt(event.key, 10)
      : 0;
    if (targetVoice === 0) return false;
    event.preventDefault();
    event.stopPropagation();

    let voiceCount = Math.max(1, Math.min(MAX_SLASH_VOICES, this.slashOptions.voiceCount));
    const wasSingleAltOne = voiceCount === 1 && targetVoice === 1;
    if (targetVoice > voiceCount && !wasSingleAltOne) {
      this.setStatus(`当前启用 ${voiceCount} 个声部；请先在选项中启用 V${targetVoice}`);
      return true;
    }
    const ranges = this.view.state.selection.ranges;
    const selected = [...new Map(this._sourceNotes.filter((source) =>
      this._selectedNotes.some((selection) => selection.source === source)
      || ranges.some((range) => range.empty
        ? range.head >= source.from && range.head < source.to
        : range.from < source.to && range.to > source.from))
      .map((source) => [`${source.from}:${source.to}`, source])).values()];
    if (selected.length === 0) {
      this.setStatus("请先在文本或谱面中选择要分配声部的音符");
      return true;
    }

    const selectedOrdinals = selected.map((source) => this._sourceNotes.indexOf(source));
    if (wasSingleAltOne) voiceCount = 2;
    const assignedVoice = (source: JpwSourceNote): number => targetVoice === voiceCount
      || (!wasSingleAltOne && source.voiceIndex === targetVoice)
      ? voiceCount
      : targetVoice;
    const touchesTuplet = selected.some((source) => source.note.tuplet !== null
      || this.painter.score.parts[assignedVoice(source) - 1]?.measures[source.chord.measure.index]
        ?.entries.some((entry) => entry instanceof Chord && entry.notes.some((note) => note.tuplet)
          && entry.position.compareTo(source.chord.position.plus(source.chord.duration ?? new Fraction(0))) < 0
          && entry.position.plus(entry.duration ?? new Fraction(0)).compareTo(source.chord.position) > 0));
    if (touchesTuplet) {
      this.reassignTupletVoiceSelection(selected, assignedVoice, voiceCount);
      return true;
    }
    const text = this.getText();
    const changes = selected.map((source) => {
      const markerFrom = source.markerFrom ?? source.from;
      const currentVoice = wasSingleAltOne ? 2 : source.voiceIndex ?? voiceCount;
      const assignedVoice = targetVoice === voiceCount
        || (!wasSingleAltOne && currentVoice === targetVoice)
        ? voiceCount
        : targetVoice;
      const insert = slashVoiceMarker(source.markerCount ?? 0, assignedVoice, voiceCount);
      return { from: markerFrom, to: source.from, insert };
    }).sort((left, right) => right.from - left.from || right.to - left.to);
    let next = text;
    for (const change of changes) {
      next = next.slice(0, change.from) + change.insert + next.slice(change.to);
    }
    this.slashOptions = { ...this.slashOptions, voiceCount };
    if (wasSingleAltOne) next = embedSlashScoreOptions(next, this.slashOptions);
    this.setText(next);
    clearTimeout(this.debounceTimer);
    this.reload(this.getText());
    for (const ordinal of selectedOrdinals) {
      const source = this._sourceNotes[ordinal];
      const rendered = source ? this.painter.noteGroupEls(source.chord, source.note)[0] : undefined;
      if (source && rendered) this.addScoreSelection(source, rendered.verse, rendered.element);
    }
    if (this._selectedNotes.length > 0) this.syncCodeSelections(false);
    this.setStatus(
      wasSingleAltOne
        ? `已自动启用双声部，并把 ${selected.length} 个音符设为 V1；其余音符属于默认 V2`
        : targetVoice === voiceCount
          ? `已把 ${selected.length} 个音符移回默认声部 V${voiceCount}`
          : `已切换 ${selected.length} 个音符的 V${targetVoice} 归属`,
    );
    return true;
  }

  /** Tuplet voice assignment is a rhythmic edit: changing only U+2063 can
   * reinterpret a member on another voice's different triplet grid. Stage
   * the moves on a fresh model and commit only if every member fits. */
  private reassignTupletVoiceSelection(
    selected: JpwSourceNote[],
    assignedVoice: (source: JpwSourceNote) => number,
    voiceCount: number,
  ): void {
    if (!this.slashOptions || this.documentFormat === "jpw") return;
    const migration = migrateSlashVoiceCount(this.getText(), this.slashOptions, voiceCount);
    const score = parseSlashScore(migration.text, migration.options).score;
    const sources = buildSlashSourceNotes(migration.text, migration.options, score);
    const moved: Array<{ part: number; pitch: number; absolute: Fraction }> = [];
    for (const original of selected) {
      const source = sources.find((candidate) => candidate.from === original.from && candidate.to === original.to);
      const target = assignedVoice(original) - 1;
      if (!source || source.grace) {
        this.setStatus("所选音符暂时无法完整对应到三连音，未更改声部");
        return;
      }
      if (source.partIndex === target) continue;
      const result = moveInputNoteToPart(score, source.partIndex, source.chord, source.note, target);
      if (!result.changed || !result.note || !result.targetChord) {
        this.setStatus("目标声部的节奏与所选三连音不兼容，未更改音符或时值");
        return;
      }
      moved.push({ part: target, pitch: result.note.pitch,
        absolute: result.targetChord.measure.position.plus(result.targetChord.position) });
    }
    if (moved.length === 0) return;
    this.deselect(false);
    this.painter.score = score;
    this.slashOptions = migration.options;
    if (!this.commitInputMutation(`已保持三连音时值，将 ${moved.length} 个音移到目标声部`)) return;
    for (const anchor of moved) {
      const source = this._sourceNotes.find((candidate) => candidate.partIndex === anchor.part
        && candidate.note.pitch === anchor.pitch
        && candidate.chord.measure.position.plus(candidate.chord.position).equals(anchor.absolute));
      const rendered = source ? this.painter.noteGroupEls(source.chord, source.note)[0] : undefined;
      if (source && rendered) this.addScoreSelection(source, rendered.verse, rendered.element);
    }
    if (this._selectedNotes.length > 0) this.syncCodeSelections(false);
  }

  private onScoreKeyDown(event: KeyboardEvent): void {
    if (event.isComposing || event.getModifierState("AltGraph")) return;
    const keyboardLabels = this.documentFormat === "keyboard" && this.slashOptions?.keyboardKeyLabels;
    // In selection mode N always enters notation input. Once input is active,
    // it belongs to the printed piano keys; custom non-letter shortcuts remain usable.
    if (keyboardLabels && !event.ctrlKey && !event.metaKey && !event.altKey
      && (this._input.enabled || event.key.toLowerCase() !== "n")
      && keyboardNoteForKey(event.key) && this._selectedObjects.length === 0
      && (this._selectedNotes.length > 0 || this._input.enabled)) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) this.editSelectedKeyboardNote(event.key);
      return;
    }
    const mapped = remapShortcutEvent(event, this._input.enabled ? "input" : this._selectedObjects.length > 0 ? "object" : "selection");
    if (!mapped) return;
    event = mapped;
    if (event.key.toLowerCase() === "n" && !event.ctrlKey && !event.metaKey && !event.altKey
      && (this._input.enabled || this._selectedNotes.length > 0)) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) this.setInputMode(!this._input.enabled);
      return;
    }
    if (!this._input.enabled && event.key === " "
      && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      && (this._selectedNotes.length > 0 || this._player?.state === "playing" || this._player?.state === "loading")) {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (this._player?.state === "playing" || this._player?.state === "loading") this.stopPlayback();
      else void this.playScore();
      return;
    }
    if ((event.ctrlKey || event.metaKey)
      && ((event.shiftKey && event.key.toLowerCase() === "z")
        || (!event.shiftKey && event.key.toLowerCase() === "y"))) {
      event.preventDefault();
      event.stopPropagation();
      redo(this.view);
      return;
    }
    if ((event.ctrlKey || event.metaKey)
      && !event.shiftKey
      && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.stopPropagation();
      if (!this.undoScoreDelete()) undo(this.view);
      return;
    }
    // In input mode an annotation click selects that semantic object instead
    // of moving the rhythmic caret.  Object editing therefore has priority
    // over the normal 0–7/arrow input bindings.
    if (this._selectedObjects.length > 0 && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      this.editSelectedObjects();
      return;
    }
    if (this._selectedObjects.length > 0
      && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      event.stopPropagation();
      this.deleteSelectedScoreItems();
      return;
    }
    if (this._input.enabled
      && this._selectedObjects.length > 0
      && /^[1-7]$/.test(event.key)) {
      const grace = this._selectedObjects.find((item) => item.kind === "grace");
      if (grace) {
        this.setGraceDegree(
          grace.mark as ScoreNote,
          parseInt(event.key, 10) as 1 | 2 | 3 | 4 | 5 | 6 | 7,
        );
        this.commitObjectMutation(`已将倚音改为 ${event.key}`);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (this._selectedObjects.length > 0
      && (event.key === "ArrowUp" || event.key === "ArrowDown")
      && (event.ctrlKey || event.metaKey)) {
      const grace = this._selectedObjects.find((item) => item.kind === "grace");
      if (grace) {
        const note = grace.mark as ScoreNote;
        const octaveDelta = event.key === "ArrowUp" ? 1 : -1;
        note.jpOctave += octaveDelta;
        note.pitch += octaveDelta * 12;
        this.commitObjectMutation("已调整倚音八度");
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (this.handleInputKeyDown(event)) return;
    if (this.handleVoiceShortcut(event)) return;
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
      && (event.key === "ArrowUp" || event.key === "ArrowDown")
      && this._selectedNotes.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      this.moveSelectedNotesToAdjacentPart(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace")
      && this._selectedNotes.length + this._selectedObjects.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      this.deleteSelectedScoreItems();
      return;
    }
    if (this._selectedNotes.length === 0) return;
    // Rhythmic movement and direct 1–7 entry belong exclusively to score
    // input mode. In normal selection mode these keys must remain inert so a
    // casual arrow/digit press cannot silently rewrite the document.
    if (event.key === "ArrowLeft" || event.key === "ArrowRight"
      || /^[1-7]$/.test(event.key)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    let edit: PitchEdit | null = null;
    let label = "";
    if (event.key === "ArrowUp") {
      edit = { kind: "octave", delta: 1 };
      label = "增加一个上加点（或移除一个下加点）";
    } else if (event.key === "ArrowDown") {
      edit = { kind: "octave", delta: -1 };
      label = "增加一个下加点（或移除一个上加点）";
    }
    if (!edit) return;
    event.preventDefault();
    event.stopPropagation();
    this.editSelectedPitches(edit, label);
  }

  private moveSelectedNotesToAdjacentPart(direction: -1 | 1): void {
    const selections = [...new Map(this._selectedNotes.map((selection) => [
      selection.source.note,
      selection,
    ])).values()];
    let changed = 0;
    let blocked = 0;
    for (const selection of selections) {
      const targetPart = selection.source.partIndex + direction;
      if (targetPart < 0 || targetPart >= this.painter.score.parts.length) {
        blocked++;
        continue;
      }
      const result = moveInputNoteToPart(
        this.painter.score,
        selection.source.partIndex,
        selection.source.chord,
        selection.source.note,
        targetPart,
      );
      if (result.changed) changed++;
      else blocked++;
    }
    if (changed === 0) {
      this.setStatus(direction < 0 ? "选中音已经在最上方可用声部" : "选中音已经在最下方可用声部");
      return;
    }
    const next = this.serializeCurrentScoreDocument();
    if (next === null || !this.replaceDocumentText(next)) {
      this.setStatus("跨声部移动后的谱面无法写回当前格式");
      return;
    }
    this.setStatus(`已把 ${changed} 个音移动到相邻${direction < 0 ? "上方" : "下方"}声部${blocked ? `；${blocked} 个未移动` : ""}`);
  }

  private editSelectedPitches(edit: PitchEdit, label: string): void {
    const text = this.getText();
    const sources = [...new Map(this._selectedNotes.map((selection) => [
      `${selection.source.from}:${selection.source.to}`,
      selection.source,
    ])).values()].sort((a, b) => a.from - b.from);
    const changes = sources.map((source) => {
      const before = text.substring(source.from, source.to);
      const insert = this.documentFormat === "jpw"
        ? editJpwPitch(before, edit)
        : editSlashPitch(before, this.documentFormat, edit);
      return { from: source.from, to: source.to, insert, before };
    }).filter((change) => change.insert !== change.before);
    if (changes.length === 0) return;
    this.view.dispatch({ changes: changes.map(({ from, to, insert }) => ({ from, to, insert })) });
    clearTimeout(this.debounceTimer);
    const ok = this.reload(this.getText());
    this.setStatus(ok ? `已修改 ${changes.length} 个音符：${label}` : "修改后的谱面暂时无法解析");
  }

  private automaticTimingDivision(): NoteTimingDivision {
    const source = this._selectedNotes[this._selectedNotes.length - 1]?.source;
    const measure = source?.chord.measure;
    if (!measure) return 16;
    let division = Math.max(4, measure.time.beatType);
    for (const entry of measure.entries) {
      if (!(entry instanceof Chord) || entry.generatedTimingContinuation) continue;
      division = Math.max(division, 4 * (1 << Math.max(0, entry.beams)));
    }
    const allowed: NoteTimingDivision[] = [1, 2, 4, 8, 16, 32, 64];
    return allowed.find((value) => value >= Math.min(64, division)) ?? 64;
  }

  private activeTimingDivision(): NoteTimingDivision {
    if (this.engravingStyle.rhythmGuideMode === "manual") {
      const selected = this.engravingStyle.rhythmGuideDivision;
      if (this.documentFormat === "jpw") return selected;
      return Math.min(selected, this.slashTimingGridLimits().enabledMaximum) as NoteTimingDivision;
    }
    if (this._input.enabled && this._input.cursor) return this._input.cursor.division;
    return this.automaticTimingDivision();
  }

  private editSelectedKeyboardNote(key: string): void {
    const target = keyboardNoteForKey(key);
    if (this._input.enabled && this._selectedNotes.length === 0) this.selectInputFocus(false);
    const active = this._selectedNotes[this._selectedNotes.length - 1];
    if (!target || !active) {
      this.setStatus("请先选择要修改的音符");
      return;
    }
    const source = active.source;
    const before = this.view.state.doc.sliceString(source.from, source.to);
    if (before === target.letter) return;
    const spec = inputDegreeSpec(this.painter.score, {
      partIndex: source.partIndex, measureIndex: source.chord.measure.index, offset: source.chord.position,
    }, target.degree, target.octave);
    this._pendingSelectionAnchors = this._selectedNotes.map((selection) => ({
      ...this.selectionAnchor(selection),
      ...(selection === active ? { pitch: spec.pitch } : {}),
    }));
    if (this._input.enabled) this._input.focusPitch = spec.pitch;
    // Replace only this tone's source span. Duration, neighboring chord tones,
    // voice markers and tuplets remain in their original notation.
    this.view.dispatch({ changes: { from: source.from, to: source.to, insert: target.letter } });
    const ok = this.reload(this.getText());
    this.setStatus(ok ? `已将当前音改为 ${target.letter}` : "修改后的谱面暂时无法解析");
  }

  private replaceDocumentText(next: string, anchors?: SelectionAnchor[]): boolean {
    const before = this.getText();
    if (before === next) {
      // Score-input edits can change the live model while serializing back to
      // the exact same compact TXT spelling. Reparse anyway so metrical
      // normalization can combine e.g. quarter + tied dotted-quarter + bar
      // sustain into one whole note. Skipping this reload left the temporary
      // edit segmentation visible even though the source already described
      // the canonical full value.
      if (anchors) this._pendingSelectionAnchors = anchors;
      clearTimeout(this.debounceTimer);
      return this.reload(before);
    }
    let prefix = 0;
    const shared = Math.min(before.length, next.length);
    while (prefix < shared && before[prefix] === next[prefix]) prefix++;
    let suffix = 0;
    while (suffix < shared - prefix
      && before[before.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
    this.view.dispatch({
      changes: {
        from: prefix,
        to: before.length - suffix,
        insert: next.slice(prefix, next.length - suffix),
      },
    });
    if (anchors) this._pendingSelectionAnchors = anchors;
    clearTimeout(this.debounceTimer);
    return this.reload(this.getText());
  }

  /**
   * TXT timing edits are overlays on the compact source timeline. Convert the
   * unedited source first, then carry the overlay into JPW metadata; serializing
   * the already shifted render score would otherwise bake and reapply it.
   */
  private slashDocumentAsJpw(): string {
    if (!this.slashOptions) return scoreToJpwabc(this.painter.score);
    const edits = normalizeNoteTimingEdits(this.slashOptions.noteTimingEdits ?? []);
    if (edits.length === 0) return scoreToJpwabc(this.painter.score);
    const baseOptions: SlashScoreOptions = {
      ...this.slashOptions,
      symbolDurations: { ...this.slashOptions.symbolDurations },
      noteTimingEdits: [],
    };
    const baseText = stripSlashScoreOptions(this.getText());
    const baseScore = parseSlashScore(baseText, baseOptions).score;
    return upsertOptionalTitleField(
      scoreToJpwabc(baseScore),
      "NoteTimingEdits",
      serializeJpwNoteTimingEdits(edits),
    );
  }

  private slashTimelineSerializationGrid(): {
    division: SlashDurationDivision;
    symbol: string;
    options: SlashScoreOptions;
    compactSubdivision: boolean;
    } | null;
  private slashTimelineSerializationGrid(
    baseOptions: SlashScoreOptions | null,
  ): {
    division: SlashDurationDivision;
    symbol: string;
    options: SlashScoreOptions;
    compactSubdivision: boolean;
    } | null;
  private slashTimelineSerializationGrid(
    baseOptions: SlashScoreOptions | null = this.slashOptions,
  ): {
    division: SlashDurationDivision;
    symbol: string;
    options: SlashScoreOptions;
    compactSubdivision: boolean;
    } | null {
    if (!baseOptions) return null;
    const configuredMappings = Object.entries(baseOptions.symbolDurations);
    const activeMappings = baseOptions.multiDurationSymbols === false
      ? configuredMappings.slice(0, 1)
      : configuredMappings;
    const mapped = activeMappings
      .filter((entry): entry is [string, SlashDurationDivision] =>
        entry[0].length === 1 && [4, 8, 16, 32, 64].includes(entry[1]));
    const finest = Math.max(
      baseOptions.noteDivision ?? 4,
      4,
      ...mapped.map(([, division]) => division),
      baseOptions.spaceDivision ?? 4,
    );
    const division = ([4, 8, 16, 32, 64] as SlashDurationDivision[])
      .find((candidate) => candidate >= Math.min(64, finest)) ?? 64;
    const existing = mapped.find(([, value]) => value === division)?.[0]
      ?? (baseOptions.spaceDivision === division ? " " : undefined);
    const symbol = existing
      ?? [".", "=", "_", "*", "~", ":", "·"].find((candidate) =>
        baseOptions.symbolDurations[candidate] === undefined)
      ?? ".";
    const compactSubdivision = false;
    const options: SlashScoreOptions = {
      ...baseOptions,
      symbolDurations: { ...baseOptions.symbolDurations },
      noteTimingEdits: [],
    };
    if (!existing) {
      options.symbolDurations[symbol] = division;
      if (mapped.length > 0) options.multiDurationSymbols = true;
    }
    return { division, symbol, options, compactSubdivision };
  }

  private serializeCurrentScoreDocument(preserveInputDraftRests = true): string | null {
    if (this.documentFormat === "jpw") {
      const withoutOverlay = upsertOptionalTitleField(
        this.getText(),
        "NoteTimingEdits",
        "",
      );
      const generated = scoreToJpwabc(this.painter.score);
      let next = replaceJpwNotationSections(
        withoutOverlay,
        generated,
      );
      for (const field of [
        "KeyAndMeters",
        "Tempo",
        "TempoUnit",
        "Arpeggios",
        "KeyChanges",
        "Annotations",
        "TempoMarks",
      ] as const) {
        next = upsertOptionalTitleField(next, field, readJpwTitleField(generated, field));
      }
      return next;
    } else {
      const serialization = this.slashTimelineSerializationGrid();
      if (!serialization) return null;
      const openingMeasure = this.painter.score.parts[0]?.measures[0];
      if (openingMeasure) {
        serialization.options.beats = openingMeasure.time.beats;
        serialization.options.beatType = openingMeasure.time.beatType as 2 | 4 | 8 | 16;
      }
      const voiceCount = Math.max(1, Math.min(
        MAX_SLASH_VOICES,
        serialization.options.voiceCount,
      ));
      const generated = scoreToSlashScore(
        this.painter.score,
        this.documentFormat,
        serialization.division,
        serialization.symbol,
        {
          braceMode: serialization.options.braceMode,
          bracketMode: serialization.options.bracketMode ?? "triplet",
          barMode: serialization.options.barMode ?? "none",
          angleMode: serialization.options.angleMode ?? "grace",
          parenMode: serialization.options.parenMode ?? "chord",
          ordering: serialization.options.ordering ?? "pitch-asc",
          compactSubdivision: serialization.compactSubdivision,
          durationNotation: serialization.options,
          preserveExplicitRestMeasures: preserveInputDraftRests
            && this._input.enabled && this._input.cursor
            ? [...new Set([
              this._input.cursor.measureIndex,
              Math.max(0, ...this.painter.score.parts.map((part) => part.measures.length)) - 1,
            ])]
            : undefined,
        },
        voiceCount,
      );
      this.slashOptions = serialization.options;
      const rewritten = rewriteSlashDurationDirectives(
        replaceSlashScoreLines(this.getText(), generated, this.documentFormat),
        serialization.options,
      );
      // Keep the in-memory TXT options in sync with score-level objects that
      // were just edited from the input context menu.  Previously the text
      // metadata was updated by embedSlashScoreOptionsFromScore(), but the
      // next reload still received the old `this.slashOptions` object.  Since
      // TXT parsing deliberately treats dialog options as authoritative, the
      // newly-added tempo/key/meter marks were then ignored by the preview
      // until the document was reopened.
      const scoreAnnotations = notationAnnotationsFromScore(this.painter.score);
      serialization.options.annotations = scoreAnnotations;
      serialization.options.tempoMarks = this.painter.score.tempoMarks.map((mark) => ({
        measure: mark.measure,
        offset: mark.offset.toFloat(),
        kind: mark.kind,
        bpm: mark.bpm,
      }));
      serialization.options.keyChanges = this.painter.score.keyMarks.map((mark) => ({
        measure: mark.measure,
        offset: mark.offset.toFloat(),
        fifths: mark.fifths,
      }));
      return embedSlashScoreOptionsFromScore(
        preserveUnchangedSlashGroups(
          this.getText(), rewritten, this.documentFormat, serialization.options,
        ),
        this.painter.score,
        serialization.options,
      );
    }
  }

  private setStatus(s: string): void {
    if (!this.statusEl) this.statusEl = document.getElementById("status");
    if (this.statusEl) this.statusEl.textContent = s;
    this.notifyWorkspaceChange();
  }

  private notifyWorkspaceChange(): void {
    if (this._workspaceChangeQueued) return;
    this._workspaceChangeQueued = true;
    queueMicrotask(() => {
      this._workspaceChangeQueued = false;
      document.dispatchEvent(new CustomEvent("editor:workspace-change"));
    });
  }

  workspaceSummary(): {
    documentName: string; format: string; position: string; pages: number; page: number;
    inputEnabled: boolean; waitingForInput: boolean; diagnostics: number;
  } {
    const selection = this._selectedNotes[this._selectedNotes.length - 1];
    const cursor = this._input.cursor;
    const part = cursor?.partIndex ?? selection?.source.partIndex;
    const measure = cursor?.measureIndex ?? selection?.visualNote.chord.measure.index;
    const offset = cursor?.offset ?? selection?.visualNote.chord.position;
    const name = this.filePath ?? this._browserSaveHandle?.name ?? this._browserOpenHandle?.name
      ?? this._suggestedSavePath;
    return {
      documentName: name?.split(/[\\/]/).pop() || this.painter.score.title.split("\n")[0].trim() || "未命名乐谱",
      format: this.documentFormat === "jpw" ? "JPW 简谱" : this.documentFormat === "keyboard" ? "键盘谱" : "数字谱",
      position: part !== undefined && measure !== undefined && offset
        ? `${this.getPartLabel(part)} · 第 ${measure + 1} 小节 · ${this.formatBeatPosition(offset.plus(new Fraction(1)))} 拍`
        : this._input.enabled ? "等待选择起点" : "选择音符以查看位置",
      pages: this.pageEls.length, page: this.pageIndex + 1,
      inputEnabled: this._input.enabled, waitingForInput: this._input.enabled && cursor === null,
      diagnostics: this._slashTimingDiagnostics.length,
    };
  }

  setCodePaneCollapsed(collapsed: boolean): void {
    if (this.codePaneCollapsed === collapsed) return;
    this.codePaneCollapsed = collapsed;
    this.syncCodePaneLayout();
    this.saveSettings();
  }

  formatBeatPosition(value: Fraction): string {
    return this.beatPositionFormat === "decimal"
      ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4, useGrouping: false }).format(value.toFloat())
      : value.toString();
  }

  setBeatPositionFormat(value: "fraction" | "decimal"): void {
    this.beatPositionFormat = value;
    this.saveSettings();
    this.notifyWorkspaceChange();
  }

  setStartupPreferences(showText: boolean, restoreLastFile: boolean): void {
    this.showTextOnStartup = showText;
    this.restoreLastFileOnStartup = restoreLastFile;
    this.saveSettings();
  }

  setBarlineConnectionsEnabled(enabled: boolean): void {
    this.setEngravingStyle({ ...this.engravingStyle, connectBarlines: enabled });
  }

  setCodePaneWidth(px: number): void {
    if (!Number.isFinite(px)) return;
    this.codePaneWidth = Math.max(220, Math.min(720, Math.round(px)));
    this.syncCodePaneLayout();
    this.saveSettings();
  }

  undoEdit(): void { if (!this.undoScoreDelete()) undo(this.view); }
  redoEdit(): void { redo(this.view); }

  private syncScoreSettingsButton(): void {
    const button = document.getElementById("btn-score-settings");
    if (!button) return;
    const available = this.mode === "jp"
      && this.documentFormat !== "jpw"
      && this.slashOptions !== null;
    button.classList.toggle("format-unavailable", !available);
    button.setAttribute("aria-disabled", String(!available));
    button.title = available
      ? "修改当前键盘谱或数字谱的识别、节奏、拍号、速度与标题设置"
      : this.documentFormat === "jpw"
        ? "JPW 格式不支持乐谱设置"
        : "当前视图不支持乐谱设置";
  }

  private showToolbarNotice(message: string): void {
    this.setStatus(message);
    document.getElementById("toolbar-notice")?.remove();
    const notice = document.createElement("div");
    notice.id = "toolbar-notice";
    notice.className = "toolbar-notice";
    notice.setAttribute("role", "status");
    notice.textContent = message;
    const button = document.getElementById("btn-score-settings");
    const rect = button?.getBoundingClientRect();
    notice.style.left = `${Math.max(12, rect?.left ?? 12)}px`;
    notice.style.top = `${(rect?.bottom ?? 36) + 8}px`;
    document.body.append(notice);
    requestAnimationFrame(() => notice.classList.add("visible"));
    window.setTimeout(() => {
      notice.classList.remove("visible");
      window.setTimeout(() => notice.remove(), 160);
    }, 2400);
  }

  getSlashVoiceCount(): number {
    return this.documentFormat === "jpw" ? 1 : this.slashOptions?.voiceCount ?? 1;
  }

  async showScoreSettings(): Promise<void> {
    if (this.mode !== "jp" || this.documentFormat === "jpw" || !this.slashOptions) {
      this.syncScoreSettingsButton();
      this.showToolbarNotice(this.documentFormat === "jpw"
        ? "JPW 格式不支持乐谱设置"
        : "当前视图不支持乐谱设置");
      return;
    }
    let current: SlashScoreOptions = {
      ...this.slashOptions,
      symbolDurations: { ...this.slashOptions.symbolDurations },
      tempoMarks: this.slashOptions.tempoMarks?.map((mark) => ({ ...mark })) ?? [],
      keyChanges: this.slashOptions.keyChanges?.map((change) => ({ ...change })) ?? [],
    };
    const next = await showSlashScoreSettingsDialog(this.getText(), current);
    if (!next) {
      this.setStatus("未更改当前乐谱设置");
      return;
    }
    let text = this.getText();
    let voiceMessage = "";
    if (next.voiceCount !== current.voiceCount) {
      // Overlay chord ordinals are local to each voice. Materialize edits
      // before merging rows, where those ordinals can collide or reorder.
      if ((current.noteTimingEdits?.length ?? 0) > 0) {
        const serialized = this.serializeCurrentScoreDocument();
        if (serialized === null || !this.slashOptions) {
          this.setStatus("当前时值无法写回文本谱，未更改声部数量");
          return;
        }
        text = serialized;
        current = { ...this.slashOptions, symbolDurations: { ...this.slashOptions.symbolDurations } };
      }
      const migration = migrateSlashVoiceCount(text, current, next.voiceCount);
      text = migration.text;
      next.annotations = migration.options.annotations;
      next.noteTimingEdits = migration.options.noteTimingEdits;
      voiceMessage = migration.mergedVoices.length > 0
        ? `；V${migration.mergedVoices.join("、V")} 已并入默认 V${next.voiceCount}`
        : `；声部数量已从 ${migration.from} 调整为 ${migration.to}`;
    }
    const delimiterSignature = (options: SlashScoreOptions): string => JSON.stringify({
      brace: options.braceMode,
      bracket: options.bracketMode ?? "triplet",
      bar: options.barMode ?? "none",
      angle: options.angleMode ?? "grace",
      paren: options.parenMode ?? "chord",
    });
    let delimiterTextMigrated = false;
    if (delimiterSignature(current) !== delimiterSignature(next)) {
      const migration = migrateSlashDelimiters(text, current, next);
      if (migration.changed > 0) {
        const beforeText = this.getText();
        const beforeScore = this.painter.score;
        const replace = await showConfirmDialog({ title: "同步替换括号",
          message: `检测到 ${migration.changed} 处括号可按原功能迁移到新的括号。也可以只修改设置、保留原文括号。`,
          confirmText: "同步替换", cancelText: "保留原文" });
        if (this.getText() !== beforeText || this.painter.score !== beforeScore) return;
        if (replace) {
          text = migration.text;
          delimiterTextMigrated = true;
        }
      }
    }
    const rhythmSignature = (options: SlashScoreOptions): string => JSON.stringify({
      symbols: options.symbolDurations,
      multiple: options.multiDurationSymbols ?? false,
      space: options.spaceDivision,
      note: options.noteDivision,
      wholeMeasureGroups: options.wholeMeasureGroups ?? false,
      empty: options.emptyGroupsAsRests ?? false,
      rests: options.showExplicitRests ?? true,
      ordering: options.ordering ?? "pitch-asc",
    });
    let appliedOptions: SlashScoreOptions = {
      ...next,
      symbolDurations: { ...next.symbolDurations },
      noteTimingEdits: [],
    };
    if (next.kind === current.kind
      && rhythmSignature(current) !== rhythmSignature(next)) {
      try {
        const sourceOptions: SlashScoreOptions = {
          ...current,
          voiceCount: next.voiceCount,
          symbolDurations: { ...current.symbolDurations },
          ...(delimiterTextMigrated ? {
            braceMode: next.braceMode,
            bracketMode: next.bracketMode,
            barMode: next.barMode,
            angleMode: next.angleMode,
            parenMode: next.parenMode,
          } : {}),
        };
        const score = parseSlashScore(text, sourceOptions).score;
        const serialization = this.slashTimelineSerializationGrid(appliedOptions);
        if (!serialization) throw new Error("当前时值设置无法生成文本谱");
        const generated = scoreToSlashScore(
          score,
          next.kind,
          serialization.division,
          serialization.symbol,
          {
            braceMode: serialization.options.braceMode,
            bracketMode: serialization.options.bracketMode ?? "triplet",
            barMode: serialization.options.barMode ?? "none",
            angleMode: serialization.options.angleMode ?? "grace",
            parenMode: serialization.options.parenMode ?? "chord",
            ordering: serialization.options.ordering ?? "pitch-asc",
            compactSubdivision: serialization.compactSubdivision,
            durationNotation: serialization.options,
          },
          next.voiceCount,
        );
        text = replaceSlashScoreLines(text, generated, next.kind);
        appliedOptions = serialization.options;
        text = rewriteSlashDurationDirectives(text, appliedOptions);
      } catch (reason) {
        this.setStatus(
          reason instanceof Error
            ? `时值符号无法应用：${reason.message}`
            : "时值符号无法应用到当前乐谱",
        );
        return;
      }
    }
    this.stopPlayback();
    this.documentFormat = appliedOptions.kind;
    this.slashOptions = {
      ...appliedOptions,
      symbolDurations: { ...appliedOptions.symbolDurations },
      tempoMarks: appliedOptions.tempoMarks?.map((mark) => ({ ...mark })) ?? [],
      keyChanges: appliedOptions.keyChanges?.map((change) => ({ ...change })) ?? [],
    };
    this.setText(embedSlashScoreOptions(text, this.slashOptions));
    this.setStatus(
      `乐谱设置已应用：当前按${next.kind === "keyboard" ? "键盘谱" : "数字谱"}识别，${next.beats}/${next.beatType}，${next.tempoBpm} BPM${voiceMessage}`,
    );
  }

  setSlashVoiceSettings(
    requestedCount: number,
    colors: readonly string[],
    scoreColoring: boolean,
    showMarkers: boolean,
    textColoring = this.textVoiceColoring,
  ): void {
    this.slashVoiceColors = this.slashVoiceColors.map((fallback, index) => {
      const value = colors[index];
      return value === "" || (typeof value === "string" && /^#[\da-f]{6}$/i.test(value))
        ? value
        : fallback;
    });
    this.textVoiceColoring = textColoring;
    this.scoreVoiceColoring = scoreColoring;
    this.showInvisibleVoiceMarkers = showMarkers;
    this.saveSettings();
    if (this.documentFormat === "jpw" || !this.slashOptions) {
      this.reload(this.getText());
      return;
    }
    const nextCount = Math.max(1, Math.min(MAX_SLASH_VOICES, Math.round(requestedCount)));
    if (nextCount === this.slashOptions.voiceCount) {
      this.reload(this.getText());
      this.setStatus(`已更新 V1–V${nextCount} 的显示设置`);
      return;
    }
    let text = this.getText();
    if ((this.slashOptions.noteTimingEdits?.length ?? 0) > 0) {
      const serialized = this.serializeCurrentScoreDocument();
      if (serialized === null) {
        this.setStatus("当前时值无法写回文本谱，未更改声部数量");
        return;
      }
      text = serialized;
    }
    const migration = migrateSlashVoiceCount(text, this.slashOptions, nextCount);
    this.slashOptions = migration.options;
    this.setText(migration.text);
    this.setStatus(migration.mergedVoices.length > 0
      ? `声部数量已改为 ${nextCount}；V${migration.mergedVoices.join("、V")} 已并入默认 V${nextCount}`
      : `声部数量已从 ${migration.from} 增加到 ${migration.to}；原默认声部内容已移到新的默认 V${nextCount}`);
  }

  async changeDocumentFormat(target: "jpw" | SlashScoreKind): Promise<void> {
    if (target === this.documentFormat || this.mode !== "jp") return;
    this.stopPlayback();
    if (target !== "jpw"
      && this.documentFormat !== "jpw"
      && this.slashOptions
      && hasSlashScoreLines(this.getText(), target)) {
      // Keyboard/number recognition is a non-destructive view switch for a
      // mixed TXT document. Keep both representations exactly where the user
      // wrote them; only the persisted parser choice and live preview change.
      const options: SlashScoreOptions = {
        ...this.slashOptions,
        kind: target,
        symbolDurations: { ...this.slashOptions.symbolDurations },
      };
      this.documentFormat = target;
      this.slashOptions = options;
      this.setText(embedSlashScoreOptions(this.getText(), options));
      this.setStatus(
        `当前按${target === "keyboard" ? "键盘谱" : "数字谱"}识别；另一种谱文仍保留在 TXT 中，但不参与排版、播放和休止计算`,
      );
      return;
    }
    const score = this.painter.score;
    if (target === "jpw") {
      const text = this.slashDocumentAsJpw();
      this.documentFormat = "jpw";
      this.slashOptions = null;
      this.setText(text);
    } else {
      const current = this.slashOptions;
      const voiceCount = current?.voiceCount
        ?? Math.max(1, Math.min(MAX_SLASH_VOICES, score.parts.length));
      const division = current
        ? Math.max(
          4,
          current.noteDivision ?? 4,
          current.spaceDivision ?? 4,
          ...Object.values(current.symbolDurations),
        ) as 4 | 8 | 16 | 32 | 64
        : 16;
      const raw = scoreToSlashScore(
        score,
        target,
        division,
        ".",
        current
          ? {
            braceMode: current.braceMode,
            bracketMode: current.bracketMode ?? "triplet",
            barMode: current.barMode ?? "none",
            angleMode: current.angleMode ?? "grace",
            parenMode: current.parenMode ?? "chord",
            ordering: current.ordering ?? "pitch-asc",
            showExplicitRests: current.showExplicitRests ?? true,
            durationNotation: current,
          }
          : undefined,
        voiceCount,
      );
      const analysis = analyzeSlashScore(raw);
      const options: SlashScoreOptions = {
        ...(current ?? defaultSlashScoreOptions(target, analysis)),
        kind: target,
        voiceCount,
        instrumentName: current?.instrumentName?.trim()
          || score.instrumentName.trim()
          || score.parts[0]?.instrumentName.trim()
          || "钢琴",
        title: score.title,
        subtitle: score.subtitle,
        composer: score.composer,
        arranger: score.arranger,
        lyricist: score.lyricist,
        tempoBpm: score.tempoBpm,
        tempoBeatUnit: score.tempoBeatUnit,
        // Carry score-level annotations across a JPW → TXT view switch.  The
        // old conversion only copied the opening metadata, so key changes,
        // local tempo marks/ramps, and meter changes created in JPW vanished
        // as soon as the document became a keyboard/number score.
        tempoMarks: score.tempoMarks.map((mark) => ({
          measure: mark.measure,
          offset: mark.offset.toFloat(),
          kind: mark.kind,
          bpm: mark.bpm,
        })),
        keyChanges: score.keyMarks.map((mark) => ({
          measure: mark.measure,
          offset: mark.offset.toFloat(),
          fifths: mark.fifths,
        })),
        annotations: notationAnnotationsFromScore(score),
      };
      this.documentFormat = target;
      this.slashOptions = options;
      // Use the score-aware writer so the readable directives are placed next
      // to their affected measures while the machine directives remain in the
      // metadata header.  This also keeps the live preview and a later reopen
      // identical.
      this.setText(embedSlashScoreOptionsFromScore(raw, score, options));
    }
    this.filePath = null;
    this._browserSaveHandle = null;
    this._hasSavedCurrent = false;
    this.setStatus(`当前谱子已转换为${target === "jpw" ? " JPW 简谱" : target === "keyboard" ? "键盘谱 TXT" : "数字谱 TXT"}`);
  }

  exportTextDocument(
    target: "jpw" | SlashScoreKind,
    includeVoiceMarkers = true,
    includeMetadata = true,
  ): { bytes: Uint8Array; name: string; mime: string } {
    const title = this.painter.score.title.split("\n")[0].trim() || "未命名";
    if (target === "jpw") {
      const text = this.documentFormat === "jpw"
        ? this.getText()
        : this.slashDocumentAsJpw();
      return {
        bytes: encodeJpwabc(text),
        name: `${title}.jpwabc`,
        mime: "application/octet-stream",
      };
    }
    let text: string;
    let options: SlashScoreOptions;
    if (this.documentFormat === target && this.slashOptions) {
      options = { ...this.slashOptions, symbolDurations: { ...this.slashOptions.symbolDurations } };
      text = embedSlashScoreOptions(this.getText(), options);
    } else {
      const voiceCount = includeVoiceMarkers
        ? Math.max(1, Math.min(MAX_SLASH_VOICES, this.painter.score.parts.length))
        : 1;
      text = scoreToSlashScore(this.painter.score, target, 16, ".", undefined, voiceCount);
      options = defaultSlashScoreOptions(target, analyzeSlashScore(text));
      options = {
        ...options,
        voiceCount,
        instrumentName: this.painter.score.instrumentName
          || this.painter.score.parts[0]?.instrumentName
          || "钢琴",
        title: this.painter.score.title,
        subtitle: this.painter.score.subtitle,
        composer: this.painter.score.composer,
        arranger: this.painter.score.arranger,
        lyricist: this.painter.score.lyricist,
        tempoBpm: this.painter.score.tempoBpm,
        tempoBeatUnit: this.painter.score.tempoBeatUnit,
      };
      text = embedSlashScoreOptions(text, options);
    }
    if (!includeVoiceMarkers) text = stripSlashVoiceMarkers(text, options);
    if (!includeMetadata) text = stripSlashScoreOptions(text);
    return {
      bytes: new TextEncoder().encode(text),
      name: `${title}-${target === "keyboard" ? "键盘谱" : "数字谱"}.txt`,
      mime: "text/plain;charset=utf-8",
    };
  }

  // ---------------- paging ----------------
  goToPage(i: number): void {
    if (this.pageEls.length === 0) return;
    const np = Math.max(0, Math.min(i, this.pageEls.length - 1));
    this.pageIndex = np;
    document.dispatchEvent(new CustomEvent("editor:page-navigation", { detail: { page: np } }));
    this.notifyWorkspaceChange();
    this.pageEls[np]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // ---------------- playback ----------------
  setPlayBtn(el: HTMLButtonElement): void {
    this._playBtnEl = el;
    this.onPlayState(this._player?.state ?? "stopped");
  }
  setStopBtn(el: HTMLButtonElement): void {
    this._stopBtnEl = el;
    el.disabled = true;
  }

  private player(): ScorePlayer {
    if (!this._player) {
      this._player = new ScorePlayer(
        (chord, pass) => this.onPlayChord(chord, pass),
        (state) => this.onPlayState(state),
      );
    }
    return this._player;
  }

  private onPlayChord(chords: import("../score/score").Chord[] | null, pass: number): void {
    const page = this.painter.highlightChords(chords, pass);
    if (chords && chords.length > 0 && page !== null) {
      if (page !== this.pageIndex) this.pageIndex = page;
      // keep the sounding note visible (no-op when already in view)
      this.painter.chordGroupEl(chords[0], pass)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  private onPlayState(state: PlayState): void {
    const busy = state === "playing" || state === "loading";
    if (this._playBtnEl) {
      this._playBtnEl.disabled = false;
      this._playBtnEl.classList.toggle("playback-active", busy);
      this._playBtnEl.setAttribute("aria-pressed", String(busy));
      this._playBtnEl.setAttribute("aria-label", busy ? "停止播放" : "播放");
      this._playBtnEl.title = busy ? "停止播放" : "从当前选择开始播放";
      const icon = this._playBtnEl.querySelector("span:first-child");
      if (icon) icon.textContent = busy ? "■" : "▶";
      const label = this._playBtnEl.querySelector("span:last-child");
      const text = state === "loading" ? "加载中" : busy ? "停止" : "播放";
      if (label) label.textContent = text;
      else this._playBtnEl.textContent = text;
    }
    if (this._stopBtnEl) this._stopBtnEl.disabled = state === "stopped";
  }

  /** Number of parts in the current score (for the mixer UI). */
  get partCount(): number {
    return this.painter.score.parts.length;
  }
  getPartLabel(i: number): string {
    const part = this.painter.score.parts[i];
    if (part?.instrumentName) {
      const voices = this.painter.score.parts.filter((item) => item.instrumentName === part.instrumentName).length;
      return voices > 1 ? `${part.instrumentName} · 声部 ${part.voiceIndex}` : part.instrumentName;
    }
    const hand = part?.hand;
    if (hand === "right") return "右手";
    if (hand === "left") return "左手";
    return `声部 ${i + 1}`;
  }
  getPartVolume(i: number): number {
    const v = this.partVolumes[i];
    return v === undefined ? 1 : v;
  }
  setPartVolume(i: number, v: number): void {
    this.partVolumes[i] = Math.max(0, Math.min(1, v));
  }

  /** Rescan SF2 files. Called only during startup and by the manual refresh button. */
  async refreshSoundfonts(): Promise<void> {
    this.soundfontCatalog = await readSoundfontCatalog();
    const playable = this.soundfontCatalog.filter((entry) => entry.instruments.length > 0);
    if (!playable.some((entry) => entry.id === this.selectedSoundfontId)) {
      this.selectedSoundfontId = playable[0]?.id ?? "";
    }
    if (playable.length === 0) this.playbackSoundSource = "default";
    this.saveSettings();
  }

  async openSoundfontFolder(): Promise<void> {
    await openSoundfontDirectory();
  }

  getPlaybackInstrumentGroups(): PlaybackInstrumentGroup[] {
    const score = this.painter.score;
    if (score.parts.length === 0) return [];
    if (!score.ensemble) {
      const label =
        score.instrumentName.trim() ||
        score.parts[0]?.instrumentName.trim() ||
        (score.piano ? "钢琴" : "默认乐器");
      return [{
        key: `score:${label}`,
        label,
        parts: score.parts.map((_, index) => index),
      }];
    }

    const groups = new Map<string, PlaybackInstrumentGroup>();
    score.parts.forEach((part, index) => {
      const label = part.instrumentName.trim() || `乐器 ${index + 1}`;
      const key = `ensemble:${label}`;
      const current = groups.get(key);
      if (current) current.parts.push(index);
      else groups.set(key, { key, label, parts: [index] });
    });
    return [...groups.values()];
  }

  getSoundfontInstrument(groupKey: string, soundfontId = this.selectedSoundfontId): string {
    const entry = this.soundfontCatalog.find((item) => item.id === soundfontId);
    const saved = this.soundfontInstrumentByGroup[groupKey];
    return saved && entry?.instruments.includes(saved) ? saved : (entry?.instruments[0] ?? "");
  }

  setPlaybackSoundSettings(
    source: PlaybackSoundSource,
    soundfontId: string,
    instrumentByGroup: Record<string, string>,
  ): void {
    const selected = this.soundfontCatalog.find((entry) =>
      entry.id === soundfontId && entry.instruments.length > 0);
    this.playbackSoundSource = source === "sf2" && selected ? "sf2" : "default";
    this.selectedSoundfontId = selected?.id ?? this.selectedSoundfontId;
    this.soundfontInstrumentByGroup = { ...instrumentByGroup };
    this.saveSettings();
    this.stopPlayback();
  }

  private sf2PlaybackOptions(): Sf2PlaybackOptions | undefined {
    if (this.playbackSoundSource !== "sf2") return undefined;
    const soundfont = this.soundfontCatalog.find((entry) =>
      entry.id === this.selectedSoundfontId && entry.instruments.length > 0);
    if (!soundfont) return undefined;
    const first = soundfont.instruments[0];
    const instrumentByPart = this.painter.score.parts.map(() => first);
    for (const group of this.getPlaybackInstrumentGroups()) {
      const instrument = this.getSoundfontInstrument(group.key, soundfont.id);
      for (const part of group.parts) instrumentByPart[part] = instrument || first;
    }
    return { bytes: soundfont.bytes, instrumentByPart };
  }

  async playScore(): Promise<void> {
    if (this.mode !== "jp") return; // playback is jianpu-mode only
    const selected = this._selectedNotes[this._selectedNotes.length - 1];
    const input = this._input.enabled ? this.inputFocus() : null;
    const start = input
      ? { chord: input.chord, pass: 0 }
      : selected
        ? { chord: selected.source.chord, pass: selected.verse }
        : undefined;
    await this.player().play(
      this.painter.score,
      { partVolumes: this.partVolumes },
      start,
      this.sf2PlaybackOptions(),
    );
  }

  stopPlayback(): void {
    this._player?.stop();
  }

  private async editScoreHeader(target: HeaderTarget): Promise<void> {
    if (this.mode !== "jp") return;
    if ((this.debounceTimer !== undefined || this.previewDirty) && !this.reload(this.getText())) return;
    const score = this.painter.score;
    const sourceText = this.getText();
    const change = await showScoreHeaderEditor(score, target);
    if (!change || this.painter.score !== score || this.getText() !== sourceText) return;
    let next = sourceText;
    if (this.documentFormat !== "jpw" && this.slashOptions) {
      const options = { ...this.slashOptions, ...change.values };
      if (change.kind === "rhythm") {
        next = replaceOpeningMeterDirective(next, this._sourceNotes[0]?.from ?? next.length,
          change.values.beats, change.values.beatType);
        options.keyChanges = options.keyChanges?.map(mark => mark.measure === 0 && mark.offset === 0
          ? { ...mark, fifths: change.values.fifths } : mark);
        options.tempoMarks = options.tempoMarks?.map(mark => mark.measure === 0 && mark.offset === 0 && mark.kind === "tempo"
          ? { ...mark, bpm: change.values.tempoBpm } : mark);
      }
      this.slashOptions = options;
      next = embedSlashScoreOptions(next, options);
    } else if (change.kind === "credits") {
      for (const [field, value] of Object.entries(change.values)) {
        const jpwField = field === "subtitle" ? "SubTitle" : field[0].toUpperCase() + field.slice(1);
        next = upsertTitleField(next, jpwField, value);
      }
      next = upsertOptionalTitleField(next, "WordsByAndMusicBy", "");
    } else {
      const value = change.values;
      const rawKey = MusicCommon.keys[value.fifths + 7];
      const key = /^[#b]/.test(rawKey) ? rawKey.slice(1) + rawKey[0] : rawKey;
      next = upsertTitleField(next, "KeyAndMeters", `1=${key},${value.beats}/${value.beatType}`);
      next = upsertTitleField(next, "Tempo", String(value.tempoBpm));
      next = upsertTitleField(next, "TempoUnit", value.tempoBeatUnit);
      const openingTempo = score.tempoMarks.find(mark => mark.measure === 0 && mark.offset.equals(0) && mark.kind === "tempo");
      if (openingTempo) {
        openingTempo.bpm = value.tempoBpm;
        openingTempo.beatUnit = value.tempoBeatUnit;
        next = upsertTitleField(next, "TempoMarks", readJpwTitleField(scoreToJpwabc(score), "TempoMarks"));
      }
    }
    if (!this.replaceDocumentText(next)) return;
    document.dispatchEvent(new CustomEvent("editor:header-changed", {
      detail: { ...change.values, ...(change.kind === "rhythm" && this.slashOptions ? {
        tempoMarks: this.slashOptions.tempoMarks, keyChanges: this.slashOptions.keyChanges,
      } : {}) },
    }));
    this.setStatus(change.kind === "credits" ? "已修改标题与署名" : "已修改谱头调号、拍号与速度");
  }

  togglePlayback(): void {
    if (this._player?.state === "playing" || this._player?.state === "loading") this.stopPlayback();
    else void this.playScore();
  }

  nextPage(): void {
    this.goToPage(this.pageIndex + 1);
  }
  prevPage(): void {
    this.goToPage(this.pageIndex - 1);
  }

  // ---------------- file I/O ----------------
  /** Decode/import supported score formats. MIDI pauses for an analyze/quantize dialog. */
  async importBytes(
    bytes: Uint8Array,
    name: string,
    settings?: { skipMusicXmlDialog?: boolean },
  ): Promise<void> {
    const originalName = name;
    let importKind = classifyImportFile(name);
    if (importKind === "midi") {
      try {
        const parsed = parseMidi(bytes);
        if (!parsed.title) parsed.title = fileStem(name);
        const analysis = analyzeMidi(parsed);
        const options = await showMidiImportDialog(parsed, analysis, name);
        if (!options) {
          this.setStatus("已取消 MIDI 导入");
          return;
        }
        const { score, summary } = midiToScore(parsed, options);
        this._clearRecognition();
        this.mixedXmlText = null;
        this._mixedPainter = null;
        if (this._mixedBtnEl) this._mixedBtnEl.disabled = true;
        if (this.mode === "mixed") {
          this.mode = "jp";
          this._setMixedLayout(false);
          if (this._mixedBtnEl) this._mixedBtnEl.textContent = "混排";
        }
        this.filePath = null;
        const outputFormat = options.outputFormat ?? "jpw";
        if (outputFormat === "jpw") {
          const { text, meta } = scoreToJpwabcWithMeta(score);
          this._lastImportMeta = meta;
          this._applyImportedJp(text);
          this._disablePhrase();
        } else {
          const slashBraceMode = options.slashBraceMode ?? "arpeggio";
          const slashBracketMode = options.slashBracketMode ?? "triplet";
          const slashBarMode = options.slashBarMode ?? "none";
          const slashAngleMode = options.slashAngleMode ?? "grace";
          const slashParenMode = options.slashParenMode ?? "chord";
          const slashVoiceCount = Math.max(
            1,
            Math.min(MAX_SLASH_VOICES, score.parts.length),
          );
          const slashText = scoreToSlashScore(
            score,
            outputFormat,
            Math.min(64, options.quantize) as SlashDurationDivision,
            ".",
            {
            sourceMidi: parsed,
            braceMode: slashBraceMode,
            bracketMode: slashBracketMode,
            barMode: slashBarMode,
            angleMode: slashAngleMode,
            parenMode: slashParenMode,
            ordering: options.slashOrdering ?? "pitch-asc",
            showExplicitRests: options.showExplicitRests ?? true,
            },
            slashVoiceCount,
          );
          const slashAnalysis = analyzeSlashScore(slashText);
          const slashOptions = defaultSlashScoreOptions(outputFormat, slashAnalysis);
          slashOptions.keyboardKeyLabels = outputFormat === "keyboard"
            && (options.keyboardKeyLabels ?? false);
          slashOptions.keyboardTieAsZero = options.keyboardTieAsZero ?? false;
          slashOptions.keyboardHideTieLabels = options.keyboardHideTieLabels ?? false;
          slashOptions.showExplicitRests = options.showExplicitRests ?? true;
          slashOptions.voiceCount = slashVoiceCount;
          slashOptions.instrumentName = score.instrumentName.trim()
            || score.parts[0]?.instrumentName.trim()
            || "钢琴";
          slashOptions.title = score.title;
          slashOptions.subtitle = score.subtitle;
          slashOptions.composer = score.composer;
          slashOptions.arranger = score.arranger;
          slashOptions.lyricist = score.lyricist;
          slashOptions.tempoBpm = score.tempoBpm;
          slashOptions.tempoBeatUnit = score.tempoBeatUnit;
          slashOptions.fifths = options.fifths;
          slashOptions.beats = options.beats;
          slashOptions.beatType = options.beatType;
          slashOptions.braceMode = slashBraceMode;
          slashOptions.bracketMode = slashBracketMode;
          slashOptions.barMode = slashBarMode;
          slashOptions.angleMode = slashAngleMode;
          slashOptions.parenMode = slashParenMode;
          slashOptions.ordering = options.slashOrdering ?? "pitch-asc";
          slashOptions.tempoMarks = score.tempoMarks.map((mark) => ({
            measure: mark.measure,
            offset: mark.offset.toFloat(),
            kind: mark.kind,
            bpm: mark.bpm,
          }));
          this._applyImportedSlash(slashText, slashOptions, score);
        }
        const details = [
          summary.layoutMode === "ensemble"
            ? `总谱 ${summary.instrumentCount} 种乐器 / ${summary.partCount} 个声部`
            : summary.handCount === 2 ? "双手" : "单手",
          `${summary.quantize}分量化`,
          `三连音${summary.tripletGroups}组`,
          `倚音${summary.graceGroups}组`,
          `琶音${summary.arpeggioGroups}组`,
          `疑似倚音${summary.suspectedGraceCount}个`,
          `化简重叠${summary.simplifiedOverlaps}处`,
          `忽略事件${summary.ignoredEvents}个`,
          outputFormat === "jpw"
            ? "JPW 简谱"
            : `${score.parts.length > 1 ? `${Math.min(MAX_SLASH_VOICES, score.parts.length)}声部完整排版` : "单谱表"}${outputFormat === "keyboard" ? "键盘谱" : "数字谱"}`,
        ];
        if (summary.warnings.length) details.push(summary.warnings.join("；"));
        this.setStatus(`MIDI 导入完成：${details.join("，")}`);
      } catch (e) {
        this._reportImportFailure("MIDI", e);
      }
      return;
    }
    if (importKind === "slash") {
      const source = decodeJpwabc(bytes);
      try {
        const analysis = analyzeSlashScore(source);
        if (analysis.measureCount === 0) throw new Error("没有找到可导入的小节；有效谱行需要包含至少两个 /");
        const hintedKind = slashKindHint(name);
        const options = await showSlashScoreImportDialog(source, analysis, name, hintedKind ? { kind: hintedKind } : undefined);
        if (!options) {
          this.setStatus("已取消斜杠谱导入");
          return;
        }
        this._clearRecognition();
        this._prepareEditableJpMode();
        this._applyImportedSlash(source, options);
        const summary = parseSlashScore(source, options).summary;
        const details = [
          summary.kind === "keyboard" ? "键盘谱" : "数字谱",
          `${summary.measures}小节`,
          options.voiceCount === 1
            ? "单谱表"
            : `${options.voiceCount}声部（${options.instrumentName?.trim() || "钢琴"}）`,
          `保留注释${summary.comments}行`,
          `忽略标签${summary.ignoredTags}个`,
        ];
        if (summary.warnings.length) details.push(summary.warnings.join("；"));
        this.setStatus(`斜杠谱导入完成：${details.join("，")}`);
      } catch (e) {
        this._reportImportFailure("斜杠谱", e);
      }
      return;
    }
    // ABC 记谱：先用移植版 abc2xml 转成 MusicXML，再复用现有 MusicXML 导入路径。
    if (importKind === "abc") {
      const abcText = new TextDecoder(
        bytes[0] === 0xff || bytes[0] === 0xfe ? "utf-16" : "utf-8",
      ).decode(bytes);
      try {
        const xml = abcToMusicXml(abcText);
        bytes = new TextEncoder().encode(xml);
        name = replaceFileExtension(name, ".musicxml");
        importKind = "musicxml";
      } catch (e) {
        this._reportImportFailure("ABC", e);
        return;
      }
    }
    if (importKind === "musicxml") {
      try {
        const xml = new TextDecoder(
          bytes[0] === 0xff || bytes[0] === 0xfe ? "utf-16" : "utf-8",
        ).decode(bytes);
        const score = loadMusicXml(xml);
        const soundingNotes = score.parts.flatMap((part) =>
          part.measures.flatMap((measure) =>
            measure.entries.flatMap((entry) =>
              entry instanceof Chord
                ? [...entry.notes, ...entry.graceNotes].filter(
                  (note) => !note.rest && !note.softDeleted,
                )
                : [])));
        if (soundingNotes.length === 0) {
          throw new Error("文件中没有可导入的有效音符");
        }
        const defaultMixed = !isPianoMusicXml(xml) && isMultiPartXml(xml);
        const options = settings?.skipMusicXmlDialog
          ? this._defaultMusicXmlImportOptions(score, defaultMixed)
          : await showMusicXmlImportDialog(score, originalName, defaultMixed);
        if (!options) {
          this.setStatus("已取消 MusicXML 导入");
          return;
        }
        this._applyMusicXmlImportOptions(score, options);
        const { text, meta } = scoreToJpwabcWithMeta(score);
        let preparedSlash: {
          text: string;
          options: SlashScoreOptions;
        } | null = null;
        if (options.outputFormat === "keyboard" || options.outputFormat === "number") {
          const voiceCount = Math.max(
            1,
            Math.min(MAX_SLASH_VOICES, score.parts.length),
          );
          const slashText = scoreToSlashScore(
            score,
            options.outputFormat,
            Math.min(64, options.textDivision) as SlashDurationDivision,
            ".",
            {
              braceMode: options.slashBraceMode,
              bracketMode: options.slashBracketMode,
              barMode: options.slashBarMode,
              angleMode: options.slashAngleMode,
              parenMode: options.slashParenMode,
              ordering: options.slashOrdering,
              showExplicitRests: options.showExplicitRests,
            },
            voiceCount,
          );
          const slashAnalysis = analyzeSlashScore(slashText);
          const slashOptions = defaultSlashScoreOptions(
            options.outputFormat,
            slashAnalysis,
          );
          slashOptions.keyboardKeyLabels =
            options.outputFormat === "keyboard" && options.keyboardKeyLabels;
          slashOptions.keyboardTieAsZero = options.keyboardTieAsZero;
          slashOptions.keyboardHideTieLabels = options.keyboardHideTieLabels;
          slashOptions.showExplicitRests = options.showExplicitRests;
          slashOptions.voiceCount = voiceCount;
          slashOptions.instrumentName = score.instrumentName.trim()
            || score.parts[0]?.instrumentName.trim()
            || "钢琴";
          slashOptions.title = score.title;
          slashOptions.subtitle = score.subtitle;
          slashOptions.composer = score.composer;
          slashOptions.arranger = score.arranger;
          slashOptions.lyricist = score.lyricist;
          slashOptions.tempoBpm = score.tempoBpm;
          slashOptions.tempoBeatUnit = score.tempoBeatUnit;
          slashOptions.fifths = options.fifths;
          slashOptions.beats = options.beats;
          slashOptions.beatType = options.beatType;
          slashOptions.braceMode = options.slashBraceMode;
          slashOptions.bracketMode = options.slashBracketMode;
          slashOptions.barMode = options.slashBarMode;
          slashOptions.angleMode = options.slashAngleMode;
          slashOptions.parenMode = options.slashParenMode;
          slashOptions.ordering = options.slashOrdering;
          slashOptions.tempoMarks = score.tempoMarks.map((mark) => ({
            measure: mark.measure,
            offset: mark.offset.toFloat(),
            kind: mark.kind,
            bpm: mark.bpm,
          }));
          slashOptions.keyChanges = score.keyMarks.length > 0
            ? score.keyMarks.map((mark) => ({
              measure: mark.measure,
              offset: mark.offset.toFloat(),
              fifths: mark.fifths,
            }))
            : score.parts[0]?.measures
              .filter((measure) => measure.index > 0 && measure.keyChange)
              .map((measure) => ({
                measure: measure.index,
                offset: 0,
                fifths: measure.key.fifths,
              })) ?? [];
          slashOptions.annotations = notationAnnotationsFromScore(score);
          preparedSlash = { text: slashText, options: slashOptions };
        }
        let preparedMixedPainter: MixedPainter | null = null;
        if (options.outputFormat === "mixed") {
          preparedMixedPainter = new MixedPainter();
          preparedMixedPainter.hideBarNumber = this.mixedHideBarNumber;
          await preparedMixedPainter.load(xml);
          for (let page = 0; page < preparedMixedPainter.pageCount; page++) {
            preparedMixedPainter.renderPage(page);
          }
        }
        this._clearRecognition();
        this._prepareEditableJpMode();
        this.filePath = null;
        this._browserSaveHandle = null;
        this._hasSavedCurrent = false;

        this._lastImportMeta = meta;
        this._applyImportedJp(text);
        this.mixedXmlText = xml;
        this._mixedPainter = preparedMixedPainter;
        if (this._mixedBtnEl) this._mixedBtnEl.disabled = false;

        if (options.outputFormat === "mixed") {
          this.mode = "mixed";
          this._setMixedLayout(true);
          if (this._mixedBtnEl) this._mixedBtnEl.textContent = "简谱";
          await this._renderMixedPages(true);
        } else if (preparedSlash) {
          this._applyImportedSlash(preparedSlash.text, preparedSlash.options, score);
        }
        const outputName = options.outputFormat === "mixed"
          ? "MusicXML 五线谱混排"
          : options.outputFormat === "jpw"
            ? "JPW 简谱"
            : options.outputFormat === "keyboard" ? "键盘谱" : "数字谱";
        this.setStatus(
          `MusicXML 导入完成：${score.parts.length} 个声部，`
          + `${score.parts[0]?.measures.length ?? 0} 小节，${outputName}`,
        );
      } catch (e) {
        this._reportImportFailure("MusicXML", e);
      }
      return;
    } else {
      try {
        const text = decodeJpwabc(bytes);
        if (isJpwFile(name) && !JpwFile.fromString(text)) {
          throw new Error("JPW 文件缺少有效的 .Title 或 .Voice 段落");
        }
        this._clearRecognition();
        this.mixedXmlText = null;
        this._mixedPainter = null;
        if (this._mixedBtnEl) this._mixedBtnEl.disabled = true;
        this._disablePhrase();
        if (this.mode === "mixed") {
          this.mode = "jp";
          this._setMixedLayout(false);
          if (this._mixedBtnEl) this._mixedBtnEl.textContent = "混排";
        }
        this.documentFormat = "jpw";
        this.slashOptions = null;
        this.setText(text);
        this.resetDocumentUndo();
      } catch (e) {
        this._reportImportFailure("JPW", e);
      }
    }
  }

  private _defaultMusicXmlImportOptions(
    score: Score,
    defaultMixed: boolean,
  ): MusicXmlImportOptions {
    const firstMeasure = score.parts[0]?.measures[0];
    return {
      outputFormat: defaultMixed ? "mixed" : "jpw",
      textDivision: 16,
      title: score.title,
      subtitle: score.subtitle,
      composer: score.composer,
      arranger: score.arranger,
      lyricist: score.lyricist,
      instrumentNames: score.parts.map((part, index) =>
        part.instrumentName.trim()
        || score.instrumentName.trim()
        || (score.piano ? "钢琴" : `乐器 ${index + 1}`)),
      fifths: firstMeasure?.key.fifths ?? 0,
      beats: firstMeasure?.time.beats ?? 4,
      beatType: firstMeasure?.time.beatType ?? 4,
      tempoBpm: score.tempoBpm,
      tempoBeatUnit: score.tempoBeatUnit,
      showExplicitRests: true,
      keyboardKeyLabels: false,
      keyboardTieAsZero: false,
      keyboardHideTieLabels: false,
      slashBraceMode: "arpeggio",
      slashBracketMode: "triplet",
      slashBarMode: "none",
      slashAngleMode: "grace",
      slashParenMode: "chord",
      slashOrdering: "pitch-asc",
    };
  }

  private _applyMusicXmlImportOptions(
    score: Score,
    options: MusicXmlImportOptions,
  ): void {
    score.title = options.title;
    score.subtitle = options.subtitle;
    score.composer = options.composer;
    score.arranger = options.arranger;
    score.lyricist = options.lyricist;
    for (const [type, value] of [
      ["composer", options.composer],
      ["arranger", options.arranger],
      ["lyricist", options.lyricist],
    ] as const) {
      if (value) score.creator.set(type, value);
      else score.creator.delete(type);
    }
    score.tempoBpm = options.tempoBpm;
    score.tempoBeatUnit = options.tempoBeatUnit;
    const openingTempo = score.tempoMarks.find((mark) =>
      mark.kind === "tempo" && mark.measure === 0 && mark.offset.equals(0));
    if (openingTempo) {
      openingTempo.bpm = options.tempoBpm;
      openingTempo.beatUnit = options.tempoBeatUnit;
    }

    const voiceByInstrument = new Map<string, number>();
    score.parts.forEach((part, index) => {
      const instrument = options.instrumentNames[index]?.trim()
        || (score.piano ? "钢琴" : `乐器 ${index + 1}`);
      part.instrumentName = instrument;
      const voice = (voiceByInstrument.get(instrument) ?? 0) + 1;
      voiceByInstrument.set(instrument, voice);
      part.voiceIndex = voice;
    });
    if (score.piano) {
      const instrument = options.instrumentNames[0]?.trim() || "钢琴";
      score.instrumentName = instrument;
      for (const part of score.parts) part.instrumentName = instrument;
    } else {
      score.ensemble = score.parts.length > 1;
    }

    for (const part of score.parts) {
      let updateKey = true;
      let updateTime = true;
      part.measures.forEach((measure, index) => {
        if (index > 0 && measure.keyChange) updateKey = false;
        if (index > 0 && measure.timeChange) updateTime = false;
        if (updateKey) measure.key.fifths = options.fifths;
        if (updateTime) {
          measure.time.beats = options.beats;
          measure.time.beatType = options.beatType;
        }
      });
    }
  }

  private _reportImportFailure(kind: string, error: unknown): void {
    console.error(`${kind} 导入失败`, error);
    const message = error instanceof Error ? error.message : String(error);
    this.setStatus(`导入失败：${message}`);
    showImportFailureDialog(kind, error);
  }

  /** 导入 MusicXML/OMR 得到的默认（原始排版）文本：缓存以便乐句排版无损切回，并启用切换按钮。 */
  private _applyImportedJp(text: string): void {
    this.documentFormat = "jpw";
    this.slashOptions = null;
    this._origLayoutText = text;
    this._phraseOn = false;
    if (this._phraseBtnEl) { this._phraseBtnEl.disabled = false; this._phraseBtnEl.textContent = "乐句排版"; }
    this.setText(text);
    this.resetDocumentUndo();
  }

  private _applyImportedSlash(text: string, options: SlashScoreOptions, score?: Score): void {
    this.documentFormat = options.kind;
    this.slashOptions = { ...options, symbolDurations: { ...options.symbolDurations } };
    this._disablePhrase();
    this._origLayoutText = null;
    this._lastImportMeta = null;
    this.setText(score
      ? embedSlashScoreOptionsFromScore(text, score, options)
      : embedSlashScoreOptions(text, options));
    this.resetDocumentUndo();
  }

  private _prepareEditableJpMode(): void {
    this.mixedXmlText = null;
    this._mixedPainter = null;
    if (this._mixedBtnEl) this._mixedBtnEl.disabled = true;
    if (this.mode === "mixed") {
      this.mode = "jp";
      this._setMixedLayout(false);
      if (this._mixedBtnEl) this._mixedBtnEl.textContent = "混排";
    } else if (this.mode === "recognize") {
      this.mode = "jp";
      this._setRecognizeLayout(false);
      if (this._recognizeBtnEl) this._recognizeBtnEl.textContent = "识别";
    }
  }

  private _disablePhrase(): void {
    this._origLayoutText = null;
    this._phraseOn = false;
    if (this._phraseBtnEl) { this._phraseBtnEl.disabled = true; this._phraseBtnEl.textContent = "乐句排版"; }
  }

  /** Register the #btn-phrase element so App can enable/disable it. */
  setPhraseBtn(el: HTMLButtonElement): void {
    this._phraseBtnEl = el;
  }

  /** 在「原始排版」与「乐句排版」间切换（保留原始排版文本，无损切回）。 */
  togglePhrase(): void {
    if (!this.mixedXmlText || !this._origLayoutText) return;
    // 乐句排版要看的是排版结果 → 先退出识别/混排叠加视图，回到简谱模式，否则 reload 直接返回不重排。
    if (this.mode === "recognize") {
      this.mode = "jp";
      this._setRecognizeLayout(false);
      if (this._recognizeBtnEl) this._recognizeBtnEl.textContent = "识别";
    } else if (this.mode === "mixed") {
      this.mode = "jp";
      this._setMixedLayout(false);
      if (this._mixedBtnEl) this._mixedBtnEl.textContent = "混排";
    }
    if (this._phraseOn) {
      this._phraseOn = false;
      if (this._phraseBtnEl) this._phraseBtnEl.textContent = "乐句排版";
      this.setText(this._origLayoutText);
    } else {
      try {
        const score = loadMusicXml(this.mixedXmlText);
        this.setText(scoreToJpwabc(score, { phrase: true }));
        this._phraseOn = true;
        if (this._phraseBtnEl) this._phraseBtnEl.textContent = "原始排版";
      } catch (e) {
        console.error("phrase relayout failed", e);
      }
    }
  }

  /** Register the #btn-mixed element so App can enable/disable it. */
  setMixedBtn(el: HTMLButtonElement): void {
    this._mixedBtnEl = el;
  }

  /** Register the #btn-recognize element so App can enable/disable it. */
  setRecognizeBtn(el: HTMLButtonElement): void {
    this._recognizeBtnEl = el;
  }

  /** Register the #sel-recog-view dropdown (识别视图切换)。 */
  setRecogViewSelect(el: HTMLSelectElement): void {
    this._recogViewSelectEl = el;
    el.value = this.recogView;
  }

  /** 切换识别视图（原位叠加/附近浮窗/仅原图）。识别模式下即时重渲。 */
  setRecogView(v: RecogView): void {
    this.recogView = v;
    if (this._recogViewSelectEl) this._recogViewSelectEl.value = v;
    if (this.mode === "recognize") this._renderRecognizePages();
  }

  /** 在「简谱模式」与「识别模式」（二值图+半透明识别叠加）之间切换。需先有 OMR 识别结果。 */
  async toggleRecognize(): Promise<void> {
    if (!this._recogScore || !this._recogBin) return;
    this.stopPlayback();
    if (this.mode === "recognize") {
      this.mode = "jp";
      this._setRecognizeLayout(false);
      if (this._recognizeBtnEl) this._recognizeBtnEl.textContent = "识别";
      this.reload(this.getText());
    } else {
      // 从混排切入识别：先退混排布局
      if (this.mode === "mixed") this._setMixedLayout(false);
      this.mode = "recognize";
      this._setRecognizeLayout(true);
      if (this._recognizeBtnEl) this._recognizeBtnEl.textContent = "排版";
      this._renderRecognizePages();
    }
  }

  /** 识别模式布局钩子：打 body.recognize 类 + 显示/隐藏视图下拉。 */
  private _setRecognizeLayout(on: boolean): void {
    document.getElementById("body")?.classList.toggle("recognize", on);
    if (this._recogViewSelectEl) this._recogViewSelectEl.hidden = !on;
    if (!on) this._hideRecogPopup();
  }

  /** 渲染识别视图：二值图 + 识别结果 → 一张 SVG，沿用 score-page-wrap + zoom 容器。 */
  private _renderRecognizePages(): void {
    this.scorePane.replaceChildren();
    this.pageEls = [];
    this.deselect(false);
    this._recogPopupEl = null;
    if (!this._recogBin || !this._recogScore) return;
    const bin = this._recogBin;
    const svg = renderRecognitionSvg(bin, this._recogScore, this.recogView);
    const wrap = document.createElement("div");
    wrap.className = "score-page-wrap";
    wrap.style.position = "relative"; // 浮窗绝对定位相对此容器
    wrap.style.aspectRatio = `${bin.w} / ${bin.h}`;
    wrap.style.width = "calc(min(960px, 100%) * var(--score-zoom, 1))";
    wrap.appendChild(svg);
    this._wireRecognizeInteraction(svg, wrap);
    this.scorePane.appendChild(wrap);
    this.pageEls.push(wrap);
    this.pageIndex = 0;
  }

  /** 识别 SVG 交互：点选命中对象→选中对应 jpwabc 代码；悬停高亮；floating 视图弹行/页眉浮窗。 */
  private _wireRecognizeInteraction(svg: SVGSVGElement, wrap: HTMLDivElement): void {
    const hitOf = (t: EventTarget | null): SVGRectElement | null =>
      (t instanceof Element ? t.closest(".omr-hits rect") : null) as SVGRectElement | null;

    let hovered: SVGRectElement | null = null;
    const setHover = (r: SVGRectElement | null): void => {
      if (hovered === r) return;
      hovered?.classList.remove("omr-hover");
      hovered = r;
      hovered?.classList.add("omr-hover");
    };

    svg.addEventListener("click", (e) => {
      const r = hitOf(e.target);
      if (!r) return;
      const range = this._rangeOfHit(r);
      if (range) this._selectCode(range);
      svg.querySelectorAll(".omr-hits rect.selected").forEach((x) => x.classList.remove("selected"));
      r.classList.add("selected");
    });

    svg.addEventListener("mousemove", (e) => {
      const r = hitOf(e.target);
      setHover(r);
      if (this.recogView === "floating") this._updateFloatingPopup(r, wrap);
    });
    svg.addEventListener("mouseleave", () => {
      setHover(null);
      if (this.recogView === "floating") this._hideRecogPopup();
    });
  }

  /** 命中 rect → jpwabc 代码区间（据 data-kind 查 _recogMeta）。 */
  private _rangeOfHit(r: SVGRectElement): { from: number; to: number } | null {
    const meta = this._recogMeta;
    if (!meta) return null;
    const kind = r.getAttribute("data-kind");
    if (kind === "note") {
      const i = Number(r.getAttribute("data-i"));
      return meta.noteRanges[i] ?? null;
    }
    if (kind === "lyric") {
      const i = Number(r.getAttribute("data-i"));
      const v = Number(r.getAttribute("data-verse"));
      return meta.lyricRanges[i]?.get(v) ?? null;
    }
    if (kind === "title") return meta.titleRange ?? null;
    if (kind === "author") {
      const text = (r.getAttribute("data-text") ?? "").trim();
      const a = meta.authorRanges.find((x) => x.text.trim() === text)
        ?? meta.authorRanges.find((x) => text.includes(x.text.trim()) || x.text.trim().includes(text));
      return a?.range ?? null;
    }
    return null;
  }

  /** 选中并滚动到编辑器里的代码区间。 */
  private _selectCode(range: { from: number; to: number }): void {
    const len = this.view.state.doc.length;
    const from = Math.max(0, Math.min(range.from, len));
    const to = Math.max(from, Math.min(range.to, len));
    this.view.dispatch({
      selection: EditorSelection.single(from, to),
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    this.view.focus();
  }

  /** floating 视图：悬停对象所在行→在该行相邻固定位置弹整行浮窗；页眉命中→弹整块页眉。 */
  private _updateFloatingPopup(r: SVGRectElement | null, wrap: HTMLDivElement): void {
    if (!this._recogBin || !this._recogScore) { this._hideRecogPopup(); return; }
    // 停在音符/歌词间隙（无命中）时保持当前浮窗，不隐藏——否则同 system 内移动光标会反复隐现闪烁。
    // 真正离开谱面由 svg 的 mouseleave 负责隐藏。
    if (!r) return;
    const bin = this._recogBin, score = this._recogScore;
    const kind = r.getAttribute("data-kind");
    let key: string;
    let r2: { svg: SVGSVGElement; srcTop: number; srcBottom: number };
    if (kind === "title" || kind === "author") {
      key = "header";
      r2 = renderHeaderPopup(bin, score);
    } else {
      const i = Number(r.getAttribute("data-i"));
      const ri = this._rowIndexOfFlat(i);
      key = "row" + ri;
      r2 = renderRowPopup(bin, score, ri);
    }
    // 同一行/页眉不重复重建。
    if (this._recogPopupEl?.dataset.key !== key) {
      this._showRecogPopup(r2.svg, key, wrap, bin, r2.srcTop, r2.srcBottom);
    }
  }

  private _showRecogPopup(content: SVGSVGElement, key: string, wrap: HTMLDivElement, bin: Binary, srcTop: number, srcBottom: number): void {
    let el = this._recogPopupEl;
    if (!el) {
      el = document.createElement("div");
      el.className = "omr-popup";
      wrap.appendChild(el);
      this._recogPopupEl = el;
    }
    el.dataset.key = key;
    el.replaceChildren(content);
    el.style.display = "block";
    // 定位到**当前 system 之下**（srcBottom 已含本行歌词带底，故浮窗不盖当前行歌词）；
    // 靠近底部则翻到当前行之上。浮窗整幅宽、列与源图对齐，便于逐音对比。
    const topPct = (srcBottom / bin.h) * 100;
    const botPct = (srcTop / bin.h) * 100;
    if (topPct < 82) {
      el.style.top = `${topPct}%`;
      el.style.bottom = "auto";
    } else {
      el.style.bottom = `${100 - botPct}%`;
      el.style.top = "auto";
    }
  }

  private _hideRecogPopup(): void {
    if (this._recogPopupEl) { this._recogPopupEl.style.display = "none"; delete this._recogPopupEl.dataset.key; }
  }

  /** flatten 音符下标 → 所属行下标。 */
  private _rowIndexOfFlat(i: number): number {
    if (!this._recogScore) return 0;
    let acc = 0;
    for (let ri = 0; ri < this._recogScore.rows.length; ri++) {
      const n = this._recogScore.rows[ri].nums.length;
      if (i < acc + n) return ri;
      acc += n;
    }
    return this._recogScore.rows.length - 1;
  }

  /** 清掉本次 OMR 的识别叠加产物并禁用识别按钮；若正处识别模式则退回简谱模式。 */
  private _clearRecognition(): void {
    this._recogBin = null;
    this._recogScore = null;
    this._recogMeta = null;
    this._hideRecogPopup();
    if (this._recognizeBtnEl) {
      this._recognizeBtnEl.disabled = true;
      this._recognizeBtnEl.textContent = "识别";
    }
    if (this.mode === "recognize") {
      this.mode = "jp";
      this._setRecognizeLayout(false);
    }
  }

  /** Toggle between JP mode and Mixed (五线谱+简谱) mode. */
  async toggleMixed(): Promise<void> {
    if (!this.mixedXmlText) return;
    this.stopPlayback();
    if (this.mode === "jp") {
      this.mode = "mixed";
      this._setMixedLayout(true);
      if (this._mixedBtnEl) this._mixedBtnEl.textContent = "简谱";
      await this._renderMixedPages();
    } else {
      this.mode = "jp";
      this._setMixedLayout(false);
      if (this._mixedBtnEl) this._mixedBtnEl.textContent = "混排";
      this.reload(this.getText());
    }
  }

  /** 设置混排是否隐藏小节号，持久化；当前处于混排模式时立即重排。 */
  async setMixedHideBarNumber(on: boolean): Promise<void> {
    if (this.mixedHideBarNumber === on) return;
    this.mixedHideBarNumber = on;
    this.saveSettings();
    if (this.mode === "mixed") await this._renderMixedPages();
  }

  /** Mixed mode: editor read-only + hide the code pane entirely. */
  private _setMixedLayout(on: boolean): void {
    this.view.dispatch({
      effects: this._readOnlyCompartment.reconfigure(EditorState.readOnly.of(on)),
    });
    document.getElementById("body")?.classList.toggle("mixed", on);
  }

  private async _renderMixedPages(alreadyLoaded = false): Promise<void> {
    if (!this._mixedPainter) {
      this._mixedPainter = new MixedPainter();
    }
    this._mixedPainter.hideBarNumber = this.mixedHideBarNumber;
    if (this.mixedXmlText && !alreadyLoaded) {
      await this._mixedPainter.load(this.mixedXmlText);
    }
    // Portrait paper sized from the MusicXML page dimensions.
    const aspect = `${this._mixedPainter.pageWidthTenths} / ${this._mixedPainter.pageHeightTenths}`;
    this.scorePane.replaceChildren();
    this.pageEls = [];
    for (let i = 0; i < this._mixedPainter.pageCount; i++) {
      const svg = this._mixedPainter.renderPage(i);
      svg.style.width = "100%";
      svg.style.display = "block";
      const wrap = document.createElement("div");
      wrap.className = "score-page-wrap";
      wrap.style.aspectRatio = aspect;
      wrap.style.width = "calc(min(620px, 100%) * var(--score-zoom, 1))";
      wrap.appendChild(svg);
      this.scorePane.appendChild(wrap);
      this.pageEls.push(wrap);
    }
    this.pageIndex = 0;
  }

  /** 记住上次打开/保存的文件路径（仅 Tauri：浏览器路径不可复读）。 */
  rememberLastFile(path: string): void {
    try {
      localStorage.setItem(App.LAST_FILE_KEY, path);
    } catch {
      // storage unavailable — ignore
    }
  }

  private clearLastFile(): void {
    try {
      localStorage.removeItem(App.LAST_FILE_KEY);
    } catch {
      // ignore
    }
  }

  /** Start a new document/file session; the first Save still asks for a target. */
  setImportedFileSource(path: string | null, handle: BrowserFileHandle | null = null): void {
    this.filePath = null;
    this._suggestedSavePath = path;
    this._browserOpenHandle = handle;
    this._browserSaveHandle = null;
    this._hasSavedCurrent = false;
  }

  /** 启动时尝试复读上次打开的文件（仅 Tauri）。返回 true 表示已加载，false 则保持示例文本。 */
  async tryRestoreLastFile(): Promise<boolean> {
    if (!isTauriRuntime()) return false;
    let path: string | null;
    try {
      path = localStorage.getItem(App.LAST_FILE_KEY);
    } catch {
      return false;
    }
    if (!path) return false;
    try {
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const bytes = await readFile(path);
      await this.importBytes(bytes, path);
      this.setImportedFileSource(path);
      return true;
    } catch {
      // 文件已被移动/删除/不可读 — 忘掉它，回退到示例
      this.clearLastFile();
      return false;
    }
  }

  async openFile(): Promise<void> {
    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const sel = await open({
        multiple: false,
        filters: [{ name: SCORE_OPEN_DESCRIPTION, extensions: [...SCORE_OPEN_TAURI_EXTENSIONS] }],
      });
      if (typeof sel !== "string") return;
      const bytes = await readFile(sel);
      await this.importBytes(bytes, sel);
      this.setImportedFileSource(sel);
      if (!isMidiFile(sel)) this.rememberLastFile(sel);
    } else {
      const picker = (window as unknown as {
        showOpenFilePicker?: (options: unknown) => Promise<BrowserFileHandle[]>;
      }).showOpenFilePicker;
      if (picker) {
        try {
          const [handle] = await picker({
            multiple: false,
            types: [{
              description: SCORE_OPEN_DESCRIPTION,
              accept: SCORE_OPEN_PICKER_ACCEPT,
            }],
          });
          if (!handle) return;
          const file = await handle.getFile();
          const buf = new Uint8Array(await file.arrayBuffer());
          await this.importBytes(buf, file.name);
          this.setImportedFileSource(file.name, handle);
          return;
        } catch (reason) {
          if (reason instanceof DOMException && reason.name === "AbortError") return;
          console.warn("File System Access open failed; falling back to input", reason);
        }
      }
      const input = document.createElement("input");
      input.type = "file";
      input.accept = SCORE_OPEN_INPUT_ACCEPT;
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const buf = new Uint8Array(await file.arrayBuffer());
        await this.importBytes(buf, file.name);
        this.setImportedFileSource(file.name);
      };
      input.click();
    }
  }

  async createDocument(kind: "jpw" | SlashScoreKind): Promise<void> {
    this.stopPlayback();
    if (kind === "jpw") {
      this._clearRecognition();
      this._prepareEditableJpMode();
      this.setImportedFileSource(null);
      this.clearLastFile();
      this.documentFormat = "jpw";
      this.slashOptions = null;
      this._disablePhrase();
      this.setText([
        ".Title",
        "Title = {未命名}",
        "SubTitle = {}",
        "Composer = {}",
        "Arranger = {}",
        "Lyricist = {}",
        "KeyAndMeters = {1=C,4/4}",
        "Tempo = {90}",
        ".Voice",
        "0--- |]$(true,0,0,true)",
        ".Words",
        "",
      ].join("\n"));
      this.resetDocumentUndo();
      this.setStatus("已创建 JPW 简谱");
      return;
    }
    const text = slashScoreTemplate(kind);
    const analysis = analyzeSlashScore(text);
    const options = await showSlashScoreImportDialog(text, analysis, `新建${kind === "keyboard" ? "键盘谱" : "数字谱"}.txt`, { kind });
    if (!options) {
      this.setStatus("已取消创建");
      return;
    }
    this._clearRecognition();
    this._prepareEditableJpMode();
    this.setImportedFileSource(null);
    this.clearLastFile();
    this._applyImportedSlash(text, options);
    this.setStatus(`已创建${kind === "keyboard" ? "键盘谱" : "数字谱"}：每行一小节，实时生成单谱表预览`);
  }

  // ---------------- OMR：从图片识别简谱 ----------------
  /** 已取得图片字节后的识别核心（供拖拽识别复用）。
   *  musicpp 本地路额外保留二值图+识别结果并自动进入识别模式叠加核对；gemini 路只导入排版。 */
  async recognizeBytes(method: OmrMethod, picked: { bytes: Uint8Array; mime?: string; path?: string | null }): Promise<void> {
    if (method === "gemini" && !agyAvailable()) {
      this.setStatus("Gemini 识别需要桌面版（Antigravity CLI / agy），浏览器内不可用");
      return;
    }
    const label = method === "gemini" ? "Gemini" : "musicpp";
    this.setStatus(`识别中（${label}）…可能需要几十秒`);
    try {
      const t0 = performance.now();
      if (method === "musicpp") {
        const { musicxml, bin, score } = await recognizeMusicppDetailed(picked.bytes, picked.mime);
        await this.importBytes(
          new TextEncoder().encode(musicxml),
          "omr.musicxml",
          { skipMusicXmlDialog: true },
        ); // 先导入（会清旧识别）
        this._recogBin = bin; // 再设本次识别产物
        this._recogScore = score;
        this._recogMeta = this._lastImportMeta; // 接管导入时序列化产出的代码区间映射
        if (this._recognizeBtnEl) this._recognizeBtnEl.disabled = false;
        if (this.mode !== "recognize") await this.toggleRecognize(); // 自动进识别模式叠加
        this.setStatus(`识别完成（${label}，${((performance.now() - t0) / 1000).toFixed(1)}s）`);
      } else {
        const { musicxml, ms } = await recognizeImage(method, picked);
        await this.importBytes(
          new TextEncoder().encode(musicxml),
          "omr.musicxml",
          { skipMusicXmlDialog: true },
        );
        this.setStatus(`识别完成（${label}，${(ms / 1000).toFixed(1)}s）`);
      }
    } catch (e) {
      console.error("OMR failed", e);
      this.setStatus("识别失败：" + (e instanceof Error ? e.message : String(e)));
    }
  }

  async saveFile(): Promise<void> {
    try {
      if (this._hasSavedCurrent) {
        if (isTauriRuntime() && this.filePath) {
          await this.writeTo(this.filePath);
          this.setStatus(`保存成功：${this.filePath}`);
          return;
        }
        if (!isTauriRuntime() && this._browserSaveHandle) {
          await this.writeBrowserHandle(this._browserSaveHandle);
          this.setStatus(`保存成功：${this._browserSaveHandle.name}`);
          return;
        }
      }
      await this.chooseSaveDestination(true);
    } catch (reason) {
      console.error("save failed", reason);
      this.setStatus("保存出错：" + (reason instanceof Error ? reason.message : String(reason)));
    }
  }

  async saveFileAs(): Promise<void> {
    try {
      await this.chooseSaveDestination(false);
    } catch (reason) {
      console.error("save as failed", reason);
      this.setStatus("另存为出错：" + (reason instanceof Error ? reason.message : String(reason)));
    }
  }

  private saveDocumentName(): string {
    const { extension } = editableDocumentFileInfo(this.documentFormat);
    return (this.painter.score.title.split("\n")[0].trim() || "未命名") + extension;
  }

  private suggestedDesktopSavePath(name: string): string {
    const source = this._suggestedSavePath;
    if (!source) return name;
    const slash = Math.max(source.lastIndexOf("/"), source.lastIndexOf("\\"));
    return slash >= 0 ? source.slice(0, slash + 1) + name : name;
  }

  private documentBytes(): Uint8Array {
    return this.documentFormat === "jpw"
      ? encodeJpwabc(this.getText())
      : new TextEncoder().encode(this.getText());
  }

  private async chooseSaveDestination(establishTarget: boolean): Promise<void> {
    const name = this.saveDocumentName();
    const fileInfo = editableDocumentFileInfo(this.documentFormat);
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({
        defaultPath: this.suggestedDesktopSavePath(name),
        filters: [{
          name: fileInfo.description,
          extensions: [fileInfo.extension.slice(1)],
        }],
      });
      if (!dest) return;
      await this.writeTo(dest);
      if (establishTarget) {
        this.filePath = dest;
        this._hasSavedCurrent = true;
        this.rememberLastFile(dest);
      }
      this.setStatus(`${establishTarget ? "保存" : "另存为"}成功：${dest}`);
      return;
    }
    const picker = (window as unknown as {
      showSaveFilePicker?: (options: unknown) => Promise<BrowserFileHandle>;
    }).showSaveFilePicker;
    if (picker) {
      let handle: BrowserFileHandle;
      const pickerOptions = {
        suggestedName: name,
        startIn: this._browserOpenHandle ?? undefined,
        types: [{
          description: fileInfo.description,
          accept: { [fileInfo.mime]: [fileInfo.extension] },
        }],
      };
      try {
        handle = await picker(pickerOptions);
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        // Some File System Access implementations accept a directory handle for
        // startIn but reject a file handle. Preserve the imported-folder hint where
        // supported, then retry once without it for compatibility.
        if (!this._browserOpenHandle) throw reason;
        try {
          const { startIn: _startIn, ...fallbackOptions } = pickerOptions;
          void _startIn;
          handle = await picker(fallbackOptions);
        } catch (fallbackReason) {
          if (fallbackReason instanceof DOMException && fallbackReason.name === "AbortError") return;
          throw fallbackReason;
        }
      }
      await this.writeBrowserHandle(handle);
      if (establishTarget) {
        this._browserSaveHandle = handle;
        this._hasSavedCurrent = true;
      }
      this.setStatus(`${establishTarget ? "保存" : "另存为"}成功：${handle.name}`);
      return;
    }
    const data = this.documentBytes();
    const blob = new Blob([data], {
      type: fileInfo.mime,
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    this.setStatus(`${establishTarget ? "保存" : "另存为"}已下载；当前浏览器不支持固定文件句柄，下次保存仍会询问位置`);
  }

  private async writeTo(path: string): Promise<void> {
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(path, this.documentBytes());
  }

  private async writeBrowserHandle(handle: BrowserFileHandle): Promise<void> {
    const writable = await handle.createWritable();
    await writable.write(this.documentBytes());
    await writable.close();
  }

  /** Load dropped file content (already decoded). */
  loadText(text: string, path: string | null): void {
    this.setImportedFileSource(path);
    if (!path || !isSlashFile(path)) {
      this.documentFormat = "jpw";
      this.slashOptions = null;
    }
    this.setText(text);
    this.resetDocumentUndo();
  }

  /** Set LinesPerPage in the document's .Layout section (empty string clears it). */
  setLinesPerPage(value: string): void {
    if (this.documentFormat !== "jpw") return;
    this.setText(upsertLayoutLines(this.getText(), value));
  }

  /** Current LinesPerPage value from the document, if any. */
  getLinesPerPage(): string {
    if (this.documentFormat !== "jpw") return "";
    const f = JpwFile.fromString(this.getText());
    return f?.getSection(LayoutSection)?.linesPerPage?.trim() ?? "";
  }

  /** Set the first piano system's editable instrument label. */
  setInstrumentName(value: string): void {
    if (this.documentFormat !== "jpw") return;
    this.setText(upsertTitleField(this.getText(), "Instrument", value.trim()));
  }

  getInstrumentName(): string {
    return this.painter.score.instrumentName.trim() || (this.painter.score.piano ? "钢琴" : "");
  }
}

function upsertTitleField(doc: string, field: string, value: string): string {
  const lines = doc.split("\n");
  const titleAt = lines.findIndex((line) => line.trim().toLowerCase() === ".title");
  const escaped = value.replace(/\r?\n/g, "\\n");
  const nextLine = `${field} = {${escaped}}`;
  if (titleAt < 0) return `.Title\n${nextLine}\n${doc}`;
  let end = titleAt + 1;
  while (end < lines.length && !lines[end].trimStart().startsWith(".")) end++;
  const key = field.toLowerCase();
  const existing = lines.findIndex((line, index) => index > titleAt && index < end && line.split("=", 1)[0].trim().toLowerCase() === key);
  if (existing >= 0) lines[existing] = nextLine;
  else lines.splice(end, 0, nextLine);
  return lines.join("\n");
}

function upsertOptionalTitleField(doc: string, field: string, value: string): string {
  if (value) return upsertTitleField(doc, field, value);
  const lines = doc.split("\n");
  const titleAt = lines.findIndex((line) => line.trim().toLowerCase() === ".title");
  if (titleAt < 0) return doc;
  let end = titleAt + 1;
  while (end < lines.length && !lines[end].trimStart().startsWith(".")) end++;
  const key = field.toLowerCase();
  const existing = lines.findIndex((line, index) =>
    index > titleAt && index < end
    && line.split("=", 1)[0].trim().toLowerCase() === key);
  if (existing < 0) return doc;
  lines.splice(existing, 1);
  return lines.join("\n");
}

function readJpwTitleField(doc: string, field: string): string {
  const lines = doc.split(/\r?\n/);
  const titleAt = lines.findIndex((line) => line.trim().toLowerCase() === ".title");
  if (titleAt < 0) return "";
  const key = field.toLowerCase();
  for (let index = titleAt + 1; index < lines.length; index++) {
    if (lines[index].trimStart().startsWith(".")) break;
    const equals = lines[index].indexOf("=");
    if (equals < 0 || lines[index].slice(0, equals).trim().toLowerCase() !== key) continue;
    const value = lines[index].slice(equals + 1).trim();
    return value.startsWith("{") && value.endsWith("}")
      ? value.slice(1, -1)
      : value;
  }
  return "";
}

function replaceJpwNotationSections(original: string, generated: string): string {
  interface SectionBlock {
    header: string;
    from: number;
    to: number;
    lines: string[];
  }
  const blocks = (text: string): { lines: string[]; sections: SectionBlock[] } => {
    const lines = text.split(/\r?\n/);
    const starts = lines.flatMap((line, index) =>
      line.trimStart().startsWith(".") ? [index] : []);
    const sections = starts.map((from, index) => ({
      header: lines[from].trim().toLowerCase(),
      from,
      to: starts[index + 1] ?? lines.length,
      lines: lines.slice(from, starts[index + 1] ?? lines.length),
    }));
    return { lines, sections };
  };
  const source = blocks(original);
  const replacement = blocks(generated);
  const wanted = (header: string): boolean =>
    header === ".words" || header === ".voice" || header.startsWith(".voice.");
  const queues = new Map<string, string[][]>();
  for (const section of replacement.sections.filter((item) => wanted(item.header))) {
    const queue = queues.get(section.header) ?? [];
    queue.push(section.lines);
    queues.set(section.header, queue);
  }
  const fallbackVoices = replacement.sections
    .filter((section) => section.header === ".voice" || section.header.startsWith(".voice."))
    .map((section) => section.lines);
  let fallbackVoiceIndex = 0;
  const changes = source.sections
    .filter((section) => wanted(section.header))
    .map((section) => {
      const exact = queues.get(section.header)?.shift();
      const lines = exact ?? (section.header === ".words"
        ? replacement.sections.find((item) => item.header === ".words")?.lines
        : fallbackVoices[fallbackVoiceIndex++]);
      return lines ? { from: section.from, to: section.to, lines } : null;
    })
    .filter((change): change is { from: number; to: number; lines: string[] } => change !== null)
    .sort((left, right) => right.from - left.from);
  for (const change of changes) {
    source.lines.splice(change.from, change.to - change.from, ...change.lines);
  }
  return source.lines.join(original.includes("\r\n") ? "\r\n" : "\n");
}

/** Insert/update/remove `LinesPerPage = N` within a `.Layout` section. */
function upsertLayoutLines(doc: string, value: string): string {
  const lines = doc.split("\n");
  const isSection = (l: string) => l.startsWith(".");
  let layoutAt = lines.findIndex((l) => l.trim().toLowerCase() === ".layout");

  if (layoutAt < 0) {
    if (!value) return doc;
    const block = lines[lines.length - 1] === "" ? "" : "\n";
    return doc + `${block}.Layout\nLinesPerPage = ${value}\n`;
  }
  // find section body bounds
  let end = layoutAt + 1;
  while (end < lines.length && !isSection(lines[end])) end++;
  let lpIdx = -1;
  for (let i = layoutAt + 1; i < end; i++) {
    if (lines[i].toLowerCase().includes("linesperpage")) lpIdx = i;
  }
  if (!value) {
    if (lpIdx >= 0) lines.splice(lpIdx, 1);
    return lines.join("\n");
  }
  if (lpIdx >= 0) lines[lpIdx] = `LinesPerPage = ${value}`;
  else lines.splice(layoutAt + 1, 0, `LinesPerPage = ${value}`);
  return lines.join("\n");
}

function describePick(item: PageItem): string {
  if (item instanceof LayoutLyric) return `歌词: ${item.text}`;
  if (item instanceof JpNumber) return `音符: ${item.text}`;
  if (item instanceof TextFrame) return `文本: ${item.text}`;
  const cls = [...item.classes].filter((c) => c !== "entry");
  return cls.length ? `已选: ${cls.join(",")}` : "已选: 元素";
}

/** 判断 MusicXML 是否多声部（≥2 part、单 part 多谱表、或 ≥2 voice）→ 默认混排。 */
function isMultiPartXml(xml: string): boolean {
  try {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return false;
    if (doc.getElementsByTagName("score-part").length >= 2) return true;
    for (const s of Array.from(doc.getElementsByTagName("staves"))) {
      if (parseInt(s.textContent ?? "1", 10) >= 2) return true;
    }
    const voices = new Set<string>();
    for (const v of Array.from(doc.getElementsByTagName("voice"))) {
      const t = v.textContent?.trim();
      if (t) voices.add(t);
    }
    return voices.size >= 2;
  } catch {
    return false;
  }
}

/** 把识别映射的所有代码区间经 CodeMirror 变更集迁移到新文档位置（保持编辑后点选仍准）。 */
function mapMeta(meta: JpwMeta, ch: { mapPos(pos: number, assoc?: number): number }): JpwMeta {
  const mr = (r: JpwRange): JpwRange => ({ from: ch.mapPos(r.from, 1), to: ch.mapPos(r.to, -1) });
  return {
    noteRanges: meta.noteRanges.map(mr),
    lyricRanges: meta.lyricRanges.map((m) => {
      const nm = new Map<number, JpwRange>();
      for (const [k, v] of m) nm.set(k, mr(v));
      return nm;
    }),
    titleRange: meta.titleRange ? mr(meta.titleRange) : undefined,
    authorRanges: meta.authorRanges.map((a) => ({ text: a.text, range: mr(a.range) })),
  };
}
