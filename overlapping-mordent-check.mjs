import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = createServer(async (request, response) => {
  try {
    const urlPath = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = urlPath === "/" ? "/index.html" : urlPath;
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(await readFile(join(root, normalize(file))));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

const z = "\u2063";
const source = `键盘谱\n4/4拍：\n点=16分音符\n(V${z}D${z}G).${z}A.${z}N.(${z}D${z}G)./.${z}A.${z}N.${z}A./(B${z}D${z}G).${z}A.${z}N.(${z}D${z}G)./.${z}N.${z}A.${z}N./\n`;
const body = (text) => text.split(/\r?\n/)
  .find((line) => (line.startsWith("[") || line.startsWith("(")) && line.includes("/"))
  ?.replaceAll(z, "") ?? "";
const snapshot = () => page.evaluate(() => {
  const app = window.__app;
  const rows = app.painter.score.parts.map((part) => part.measures[0].entries
    .filter((entry) => entry.notes?.length)
    .map((entry) => ({
      at: entry.position.toString(), end: entry.position.plus(entry.duration).toString(),
      pitches: entry.notes.filter((note) => !note.rest).map((note) => note.pitch).sort((a, b) => a - b),
      rest: entry.rest,
      tuplet: entry.notes.some((note) => note.tuplet && !note.tuplet.ornamentProxy),
      ornaments: entry.ornaments.map((item) => item.kind),
    })));
  return { text: app.getText(), rows, diagnostics: app._slashTimingDiagnostics
    .filter((item) => item.severity === "error") };
});
const timing = (rows) => rows.map(({ at, end, pitches, rest, tuplet }) =>
  ({ at, end, pitches, rest, tuplet }));
const assertClean = (state, label) => {
  assert.deepEqual(state.diagnostics, [], `${label}: timing errors\n${state.text}`);
  assert.deepEqual(state.rows[1].filter((row) => row.tuplet).map((row) =>
    [row.at, row.end, row.pitches]), [
    ["0", "2/3", [53]], ["2/3", "4/3", []], ["4/3", "2", []],
  ], `${label}: voice 2 triplet changed`);
};
const pointAt = (part, at, pitch) => page.evaluate(({ part, at, pitch }) => {
  const app = window.__app;
  const sourceNote = app._sourceNotes.find((item) => item.partIndex === part
    && item.chord.position.toString() === at && item.note.pitch === pitch && !item.note.rest);
  const element = sourceNote && app.painter.noteGroupEls(sourceNote.chord, sourceNote.note)[0]?.element;
  // A wave mark extends the note group's box upward. Hit the number glyph
  // itself; the group's centre can land on the ornament and clear selection.
  const glyph = [...(element?.querySelectorAll("text") ?? [])].find((item) =>
    !(item.getAttribute("font-family") ?? "").includes("Bravura")) ?? element;
  const box = glyph?.getBoundingClientRect();
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}, { part, at, pitch });
const contextAction = async (part, at, pitch, label) => {
  const point = await pointAt(part, at, pitch);
  assert(point, `missing rendered note: voice ${part + 1} ${at} pitch ${pitch}`);
  await page.mouse.click(point.x, point.y);
  await page.mouse.click(point.x, point.y, { button: "right" });
  const item = page.getByRole("menuitem", { name: label, exact: true });
  await item.waitFor({ state: "visible" });
  assert.equal(await item.isDisabled(), false, `${label} unexpectedly disabled`);
  await item.click();
  await page.waitForTimeout(250);
};
const checkClickSource = async (at, pitch, letter, neighbour) => {
  const point = await pointAt(0, at, pitch);
  assert(point, `missing rendered first-voice ${letter}`);
  await page.mouse.click(point.x, point.y);
  const selected = await page.evaluate(({ at, pitch }) => {
    const app = window.__app;
    const sourceNote = app._selectedNotes.at(-1)?.source;
    const selection = app.view.state.selection.main;
    const sameMoment = app._sourceNotes.filter((item) => item.partIndex === 0
      && item.chord.position.toString() === at && item.note.pitch === pitch && !item.note.rest);
    const focus = app.inputFocus();
    return {
      token: sourceNote && app.getText().slice(sourceNote.from, sourceNote.to),
      part: sourceNote?.partIndex,
      at: sourceNote?.chord.position.toString(),
      from: sourceNote?.from, to: sourceNote?.to,
      selection: [selection.from, selection.to],
      sameMoment: sameMoment.map((item) => app.getText().slice(item.from, item.to)),
      selectedCount: app._selectedNotes.length,
      cursor: app._input.cursor && {
        part: app._input.cursor.partIndex,
        at: app._input.cursor.offset.toString(),
        focusPitch: app._input.focusPitch,
      },
      focus: focus && { at: focus.chord.position.toString(), pitch: focus.note.pitch,
        sameNote: sameMoment.some((item) => item.note === focus.note),
        sameChord: sameMoment.some((item) => item.chord === focus.chord),
        rendered: app.painter.noteGroupEls(focus.chord, focus.note).length },
    };
  }, { at, pitch });
  assert.equal(selected.part, 0, `click on ${letter} selected another voice: ${JSON.stringify(selected)}`);
  assert.equal(selected.at, at, `click on ${letter} selected another beat`);
  assert.equal(selected.token, letter, `click on ${letter} selected a helper pitch`);
  assert.deepEqual(selected.sameMoment, [letter], `helper pitches stole the ${letter} source mapping`);
  assert.deepEqual(selected.selection, [selected.from, selected.to], `${letter} was not highlighted in the code pane`);
  if (neighbour) {
    const text = await page.evaluate(() => window.__app.getText());
    const wave = text.match(new RegExp(`\\[${z}*A${z}*${neighbour}${z}*A\\]`));
    assert(wave, `missing wave A${neighbour}A`);
    const waveAt = wave.index;
    if (letter === "A") assert(selected.from > waveAt && selected.to < waveAt + wave[0].length);
    if (letter === "N") assert(selected.from > waveAt + wave[0].length);
  }
};

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = { kind: "keyboard", voiceCount: 2, instrumentName: "钢琴",
      title: "键盘谱", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, spaceDivision: null, noteDivision: null,
      braceMode: "chord", parenMode: "chord", bracketMode: "triplet" };
    app.setText(text);
    app.setInputMode(true);
  }, source);
  await page.waitForTimeout(250);
  const initial = await snapshot();
  assert.deepEqual(initial.diagnostics, []);

  await contextAction(1, "0", 53, "在光标处创建三连音");
  const triplet = await snapshot();
  assertClean(triplet, "created triplet");
  assert.deepEqual(timing(triplet.rows[0]), timing(initial.rows[0]), "triplet changed voice 1");

  await contextAction(0, "1/4", 60, "上波音");
  const upper = await snapshot();
  assertClean(upper, "upper wave");
  assert(body(upper.text).includes("[ASA]"), `upper wave lacks three TXT pitches: ${body(upper.text)}`);
  assert.deepEqual(timing(upper.rows[0]), timing(initial.rows[0]), "upper wave changed ordinary note timing");
  assert.deepEqual(timing(upper.rows[1]), timing(triplet.rows[1]), "upper wave changed parallel triplet");
  assert(upper.rows[0].find((row) => row.at === "1/4")?.ornaments.includes("upper-mordent"));
  await checkClickSource("1/2", 57, "N", "S");
  await checkClickSource("1/4", 60, "A", "S");

  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForTimeout(250);
  const undone = await snapshot();
  assertClean(undone, "undo upper wave");
  assert(!body(undone.text).includes("[ASA]"), "undo left the wave in TXT");
  assert.deepEqual(timing(undone.rows[0]), timing(initial.rows[0]));
  assert.deepEqual(timing(undone.rows[1]), timing(triplet.rows[1]));
  await page.keyboard.press("ControlOrMeta+y");
  await page.waitForTimeout(250);
  const redone = await snapshot();
  assertClean(redone, "redo upper wave");
  assert(body(redone.text).includes("[ASA]"), "redo lost the visible wave");
  assert.deepEqual(timing(redone.rows[1]), timing(triplet.rows[1]));

  await page.evaluate((text) => window.__app.setText(text), redone.text);
  await page.waitForTimeout(250);
  const reloaded = await snapshot();
  assertClean(reloaded, "reloaded upper wave");
  assert(body(reloaded.text).includes("[ASA]"));
  await checkClickSource("1/2", 57, "N", "S");
  await checkClickSource("1/4", 60, "A", "S");

  // Editing the same ordinary note after reload must be able to remove one
  // semantic wave and write the opposite one without touching voice 2.
  await contextAction(0, "1/4", 60, "上波音");
  const removed = await snapshot();
  assertClean(removed, "removed upper wave");
  assert(!body(removed.text).includes("[ASA]"));
  await contextAction(0, "1/4", 60, "下波音");
  const lower = await snapshot();
  assertClean(lower, "lower wave after reload");
  assert(body(lower.text).includes("[AMA]"), `lower wave lacks three TXT pitches: ${body(lower.text)}`);
  assert.deepEqual(timing(lower.rows[0]), timing(initial.rows[0]));
  assert.deepEqual(timing(lower.rows[1]), timing(triplet.rows[1]));
  assert(lower.rows[0].find((row) => row.at === "1/4")?.ornaments.includes("lower-mordent"));
  await checkClickSource("1/2", 57, "N", "M");
  await checkClickSource("1/4", 60, "A", "M");
  assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`);
  console.log("overlapping-mordent-check browser: ok (real fixture, wave body, source mapping, undo/redo, reload)");
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
