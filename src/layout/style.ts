export type RhythmGuideDivision = 1 | 2 | 4 | 8 | 16 | 32 | 64;
export type RhythmGuideMode = "auto" | "manual";

/** Global engraving controls shared by every numbered-notation document. */
export interface EngravingStyle {
  /** Number size relative to the base font size. */
  numberScale: number;
  numberBold: boolean;
  /** Vertical distance between tones in a stacked chord, in number-size units. */
  chordRowGap: number;
  /** Octave-dot glyph size, distance from its owner, and clearance from an adjacent chord tone. */
  octaveDotScale: number;
  octaveDotDistance: number;
  octaveDotClearance: number;
  /** Accidental glyph size and its clear space before the owning number. */
  accidentalScale: number;
  accidentalGapScale: number;
  /** Fade the destination note of a tie so the sustained continuation stays secondary. */
  tieContinuationGray: boolean;
  /** Global minimum-clearance and elastic-spacing multiplier. */
  noteGapScale: number;
  /** Duration-aware measure layout and its global flow controls. */
  rhythmicSpacingEnabled: boolean;
  rhythmicSpacingExponent: number;
  measuresPerSystem: number;
  justifyLastSystem: boolean;
  /** Preferred vertical distance between adjacent notation systems. */
  systemGapScale: number;
  /** Publication-header typography and relative placement. X values are content-width ratios. */
  publicationTitleScale: number;
  publicationTitleX: number;
  publicationTitleYOffset: number;
  publicationSubtitleScale: number;
  publicationSubtitleX: number;
  publicationSubtitleYOffset: number;
  publicationMetaScale: number;
  publicationMetaX: number;
  publicationMetaYOffset: number;
  publicationCreditScale: number;
  publicationCreditX: number;
  publicationCreditYOffset: number;
  /** Minimum vertical distance from the key/meter/tempo baseline to the first system. */
  publicationFirstSystemGap: number;
  /** Optional rhythm ruler below numbered notation. */
  rhythmGuideEnabled: boolean;
  /** Auto detects the shortest local value; manual uses rhythmGuideDivision. */
  rhythmGuideMode: RhythmGuideMode;
  rhythmGuideDivision: RhythmGuideDivision;
  /** Distance between right- and left-hand rows, in number-size units. */
  pianoHandGap: number;
  /** Curly-brace horizontal size and stroke width. */
  braceWidthScale: number;
  braceStrokeWidth: number;
  /** Piano system left edge and between-hand connector. */
  pianoLeftLineWidth: number;
  pianoConnectorScale: number;
  /** Ordinary and final barline geometry, in SVG page units. */
  barlineWidth: number;
  finalBarlineWidth: number;
  finalBarlineGap: number;
}

export const DEFAULT_ENGRAVING_STYLE: Readonly<EngravingStyle> = Object.freeze({
  numberScale: 0.6,
  numberBold: false,
  chordRowGap: 0.88,
  octaveDotScale: 1,
  octaveDotDistance: 0.75,
  octaveDotClearance: 1.35,
  accidentalScale: 1,
  accidentalGapScale: 1,
  tieContinuationGray: true,
  noteGapScale: 0.8,
  rhythmicSpacingEnabled: true,
  rhythmicSpacingExponent: 1,
  measuresPerSystem: 4,
  justifyLastSystem: true,
  systemGapScale: 1,
  publicationTitleScale: 1,
  publicationTitleX: 0.5,
  publicationTitleYOffset: 0,
  publicationSubtitleScale: 1,
  publicationSubtitleX: 0.5,
  publicationSubtitleYOffset: 0,
  publicationMetaScale: 1,
  publicationMetaX: 0,
  publicationMetaYOffset: 0,
  publicationCreditScale: 1,
  publicationCreditX: 1,
  publicationCreditYOffset: 0,
  publicationFirstSystemGap: 0.88,
  rhythmGuideEnabled: true,
  rhythmGuideMode: "auto",
  rhythmGuideDivision: 4,
  pianoHandGap: 1.4,
  braceWidthScale: 0.7,
  braceStrokeWidth: 0.5,
  pianoLeftLineWidth: 1.8,
  pianoConnectorScale: 1,
  barlineWidth: 1.3,
  finalBarlineWidth: 3.5,
  finalBarlineGap: 2.8,
});

export type NumericEngravingStyleKey = Exclude<
  keyof EngravingStyle,
  "numberBold" | "tieContinuationGray" | "rhythmicSpacingEnabled" | "justifyLastSystem" |
  "rhythmGuideEnabled" | "rhythmGuideMode" | "rhythmGuideDivision"
>;

