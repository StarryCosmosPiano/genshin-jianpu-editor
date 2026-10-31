import { HEADER_TEXT_FIELDS, headerFontSize, normalizeHeaderTypography, parseHeaderTypography } from "./src/score/header-typography";
import { JpwFile } from "./src/jpword/jpwfile";
import { fromJpw } from "./src/score/jpwimport";
import { scoreToJpwabc } from "./src/score/jpscore";
import { analyzeSlashScore, defaultSlashScoreOptions, embedSlashScoreOptions, embedSlashScoreOptionsFromScore, parseSlashScore } from "./src/slashscore";
import { parseEditableDocument } from "./src/editor/document-parser";
import { buildScoreLayoutSnapshot } from "./src/layout/score-layout-snapshot";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const sizes = { title: 35, subtitle: 16, lyricist: 9, composer: 12.5, arranger: 15 };
for (const scale of [0.25, 0.5, 1, 1.5, 2]) for (const field of HEADER_TEXT_FIELDS) {
  check(headerFontSize(field, sizes, 17, scale) === sizes[field] * scale, `${field} scaled twice`);
  check(headerFontSize(field, undefined, 17, scale) === 17 * scale, `${field} default changed`);
}
check(parseHeaderTypography("broken") === undefined, "Malformed metadata accepted");
check(normalizeHeaderTypography({ title: 7, subtitle: 145, lyricist: Infinity, unknown: 13 }) === undefined, "Invalid sizes accepted");
check(JSON.stringify(normalizeHeaderTypography({ title: 12, composer: "16", unknown: 22 })) === '{"title":12}', "Invalid fields retained");
const oldJpw = ".Title\nTitle = 字号回归\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 |]\n";
const jpw = oldJpw.replace(".Voice", `HeaderTypography = {${JSON.stringify(sizes)}}\n.Voice`);
const score = fromJpw(JpwFile.fromString(jpw)!);
check(score && JSON.stringify(score.headerTypography) === JSON.stringify(sizes), "JPW import lost sizes");
const roundtrip = scoreToJpwabc(score);
const signature = buildScoreLayoutSnapshot(score).globalKey;
score.headerTypography = { ...sizes, title: 36 };
check(buildScoreLayoutSnapshot(score).globalKey !== signature, "Layout cache ignored typography");
score.headerTypography = sizes;
check(JSON.stringify(fromJpw(JpwFile.fromString(roundtrip)!)?.headerTypography) === JSON.stringify(sizes), "JPW save lost sizes");
check(!scoreToJpwabc(fromJpw(JpwFile.fromString(oldJpw)!)!).includes("HeaderTypography"), "Old JPW gained font metadata");
const txt = "数字谱\n4/4拍：\n点=16分音符\n1.../2.../3.../4.../\n";
const options = defaultSlashScoreOptions("number", analyzeSlashScore(txt));
options.headerTypography = sizes;
const saved = embedSlashScoreOptions(txt, options);
check(saved.includes('"ht":'), "TXT footer lacks typography");
const analysis = analyzeSlashScore(saved);
check(JSON.stringify(analysis.headerTypography) === JSON.stringify(sizes), "TXT analysis lost sizes");
const parsed = parseEditableDocument(saved, "number", options);
check(parsed && JSON.stringify(parsed.score.headerTypography) === JSON.stringify(sizes), "TXT score lost sizes");
check(JSON.stringify(parseSlashScore(saved, defaultSlashScoreOptions("number")).score.headerTypography) === JSON.stringify(sizes), "TXT directives lost sizes");
check(analyzeSlashScore(embedSlashScoreOptionsFromScore(txt, score, defaultSlashScoreOptions("number", analyzeSlashScore(txt)))).headerTypography?.title === 35, "JPW to TXT lost sizes");
const undone = parseEditableDocument(txt, "number", options);
check(undone && undone.score.headerTypography === undefined && undone.slashOptions?.headerTypography === undefined, "TXT undo kept newer sizes");
check(!embedSlashScoreOptions(txt, { ...options, headerTypography: undefined }).includes('"ht":'), "Cleared sizes retained metadata");
console.log("header-typography-check: five sizes, scale, validation, JPW/TXT save, conversion and absent-field undo passed");
