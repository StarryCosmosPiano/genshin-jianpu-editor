import {
  allocateMeasureWidths,
  buildMeasureLayout,
  packMeasureSystems,
  placeMeasureColumns,
  type MeasureLayout,
  type RhythmItem,
} from "./src/layout/horizontal";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const options = {
  edgePadding: 2,
  normalClearance: 2,
  boundaryClearance: 3,
  minimumElasticUnit: 3,
  spacingExponent: 0.65,
};

function item(tick: number, order: number, kind: RhythmItem<string>["kind"], value: string): RhythmItem<string> {
  return {
    value,
    tickKey: String(tick),
    tick,
    order,
    kind,
    left: kind === "barline" ? 0.5 : 5,
    right: kind === "barline" ? 0.5 : 5,
  };
}

const durationMeasure = buildMeasureLayout(0, 2, [
  item(0, 2, "note", "quarter"),
  item(1, 2, "note", "eighth"),
  item(1.5, 2, "note", "sixteenth"),
  item(1.75, 2, "note", "last"),
  item(2, 3, "barline", "bar"),
], options);
durationMeasure.width = 240;
placeMeasureColumns(durationMeasure);
const noteColumns = durationMeasure.columns.filter((column) => column.kind === "note");
const rhythmicGaps = noteColumns.slice(1).map((column, index) => column.x - noteColumns[index].x);
check(rhythmicGaps[0] > rhythmicGaps[1], "quarter interval should be wider than eighth interval");
check(rhythmicGaps[1] > rhythmicGaps[2], "eighth interval should be wider than sixteenth interval");

function sizedMeasure(index: number, minimumWidth: number): MeasureLayout<string> {
  const measure = buildMeasureLayout(index, 1, [
    item(0, 2, "note", `note-${index}`),
    item(1, 3, "barline", `bar-${index}`),
  ], options);
  measure.minimumWidth = minimumWidth;
  return measure;
}

const borrowed = [
  sizedMeasure(0, 60),
  sizedMeasure(1, 150),
  sizedMeasure(2, 60),
  sizedMeasure(3, 60),
];
check(allocateMeasureWidths(borrowed, 400), "borrow-width fixture should fit");
check(Math.abs(borrowed.reduce((sum, measure) => sum + measure.width, 0) - 400) < 1e-7, "measure widths must fill the system");
check(borrowed[1].width > borrowed[0].width, "dense measure should borrow width");
check(Math.abs(borrowed[0].width - borrowed[2].width) < 1e-7, "ordinary measures should shrink equally");
check(Math.abs(borrowed[2].width - borrowed[3].width) < 1e-7, "ordinary measure widths should remain equal");

const equal = Array.from({ length: 4 }, (_, index) => sizedMeasure(index, 60));
check(allocateMeasureWidths(equal, 400), "equal-width fixture should fit");
check(equal.every((measure) => Math.abs(measure.width - 100) < 1e-7), "four ordinary measures should be equal width");

const denseFlow = Array.from({ length: 4 }, (_, index) => sizedMeasure(index, 150));
const denseSystems = packMeasureSystems(denseFlow, 400, 4, true);
check(denseSystems.length === 2, "over-dense four-measure line should reflow to two systems");
check(denseSystems.every((system) => system.measures.length === 2), "each dense system should contain two measures");
check(denseSystems.every((system) => Math.abs(system.width - 400) < 1e-7), "every justified system should fill its width");

const forced = Array.from({ length: 4 }, (_, index) => sizedMeasure(index, 50));
forced[0].forceAfter = true;
const forcedSystems = packMeasureSystems(forced, 400, 4, true);
check(forcedSystems.length === 2, "forced break should create a new system");
check(forcedSystems[0].measures.length === 1 && forcedSystems[1].measures.length === 3, "forced break boundary is incorrect");

const pickupFlow = Array.from({ length: 5 }, (_, index) => sizedMeasure(index, index === 0 ? 40 : 60));
pickupFlow[0].widthWeight = 0.5;
pickupFlow[0].countInTarget = false;
pickupFlow[0].displayNumber = null;
const pickupSystems = packMeasureSystems(pickupFlow, 500, 4, true);
check(pickupSystems.length === 1 && pickupSystems[0].measures.length === 5,
  "pickup should not consume one of the four preferred formal-measure slots");
check(pickupFlow[0].width < pickupFlow[1].width,
  "short pickup should receive a smaller elastic width than a full measure");

console.log(JSON.stringify({
  rhythmicGaps,
  borrowedWidths: borrowed.map((measure) => measure.width),
  equalWidths: equal.map((measure) => measure.width),
  denseSystems: denseSystems.map((system) => system.measures.length),
  forcedSystems: forcedSystems.map((system) => system.measures.length),
  pickupWidths: pickupFlow.map((measure) => measure.width),
}, null, 2));
