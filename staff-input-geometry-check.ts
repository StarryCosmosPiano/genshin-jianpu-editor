import assert from "node:assert/strict";
import { staffCursorPoint, staffInputAtPoint, staffPitchAtY, staffSnapAnchors, staffNextInputAnchor } from "./src/staff-preview/input-geometry";
import type { StaffInputSpan } from "./src/staff-preview/types";

const span: StaffInputSpan = {
  partIndex: 0, measureIndex: 2, clef: "treble", fifths: 1,
  keyChanges: [{ tick: 2, fifths: -1 }],
  xStart: 100, xEnd: 500, yTop: -30, yBottom: 80, bottomLineY: 40, lineSpacing: 10, rulerY: 70, division: 8,
  anchors: [{ tick: 0, x: 100 }, { tick: 2, x: 300 }, { tick: 4, x: 500 }],
  gridAnchors: Array.from({ length: 8 }, (_, i) => ({ tick: i / 2, x: 100 + i * 50 })),
  tupletGroups: [],
};
assert.deepEqual(staffPitchAtY(span, 40, 0), { midi: 64, step: "E", octave: 4 });
assert.deepEqual(staffPitchAtY(span, 35, 0), { midi: 66, step: "F", octave: 4 }, "G major key was not applied");
assert.deepEqual(staffPitchAtY(span, 35, 2), { midi: 65, step: "F", octave: 4 }, "mid-measure key was not applied");
assert.deepEqual(staffPitchAtY(span, 20, 2), { midi: 70, step: "B", octave: 4 });
assert.deepEqual(staffPitchAtY({ ...span, clef: "bass", fifths: 0 }, 40, 0), { midi: 43, step: "G", octave: 2 });
const hit = staffInputAtPoint([span], 176, 36)!;
assert.equal(hit.position.offset, "1");
assert.equal(hit.x, 200);
assert.equal(hit.y, 35);
assert.equal(hit.position.midi, 66);
assert.equal(staffInputAtPoint([span], 40, 35), null, "pointer outside measure incorrectly inserted a note");
const cursor = staffCursorPoint(span, "1", 66);
assert.equal(cursor.x, hit.x);
assert.equal(cursor.y, hit.y);
assert.equal(staffCursorPoint(span, "1", 66, { step: "G", octave: 4 }).y, 30, "explicit G-flat spelling must not jump onto the F-sharp staff position");
assert.equal(staffCursorPoint(span, "2", 66, { step: "F", octave: 4 }).y, 35, "written staff position must remain fixed when the local key changes");
assert.equal(staffCursorPoint({ ...span, anchors: [...span.anchors, { tick: .75, x: 184 }] }, "3/4", 64).x, 184,
  "entering N from a selected onset between ordinary ruler ticks must retain the engraved column");
const scaled: StaffInputSpan = { ...span, xStart: 50, xEnd: 250, yTop: -15, yBottom: 40, bottomLineY: 20, lineSpacing: 5, rulerY: 35,
  anchors: span.anchors.map(anchor => ({ tick: anchor.tick, x: anchor.x / 2 })), gridAnchors: span.gridAnchors.map(anchor => ({ tick: anchor.tick, x: anchor.x / 2 })) };
assert.deepEqual(staffInputAtPoint([scaled], 88, 18)?.position, hit.position, "scaled paper changed musical hit position");
const triplet = { ...span, tupletGroups: [{ startTick: 0, endTick: 2, anchors: [{ tick: 0, x: 100 }, { tick: 2 / 3, x: 167 }, { tick: 4 / 3, x: 233 }] }] };
assert.equal(staffInputAtPoint([triplet], 173, 35)?.position.offset, "2/3", "tuplet input snapped onto binary ruler");
assert.deepEqual(staffSnapAnchors(triplet).map(anchor => anchor.tick), [0, 2 / 3, 4 / 3, 2, 2.5, 3, 3.5]);
assert.equal(staffNextInputAnchor(triplet, "0", 1)?.tick, 2 / 3, "right arrow used a binary tick inside the tuplet");
assert.equal(staffNextInputAnchor(triplet, "2/3", 1)?.tick, 4 / 3);
assert.equal(staffNextInputAnchor(triplet, "4/3", 1)?.tick, 2, "right arrow did not leave the tuplet at its real boundary");
assert.equal(staffNextInputAnchor(triplet, "2", -1)?.tick, 4 / 3);
assert.equal(staffCursorPoint(triplet, "2/3", 66).x, 167, "ghost marker used a different anchor set than pointer and arrows");
const dotted = { ...span, gridAnchors: span.gridAnchors.map((anchor, index) => ({ ...anchor, muted: index % 3 !== 0 })) };
assert.equal(staffNextInputAnchor(dotted, "0", 1)?.tick, 1.5, "arrow visited a muted dotted-grid reference tick");
const coarse = { ...span, gridAnchors: [{ tick: 0, x: 100 }, { tick: 1, x: 200 }, { tick: 2, x: 300 }, { tick: 3, x: 400 }] };
assert.equal(staffNextInputAnchor(coarse, "3", 1), null, "end of measure must trigger adjacent-measure navigation");
const fine = { ...span, measureIndex: 3, gridAnchors: [{ tick: 0, x: 100 }, { tick: .25, x: 125 }, { tick: .5, x: 150 }] };
assert.equal(staffNextInputAnchor(fine, "0", 1)?.tick, .25, "next measure inherited the previous measure's coarse step");
console.log("Staff input geometry checks passed");
