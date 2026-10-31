// Real Edge gestures for shared multi-target jianpu input. Run after npm run build.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = process.env.APP_TEST_URL ? null : createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(await readFile(join(root, normalize(file))));
  } catch { response.writeHead(404); response.end(); }
});
if (server) await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const modifier = process.platform === "darwin" ? "Meta" : "Control";
const fixture = ".Title\nTitle = {多目标打谱}\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V1\n1 2 3 4 |]\n.Voice.Piano.V2\n5 6 7 1 |]\n";

async function reset(format, text = fixture) {
  await page.evaluate(async ({ format, text }) => {
    const app = window.__app;
    if (app.inputModeEnabled) app.setInputMode(false);
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    if (format === "keyboard") await app.changeDocumentFormat("keyboard");
    app.setCodePaneCollapsed(true);
    app.setRhythmEditDivision(16);
    app.setInputDurationDivision(16);
    app.setEngravingStyle({ ...app.engravingStyle, contentScale: 1 }, false);
    app.resetDocumentUndo();
    app.scorePane.focus({ preventScroll: true });
  }, { format, text });
}

async function notePoint(part, at, degree) {
  return page.evaluate(({ part, at, degree }) => {
    const app = window.__app;
    const source = app._sourceNotes.find((item) => item.partIndex === part
      && item.chord.position.toString() === at && item.note.number === degree && !item.note.rest);
    if (!source) throw new Error(`missing selectable ${part}/${at}/${degree}`);
    const rendered = app.painter.noteGroupEls(source.chord, source.note)[0];
    rendered.element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const item = app.painter.pageItemForTarget(rendered.element);
    const bound = item.bound;
    const point = new DOMPoint((bound.left + bound.right) / 2,
      (bound.top + bound.bottom) / 2).matrixTransform(rendered.element.getScreenCTM());
    return { x: point.x, y: point.y };
  }, { part, at, degree });
}

async function selectNotes(specs) {
  for (let index = 0; index < specs.length; index++) {
    const point = await notePoint(...specs[index]);
    if (index > 0) await page.keyboard.down(modifier);
    await page.mouse.click(point.x, point.y);
    if (index > 0) await page.keyboard.up(modifier);
  }
  const selected = await state();
  assert.equal(selected.selected.length, specs.length, JSON.stringify(selected));
  await page.keyboard.press("n");
  const entered = await state();
  assert.equal(entered.targets.length, specs.length, `N discarded selected targets: ${JSON.stringify(entered)}`);
  assert.equal(entered.selected.length, specs.length, `N discarded the actual selection: ${JSON.stringify(entered)}`);
}

async function state() {
  return page.evaluate(() => {
    const app = window.__app;
    const at = (note, part) => ({ part, measure: note.chord.measure.index,
      at: note.chord.position.toString(), pitch: note.pitch, degree: note.number, octave: note.jpOctave });
    return {
      text: app.getText(), format: app.documentFormat,
      notes: app.painter.score.parts.flatMap((part, partIndex) => part.measures.flatMap((measure) =>
        measure.entries.flatMap((entry) => entry.notes?.filter((note) => !note.rest)
          .map((note) => at(note, partIndex)) ?? []))),
      selected: app._selectedNotes.map((item) => at(item.visualNote, item.source.partIndex)),
      targets: app._input.targets.map((target) => ({ part: target.partIndex, measure: target.measureIndex,
        at: target.offset, kind: target.kind, lane: target.lane, pitch: target.focusPitch,
        octaveOffset: target.octaveOffset })),
      placeholders: document.querySelectorAll(".score-input-note-placeholder").length,
      status: document.querySelector("#status")?.textContent ?? "",
    };
  });
}

function positions(notes) { return notes.map((note) => `${note.part}/${note.measure}/${note.at}`).sort(); }
function notesExceptTargets(actual, targets) {
  const excluded = new Set(targets);
  return actual.notes.filter((note) => !excluded.has(`${note.part}/${note.measure}/${note.at}`));
}
function assertSelection(actual, expected) {
  assert.deepEqual(positions(actual.selected), [...expected].sort(), `selection expanded: ${JSON.stringify(actual)}`);
}
async function waitForBaseline(baseline) {
  // CodeMirror undo restores the source synchronously; its ordinary render
  // reload is debounced. Observe both source and the rebuilt model.
  await page.waitForFunction(({ text, notes }) => {
    const app = window.__app;
    const actual = app.painter.score.parts.flatMap((part, partIndex) => part.measures.flatMap((measure) =>
      measure.entries.flatMap((entry) => entry.notes?.filter((note) => !note.rest).map((note) => ({
        part: partIndex, measure: note.chord.measure.index, at: note.chord.position.toString(),
        pitch: note.pitch, degree: note.number, octave: note.jpOctave,
      })) ?? [])));
    return app.getText() === text && JSON.stringify(actual) === JSON.stringify(notes);
  }, baseline);
}

