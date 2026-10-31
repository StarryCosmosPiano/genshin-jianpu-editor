import assert from "node:assert/strict";
import { DEFAULT_WATERMARK, loadWatermarkOptions, normalizeWatermarkOptions,
  saveWatermarkOptions, watermarkFontSize, watermarkPositions } from "./src/editor/watermark";

const near = (a: number, b: number) => Math.abs(a - b) < 1e-10;
type Point = readonly [number, number];
function contains(points: ReadonlyArray<Point>, x: number, y: number): boolean {
  return points.some(([px, py]) => near(px, x) && near(py, y));
}
function nearestDistance(points: ReadonlyArray<Point>, width: number, height: number): number {
  let shortest = Infinity;
  for (let a = 0; a < points.length; a++) {
    for (let b = a + 1; b < points.length; b++) {
      shortest = Math.min(shortest, Math.hypot((points[a][0] - points[b][0]) * width,
        (points[a][1] - points[b][1]) * height));
    }
  }
  return shortest;
}

let layouts = 0;
for (const [width, height] of [[595.28, 841.89], [841.89, 595.28], [612, 792], [400, 1200], [900, 900]]) {
  let previousCount = 0;
  let previousDistance = Infinity;
  for (let density = 1; density <= 15; density++) {
    const points = watermarkPositions(density, width, height);
    assert.deepEqual(points[0], [0.5, 0.5], "central watermark always comes first");
    assert.equal(points.length % 2, 1, "every non-central mark has a partner");
    assert.equal(new Set(points.map(([x, y]) => `${x},${y}`)).size, points.length);
    for (const [x, y] of points) {
      assert(x > 0 && x < 1 && y > 0 && y < 1, "all centers are inside the page");
      assert(contains(points, 1 - x, y), "every column has its horizontal reflection");
      assert(contains(points, x, 1 - y), "every row has its vertical reflection");
      assert(contains(points, 1 - x, 1 - y), "every mark has its opposite around page center");
    }
    assert(points.length >= previousCount, "increasing density never removes rows or columns");
    const distance = nearestDistance(points, width, height);
    assert(distance <= previousDistance, "increasing density never increases nearest-mark spacing");
    if (Number.isFinite(previousDistance)) assert(distance < previousDistance, "spacing changes even when count stays fixed");
    previousCount = points.length;
    previousDistance = distance;
    const scaled = watermarkPositions(density, width * 3, height * 3);
    const rotatedPage = watermarkPositions(density, height, width);
    for (const [x, y] of points) {
      assert(contains(scaled, x, y), "page zoom preserves normalized watermark positions");
      assert(contains(rotatedPage, y, x), "landscape and portrait use the same physical spacing");
    }
    assert.equal(scaled.length, points.length);
    assert.equal(rotatedPage.length, points.length);
    layouts++;
  }
  assert(watermarkPositions(15, width, height).length > watermarkPositions(1, width, height).length);
  for (const text of ["原琴助手", "A", "Watermark", "很长的水印文字".repeat(12), "🎵测试"]) {
    const size = watermarkFontSize(text, width, height);
    assert(size > 0 && Number.isFinite(size));
    assert(near(watermarkFontSize(text, width * 3, height * 3), size * 3), "watermark font scales with page");
  }
}
assert.deepEqual(watermarkPositions(NaN), watermarkPositions(DEFAULT_WATERMARK.density));
assert.deepEqual(watermarkPositions(0), watermarkPositions(1));
assert.deepEqual(watermarkPositions(99), watermarkPositions(15));
assert.deepEqual(watermarkPositions(7, NaN, -1), watermarkPositions(7));
assert.equal(normalizeWatermarkOptions({ density: 7.4 }).density, 7);

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
} });
assert.deepEqual(loadWatermarkOptions(), DEFAULT_WATERMARK);
const old = { enabled: true, text: "保留自定义水印", opacity: 0.23, density: 9 };
storage.set("jpeditor:export-watermark:v1", JSON.stringify(old));
assert.deepEqual(loadWatermarkOptions(), old, "old settings keep text, opacity and slider level");
assert.equal(storage.has("jpeditor:export-watermark:v2"), false, "opening/cancelling doesn't migrate storage");
const current = { ...old, density: 12 };
saveWatermarkOptions(current);
assert.deepEqual(JSON.parse(storage.get("jpeditor:export-watermark:v2")!), current);
assert.deepEqual(loadWatermarkOptions(), current, "new settings take priority over the legacy key");
assert.deepEqual(JSON.parse(storage.get("jpeditor:export-watermark:v1")!), old, "legacy settings stay recoverable");
storage.set("jpeditor:export-watermark:v2", "broken JSON");
assert.deepEqual(loadWatermarkOptions(), DEFAULT_WATERMARK);
console.log(`watermark density: ${layouts} symmetric layouts, spacing/zoom/orientation, fonts and v1 migration passed`);
