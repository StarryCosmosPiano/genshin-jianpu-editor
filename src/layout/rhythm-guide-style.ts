/** Both notation surfaces draw the same thin ruler below the music, with
 * ticks pointing upwards towards the staff. Values are unscaled SVG units. */
export const RHYTHM_GUIDE_STYLE = {
  color: 0xff6b4c8a,
  mutedColor: 0xffb6a4c8,
  strokeWidth: 0.7,
  majorHeight: 8,
  minorHeight: 4,
} as const;

export function rhythmGuideTickHeight(major: boolean, dotted: boolean, muted: boolean): number {
  return (dotted ? !muted : major) ? RHYTHM_GUIDE_STYLE.majorHeight : RHYTHM_GUIDE_STYLE.minorHeight;
}

/** A subpixel compact staff must not wash the purple ruler out to pale grey. */
export function rhythmGuideStrokeWidth(musicScale: number, contentScale: number): number {
  return RHYTHM_GUIDE_STYLE.strokeWidth * Math.max(musicScale, contentScale);
}