try {
  await page.goto(process.env.APP_TEST_URL ?? `http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  for (const format of ["jpw", "keyboard"]) {
    // Immediate Ctrl octave on every selected note, including one complete undo.
    await reset(format);
    const baseline = await state();
    await selectNotes([[0, "0", "1"], [0, "2", "3"]]);
    await page.keyboard.press(`${modifier}+ArrowUp`);
    let actual = await state();
    assertSelection(actual, ["0/0/0", "0/0/2"]);
    assert(actual.selected.every((note) => note.octave === 1), `Ctrl did not edit both notes: ${JSON.stringify(actual)}`);
    assert.deepEqual(notesExceptTargets(actual, ["0/0/0", "0/0/2"]), notesExceptTargets(baseline, ["0/0/0", "0/0/2"]));
    await page.keyboard.press(`${modifier}+z`);
    await waitForBaseline(baseline);
    actual = await state();
    assert.deepEqual(actual.notes, baseline.notes, "one undo did not restore the entire octave edit");
    assert(actual.selected.every((note) => ["0/0/0", "0/0/2"].includes(`${note.part}/${note.measure}/${note.at}`)),
      "undo selected an unedited note");

    // Digits uniformly replace only the two selected real targets.
    await reset(format);
    const beforeDigits = await state();
    await selectNotes([[0, "0", "1"], [0, "2", "3"]]);
    await page.keyboard.press("7");
    actual = await state();
    assertSelection(actual, ["0/0/0", "0/0/2"]);
    assert(actual.selected.every((note) => note.degree === "7" && note.octave === 0));
    assert.deepEqual(notesExceptTargets(actual, ["0/0/0", "0/0/2"]), notesExceptTargets(beforeDigits, ["0/0/0", "0/0/2"]));
    await page.keyboard.press(`${modifier}+z`);
    await waitForBaseline(beforeDigits);
    assert.deepEqual((await state()).notes, beforeDigits.notes, "one undo did not restore both numeric replacements");

    // Arrow creates a separate empty layer at each selected column. Pending
    // Octave/part changes do not edit or select the anchor notes before typing.
    await reset(format);
    const beforeGhosts = await state();
    await selectNotes([[0, "0", "1"], [0, "2", "3"]]);
    await page.keyboard.press("ArrowDown");
    actual = await state();
    assert.equal(actual.placeholders, 2, `missing multi-placeholder display: ${JSON.stringify(actual)}`);
    assert(actual.targets.every((target) => target.kind === "ghost" && target.lane === "below"));
    assert.equal(actual.selected.length, 0, "empty placeholders selected their real anchor notes");
    assert.equal(actual.text, beforeGhosts.text);
    await page.keyboard.press(`${modifier}+ArrowUp`);
    actual = await state();
    assert(actual.targets.every((target) => target.kind === "ghost" && target.octaveOffset === 1));
    assert.equal(actual.text, beforeGhosts.text, "pending octave rewrote anchor notes");
    await page.keyboard.press(`${modifier}+Alt+ArrowDown`);
    actual = await state();
    assert(actual.targets.every((target) => target.kind === "ghost" && target.part === 1));
    assert.equal(actual.selected.length, 0, "pending part switch selected destination notes");
    assert.equal(actual.text, beforeGhosts.text, "pending part switch moved an existing note");
    await page.keyboard.press("1");
    actual = await state();
    assertSelection(actual, ["1/0/0", "1/0/2"]);
    assert.equal(actual.targets.length, 2);
    assert(actual.selected.every((note) => note.degree === "1"));
    assert.deepEqual(actual.notes.filter((note) => note.part === 0), beforeGhosts.notes.filter((note) => note.part === 0));
    for (const old of beforeGhosts.notes.filter((note) => note.part === 1)) {
      assert(actual.notes.some((note) => note.part === old.part && note.at === old.at && note.pitch === old.pitch),
        `ghost input changed an existing destination note: ${JSON.stringify(old)}`);
    }
    await page.keyboard.press(`${modifier}+z`);
    await waitForBaseline(beforeGhosts);
    assert.deepEqual((await state()).notes, beforeGhosts.notes, "one undo did not remove both ghost insertions");

    // Mod+Alt immediately moves all real targets, while preserving destination
    // notes and the other source columns.
    await reset(format);
    const beforePart = await state();
    await selectNotes([[0, "0", "1"], [0, "2", "3"]]);
    await page.keyboard.press(`${modifier}+Alt+ArrowDown`);
    actual = await state();
    assertSelection(actual, ["1/0/0", "1/0/2"]);
    assert.equal(actual.targets.length, 2);
    assert.deepEqual(actual.notes.filter((note) => note.part === 0),
      beforePart.notes.filter((note) => note.part === 0 && !["0", "2"].includes(note.at)));
    assert.equal(actual.notes.length, beforePart.notes.length);

    // Delete applies to the whole concrete set and a single undo restores
    // both notes and their exact selection, without selecting a neighbour.
    await reset(format);
    const beforeDelete = await state();
    await selectNotes([[0, "0", "1"], [0, "2", "3"]]);
    await page.keyboard.press("Delete");
    actual = await state();
    assert.deepEqual(actual.notes, notesExceptTargets(beforeDelete, ["0/0/0", "0/0/2"]),
      `Delete did not remove only both selected targets: ${JSON.stringify(actual)}`);
    assert.equal(actual.selected.length, 0, "deleted targets selected a neighbouring surviving note");
    assert.equal(actual.targets.length, 2);
    assert(actual.targets.every((target) => target.kind === "ghost"));
    await page.keyboard.press(`${modifier}+z`);
    await waitForBaseline(beforeDelete);
    actual = await state();
    assertSelection(actual, ["0/0/0", "0/0/2"]);
    assert.equal(actual.targets.length, 2, "undo did not restore the complete input-target set");

    // An empty destination is not an instruction to delete its anchor.
    await reset(format);
    const beforeGhostDelete = await state();
    await selectNotes([[0, "0", "1"], [0, "2", "3"]]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Delete");
    actual = await state();
    assert.equal(actual.text, beforeGhostDelete.text, "ghost Delete changed source notation");
    assert.deepEqual(actual.notes, beforeGhostDelete.notes, "ghost Delete removed an anchor note");
    assert.equal(actual.selected.length, 0);
    assert(actual.targets.every((target) => target.kind === "ghost"));

    // Zero writes a real short rest at every pending beat. Although the
    // resulting cursors remain ghosts, the Score edit must survive saving;
    // ghost-to-ghost is not automatically a session-only movement.
    await reset(format);
    const beforeGhostZero = await state();
    await selectNotes([[0, "0", "1"], [0, "2", "3"]]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("0");
    actual = await state();
    assert.notEqual(actual.text, beforeGhostZero.text, "ghost 0 discarded its rest edit as cursor-only state");
    assert.equal(actual.selected.length, 0);
    await page.evaluate(() => {
      const app = window.__app;
      if (!app.reload(app.getText())) throw new Error("saved ghost rests failed to parse");
    });
    const persistedRests = await page.evaluate(() => window.__app.painter.score.parts[0].measures[0].entries
      .filter((entry) => entry.notes?.length && entry.rest)
      .map((entry) => ({ at: entry.position.toString(), duration: entry.duration.toString() })));
    for (const at of ["0", "2"]) assert(persistedRests.some((rest) => rest.at === at && rest.duration === "1/4"),
      `ghost 0 did not save a sixteenth rest at ${at}: ${JSON.stringify(persistedRests)}`);
    actual = await state();
    assert(actual.notes.some((note) => note.part === 0 && note.at === "1/4" && note.pitch === 60),
      "rest insertion failed to preserve the old first note's remaining tail");
    assert(actual.notes.some((note) => note.part === 0 && note.at === "9/4" && note.pitch === 64),
      "rest insertion failed to preserve the old primary note's remaining tail");
    assert.deepEqual(actual.notes.filter((note) => note.part === 1), beforeGhostZero.notes.filter((note) => note.part === 1));

    // Plain horizontal navigation ends multi-input. The next digit writes at
    // the primary cursor's new beat, leaving the former selected pitches alone.
    for (const navigation of ["ArrowRight", "Space"]) {
      await reset(format);
      await selectNotes([[0, "0", "1"], [0, "2", "3"]]);
      await page.keyboard.press(navigation);
      actual = await state();
      assert.equal(actual.targets.length, 0, `${navigation} left stale multi-targets active`);
      await page.keyboard.press("7");
      actual = await state();
      assert(actual.notes.some((note) => note.part === 0 && note.at === "0" && note.degree === "1" && note.pitch === 60),
        `${navigation} then digit rewrote the old first target`);
      assert(actual.notes.some((note) => note.part === 0 && note.at === "2" && note.degree === "3" && note.pitch === 64),
        `${navigation} then digit rewrote the old primary target`);
      assert(actual.notes.some((note) => note.part === 0 && note.at === "9/4" && note.degree === "7"),
        `${navigation} then digit missed the new primary beat: ${JSON.stringify(actual)}`);
      assertSelection(actual, ["0/0/9/4"]);
    }
  }

  // Two selected pitches inside one chord stay distinct through sorting and
  // source writeback; the untouched third tone cannot become selected.
  await reset("jpw", fixture.replace("1 2 3 4", "[135] 2 3 4"));
  await selectNotes([[0, "0", "1"], [0, "0", "3"]]);
  await page.keyboard.press("7");
  const sameChord = await state();
  assert.equal(sameChord.selected.length, 2);
  assert(sameChord.selected.every((note) => note.degree === "7"));
  assert.equal(sameChord.notes.filter((note) => note.part === 0 && note.at === "0" && note.degree === "5").length, 1);

  // Footprint checks use model-backed SVG primitives, not class names that
  // depend on minification. Include 16th/32nd/64th beams and one/two/three lower dots.
  await reset("jpw", ".Title\nTitle = {输入箭头避让}\nKeyAndMeters = {1=C,4/4}\n.Voice\n1,__ 2,,___ 3,,,____ 4___ |]\n");
  await selectNotes([[0, "0", "1"], [0, "1/4", "2"], [0, "3/8", "3"]]);
  for (const scale of [0.25, 1, 2]) {
    await page.evaluate((contentScale) => {
      const app = window.__app;
      app.setEngravingStyle({ ...app.engravingStyle, contentScale }, false);
    }, scale);
    const footprint = await page.evaluate(() => {
      const app = window.__app;
      const shapes = [...document.querySelectorAll("#score-pane svg line, #score-pane svg path")].flatMap((element) => {
        const item = app.painter.pageItemForTarget(element);
        if (!item) return [];
        const beam = typeof item.level === "number" && item.left?.chord && item.right?.chord;
        const dot = item.owner && typeof item.owner.text === "string" && element.tagName.toLowerCase() === "path";
        if (!beam && !dot) return [];
        const rect = element.getBoundingClientRect();
        return [{ type: beam ? "beam" : "dot", left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }];
      });
      const arrows = [...document.querySelectorAll(".score-input-caret, .score-input-triangle")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      const overlaps = arrows.flatMap((arrow) => shapes.filter((shape) =>
        arrow.right + 0.6 > shape.left && arrow.left - 0.6 < shape.right
        && arrow.bottom + 0.6 > shape.top && arrow.top - 0.6 < shape.bottom));
      return { beams: shapes.filter((shape) => shape.type === "beam").length,
        dots: shapes.filter((shape) => shape.type === "dot").length, arrows: arrows.length, overlaps };
    });
    assert(footprint.beams >= 2 && footprint.dots >= 6, `fixture did not cover beams/lower dots: ${JSON.stringify(footprint)}`);
    assert.equal(footprint.arrows, 6, `missing one arrow per input target: ${JSON.stringify(footprint)}`);
    assert.deepEqual(footprint.overlaps, [], `input arrows cover notation at scale ${scale}: ${JSON.stringify(footprint)}`);
  }
  await page.locator("#score-pane").screenshot({ path: join(root, "multi-input-arrow.png") });
  assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`);
  console.log("multi-input-browser-check: ok (JPW/keyboard multi-edit/delete, ghosts, Ctrl/Alt, horizontal/Space state, exact selection, one-step undo, beam/dot clearance)");
} finally {
  await browser.close();
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
