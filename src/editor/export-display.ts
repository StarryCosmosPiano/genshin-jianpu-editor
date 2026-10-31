import { Chord, type Note, type Score } from "../score/score";

export interface ExportAppearance {
  surface: "jianpu" | "staff";
  notation: "current" | "number" | "keyboard";
  voiceColors: boolean;
}

export interface ExportPage {
  page: number;
  svg: SVGSVGElement;
  widthPt?: number;
  heightPt?: number;
}

/** Preserve class methods, fractions, and shared tie/slur references. Export
 * layout may annotate its model, so it must never receive the editor's model. */
export function cloneExportScore(source: Score): { score: Score; copies: Map<object, object> } {
  const copies = new Map<object, object>();
  const copy = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    const previous = copies.get(value);
    if (previous) return previous;
    const result = Array.isArray(value) ? [] : value instanceof Map ? new Map()
      : value instanceof Set ? new Set() : Object.create(Object.getPrototypeOf(value));
    copies.set(value, result);
    if (value instanceof Map) for (const [key, item] of value) result.set(copy(key), copy(item));
    else if (value instanceof Set) for (const item of value) result.add(copy(item));
    else for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if ("value" in descriptor) descriptor.value = copy(descriptor.value);
      Object.defineProperty(result, key, descriptor);
    }
    return result;
  };
  return { score: copy(source) as Score, copies };
}

export function resetExportNumberLabels(score: Score): void {
  for (const part of score.parts) for (const measure of part.measures) for (const entry of measure.entries) {
    if (!(entry instanceof Chord)) continue;
    for (const note of [...entry.notes, ...entry.graceNotes]) {
      note.displayText = null;
      note.displayOctave = null;
      note.displayAlter = null;
      note.displayHidden = false;
    }
  }
}

export function exportContinuationVoiceColor(color: string, note: Note, grayContinuations: boolean): string {
  if (!grayContinuations || !(note.chord.transparentContinuation || note.tieEnd && note.tiePrev)) return color;
  return "#" + [1, 3, 5].map(offset => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16);
    return Math.round(channel + (255 - channel) * .58).toString(16).padStart(2, "0");
  }).join("");
}

/** Inline paint survives SVG serialization and does not depend on editor CSS. */
export function applyExportVoiceColor(element: SVGElement, color: string): void {
  if (!/^#[\da-f]{6}$/i.test(color)) return;
  element.classList.add("score-voice-colored");
  element.style.setProperty("--score-voice-color", color);
  // VexFlow noteheads are text glyphs that inherit their paint from a parent.
  // Give the exported glyph its own fill so serialization preserves the color.
  if (!element.hasAttribute("fill")) element.setAttribute("fill", color);
  for (const child of [element, ...element.querySelectorAll<SVGElement>("[fill],[stroke]")]) {
    for (const property of ["fill", "stroke"]) {
      const value = child.getAttribute(property);
      if (value !== null && value !== "none" && value !== "transparent") child.setAttribute(property, color);
    }
  }
}
