import type { Score, TempoBeatUnit } from "../score/score";

export type MidiQuantizeDivision = 4 | 8 | 16 | 32 | 64;
export type MidiHandMode = "auto" | "single" | "double";
export type MidiOutputFormat = "jpw" | "keyboard" | "number";
export type MidiScoreMode = "hands" | "ensemble";
export type MidiSlashGroupMode = "grace" | "arpeggio" | "triplet" | "subdivide";

/** One sounding MIDI track mapped to one ordered numbered-notation voice. */
export interface MidiTrackAssignment {
  track: number;
  instrumentName: string;
  /** 1 is the top row within an instrument group. */
  voice: number;
}

export interface ParsedMidiNote {
  startTick: number;
  endTick: number;
  pitch: number;
  velocity: number;
  channel: number;
  track: number;
}

export interface MidiTrackInfo {
  index: number;
  name: string;
  noteCount: number;
}

export interface MidiTempoEvent {
  tick: number;
  bpm: number;
}

export interface MidiTimeSignatureEvent {
  tick: number;
  beats: number;
  beatType: number;
}

export interface MidiKeySignatureEvent {
  tick: number;
  fifths: number;
  minor: boolean;
}

export interface ParsedMidi {
  format: 0 | 1;
  ppq: number;
  trackCount: number;
  title: string;
  tracks: MidiTrackInfo[];
  notes: ParsedMidiNote[];
  tempos: MidiTempoEvent[];
  timeSignatures: MidiTimeSignatureEvent[];
  keySignatures: MidiKeySignatureEvent[];
  ignoredEvents: number;
  endTick: number;
}

export interface MidiDurationCounts {
  4: number;
  8: number;
  16: number;
  32: number;
  64: number;
}

export interface MidiAnalysis {
  noteCount: number;
  durationQuarterNotes: number;
  durationCounts: MidiDurationCounts;
  tripletNoteCount: number;
  graceGroupCount: number;
  arpeggioGroupCount: number;
  recommendedQuantize: MidiQuantizeDivision;
  suspectedGraceDivision: MidiQuantizeDivision | null;
  suspectedGraceCount: number;
  autoHandMode: "single" | "double";
  splitPitch: number;
  tempoBpm: number;
  beats: number;
  beatType: number;
  fifths: number;
  tempoChangeCount: number;
  keyChangeCount: number;
}

export interface MidiImportOptions {
  quantize: MidiQuantizeDivision;
  detectTriplets: boolean;
  handMode: MidiHandMode;
  splitPitch: number;
  fifths: number;
  beats: number;
  beatType: number;
  tempoBpm?: number;
  /** Display unit only; tempoBpm remains normalized to quarter-note BPM. */
  tempoBeatUnit?: TempoBeatUnit;
  title?: string;
  subtitle?: string;
  composer?: string;
  arranger?: string;
  lyricist?: string;
  instrumentName?: string;
  /** Traditional auto single/piano import, or explicit multi-track full score. */
  scoreMode?: MidiScoreMode;
  trackAssignments?: MidiTrackAssignment[];
  /** Editor text produced after conversion. Slash formats merge all hands into one vertical-chord staff. */
  outputFormat?: MidiOutputFormat;
  /** Meaning assigned to curly/square groups in generated keyboard/number text. */
  slashBraceMode?: MidiSlashGroupMode;
  slashBracketMode?: MidiSlashGroupMode;
}

export interface MidiImportSummary {
  handCount: 1 | 2;
  layoutMode: "single" | "piano" | "ensemble";
  partCount: number;
  instrumentCount: number;
  quantize: MidiQuantizeDivision;
  tripletGroups: number;
  graceGroups: number;
  arpeggioGroups: number;
  suspectedGraceCount: number;
  simplifiedOverlaps: number;
  ignoredEvents: number;
  warnings: string[];
}

export interface MidiImportResult {
  score: Score;
  summary: MidiImportSummary;
}