/** Shared slider/normalization ranges: [minimum, maximum, step]. */
export const ENGRAVING_STYLE_RANGES: Readonly<Record<NumericEngravingStyleKey, readonly [number, number, number]>> = Object.freeze({
  numberScale: [0.25, 2.4, 0.05],
  chordRowGap: [0.3, 2.2, 0.02],
  octaveDotScale: [0.25, 2.5, 0.05],
  octaveDotDistance: [0.1, 3, 0.05],
  octaveDotClearance: [0.25, 4, 0.05],
  accidentalScale: [0.5, 1.8, 0.05],
  accidentalGapScale: [0.3, 3, 0.05],
  noteGapScale: [0.3, 2.5, 0.05],
  rhythmicSpacingExponent: [0.2, 1.5, 0.05],
  measuresPerSystem: [1, 16, 1],
  systemGapScale: [0.2, 4, 0.05],
  publicationTitleScale: [0.4, 2.5, 0.05],
  publicationTitleX: [0, 1, 0.01],
  publicationTitleYOffset: [-6, 8, 0.1],
  publicationSubtitleScale: [0.4, 2.5, 0.05],
  publicationSubtitleX: [0, 1, 0.01],
  publicationSubtitleYOffset: [-6, 8, 0.1],
  publicationMetaScale: [0.4, 2.5, 0.05],
  publicationMetaX: [0, 1, 0.01],
  publicationMetaYOffset: [-6, 8, 0.1],
  publicationCreditScale: [0.4, 2.5, 0.05],
  publicationCreditX: [0, 1, 0.01],
  publicationCreditYOffset: [-6, 8, 0.1],
  publicationFirstSystemGap: [0.2, 6, 0.05],
  pianoHandGap: [0.5, 4, 0.05],
  braceWidthScale: [0.25, 3, 0.05],
  braceStrokeWidth: [0.2, 8, 0.1],
  pianoLeftLineWidth: [0.2, 8, 0.1],
  pianoConnectorScale: [0.25, 3, 0.05],
  barlineWidth: [0.2, 6, 0.1],
  finalBarlineWidth: [0.6, 12, 0.1],
  finalBarlineGap: [0.4, 18, 0.2],
});

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Merge persisted/partial values with defaults and clamp unsafe geometry. */
export function normalizeEngravingStyle(value?: Partial<EngravingStyle> | null): EngravingStyle {
  const source = value ?? {};
  const result = { ...DEFAULT_ENGRAVING_STYLE } as EngravingStyle;
  for (const key of Object.keys(ENGRAVING_STYLE_RANGES) as NumericEngravingStyleKey[]) {
    const [min, max] = ENGRAVING_STYLE_RANGES[key];
    const n = finiteOr(source[key], DEFAULT_ENGRAVING_STYLE[key]);
    result[key] = Math.min(max, Math.max(min, n));
  }
  result.numberBold = typeof source.numberBold === "boolean"
    ? source.numberBold
    : DEFAULT_ENGRAVING_STYLE.numberBold;
  result.tieContinuationGray = typeof source.tieContinuationGray === "boolean"
    ? source.tieContinuationGray
    : DEFAULT_ENGRAVING_STYLE.tieContinuationGray;
  result.rhythmicSpacingEnabled = typeof source.rhythmicSpacingEnabled === "boolean"
    ? source.rhythmicSpacingEnabled
    : DEFAULT_ENGRAVING_STYLE.rhythmicSpacingEnabled;
  result.justifyLastSystem = typeof source.justifyLastSystem === "boolean"
    ? source.justifyLastSystem
    : DEFAULT_ENGRAVING_STYLE.justifyLastSystem;
  result.measuresPerSystem = Math.round(result.measuresPerSystem);
  result.rhythmGuideEnabled = typeof source.rhythmGuideEnabled === "boolean"
    ? source.rhythmGuideEnabled
    : DEFAULT_ENGRAVING_STYLE.rhythmGuideEnabled;
  result.rhythmGuideMode = source.rhythmGuideMode === "manual" || source.rhythmGuideMode === "auto"
    ? source.rhythmGuideMode
    : DEFAULT_ENGRAVING_STYLE.rhythmGuideMode;
  const guideDivision = finiteOr(source.rhythmGuideDivision, DEFAULT_ENGRAVING_STYLE.rhythmGuideDivision);
  result.rhythmGuideDivision = ([1, 2, 4, 8, 16, 32, 64] as const).includes(guideDivision as RhythmGuideDivision)
    ? guideDivision as RhythmGuideDivision
    : DEFAULT_ENGRAVING_STYLE.rhythmGuideDivision;
  return result;
}
