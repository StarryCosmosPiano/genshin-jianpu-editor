import { EditorState } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { documentContextHistory, type DocumentContext } from "./src/editor/document-history";
import { ScoreInputSession } from "./src/editor/input-mode";
import { parseEditableDocument } from "./src/editor/document-parser";
import { defaultSlashScoreOptions } from "./src/slashscore";
import { Fraction } from "./src/common/fraction";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let context: DocumentContext = { format: "number", options: defaultSlashScoreOptions("number") };
const contextHistory = documentContextHistory(() => context);
let state = EditorState.create({ doc: "1/2/3/4/", extensions: [history(), contextHistory.extension] });
const target = {
  get state() { return state; },
  dispatch(transaction: ReturnType<EditorState["update"]>) {
    state = transaction.state;
    context = structuredClone(state.field(contextHistory.field));
  },
};
context.options!.voiceCount = 2;
target.dispatch(state.update({ changes: { from: 0, insert: "\u2063" } }));
check(undo(target), "voice assignment could not be undone");
check(context.options!.voiceCount === 1 && state.doc.toString() === "1/2/3/4/",
  "undo restored plain TXT without restoring its single-voice parser");
check(redo(target) && context.options!.voiceCount === 2 && state.doc.toString().startsWith("\u2063"),
  "redo did not restore voice ownership and the parser together");

const voicedText = state.doc.toString();
context = { format: "jpw", options: null };
target.dispatch(state.update({ changes: { from: 0, to: state.doc.length, insert: ".Voice\n1 2 3 4 |" } }));
check(undo(target) && context.format === "number" && context.options?.voiceCount === 2
  && state.doc.toString() === voicedText, "undo of TXT/JPW conversion used the wrong parser");

context.options!.symbolDurations = { ".": 16 };
context.options!.bracketMode = "subdivide";
target.dispatch(state.update({ changes: { from: 0, to: state.doc.length, insert: "[1234]..../" } }));
check(undo(target) && context.options?.symbolDurations["."] === 8
  && context.options?.bracketMode === "triplet", "undo left newer rhythm/bracket settings active");
check(redo(target) && context.options?.symbolDurations["."] === 16
  && context.options?.bracketMode === "subdivide", "redo lost rhythm/bracket settings");

const parsed = parseEditableDocument(".Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 | 5 6 7 1 |]", "jpw", null);
check(parsed, "cursor fixture did not parse");
const session = new ScoreInputSession();
session.setCursor(parsed.score, { partIndex: 0, measureIndex: 1, offset: new Fraction(15, 4), division: 16, lane: "rest" });
session.moveHorizontal(parsed.score, 1);
check(session.cursor?.measureIndex === 1 && session.cursor.offset.equals(new Fraction(15, 4)),
  "right arrow at the score end wrapped onto the opening note of the last bar");
session.moveByDuration(parsed.score, new Fraction(4));
check(session.cursor?.offset.equals(new Fraction(15, 4)), "Space with a long value wrapped at the score end");
session.setCursor(parsed.score, { partIndex: 0, measureIndex: 0, offset: new Fraction(15, 4), division: 16, lane: "rest" });
session.moveHorizontal(parsed.score, 1);
check(session.cursor?.measureIndex === 1 && session.cursor.offset.equals(new Fraction(0)),
  "ordinary navigation no longer crosses an existing barline");
session.moveHorizontal(parsed.score, -1);
check(session.cursor?.measureIndex === 0 && session.cursor.offset.equals(new Fraction(15, 4)),
  "left arrow did not return across the barline");
console.log("notation-session-check: ok");
