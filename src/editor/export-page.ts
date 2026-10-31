import { withWatermark, type WatermarkOptions } from "./watermark";

export const RHYTHM_GUIDE_SELECTOR = ".rhythm-guide-line,.rhythm-guide-tick,.staff-rhythm-guide";

/** Compose only a detached copy. Preview, raster export and print share the
 * same filtering, so exporting never changes the score shown in the editor. */
export function composeExportPageSvg(source: SVGSVGElement, watermark: WatermarkOptions,
  transparent = false, includeRhythmGuides = false): SVGSVGElement {
  const svg = withWatermark(source, watermark, transparent);
  svg.style.removeProperty("transform");
  svg.style.removeProperty("transform-origin");
  svg.removeAttribute("tabindex");
  if (!includeRhythmGuides) svg.querySelectorAll(RHYTHM_GUIDE_SELECTOR).forEach((node) => node.remove());
  svg.querySelectorAll(".score-input-cursor,.score-input-draft,[data-staff-input-overlay],[data-staff-hit],rect[fill='transparent'][pointer-events='all']")
    .forEach((node) => node.remove());
  svg.querySelectorAll(".selected,.playing,.input-focused,.staff-selected,.staff-playing")
    .forEach((node) => node.classList.remove("selected", "playing", "input-focused", "staff-selected", "staff-playing"));
  return svg;
}
