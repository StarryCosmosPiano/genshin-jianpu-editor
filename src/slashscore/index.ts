import { Fraction } from "../common/fraction";
import {
  Chord,
  formatTempoBpm,
  Measure,
  MusicCommon,
  Note,
  quarterBpmFromUnit,
  Score,
  tempoBpmForUnit,
  TempoMark,
  type TempoBeatUnit,
} from "../score/score";
import { midiToScore } from "../midi/importer";
import { detectMidiSlashGestures, type MidiSlashGesture } from "../midi/gestures";
import type { MidiImportOptions, MidiQuantizeDivision, ParsedMidi, ParsedMidiNote } from "../midi/types";

export type SlashScoreKind = "keyboard" | "number";
export type SlashDurationDivision = 4 | 8 | 16 | 32 | 64;
export type SlashGroupMode = "none" | "subdivide" | "grace" | "arpeggio" | "triplet";
/** Zero-width marker used by editable TXT scores to assign one pitch to a voice. */
export const SLASH_VOICE_SEPARATOR = "\u2063";
export const MAX_SLASH_VOICES = 9;
/** Backward-compatible name retained for callers that configured `{}`. */
export type SlashBraceMode = SlashGroupMode;

export interface SlashTempoMark {
  measure: number;
  offset: number;
  kind: "accel" | "rit" | "tempo";
  bpm: number | null;
}

export interface SlashScoreOptions {
  kind: SlashScoreKind;
  /** V1..VN; an unmarked pitch belongs to the last/default voice VN. */
  voiceCount: number;
  /** One shared label is printed to the left of a multi-voice brace. */
  instrumentName?: string;
  title: string;
  subtitle: string;
  composer: string;
  arranger: string;
  lyricist: string;
  tempoBpm: number;
  tempoBeatUnit?: TempoBeatUnit;
  fifths: number;
  beats: number;
  beatType: number;
  symbolDurations: Record<string, SlashDurationDivision>;
  /** null means formatting whitespace; otherwise literal spaces add duration to the adjacent sounding note. */
  spaceDivision: SlashDurationDivision | null;
  /** null preserves the legacy marker-only rhythm; otherwise every note/chord advances this duration itself. */
  noteDivision: SlashDurationDivision | null;
  braceMode: SlashBraceMode;
  /** Defaults to triplet when absent in an older saved options comment. */
  bracketMode?: SlashGroupMode;
  /** MIDI tempo annotations retained inside the editable TXT settings comment. */
  tempoMarks?: SlashTempoMark[];
}

export interface SlashMeterSuggestion {
  beats: number;
  beatType: number;
  groupsPerMeasure: number;
  groupQuarterNotes: number;
  explicit: boolean;
}

export interface SlashScoreAnalysis {
  detectedKind: SlashScoreKind;
  voiceCount: number;
  measureCount: number;
  commentCount: number;
  ignoredTagCount: number;
  observedSymbols: string[];
  containsScoreSpaces: boolean;
  suggestedMappings: Record<string, SlashDurationDivision>;
  suggestedSpaceDivision: SlashDurationDivision | null;
  suggestedNoteDivision: SlashDurationDivision | null;
  meter: SlashMeterSuggestion;
  tempoBpm: number;
  tempoBeatUnit: TempoBeatUnit;
  fifths: number;
  title: string;
  subtitle: string;
  composer: string;
  arranger: string;
  lyricist: string;
  suggestedBraceMode: SlashBraceMode;
  suggestedBracketMode: SlashGroupMode;
  tempoMarks: SlashTempoMark[];
  /** One long score line contains several measures and must be split from the chosen meter. */
  continuous: boolean;
}

export interface SlashScoreSummary {
  kind: SlashScoreKind;
  measures: number;
  /** Length of an opening pickup in quarter-note units; 0 means no pickup. */
  pickupQuarterNotes: number;
  /** Automatically inserted leading zero rests inside the opening slash group. */
  pickupRestCount: number;
  comments: number;
  ignoredTags: number;
  clippedGroups: number;
  ignoredCharacters: number;
  warnings: string[];
}

export interface SlashScoreResult {
  score: Score;
  summary: SlashScoreSummary;
}

export interface MidiSlashExportOptions {
  sourceMidi: ParsedMidi;
  braceMode: SlashGroupMode;
  bracketMode: SlashGroupMode;
}

/** One editable pitch spelling in the original keyboard/number slash-score text. */
export interface SlashPitchSource {
  from: number;
  to: number;
  pitch: number;
  /** Grace pitches and their following main chord share an event index. */
  eventIndex: number;
  /** True when the spelling belongs to a non-metrical grace-note container. */
  grace: boolean;
  /** One-based V1..VN assignment derived from the preceding separators. */
  voiceIndex: number;
  /** Absolute start of the zero-width voice prefix; equals `from` when unmarked. */
  markerFrom: number;
  markerCount: number;
}

interface SourceLines {
  score: string[];
  comments: string[];
  ignoredTags: number;
}

interface Directives {
  kind: SlashScoreKind | null;
  voiceCount: number | null;
  instrumentName: string;
  beats: number | null;
  beatType: number | null;
  tempoBpm: number | null;
  tempoBeatUnit: TempoBeatUnit | null;
  fifths: number | null;
  title: string;
  subtitle: string;
  composer: string;
  arranger: string;
  lyricist: string;
  mappings: Record<string, SlashDurationDivision>;
  spaceDivision: SlashDurationDivision | null | undefined;
  noteDivision: SlashDurationDivision | null | undefined;
  braceMode: SlashBraceMode | null;
  bracketMode: SlashGroupMode | null;
  tempoMarks: SlashTempoMark[];
}

interface TimedEvent {
  start: number;
  end: number;
  pitches: number[];
  /** Leading duration in a slash group continues this preceding event. */
  continuationOf?: TimedEvent;
  /** Non-metrical notes printed before this event. */
  gracePitches?: number[][];
  /** The event is a rolled chord and receives an arpeggio wave. */
  arpeggio?: boolean;
  /** Only this subset receives the wave when a simultaneous main pitch is present. */
  arpeggioPitches?: number[];
  /** Zero-based part/voice index. Old single-voice events omit this field. */
  voiceIndex?: number;
}

interface PitchToken {
  pitch: number;
  next: number;
}

const DIVISIONS: SlashDurationDivision[] = [4, 8, 16, 32, 64];
const DEGREE_INTERVALS = [0, 2, 4, 5, 7, 9, 11];
const KEYBOARD_ROWS = ["ZXCVBNM", "ASDFGHJ", "QWERTYU"] as const;
const LINE_TAG_RE = /\[(?:line|end)\s*\d+\s*\]/gi;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mode(values: number[], fallback: number): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = fallback;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function stripLineTags(line: string): { text: string; count: number } {
  let count = 0;
  const text = line.replace(LINE_TAG_RE, () => {
    count++;
    return "";
  });
  return { text, count };
}

function looksLikeScoreLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("；") || trimmed.startsWith(";")) return false;
  // `//3../4../` is a valid opening measure with two omitted slash groups,
  // while `// comment` and the persisted `// @jpeditor ...` header remain
  // comments. Requiring a score token immediately after the empty groups and
  // another later separator keeps those two uses unambiguous.
  if (trimmed.startsWith("//") && !/^\/+\s*(?:[\u2063\-+0-9A-Z#b({]).*\//.test(trimmed)) return false;
  if (/\d+\s*\/\s*\d+\s*拍/.test(trimmed)) return false;
  const slashCount = (line.match(/\//g) ?? []).length;
  if (slashCount < 1) return false;
  const withoutTags = line.replace(LINE_TAG_RE, "");
  if (!/[A-Z1-7]/.test(withoutTags)) return /^\s*-\s*\//.test(withoutTags);
  const nonSpace = Array.from(withoutTags).filter((c) => !/\s/.test(c) && c !== SLASH_VOICE_SEPARATOR);
  const latinLike = nonSpace.filter((c) => /[A-Za-z0-9+\-#b♭♯/(){}[\].=*_~,'：:]/.test(c)).length;
  return nonSpace.length === 0 || latinLike / nonSpace.length >= 0.72;
}

interface SourceLineRecord {
  raw: string;
  text: string;
  from: number;
  score: boolean;
  kind: SlashScoreKind | null;
  sectionKind: SlashScoreKind | null;
  ignoredTags: number;
}

function scoreLineKind(line: string): SlashScoreKind | null {
  const withoutTags = line.replace(LINE_TAG_RE, "");
  const keyboardCount = (withoutTags.match(/[A-Z]/g) ?? []).length;
  const numberCount = [...withoutTags.matchAll(/(?:[#♯b♭]?[+-]*)([1-7])(?!\d)/g)].length;
  if (keyboardCount === 0 && numberCount === 0) return null;
  if (keyboardCount === numberCount) return null;
  return keyboardCount > numberCount ? "keyboard" : "number";
}

function sourceLineRecords(text: string): SourceLineRecord[] {
  const records: SourceLineRecord[] = [];
  let lineFrom = text.startsWith("\uFEFF") ? 1 : 0;
  let sectionKind: SlashScoreKind | null = null;
  while (lineFrom <= text.length) {
    let lineTo = lineFrom;
    while (lineTo < text.length && text[lineTo] !== "\r" && text[lineTo] !== "\n") lineTo++;
    const raw = text.slice(lineFrom, lineTo);
    const header = raw.trim();
    if (/^键盘谱$/i.test(header)) sectionKind = "keyboard";
    else if (/^数字谱$/i.test(header)) sectionKind = "number";
    const stripped = stripLineTags(raw);
    const score = looksLikeScoreLine(stripped.text);
    records.push({
      raw,
      text: stripped.text,
      from: lineFrom,
      score,
      kind: score ? scoreLineKind(stripped.text) : null,
      sectionKind,
      ignoredTags: stripped.count,
    });
    if (lineTo >= text.length) break;
    lineFrom = lineTo + (text[lineTo] === "\r" && text[lineTo + 1] === "\n" ? 2 : 1);
  }
  return records;
}

function scoreLineOwner(records: readonly SourceLineRecord[], index: number): SlashScoreKind | null {
  const record = records[index];
  if (record.kind) return record.kind;
  if (record.sectionKind) return record.sectionKind;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (!records[cursor].score) continue;
    if (records[cursor].kind) return records[cursor].kind;
  }
  for (let cursor = index + 1; cursor < records.length; cursor++) {
    if (!records[cursor].score) continue;
    if (records[cursor].kind) return records[cursor].kind;
  }
  return null;
}

function selectedScoreLine(
  records: readonly SourceLineRecord[],
  index: number,
  kind?: SlashScoreKind,
): boolean {
  if (!records[index].score) return false;
  if (!kind) return true;
  const owner = scoreLineOwner(records, index);
  return owner === null || owner === kind;
}

function sourceLines(text: string, kind?: SlashScoreKind): SourceLines {
  const records = sourceLineRecords(text);
  return {
    score: records
      .filter((_record, index) => selectedScoreLine(records, index, kind))
      .map((record) => record.text),
    comments: records
      .filter((record) => !record.score && record.raw.trim())
      .map((record) => record.raw),
    ignoredTags: records.reduce((sum, record) => sum + record.ignoredTags, 0),
  };
}

/** Infer the minimum voice count from markers in real score lines only. */
export function inferSlashVoiceCount(text: string, kind?: SlashScoreKind): number {
  const lines = sourceLines(text, kind);
  let maxMarkers = 0;
  for (const line of lines.score) {
    const runs = line.matchAll(/\u2063+(?=(?:[#♯b♭]*[,+']*|[#♯b♭]*[+-]*)[A-Z1-7])/g);
    for (const run of runs) maxMarkers = Math.max(maxMarkers, run[0].length);
  }
  return clamp(maxMarkers + 1, 1, MAX_SLASH_VOICES);
}

function straySlashVoiceMarkerCount(text: string, kind?: SlashScoreKind): number {
  let stray = 0;
  for (const line of sourceLines(text, kind).score) {
    const all = (line.match(/\u2063/g) ?? []).length;
    const valid = [...line.matchAll(/\u2063+(?=(?:[#♯b♭]*[,+']*|[#♯b♭]*[+-]*)[A-Z1-7])/g)]
      .reduce((sum, match) => sum + match[0].length, 0);
    stray += Math.max(0, all - valid);
  }
  return stray;
}

function divisionFromText(value: string): SlashDurationDivision | null {
  const normalized = value.replace(/\s/g, "");
  const chinese: Array<[RegExp, SlashDurationDivision]> = [
    [/六十四分/, 64], [/三十二分/, 32], [/十六分/, 16], [/八分/, 8], [/四分/, 4],
  ];
  for (const [pattern, division] of chinese) if (pattern.test(normalized)) return division;
  const numeric = /(?:^|[^\d])(64|32|16|8|4)\s*分/.exec(value);
  return numeric ? parseInt(numeric[1], 10) as SlashDurationDivision : null;
}

function keyToFifths(name: string): number | null {
  const normalized = name.trim().replace("♭", "b").replace("♯", "#").toUpperCase();
  const index = MusicCommon.keys.findIndex((key) => key.toUpperCase() === normalized);
  return index < 0 ? null : index - 7;
}

function directiveValue(text: string, label: string): string {
  const match = new RegExp(`^\\s*(?:${label})\\s*[=：:]\\s*(.*?)\\s*$`, "i").exec(text);
  return match?.[1]?.trim() ?? "";
}

function readDirectives(text: string): Directives {
  const hasKeyboardHeader = /(?:^|\n)\s*键盘谱\s*(?:\n|$)/i.test(text);
  const hasNumberHeader = /(?:^|\n)\s*数字谱\s*(?:\n|$)/i.test(text);
  const result: Directives = {
    kind: hasKeyboardHeader ? "keyboard" : hasNumberHeader ? "number" : null,
    voiceCount: null,
    instrumentName: "",
    beats: null,
    beatType: null,
    tempoBpm: null,
    tempoBeatUnit: null,
    fifths: null,
    title: "",
    subtitle: "",
    composer: "",
    arranger: "",
    lyricist: "",
    mappings: {},
    spaceDivision: undefined,
    noteDivision: undefined,
    braceMode: null,
    bracketMode: null,
    tempoMarks: [],
  };
  const meter = /(?:^|\n)\s*(\d{1,2})\s*\/\s*(2|4|8|16)\s*拍?/m.exec(text);
  if (meter) {
    result.beats = clamp(parseInt(meter[1], 10), 1, 32);
    result.beatType = parseInt(meter[2], 10);
  }
  const bpm = /(\d{1,3}(?:\.\d)?)\s*BPM/i.exec(text);
  if (bpm) {
    const tempoLine = text.slice(
      Math.max(0, text.lastIndexOf("\n", bpm.index) + 1),
      text.indexOf("\n", bpm.index) < 0 ? text.length : text.indexOf("\n", bpm.index),
    );
    result.tempoBeatUnit = /附点四分音符|dotted[\s-]*quarter/i.test(tempoLine)
      ? "dotted-quarter"
      : /八分音符|eighth/i.test(tempoLine) ? "eighth" : "quarter";
    result.tempoBpm = quarterBpmFromUnit(
      clamp(parseFloat(bpm[1]), 0.1, 999),
      result.tempoBeatUnit,
    );
  }
  const key = /1\s*=\s*([#♯b♭]?[A-G])/i.exec(text);
  if (key) result.fifths = keyToFifths(key[1]);

  for (const line of text.replace(/\r/g, "").split("\n")) {
    result.title ||= directiveValue(line, "标题|Title");
    result.subtitle ||= directiveValue(line, "副标题|SubTitle");
    result.composer ||= directiveValue(line, "作曲|Composer");
    result.arranger ||= directiveValue(line, "编曲|Arranger");
    result.lyricist ||= directiveValue(line, "作词|Lyricist");
    result.instrumentName ||= directiveValue(line, "乐器|Instrument");
    const space = /^\s*空格\s*[=：:]\s*(.*?)\s*$/.exec(line);
    if (space) result.spaceDivision = divisionFromText(space[1]);
    const note = /^\s*(?:音符|音)自身时值\s*[=：:]\s*(.*?)\s*$/.exec(line);
    if (note) result.noteDivision = divisionFromText(note[1]);
    const dot = /^\s*点(?:号)?\s*[=：:]\s*(.*?)\s*$/.exec(line);
    if (dot) {
      const division = divisionFromText(dot[1]);
      if (division) result.mappings["."] = division;
    }
    const doubleDot = /^\s*两个点\s*[=：:]\s*(.*?)\s*$/.exec(line);
    if (doubleDot) {
      const combined = divisionFromText(doubleDot[1]);
      if (combined && combined < 64) result.mappings["."] = (combined * 2) as SlashDurationDivision;
    }
    const symbol = /^\s*符号\s*[（(](.*?)[）)]\s*[=：:]\s*(.*?)\s*$/.exec(line);
    if (symbol) {
      const division = divisionFromText(symbol[2]);
      const glyph = symbol[1] === "空格" ? " " : Array.from(symbol[1])[0];
      if (division && glyph) {
        if (glyph === " ") result.spaceDivision = division;
        else result.mappings[glyph] = division;
      }
    }
    const groupMode = (label: "花括号" | "方括号"): SlashGroupMode | null => {
      if (!line.includes(label)) return null;
      if (/(?:留空|忽略|不使用|无特殊功能)/.test(line)) return "none";
      if (/倚音/.test(line)) return "grace";
      if (/琶音/.test(line)) return "arpeggio";
      if (/三连音/.test(line)) return "triplet";
      if (/(?:细分|计拍|最低)/.test(line)) return "subdivide";
      return null;
    };
    result.braceMode = groupMode("花括号") ?? result.braceMode;
    result.bracketMode = groupMode("方括号") ?? result.bracketMode;
  }
  const stored = /(?:^|\n)\s*\/\/\s*@jpeditor\s+(\{[^\n]*\})\s*(?:\n|$)/.exec(text);
  if (stored) {
    try {
      type Stored = Partial<SlashScoreOptions> & {
        vc?: number; i?: string;
        k?: "k" | "n"; n?: string; u?: string; c?: string; a?: string; l?: string;
        bpm?: number; f?: number; m?: [number, number]; s?: Record<string, SlashDurationDivision>;
        bu?: TempoBeatUnit;
        sp?: SlashDurationDivision | null; nd?: SlashDurationDivision | null;
        b?: "n" | "g" | "s" | "a" | "t"; q?: "n" | "g" | "s" | "a" | "t";
        tm?: SlashTempoMark[];
      };
      const value = JSON.parse(stored[1]) as Stored;
      const storedKind = value.kind ?? (value.k === "k" ? "keyboard" : value.k === "n" ? "number" : undefined);
      if (storedKind === "keyboard" || storedKind === "number") result.kind = storedKind;
      const storedVoiceCount = value.voiceCount ?? value.vc;
      if (Number.isFinite(storedVoiceCount)) {
        result.voiceCount = clamp(Math.round(storedVoiceCount!), 1, MAX_SLASH_VOICES);
      }
      const storedBeats = value.beats ?? value.m?.[0];
      const storedBeatType = value.beatType ?? value.m?.[1];
      if (Number.isFinite(storedBeats) && storedBeats! >= 1) result.beats = clamp(Math.round(storedBeats!), 1, 32);
      if ([2, 4, 8, 16].includes(storedBeatType ?? 0)) result.beatType = storedBeatType!;
      const storedTempo = value.tempoBpm ?? value.bpm;
      const storedTempoUnit = value.tempoBeatUnit ?? value.bu;
      const storedFifths = value.fifths ?? value.f;
      if (Number.isFinite(storedTempo)) {
        result.tempoBpm = clamp(Math.round(storedTempo! * 10) / 10, 0.1, 999);
      }
      if (storedTempoUnit === "quarter"
        || storedTempoUnit === "dotted-quarter"
        || storedTempoUnit === "eighth") {
        result.tempoBeatUnit = storedTempoUnit;
      }
      if (Number.isFinite(storedFifths)) result.fifths = clamp(Math.round(storedFifths!), -7, 7);
      if (typeof (value.title ?? value.n) === "string") result.title = value.title ?? value.n ?? "";
      if (typeof (value.subtitle ?? value.u) === "string") result.subtitle = value.subtitle ?? value.u ?? "";
      if (typeof (value.composer ?? value.c) === "string") result.composer = value.composer ?? value.c ?? "";
      if (typeof (value.arranger ?? value.a) === "string") result.arranger = value.arranger ?? value.a ?? "";
      if (typeof (value.lyricist ?? value.l) === "string") result.lyricist = value.lyricist ?? value.l ?? "";
      if (typeof (value.instrumentName ?? value.i) === "string") {
        result.instrumentName = value.instrumentName ?? value.i ?? "";
      }
      const storedMappings = value.symbolDurations ?? value.s;
      if (storedMappings && typeof storedMappings === "object") {
        result.mappings = {};
        for (const [symbol, division] of Object.entries(storedMappings)) {
          if (symbol && DIVISIONS.includes(division as SlashDurationDivision)) result.mappings[symbol] = division as SlashDurationDivision;
        }
      }
      const storedSpace = value.spaceDivision !== undefined ? value.spaceDivision : value.sp;
      if (storedSpace === null || DIVISIONS.includes(storedSpace as SlashDurationDivision)) {
        result.spaceDivision = storedSpace as SlashDurationDivision | null;
      }
      const storedNote = value.noteDivision !== undefined ? value.noteDivision : value.nd;
      if (storedNote === null || DIVISIONS.includes(storedNote as SlashDurationDivision)) {
        result.noteDivision = storedNote as SlashDurationDivision | null;
      }
      const compactMode = (value: unknown): SlashGroupMode | undefined =>
        value === "n" ? "none"
          : value === "g" ? "grace"
          : value === "s" ? "subdivide"
            : value === "a" ? "arpeggio"
              : value === "t" ? "triplet"
                : undefined;
      const validMode = (value: unknown): value is SlashGroupMode =>
        value === "none" || value === "grace" || value === "subdivide"
        || value === "arpeggio" || value === "triplet";
      const storedBrace = value.braceMode ?? compactMode(value.b);
      const storedBracket = value.bracketMode ?? compactMode(value.q);
      if (validMode(storedBrace)) result.braceMode = storedBrace;
      if (validMode(storedBracket)) result.bracketMode = storedBracket;
      const storedTempoMarks = value.tempoMarks ?? value.tm;
      if (Array.isArray(storedTempoMarks)) {
        result.tempoMarks = storedTempoMarks.flatMap((mark) => {
          if (!mark || typeof mark !== "object") return [];
          const measure = Math.round(Number(mark.measure));
          const offset = Number(mark.offset);
          const kind = mark.kind;
          const bpm = mark.bpm === null ? null : Math.round(Number(mark.bpm));
          if (!Number.isFinite(measure) || measure < 0 || !Number.isFinite(offset) || offset < 0) return [];
          if (kind !== "accel" && kind !== "rit" && kind !== "tempo") return [];
          if (kind === "tempo" && (!Number.isFinite(bpm) || (bpm ?? 0) < 1)) return [];
          return [{ measure, offset, kind, bpm }];
        });
      }
    } catch {
      // A damaged settings comment is ordinary ignored text; natural-language directives still work.
    }
  }
  return result;
}

function detectKind(text: string, lines: SourceLines, directive: Directives): SlashScoreKind {
  if (directive.kind) return directive.kind;
  const joined = lines.score.join("\n").replace(LINE_TAG_RE, "");
  const keyboardCount = (joined.match(/[A-Z]/g) ?? []).length;
  const numberCount = (joined.match(/[1-7]/g) ?? []).length;
  if (/键盘/i.test(text)) return "keyboard";
  if (/数字/i.test(text)) return "number";
  return keyboardCount > numberCount ? "keyboard" : "number";
}

function observedSymbols(lines: string[]): { symbols: string[]; spaces: boolean } {
  const found = new Set<string>();
  let spaces = false;
  for (const line of lines) {
    for (const char of Array.from(line)) {
      if (char === " ") { spaces = true; continue; }
      if (/\s/.test(char)) continue;
      if (char === SLASH_VOICE_SEPARATOR) continue;
      if (/[A-Za-z0-9+\-#♭♯/(){}[\],']/.test(char)) continue;
      found.add(char);
    }
  }
  return { symbols: [...found], spaces };
}

function defaultDivisionForSymbol(symbol: string): SlashDurationDivision {
  if (symbol === "." || symbol === "=") return 8;
  if (symbol === "_") return 16;
  if (symbol === "*") return 32;
  if (symbol === "~") return 64;
  return 16;
}

function effectiveMappings(options: Pick<SlashScoreOptions, "symbolDurations" | "spaceDivision">): Record<string, SlashDurationDivision> {
  const mappings = { ...options.symbolDurations };
  if (options.spaceDivision) mappings[" "] = options.spaceDivision;
  else delete mappings[" "];
  return mappings;
}

function segmentMarkerDuration(
  segment: string,
  mappings: Record<string, SlashDurationDivision>,
  braceMode: SlashBraceMode,
  noteDivision: SlashDurationDivision | null = null,
  bracketMode: SlashGroupMode = "triplet",
): number {
  let duration = 0;
  const finest = Math.max(4, noteDivision ?? 4, ...Object.values(mappings));
  const braceUnit = Math.max(4 / 64, (4 / finest) / 2);
  const noteUnit = noteDivision ? 4 / noteDivision : 0;
  const modeFor = (opening: string): SlashGroupMode =>
    opening === "{" ? braceMode : bracketMode;
  const closingFor = (opening: string): string => opening === "{" ? "}" : "]";

  for (let index = 0; index < segment.length;) {
    const char = segment[index];
    if (char === "{" || char === "[") {
      const end = segment.indexOf(closingFor(char), index + 1);
      if (end < 0) { index++; continue; }
      const content = segment.slice(index + 1, end);
      const mode = modeFor(char);
      const nominal = segmentMarkerDuration(content, mappings, "subdivide", noteDivision, "subdivide");
      const atomCount = braceAtomsText(content).length;
      if (mode === "triplet") {
        duration += (nominal > 1e-8 ? nominal : atomCount * (noteUnit || braceUnit)) * 2 / 3;
      } else if (mode === "subdivide" || mode === "none") {
        duration += nominal > 1e-8 ? nominal : atomCount * braceUnit;
      }
      // Grace notes and arpeggio signs decorate an adjacent sounding event;
      // their own contents do not lengthen the measure.
      index = end + 1;
      continue;
    }
    if (char === "(") {
      const end = segment.indexOf(")", index + 1);
      if (end >= 0) {
        if (noteUnit > 0 && /[A-Z1-7]/.test(segment.slice(index + 1, end))) duration += noteUnit;
        index = end + 1;
        continue;
      }
    }
    const division = mappings[char];
    if (division) duration += 4 / division;
    else if (noteUnit > 0 && /[A-Z1-7]/.test(char)) duration += noteUnit;
    index++;
  }
  return duration;
}

/** Count sounding atoms without needing key/fifths conversion. */
function braceAtomsText(text: string): string[] {
  const atoms: string[] = [];
  for (let index = 0; index < text.length;) {
    if (text[index] === "(") {
      const end = text.indexOf(")", index + 1);
      if (end >= 0) {
        if (/[A-Z1-7]/.test(text.slice(index + 1, end))) atoms.push(text.slice(index, end + 1));
        index = end + 1;
        continue;
      }
    }
    if (/[A-Z1-7]/.test(text[index])) atoms.push(text[index]);
    index++;
  }
  return atoms;
}

function splitGroups(line: string): string[] {
  const groups = line.split("/");
  while (groups.length > 0 && groups[groups.length - 1].trim() === "") groups.pop();
  return groups;
}

function groupsForMeter(meter: SlashMeterSuggestion): number {
  // `/` separates beat groups. Compound meters group three eighth notes into
  // one dotted-quarter beat; simple meters use one group per written beat.
  // Do not derive this count from how many duration marks happen to follow a
  // note: a short note plus silence still occupies its complete slash group.
  return meter.beatType === 8 && meter.beats >= 6 && meter.beats % 3 === 0 ? meter.beats / 3 : meter.beats;
}

export function inferSlashMeter(
  text: string,
  symbolDurations: Record<string, SlashDurationDivision>,
  spaceDivision: SlashDurationDivision | null,
  braceMode: SlashBraceMode,
  noteDivision: SlashDurationDivision | null = null,
  bracketMode: SlashGroupMode = "triplet",
  kind?: SlashScoreKind,
): SlashMeterSuggestion {
  const directive = readDirectives(text);
  const allLines = sourceLines(text);
  const selectedKind = kind ?? detectKind(text, allLines, directive);
  const lines = sourceLines(text, selectedKind);
  const mappings = effectiveMappings({ symbolDurations, spaceDivision });
  const groupCounts = lines.score.map((line) => splitGroups(line).length).filter((count) => count > 0);
  const groupsPerMeasure = mode(groupCounts, 4);
  const durations: number[] = [];
  for (const line of lines.score) {
    for (const group of splitGroups(line)) {
      const duration = segmentMarkerDuration(group, mappings, braceMode, noteDivision, bracketMode);
      if (duration > 1e-8) durations.push(duration);
    }
  }
  const groupQuarterNotes = median(durations) || 1;
  if (directive.beats && directive.beatType) {
    return {
      beats: directive.beats,
      beatType: directive.beatType,
      groupsPerMeasure,
      groupQuarterNotes,
      explicit: true,
    };
  }

  const total = groupQuarterNotes * groupsPerMeasure;
  let best = { beats: 4, beatType: 4, score: Infinity };
  for (const beatType of [4, 8, 16, 2]) {
    for (let beats = 1; beats <= 32; beats++) {
      const measure = beats * 4 / beatType;
      let score = Math.abs(measure - total) * 20;
      const expectedGroups = beatType === 8 && beats >= 6 && beats % 3 === 0 ? beats / 3 : beats;
      score += Math.abs(expectedGroups - groupsPerMeasure) * 1.5;
      if (beatType === 4 && Math.abs(groupQuarterNotes - 1) < 0.08 && beats === groupsPerMeasure) score -= 4;
      if (beatType === 8 && beats % 3 === 0 && Math.abs(groupQuarterNotes - 1.5) < 0.08 && beats === groupsPerMeasure * 3) score -= 6;
      if (beatType === 8 && Math.abs(groupQuarterNotes - 0.5) < 0.08 && beats === groupsPerMeasure) score -= 4;
      if (score < best.score) best = { beats, beatType, score };
    }
  }
  return { beats: best.beats, beatType: best.beatType, groupsPerMeasure, groupQuarterNotes, explicit: false };
}

export function analyzeSlashScore(text: string): SlashScoreAnalysis {
  const directive = readDirectives(text);
  const allLines = sourceLines(text);
  const detectedKind = detectKind(text, allLines, directive);
  const lines = sourceLines(text, detectedKind);
  const observed = observedSymbols(lines.score);
  const suggestedMappings: Record<string, SlashDurationDivision> = {};
  for (const symbol of observed.symbols) {
    suggestedMappings[symbol] = directive.mappings[symbol] ?? defaultDivisionForSymbol(symbol);
  }
  for (const [symbol, division] of Object.entries(directive.mappings)) suggestedMappings[symbol] = division;
  if (Object.keys(suggestedMappings).length === 0) suggestedMappings["."] = 8;
  const spaceDivision = directive.spaceDivision ?? null;
  const noteDivision = directive.noteDivision ?? null;
  const braceMode = directive.braceMode ?? "grace";
  const bracketMode = directive.bracketMode ?? "triplet";
  let meter = inferSlashMeter(
    text,
    suggestedMappings,
    spaceDivision,
    braceMode,
    noteDivision,
    bracketMode,
    detectedKind,
  );
  const rawGroupCount = lines.score.length === 1 ? splitGroups(lines.score[0]).length : 0;
  // A single unbroken run that would imply an unusually long simple meter is
  // more likely several measures without line/bar separators. Ask for a meter
  // in the dialog and use common 4/4 as the editable starting point.
  if (!meter.explicit && lines.score.length === 1 && meter.beatType === 4 && meter.beats > 6) {
    meter = { ...meter, beats: 4, beatType: 4, groupsPerMeasure: 4 };
  }
  const expectedGroups = groupsForMeter(meter);
  const firstGroupCount = rawGroupCount;
  const measureLength = meter.beats * 4 / meter.beatType;
  const wholeMeasureGroups = slashGroupsUseWholeMeasures(
    lines.score,
    { symbolDurations: suggestedMappings, spaceDivision, noteDivision, braceMode, bracketMode },
    measureLength / Math.max(1, expectedGroups),
    measureLength,
  );
  const continuous = lines.score.length === 1 && (wholeMeasureGroups ? firstGroupCount > 1 : firstGroupCount > expectedGroups);
  const measureCount = wholeMeasureGroups
    ? lines.score.reduce((sum, line) => sum + splitGroups(line).length, 0)
    : continuous ? Math.ceil(firstGroupCount / expectedGroups) : lines.score.length;
  const voiceCount = directive.voiceCount ?? inferSlashVoiceCount(text, detectedKind);
  return {
    detectedKind,
    voiceCount,
    measureCount,
    commentCount: lines.comments.length,
    ignoredTagCount: lines.ignoredTags,
    observedSymbols: observed.symbols,
    containsScoreSpaces: observed.spaces,
    suggestedMappings,
    suggestedSpaceDivision: spaceDivision,
    suggestedNoteDivision: noteDivision,
    meter,
    tempoBpm: directive.tempoBpm ?? 90,
    tempoBeatUnit: directive.tempoBeatUnit ?? "quarter",
    fifths: directive.fifths ?? 0,
    title: directive.title,
    subtitle: directive.subtitle,
    composer: directive.composer,
    arranger: directive.arranger,
    lyricist: directive.lyricist,
    suggestedBraceMode: braceMode,
    suggestedBracketMode: bracketMode,
    tempoMarks: directive.tempoMarks,
    continuous,
  };
}

export function defaultSlashScoreOptions(kind: SlashScoreKind, analysis?: SlashScoreAnalysis): SlashScoreOptions {
  return {
    kind,
    voiceCount: analysis?.voiceCount ?? 1,
    instrumentName: "钢琴",
    title: analysis?.title ?? "",
    subtitle: analysis?.subtitle ?? "",
    composer: analysis?.composer ?? "",
    arranger: analysis?.arranger ?? "",
    lyricist: analysis?.lyricist ?? "",
    tempoBpm: analysis?.tempoBpm ?? 90,
    tempoBeatUnit: analysis?.tempoBeatUnit ?? "quarter",
    fifths: analysis?.fifths ?? 0,
    beats: analysis?.meter.beats ?? 4,
    beatType: analysis?.meter.beatType ?? 4,
    symbolDurations: { ...(analysis?.suggestedMappings ?? { ".": 8 }) },
    spaceDivision: analysis?.suggestedSpaceDivision ?? null,
    noteDivision: analysis?.suggestedNoteDivision ?? null,
    braceMode: analysis?.suggestedBraceMode ?? "grace",
    bracketMode: analysis?.suggestedBracketMode ?? "triplet",
    tempoMarks: analysis?.tempoMarks.map((mark) => ({ ...mark })) ?? [],
  };
}

function tonicPitch(fifths: number): number {
  // JPW deliberately places tonic A/B (and their flat spellings) below
  // middle C, so one octave of numbered notation remains centred around C4.
  // Using only the pitch class here made `1=A` serialize as `-1`, even though
  // the source JPW pitch and the generated preview sounded the same.
  const key = MusicCommon.keys[clamp(Math.round(fifths) + 7, 0, MusicCommon.keys.length - 1)];
  return MusicCommon.getBasePitch(key);
}

function keyboardPitchAt(text: string, at: number, fifths: number): PitchToken | null {
  let index = at;
  let accidental = 0;
  if (text[index] === "#" || text[index] === "♯") { accidental = 1; index++; }
  else if (text[index] === "b" || text[index] === "♭") { accidental = -1; index++; }
  let extraOctave = 0;
  while (text[index] === "," || text[index] === "'") {
    extraOctave += text[index] === "'" ? 1 : -1;
    index++;
  }
  const letter = text[index]?.toUpperCase();
  if (!letter) return null;
  let row = -1;
  let degree = -1;
  for (let r = 0; r < KEYBOARD_ROWS.length; r++) {
    const found = KEYBOARD_ROWS[r].indexOf(letter);
    if (found >= 0) { row = r; degree = found; break; }
  }
  if (row < 0) return null;
  const octave = row - 1 + extraOctave;
  return { pitch: tonicPitch(fifths) + DEGREE_INTERVALS[degree] + octave * 12 + accidental, next: index + 1 };
}

function numberPitchAt(text: string, at: number, fifths: number): PitchToken | null {
  let index = at;
  let accidental = 0;
  if (text[index] === "#" || text[index] === "♯") { accidental = 1; index++; }
  else if (text[index] === "b" || text[index] === "♭") { accidental = -1; index++; }
  let octave = 0;
  while (text[index] === "+" || text[index] === "-") {
    octave += text[index] === "+" ? 1 : -1;
    index++;
  }
  const digit = text[index];
  if (!/[1-7]/.test(digit ?? "")) return null;
  const degree = parseInt(digit, 10) - 1;
  return { pitch: tonicPitch(fifths) + DEGREE_INTERVALS[degree] + octave * 12 + accidental, next: index + 1 };
}

function pitchAt(text: string, at: number, options: SlashScoreOptions): PitchToken | null {
  return options.kind === "keyboard" ? keyboardPitchAt(text, at, options.fifths) : numberPitchAt(text, at, options.fifths);
}

/**
 * Locate every playable pitch in accepted score lines without rewriting the
 * user's TXT.  The returned absolute ranges let the rendered single-staff
 * score select and edit its exact keyboard/number source spelling.
 */
export function slashPitchSources(text: string, baseOptions: SlashScoreOptions): SlashPitchSource[] {
  const options = optionsWithDirectives(text, baseOptions);
  const mappings = effectiveMappings(options);
  const result: SlashPitchSource[] = [];
  const lineRecords = sourceLineRecords(text);
  const selectedLineStarts = new Set(lineRecords
    .filter((_record, index) => selectedScoreLine(lineRecords, index, options.kind))
    .map((record) => record.from));
  let eventIndex = 0;
  let lineFrom = text.startsWith("\uFEFF") ? 1 : 0;

  while (lineFrom <= text.length) {
    let lineTo = lineFrom;
    while (lineTo < text.length && text[lineTo] !== "\r" && text[lineTo] !== "\n") lineTo++;
    const raw = text.slice(lineFrom, lineTo);
    if (selectedLineStarts.has(lineFrom)) {
      const tagRanges = [...raw.matchAll(/\[(?:line|end)\s*\d+\s*\]/gi)]
        .map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length] as const);
      const tagAt = (index: number): readonly [number, number] | undefined =>
        tagRanges.find(([from, to]) => index >= from && index < to);

      const appendRange = (
        from: number,
        to: number,
        sharedEvent: number,
        grace = false,
      ): void => {
        for (let index = from; index < to;) {
          const tag = tagAt(index);
          if (tag) { index = tag[1]; continue; }
          const token = pitchAt(raw, index, options);
          if (!token || token.next > to) { index++; continue; }
          let markerFrom = index;
          while (markerFrom > 0 && raw[markerFrom - 1] === SLASH_VOICE_SEPARATOR) markerFrom--;
          const markerCount = index - markerFrom;
          result.push({
            from: lineFrom + index,
            to: lineFrom + token.next,
            pitch: clamp(token.pitch, 0, 127),
            eventIndex: sharedEvent,
            grace,
            voiceIndex: markerCount > 0
              ? clamp(markerCount, 1, options.voiceCount)
              : options.voiceCount,
            markerFrom: lineFrom + markerFrom,
            markerCount,
          });
          index = token.next;
        }
      };
      let pendingArpeggioEvent: number | null = null;
      let mergeableEvent: number | null = null;
      const finishPendingArpeggio = (): void => {
        if (pendingArpeggioEvent === null) return;
        eventIndex = Math.max(eventIndex, pendingArpeggioEvent + 1);
        mergeableEvent = pendingArpeggioEvent;
        pendingArpeggioEvent = null;
      };
      const eventForAtom = (): number => {
        const sharedEvent = pendingArpeggioEvent ?? eventIndex;
        if (pendingArpeggioEvent !== null) {
          eventIndex = Math.max(eventIndex, sharedEvent + 1);
          pendingArpeggioEvent = null;
        } else {
          eventIndex++;
        }
        mergeableEvent = sharedEvent;
        return sharedEvent;
      };

      for (let index = 0; index < raw.length;) {
        const tag = tagAt(index);
        if (tag) {
          finishPendingArpeggio();
          mergeableEvent = null;
          index = tag[1];
          continue;
        }
        if (raw[index] === "{" || raw[index] === "[") {
          const closing = raw[index] === "{" ? "}" : "]";
          const mode = raw[index] === "{" ? options.braceMode : options.bracketMode ?? "triplet";
          const end = raw.indexOf(closing, index + 1);
          if (end >= 0 && mode === "arpeggio") {
            const sharedEvent: number = mergeableEvent ?? pendingArpeggioEvent ?? eventIndex;
            appendRange(index + 1, end, sharedEvent);
            if (mergeableEvent === null && pendingArpeggioEvent === null) {
              pendingArpeggioEvent = sharedEvent;
            }
            mergeableEvent = sharedEvent;
            index = end + 1;
            continue;
          }
          // Grace notes are rendered as decorations on the following chord,
          // not as normal score entries.  Retain their exact source ranges,
          // but share the upcoming event index so they cannot consume the
          // following main-note mapping.
          if (end >= 0 && mode === "grace") {
            appendRange(index + 1, end, pendingArpeggioEvent ?? eventIndex, true);
            index = end + 1;
            continue;
          }
        }
        if (raw[index] === "(") {
          const end = raw.indexOf(")", index + 1);
          if (end >= 0) {
            appendRange(index + 1, end, eventForAtom());
            index = end + 1;
            continue;
          }
        }
        const token = pitchAt(raw, index, options);
        if (!token) {
          const char = raw[index];
          if (char !== SLASH_VOICE_SEPARATOR && !(/\s/.test(char) && !mappings[char])) {
            finishPendingArpeggio();
            mergeableEvent = null;
          }
          index++;
          continue;
        }
        let markerFrom = index;
        while (markerFrom > 0 && raw[markerFrom - 1] === SLASH_VOICE_SEPARATOR) markerFrom--;
        const markerCount = index - markerFrom;
        result.push({
          from: lineFrom + index,
          to: lineFrom + token.next,
          pitch: clamp(token.pitch, 0, 127),
          eventIndex: eventForAtom(),
          grace: false,
          voiceIndex: markerCount > 0
            ? clamp(markerCount, 1, options.voiceCount)
            : options.voiceCount,
          markerFrom: lineFrom + markerFrom,
          markerCount,
        });
        index = token.next;
        continue;
      }
      finishPendingArpeggio();
    }
    if (lineTo >= text.length) break;
    lineFrom = lineTo + (text[lineTo] === "\r" && text[lineTo + 1] === "\n" ? 2 : 1);
  }
  return result;
}

function pitchesIn(text: string, options: SlashScoreOptions): number[] {
  const pitches: number[] = [];
  for (let index = 0; index < text.length;) {
    const token = pitchAt(text, index, options);
    if (token) {
      pitches.push(clamp(token.pitch, 0, 127));
      index = token.next;
    } else {
      index++;
    }
  }
  return [...new Set(pitches)];
}

interface TimedAtom {
  pitches: number[];
  nominalDuration: number;
}

function timedContainerAtoms(text: string, options: SlashScoreOptions, fallback: number): TimedAtom[] {
  const mappings = effectiveMappings(options);
  const noteUnit = options.noteDivision ? 4 / options.noteDivision : 0;
  const atoms: TimedAtom[] = [];
  const state: { active: TimedAtom | null } = { active: null };
  let leadingDuration = 0;

  const start = (pitches: number[]): void => {
    if (state.active) {
      if (state.active.nominalDuration <= 1e-9) state.active.nominalDuration = fallback;
      atoms.push(state.active);
    }
    state.active = { pitches, nominalDuration: noteUnit + leadingDuration };
    leadingDuration = 0;
  };

  for (let index = 0; index < text.length;) {
    const division = mappings[text[index]];
    if (division) {
      const amount = 4 / division;
      if (state.active) state.active.nominalDuration += amount;
      else leadingDuration += amount;
      index++;
      continue;
    }
    if (text[index] === "(") {
      const end = text.indexOf(")", index + 1);
      if (end >= 0) {
        const chord = pitchesIn(text.slice(index + 1, end), options);
        if (chord.length) start(chord);
        index = end + 1;
        continue;
      }
    }
    const pitch = pitchAt(text, index, options);
    if (pitch) {
      start([clamp(pitch.pitch, 0, 127)]);
      index = pitch.next;
      continue;
    }
    index++;
  }
  if (state.active) {
    if (state.active.nominalDuration <= 1e-9) state.active.nominalDuration = fallback;
    atoms.push(state.active);
  }
  if (leadingDuration > 1e-9 && atoms.length > 0) atoms[0].nominalDuration += leadingDuration;
  return atoms;
}

function isRestOnlyGroup(group: string, options: SlashScoreOptions): boolean {
  // A slash group containing a rest marker and no playable pitch is a full
  // empty beat/group. Whitespace and duration markers around `-` therefore do
  // not change `-`, ` - ` or `-....` into sounding material. Numeric octave
  // prefixes such as `-1` remain notes because pitchesIn() finds their pitch.
  const hasRestMarker = group.includes("-") || group.includes("0");
  return hasRestMarker && pitchesIn(group, options).length === 0;
}

function groupHasContent(group: string, options: SlashScoreOptions): boolean {
  return isRestOnlyGroup(group, options) || pitchesIn(group, options).length > 0 || /[{}]/.test(group);
}

function parseGroup(
  group: string,
  absoluteStart: number,
  targetDuration: number,
  options: SlashScoreOptions,
  events: TimedEvent[],
  previousEvent: TimedEvent | null,
): { clipped: boolean; ignored: number; lastEvent: TimedEvent | null } {
  if (isRestOnlyGroup(group, options)) return { clipped: false, ignored: 0, lastEvent: null };
  const mappings = effectiveMappings(options);
  const finest = Math.max(4, options.noteDivision ?? 4, ...Object.values(mappings));
  const minimumUnit = 4 / finest;
  const braceUnit = Math.max(4 / 64, minimumUnit / 2);
  const noteUnit = options.noteDivision ? 4 / options.noteDivision : null;
  let cursor = 0;
  let ignored = 0;
  let clipped = false;
  let unattachedDuration = 0;
  let lastEvent: TimedEvent | null = null;
  let pendingGrace: TimedAtom[] = [];
  let active: {
    start: number;
    pitches: number[];
    hadDuration: boolean;
    continuationOf: TimedEvent | null;
    gracePitches: number[][];
    arpeggio: boolean;
    arpeggioPitches: number[];
    awaitingArpeggioMain: boolean;
  } | null = null;

  const flush = (end: number, fillIfEmpty = false): void => {
    if (!active) return;
    let finish = end;
    if (finish <= active.start + 1e-9 && fillIfEmpty) finish = Math.min(targetDuration, active.start + minimumUnit);
    if (finish > active.start + 1e-9) {
      const event: TimedEvent = {
        start: absoluteStart + active.start,
        end: absoluteStart + Math.min(targetDuration, finish),
        pitches: active.pitches,
      };
      if (active.continuationOf) event.continuationOf = active.continuationOf;
      if (active.gracePitches.length > 0) event.gracePitches = active.gracePitches;
      if (active.arpeggio) event.arpeggio = true;
      if (active.arpeggioPitches.length > 0) {
        event.arpeggioPitches = [...active.arpeggioPitches];
      }
      events.push(event);
      lastEvent = event;
    }
    active = null;
  };

  const applyIntrinsicDuration = (): void => {
    if (!active || noteUnit === null) return;
    const finish = cursor + noteUnit;
    if (finish > targetDuration + 1e-8) clipped = true;
    cursor = Math.min(targetDuration, finish);
    active.hadDuration = true;
  };

  const startNote = (pitches: number[], deferIntrinsicDuration = false): void => {
    if (active?.awaitingArpeggioMain && !active.hadDuration) {
      active.pitches = [...new Set([...active.pitches, ...pitches])];
      active.awaitingArpeggioMain = false;
      if (pendingGrace.length > 0) {
        active.gracePitches.push(...pendingGrace.map((atom) => atom.pitches));
        pendingGrace = [];
      }
      if (!deferIntrinsicDuration) applyIntrinsicDuration();
      return;
    }
    if (active) {
      if (!active.hadDuration) {
        const finish = Math.min(targetDuration, cursor + minimumUnit);
        flush(finish, true);
        cursor = finish;
      } else {
        flush(cursor);
      }
    }
    const gracePitches = pendingGrace.map((atom) => atom.pitches);
    pendingGrace = [];
    active = {
      start: Math.max(0, cursor - unattachedDuration),
      pitches,
      hadDuration: unattachedDuration > 1e-9,
      continuationOf: null,
      gracePitches,
      arpeggio: false,
      arpeggioPitches: [],
      awaitingArpeggioMain: false,
    };
    unattachedDuration = 0;
    if (!deferIntrinsicDuration) applyIntrinsicDuration();
  };

  for (let index = 0; index < group.length;) {
    const char = group[index];
    const division = mappings[char];
    if (division) {
      // A duration mark immediately after `/` belongs to the preceding sound
      // when that sound reaches the group boundary.  Keep a separate faint
      // chord at the new rhythmic position so the notation exposes the grid.
      if (!active && cursor <= 1e-9 && previousEvent &&
          Math.abs(previousEvent.end - absoluteStart) <= 1e-8) {
        active = {
          start: 0,
          pitches: [...previousEvent.pitches],
          hadDuration: false,
          continuationOf: previousEvent,
          gracePitches: [],
          arpeggio: false,
          arpeggioPitches: [],
          awaitingArpeggioMain: false,
        };
      }
      const amount = 4 / division;
      const before = cursor;
      cursor = Math.min(targetDuration, cursor + amount);
      const current = active as {
        start: number;
        pitches: number[];
        hadDuration: boolean;
        continuationOf: TimedEvent | null;
      } | null;
      if (current) current.hadDuration = true;
      else unattachedDuration += cursor - before;
      if (before + amount > targetDuration + 1e-8) clipped = true;
      index++;
      continue;
    }
    if (/\s/.test(char) || char === SLASH_VOICE_SEPARATOR) { index++; continue; }
    if (char === "{" || char === "[") {
      const closing = char === "{" ? "}" : "]";
      const mode = char === "{" ? options.braceMode : options.bracketMode ?? "triplet";
      const end = group.indexOf(closing, index + 1);
      if (end < 0) { ignored++; index++; continue; }
      const atoms = timedContainerAtoms(group.slice(index + 1, end), options, braceUnit);
      if (mode === "grace") {
        if (active) flush(cursor, true);
        pendingGrace.push(...atoms);
      } else if (mode === "arpeggio") {
        const rolledChord = [...new Set(atoms.flatMap((atom) => atom.pitches))];
        if (rolledChord.length > 0) {
          if (active && !active.hadDuration) {
            const stillAwaitingMain = active.awaitingArpeggioMain;
            active.pitches = [...new Set([...active.pitches, ...rolledChord])];
            active.arpeggio = true;
            active.arpeggioPitches = [...new Set([...active.arpeggioPitches, ...rolledChord])];
            active.awaitingArpeggioMain = stillAwaitingMain;
          } else {
            if (active) flush(cursor, true);
            startNote(rolledChord, true);
            if (active) {
              active.arpeggio = true;
              active.arpeggioPitches = [...rolledChord];
              active.awaitingArpeggioMain = true;
            }
          }
        }
      } else {
        if (active) flush(cursor, true);
        const factor = mode === "triplet" ? 2 / 3 : 1;
        for (const atom of atoms) {
          const duration = atom.nominalDuration * factor;
          const start = cursor;
          const finish = Math.min(targetDuration, start + duration);
          if (finish > start + 1e-9) {
            const event: TimedEvent = {
              start: absoluteStart + start,
              end: absoluteStart + finish,
              pitches: atom.pitches,
            };
            events.push(event);
            lastEvent = event;
          }
          if (start + duration > targetDuration + 1e-8) clipped = true;
          cursor = finish;
        }
      }
      index = end + 1;
      continue;
    }
    if (char === "(") {
      const end = group.indexOf(")", index + 1);
      if (end >= 0) {
        const pitches = pitchesIn(group.slice(index + 1, end), options);
        if (pitches.length) startNote(pitches);
        index = end + 1;
        continue;
      }
    }
    const pitch = pitchAt(group, index, options);
    if (pitch) {
      startNote([clamp(pitch.pitch, 0, 127)]);
      index = pitch.next;
      continue;
    }
    if (char !== "/" && char !== "-" && char !== "0" && char !== SLASH_VOICE_SEPARATOR) ignored++;
    index++;
  }
  if (active?.awaitingArpeggioMain && !active.hadDuration && noteUnit !== null) {
    active.awaitingArpeggioMain = false;
    applyIntrinsicDuration();
  }
  const remaining = active as {
    start: number;
    pitches: number[];
    hadDuration: boolean;
    continuationOf: TimedEvent | null;
  } | null;
  if (remaining) {
    if (!remaining.hadDuration) flush(targetDuration, true);
    else flush(cursor);
  }
  if (pendingGrace.length > 0) {
    for (const atom of pendingGrace) {
      const finish = Math.min(targetDuration, cursor + braceUnit);
      if (finish <= cursor + 1e-9) break;
      const event: TimedEvent = {
        start: absoluteStart + cursor,
        end: absoluteStart + finish,
        pitches: atom.pitches,
      };
      events.push(event);
      lastEvent = event;
      cursor = finish;
    }
  }
  return { clipped, ignored, lastEvent };
}

function optionsWithDirectives(text: string, base: SlashScoreOptions): SlashScoreOptions {
  const directive = readDirectives(text);
  return {
    ...base,
    // The dialog is authoritative: directives only provide its initial values.
    // This lets a user deliberately reinterpret “点=八分” as 16th notes, or
    // supply a meter for a continuous score with no measure separators.
    kind: base.kind ?? directive.kind ?? "number",
    voiceCount: clamp(
      Math.round(base.voiceCount ?? directive.voiceCount ?? inferSlashVoiceCount(
        text,
        base.kind ?? directive.kind ?? undefined,
      )),
      1,
      MAX_SLASH_VOICES,
    ),
    instrumentName: base.instrumentName?.trim() || directive.instrumentName.trim() || "钢琴",
    title: base.title || directive.title,
    subtitle: base.subtitle || directive.subtitle,
    composer: base.composer || directive.composer,
    arranger: base.arranger || directive.arranger,
    lyricist: base.lyricist || directive.lyricist,
    tempoBpm: base.tempoBpm,
    tempoBeatUnit: base.tempoBeatUnit ?? directive.tempoBeatUnit ?? "quarter",
    fifths: base.fifths,
    beats: base.beats,
    beatType: base.beatType,
    symbolDurations: { ...base.symbolDurations },
    spaceDivision: base.spaceDivision,
    noteDivision: base.noteDivision,
    braceMode: base.braceMode,
    bracketMode: base.bracketMode ?? directive.bracketMode ?? "triplet",
    tempoMarks: base.tempoMarks ?? directive.tempoMarks,
  };
}

function splitTimedEventsByVoice(
  text: string,
  options: SlashScoreOptions,
  events: readonly TimedEvent[],
): TimedEvent[] {
  if (options.voiceCount <= 1) {
    return events.map((event) => ({ ...event, voiceIndex: 0 }));
  }
  const sourceGroups = new Map<number, SlashPitchSource[]>();
  for (const source of slashPitchSources(text, options)) {
    const group = sourceGroups.get(source.eventIndex) ?? [];
    group.push(source);
    sourceGroups.set(source.eventIndex, group);
  }
  const consumed = new Set<number>();
  const result: TimedEvent[] = [];
  let cursor = 0;
  for (const sources of sourceGroups.values()) {
    const main = sources.filter((source) => !source.grace);
    if (main.length === 0) continue;
    const expected = [...new Set(main.map((source) => source.pitch))].sort((a, b) => a - b);
    let matched = -1;
    for (let index = cursor; index < events.length; index++) {
      if (consumed.has(index) || events[index].continuationOf) continue;
      const actual = [...events[index].pitches].sort((a, b) => a - b);
      if (expected.every((pitch) => actual.includes(pitch))) {
        matched = index;
        break;
      }
    }
    if (matched < 0) {
      matched = events.findIndex((event, index) =>
        !consumed.has(index) && !event.continuationOf
        && expected.every((pitch) => event.pitches.includes(pitch)));
    }
    if (matched < 0) continue;
    consumed.add(matched);
    cursor = Math.max(cursor, matched + 1);
    const sourceEvent = events[matched];
    for (let voice = 1; voice <= options.voiceCount; voice++) {
      const pitches = [...new Set(main
        .filter((source) => source.voiceIndex === voice)
        .map((source) => source.pitch))];
      if (pitches.length === 0) continue;
      const gracePitches = sources
        .filter((source) => source.grace && source.voiceIndex === voice)
        .map((source) => [source.pitch]);
      const arpeggioPitches = sourceEvent.arpeggioPitches?.filter((pitch) => pitches.includes(pitch));
      result.push({
        ...sourceEvent,
        pitches,
        voiceIndex: voice - 1,
        continuationOf: undefined,
        gracePitches: gracePitches.length > 0 ? gracePitches : undefined,
        arpeggioPitches: arpeggioPitches?.length ? arpeggioPitches : undefined,
        arpeggio: Boolean(sourceEvent.arpeggio && arpeggioPitches?.length),
      });
    }
  }
  events.forEach((event, index) => {
    if (!consumed.has(index) && !event.continuationOf) {
      result.push({ ...event, voiceIndex: options.voiceCount - 1, continuationOf: undefined });
    }
  });
  return result.sort((left, right) =>
    left.start - right.start || (left.voiceIndex ?? 0) - (right.voiceIndex ?? 0));
}

function parsedMidiFromEvents(events: TimedEvent[], measures: number, options: SlashScoreOptions): ParsedMidi {
  const ppq = 960;
  const notes: ParsedMidiNote[] = [];
  const endQuarter = Math.max(1, measures * options.beats * 4 / options.beatType);
  if (options.voiceCount <= 1) {
    for (const event of events) {
      for (const pitch of event.pitches) {
        notes.push({
          startTick: Math.round(event.start * ppq),
          endTick: Math.max(Math.round(event.start * ppq) + 1, Math.round(event.end * ppq)),
          pitch,
          velocity: 88,
          channel: 0,
          track: 0,
        });
      }
    }
  } else {
    for (let voice = 0; voice < options.voiceCount; voice++) {
      const attacks = new Map<number, { start: number; pitches: Set<number> }>();
      for (const event of events) {
        if ((event.voiceIndex ?? options.voiceCount - 1) !== voice) continue;
        const key = Math.round(event.start * 192);
        const attack = attacks.get(key) ?? { start: event.start, pitches: new Set<number>() };
        for (const pitch of event.pitches) attack.pitches.add(pitch);
        attacks.set(key, attack);
      }
      const ordered = [...attacks.values()].sort((left, right) => left.start - right.start);
      ordered.forEach((attack, index) => {
        const end = ordered[index + 1]?.start ?? endQuarter;
        for (const pitch of attack.pitches) {
          notes.push({
            startTick: Math.round(attack.start * ppq),
            endTick: Math.max(Math.round(attack.start * ppq) + 1, Math.round(end * ppq)),
            pitch,
            velocity: 88,
            channel: voice,
            track: voice,
          });
        }
      });
    }
  }
  return {
    format: options.voiceCount > 1 ? 1 : 0,
    ppq,
    trackCount: options.voiceCount,
    title: options.title,
    tracks: Array.from({ length: options.voiceCount }, (_unused, voice) => ({
      index: voice,
      name: options.voiceCount > 1
        ? `${options.instrumentName?.trim() || "钢琴"} V${voice + 1}`
        : options.kind === "keyboard" ? "键盘谱" : "数字谱",
      noteCount: notes.filter((note) => note.track === voice).length,
    })),
    notes,
    tempos: [{ tick: 0, bpm: options.tempoBpm }],
    timeSignatures: [{ tick: 0, beats: options.beats, beatType: options.beatType }],
    keySignatures: [{ tick: 0, fifths: options.fifths, minor: false }],
    ignoredEvents: 0,
    endTick: Math.round(endQuarter * ppq),
  };
}

interface PositionedChord {
  chord: Chord;
  partIndex: number;
  start: number;
  end: number;
  pitches: number[];
}

function chordPitches(chord: Chord): number[] {
  return chord.notes.filter((note) => !note.rest).map((note) => note.pitch).sort((a, b) => a - b);
}

function equalPitches(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((pitch, index) => pitch === right[index]);
}

function linkContinuation(left: Chord, right: Chord): void {
  for (const next of right.notes) {
    const previous = left.notes.find((note) => !note.rest && note.pitch === next.pitch);
    if (!previous || next.rest) continue;
    previous.tieStart = true;
    previous.tieNext = next;
    next.tieEnd = true;
    next.tiePrev = previous;
  }
}

/** Re-apply slash-score continuation semantics after the MIDI quantizer built the editable Score. */
function applySlashContinuations(score: Score, events: readonly TimedEvent[]): void {
  const chords: PositionedChord[] = [];
  for (let partIndex = 0; partIndex < score.parts.length; partIndex++) {
    const part = score.parts[partIndex];
    for (const measure of part.measures) {
      const measureStart = measure.position.toFloat();
      for (const entry of measure.entries) {
        if (!(entry instanceof Chord) || entry.rest || !entry.duration) continue;
        const start = measureStart + entry.position.toFloat();
        chords.push({
          chord: entry,
          partIndex,
          start,
          end: start + entry.duration.toFloat(),
          pitches: chordPitches(entry),
        });
      }
    }
  }
  chords.sort((a, b) => a.start - b.start || a.end - b.end);

  const eventLastChord = new Map<TimedEvent, Chord>();
  for (const event of events) {
    const pitches = [...event.pitches].sort((a, b) => a - b);
    const matching = chords.filter((item) =>
      item.start >= event.start - 1e-8 &&
      item.start < event.end - 1e-8 &&
      item.end <= event.end + 1e-8 &&
      equalPitches(item.pitches, pitches));
    if (matching.length === 0) continue;

    if (event.continuationOf) {
      let previous = eventLastChord.get(event.continuationOf) ??
        [...chords].reverse().find((item) =>
          Math.abs(item.end - event.start) <= 1e-8 && equalPitches(item.pitches, pitches))?.chord ?? null;
      for (const item of matching) {
        item.chord.transparentContinuation = true;
        // A continuation split into several notated values is one tie chain,
        // not the generic slur used by the MIDI readability simplifier.
        item.chord.slurStart = false;
        item.chord.slurEnd = false;
        item.chord.slurEndChord = null;
        if (previous) linkContinuation(previous, item.chord);
        previous = item.chord;
      }
    }
    eventLastChord.set(event, matching[matching.length - 1].chord);
  }
}

function slashGraceNote(chord: Chord, pitch: number): Note {
  const value = slashPitch(pitch, chord.measure.key.fifths);
  const note = new Note(chord);
  note.pitch = pitch;
  note.number = String(value.degree + 1);
  note.jpOctave = value.octave;
  note.jpAlter = value.accidental > 0 ? "#" : value.accidental < 0 ? "b" : " ";
  return note;
}

/** Restore non-metrical slash-score decorations after MIDI quantization. */
function applySlashOrnaments(score: Score, events: readonly TimedEvent[]): void {
  const chords: PositionedChord[] = [];
  for (let partIndex = 0; partIndex < score.parts.length; partIndex++) {
    const part = score.parts[partIndex];
    for (const measure of part.measures) {
      const measureStart = measure.position.toFloat();
      for (const entry of measure.entries) {
        if (!(entry instanceof Chord) || entry.rest || !entry.duration) continue;
        const start = measureStart + entry.position.toFloat();
        chords.push({
          chord: entry,
          partIndex,
          start,
          end: start + entry.duration.toFloat(),
          pitches: chordPitches(entry),
        });
      }
    }
  }

  for (const event of events) {
    if (!event.arpeggio && (!event.gracePitches || event.gracePitches.length === 0)) continue;
    const pitches = [...event.pitches].sort((left, right) => left - right);
    const rolledPitches = [...(event.arpeggioPitches ?? event.pitches)]
      .sort((left, right) => left - right);
    const aligned = chords.filter((item) =>
      Math.abs(item.start - event.start) <= 1e-8
      && (event.voiceIndex === undefined || item.partIndex === event.voiceIndex));
    const exact = aligned.find((item) => equalPitches(item.pitches, pitches));
    // A simultaneous parenthesized chord and rolled container are quantized
    // into one written vertical chord. In that case the rolled pitches are a
    // subset of the chord rather than an exact match.
    const containing = event.arpeggio
      ? aligned.find((item) => pitches.every((pitch) => item.pitches.includes(pitch)))
      : undefined;
    const target = (exact ?? containing)?.chord;
    if (!target) continue;
    if (event.arpeggio && rolledPitches.length >= 2) {
      target.arpeggio = true;
      target.arpeggioPitches = [...rolledPitches];
    }
    if (event.gracePitches?.length) {
      target.graceNotes = event.gracePitches
        .flatMap((group) => group.map((pitch) => slashGraceNote(target, pitch)));
    }
  }
}

function applySlashTempoMarks(score: Score, marks: readonly SlashTempoMark[]): void {
  score.tempoMarks = marks.flatMap((source) => {
    if (source.measure < 0 || source.measure >= (score.parts[0]?.measures.length ?? 0)) return [];
    const mark = new TempoMark();
    mark.measure = source.measure;
    mark.offset = new Fraction(Math.round(source.offset * 192), 192);
    mark.kind = source.kind;
    mark.bpm = source.kind === "tempo" && source.bpm !== null
      ? Math.max(1, Math.round(source.bpm))
      : null;
    return [mark];
  });
}

function finestQuantize(options: SlashScoreOptions): MidiQuantizeDivision {
  let division = Math.max(4, options.noteDivision ?? 4, ...Object.values(effectiveMappings(options))) as SlashDurationDivision;
  if (options.braceMode !== "arpeggio" || (options.bracketMode ?? "triplet") !== "arpeggio") {
    division = Math.min(64, division * 2) as SlashDurationDivision;
  }
  return DIVISIONS.includes(division) ? division : 64;
}

function slashGroupsUseWholeMeasures(
  lines: readonly string[],
  options: Pick<SlashScoreOptions, "symbolDurations" | "spaceDivision" | "noteDivision" | "braceMode" | "bracketMode">,
  normalGroupDuration: number,
  measureLength: number,
): boolean {
  if (!options.noteDivision) return false;
  const mappings = effectiveMappings(options);
  const durations = lines.flatMap((line) => splitGroups(line))
    .map((group) => segmentMarkerDuration(
      group,
      mappings,
      options.braceMode,
      options.noteDivision,
      options.bracketMode ?? "triplet",
    ))
    .filter((duration) => duration > 1e-8);
  if (durations.length === 0 || durations.some((duration) => duration > measureLength + 1e-8)) return false;
  const overflowing = durations.filter((duration) => duration > normalGroupDuration + 1e-8).length;
  return overflowing >= Math.ceil(durations.length / 2) && median(durations) > normalGroupDuration + 1e-8;
}

function makePickupRest(measure: Measure, position: Fraction, duration: Fraction): Chord {
  let beams = 4;
  let cells = Math.max(1, Math.round(duration.toFloat() * (1 << beams)));
  while (beams > 0 && cells % 2 === 0) {
    cells /= 2;
    beams--;
  }
  let dot = 0;
  if (cells === 3 && beams > 0) {
    cells = 1;
    beams--;
    dot = 1;
  }
  const chord = new Chord(measure);
  chord.position = position;
  chord.duration = duration;
  chord.beats = cells;
  chord.beams = beams;
  chord.dot = dot;
  chord.voice = 1;
  chord.rest = true;
  const note = new Note(chord);
  note.rest = true;
  note.number = "0";
  chord.add(note);
  return chord;
}

function applyOpeningPickup(
  score: Score,
  fullMeasure: Fraction,
  pickupDuration: Fraction,
  leadingFill: Fraction,
  fillDivision: SlashDurationDivision,
): { duration: number; rests: number } {
  const firstMeasures = score.parts.map((part) => part.measures[0]).filter((measure) => measure !== undefined);
  if (firstMeasures.length === 0) return { duration: 0, rests: 0 };
  const hasSound = firstMeasures.some((measure) => measure.entries.some((entry) =>
    entry instanceof Chord && !entry.rest && entry.duration !== undefined));
  if (!hasSound || pickupDuration.compareTo(new Fraction(0)) <= 0 ||
      pickupDuration.compareTo(fullMeasure) > 0) return { duration: 0, rests: 0 };
  const unit = new Fraction(4, fillDivision);
  const shortfall = fullMeasure.minus(pickupDuration);
  let reportedRests = 0;
  for (let partIndex = 0; partIndex < score.parts.length; partIndex++) {
    const measures = score.parts[partIndex].measures;
    const first = measures[0];
    if (!first) continue;
    const retained: Chord[] = [];
    for (const entry of first.entries) {
      if (!(entry instanceof Chord) || entry.duration === undefined) continue;
      if (entry.position.compareTo(pickupDuration) >= 0) continue;
      const end = entry.position.plus(entry.duration);
      if (end.compareTo(pickupDuration) > 0) entry.duration = pickupDuration.minus(entry.position);
      const insideAutomaticFill = entry.rest && entry.position.compareTo(leadingFill) < 0 &&
        entry.position.plus(entry.duration).compareTo(leadingFill) <= 0;
      if (!insideAutomaticFill) retained.push(entry);
    }
    const inserted: Chord[] = [];
    let cursor = new Fraction(0);
    while (cursor.plus(unit).compareTo(leadingFill) <= 0) {
      inserted.push(makePickupRest(first, cursor, unit));
      cursor = cursor.plus(unit);
    }
    if (cursor.compareTo(leadingFill) < 0) {
      inserted.push(makePickupRest(first, cursor, leadingFill.minus(cursor)));
    }
    if (partIndex === 0) reportedRests = inserted.length;
    first.entries = [...inserted, ...retained].sort((a, b) => a.position.compareTo(b.position));
    first.pickup = true;
    first.displayNumber = null;
    for (let index = 1; index < measures.length; index++) {
      measures[index].position = measures[index].position.minus(shortfall);
      measures[index].displayNumber = index;
    }
  }
  return { duration: pickupDuration.toFloat(), rests: reportedRests };
}

export function parseSlashScore(text: string, baseOptions: SlashScoreOptions): SlashScoreResult {
  const options = optionsWithDirectives(text, baseOptions);
  const lines = sourceLines(text, options.kind);
  if (lines.score.length === 0) throw new Error("没有找到斜杠谱小节；每个有效小节需单独一行并包含 / 分隔");
  const measureLength = options.beats * 4 / options.beatType;
  const inferred = inferSlashMeter(
    text,
    options.symbolDurations,
    options.spaceDivision,
    options.braceMode,
    options.noteDivision,
    options.bracketMode ?? "triplet",
    options.kind,
  );
  const expectedGroups = groupsForMeter({ ...inferred, beats: options.beats, beatType: options.beatType });
  const groupDuration = measureLength / Math.max(1, expectedGroups);
  const wholeMeasureGroups = slashGroupsUseWholeMeasures(lines.score, options, groupDuration, measureLength);
  const logicalMeasures: string[][] = [];
  if (wholeMeasureGroups) {
    for (const line of lines.score) {
      for (const group of splitGroups(line)) logicalMeasures.push([group]);
    }
  } else if (lines.score.length === 1) {
    const groups = splitGroups(lines.score[0]);
    if (groups.length > expectedGroups) {
      for (let index = 0; index < groups.length; index += expectedGroups) logicalMeasures.push(groups.slice(index, index + expectedGroups));
    } else {
      logicalMeasures.push(groups);
    }
  } else {
    for (const line of lines.score) logicalMeasures.push(splitGroups(line));
  }
  const firstGroups = logicalMeasures[0] ?? [];
  const firstHasSound = firstGroups.some((group) => groupHasContent(group, options) && !isRestOnlyGroup(group, options));
  const structurallyShortOpening = !wholeMeasureGroups && firstHasSound &&
    firstGroups.length > 0 && firstGroups.length < expectedGroups;
  let pickupTargetQuarterNotes = structurallyShortOpening
    ? Math.min(measureLength, firstGroups.length * groupDuration)
    : 0;
  let leadingPickupFillQuarterNotes = 0;
  const events: TimedEvent[] = [];
  let previousEvent: TimedEvent | null = null;
  let clippedGroups = 0;
  let ignoredCharacters = 0;
  const warnings: string[] = [];
  if (wholeMeasureGroups) warnings.push("已按音符和空格自身时值，将每个 / 分段识别为一小节");

  logicalMeasures.forEach((groups, measureIndex) => {
    groups.forEach((group, groupIndex) => {
      const groupStart = wholeMeasureGroups ? 0 : groupIndex * groupDuration;
      if (groupStart >= measureLength - 1e-8) {
        if (groupHasContent(group, options) && !isRestOnlyGroup(group, options)) clippedGroups++;
        return;
      }
      const target = Math.min(wholeMeasureGroups ? measureLength : groupDuration, measureLength - groupStart);
      const eventStartIndex = events.length;
      const result = parseGroup(
        group,
        measureIndex * measureLength + groupStart,
        target,
        options,
        events,
        previousEvent,
      );
      if (measureIndex === 0 && groupIndex === 0 && events.length > eventStartIndex) {
        const groupEvents = events.slice(eventStartIndex);
        const targetEnd = groupStart + target;
        const latestEnd = Math.max(...groupEvents.map((event) => event.end));
        const shift = Math.max(0, targetEnd - latestEnd);
        const mappings = effectiveMappings(options);
        const leadingChar = Array.from(group).find((char) => !/\s/.test(char) || mappings[char]);
        const startsWithDuration = leadingChar !== undefined && mappings[leadingChar] !== undefined;
        const implicitOpeningFill = options.noteDivision !== null && !startsWithDuration;
        const rightAlignOpening = structurallyShortOpening || wholeMeasureGroups || implicitOpeningFill;
        if (rightAlignOpening && shift > 1e-8) {
          for (const event of groupEvents) {
            event.start += shift;
            event.end += shift;
          }
          leadingPickupFillQuarterNotes = shift;
          if (wholeMeasureGroups) pickupTargetQuarterNotes = target;
        }
      }
      previousEvent = result.lastEvent;
      if (result.clipped) clippedGroups++;
      ignoredCharacters += result.ignored;
    });
  });
  const firstEvents = events.filter((event) => event.start < measureLength - 1e-8 && event.end > 1e-8);
  const pickupCandidate = pickupTargetQuarterNotes > 1e-8 && firstEvents.length > 0;
  if (clippedGroups > 0) warnings.push(`${clippedGroups} 个拍组超过所选拍号，已在拍组边界截齐`);
  if (ignoredCharacters > 0) warnings.push(`${ignoredCharacters} 个未映射字符已按注释忽略`);
  const maxMarkerCount = Math.max(
    0,
    ...slashPitchSources(text, options).map((source) => source.markerCount),
  );
  if (maxMarkerCount >= options.voiceCount) {
    warnings.push(`发现 ${maxMarkerCount} 个连续声部标记，但当前仅启用 ${options.voiceCount} 个声部；超出部分已并入默认声部`);
  }
  const strayMarkers = straySlashVoiceMarkerCount(text, options.kind);
  if (strayMarkers > 0) warnings.push(`${strayMarkers} 个后面没有音高的声部标记已忽略`);

  if (!wholeMeasureGroups && lines.score.length === 1 && logicalMeasures.length > 1) warnings.push(`原文没有小节换行，已按 ${options.beats}/${options.beatType} 自动分成 ${logicalMeasures.length} 小节`);
  const voicedEvents = splitTimedEventsByVoice(text, options, events);
  const parsed = parsedMidiFromEvents(voicedEvents, logicalMeasures.length, options);
  const instrumentName = options.instrumentName?.trim() || "钢琴";
  const midiOptions: MidiImportOptions = {
    quantize: finestQuantize(options),
    detectTriplets: options.braceMode === "triplet" || (options.bracketMode ?? "triplet") === "triplet",
    handMode: "single",
    splitPitch: 60,
    fifths: options.fifths,
    beats: options.beats,
    beatType: options.beatType,
    tempoBpm: options.tempoBpm,
    tempoBeatUnit: options.tempoBeatUnit,
    title: options.title || (options.kind === "keyboard" ? "键盘谱" : "数字谱"),
    subtitle: options.subtitle,
    composer: options.composer,
    arranger: options.arranger,
    lyricist: options.lyricist,
    instrumentName: options.voiceCount > 1 ? instrumentName : "",
    scoreMode: options.voiceCount > 1 ? "ensemble" : "hands",
    trackAssignments: options.voiceCount > 1
      ? Array.from({ length: options.voiceCount }, (_unused, voice) => ({
        track: voice,
        instrumentName,
        voice: voice + 1,
      }))
      : undefined,
  };
  const imported = midiToScore(parsed, midiOptions);
  if (options.voiceCount === 2) {
    imported.score.ensemble = false;
    imported.score.piano = true;
    imported.score.instrumentName = instrumentName;
    imported.score.parts[0].hand = "right";
    imported.score.parts[1].hand = "left";
  } else if (options.voiceCount <= 1) {
    imported.score.piano = false;
    imported.score.instrumentName = "";
  }
  if (options.voiceCount <= 1) applySlashContinuations(imported.score, voicedEvents);
  applySlashOrnaments(imported.score, voicedEvents);
  applySlashTempoMarks(imported.score, options.tempoMarks ?? []);
  const pickupRestDivision = (options.noteDivision ?? Math.min(
    64,
    Math.max(4, ...Object.values(effectiveMappings(options))),
  )) as SlashDurationDivision;
  const pickup = pickupCandidate
    ? applyOpeningPickup(
      imported.score,
      new Fraction(options.beats * 4, options.beatType),
      new Fraction(Math.round(pickupTargetQuarterNotes * 192), 192),
      new Fraction(Math.round(leadingPickupFillQuarterNotes * 192), 192),
      pickupRestDivision,
    )
    : { duration: 0, rests: 0 };
  const pickupQuarterNotes = pickup.duration;
  if (pickupQuarterNotes > 0) {
    const readableDuration = Number(pickupQuarterNotes.toFixed(3));
    warnings.push(`识别到 ${readableDuration} 个四分音符的弱起小节；弱起不计入正式小节号`);
  }
  if (pickup.rests > 0) warnings.push(`弱起首拍已在音符前自动补 ${pickup.rests} 个 0`);
  imported.score.parts.forEach((part) => part.measures.forEach((measure) => {
    // Portrait single-staff pages remain readable with three measures per
    // system; twelve measures form a balanced four-system page.
    const formalNumber = measure.displayNumber;
    measure.newSystem = formalNumber !== null && formalNumber > 1 && (formalNumber - 1) % 3 === 0;
    // Page breaks remain automatic so changing the global vertical system gap
    // can pull following systems back into usable space on the previous page.
    measure.newPage = false;
  }));
  return {
    score: imported.score,
    summary: {
      kind: options.kind,
      measures: logicalMeasures.length,
      pickupQuarterNotes,
      pickupRestCount: pickup.rests,
      comments: lines.comments.length,
      ignoredTags: lines.ignoredTags,
      clippedGroups,
      ignoredCharacters,
      warnings,
    },
  };
}

function slashPitch(pitch: number, fifths: number): { degree: number; octave: number; accidental: number } {
  const relative = pitch - tonicPitch(fifths);
  let best = { degree: 0, octave: Math.floor(relative / 12), accidental: 0, cost: Infinity };
  for (let octave = Math.floor(relative / 12) - 1; octave <= Math.floor(relative / 12) + 1; octave++) {
    for (let degree = 0; degree < 7; degree++) {
      const accidental = relative - (octave * 12 + DEGREE_INTERVALS[degree]);
      const cost = Math.abs(accidental) + (Math.abs(accidental) > 1 ? 20 : 0);
      if (cost < best.cost) best = { degree, octave, accidental, cost };
    }
  }
  return best;
}

function accidentalPrefix(accidental: number): string {
  return accidental > 0 ? "#".repeat(accidental) : accidental < 0 ? "b".repeat(-accidental) : "";
}

function numericPitchValue(pitch: number, fifths: number): string {
  const value = slashPitch(pitch, fifths);
  const octave = value.octave > 0 ? "+".repeat(value.octave) : "-".repeat(-value.octave);
  return accidentalPrefix(value.accidental) + octave + String(value.degree + 1);
}

function keyboardPitchValue(pitch: number, fifths: number): string {
  const value = slashPitch(pitch, fifths);
  let octave = value.octave;
  let prefix = "";
  if (octave < -1) { prefix = ",".repeat(-octave - 1); octave = -1; }
  else if (octave > 1) { prefix = "'".repeat(octave - 1); octave = 1; }
  const row = KEYBOARD_ROWS[octave + 1];
  return accidentalPrefix(value.accidental) + prefix + row[value.degree];
}

function chordToken(chord: Chord, kind: SlashScoreKind): string {
  const fifths = chord.measure.key.fifths;
  const values = chord.notes.filter((note) => !note.rest)
    .map((note) => kind === "keyboard" ? keyboardPitchValue(note.pitch, fifths) : numericPitchValue(note.pitch, fifths));
  if (values.length === 0) return "";
  return values.length === 1 ? values[0] : `(${values.join("")})`;
}

interface OutputEvent {
  start: number;
  end: number;
  chords: Chord[];
  /** One-based source part for each chord, parallel to `chords`. */
  voiceIndexes?: number[];
  specialToken?: string;
  /** The token already contains all duration marks, as with `[A..B..C..]`. */
  embeddedDuration?: number;
  hidden?: boolean;
  /** Sound began in an earlier slash group; emit only continuation markers. */
  continued?: boolean;
  /** MIDI note-on pitches at this column, excluding split note-off continuations. */
  explicitPitches?: number[];
}

function measureEvents(score: Score, measureIndex: number): OutputEvent[] {
  const grouped = new Map<number, {
    start: number;
    attackEnds: number[];
    continuationEnds: number[];
    chords: Chord[];
    voiceIndexes: number[];
  }>();
  for (let partIndex = 0; partIndex < score.parts.length; partIndex++) {
    const part = score.parts[partIndex];
    const measure = part.measures[measureIndex];
    if (!measure) continue;
    for (const entry of measure.entries) {
      if (!(entry instanceof Chord) || entry.rest || entry.notes.every((note) => note.rest)) continue;
      const sounding = entry.notes.filter((note) => !note.rest);
      // A transparent slash continuation or an explicit JPW tie-stop advances
      // the common time axis but must not become a new keyboard/number attack.
      const continuation = entry.transparentContinuation
        || (entry.graceNotes.every((note) => note.rest)
          && !entry.arpeggio
          && sounding.length > 0
          && sounding.every((note) => note.tieEnd));
      const start = entry.position.toFloat();
      const duration = entry.duration?.toFloat() ?? 0.25;
      const key = Math.round(start * 192);
      const item = grouped.get(key) ?? {
        start,
        attackEnds: [],
        continuationEnds: [],
        chords: [],
        voiceIndexes: [],
      };
      if (continuation) {
        item.continuationEnds.push(start + duration);
      } else {
        item.attackEnds.push(start + duration);
        item.chords.push(entry);
        item.voiceIndexes.push(partIndex + 1);
      }
      grouped.set(key, item);
    }
  }
  return [...grouped.values()]
    .map((item): OutputEvent => {
      const ends = [...item.attackEnds, ...item.continuationEnds];
      return {
        start: item.start,
        // Multiple voices can overlap for different lengths. The slash text
        // needs one common cursor, so retain the longest active span and emit
        // at most one continuation marker at a following group boundary.
        end: Math.max(item.start + 1 / 192, ...ends),
        chords: item.chords,
        voiceIndexes: item.voiceIndexes,
        specialToken: item.chords.length === 0 ? "" : undefined,
      };
    })
    .sort((a, b) => a.start - b.start);
}

function outputToken(event: OutputEvent, kind: SlashScoreKind, fifths: number, voiceCount = 1): string {
  if (event.specialToken !== undefined) return event.specialToken;
  if (event.explicitPitches) return pitchesToken(event.explicitPitches, kind, fifths);
  if (voiceCount > 1 && event.voiceIndexes?.length === event.chords.length) {
    const values = event.chords.flatMap((chord, chordIndex) => {
      const voice = clamp(event.voiceIndexes![chordIndex], 1, voiceCount);
      const prefix = voice === voiceCount ? "" : SLASH_VOICE_SEPARATOR.repeat(voice);
      return chord.notes
        .filter((note) => !note.rest)
        .sort((left, right) => left.pitch - right.pitch)
        .map((note) => prefix + (kind === "keyboard"
          ? keyboardPitchValue(note.pitch, fifths)
          : numericPitchValue(note.pitch, fifths)));
    });
    return values.length === 1 ? values[0] : `(${values.join("")})`;
  }
  const notes = event.chords.flatMap((chord) => chord.notes.filter((note) => !note.rest));
  const fake = event.chords[0];
  if (!fake) return "";
  const unique = new Map<number, Chord["notes"][number]>();
  for (const note of notes) unique.set(note.pitch, note);
  const values = [...unique.values()].sort((a, b) => a.pitch - b.pitch)
    .map((note) => kind === "keyboard" ? keyboardPitchValue(note.pitch, fifths) : numericPitchValue(note.pitch, fifths));
  return values.length === 1 ? values[0] : `(${values.join("")})`;
}

function pitchValues(pitches: readonly number[], kind: SlashScoreKind, fifths: number): string[] {
  return [...new Set(pitches)].sort((a, b) => a - b)
    .map((pitch) => kind === "keyboard" ? keyboardPitchValue(pitch, fifths) : numericPitchValue(pitch, fifths));
}

function pitchesToken(pitches: readonly number[], kind: SlashScoreKind, fifths: number): string {
  const values = pitchValues(pitches, kind, fifths);
  return values.length <= 1 ? values[0] ?? "" : `(${values.join("")})`;
}

function eventVoiceForPitch(event: OutputEvent, pitch: number, voiceCount: number): number {
  for (let chordIndex = 0; chordIndex < event.chords.length; chordIndex++) {
    const chord = event.chords[chordIndex];
    if ([...chord.notes, ...chord.graceNotes].some((note) => !note.rest && note.pitch === pitch)) {
      return clamp(event.voiceIndexes?.[chordIndex] ?? voiceCount, 1, voiceCount);
    }
  }
  return clamp(event.voiceIndexes?.[0] ?? voiceCount, 1, voiceCount);
}

function voicedPitchesToken(
  pitches: readonly number[],
  event: OutputEvent,
  kind: SlashScoreKind,
  fifths: number,
  voiceCount: number,
): string {
  if (voiceCount <= 1) return pitchesToken(pitches, kind, fifths);
  const values = [...new Set(pitches)].sort((left, right) => left - right).map((pitch) => {
    const voice = eventVoiceForPitch(event, pitch, voiceCount);
    const prefix = voice === voiceCount ? "" : SLASH_VOICE_SEPARATOR.repeat(voice);
    const value = kind === "keyboard"
      ? keyboardPitchValue(pitch, fifths)
      : numericPitchValue(pitch, fifths);
    return prefix + value;
  });
  return values.length <= 1 ? values[0] ?? "" : `(${values.join("")})`;
}

function eventPitches(event: OutputEvent): number[] {
  if (event.explicitPitches) return [...event.explicitPitches];
  return [...new Set(event.chords.flatMap((chord) =>
    chord.notes.filter((note) => !note.rest).map((note) => note.pitch)))];
}

function midiOnsetPitchMap(
  parsed: ParsedMidi,
  division: SlashDurationDivision,
  gestures: readonly MidiSlashGesture[],
): Map<number, Set<number>> {
  const unit = 4 / division;
  const result = new Map<number, Set<number>>();
  const add = (quarter: number, pitches: readonly number[]): void => {
    const key = Math.round(quarter * 192);
    const values = result.get(key) ?? new Set<number>();
    for (const pitch of pitches) values.add(pitch);
    result.set(key, values);
  };
  for (const note of parsed.notes) add(Math.round((note.startTick / parsed.ppq) / unit) * unit, [note.pitch]);
  for (const gesture of gestures) {
    if (gesture.kind !== "triplet") continue;
    for (const event of gesture.events) add(event.start, event.pitches);
  }
  return result;
}

function retainMidiOnsets(
  events: readonly OutputEvent[],
  measureStart: number,
  onsetPitches: ReadonlyMap<number, Set<number>>,
  preserveVoices: boolean,
): OutputEvent[] {
  const result: OutputEvent[] = [];
  for (const event of events) {
    const key = Math.round((measureStart + event.start) * 192);
    const pitches = onsetPitches.get(key);
    if (!pitches || pitches.size === 0) continue;
    result.push(preserveVoices
      ? { ...event, explicitPitches: undefined }
      : { ...event, explicitPitches: [...pitches].sort((a, b) => a - b) });
  }
  return result;
}

function delimiterFor(
  mode: SlashGroupMode,
  options: Pick<MidiSlashExportOptions, "braceMode" | "bracketMode">,
): readonly [string, string] | null {
  if (options.braceMode === mode) return ["{", "}"];
  if (options.bracketMode === mode) return ["[", "]"];
  return null;
}

function nearestEvent(
  events: readonly OutputEvent[],
  localStart: number,
  tolerance: number,
): OutputEvent | null {
  let best: OutputEvent | null = null;
  let bestError = Infinity;
  for (const event of events) {
    if (event.hidden) continue;
    const error = Math.abs(event.start - localStart);
    if (error <= tolerance && error < bestError) {
      best = event;
      bestError = error;
    }
  }
  return best;
}

function applyMidiSlashGestures(
  events: OutputEvent[],
  measureStart: number,
  measureLength: number,
  gestures: readonly MidiSlashGesture[],
  options: MidiSlashExportOptions,
  kind: SlashScoreKind,
  fifths: number,
  division: SlashDurationDivision,
  symbol: string,
  voiceCount: number,
): OutputEvent[] {
  const unit = 4 / division;
  const measureEnd = measureStart + measureLength;
  const localGestures = gestures.filter((gesture) =>
    gesture.anchor >= measureStart - 1e-8 && gesture.anchor < measureEnd - 1e-8);

  for (const gesture of localGestures) {
    const delimiter = delimiterFor(gesture.kind, options);
    if (!delimiter) continue;
    const [opening, closing] = delimiter;
    const localAnchor = gesture.anchor - measureStart;

    if (gesture.kind === "arpeggio") {
      const target = nearestEvent(events, localAnchor, unit * 0.51);
      if (!target) continue;
      const rolledPitches = gesture.events.flatMap((event) => event.pitches);
      const rolled = new Set(rolledPitches);
      const extra = eventPitches(target).filter((pitch) => !rolled.has(pitch));
      const atoms = gesture.events
        .map((event) => voicedPitchesToken(event.pitches, target, kind, fifths, voiceCount))
        .join("");
      target.specialToken = `${opening}${atoms}${closing}` +
        voicedPitchesToken(extra, target, kind, fifths, voiceCount);
      continue;
    }

    if (gesture.kind === "grace") {
      const target = nearestEvent(events, localAnchor, unit * 0.51);
      if (!target || gesture.events.length < 2) continue;
      const graceEvents = gesture.events.slice(0, -1);
      const mainPitches = new Set(gesture.events[gesture.events.length - 1].pitches);
      const gracePitches = new Set(graceEvents.flatMap((event) => event.pitches));
      const retained = eventPitches(target).filter((pitch) =>
        mainPitches.has(pitch) || !gracePitches.has(pitch));
      const graceText = graceEvents
        .map((event) => voicedPitchesToken(event.pitches, target, kind, fifths, voiceCount))
        .join("");
      target.specialToken = `${opening}${graceText}${closing}` +
        voicedPitchesToken(retained, target, kind, fifths, voiceCount);
      for (const source of graceEvents) {
        const quantized = Math.round(source.start / unit) * unit - measureStart;
        const separate = nearestEvent(events, quantized, unit * 0.2);
        if (separate && separate !== target) {
          const separatePitches = eventPitches(separate);
          if (separatePitches.every((pitch) => gracePitches.has(pitch))) separate.hidden = true;
        }
      }
      continue;
    }

    if (gesture.kind === "triplet" && gesture.events.length === 3) {
      const nominalDivision = gesture.division ?? division;
      const nominal = 4 / nominalDivision;
      const cell = nominal * 2 / 3;
      const matched = gesture.events.map((_source, index) =>
        nearestEvent(events, localAnchor + index * cell, Math.max(1 / 192, cell * 0.24)));
      const first = matched[0] ?? nearestEvent(events, localAnchor, unit * 0.51);
      if (!first) continue;
      const markerCount = Math.max(1, Math.round(nominal / unit));
      const atoms = gesture.events.map((source, index) => {
        const matchedEvent = matched[index] ?? first;
        const sounding = matched[index] ? eventPitches(matched[index]!) : source.pitches;
        return voicedPitchesToken(sounding, matchedEvent, kind, fifths, voiceCount) +
          symbol.repeat(markerCount);
      }).join("");
      first.specialToken = `${opening}${atoms}${closing}`;
      first.embeddedDuration = nominal * 2;
      first.end = Math.min(measureLength, localAnchor + nominal * 2);
      for (const event of matched.slice(1)) if (event && event !== first) event.hidden = true;
    }
  }
  return events.filter((event) => !event.hidden).sort((a, b) => a.start - b.start);
}

function keyName(fifths: number): string {
  return MusicCommon.keys[clamp(fifths + 7, 0, 14)];
}

function slashGroupDirective(label: "花括号" | "方括号", mode: SlashGroupMode): string {
  const description = mode === "none"
    ? "留空（不指定特殊功能，内部按普通音符读取）"
    : mode === "grace"
    ? "倚音（装饰音不增加小节拍长）"
    : mode === "arpeggio"
      ? "琶音（括号内三个及以上音按滚奏和弦处理）"
      : mode === "triplet"
        ? "三连音（括号内三个时值按 3:2 压缩）"
        : "细分（最低时值再除以2并计入拍长）";
  return `${label}=${description}`;
}

export function scoreToSlashScore(
  score: Score,
  kind: SlashScoreKind,
  division: SlashDurationDivision,
  symbol = ".",
  midiExport?: MidiSlashExportOptions,
  voiceCount = 1,
): string {
  const firstMeasure = score.parts[0]?.measures[0];
  const beats = firstMeasure?.time.beats ?? 4;
  const beatType = firstMeasure?.time.beatType ?? 4;
  const fifths = firstMeasure?.key.fifths ?? 0;
  const unit = 4 / division;
  const compound = beatType === 8 && beats >= 6 && beats % 3 === 0;
  const groups = compound ? beats / 3 : beats;
  const groupDuration = compound ? 1.5 : 4 / beatType;
  const measureCount = Math.max(0, ...score.parts.map((part) => part.measures.length));
  const braceMode = midiExport?.braceMode ?? "grace";
  const bracketMode = midiExport?.bracketMode ?? "triplet";
  const detectedGestures = midiExport
    ? detectMidiSlashGestures(midiExport.sourceMidi, division)
    : null;
  const midiGestures = detectedGestures
    ? [...detectedGestures.grace, ...detectedGestures.arpeggio, ...detectedGestures.triplet]
    : [];
  const midiOnsets = midiExport
    ? midiOnsetPitchMap(midiExport.sourceMidi, division, midiGestures)
    : null;
  const lines: string[] = [
    kind === "keyboard" ? "键盘谱" : "数字谱",
    "// 每行一小节，/ 分隔拍组；未识别的其他文字作为注释保留。",
    `标题=${score.title || (kind === "keyboard" ? "键盘谱" : "数字谱")}`,
  ];
  if (score.subtitle) lines.push(`副标题=${score.subtitle}`);
  if (score.composer) lines.push(`作曲=${score.composer}`);
  if (score.arranger) lines.push(`编曲=${score.arranger}`);
  if (score.lyricist) lines.push(`作词=${score.lyricist}`);
  lines.push(
    `1=${keyName(fifths)}`,
    `${beats}/${beatType}拍：`,
    `速度=${score.tempoBeatUnit === "eighth" ? "八分音符" : score.tempoBeatUnit === "dotted-quarter" ? "附点四分音符" : "四分音符"}(${formatTempoBpm(tempoBpmForUnit(score.tempoBpm, score.tempoBeatUnit))} BPM)`,
    symbol === "." ? `点=${division}分音符` : symbol === " " ? `空格=${division}分音符` : `符号(${symbol})=${division}分音符`,
    slashGroupDirective("花括号", braceMode),
    slashGroupDirective("方括号", bracketMode),
    "",
  );

  for (let measureIndex = 0; measureIndex < measureCount; measureIndex++) {
    const measure = score.parts[0]?.measures[measureIndex];
    const measureStart = measure?.position.toFloat() ?? measureIndex * beats * 4 / beatType;
    const measureLength = (measure?.time.beats ?? beats) * 4 / (measure?.time.beatType ?? beatType);
    let events = measureEvents(score, measureIndex);
    if (midiExport) {
      events = retainMidiOnsets(events, measureStart, midiOnsets!, voiceCount > 1);
      // Slash scores express sustain with their own adjacent rhythm symbols.
      // Ignore MIDI note-off/pedal length and hold each onset until the next
      // onset (or the end of the measure) before serializing.
      for (let index = 0; index < events.length; index++) {
        events[index].end = events[index + 1]?.start ?? measureLength;
      }
      events = applyMidiSlashGestures(
        events,
        measureStart,
        measureLength,
        midiGestures,
        midiExport,
        kind,
        fifths,
        division,
        symbol,
        voiceCount,
      );
    }
    const segments: string[] = [];
    for (let groupIndex = 0; groupIndex < groups; groupIndex++) {
      const start = groupIndex * groupDuration;
      const end = start + groupDuration;
      const attacks = events
        .filter((item) => item.start >= start - 1e-8 && item.start < end - 1e-8)
        .map((item): OutputEvent => ({ ...item, continued: false }));
      const activeBeforeGroup = events
        .filter((item) => item.start < start - 1e-8 && item.end > start + 1e-8);
      const inGroup: OutputEvent[] = [...attacks];
      if (activeBeforeGroup.length > 0
        && (attacks[0]?.start ?? end) > start + 1e-8) {
        const latest = activeBeforeGroup.reduce((left, right) =>
          right.start > left.start ? right : left);
        inGroup.push({
          ...latest,
          start,
          end: Math.max(...activeBeforeGroup.map((item) => item.end)),
          continued: true,
        });
      }
      inGroup.sort((a, b) => a.start - b.start || Number(Boolean(b.continued)) - Number(Boolean(a.continued)));
      if (inGroup.length === 0) { segments.push("-"); continue; }
      let cursor = start;
      let out = "";
      let cellsLeft = Math.max(1, Math.round(groupDuration / unit));
      const appendMarkers = (duration: number, atLeastOne = false) => {
        const wanted = Math.max(atLeastOne ? 1 : 0, Math.round(duration / unit));
        const count = Math.min(cellsLeft, wanted);
        out += symbol.repeat(count);
        cellsLeft -= count;
      };
      inGroup.forEach((event, eventIndex) => {
        const eventStart = Math.max(start, event.start);
        if (eventStart > cursor + 1e-8) appendMarkers(eventStart - cursor);
        const token = event.continued ? "" : outputToken(event, kind, fifths, voiceCount);
        if (token) out += token;
        if (event.embeddedDuration !== undefined) {
          const occupied = Math.min(end - eventStart, event.embeddedDuration);
          cellsLeft = Math.max(0, cellsLeft - Math.round(occupied / unit));
          cursor = Math.max(cursor, eventStart + occupied);
          return;
        }
        const nextStart = inGroup[eventIndex + 1]?.start ?? end;
        const eventEnd = Math.min(end, event.end, nextStart);
        appendMarkers(eventEnd - eventStart, true);
        cursor = Math.max(cursor, eventEnd);
      });
      if (cursor < end - 1e-8) appendMarkers(end - cursor);
      if (cellsLeft > 0) out += symbol.repeat(cellsLeft);
      segments.push(out || "-");
    }
    lines.push(segments.join("/") + "/");
  }
  return lines.join("\n") + "\n";
}

export function slashScoreTemplate(kind: SlashScoreKind): string {
  return [
    kind === "keyboard" ? "键盘谱" : "数字谱",
    "// 这里可以写任意说明；只有含 / 的有效谱行会被读取。",
    "标题=未命名",
    "1=C",
    "4/4拍：",
    "速度=四分音符(90 BPM)",
    "点=八分音符",
    "花括号=倚音（最低时值再除以2，不增加小节拍长）",
    "方括号=三连音（括号内三个时值按 3:2 压缩）",
    "",
    "-/-/-/-/",
    "",
  ].join("\n");
}

/** Persist dialog choices inside a normal ignored TXT comment without deleting any user text. */
export function embedSlashScoreOptions(text: string, options: SlashScoreOptions): string {
  const clean = stripSlashScoreOptions(text);
  const stored: Record<string, unknown> = {
    v: 2,
    vc: clamp(Math.round(options.voiceCount), 1, MAX_SLASH_VOICES),
    k: options.kind === "keyboard" ? "k" : "n",
    n: options.title,
    bpm: options.tempoBpm,
    bu: options.tempoBeatUnit,
    f: options.fifths,
    m: [options.beats, options.beatType],
    s: { ...options.symbolDurations },
    sp: options.spaceDivision,
    nd: options.noteDivision,
    b: compactSlashGroupMode(options.braceMode),
    q: compactSlashGroupMode(options.bracketMode ?? "triplet"),
  };
  if (options.instrumentName?.trim()) stored.i = options.instrumentName.trim();
  if (options.subtitle) stored.u = options.subtitle;
  if (options.composer) stored.c = options.composer;
  if (options.arranger) stored.a = options.arranger;
  if (options.lyricist) stored.l = options.lyricist;
  if (options.tempoMarks?.length) {
    stored.tm = options.tempoMarks.map((mark) => ({ ...mark }));
  }
  const line = `// @jpeditor ${JSON.stringify(stored)}`;
  const lines = clean.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = lines.findIndex((item) => /^\s*(?:键盘谱|数字谱)\s*$/.test(item));
  lines.splice(header >= 0 ? header + 1 : 0, 0, line);
  return lines.join("\n");
}

/** Remove only the persisted editor settings comment and keep every score/comment line unchanged. */
export function stripSlashScoreOptions(text: string): string {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? text.slice(1) : text;
  return bom + body.replace(
    /^[ \t]*\/\/[ \t]*@jpeditor[ \t]+\{[^\r\n]*\}[ \t]*(?:\r?\n|$)/gm,
    "",
  );
}

export interface SlashVoiceMigration {
  text: string;
  from: number;
  to: number;
  mergedVoices: number[];
}

/**
 * Change N while keeping unmarked notes on the current default row. Increasing
 * therefore moves the old default material to the newly created last voice;
 * explicitly marked upper voices retain their indexes. Decreasing merges
 * removed rows into the new unmarked default row.
 */
export function migrateSlashVoiceCount(
  text: string,
  options: SlashScoreOptions,
  requested: number,
): SlashVoiceMigration {
  const from = clamp(Math.round(options.voiceCount), 1, MAX_SLASH_VOICES);
  const to = clamp(Math.round(requested), 1, MAX_SLASH_VOICES);
  if (from === to) {
    return {
      text: embedSlashScoreOptions(text, { ...options, voiceCount: to }),
      from,
      to,
      mergedVoices: [],
    };
  }
  const sources = slashPitchSources(text, { ...options, voiceCount: from });
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  if (to < from) {
    for (const source of sources) {
      if (source.markerCount > 0 && (to === 1 || source.voiceIndex >= to)) {
        changes.push({ from: source.markerFrom, to: source.from, insert: "" });
      }
    }
  }
  let migrated = text;
  for (const change of changes.sort((left, right) => right.from - left.from || right.to - left.to)) {
    migrated = migrated.slice(0, change.from) + change.insert + migrated.slice(change.to);
  }
  const nextOptions = { ...options, voiceCount: to };
  return {
    text: embedSlashScoreOptions(migrated, nextOptions),
    from,
    to,
    mergedVoices: to < from
      ? Array.from({ length: from - to + 1 }, (_unused, index) => to + index)
      : [],
  };
}

/** Collapse a compact TXT score to one voice while retaining all attacks. */
export function stripSlashVoiceMarkers(text: string, options?: SlashScoreOptions): string {
  const clean = text.split(SLASH_VOICE_SEPARATOR).join("");
  return options
    ? embedSlashScoreOptions(clean, { ...options, voiceCount: 1 })
    : clean.replace(
      /(^\s*\/\/\s*@jpeditor\s+)(\{[^\n]*\})/m,
      (_all, prefix: string, json: string) => {
        try {
          const value = JSON.parse(json) as Record<string, unknown>;
          value.v = 2;
          value.vc = 1;
          return prefix + JSON.stringify(value);
        } catch {
          return prefix + json;
        }
      },
    );
}

function compactSlashGroupMode(mode: SlashGroupMode): "n" | "g" | "s" | "a" | "t" {
  return mode === "none" ? "n"
    : mode === "grace" ? "g"
    : mode === "subdivide" ? "s"
      : mode === "arpeggio" ? "a"
        : "t";
}

/** Kept public for tests and UI summaries. */
export function slashChordToken(chord: Chord, kind: SlashScoreKind): string {
  return chordToken(chord, kind);
}
