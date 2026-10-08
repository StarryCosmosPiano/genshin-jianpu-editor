/** SVG watermark shared by the live export preview and serialized page exports. */
export interface WatermarkOptions {
  enabled: boolean;
  text: string;
  opacity: number;
  density: number;
}

export const DEFAULT_WATERMARK: Readonly<WatermarkOptions> = {
  enabled: false,
  text: "原琴助手",
  opacity: 0.1,
  density: 7,
};

const SVG_NS = "http://www.w3.org/2000/svg";
const STORAGE_KEY = "jpeditor:export-watermark:v1";

export function loadWatermarkOptions(): WatermarkOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<WatermarkOptions> | null;
    if (!raw) return { ...DEFAULT_WATERMARK };
    return normalizeWatermarkOptions(raw);
  } catch {
    return { ...DEFAULT_WATERMARK };
  }
}

export function saveWatermarkOptions(options: WatermarkOptions): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeWatermarkOptions(options))); }
  catch { /* Storage can be unavailable in a private browser session. */ }
}

export function normalizeWatermarkOptions(raw: Partial<WatermarkOptions>): WatermarkOptions {
  const opacity = Number(raw.opacity);
  const density = Number(raw.density);
  return {
    enabled: raw.enabled === true,
    text: typeof raw.text === "string" ? raw.text.slice(0, 100) : DEFAULT_WATERMARK.text,
    opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : DEFAULT_WATERMARK.opacity,
    density: Number.isFinite(density) ? Math.max(1, Math.min(15, Math.round(density))) : DEFAULT_WATERMARK.density,
  };
}

export function pageViewBox(svg: SVGSVGElement): { x: number; y: number; width: number; height: number } {
  const vb = svg.viewBox.baseVal;
  if (vb.width > 0 && vb.height > 0) return { x: vb.x, y: vb.y, width: vb.width, height: vb.height };
  const width = Number.parseFloat(svg.getAttribute("width") ?? "");
  const height = Number.parseFloat(svg.getAttribute("height") ?? "");
  if (!(width > 0 && height > 0)) throw new Error("谱面页面尺寸无效");
  return { x: 0, y: 0, width, height };
}

/** First mark is always fully inside the page; the others may cross an edge. */
export function watermarkPositions(count: number): ReadonlyArray<readonly [number, number]> {
  const positions: Array<readonly [number, number]> = [[0.5, 0.5]];
  const ring: Array<readonly [number, number]> = [
    [0.12, 0.13], [0.88, 0.13], [0.12, 0.5], [0.88, 0.5],
    [0.12, 0.87], [0.88, 0.87], [0.5, 0.12], [0.5, 0.88],
    [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7],
    [0.5, 0.29], [0.5, 0.71],
  ];
  return positions.concat(ring).slice(0, Math.max(1, Math.min(15, Math.round(count))));
}

export function watermarkFontSize(text: string, width: number, height: number): number {
  const glyphUnits = [...text].reduce((sum, ch) => sum + (/\p{Script=Han}/u.test(ch) ? 1 : 0.62), 0);
  return Math.min(width * 0.115, height * 0.082, width * 0.58 / Math.max(glyphUnits, 1));
}

/** Clone a page, with transparent watermark marks behind all notation. */
export function withWatermark(source: SVGSVGElement, raw: Partial<WatermarkOptions>, transparent = false): SVGSVGElement {
  const copy = source.cloneNode(true) as SVGSVGElement;
  if (transparent) {
    copy.style.removeProperty("background");
    copy.style.removeProperty("background-color");
    const firstVisual = [...copy.children].find((child) =>
      child.tagName.toLowerCase() !== "defs" && child.tagName.toLowerCase() !== "style");
    if (firstVisual?.tagName.toLowerCase() === "rect"
      && /^(white|#fff(?:fff)?|rgb\(255,\s*255,\s*255\))$/i.test(firstVisual.getAttribute("fill") ?? "")) {
      const bounds = pageViewBox(copy);
      const rect = firstVisual as SVGRectElement;
      const coversPage = Number(rect.getAttribute("x") ?? 0) === bounds.x
        && Number(rect.getAttribute("y") ?? 0) === bounds.y
        && Number(rect.getAttribute("width")) >= bounds.width
        && Number(rect.getAttribute("height")) >= bounds.height;
      if (coversPage) rect.remove();
    }
  }
  const options = normalizeWatermarkOptions(raw);
  const value = options.text.trim();
  if (!options.enabled || !value || options.opacity <= 0) return copy;
  const { x, y, width, height } = pageViewBox(copy);
  // The central mark must fit after rotation even for the longest allowed text.
  const fontSize = watermarkFontSize(value, width, height);
  const layer = document.createElementNS(SVG_NS, "g");
  layer.setAttribute("class", "export-watermark");
  layer.setAttribute("aria-hidden", "true");
  layer.setAttribute("fill", "#29384d");
  layer.setAttribute("fill-opacity", String(options.opacity));
  layer.setAttribute("font-family", '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif');
  layer.setAttribute("font-weight", "600");
  layer.setAttribute("font-size", String(fontSize));
  layer.setAttribute("text-anchor", "middle");
  layer.setAttribute("dominant-baseline", "middle");
  for (const [nx, ny] of watermarkPositions(options.density)) {
    const cx = x + width * nx;
    const cy = y + height * ny;
    const mark = document.createElementNS(SVG_NS, "text");
    mark.setAttribute("x", String(cx));
    mark.setAttribute("y", String(cy));
    mark.setAttribute("transform", `rotate(-32 ${cx} ${cy})`);
    mark.textContent = value;
    layer.append(mark);
  }
  let firstVisual = [...copy.children].find((child) =>
    child.tagName.toLowerCase() !== "defs" && child.tagName.toLowerCase() !== "style") ?? null;
  // Staff pages have an explicit white page rect; paint the marks above it.
  if (firstVisual?.tagName.toLowerCase() === "rect"
    && /^(white|#fff(?:fff)?|rgb\(255,\s*255,\s*255\))$/i.test(firstVisual.getAttribute("fill") ?? "")) {
    firstVisual = firstVisual.nextElementSibling;
  }
  copy.insertBefore(layer, firstVisual);
  return copy;
}
