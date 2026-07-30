// App controller: CodeMirror editor <-> live relayout/render <-> paging <-> file I/O.
// Mirrors EditorController in CodeEditor.kt (doBind/tryLoad/updateLayout/paint/load/doSave).

import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState, EditorSelection, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, undo } from "@codemirror/commands";
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
import { Chord, Note as ScoreNote, PlayItem, Score, TempoMark } from "../score/score";
import { JinpuPainter } from "../layout/painter";
import { JpNumber, JpOctaveDot, Lyric as LayoutLyric, NoteEntry, TextFrame, type PageItem } from "../layout/layout";
import {
  normalizeEngravingStyle,
  type EngravingStyle,
  type RhythmGuideDivision,
} from "../layout/style";
import { Point } from "../common/geom";
import { MetaData } from "../smufl/smufl";
import { isPianoMusicXml, loadMusicXml } from "../score/musicxml";
import { abcToMusicXml } from "../abc/abc2xml";
import { scoreToJpwabc, scoreToJpwabcWithMeta, type JpwMeta, type JpwRange } from "../score/jpscore";
import { decodeJpwabc, encodeJpwabc, isTauriRuntime } from "./fileio";
import { MixedPainter } from "../mixed/painter";
import { ScorePlayer, type PlayState, type Sf2PlaybackOptions } from "./player";
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
  hasSlashScoreLines,
  MAX_SLASH_VOICES,
  migrateSlashVoiceCount,
  parseSlashScore,
  replaceSlashScoreLines,
  rewriteSlashDurationDirectives,
  scoreToSlashScore,
  SLASH_VOICE_SEPARATOR,
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
  normalizeNoteTimingEdits,
  moveScoreNotesOnTimeline,
  noteTimingStep,
  resizeScoreNoteSegmentsWithRests,
  serializeJpwNoteTimingEdits,
  type NoteTimingDivision,
} from "../score/note-timing";

interface SelectedScoreNote {
  source: JpwSourceNote;
  /** The exact rendered segment that was clicked (it may be a gray tie continuation). */
  visualNote: ScoreNote;
  verse: number;
  element: SVGGElement;
}

