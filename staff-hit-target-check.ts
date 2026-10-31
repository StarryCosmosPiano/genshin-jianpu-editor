import assert from "node:assert/strict";
import { partitionUnisonHits } from "./src/staff-preview/renderer-svg";

function rect(id: string, x: number, y = 86.64, width = 13, height = 10): SVGRectElement {
  const attributes = new Map(Object.entries({ "data-staff-hit": id, x: String(x), y: String(y), width: String(width), height: String(height) }));
  return { getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value) } as unknown as SVGRectElement;
}
const value = (hit: SVGRectElement, key: string) => Number(hit.getAttribute(key));
for (const hits of [[rect("a", 110.431), rect("b", 115.938)], [rect("a", 110.431), rect("b", 110.431)],
  Array.from({ length: 4 }, (_, index) => rect(String(index), 110.431))]) {
  const identities = hits.map(hit => hit.getAttribute("data-staff-hit"));
  partitionUnisonHits(hits);
  assert.deepEqual(hits.map(hit => hit.getAttribute("data-staff-hit")), identities);
  for (const hit of hits) {
    assert(value(hit, "width") >= 5, "partition narrowed a note below the minimum target width");
    assert.equal(value(hit, "height"), 10, "partition reduced the vertical click area");
    const center = value(hit, "x") + value(hit, "width") / 2;
    assert(hits.every(other => other === hit || center < value(other, "x") || center > value(other, "x") + value(other, "width")),
      "another unison still intercepts this note's center click");
  }
}
const independent = [rect("a", 110.431), rect("other-pitch", 115.938, 76.03), rect("later-beat", 160)];
partitionUnisonHits(independent);
assert.deepEqual(independent.map(hit => value(hit, "x")), [110.431, 115.938, 160], "partition moved unrelated notes");
assert.deepEqual(independent.map(hit => value(hit, "width")), [13, 13, 13]);
const adjacent = [rect("e", 110.431, 81.336), rect("c1", 110.431), rect("c2", 115.938)];
partitionUnisonHits(adjacent);
assert.equal(value(adjacent[1], "y"), value(adjacent[2], "y"), "adjacent pitch trimming split the unison row");
assert.equal(value(adjacent[1], "height"), value(adjacent[2], "height"), "unisons gained different vertical centres");
for (const hit of adjacent) {
  const centerX = value(hit, "x") + value(hit, "width") / 2;
  const centerY = value(hit, "y") + value(hit, "height") / 2;
  for (const other of adjacent) if (other !== hit) {
    assert(centerX < value(other, "x") || centerX > value(other, "x") + value(other, "width")
      || centerY < value(other, "y") - 1 || centerY > value(other, "y") + value(other, "height") + 1,
    "adjacent pitch padding intercepts a centre click or its rounding margin");
  }
}
console.log("Staff hit targets: displaced/identical unisons remain independently clickable, with stable identity and minimum target size");
