const ROWS = ["ZXCVBNM", "ASDFGHJ", "QWERTYU"] as const;

/** The same three diatonic octaves printed by keyboard-score labels. */
export function keyboardNoteForKey(key: string): {
  letter: string; degree: 1 | 2 | 3 | 4 | 5 | 6 | 7; octave: number;
} | null {
  const letter = key.toUpperCase();
  if (letter.length !== 1) return null;
  const row = ROWS.findIndex((keys) => keys.includes(letter));
  if (row < 0) return null;
  return { letter, degree: (ROWS[row].indexOf(letter) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7, octave: row - 1 };
}
