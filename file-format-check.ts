import {
  classifyImportFile,
  editableDocumentFileInfo,
  fileExtension,
  fileStem,
  isSupportedImportFile,
  replaceFileExtension,
  SCORE_OPEN_EXTENSIONS,
  SCORE_OPEN_INPUT_ACCEPT,
  slashKindHint,
} from "./src/editor/file-format";
import { parseEditableDocument } from "./src/editor/document-parser";
import { analyzeSlashScore, defaultSlashScoreOptions } from "./src/slashscore";
import { JpwFile } from "./src/jpword/jpwfile";
import { fromJpw } from "./src/score/jpwimport";
import { buildJpwSourceNotes } from "./src/editor/note-selection";
import { scoreToJpwabc } from "./src/score/jpscore";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const classifications = new Map<string, ReturnType<typeof classifyImportFile>>([
  ["C:\\scores\\demo.JPWABC", "jpw"],
  ["demo.keyscore", "slash"],
  ["demo.NPS", "slash"],
  ["demo.MID", "midi"],
  ["demo.MusicXML", "musicxml"],
  ["demo.abc", "abc"],
  ["scan.PDF", "recognition"],
  ["scan-without-extension", "unknown"],
]);
for (const [path, expected] of classifications) {
  check(classifyImportFile(path) === expected, `${path} was not classified as ${expected}`);
}
check(classifyImportFile("clipboard", "image/png") === "recognition", "image MIME was ignored");
check(classifyImportFile("clipboard", "application/pdf") === "recognition", "PDF MIME was ignored");
check(isSupportedImportFile("song.midi"), "supported MIDI was rejected");
check(!isSupportedImportFile("notes.docx"), "unsupported document was accepted");
check(fileExtension("C:\\scores\\A.B.MID") === "mid", "extension normalization failed");
check(fileStem("C:\\scores\\Avid%20Theme.mid") === "Avid Theme", "file stem decoding failed");
check(replaceFileExtension("C:\\scores\\demo.abc", "musicxml") === "C:\\scores\\demo.musicxml",
  "Windows extension replacement failed");
check(slashKindHint("demo.KPS") === "keyboard", "keyboard hint failed");
check(slashKindHint("demo.numscore") === "number", "number hint failed");
check(slashKindHint("demo.txt") === undefined, "plain TXT should remain undecided");
check(SCORE_OPEN_EXTENSIONS.every((extension) => SCORE_OPEN_INPUT_ACCEPT.includes(`.${extension}`)),
  "open-file accept string drifted from the registry");
check(editableDocumentFileInfo("jpw").extension === ".jpwabc", "JPW save info failed");
check(editableDocumentFileInfo("keyboard").extension === ".txt", "TXT save info failed");

const jpw = `.Title
KeyAndMeters = {1=C,4/4}
.Voice
1 2 3 4 |]
`;
const parsedJpw = parseEditableDocument(jpw, "jpw", null);
check(parsedJpw?.score.parts[0]?.measures.length === 1, "shared JPW document parser failed");

const plainMultiVoice = `.Title
KeyAndMeters = {1=C,4/4}
.Voice
1--- |
.Voice
5--- |]
`;
const plainMultiScore = fromJpw(JpwFile.fromString(plainMultiVoice)!);
check(plainMultiScore?.ensemble === true && plainMultiScore.parts.length === 2,
  "multiple plain JPW Voice sections were not retained as independent parts");

const reversedEnsemble = `.Title
KeyAndMeters = {1=C,4/4}
.Voice.Piano.V2
5 |]
.Voice.Piano.V1
1 |]
`;
const reversedScore = fromJpw(JpwFile.fromString(reversedEnsemble)!);
const reversedSources = reversedScore
  ? buildJpwSourceNotes(reversedEnsemble, reversedScore)
  : [];
check(reversedScore?.parts[0]?.voiceIndex === 1
  && reversedSources.some((source) => source.partIndex === 0 && reversedEnsemble.slice(source.from, source.to) === "1")
  && reversedSources.some((source) => source.partIndex === 1 && reversedEnsemble.slice(source.from, source.to) === "5"),
"reversed JPW Vn sections mapped score selection to the wrong source text");

const reversedPiano = `.Title
KeyAndMeters = {1=C,4/4}
.Voice.LH
5--- |]
.Voice.RH
1'--- |]
`;
const reversedPianoScore = fromJpw(JpwFile.fromString(reversedPiano)!);
const reversedPianoSources = reversedPianoScore
  ? buildJpwSourceNotes(reversedPiano, reversedPianoScore)
  : [];
check(reversedPianoScore?.piano === true
  && reversedPianoSources.some((source) => source.partIndex === 0 && reversedPiano.slice(source.from, source.to) === "1'")
  && reversedPianoSources.some((source) => source.partIndex === 1 && reversedPiano.slice(source.from, source.to) === "5"),
"reversed JPW RH/LH sections mapped score selection to the wrong source text");

const duplicateVoice = `.Title
KeyAndMeters = {1=C,4/4}
.Voice.Piano.V1
1--- |]
.Voice.Piano.V1
5--- |]
`;
let duplicateRejected = false;
try { fromJpw(JpwFile.fromString(duplicateVoice)!); } catch { duplicateRejected = true; }
check(duplicateRejected, "duplicate JPW ensemble voice numbers were silently accepted");
check(plainMultiScore !== null
  && scoreToJpwabc(plainMultiScore).includes(".Voice.乐器 1.V1")
  && scoreToJpwabc(plainMultiScore).includes(".Voice.乐器 2.V2"),
"plain multi-voice JPW export did not retain distinct fallback instrument sections");
if (plainMultiScore) {
  plainMultiScore.instrumentName = "钢琴";
  const sameInstrumentText = scoreToJpwabc(plainMultiScore);
  check(sameInstrumentText.includes(".Voice.钢琴.V1")
    && sameInstrumentText.includes(".Voice.钢琴.V2"),
  "ensemble JPW export did not reuse the score instrument for blank part names");
}

const slash = `数字谱
4/4拍：
点=16分音符
1..../2..../3..../4..../
`;
let duplicatePianoRejected = false;
try {
  fromJpw(JpwFile.fromString(".Voice.RH\n1--- |\n.Voice.right\n3--- |\n.Voice.LH\n5--- |]")!);
} catch {
  duplicatePianoRejected = true;
}
check(duplicatePianoRejected, "duplicate piano hand silently discarded a voice");
const slashOptions = defaultSlashScoreOptions("number", analyzeSlashScore(slash));
const parsedSlash = parseEditableDocument(slash, "number", slashOptions);
check(parsedSlash?.score.parts[0]?.measures.length === 1, "shared TXT document parser failed");
check(parsedSlash.slashOptions !== null, "TXT parser did not return normalized options");

console.log(JSON.stringify({
  classified: classifications.size + 2,
  openExtensions: SCORE_OPEN_EXTENSIONS.length,
  parsedFormats: ["jpw", "number"],
}, null, 2));