interface SelectedScoreObject {
  mark: TempoMark;
  element: SVGGElement;
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
  // render settings (app-level, not part of the .jpwabc document)
  pageW = 595;
  pageH = 842;
  fontSize = 28;
  titleSize = 48;
  creditSize = 36;
  color = 0xff000000; // ARGB
  engravingStyle: EngravingStyle = normalizeEngravingStyle();
  mixedHideBarNumber = false; // 混排：隐藏小节号
  zoom = 1; // 谱面显示缩放（应用到 #score-pane 的 --score-zoom）
  previewLocked = false;
  codePaneSide: "left" | "right" = "left";
  codePaneCollapsed = false;
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
    this.scorePane.addEventListener("keydown", (event) => this.onScoreKeyDown(event));
  }

  private configurePainter(painter: JinpuPainter, color = this.color): void {
    painter.layout.options.smuflMeta = this.meta;
    painter.layout.options.color = color;
    painter.layout.options.titleSize = this.titleSize;
    painter.layout.options.creditSize = this.creditSize;
    painter.layout.options.applyEngravingStyle(this.engravingStyle);
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
  setEngravingStyle(style: Partial<EngravingStyle>, persist = true): void {
    this.engravingStyle = normalizeEngravingStyle(style);
    this.painter.layout.options.applyEngravingStyle(this.engravingStyle);
    this.syncRhythmGridToolbar();
    if (persist) this.saveSettings();
    if (this.view && this.mode === "jp") this.reload(this.getText());
  }

  /** Select one direct-edit grid; selecting the active value again restores auto. */
  setRhythmEditDivision(division: NoteTimingDivision | null): void {
    if (division !== null && this.documentFormat !== "jpw") {
      const limits = this.slashTimingGridLimits();
      if (division > limits.enabledMaximum) {
        const message = limits.hasSubdivision
          ? `当前文本谱最细只能写到 ${limits.enabledMaximum} 分音符；请把时值符号或音符自身时值设得更细`
          : `当前文本谱最细时值是 ${limits.base} 分音符；要使用 ${division} 分音符，请先在“乐谱设置”中把花括号或方括号设为“细分”，或给符号映射 ${division} 分音符`;
        this.showToolbarNotice(message);
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
    this.setStatus(division === null
      ? "节奏编辑刻度已恢复自动；方向键会采用所选音符所在小节的最短网格"
      : `节奏编辑刻度已设为${division === 1 ? "全音符" : `${division} 分音符`}；左右方向键按此步长移动`);
  }

  syncRhythmGridToolbar(): void {
    const limits = this.documentFormat === "jpw"
      ? { base: 64, visibleMaximum: 64, enabledMaximum: 64, hasSubdivision: true }
      : this.slashTimingGridLimits();
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
    if (!control) return;
    control.dataset.mode = selected === null ? "auto" : "manual";
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
        button.title = `${division} 分音符需要先在乐谱设置中启用细分或映射更细的时值符号`;
      } else {
        button.title = `${division === 1 ? "全音符" : `${division} 分音符`}刻度；再次点击恢复自动`;
      }
    });
  }

  private slashTimingGridLimits(): {
    base: SlashDurationDivision;
    visibleMaximum: SlashDurationDivision;
    enabledMaximum: SlashDurationDivision;
    hasSubdivision: boolean;
  } {
    const values = [
      this.slashOptions?.noteDivision ?? 4,
      this.slashOptions?.spaceDivision ?? 4,
      ...Object.values(this.slashOptions?.symbolDurations ?? {}),
    ];
    const base = ([4, 8, 16, 32, 64] as SlashDurationDivision[])
      .find((division) => division >= Math.min(64, Math.max(4, ...values))) ?? 64;
    const hasSubdivision = this.slashOptions?.braceMode === "subdivide"
      || this.slashOptions?.bracketMode === "subdivide";
    const visibleMaximum = Math.min(64, base * 2) as SlashDurationDivision;
    const enabledMaximum = (hasSubdivision ? visibleMaximum : base) as SlashDurationDivision;
    return { base, visibleMaximum, enabledMaximum, hasSubdivision };
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
        engravingStyle: Partial<EngravingStyle>;
        slashVoiceColors: string[];
        slashVoiceColorVersion: number;
        textVoiceColoring: boolean;
        scoreVoiceColoring: boolean;
        showInvisibleVoiceMarkers: boolean;
        codePaneSide: "left" | "right";
        codePaneCollapsed: boolean;
        partVolumes: number[];
        playbackSoundSource: PlaybackSoundSource;
        selectedSoundfontId: string;
        soundfontInstrumentByGroup: Record<string, string>;
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
      this.engravingStyle = normalizeEngravingStyle(s.engravingStyle);
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
      if (s.codePaneSide === "left" || s.codePaneSide === "right") {
        this.codePaneSide = s.codePaneSide;
      }
      if (typeof s.codePaneCollapsed === "boolean") {
        this.codePaneCollapsed = s.codePaneCollapsed;
      }
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
        engravingStyle: this.engravingStyle,
        slashVoiceColors: this.slashVoiceColors,
        slashVoiceColorVersion: 2,
        textVoiceColoring: this.textVoiceColoring,
        scoreVoiceColoring: this.scoreVoiceColoring,
        showInvisibleVoiceMarkers: this.showInvisibleVoiceMarkers,
        codePaneSide: this.codePaneSide,
        codePaneCollapsed: this.codePaneCollapsed,
        partVolumes: this.partVolumes,
        playbackSoundSource: this.playbackSoundSource,
        selectedSoundfontId: this.selectedSoundfontId,
        soundfontInstrumentByGroup: this.soundfontInstrumentByGroup,
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
    body.classList.toggle("code-pane-collapsed", this.codePaneCollapsed);
    if (toggle) {
      const pointsTowardPane = this.codePaneSide === "left" ? "▶" : "◀";
      const pointsTowardScore = this.codePaneSide === "left" ? "◀" : "▶";
      toggle.textContent = this.codePaneCollapsed ? pointsTowardPane : pointsTowardScore;
      toggle.title = this.codePaneCollapsed ? "展开文本编辑器" : "隐藏文本编辑器";
      toggle.setAttribute("aria-expanded", String(!this.codePaneCollapsed));
    }
    if (this.view) requestAnimationFrame(() => this.view.requestMeasure());
  }

  mountEditor(parent: HTMLElement, initialText: string): void {
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) {
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
        this.syncScoreSelectionsFromCode();
      }
    });
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorState.allowMultipleSelections.of(true),
          jpwHighlighter,
          scoreSourceHighlighter,
          slashTimingDiagnosticHighlighter,
          slashVoiceHighlighter,
          Prec.high(EditorView.domEventHandlers({
            keydown: (event) => this.onEditorKeyDown(event),
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
    this.syncScoreSettingsButton();
    // 混排/识别模式：谱面区显示各自专属视图，编辑文本不重排冲掉它。
    if (this.mode !== "jp") return true;
    if (this._pendingSelectionAnchors === null && this._selectedNotes.length > 0) {
      this._pendingSelectionAnchors = this._selectedNotes.map((selection) =>
        this.selectionAnchor(selection));
    }
    let score;
    let slashTimingDiagnostics: SlashScoreDiagnostic[] = [];
    let breakDesc: string | null = null;
    if (this.documentFormat === "jpw") {
      let f: JpwFile | null;
      try {
        f = JpwFile.fromString(text);
      } catch {
        return false;
      }
      if (!f) return false;
      try {
        score = fromJpw(f);
      } catch (e) {
        console.error("import failed", e);
        return false;
      }
      if (!score) return false;
      breakDesc = f.getSection(LayoutSection)?.desc ?? null;
    } else {
      if (!this.slashOptions) return false;
      try {
        // The settings comment is the undoable source of truth for direct
        // timing edits. Re-read it before every parse so Ctrl+Z also restores
        // the previous rhythmic positions and lengths.
        this.slashOptions = {
          ...this.slashOptions,
          noteTimingEdits: analyzeSlashScore(text).noteTimingEdits.map((edit) => ({ ...edit })),
        };
        const parsed = parseSlashScore(text, this.slashOptions);
        score = parsed.score;
        slashTimingDiagnostics = parsed.summary.diagnostics;
      } catch (e) {
        console.error("slash-score import failed", e);
        return false;
      }
    }

    this.painter.score = score;
    this._slashTimingDiagnostics = slashTimingDiagnostics;
    this._sourceNotes = this.documentFormat === "jpw"
      ? buildJpwSourceNotes(text, score)
      : buildSlashSourceNotes(text, this.slashOptions!, score);
    this.syncRhythmGridToolbar();
    this.updateSlashTimingDiagnostics();
    this.updateSlashVoiceHighlights();
    this.applySoftDeletedModelState();
    try {
      this.painter.resize(this.pageW, this.pageH, breakDesc);
    } catch (e) {
      console.error("layout failed", e);
      return false;
    }
    this.renderPages();
    this.applyScoreVoiceColors();
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

  private updateSlashVoiceHighlights(): void {
    if (!this.view) return;
    if (this.documentFormat === "jpw"
      || (!this.textVoiceColoring && !this.showInvisibleVoiceMarkers)) {
      this.view.dispatch({ effects: setSlashVoiceHighlights.of([]) });
      return;
    }
    this.view.dispatch({
      effects: setSlashVoiceHighlights.of(this._sourceNotes.flatMap((source) => {
        if (!source.voiceIndex || source.markerFrom === undefined) return [];
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
    const previewPainter = new JinpuPainter(this.fontSize);
    this.configurePainter(previewPainter);
    previewPainter.layout.options.applyEngravingStyle(style);
    previewPainter.score = previewScore;
    const previewPageHeight = Math.max(this.pageH, this.fontSize * 44);
    try {
      previewPainter.resize(
        this.pageW,
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
      Math.max(this.fontSize * 8, notationBottom),
    );
    const svg = previewPainter.renderPage(0);
    svg.setAttribute("viewBox", `0 0 ${this.pageW} ${cropHeight}`);
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
    this.scorePane.replaceChildren();
    this.pageEls = [];
    this.selectedEls.clear();
    for (let i = 0; i < this.painter.pageCount; i++) {
      const svg = this.painter.renderPage(i);
      const wrap = document.createElement("div");
      wrap.className = "score-page-wrap";
      wrap.style.aspectRatio = `${this.painter.pageWidth} / ${this.painter.pageHeight}`;
      const maxWidth = this.painter.pageHeight > this.painter.pageWidth ? 720 : 960;
      wrap.style.width = `calc(min(${maxWidth}px, 100%) * var(--score-zoom, 1))`;
      wrap.appendChild(svg);
      const idx = i;
      svg.addEventListener("click", (e) => this.onPageClick(idx, svg, e));
      svg.addEventListener("dblclick", (e) => this.onPageDoubleClick(idx, svg, e));
      svg.addEventListener("pointerdown", (e) => this.onPagePointerDown(idx, svg, e));
      svg.addEventListener("pointermove", (e) => this.onPagePointerMove(e));
      svg.addEventListener("pointerup", (e) => this.onPagePointerUp(e));
      svg.addEventListener("pointercancel", (e) => this.onPagePointerCancel(e));
      this.scorePane.appendChild(wrap);
      this.pageEls.push(wrap);
    }
    this.applySlashMeasureDiagnostics();
    this.pageIndex = Math.min(this.pageIndex, Math.max(0, this.pageEls.length - 1));
    this.applySoftDeletedClasses();
    this.restoreScoreSelections();
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
      if (overlay.childElementCount > 0) svg.appendChild(overlay);
    }
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
    };
  }

  private onPageClick(pageIndex: number, svg: SVGSVGElement, ev: MouseEvent): void {
    if (this._suppressPageClick) {
      this._suppressPageClick = false;
      ev.preventDefault();
      return;
    }
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
    const picked = this.painter.pickPage(pageIndex, new Point(pt.x, pt.y));
    const additive = ev.ctrlKey || ev.metaKey;
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
      if (item.data instanceof TempoMark) {
        const element = this.painter.nodeMap.get(item);
        return element ? { mark: item.data, element } : null;
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
  }

  private addScoreObjectSelection(selection: SelectedScoreObject): void {
    if (this._selectedObjects.some((item) => item.mark === selection.mark)) return;
    selection.element.classList.add("selected");
    this.selectedEls.add(selection.element);
    this._selectedObjects.push(selection);
  }

  private removeScoreObjectSelection(index: number): void {
    const selection = this._selectedObjects[index];
    if (!selection) return;
    selection.element.classList.remove("selected");
    this.selectedEls.delete(selection.element);
    this._selectedObjects.splice(index, 1);
  }

  private selectionStatus(): string {
    const noteCount = this._selectedNotes.length;
    const objectCount = this._selectedObjects.length;
    if (noteCount + objectCount === 0) {
      return "已清除谱面选择；播放将从开头开始";
    }
    const parts = [
      noteCount > 0 ? `${noteCount} 个音符` : "",
      objectCount > 0 ? `${objectCount} 个速度标记` : "",
    ].filter(Boolean);
    return `已选择 ${parts.join("、")}；Del/退格软删除，双击半透明项目恢复`;
  }

  private tempoMarkKey(mark: TempoMark): string {
    return `${mark.measure}:${mark.offset.toString()}:${mark.kind}:${mark.bpm ?? ""}`;
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
    const tempoKeys = [...new Set(this._selectedObjects
      .map(({ mark }) => this.tempoMarkKey(mark))
      .filter((key) => !this._softDeletedTempoKeys.has(key)))];
    if (notes.length === 0 && tempoKeys.length === 0) return;

    this._scoreUndoStack.push({ notes, tempoKeys });
    this._softDeletedNotes.push(...notes);
    for (const key of tempoKeys) this._softDeletedTempoKeys.add(key);
    this.applySoftDeletedModelState();
    this.applySoftDeletedClasses();
    this.clearSelectedItems();
    this.syncCodeSelections(false);
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
    const point = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
    const picked = this.painter.pickPage(pageIndex, new Point(point.x, point.y));
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
    if (object?.mark.softDeleted) {
      const key = this.tempoMarkKey(object.mark);
      this._softDeletedTempoKeys.delete(key);
      object.mark.softDeleted = false;
      for (const rendered of this.painter.itemGroupsForData(object.mark)) {
        rendered.element.classList.remove("soft-deleted");
      }
      this.discardRestoredUndo(null, key);
      this.setStatus("已恢复速度标记");
      ev.preventDefault();
    }
  }

  private onPagePointerDown(
    page: number,
    svg: SVGSVGElement,
    ev: PointerEvent,
  ): void {
    if (ev.button !== 0) return;
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
    for (const element of this.selectedEls) element.classList.remove("selected");
    this.selectedEls.clear();
    this._selectedNotes = [];
    this._selectedObjects = [];
    this._pendingSelectionAnchors = null;
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
      if (source) this.addScoreSelection(source, anchor.verse);
    }
    if (anchors.length > 0) this.syncCodeSelections(false);
  }

  private onEditorKeyDown(event: KeyboardEvent): boolean {
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
    const text = this.getText();
    const changes = selected.map((source) => {
      const markerFrom = source.markerFrom ?? source.from;
      const currentVoice = wasSingleAltOne ? 2 : source.voiceIndex ?? voiceCount;
      const insert = targetVoice === voiceCount
        || (!wasSingleAltOne && currentVoice === targetVoice)
        ? ""
        : SLASH_VOICE_SEPARATOR.repeat(targetVoice);
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

  private onScoreKeyDown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey)
      && !event.shiftKey
      && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.stopPropagation();
      if (!this.undoScoreDelete()) undo(this.view);
      return;
    }
    if (this.handleVoiceShortcut(event)) return;
    if ((event.key === "Delete" || event.key === "Backspace")
      && this._selectedNotes.length + this._selectedObjects.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      this.deleteSelectedScoreItems();
      return;
    }
    if (this._selectedNotes.length === 0) return;
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight")
      && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      this.editSelectedTiming(
        event.key === "ArrowRight" ? 1 : -1,
        event.ctrlKey || event.metaKey,
      );
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    let edit: PitchEdit | null = null;
    let label = "";
    if (/^[1-7]$/.test(event.key)) {
      edit = { kind: "number", number: event.key };
      label = `音高改为 ${event.key}`;
    } else if (event.key === "ArrowUp") {
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
    return this.automaticTimingDivision();
  }

  private replaceDocumentText(next: string, anchors?: SelectionAnchor[]): boolean {
    const before = this.getText();
    if (before === next) return true;
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
    subdivisionMode?: "brace" | "bracket";
    } | null;
  private slashTimelineSerializationGrid(
    baseOptions: SlashScoreOptions | null,
  ): {
    division: SlashDurationDivision;
    symbol: string;
    options: SlashScoreOptions;
    subdivisionMode?: "brace" | "bracket";
    } | null;
  private slashTimelineSerializationGrid(
    baseOptions: SlashScoreOptions | null = this.slashOptions,
  ): {
    division: SlashDurationDivision;
    symbol: string;
    options: SlashScoreOptions;
    subdivisionMode?: "brace" | "bracket";
    } | null {
    if (!baseOptions) return null;
    const requested = Math.max(4, this.activeTimingDivision()) as SlashDurationDivision;
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
    const subdivisionMode = requested > division
      ? baseOptions.braceMode === "subdivide"
        ? "brace"
        : baseOptions.bracketMode === "subdivide"
          ? "bracket"
          : undefined
      : undefined;
    const options: SlashScoreOptions = {
      ...baseOptions,
      symbolDurations: { ...baseOptions.symbolDurations },
      noteTimingEdits: [],
    };
    if (!existing) {
      options.symbolDurations[symbol] = division;
      if (mapped.length > 0) options.multiDurationSymbols = true;
    }
    return { division, symbol, options, subdivisionMode };
  }

  private moveSelectedAttacks(
    sources: readonly JpwSourceNote[],
    direction: -1 | 1,
    division: NoteTimingDivision,
  ): void {
    const delta = noteTimingStep(division).timesInt(direction);
    const unique = [...new Map(sources.map((source) => [source.note, source])).values()];
    const anchors = unique.map((source): SelectionAnchor => ({
      position: source.from,
      verse: this._selectedNotes.find((selection) => selection.source === source)?.verse ?? 0,
      partIndex: source.partIndex,
      grace: source.grace,
      pitch: source.note.pitch,
      absoluteTick: source.note.absoluteTick.plus(delta).toString(),
    }));
    const result = moveScoreNotesOnTimeline(
      this.painter.score,
      unique.map((source) => ({
        partIndex: source.partIndex,
        note: source.note,
        grace: source.grace,
      })),
      delta,
      { preserveRests: this.documentFormat === "jpw" },
    );
    if (result.changed === 0) {
      this.setStatus(result.blocked > 0
        ? this.documentFormat === "jpw" && direction < 0
          ? `左移后必须能完整容纳原时值；若会与保留在原和弦中的音或下一起音重叠，就不能继续左移`
          : "倚音、休止符或乐谱边界上的音符不能按当前方向继续移动"
        : "没有可移动的音符");
      return;
    }

    let next: string;
    if (this.documentFormat === "jpw") {
      const withoutOverlay = upsertOptionalTitleField(
        this.getText(),
        "NoteTimingEdits",
        "",
      );
      const generated = scoreToJpwabc(this.painter.score);
      next = replaceJpwNotationSections(
        withoutOverlay,
        generated,
      );
      next = upsertOptionalTitleField(
        next,
        "Arpeggios",
        readJpwTitleField(generated, "Arpeggios"),
      );
    } else {
      const serialization = this.slashTimelineSerializationGrid();
      if (!serialization) return;
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
          ordering: serialization.options.ordering ?? "pitch-asc",
          subdivisionMode: serialization.subdivisionMode,
          durationNotation: serialization.options,
        },
        voiceCount,
      );
      this.slashOptions = serialization.options;
      const rewritten = rewriteSlashDurationDirectives(
        replaceSlashScoreLines(this.getText(), generated, this.documentFormat),
        serialization.options,
      );
      next = embedSlashScoreOptions(
        rewritten,
        serialization.options,
      );
    }

    const ok = this.replaceDocumentText(next, anchors);
    const grid = division === 1 ? "全音符" : `${division} 分音符`;
    this.setStatus(ok
      ? `已把 ${result.changed} 个独立音按${grid}刻度${direction > 0 ? "右移" : "左移"}；小节总拍长保持不变${
        result.blocked ? `，另有 ${result.blocked} 个未移动` : ""
      }`
      : "移动后的时值无法重新写回当前乐谱");
  }

  private editSelectedTiming(direction: -1 | 1, resize: boolean): void {
    const sources = [...new Map(this._selectedNotes.map(({ source }) => [
      source.note,
      source,
    ])).values()];
    if (sources.length === 0) return;
    if (resize && this.documentFormat !== "jpw") {
      this.setStatus("键盘谱和数字谱只支持左右方向键移动起音；Ctrl+左右调整时值仅用于 JPW 简谱");
      return;
    }
    const division = this.activeTimingDivision();
    if (!resize) {
      this.moveSelectedAttacks(sources, direction, division);
      return;
    }

    const step = noteTimingStep(division);
    const exactSelections = [...new Map(this._selectedNotes.map((selection) => [
      selection.visualNote.chord,
      selection,
    ])).values()];
    const extendable = exactSelections.filter((selection) =>
      !selection.visualNote.chord.notes.some((note) =>
          note.tuplet !== null || note.tupletBegin || note.tupletEnd));
    const skippedTuplets = exactSelections.length - extendable.length;
    const anchors = extendable.map(({ source, verse, visualNote }): SelectionAnchor => ({
      position: source.from,
      verse,
      partIndex: source.partIndex,
      grace: source.grace,
      pitch: visualNote.pitch,
      absoluteTick: visualNote.absoluteTick.toString(),
    }));
    const result = resizeScoreNoteSegmentsWithRests(
      this.painter.score,
      extendable.map(({ source, visualNote }) => ({
        partIndex: source.partIndex,
        note: visualNote,
        grace: source.grace,
      })),
      step.timesInt(direction),
    );
    if (result.changed === 0) {
      if (skippedTuplets > 0) {
        this.setStatus("三连音内部时值需要保持等分，当前未修改");
      } else if (direction > 0) {
        this.setStatus("Ctrl+右只能让当前音段吞并紧邻的休止符；后面已有音符、延音段或休止不足时不能延长");
      } else {
        this.setStatus("Ctrl+左会缩短当前音段并补上等量休止符；当前音段已经达到所选刻度的最短时值");
      }
      return;
    }

    const withoutOverlay = upsertOptionalTitleField(
      this.getText(),
      "NoteTimingEdits",
      "",
    );
    const generated = scoreToJpwabc(this.painter.score);
    let next = replaceJpwNotationSections(withoutOverlay, generated);
    next = upsertOptionalTitleField(
      next,
      "Arpeggios",
      readJpwTitleField(generated, "Arpeggios"),
    );
    const ok = this.replaceDocumentText(next, anchors);
    const grid = division === 1 ? "全音符" : `${division} 分音符`;
    const action = direction > 0
      ? "向右延长，并从紧邻休止符扣除等量时值"
      : "缩短，并在释放的位置补上等量休止符";
    this.setStatus(ok
      ? `已将 ${result.changed} 个当前音段按${grid}刻度${action}${
        result.blocked || skippedTuplets
          ? `；另有 ${result.blocked + skippedTuplets} 个未修改`
          : ""
      }`
      : "时值修改后的谱面无法重新写回当前乐谱");
  }

  private setStatus(s: string): void {
    if (!this.statusEl) this.statusEl = document.getElementById("status");
    if (this.statusEl) this.statusEl.textContent = s;
  }

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
    const current: SlashScoreOptions = {
      ...this.slashOptions,
      symbolDurations: { ...this.slashOptions.symbolDurations },
      tempoMarks: this.slashOptions.tempoMarks?.map((mark) => ({ ...mark })) ?? [],
    };
    const next = await showSlashScoreSettingsDialog(this.getText(), current);
    if (!next) {
      this.setStatus("未更改当前乐谱设置");
      return;
    }
    let text = this.getText();
    let voiceMessage = "";
    if (next.voiceCount !== current.voiceCount) {
      const migration = migrateSlashVoiceCount(text, current, next.voiceCount);
      text = migration.text;
      voiceMessage = migration.mergedVoices.length > 0
        ? `；V${migration.mergedVoices.join("、V")} 已并入默认 V${next.voiceCount}`
        : `；声部数量已从 ${migration.from} 调整为 ${migration.to}`;
    }
    const rhythmSignature = (options: SlashScoreOptions): string => JSON.stringify({
      symbols: options.symbolDurations,
      multiple: options.multiDurationSymbols ?? false,
      space: options.spaceDivision,
      note: options.noteDivision,
      empty: options.emptyGroupsAsRests ?? false,
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
            ordering: serialization.options.ordering ?? "pitch-asc",
            subdivisionMode: serialization.subdivisionMode,
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
    const migration = migrateSlashVoiceCount(this.getText(), this.slashOptions, nextCount);
    this.slashOptions = { ...this.slashOptions, voiceCount: nextCount };
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
            ordering: current.ordering ?? "pitch-asc",
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
      };
      this.documentFormat = target;
      this.slashOptions = options;
      this.setText(embedSlashScoreOptions(raw, options));
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
    const np = Math.max(0, Math.min(i, this.pageEls.length - 1));
    this.pageIndex = np;
    this.pageEls[np]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // ---------------- playback ----------------
  setPlayBtn(el: HTMLButtonElement): void {
    this._playBtnEl = el;
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
      this._playBtnEl.disabled = busy;
      this._playBtnEl.textContent = state === "loading" ? "加载中…" : "播放";
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
    const start = selected
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
    if (/\.(mid|midi)$/i.test(name)) {
      try {
        const parsed = parseMidi(bytes);
        if (!parsed.title) parsed.title = importedFileStem(name);
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
          const slashBraceMode = options.slashBraceMode ?? (analysis.arpeggioGroupCount > 0 ? "arpeggio" : "grace");
          const slashBracketMode = options.slashBracketMode ?? "triplet";
          const slashVoiceCount = Math.max(
            1,
            Math.min(MAX_SLASH_VOICES, score.parts.length),
          );
          const slashText = scoreToSlashScore(score, outputFormat, options.quantize, ".", {
            sourceMidi: parsed,
            braceMode: slashBraceMode,
            bracketMode: slashBracketMode,
            ordering: options.slashOrdering ?? "pitch-asc",
          }, slashVoiceCount);
          const slashAnalysis = analyzeSlashScore(slashText);
          const slashOptions = defaultSlashScoreOptions(outputFormat, slashAnalysis);
          slashOptions.keyboardKeyLabels = outputFormat === "keyboard"
            && (options.keyboardKeyLabels ?? false);
          slashOptions.keyboardTieAsZero = options.keyboardTieAsZero ?? false;
          slashOptions.keyboardHideTieLabels = options.keyboardHideTieLabels ?? false;
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
          slashOptions.ordering = options.slashOrdering ?? "pitch-asc";
          slashOptions.tempoMarks = score.tempoMarks.map((mark) => ({
            measure: mark.measure,
            offset: mark.offset.toFloat(),
            kind: mark.kind,
            bpm: mark.bpm,
          }));
          this._applyImportedSlash(slashText, slashOptions);
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
    if (/\.(txt|keyscore|numscore|kps|nps)$/i.test(name)) {
      const source = decodeJpwabc(bytes);
      try {
        const analysis = analyzeSlashScore(source);
        if (analysis.measureCount === 0) throw new Error("没有找到可导入的小节；有效谱行需要包含至少两个 /");
        const hintedKind: SlashScoreKind | undefined = /\.(keyscore|kps)$/i.test(name)
          ? "keyboard"
          : /\.(numscore|nps)$/i.test(name) ? "number" : undefined;
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
    if (/\.abc$/i.test(name)) {
      const abcText = new TextDecoder(
        bytes[0] === 0xff || bytes[0] === 0xfe ? "utf-16" : "utf-8",
      ).decode(bytes);
      try {
        const xml = abcToMusicXml(abcText);
        bytes = new TextEncoder().encode(xml);
        name = name.replace(/\.abc$/i, ".musicxml");
      } catch (e) {
        this._reportImportFailure("ABC", e);
        return;
      }
    }
    if (/\.(xml|musicxml)$/i.test(name)) {
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
            options.textDivision,
            ".",
            {
              braceMode: options.slashBraceMode,
              bracketMode: options.slashBracketMode,
              ordering: options.slashOrdering,
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
          slashOptions.ordering = options.slashOrdering;
          slashOptions.tempoMarks = score.tempoMarks.map((mark) => ({
            measure: mark.measure,
            offset: mark.offset.toFloat(),
            kind: mark.kind,
            bpm: mark.bpm,
          }));
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
          this._applyImportedSlash(preparedSlash.text, preparedSlash.options);
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
        if (/\.jpwabc$/i.test(name) && !JpwFile.fromString(text)) {
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
      keyboardKeyLabels: false,
      keyboardTieAsZero: false,
      keyboardHideTieLabels: false,
      slashBraceMode: "grace",
      slashBracketMode: "triplet",
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
  }

  private _applyImportedSlash(text: string, options: SlashScoreOptions): void {
    this.documentFormat = options.kind;
    this.slashOptions = { ...options, symbolDurations: { ...options.symbolDurations } };
    this._disablePhrase();
    this._origLayoutText = null;
    this._lastImportMeta = null;
    this.setText(embedSlashScoreOptions(text, options));
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
        filters: [{ name: "简谱 / 斜杠谱 TXT / MIDI / MusicXML / ABC", extensions: ["jpwabc", "JPWABC", "txt", "keyscore", "numscore", "kps", "nps", "mid", "midi", "xml", "musicxml", "abc"] }],
      });
      if (typeof sel !== "string") return;
      const bytes = await readFile(sel);
      await this.importBytes(bytes, sel);
      this.setImportedFileSource(sel);
      if (!/\.(mid|midi)$/i.test(sel)) this.rememberLastFile(sel);
    } else {
      const picker = (window as unknown as {
        showOpenFilePicker?: (options: unknown) => Promise<BrowserFileHandle[]>;
      }).showOpenFilePicker;
      if (picker) {
        try {
          const [handle] = await picker({
            multiple: false,
            types: [{
              description: "简谱 / 斜杠谱 TXT / MIDI / MusicXML / ABC",
              accept: {
                "application/octet-stream": [".jpwabc", ".mid", ".midi"],
                "text/plain": [".txt", ".keyscore", ".numscore", ".kps", ".nps", ".abc"],
                "application/xml": [".xml", ".musicxml"],
              },
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
      input.accept = ".jpwabc,.txt,.keyscore,.numscore,.kps,.nps,.mid,.midi,.xml,.musicxml,.abc";
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
    const extension = this.documentFormat === "jpw" ? ".jpwabc" : ".txt";
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
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({
        defaultPath: this.suggestedDesktopSavePath(name),
        filters: [{
          name: this.documentFormat === "jpw" ? "JPW 简谱" : "TXT 谱",
          extensions: [this.documentFormat === "jpw" ? "jpwabc" : "txt"],
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
          description: this.documentFormat === "jpw" ? "JPW 简谱" : "TXT 谱",
          accept: this.documentFormat === "jpw"
            ? { "application/octet-stream": [".jpwabc"] }
            : { "text/plain": [".txt"] },
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
      type: this.documentFormat === "jpw" ? "application/octet-stream" : "text/plain;charset=utf-8",
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
    if (!path || !/\.(txt|keyscore|numscore|kps|nps)$/i.test(path)) {
      this.documentFormat = "jpw";
      this.slashOptions = null;
    }
    this.setText(text);
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

function importedFileStem(path: string): string {
  const leaf = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const stem = leaf.replace(/\.(?:mid|midi)$/i, "");
  try {
    return decodeURIComponent(stem);
  } catch {
    return stem;
  }
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
