/** Loaded only by the explicit browser regression hook, never on startup. */
export { prepareStaffPreview } from "./renderer";
import { prepareStaffPreview } from "./renderer";
import { Score, Part, Measure, Chord, Note, Lyric, Tuplet, PlaySpecKind, JumpSpec, TimePosition } from "../score/score";
import { Fraction } from "../common/fraction";
import { createStaffNoteRegistry } from "./identity";
import { buildStaffModel } from "./model";
import { staffInputAtPoint, staffPitchAtY, staffCursorPoint, staffSnapAnchors, staffNextInputAnchor } from "./input-geometry";

export const staffPreviewTestApi = {
  prepareStaffPreview, Score, Part, Measure, Chord, Note, Lyric, Tuplet,
  Fraction, createStaffNoteRegistry, buildStaffModel, PlaySpecKind, JumpSpec, TimePosition,
  staffInputAtPoint, staffPitchAtY, staffCursorPoint, staffSnapAnchors, staffNextInputAnchor,
};
