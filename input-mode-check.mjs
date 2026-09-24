// Browser regression for the logical numbered-notation input cursor.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm",
};
const server = createServer(async (request, response) => {
  try {
    let path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    if (path === "/") path = "/index.html";
    const data = await readFile(join(root, normalize(path)));
    response.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream" });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.message));

async function answerAppPrompt(value) {
  const dialog = page.locator('.app-dialog');
  await dialog.locator('input,textarea').first().fill(value);
  await dialog.getByRole('button', { name: '确定', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

const fixture = `.Title
Title = {打谱模式回归}
KeyAndMeters = {1=C,4/4}
Tempo = {90}
.Voice
1 2 3 4 |]
`;

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await page.evaluate((text) => { window.__app.documentFormat = "jpw"; window.__app.slashOptions = null; window.__app.setCodePaneCollapsed(true); window.__app.setText(text); }, fixture);
  await page.evaluate(() => window.__app.setRhythmEditDivision(16));
  await page.waitForTimeout(350);

  // Direct pitch entry and rhythmic arrow edits are input-mode commands.
  // A selected score note in ordinary viewing mode must not be changed by an
  // accidental digit, ArrowLeft/Right, or Ctrl+ArrowLeft/Right press.
  const ordinaryShortcutSource = await page.evaluate(() => window.__app.getText());
  await page.locator("#score-pane g.entry").first().click();
  await page.keyboard.press("5");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Control+ArrowRight");
  await page.waitForTimeout(100);
  const ordinaryShortcutResult = await page.evaluate(() => ({
    text: window.__app.getText(),
    input: window.__app._input.enabled,
  }));
  if (ordinaryShortcutResult.input
    || ordinaryShortcutResult.text !== ordinaryShortcutSource) {
    throw new Error(`ordinary score selection still accepted input-only shortcuts: ${JSON.stringify(ordinaryShortcutResult)}`);
  }
  await page.evaluate(() => window.__app.deselect(false));

  // Cursor grid and written duration are explicit, always-visible groups.
  // Choosing and clearing one duration must not disturb the grid.
  if (!await page.locator('.rhythm-group[data-rhythm-mode="grid"]').isVisible()
    || !await page.locator('.rhythm-group[data-rhythm-mode="duration"]').isVisible()
    || !await page.locator('button[data-rhythm-division="16"]').evaluate((button) => button.classList.contains("active"))) {
    throw new Error("timing toolbar did not show both groups with the selected grid value");
  }
  const eighthDurationButton = page.locator('button[data-input-duration-division="8"]');
  await eighthDurationButton.click();
  if (await page.evaluate(() => window.__app._inputDurationDivision) !== 8
    || !await eighthDurationButton.evaluate((button) => button.classList.contains("active"))) {
    throw new Error("duration group did not retain the selected eighth-note value");
  }
  await eighthDurationButton.click();
  if (await page.evaluate(() => window.__app._inputDurationDivision) !== null) {
    throw new Error("clicking the selected duration did not restore follow-grid mode");
  }
  if (!await page.locator('button[data-rhythm-division="16"]').evaluate((button) => button.classList.contains("active"))) {
    throw new Error("duration editing lost the independent grid selection");
  }

  await page.locator("#btn-input-mode").click();
  await page.waitForFunction(() => document.body.classList.contains("score-input-mode"));
  await page.waitForFunction(() => window.__app.painter.score.parts[0].measures.length === 1);
  if (await page.locator(".score-input-draft").count() !== 0) {
    throw new Error("legacy HTML-only tail draft is still visible");
  }
  const initialInputText = await page.evaluate(() => window.__app.getText());

  // Empty subdivisions must use the exact x coordinate of the visible
  // rhythm ruler, not a second interpolation from sparse note anchors.
  const emptyGridHit = await page.evaluate(() => {
    const app = window.__app;
    const svg = document.querySelector("#score-pane svg");
    const span = app.painter.rhythmInputSpansForPage(0, svg)
      .find((candidate) => candidate.measureIndex === 0);
    const anchor = span?.gridAnchors?.find((item) => Math.abs(item.tick - 0.5) < 1e-8);
    const row = span?.partRows.find((item) => item.partIndex === 0);
    const matrix = svg?.getScreenCTM();
    if (!anchor || !row || !matrix) return null;
    const point = new DOMPoint(anchor.x, (row.yTop + row.yBottom) / 2).matrixTransform(matrix);
    return { x: point.x, y: point.y, tick: anchor.tick };
  });
  if (!emptyGridHit) throw new Error("empty rhythm-guide subdivision is unavailable");
  await page.mouse.click(emptyGridHit.x, emptyGridHit.y);
  await page.waitForTimeout(60);
  const emptyGridResult = await page.evaluate((expectedX) => {
    const cursor = window.__app._input.cursor;
    const caret = document.querySelector(".score-input-caret")?.getBoundingClientRect();
    return {
      offset: cursor?.offset.toFloat() ?? null,
      xError: caret
        ? Math.abs((caret.left + caret.right) / 2 - expectedX)
        : null,
    };
  }, emptyGridHit.x);
  if (emptyGridResult.offset === null
    || Math.abs(emptyGridResult.offset - emptyGridHit.tick) > 1e-8
    || emptyGridResult.xError === null
    || emptyGridResult.xError > 2.5) {
    throw new Error(`empty-grid hit/cursor mismatch: ${JSON.stringify(emptyGridResult)}`);
  }

  const hit = await page.evaluate(() => {
    const app = window.__app;
    const svg = document.querySelector("#score-pane svg");
    const span = app.painter.rhythmInputSpansForPage(0, svg)
      .find((candidate) => candidate.measureIndex === 0);
    if (!span) return null;
    const anchor = span.anchors.find((item) => Math.abs(item.tick - 2) < 1e-8);
    const row = span.partRows.find((item) => item.partIndex === 0);
    const matrix = svg.getScreenCTM();
    if (!anchor || !row || !matrix) return null;
    const point = new DOMPoint(anchor.x, (row.yTop + row.yBottom) / 2).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });
  if (!hit) throw new Error("no rhythm input hit span");
  await page.mouse.click(hit.x, hit.y);
  await page.waitForFunction(() => !!document.querySelector(".score-input-cursor"));
  const cursorAlignment = await page.evaluate(() => {
    const caret = document.querySelector(".score-input-caret");
    const selected = document.querySelector(".score-page g.input-focused");
    if (!caret || !selected) return null;
    const caretRect = caret.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    return Math.abs((caretRect.left + caretRect.right) / 2
      - (selectedRect.left + selectedRect.right) / 2);
  });
  if (cursorAlignment === null || cursorAlignment > 2.5) {
    throw new Error(`cursor is not aligned to the selected rendered note: ${cursorAlignment}`);
  }
  await page.keyboard.press("5");
  await page.waitForFunction((before) => window.__app.getText() !== before, initialInputText);
  const afterReplace = await page.evaluate(() => window.__app.getText());
  if (!/1\s+2\s+5\s+4/.test(afterReplace)) {
    throw new Error(`digit did not replace focused note:\n${afterReplace}`);
  }

  await page.keyboard.press("ArrowUp");
  if (await page.locator(".score-input-note-placeholder").count() !== 1) {
    throw new Error("upper empty chord slot did not use one dashed note placeholder");
  }
  const placeholderAlignment = async () => page.evaluate(() => {
    const placeholder = document.querySelector(".score-input-note-placeholder")?.getBoundingClientRect();
    const caret = document.querySelector(".score-input-caret")?.getBoundingClientRect();
    const selected = document.querySelector(".score-page g.selected")?.getBoundingClientRect();
    if (!placeholder || !caret || !selected) return null;
    const placeholderX = (placeholder.left + placeholder.right) / 2;
    return {
      caret: Math.abs(placeholderX - (caret.left + caret.right) / 2),
      selected: Math.abs(placeholderX - (selected.left + selected.right) / 2),
    };
  });
  const upperAlignment = await placeholderAlignment();
  if (upperAlignment === null || upperAlignment.caret > 2.5 || upperAlignment.selected > 2.5) {
    throw new Error(`upper placeholder is not centered on its selected note: ${JSON.stringify(upperAlignment)}`);
  }
  const placeholderBoundaryState = async () => page.evaluate(() => {
    const cursor = window.__app._input.cursor;
    const box = document.querySelector(".score-input-note-placeholder")?.getBoundingClientRect();
    return {
      part: cursor?.partIndex ?? null,
      lane: cursor?.lane ?? null,
      vertical: cursor?.verticalIndex ?? null,
      box: box ? [box.left, box.top, box.width, box.height].map((value) => Math.round(value * 100) / 100) : null,
    };
  });
  const upperBoundaryBefore = await placeholderBoundaryState();
  await page.keyboard.press("ArrowUp");
  const upperBoundaryAfter = await placeholderBoundaryState();
  if (JSON.stringify(upperBoundaryAfter) !== JSON.stringify(upperBoundaryBefore)) {
    throw new Error(`ArrowUp escaped the highest placeholder without an upper part: ${JSON.stringify({
      before: upperBoundaryBefore,
      after: upperBoundaryAfter,
    })}`);
  }
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const lowerAlignment = await placeholderAlignment();
  if (lowerAlignment === null || lowerAlignment.caret > 2.5 || lowerAlignment.selected > 2.5) {
    throw new Error(`lower placeholder is not centered on its selected note: ${JSON.stringify(lowerAlignment)}`);
  }
  const lowerBoundaryBefore = await placeholderBoundaryState();
  await page.keyboard.press("ArrowDown");
  const lowerBoundaryAfter = await placeholderBoundaryState();
  if (JSON.stringify(lowerBoundaryAfter) !== JSON.stringify(lowerBoundaryBefore)) {
    throw new Error(`ArrowDown escaped the lowest placeholder without a lower part: ${JSON.stringify({
      before: lowerBoundaryBefore,
      after: lowerBoundaryAfter,
    })}`);
  }
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("3");
  const afterChord = await page.evaluate(() => window.__app.getText());
  if (!afterChord.includes("[")) throw new Error(`upper-lane digit did not create a chord:\n${afterChord}`);

  // Replace the chord with one tone, then add a semantic ornament from the
  // score-input context menu. The mark must survive JPW text round-tripping.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("5");
  const caretBox = await page.locator(".score-input-caret").boundingBox();
  if (!caretBox) throw new Error("input caret missing before context-menu test");
  await page.mouse.click(caretBox.x + caretBox.width / 2, caretBox.y + caretBox.height / 2, {
    button: "right",
  });
  await page.waitForTimeout(100);
  if (await page.getByRole("menuitem", { name: "上波音" }).count() === 0) {
    const menuDebug = await page.evaluate(() => ({
      cursor: window.__app._input.cursor && {
        part: window.__app._input.cursor.partIndex,
        measure: window.__app._input.cursor.measureIndex,
        offset: window.__app._input.cursor.offset.toString(),
        focusPitch: window.__app._input.focusPitch,
      },
      focus: (() => {
        const value = window.__app.inputFocus();
        return value ? {
          rest: value.chord.rest,
          position: value.chord.position.toString(),
          pitch: value.note.pitch,
        } : null;
      })(),
      caret: document.querySelector(".score-input-caret")?.getBoundingClientRect().toJSON() ?? null,
      contextMenus: document.querySelectorAll(".score-input-context-menu").length,
    }));
    throw new Error(`input context menu did not open after same-text normalization: ${JSON.stringify(menuDebug)}`);
  }
  await page.getByRole("menuitem", { name: "上波音" }).click();
  await page.waitForFunction(() => window.__app.getText().includes("upper-mordent"));
  if (await page.locator(".jianpu-ornament").count() < 1) {
    throw new Error("ornament metadata was not rendered after round-trip");
  }

  const measureCount = await page.evaluate(() => window.__app.painter.score.parts[0].measures.length);
  if (measureCount !== 1) {
    throw new Error(`entering/editing input mode appended an independent empty measure: ${measureCount}`);
  }

  const cursorVisible = await page.locator(".score-input-cursor").count();
  if (cursorVisible < 1) throw new Error("input cursor disappeared after materializing the draft");

  // A rendered gray tie continuation is the same logical note as its black
  // attack in JPW input mode. Editing either segment must update the complete
  // chain without breaking the incoming/outgoing tie. Empty space still
  // snaps to the visible ruler.
  await page.evaluate(() => window.__app.setInputMode(false));
  // Entering input mode must leave a deliberate all-rest source measure as-is:
  // no additional draft bar is appended and the source silence is retained.
  const existingSilentTail = `.Title
Title = {已有空尾小节}
KeyAndMeters = {1=C,4/4}
.Voice
1--- | 0 0 0 0 |]
`;
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    app.setInputMode(true);
  }, existingSilentTail);
  await page.waitForFunction(() => window.__app.painter.score.parts[0].measures.length === 2);
  await page.evaluate(() => window.__app.setInputMode(false));
  const retainedSilentTail = await page.evaluate(() => {
    const measures = window.__app.painter.score.parts[0].measures;
    return {
      count: measures.length,
      sourceTailSilent: measures[1]?.entries.filter((entry) => entry.notes)
        .every((entry) => entry.rest) ?? false,
    };
  });
  if (retainedSilentTail.count !== 2 || !retainedSilentTail.sourceTailSilent) {
    throw new Error(`JPW input tail cleanup removed source content: ${JSON.stringify(retainedSilentTail)}`);
  }
  await page.evaluate((text) => window.__app.setText(text), `.Title
Title = {延音与空白定位}
KeyAndMeters = {1=C,4/4}
.Voice
(1--- |1---) |]
`);
  await page.evaluate(() => window.__app.setRhythmEditDivision(16));
  await page.evaluate(() => window.__app.setInputMode(true));
  await page.waitForTimeout(180);
  const findContinuationPoint = async () => page.evaluate(() => {
    const app = window.__app;
    const chord = app.painter.score.parts[0]?.measures.flatMap((measure) => measure.entries)
      .find((entry) => entry.notes?.some((note) => note.tieEnd));
    const note = chord?.notes?.find((item) => item.tieEnd && item.tiePrev);
    const element = note ? app.painter.noteGroupEl(chord, note) : null;
    const rect = element?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  });
  const focusContinuation = async () => page.evaluate(() => {
    const app = window.__app;
    const chord = app.painter.score.parts[0]?.measures.flatMap((measure) => measure.entries)
      .find((entry) => entry.notes?.some((note) => note.tieEnd && note.tiePrev));
    const note = chord?.notes?.find((item) => item.tieEnd && item.tiePrev);
    if (!chord || !note) return false;
    app._input.setCursor(app.painter.score, {
      partIndex: 0,
      measureIndex: chord.measure.index,
      offset: chord.position,
      lane: "rest",
      verticalIndex: 0,
    }, note.pitch);
    app.selectInputFocus(false);
    app.renderInputCursor();
    return true;
  });
  let continuationPoint = await findContinuationPoint();
  if (!continuationPoint) throw new Error("tied continuation has no clickable visual");
  if (!await focusContinuation()) throw new Error("tied continuation could not receive input focus");
  const continuationCursor = await page.evaluate(() => ({
    measure: window.__app._input.cursor?.measureIndex,
    offset: window.__app._input.cursor?.offset.toFloat(),
  }));
  if (continuationCursor.measure !== 1 || Math.abs((continuationCursor.offset ?? -1) - 0) > 1e-8) {
    throw new Error(`tied continuation did not keep its own rhythmic slot: ${JSON.stringify(continuationCursor)}`);
  }
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForTimeout(220);
  const movedTieRight = await page.evaluate(() => {
    const app = window.__app;
    const root = app.painter.score.parts[0].measures.flatMap((measure) => measure.entries)
      .find((entry) => entry.notes?.some((note) => !note.rest && !note.tiePrev));
    const note = root?.notes.find((item) => !item.rest && !item.tiePrev);
    let total = root?.duration?.toFloat() ?? 0;
    let next = note?.tieNext ?? null;
    while (next) {
      total += next.chord.duration?.toFloat() ?? 0;
      next = next.tieNext;
    }
    return {
      at: root ? root.measure.position.plus(root.position).toFloat() : -1,
      total,
      cursorAt: app._input.cursor
        ? app.painter.score.parts[app._input.cursor.partIndex].measures[app._input.cursor.measureIndex]
          .position.plus(app._input.cursor.offset).toFloat()
        : -1,
      selectedContinuation: app._selectedNotes.some((item) => item.visualNote.tiePrev),
    };
  });
  if (Math.abs(movedTieRight.at - 0.25) > 1e-8
    || Math.abs(movedTieRight.total - 8) > 1e-8
    || Math.abs(movedTieRight.cursorAt - 0.25) > 1e-8
    || movedTieRight.selectedContinuation) {
    throw new Error(`Alt+Right did not move/select the complete tie chain root: ${JSON.stringify(movedTieRight)}`);
  }
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForTimeout(220);
  const movedTieBack = await page.evaluate(() => {
    const app = window.__app;
    const root = app.painter.score.parts[0].measures.flatMap((measure) => measure.entries)
      .find((entry) => entry.notes?.some((note) => !note.rest && !note.tiePrev));
    const note = root?.notes.find((item) => !item.rest && !item.tiePrev);
    let total = root?.duration?.toFloat() ?? 0;
    let next = note?.tieNext ?? null;
    while (next) {
      total += next.chord.duration?.toFloat() ?? 0;
      next = next.tieNext;
    }
    return { at: root ? root.measure.position.plus(root.position).toFloat() : -1, total };
  });
  if (Math.abs(movedTieBack.at) > 1e-8 || Math.abs(movedTieBack.total - 8) > 1e-8) {
    throw new Error(`Alt+Left did not restore the complete tie chain: ${JSON.stringify(movedTieBack)}`);
  }
  continuationPoint = await findContinuationPoint();
  if (!continuationPoint) throw new Error("tied continuation disappeared after whole-chain movement");
  if (!await focusContinuation()) throw new Error("moved tied continuation could not receive input focus");
  await page.keyboard.press("2");
  await page.waitForTimeout(180);
  const editedTieDegree = await page.evaluate(() => {
    const notes = window.__app.painter.score.parts[0]?.measures
      .flatMap((measure) => measure.entries)
      .flatMap((entry) => entry.notes ?? [])
      .filter((note) => !note.rest) ?? [];
    const root = notes.find((note) => note.tiePrev === null);
    const tail = root?.tieNext ?? null;
    return {
      numbers: [root?.number, tail?.number],
      pitches: [root?.pitch, tail?.pitch],
      linked: Boolean(root && tail && root.tieNext === tail && tail.tiePrev === root),
      transparent: Boolean(tail?.chord.transparentContinuation),
    };
  });
  if (editedTieDegree.numbers.some((number) => number !== "2")
    || editedTieDegree.pitches[0] !== editedTieDegree.pitches[1]
    || !editedTieDegree.linked
    || !editedTieDegree.transparent) {
    throw new Error(`editing a gray continuation did not update the complete tie: ${JSON.stringify(editedTieDegree)}`);
  }

  // Ctrl+Up from the gray segment, then Ctrl+Down from the black root, must
  // likewise keep every continuation at one octave and preserve both links.
  if (!await focusContinuation()) throw new Error("edited continuation could not regain input focus");
  await page.keyboard.press("Control+ArrowUp");
  await page.waitForTimeout(120);
  const raisedTie = await page.evaluate(() => {
    const notes = window.__app.painter.score.parts[0]?.measures
      .flatMap((measure) => measure.entries)
      .flatMap((entry) => entry.notes ?? [])
      .filter((note) => !note.rest) ?? [];
    const root = notes.find((note) => note.tiePrev === null);
    const tail = root?.tieNext ?? null;
    return {
      octaves: [root?.jpOctave, tail?.jpOctave],
      pitches: [root?.pitch, tail?.pitch],
      linked: Boolean(root && tail && root.tieNext === tail && tail.tiePrev === root),
    };
  });
  if (raisedTie.octaves.some((octave) => octave !== 1)
    || raisedTie.pitches[0] !== raisedTie.pitches[1]
    || !raisedTie.linked) {
    throw new Error(`raising a gray continuation did not update its tie root: ${JSON.stringify(raisedTie)}`);
  }
  await page.evaluate(() => {
    const app = window.__app;
    const root = app.painter.score.parts[0]?.measures
      .flatMap((measure) => measure.entries)
      .flatMap((entry) => entry.notes ?? [])
      .find((note) => !note.rest && note.tiePrev === null);
    if (!root) return;
    app._input.setCursor(app.painter.score, {
      partIndex: 0,
      measureIndex: root.chord.measure.index,
      offset: root.chord.position,
      lane: "rest",
      verticalIndex: 0,
    }, root.pitch);
    app.selectInputFocus(false);
    app.renderInputCursor();
    app.scorePane.focus({ preventScroll: true });
  });
  await page.keyboard.press("Control+ArrowDown");
  await page.waitForTimeout(120);
  const loweredTie = await page.evaluate(() => {
    const notes = window.__app.painter.score.parts[0]?.measures
      .flatMap((measure) => measure.entries)
      .flatMap((entry) => entry.notes ?? [])
      .filter((note) => !note.rest) ?? [];
    const root = notes.find((note) => note.tiePrev === null);
    const tail = root?.tieNext ?? null;
    return {
      octaves: [root?.jpOctave, tail?.jpOctave],
      linked: Boolean(root && tail && root.tieNext === tail && tail.tiePrev === root),
    };
  });
  if (loweredTie.octaves.some((octave) => octave !== 0) || !loweredTie.linked) {
    throw new Error(`lowering a tie root did not update its continuation: ${JSON.stringify(loweredTie)}`);
  }
  if (!await focusContinuation()) throw new Error("continuation focus was lost after whole-chain octave edits");
  await page.keyboard.press("ArrowUp");
  const tiedPlaceholderAlignment = await page.evaluate(() => {
    const placeholder = document.querySelector(".score-input-note-placeholder")?.getBoundingClientRect();
    const selected = document.querySelector(".score-page g.selected")?.getBoundingClientRect();
    const caret = document.querySelector(".score-input-caret")?.getBoundingClientRect();
    const app = window.__app;
    const svg = document.querySelector("#score-pane svg");
    const span = app.painter.rhythmInputSpansForPage(0, svg)
      .find((candidate) => candidate.measureIndex === 1 && candidate.partIndexes.includes(0));
    const owner = span?.owner ? app.painter.nodeMap.get(span.owner) : null;
    const tick = owner?.querySelector(
      ".rhythm-guide-tick.rhythm-guide-measure-1.rhythm-guide-beat-0",
    )?.getBoundingClientRect();
    if (!placeholder || !selected || !caret || !tick) return null;
    const placeholderX = (placeholder.left + placeholder.right) / 2;
    return {
      selected: Math.abs(placeholderX - (selected.left + selected.right) / 2),
      caret: Math.abs(placeholderX - (caret.left + caret.right) / 2),
      ruler: Math.abs(placeholderX - (tick.left + tick.right) / 2),
    };
  });
  if (tiedPlaceholderAlignment === null
    || tiedPlaceholderAlignment.selected > 2.5
    || tiedPlaceholderAlignment.caret > 2.5
    || tiedPlaceholderAlignment.ruler > 2.5) {
    throw new Error(`tied placeholder jumped away from its note/ruler: ${JSON.stringify(tiedPlaceholderAlignment)}`);
  }
  const tiedBlankPoint = await page.evaluate(() => {
    const app = window.__app;
    const svg = document.querySelector("#score-pane svg");
    const span = app.painter.rhythmInputSpansForPage(0, svg)
      .find((candidate) => candidate.measureIndex === 0 && candidate.partIndexes.includes(0));
    const anchor = span?.gridAnchors?.find((item) => Math.abs(item.tick - 0.5) < 1e-8);
    const row = span?.partRows?.find((item) => item.partIndex === 0);
    const matrix = svg?.getScreenCTM();
    if (!anchor || !row || !matrix) return null;
    const y = row.yBottom - (row.yBottom - row.yTop) * 0.18;
    const point = new DOMPoint(anchor.x, y).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });
  if (!tiedBlankPoint) throw new Error("tied measure has no empty subdivision hit point");
  await page.mouse.click(tiedBlankPoint.x, tiedBlankPoint.y);
  const tiedBlankCursor = await page.evaluate(() => ({
    measure: window.__app._input.cursor?.measureIndex,
    offset: window.__app._input.cursor?.offset.toFloat(),
  }));
  if (tiedBlankCursor.measure !== 0 || Math.abs((tiedBlankCursor.offset ?? -1) - 0.5) > 1e-8) {
    throw new Error(`empty tied-measure click jumped to a note: ${JSON.stringify(tiedBlankCursor)}`);
  }

  // Keyboard and number TXT use the same semantic tie chain as JPW. Editing
  // either the black attack or a gray continuation must update every printed
  // segment before compact TXT is serialized and reparsed. The V1 source
  // range must also remain mapped so clicking the note still selects text.
  const textTieFixtures = {
    keyboard: `键盘谱
4/4拍：
点=八分音符
-/-/-/(⁣Q Z)../
../../⁣W../X../
`,
    number: `数字谱
4/4拍：
点=八分音符
-/-/-/(⁣+1 -1)../
../../⁣+2../-2../
`,
  };
  const focusTextTieMember = async (continuation) => page.evaluate((tail) => {
    const app = window.__app;
    const notes = app.painter.score.parts[0]?.measures
      .flatMap((measure) => measure.entries)
      .flatMap((entry) => entry.notes ?? [])
      .filter((note) => !note.rest) ?? [];
    const root = notes.find((note) => note.tiePrev === null && note.tieNext !== null);
    let target = root;
    if (tail) {
      while (target?.tieNext) target = target.tieNext;
    }
    if (!target) return null;
    app._input.setCursor(app.painter.score, {
      partIndex: 0,
      measureIndex: target.chord.measure.index,
      offset: target.chord.position,
      lane: "rest",
      verticalIndex: 0,
    }, target.pitch);
    app.selectInputFocus(false);
    app.renderInputCursor();
    app.scorePane.focus({ preventScroll: true });
    const selected = app._selectedNotes.find((item) => item.visualNote === target)
      ?? app._selectedNotes[0];
    return {
      measure: target.chord.measure.index,
      selectedText: selected ? app.getText().slice(selected.source.from, selected.source.to) : "",
      voiceIndex: selected?.source.voiceIndex ?? null,
    };
  }, continuation);
  const inspectTextTie = async () => page.evaluate(() => {
    const app = window.__app;
    const notes = app.painter.score.parts[0]?.measures
      .flatMap((measure) => measure.entries)
      .flatMap((entry) => entry.notes ?? [])
      .filter((note) => !note.rest) ?? [];
    const root = notes.find((note) => note.tiePrev === null && note.tieNext !== null);
    const chain = [];
    let member = root ?? null;
    const seen = new Set();
    while (member && !seen.has(member)) {
      seen.add(member);
      chain.push(member);
      member = member.tieNext;
    }
    return {
      format: app.documentFormat,
      voiceCount: app.slashOptions?.voiceCount ?? 0,
      partCount: app.painter.score.parts.length,
      numbers: chain.map((note) => note.number),
      pitches: chain.map((note) => note.pitch),
      octaves: chain.map((note) => note.jpOctave),
      linked: chain.length >= 2
        && chain.slice(1).every((note, index) => note.tiePrev === chain[index]),
      transparent: chain.slice(1).every((note) => note.chord.transparentContinuation),
      source: app.getText(),
      markerCount: [...app.getText()].filter((char) => char === "\u2063").length,
      allNotes: app.painter.score.parts[0]?.measures
        .flatMap((measure) => measure.entries)
        .filter((entry) => entry.notes)
        .map((entry) => ({
          measure: entry.measure.index,
          position: entry.position.toFloat(),
          duration: entry.duration?.toFloat() ?? null,
          generated: entry.generatedTimingContinuation,
          transparent: entry.transparentContinuation,
          notes: entry.notes.map((note) => ({
            number: note.number,
            pitch: note.pitch,
            octave: note.jpOctave,
            tiePrev: Boolean(note.tiePrev),
            tieNext: Boolean(note.tieNext),
          })),
        })),
    };
  });
  for (const [format, text] of Object.entries(textTieFixtures)) {
    await page.evaluate(({ text, target }) => {
      const app = window.__app;
      app.setInputMode(false);
      app.documentFormat = target;
      app.slashOptions = {
        kind: target, voiceCount: 2, instrumentName: "钢琴",
        title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
        tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
        symbolDurations: { ".": 8 }, multiDurationSymbols: false,
        spaceDivision: null, noteDivision: null,
        braceMode: "none", bracketMode: "none", barMode: "none",
        angleMode: "none", parenMode: "chord", ordering: "pitch-asc",
        showExplicitRests: true,
      };
      app.setText(text);
      app.setRhythmEditDivision(16);
      app.setInputDurationDivision(16);
      app.setInputMode(true);
    }, { text, target: format });
    await page.waitForTimeout(220);

    const rootFocus = await focusTextTieMember(false);
    if (!rootFocus?.selectedText || rootFocus.voiceIndex !== 1) {
      throw new Error(`${format} tie root lost its V1 TXT selection: ${JSON.stringify(rootFocus)}`);
    }
    await page.keyboard.press("2");
    await page.waitForTimeout(180);
    let state = await inspectTextTie();
    if (state.format !== format || state.voiceCount !== 2 || state.partCount !== 2
      || state.numbers.length < 2 || state.numbers.some((number) => number !== "2")
      || new Set(state.pitches).size !== 1 || !state.linked || !state.transparent
      || state.markerCount === 0) {
      throw new Error(`${format} root pitch edit broke its TXT tie chain: ${JSON.stringify(state)}`);
    }

    const tailFocus = await focusTextTieMember(true);
    if (!tailFocus?.selectedText || tailFocus.voiceIndex !== 1) {
      throw new Error(`${format} gray continuation lost its V1 TXT selection: ${JSON.stringify(tailFocus)}`);
    }
    await page.keyboard.press("3");
    await page.waitForTimeout(180);
    state = await inspectTextTie();
    if (state.numbers.some((number) => number !== "3")
      || new Set(state.pitches).size !== 1 || !state.linked || !state.transparent) {
      throw new Error(`${format} continuation pitch edit did not update its root: ${JSON.stringify(state)}`);
    }
    const baseOctave = state.octaves[0];

    if (!await focusTextTieMember(true)) throw new Error(`${format} continuation could not regain focus`);
    await page.keyboard.press("Control+ArrowUp");
    await page.waitForTimeout(150);
    state = await inspectTextTie();
    if (state.octaves.some((octave) => octave !== baseOctave + 1)
      || new Set(state.pitches).size !== 1 || !state.linked) {
      throw new Error(`${format} continuation octave edit did not update its root: ${JSON.stringify(state)}`);
    }

    if (!await focusTextTieMember(false)) throw new Error(`${format} tie root could not regain focus`);
    await page.keyboard.press("Control+ArrowDown");
    await page.waitForTimeout(150);
    state = await inspectTextTie();
    if (state.octaves.some((octave) => octave !== baseOctave)
      || new Set(state.pitches).size !== 1 || !state.linked || state.markerCount === 0) {
      throw new Error(`${format} root octave edit did not update its continuation: ${JSON.stringify(state)}`);
    }
  }
  await page.evaluate(() => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "jpw";
    app.slashOptions = null;
  });

  // Keep a cursor on beat four, then select a whole-note grid and type. The
  // requested four-quarter value must consume the next formal rest measure
  // and become a tied cross-bar sound instead of being clipped to one beat.
  await page.evaluate(() => window.__app.setInputMode(false));
  await page.evaluate((text) => window.__app.setText(text), `.Title
Title = {跨小节输入}
KeyAndMeters = {1=C,4/4}
.Voice
0 0 0 0 |]
`);
  await page.evaluate(() => {
    window.__app.setRhythmEditDivision(4);
    window.__app.setInputDurationDivision(null);
  });
  await page.evaluate(() => {
    const app = window.__app;
    app.setInputMode(true);
    const first = app.painter.score.parts[0].measures[0].entries[0];
    app._input.setCursor(app.painter.score, {
      partIndex: 0, measureIndex: 0, offset: first.position,
      division: 4, lane: "rest", verticalIndex: 0,
    });
    app.renderInputCursor();
    app.scorePane.focus({ preventScroll: true });
  });
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.evaluate(() => window.__app.setRhythmEditDivision(1));
  await page.keyboard.press("1");
  await page.waitForTimeout(250);
  const crossBar = await page.evaluate(() => {
    const score = window.__app.painter.score;
    const root = score.parts[0].measures[0].entries.find((entry) =>
      !entry.rest && entry.position.toFloat() === 3);
    const note = root?.notes.find((item) => !item.rest);
    let total = root?.duration?.toFloat() ?? 0;
    let next = note?.tieNext ?? null;
    const measures = [];
    while (next) {
      measures.push(next.chord.measure.index);
      total += next.chord.duration?.toFloat() ?? 0;
      next = next.tieNext;
    }
    const last = score.parts[0].measures.at(-1);
    return {
      total,
      measures,
      count: score.parts[0].measures.length,
      lastRest: last?.entries.filter((entry) => entry.notes).every((entry) => entry.rest),
      text: window.__app.getText(),
      entries: score.parts[0].measures.map((measure) => measure.entries
        .filter((entry) => entry.notes)
        .map((entry) => ({
          rest: entry.rest,
          position: entry.position.toString(),
          duration: entry.duration?.toString(),
          numbers: entry.notes.map((note) => note.number),
        }))),
    };
  });
  if (Math.abs(crossBar.total - 4) > 1e-8
    || !crossBar.measures.includes(1)
    || crossBar.count !== 2
    || crossBar.lastRest) {
    throw new Error(`whole-note input did not create exactly the required sounding measure: ${JSON.stringify(crossBar)}`);
  }

  // Cursor grid and written duration are independent. Arrow keys keep the
  // sixteenth grid, Space advances by the eighth-note writing value, and the
  // toolbar dot independently augments either the value or the ruler.
  await page.evaluate(() => window.__app.setInputMode(false));
  await page.evaluate((text) => window.__app.setText(text), `.Title
Title = {独立刻度与时值}
KeyAndMeters = {1=C,4/4}
.Voice
0 0 0 0 |]
`);
  await page.evaluate(() => {
    const app = window.__app;
    app.setRhythmEditDivision(16);
    app.setInputDurationDivision(8);
    app.setInputMode(true);
    const first = app.painter.score.parts[0].measures[0].entries[0];
    app._input.setCursor(app.painter.score, {
      partIndex: 0, measureIndex: 0, offset: first.position,
      division: 16, lane: "rest", verticalIndex: 0,
    });
    app.renderInputCursor();
    app.scorePane.focus({ preventScroll: true });
  });
  await page.waitForTimeout(180);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("5");
  await page.waitForTimeout(180);
  const eighthInput = await page.evaluate(() => {
    const cursor = window.__app._input.cursor;
    const measure = window.__app.painter.score.parts[cursor.partIndex]
      ?.measures[cursor.measureIndex];
    const chord = measure?.entries.find((entry) =>
        !entry.rest && entry.position.equals(cursor.offset));
    return {
      duration: chord?.duration?.toFloat(),
      offset: cursor.offset.toFloat(),
      text: window.__app.getText(),
      entries: measure?.entries.filter((entry) => entry.notes).map((entry) => ({
        rest: entry.rest,
        position: entry.position.toString(),
        duration: entry.duration?.toString(),
        notes: entry.notes.map((note) => note.number),
      })),
    };
  });
  if (Math.abs((eighthInput.duration ?? -1) - 0.5) > 1e-8
    || Math.abs(eighthInput.offset - 0.5) > 1e-8) {
    throw new Error(`input did not use the independent eighth-note value: ${JSON.stringify(eighthInput)}`);
  }
  await page.keyboard.press("ArrowRight");
  const cursorAfterGridMove = await page.evaluate(() => window.__app._input.cursor?.offset.toFloat());
  if (Math.abs((cursorAfterGridMove ?? -1) - 0.75) > 1e-8) {
    throw new Error(`cursor did not keep the sixteenth-note grid: ${cursorAfterGridMove}`);
  }
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press(" ");
  const cursorAfterSpace = await page.evaluate(() => window.__app._input.cursor?.offset.toFloat());
  if (Math.abs((cursorAfterSpace ?? -1) - 1) > 1e-8) {
    throw new Error(`Space did not advance by the selected eighth-note value: ${cursorAfterSpace}`);
  }

  const durationDot = page.locator("#input-duration-dot-toggle");
  const gridDot = page.locator("#rhythm-grid-dot-toggle");
  await durationDot.click();
  if (!await durationDot.evaluate((button) => button.classList.contains("active"))
    || !await page.evaluate(() => window.__app._inputDurationDotted)) {
    throw new Error("duration dot toggle did not activate independently");
  }
  await page.keyboard.press("6");
  await page.waitForTimeout(180);
  const dottedState = await page.evaluate(() => {
    const cursor = window.__app._input.cursor;
    const measure = window.__app.painter.score.parts[cursor.partIndex]
      ?.measures[cursor.measureIndex];
    const chord = measure?.entries.find((entry) =>
      !entry.rest && entry.position.equals(cursor.offset));
    const note = chord?.notes?.find((item) => !item.rest);
    let total = chord?.duration?.toFloat() ?? 0;
    let continuation = note?.tieNext ?? null;
    while (continuation) {
      total += continuation.chord.duration?.toFloat() ?? 0;
      continuation = continuation.tieNext;
    }
    return {
      duration: total,
      entries: measure?.entries.map((entry) => ({
        rest: entry.rest,
        position: entry.position.toFloat(),
        duration: entry.duration?.toFloat(),
      })),
      status: document.querySelector("#status")?.textContent,
    };
  });
  if (Math.abs(dottedState.duration - 0.75) > 1e-8) {
    throw new Error(`toolbar dot did not create a dotted selected duration: ${JSON.stringify(dottedState)}`);
  }

  // The old period shortcut is intentionally gone; punctuation must not
  // resize the focused note anymore.
  const beforePeriod = await page.evaluate(() => window.__app.getText());
  await page.keyboard.press(".");
  await page.waitForTimeout(80);
  if (await page.evaluate(() => window.__app.getText()) !== beforePeriod) {
    throw new Error("period still changed a note after moving dot control to the toolbar");
  }

  await durationDot.click();
  await gridDot.click();
  await page.waitForTimeout(180);
  const dottedGrid = await page.evaluate(() => ({
    enabled: window.__app.engravingStyle.rhythmGuideDotted,
    muted: document.querySelectorAll(".rhythm-guide-tick.rhythm-guide-muted").length,
    active: document.querySelectorAll(".rhythm-guide-tick.rhythm-guide-dotted").length,
  }));
  if (!dottedGrid.enabled || dottedGrid.muted < 1 || dottedGrid.active < 1) {
    throw new Error(`dotted ruler did not retain muted binary ticks: ${JSON.stringify(dottedGrid)}`);
  }
  const beforeDottedArrow = await page.evaluate(() => window.__app._input.cursor?.offset.toFloat());
  await page.keyboard.press("ArrowRight");
  const afterDottedArrow = await page.evaluate(() => window.__app._input.cursor?.offset.toFloat());
  if (Math.abs((afterDottedArrow ?? -1) - ((beforeDottedArrow ?? 0) + 0.375)) > 1e-8) {
    throw new Error(`dotted sixteenth grid did not move by 3/32: ${beforeDottedArrow} -> ${afterDottedArrow}`);
  }
  await page.keyboard.press("ArrowLeft");
  await gridDot.click();

  // A dotted value needs a half-cell finer than its base value. At the
  // document's finest writable duration that cell does not exist, so the dot
  // control must clear itself and remain disabled instead of quantizing.
  await page.evaluate(() => window.__app.setInputDurationDivision(64));
  const finestDurationDot = await page.evaluate(() => {
    const button = document.querySelector("#input-duration-dot-toggle");
    button?.click();
    return {
      disabled: button?.disabled ?? false,
      pressed: button?.getAttribute("aria-pressed"),
      active: button?.classList.contains("active") ?? false,
      state: window.__app._inputDurationDotted,
    };
  });
  if (!finestDurationDot.disabled || finestDurationDot.pressed !== "false"
    || finestDurationDot.active || finestDurationDot.state) {
    throw new Error(`finest written duration still accepted a dot: ${JSON.stringify(finestDurationDot)}`);
  }
  await page.evaluate(() => window.__app.setInputDurationDivision(8));
  if (await durationDot.isDisabled()) {
    throw new Error("dot toggle stayed disabled after selecting a coarser written duration");
  }

  const openPositionMenu = async () => {
    const box = await page.locator(".score-input-caret").boundingBox();
    if (!box) throw new Error("input caret missing before notation-dialog test");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  };
  await openPositionMenu();
  await page.getByRole("menuitem", { name: "从本小节更换拍号…" }).click();
  if (await page.getByRole("button", { name: "3/4", exact: true }).count() !== 1) {
    throw new Error("time-signature preset dialog is missing 3/4");
  }
  await page.getByRole("button", { name: "3/4", exact: true }).click();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await page.waitForFunction(() => {
    const measure = window.__app.painter.score.parts[0]?.measures[0];
    return measure?.time.beats === 3 && measure.time.beatType === 4;
  });
  const meterRoundTrip = await page.evaluate(() => ({
    text: window.__app.getText(),
    header: document.querySelector("#score-pane")?.textContent ?? "",
  }));
  if (!meterRoundTrip.text.includes("KeyAndMeters = {1=C,3/4}")
    || !meterRoundTrip.header.includes("3/4")) {
    throw new Error(`opening meter did not survive JPW serialization/rendering: ${JSON.stringify(meterRoundTrip)}`);
  }

  await page.evaluate(() => window.__app.setRhythmEditDivision(16));
  const keyHit = await page.evaluate(() => {
    const app = window.__app;
    const svg = document.querySelector("#score-pane svg");
    const span = app.painter.rhythmInputSpansForPage(0, svg)
      .find((candidate) => candidate.measureIndex === 0 && candidate.partIndexes.includes(0));
    const anchor = span?.gridAnchors?.find((item) => Math.abs(item.tick - 0.25) < 1e-8);
    const row = span?.partRows.find((item) => item.partIndex === 0);
    const matrix = svg?.getScreenCTM();
    if (!anchor || !row || !matrix) return null;
    const point = new DOMPoint(anchor.x, (row.yTop + row.yBottom) / 2).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });
  if (!keyHit) throw new Error("quarter-beat key-change input position is unavailable");
  await page.mouse.click(keyHit.x, keyHit.y);
  await openPositionMenu();
  await page.getByRole("menuitem", { name: "从这里换调…" }).click();
  const keyButtons = await page.locator(".key-circle-option").count();
  const keyCircleBox = await page.locator(".key-circle-wheel").boundingBox();
  if (keyButtons !== 15 || !keyCircleBox || keyCircleBox.width < 250) {
    throw new Error(`circle-of-fifths dialog is incomplete: ${keyButtons} ${JSON.stringify(keyCircleBox)}`);
  }
  await page.locator('.key-circle-option[data-fifths="2"]').click();
  await page.waitForFunction(() => window.__app.painter.score.keyMarks.some((mark) => mark.fifths === 2));
  if (await page.locator(".key-signature-entry").count() < 1) {
    throw new Error("right-click key change exists in the model but is missing from the score");
  }

  await openPositionMenu();
  await page.getByRole("menuitem", { name: "添加文本…" }).click();
  await answerAppPrompt("测试文本");
  await page.waitForFunction(() => window.__app.painter.score.textMarks.some((mark) => mark.text === "测试文本"));
  if (await page.locator(".score-text-annotation").count() < 1) {
    throw new Error("right-click text annotation exists in the model but is missing from the score");
  }

  await openPositionMenu();
  await page.getByRole("menuitem", { name: "设置当前位置速度…", exact: true }).click();
  await answerAppPrompt("123");
  await page.waitForFunction(() => window.__app.painter.score.tempoMarks.some((mark) => mark.bpm === 123));
  if (await page.locator(".tempo-annotation").count() < 1) {
    throw new Error("right-click tempo annotation exists in the model but is missing from the score");
  }

  // The same input annotations must survive the compact keyboard/digital TXT
  // serializer. This is the path used by the coloured multi-voice editor and
  // is distinct from the JPW title-field round trip above.
  await page.evaluate(() => window.__app.setInputMode(false));
  await page.evaluate((text) => window.__app.setText(text), `.Title
Title = {空位跨声部}
KeyAndMeters = {1=C,4/4}
.Voice.RH
1--- |]
.Voice.LH
5--- |]
`);
  await page.evaluate(() => {
    const app = window.__app;
    app.setRhythmEditDivision(16);
    app.setInputMode(true);
    const first = app.painter.score.parts[0].measures[0].entries[0];
    app._input.setCursor(app.painter.score, {
      partIndex: 0, measureIndex: 0, offset: first.position,
      division: 16, lane: "rest", verticalIndex: 0,
    });
    app.renderInputCursor();
    app.scorePane.focus({ preventScroll: true });
  });
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  const emptyPartDown = await page.evaluate(() => ({
    part: window.__app._input.cursor?.partIndex,
    placeholder: document.querySelectorAll(".score-input-note-placeholder").length,
  }));
  await page.keyboard.press("ArrowUp");
  const emptyPartUp = await page.evaluate(() => ({
    part: window.__app._input.cursor?.partIndex,
    placeholder: document.querySelectorAll(".score-input-note-placeholder").length,
  }));
  if (emptyPartDown.part !== 1 || emptyPartDown.placeholder !== 0
    || emptyPartUp.part !== 0 || emptyPartUp.placeholder !== 0) {
    throw new Error(`empty input position did not switch parts directly: ${JSON.stringify({ emptyPartDown, emptyPartUp })}`);
  }
  await page.evaluate(() => window.__app.setInputMode(false));
  const inputModeStableText = `键盘谱
4/4拍：
点=16分音符
3/4拍:
(NDE).H.(AG).E./.H.G.H./D.N.B.D./
4/4拍:
// "第93小节第1.75拍到第94小节第1拍渐慢到65BPM"
.(0B).S.N./(0D).S.G.D./(0H).G.W.H./E.W.T.E./
// "第94小节第2拍到第95小节第1拍渐快到87BPM"
(0\u2063Y)..../..../..../..../
`;
  const inputModeStability = await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 2, instrumentName: "钢琴",
      title: "打谱模式文本稳定", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 72, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: null,
      braceMode: "grace", bracketMode: "triplet", ordering: "pitch-asc",
      showExplicitRests: true,
    };
    app.setText(text);
    const reloadOk = app.reload(text);
    const before = app.getText();
    const beforeMeters = app.painter.score.parts[0]?.measures.map((measure) => measure.time.beats);
    const parsedOptions = { ...app.slashOptions };
    app.setRhythmEditDivision(16);
    app.setInputMode(true);
    return {
      before,
      reloadOk,
      beforeMeters,
      parsedOptions,
      after: app.getText(),
      diagnostics: app._slashTimingDiagnostics,
      measures: app.painter.score.parts[0]?.measures.map((measure) => measure.time.beats),
    };
  }, inputModeStableText);
  if (inputModeStability.before !== inputModeStability.after
    || inputModeStability.diagnostics.some((item) => item.severity === "error")
    || !inputModeStability.measures.includes(3)) {
    throw new Error(`entering input mode rewrote a local-meter TXT score: ${JSON.stringify(inputModeStability)}`);
  }
  const changedMeterQuarterInput = await page.evaluate(() => {
    const app = window.__app;
    const measureIndex = app.painter.score.parts[1].measures.length - 1;
    const measure = app.painter.score.parts[1].measures[measureIndex];
    const rest = measure.entries.find((entry) => entry.notes && entry.rest
      && Math.abs(entry.position.toFloat()) < 1e-8);
    if (!rest) return { ok: false, reason: "missing default-voice rest" };
    app.setInputDurationDivision(4);
    app._input.setCursor(app.painter.score, {
      partIndex: 1,
      measureIndex,
      offset: rest.position,
      lane: "rest",
      verticalIndex: 0,
    }, null);
    app.inputDegree(1);
    const inspect = () => {
      const updated = app.painter.score.parts[1].measures[measureIndex];
      const attack = updated.entries.find((entry) => entry.notes && !entry.rest
        && Math.abs(entry.position.toFloat()) < 1e-8);
      const rests = updated.entries.filter((entry) => entry.notes && entry.rest);
      return {
        attackDuration: attack?.duration?.toFloat() ?? null,
        restDuration: rests.reduce((sum, entry) => sum + (entry.duration?.toFloat() ?? 0), 0),
        rests: rests.map((entry) => ({
          position: entry.position.toFloat(),
          duration: entry.duration?.toFloat() ?? null,
          beams: entry.beams,
          dot: entry.dot,
        })),
      };
    };
    const stages = [inspect()];
    app.resizeInputFocus(1);
    stages.push(inspect());
    app.resizeInputFocus(1);
    stages.push(inspect());
    app.resizeInputFocus(1);
    stages.push(inspect());
    const updated = app.painter.score.parts[1].measures[measureIndex];
    return {
      ok: true,
      meter: [updated.time.beats, updated.time.beatType],
      position: updated.position.toFloat(),
      stages,
      text: app.getText(),
    };
  });
  if (!changedMeterQuarterInput.ok
    || changedMeterQuarterInput.meter?.[0] !== 4
    || changedMeterQuarterInput.meter?.[1] !== 4
    || changedMeterQuarterInput.stages?.length !== 4
    || changedMeterQuarterInput.stages.some((stage, index) =>
      Math.abs((stage.attackDuration ?? -1) - (index + 1)) > 1e-8
      || Math.abs((stage.restDuration ?? -1) - (3 - index)) > 1e-8
      || stage.rests.length !== 3 - index
      || stage.rests.some((rest, restIndex) =>
        Math.abs(rest.position - (index + restIndex + 1)) > 1e-8
        || Math.abs((rest.duration ?? -1) - 1) > 1e-8))) {
    throw new Error(`quarter input after 3/4 -> 4/4 could not consume following rests: ${JSON.stringify(changedMeterQuarterInput)}`);
  }
  await page.evaluate(() => window.__app.setInputMode(false));

  // Exercise the first 4/4 bar immediately after a complete 3/4 bar through
  // the real TXT save/reparse loop. Its hidden MIDI bridge must keep the
  // tick-zero 3/4 signature, otherwise this one transition bar alone acquires
  // a one-beat-shifted edit boundary while the following 4/4 bar looks normal.
  const transitionBoundaryInput = await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 2, instrumentName: "钢琴",
      title: "换拍输入边界", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: null,
      braceMode: "arpeggio", bracketMode: "triplet", barMode: "grace",
      angleMode: "subdivide", parenMode: "chord", ordering: "pitch-asc",
      showExplicitRests: true,
    };
    app.setText(text);
    app.reload(text);
    app.setRhythmEditDivision(16);
    app.setInputDurationDivision(16);
    app._inputDurationDotted = false;
    app.setInputMode(true);
    const measure = app.painter.score.parts[1]?.measures[1];
    const rest = measure?.entries.find((entry) => entry.notes && entry.rest
      && Math.abs(entry.position.toFloat()) < 1e-8);
    if (!measure || !rest) return { ok: false, reason: "missing transition rest" };
    app._input.setCursor(app.painter.score, {
      partIndex: 1,
      measureIndex: 1,
      offset: rest.position,
      lane: "rest",
      verticalIndex: 0,
    }, null);
    app.inputDegree(1);
    for (let index = 0; index < 15; index++) {
      app.resizeInputFocus(1);
    }
    const part = app.painter.score.parts[1];
    const updated = part.measures[1];
    const attack = updated.entries.find((entry) => entry.notes && !entry.rest
      && Math.abs(entry.position.toFloat()) < 1e-8);
    let duration = 0;
    let note = attack?.notes.find((candidate) => !candidate.rest) ?? null;
    const visited = new Set();
    while (note && !visited.has(note)) {
      visited.add(note);
      duration += note.chord.duration?.toFloat() ?? 0;
      note = note.tieNext;
    }
    return {
      ok: true,
      positions: part.measures.map((item) => item.position.toFloat()),
      meters: part.measures.map((item) => [item.time.beats, item.time.beatType]),
      duration,
      rests: updated.entries.filter((entry) => entry.notes && entry.rest).map((entry) => ({
        position: entry.position.toFloat(),
        duration: entry.duration?.toFloat() ?? null,
      })),
      text: app.getText(),
    };
  }, `键盘谱
点=16分音符
3/4拍：
-/-/-/
4/4拍：
(0\u2063Y)..../..../..../..../
(0\u2063T)..../..../..../..../
`);
  if (!transitionBoundaryInput.ok
    || transitionBoundaryInput.positions?.length !== 3
    || transitionBoundaryInput.positions.some((position, index) =>
      Math.abs(position - [0, 3, 7][index]) > 1e-8)
    || transitionBoundaryInput.meters?.[1]?.[0] !== 4
    || transitionBoundaryInput.meters?.[1]?.[1] !== 4
    || Math.abs((transitionBoundaryInput.duration ?? -1) - 4) > 1e-8
    || transitionBoundaryInput.rests?.length !== 0) {
    throw new Error(`first 4/4 input bar after 3/4 retained a shifted boundary: ${JSON.stringify(transitionBoundaryInput)}`);
  }
  await page.evaluate(() => window.__app.setInputMode(false));

  // TXT follows the same no-draft lifecycle as JPW. Even when the source ends
  // in a full-rest bar, entering input mode neither appends another measure nor
  // rewrites the source text.
  const silentTxtSource = `键盘谱
4/4拍：
点=16分音符
A.../B.../C.../D.../
0.../0.../0.../0.../
`;
  const silentTxtTail = await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 1, instrumentName: "钢琴",
      title: "文本谱临时尾小节", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: null,
      braceMode: "arpeggio", bracketMode: "triplet", barMode: "grace",
      angleMode: "subdivide", parenMode: "chord", ordering: "pitch-asc",
      showExplicitRests: true,
    };
    app.setText(text);
    const before = app.getText();
    app.setInputMode(true);
    const during = app.painter.score.parts[0]?.measures.length ?? 0;
    app.setInputMode(false);
    return {
      before,
      after: app.getText(),
      during,
      afterCount: app.painter.score.parts[0]?.measures.length ?? 0,
    };
  }, silentTxtSource);
  if (silentTxtTail.during !== 2 || silentTxtTail.afterCount !== 2
    || silentTxtTail.before !== silentTxtTail.after) {
    throw new Error(`TXT session tail did not preserve a source-authored rest bar: ${JSON.stringify(silentTxtTail)}`);
  }

  // With "保留 0 休止符" enabled, Alt+Right moves the attack but leaves an
  // explicit rest at the vacated grid column. The previous note must not grow
  // across that gap during TXT serialization/reload.
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 1, instrumentName: "钢琴",
      title: "Alt 移动保留休止", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: 16,
      braceMode: "arpeggio", bracketMode: "triplet", barMode: "grace",
      angleMode: "subdivide", parenMode: "chord", ordering: "pitch-asc",
      showExplicitRests: true,
    };
    app.setText(text);
    app.setRhythmEditDivision(16);
    app.setInputDurationDivision(16);
    app._inputDurationDotted = false;
    app.setInputMode(true);
    const target = app.painter.score.parts[0]?.measures[0]?.entries.find((entry) =>
      entry.notes && !entry.rest && Math.abs(entry.position.toFloat() - 1) < 1e-8);
    if (!target) throw new Error("explicit-rest Alt fixture has no beat-two attack");
    app._input.setCursor(app.painter.score, {
      partIndex: 0,
      measureIndex: 0,
      offset: target.position,
      lane: "rest",
      verticalIndex: 0,
    }, target.notes[0]?.pitch ?? null);
    app.renderInputCursor();
    app.scorePane.focus();
  }, `键盘谱
4/4拍：
点=16分音符
A.../B0../C.../D.../
`);
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForTimeout(180);
  const explicitAltMove = await page.evaluate(() => {
    const measure = window.__app.painter.score.parts[0]?.measures[0];
    const entries = measure?.entries.filter((entry) => entry.notes).map((entry) => ({
      rest: entry.rest,
      position: entry.position.toFloat(),
      duration: entry.duration?.toFloat() ?? 0,
    })) ?? [];
    window.__app.setInputMode(false);
    return { entries, text: window.__app.getText() };
  });
  const retainedGap = explicitAltMove.entries.some((entry) => entry.rest
    && Math.abs(entry.position - 1) < 1e-8 && Math.abs(entry.duration - 0.25) < 1e-8);
  const movedAttack = explicitAltMove.entries.some((entry) => !entry.rest
    && Math.abs(entry.position - 1.25) < 1e-8);
  const previousStayedQuarter = explicitAltMove.entries.some((entry) => !entry.rest
    && Math.abs(entry.position) < 1e-8 && Math.abs(entry.duration - 1) < 1e-8);
  if (!retainedGap || !movedAttack || !previousStayedQuarter || !explicitAltMove.text.includes("0")) {
    throw new Error(`TXT Alt move did not retain its vacated explicit rest: ${JSON.stringify(explicitAltMove)}`);
  }

  // Implicit-rest TXT also enters input mode without manufacturing a second
  // measure. The existing score and source text stay byte-for-byte stable.
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 1, instrumentName: "钢琴",
      title: "尾部休止保留", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: null,
      braceMode: "arpeggio", bracketMode: "triplet", barMode: "grace",
      angleMode: "subdivide", parenMode: "chord", ordering: "pitch-asc",
      showExplicitRests: false,
    };
    app.setText(text);
    app.setRhythmEditDivision(16);
    app.setInputDurationDivision(4);
  }, `键盘谱
4/4拍：
点=16分音符
A.../0.../0.../0.../
`);
  await page.waitForTimeout(220);
  const implicitSetupState = await page.evaluate(() => {
    const app = window.__app;
    const before = app.getText();
    app.setInputMode(true);
    return {
      enabled: app._input.enabled,
      format: app.documentFormat,
      mode: app.mode,
      measures: app.painter.score.parts[0]?.measures.length,
      tailCreated: app._inputTailCreated,
      unchanged: before === app.getText(),
      renderedTail: [...document.querySelectorAll("#score-pane svg")].some((svg, pageIndex) =>
        app.painter.rhythmInputSpansForPage(pageIndex, svg)
          .some((span) => span.measureIndex === 1)),
    };
  });
  if (!implicitSetupState.enabled || implicitSetupState.measures !== 1
    || implicitSetupState.tailCreated
    || !implicitSetupState.unchanged || implicitSetupState.renderedTail) {
    throw new Error(`implicit-rest TXT appended an input draft: ${JSON.stringify(implicitSetupState)}`);
  }
  await page.evaluate(() => window.__app.setInputMode(false));
  await page.evaluate(() => {
    const app = window.__app;
    app.setInputDurationDivision(null);
    app.setEngravingStyle({ ...app.engravingStyle, rhythmGuideDotted: false }, false);
  });
  await page.waitForTimeout(180);

  // Multi-voice TXT follows the same rule: input mode does not append a
  // synchronized empty measure before the first real cross-bar edit.
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 2, instrumentName: "钢琴",
      title: "双声部尾部休止", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: null,
      braceMode: "arpeggio", bracketMode: "triplet", barMode: "grace",
      angleMode: "subdivide", parenMode: "chord", ordering: "pitch-asc",
      showExplicitRests: false,
    };
    app.setText(text);
    app.setRhythmEditDivision(16);
    app.setInputDurationDivision(4);
  }, `键盘谱
4/4拍：
点=16分音符
(⁣AQ).../(⁣BW).../(⁣CE).../(⁣DR).../
`);
  await page.waitForTimeout(220);
  const voicedDraftState = await page.evaluate(() => {
    const app = window.__app;
    const before = app.getText();
    app.setInputMode(true);
    const renderedMeasures = new Set();
    document.querySelectorAll("#score-pane svg").forEach((svg, pageIndex) => {
      app.painter.rhythmInputSpansForPage(pageIndex, svg)
        .forEach((span) => renderedMeasures.add(span.measureIndex));
    });
    return {
      measureCounts: app.painter.score.parts.map((part) => part.measures.length),
      renderedMeasures: [...renderedMeasures],
      unchanged: before === app.getText(),
      tailCreated: app._inputTailCreated,
    };
  });
  if (voicedDraftState.measureCounts.some((count) => count !== 1)
    || voicedDraftState.renderedMeasures.some((measure) => measure !== 0)
    || !voicedDraftState.unchanged || voicedDraftState.tailCreated) {
    throw new Error(`two-voice TXT appended an input draft: ${JSON.stringify(voicedDraftState)}`);
  }
  await page.evaluate(() => window.__app.setInputMode(false));
  await page.evaluate(() => window.__app.setInputDurationDivision(null));
  await page.waitForTimeout(180);

  // A model-only input edit may serialize to the exact same compact TXT.
  // Even then the editor must reparse it so the metrical combiner restores a
  // final full-measure sustain as one whole note instead of leaving temporary
  // tied fragments on screen.
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 2, instrumentName: "钢琴",
      title: "结尾全音符", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: null,
      braceMode: "arpeggio", bracketMode: "triplet", barMode: "grace",
      angleMode: "subdivide", parenMode: "chord", ordering: "pitch-asc",
      showExplicitRests: false,
    };
    app.setText(text);
  }, `键盘谱
4/4拍：
点=16分音符
(⁣AB)..⁣../..../..../..⁣../
`);
  await page.waitForTimeout(220);
  const sameTextNormalization = await page.evaluate(() => {
    const app = window.__app;
    const source = app.painter.score.parts[0]?.measures[0]?.entries
      .find((entry) => entry.notes && !entry.rest);
    if (!source?.duration) return { ok: false, reason: "missing source" };
    source.duration = source.duration.divInt(4);
    source.beats = 1;
    source.beams = 0;
    source.dot = 0;
    const before = app.getText();
    const ok = app.replaceDocumentText(before);
    return {
      ok,
      unchanged: app.getText() === before,
      parts: app.painter.score.parts.map((part) => part.measures[0]?.entries
        .filter((entry) => entry.notes && !entry.rest)
        .map((entry) => ({
          duration: entry.duration?.toFloat(),
          beats: entry.beats,
          dot: entry.dot,
          tied: entry.notes.some((note) => note.tieStart || note.tieEnd),
        }))),
    };
  });
  if (!sameTextNormalization.ok
    || !sameTextNormalization.unchanged
    || sameTextNormalization.parts.some((part) => part.length !== 1
      || Math.abs((part[0]?.duration ?? 0) - 4) > 1e-8
      || part[0]?.beats !== 4
      || part[0]?.dot !== 0
      || part[0]?.tied)) {
    throw new Error(`unchanged compact TXT did not normalize its live score model: ${JSON.stringify(sameTextNormalization)}`);
  }

  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 1, instrumentName: "钢琴",
      title: "文本谱标记", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: null,
      braceMode: "none", bracketMode: "triplet", ordering: "pitch-asc",
      showExplicitRests: true,
    };
    app.setText(text);
    app.setRhythmEditDivision(16);
    app.setInputMode(true);
  }, `键盘谱
4/4拍：
点=16分音符
A.../B.../C.../D.../
E.../F.../G.../A.../
`);
  // setText schedules the canonical TXT reload after the editor's 200 ms
  // debounce. Wait past that boundary so it cannot replace a caret created by
  // the following click while this annotation test is opening its menu.
  await page.waitForTimeout(320);
  const slashMarkHit = await page.evaluate(() => {
    const app = window.__app;
    const svg = document.querySelector("#score-pane svg");
    const span = app.painter.rhythmInputSpansForPage(0, svg)
      .find((candidate) => candidate.measureIndex === 0 && candidate.partIndexes.includes(0));
    const anchor = span?.gridAnchors?.find((item) => Math.abs(item.tick - 0.5) < 1e-8);
    const row = span?.partRows?.find((item) => item.partIndex === 0);
    const matrix = svg?.getScreenCTM();
    if (!anchor || !row || !matrix) return null;
    const point = new DOMPoint(anchor.x, (row.yTop + row.yBottom) / 2).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });
  if (!slashMarkHit) throw new Error("keyboard TXT has no annotation input position");
  await page.mouse.click(slashMarkHit.x, slashMarkHit.y);
  const openSlashMenu = async () => {
    const box = await page.locator(".score-input-caret").boundingBox();
    if (!box) throw new Error("keyboard TXT input caret is missing");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  };
  await openSlashMenu();
  await page.getByRole("menuitem", { name: "设置当前位置速度…" }).click();
  await answerAppPrompt("111");
  await page.waitForFunction(() => window.__app.painter.score.tempoMarks.some((mark) => mark.bpm === 111));
  if (await page.locator(".tempo-annotation").count() < 1) {
    throw new Error("keyboard TXT tempo annotation was lost during serialization");
  }
  await openSlashMenu();
  await page.getByRole("menuitem", { name: "从这里换调…" }).click();
  await page.locator('.key-circle-option[data-fifths="2"]').click();
  await page.waitForTimeout(250);
  const slashAnnotationState = await page.evaluate(() => ({
    keyLabels: document.querySelectorAll(".key-signature-entry").length,
    tempoLabels: document.querySelectorAll(".tempo-annotation").length,
    keyMarks: window.__app.painter.score.keyMarks.map((mark) => ({
      measure: mark.measure, offset: mark.offset.toString(), fifths: mark.fifths,
    })),
    text: window.__app.getText(),
  }));
  if (slashAnnotationState.keyLabels < 1 || slashAnnotationState.tempoLabels < 1
    || !slashAnnotationState.keyMarks.some((mark) => mark.fifths === 2)
    || !slashAnnotationState.text.includes("@jpeditor")) {
    throw new Error(`keyboard TXT annotations are not visible/persistent: ${JSON.stringify(slashAnnotationState)}`);
  }

  // A TXT triplet divides the undotted value already under the cursor.
  // The toolbar value is deliberately different here: it must neither resize
  // the source note nor pull a following attack into the new triplet.  The
  // source attack becomes member one and the two exposed members are rests.
  await page.evaluate(() => window.__app.setInputDurationDivision(8));
  const slashTripletHit = await page.evaluate(() => {
    const app = window.__app;
    const svg = document.querySelector("#score-pane svg");
    const span = app.painter.rhythmInputSpansForPage(0, svg)
      .find((candidate) => candidate.measureIndex === 0 && candidate.partIndexes.includes(0));
    const anchor = span?.gridAnchors?.find((item) => Math.abs(item.tick - 1) < 1e-8);
    const row = span?.partRows?.find((item) => item.partIndex === 0);
    const matrix = svg?.getScreenCTM();
    const source = app.painter.score.parts[0]?.measures[0]?.entries.find((entry) =>
      entry.notes && !entry.rest && Math.abs(entry.position.toFloat() - 1) < 1e-8);
    if (!anchor || !row || !matrix || !source?.duration) return null;
    const point = new DOMPoint(anchor.x, (row.yTop + row.yBottom) / 2).matrixTransform(matrix);
    return { x: point.x, y: point.y, sourceDuration: source.duration.toFloat() };
  });
  if (!slashTripletHit) throw new Error("keyboard TXT triplet start is unavailable");
  await page.mouse.click(slashTripletHit.x, slashTripletHit.y);
  await openSlashMenu();
  await page.getByRole("menuitem", { name: "在光标处创建三连音", exact: true }).click();
  await page.waitForTimeout(250);
  const slashTripletState = await page.evaluate(() => {
    const measure = window.__app.painter.score.parts[0]?.measures[0];
    const tuplets = measure?.entries.filter((entry) =>
      entry.notes?.some((note) => note.tuplet)
      && entry.position.toFloat() >= 1 - 1e-8
      && entry.position.toFloat() < 2 - 1e-8) ?? [];
    return {
      count: tuplets.length,
      positions: tuplets.map((entry) => entry.position.toFloat()),
      durations: tuplets.map((entry) => entry.duration?.toFloat()),
      begin: Boolean(tuplets[0]?.notes?.some((note) => note.tupletBegin)),
      rests: tuplets.map((entry) => entry.rest),
      end: Boolean(tuplets[tuplets.length - 1]?.notes?.some((note) => note.tupletEnd)),
      text: window.__app.getText(),
      visible: (document.querySelector("#score-pane")?.textContent ?? "")
        .includes(String.fromCharCode(0xe883)),
    };
  });
  // B... is a dotted eighth: remove the dot, then divide its eighth-note
  // span into three written sixteenths. The released dot stays silent.
  if (Math.abs(slashTripletHit.sourceDuration - 0.75) > 1e-8) {
    throw new Error(`keyboard TXT dotted-eighth fixture changed: ${slashTripletHit.sourceDuration}`);
  }
  const memberDuration = 1 / 6;
  const expectedTriplet = [1, 1 + memberDuration, 1 + memberDuration * 2];
  const expectedDurations = [memberDuration, memberDuration, memberDuration];
  if (slashTripletState.count !== 3
    || slashTripletState.positions.some((value, index) =>
      Math.abs(value - expectedTriplet[index]) > 1e-8)
    || slashTripletState.durations.some((value, index) =>
      Math.abs((value ?? -1) - expectedDurations[index]) > 1e-8)
    || slashTripletState.rests[0]
    || !slashTripletState.rests[1]
    || !slashTripletState.rests[2]
    || !slashTripletState.begin
    || !slashTripletState.end
    || !slashTripletState.text.includes("[")
    || !slashTripletState.visible) {
    throw new Error(`keyboard TXT triplet is not fixed, persistent, and visible: ${JSON.stringify(slashTripletState)}`);
  }
  // Clicking the otherwise empty visual space after the last printed member
  // must stay on that real 3:2 member, not fall back to a binary ruler tick.
  const tripletBlankHit = await page.evaluate(() => {
    const app = window.__app;
    const svg = document.querySelector("#score-pane svg");
    const span = app.painter.rhythmInputSpansForPage(0, svg)
      .find((candidate) => candidate.measureIndex === 0 && candidate.partIndexes.includes(0));
    const group = span?.tupletGroups?.find((candidate) => candidate.partIndex === 0);
    const row = span?.partRows?.find((item) => item.partIndex === 0);
    const last = group?.anchors.at(-1);
    const matrix = svg?.getScreenCTM();
    if (!group || !last || !row || !matrix) return null;
    const point = new DOMPoint(
      last.x + (group.endX - last.x) * 0.55,
      (row.yTop + row.yBottom) / 2,
    ).matrixTransform(matrix);
    return { x: point.x, y: point.y, expected: last.tick };
  });
  if (!tripletBlankHit) throw new Error("created TXT triplet has no real-member hit range");
  await page.mouse.click(tripletBlankHit.x, tripletBlankHit.y);
  const tripletBlankOffset = await page.evaluate(() => window.__app._input.cursor?.offset.toFloat());
  if (Math.abs((tripletBlankOffset ?? -1) - tripletBlankHit.expected) > 1e-8) {
    throw new Error(`triplet blank click fell back to the ordinary ruler: ${tripletBlankOffset}`);
  }
  const tripletMark = await page.locator("#score-pane .tuplet-mark").first().boundingBox();
  if (!tripletMark) throw new Error("created TXT triplet has no selectable bracket");
  await page.mouse.click(
    tripletMark.x + tripletMark.width / 2,
    tripletMark.y + tripletMark.height / 2,
  );
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => document.querySelectorAll("#score-pane .tuplet-mark").length === 0);
  const removedTripletState = await page.evaluate(() => ({
    scoreRow: window.__app.getText().split(/\r?\n/)
      .find((line) => !line.trim().startsWith("//") && line.includes("/")) ?? "",
    tuplets: window.__app.painter.score.parts[0].measures[0].entries.filter((entry) =>
      entry.notes?.some((note) => note.tuplet)).length,
  }));
  if (removedTripletState.tuplets !== 0 || removedTripletState.scoreRow.includes("[")) {
    throw new Error(`clicking the tuplet numeral and deleting did not unwrap it: ${JSON.stringify(removedTripletState)}`);
  }
  const slashMeterHit = await page.evaluate(() => {
    const app = window.__app;
    const svg = document.querySelector("#score-pane svg");
    const span = app.painter.rhythmInputSpansForPage(0, svg)
      .find((candidate) => candidate.measureIndex === 1 && candidate.partIndexes.includes(0));
    const anchor = span?.gridAnchors?.find((item) => Math.abs(item.tick) < 1e-8);
    const row = span?.partRows?.find((item) => item.partIndex === 0);
    const matrix = svg?.getScreenCTM();
    if (!anchor || !row || !matrix) return null;
    const point = new DOMPoint(anchor.x, (row.yTop + row.yBottom) / 2).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });
  if (!slashMeterHit) throw new Error("second TXT measure has no meter-change position");
  await page.mouse.click(slashMeterHit.x, slashMeterHit.y);
  await openSlashMenu();
  await page.getByRole("menuitem", { name: "从本小节更换拍号…" }).click();
  await page.getByRole("button", { name: "3/4", exact: true }).click();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await page.waitForFunction(() => {
    const measure = window.__app.painter.score.parts[0]?.measures[1];
    return measure?.timeChange && measure.time.beats === 3 && measure.time.beatType === 4;
  });
  const slashMeterState = await page.evaluate(() => {
    const app = window.__app;
    let element = null;
    const walk = (item) => {
      if (item?.data?.beats === 3 && item?.data?.beatType === 4) {
        element = app.painter.nodeMap.get(item) ?? element;
      }
      for (const child of item?.children ?? []) walk(child);
    };
    for (const layoutPage of app.painter.layout.pages) walk(layoutPage);
    const rect = element?.getBoundingClientRect();
    return {
      text: app.getText(),
      visible: Boolean(rect && rect.width > 0 && rect.height > 0),
      glyphText: element?.textContent ?? "",
    };
  });
  if (!slashMeterState.text.includes('"type":"meter","measure":1')
    || !slashMeterState.visible
    || !slashMeterState.glyphText.includes("3")
    || !slashMeterState.glyphText.includes("4")) {
    throw new Error(`keyboard TXT meter annotation is not visible/persistent: ${JSON.stringify(slashMeterState)}`);
  }
  const visibleRulerAlignment = await page.evaluate(() => {
    const app = window.__app;
    const svg = document.querySelector("#score-pane svg");
    const measureIndex = app._input.cursor?.measureIndex ?? 0;
    const span = app.painter.rhythmInputSpansForPage(0, svg)
      .find((candidate) => candidate.measureIndex === measureIndex && candidate.partIndexes.includes(0));
    const owner = span?.owner ? app.painter.nodeMap.get(span.owner) : null;
    const matrix = svg?.getScreenCTM();
    const ticks = owner ? [...owner.querySelectorAll(
      `.rhythm-guide-tick.rhythm-guide-measure-${measureIndex}`,
    )].map((element) => {
      const rect = element.getBoundingClientRect();
      return (rect.left + rect.right) / 2;
    }) : [];
    const anchors = span && matrix ? span.gridAnchors.map((anchor) => ({
      tick: anchor.tick,
      x: new DOMPoint(anchor.x, 0).matrixTransform(matrix).x,
    })) : [];
    const caret = document.querySelector(".score-input-caret")?.getBoundingClientRect();
    const cursorTick = app._input.cursor?.offset.toFloat();
    const expected = anchors.find((anchor) =>
      cursorTick !== undefined && Math.abs(anchor.tick - cursorTick) < 1e-8);
    return {
      tickErrors: anchors.map((anchor, index) => Math.abs(anchor.x - (ticks[index] ?? Number.NaN))),
      caretError: caret && expected
        ? Math.abs((caret.left + caret.right) / 2 - expected.x)
        : null,
    };
  });
  if (visibleRulerAlignment.caretError === null || visibleRulerAlignment.caretError > 2.5
    || visibleRulerAlignment.tickErrors.some((error) => !Number.isFinite(error) || error > 1.5)) {
    throw new Error(`input cursor is not using the visible ruler coordinates: ${JSON.stringify(visibleRulerAlignment)}`);
  }

  // Crossing a barline with the input cursor is navigation only. It must not
  // manufacture another measure; a new formal tail is created only after an
  // actual note is entered at the end of the score.
  await page.evaluate(() => window.__app.setInputMode(false));
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.setText(text);
    app.setRhythmEditDivision(16);
    app.setInputMode(true);
  }, `.Title
Title = {输入跨小节不增栏}
KeyAndMeters = {1=C,4/4}
.Voice
1 2 3 4 | 5 6 7 1 | 0 0 0 0 |]
`);
  await page.waitForTimeout(220);
  const beforeCrossing = await page.evaluate(() => window.__app.painter.score.parts[0].measures.length);
  const crossingHit = await page.evaluate(() => {
    const app = window.__app;
    for (let pageIndex = 0; pageIndex < document.querySelectorAll("#score-pane svg").length; pageIndex++) {
      const svg = document.querySelectorAll("#score-pane svg")[pageIndex];
      const span = app.painter.rhythmInputSpansForPage(pageIndex, svg)
        .find((candidate) => candidate.measureIndex === 0 && candidate.partIndexes.includes(0));
      const anchor = span?.anchors.find((item) => Math.abs(item.tick - 3) < 1e-8);
      const row = span?.partRows.find((item) => item.partIndex === 0);
      const matrix = svg?.getScreenCTM();
      if (!anchor || !row || !matrix) continue;
      const point = new DOMPoint(anchor.x, (row.yTop + row.yBottom) / 2).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    }
    return null;
  });
  if (!crossingHit) throw new Error("last beat hit for cross-barline navigation is unavailable");
  await page.mouse.click(crossingHit.x, crossingHit.y);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(100);
  const afterCrossing = await page.evaluate(() => window.__app.painter.score.parts[0].measures.length);
  if (afterCrossing !== beforeCrossing) {
    throw new Error(`moving the input cursor across a barline changed measure count: ${beforeCrossing} -> ${afterCrossing}`);
  }

  // Leaving input mode removes only the session-created draft. A silent bar
  // that was already present in the JPW source remains musical content.
  await page.evaluate(() => window.__app.setInputMode(false));
  const cleanedMeasures = await page.evaluate(() => {
    const measures = window.__app.painter.score.parts[0].measures;
    return {
      count: measures.length,
      sourceTailSilent: !measures[2]?.entries.some((entry) => entry.notes
        && !entry.rest && entry.notes.some((note) => !note.rest)),
    };
  });
  if (cleanedMeasures.count !== 3 || !cleanedMeasures.sourceTailSilent) {
    throw new Error(`input exit removed a source-authored rest measure: ${JSON.stringify(cleanedMeasures)}`);
  }

  // Exercise the context-menu measure commands. Inserting before/after the
  // cursor changes the model immediately; deleting the selected measures uses
  // the same menu path and removes all distinct measure indices represented by
  // the current score selection.
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.setText(text);
    app.setRhythmEditDivision(16);
    app.setInputMode(true);
  }, `.Title
Title = {小节菜单回归}
KeyAndMeters = {1=C,4/4}
.Voice
1 2 3 4 | 5 6 7 1 | 2 3 4 5 |]
`);
  await page.waitForTimeout(220);
  const menuHit = await page.evaluate(() => {
    const app = window.__app;
    const svg = document.querySelector("#score-pane svg");
    const span = app.painter.rhythmInputSpansForPage(0, svg)
      .find((candidate) => candidate.measureIndex === 1 && candidate.partIndexes.includes(0));
    const anchor = span?.anchors.find((item) => Math.abs(item.tick - 0) < 1e-8);
    const row = span?.partRows.find((item) => item.partIndex === 0);
    const matrix = svg?.getScreenCTM();
    if (!anchor || !row || !matrix) return null;
    const point = new DOMPoint(anchor.x, (row.yTop + row.yBottom) / 2).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });
  if (!menuHit) throw new Error("measure-menu cursor position is unavailable");
  await page.mouse.click(menuHit.x, menuHit.y);
  const menuAt = async (name) => {
    const caret = await page.locator(".score-input-caret").boundingBox();
    if (!caret) throw new Error(`input caret missing before menu action: ${name}`);
    await page.mouse.click(caret.x + caret.width / 2, caret.y + caret.height / 2, {
      button: "right",
    });
    await page.getByRole("menuitem", { name, exact: true }).click();
    await page.waitForTimeout(100);
  };
  const menuStartCount = await page.evaluate(() => window.__app.painter.score.parts[0].measures.length);
  await menuAt("在当前小节前插入小节");
  const afterInsertBefore = await page.evaluate(() => window.__app.painter.score.parts[0].measures.length);
  if (afterInsertBefore !== menuStartCount + 1) {
    throw new Error(`insert-before did not add one measure: ${menuStartCount} -> ${afterInsertBefore}`);
  }
  await menuAt("在当前小节后插入小节");
  const afterInsertAfter = await page.evaluate(() => window.__app.painter.score.parts[0].measures.length);
  if (afterInsertAfter !== afterInsertBefore + 1) {
    throw new Error(`insert-after did not add one measure: ${afterInsertBefore} -> ${afterInsertAfter}`);
  }
  const selectedMeasureSetup = await page.evaluate(() => {
    const app = window.__app;
    const measureIndices = [...new Set(app._sourceNotes
      .filter((source) => source.partIndex === 0 && !source.note.rest)
      .map((source) => source.note.chord.measure.index))].sort((left, right) => left - right);
    const targetMeasures = new Set([measureIndices[0], measureIndices.at(-1)]);
    const sources = app._sourceNotes
      .filter((source) => source.partIndex === 0 && !source.note.rest
        && targetMeasures.has(source.note.chord.measure.index))
      .filter((source, index, all) => all.findIndex((item) =>
        item.note.chord.measure.index === source.note.chord.measure.index) === index);
    app._selectedNotes = sources.map((source) => {
      const element = app.painter.noteGroupEl(source.note.chord, source.note, 0);
      element?.classList.add("selected");
      return { source, visualNote: source.note, verse: 0, element };
    });
    return sources.map((source) => source.note.chord.measure.index);
  });
  if (selectedMeasureSetup.length !== 2) {
    throw new Error(`could not prepare two selected measure notes: ${JSON.stringify(selectedMeasureSetup)}`);
  }
  await menuAt("删除当前/选中音符所在小节");
  const afterDelete = await page.evaluate(() => window.__app.painter.score.parts[0].measures.length);
  if (afterDelete !== afterInsertAfter - 2) {
    throw new Error(`delete-selected-measures did not remove both selected measures: ${afterInsertAfter} -> ${afterDelete}`);
  }

  // Input audition follows the SF2 timbre assigned to the clicked score row,
  // rather than always falling back to piano. Stub the audio backend so this
  // browser regression can inspect the exact part/timbre request.
  await page.evaluate((text) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "jpw";
    app.setText(text);
    app.playbackSoundSource = "sf2";
    app.selectedSoundfontId = "input-audition-fixture";
    app.soundfontCatalog = [{
      id: "input-audition-fixture",
      name: "input-audition-fixture",
      bytes: new Uint8Array([0]),
      instruments: ["PianoTone", "FengTone"],
    }];
    app.soundfontInstrumentByGroup = {
      "ensemble:钢琴": "PianoTone",
      "ensemble:风物琴": "FengTone",
    };
    window.__auditionRequest = null;
    app._player = {
      stop() {},
      stopAudition() {},
      audition(notes, sf2) {
        window.__auditionRequest = {
          notes: notes.map((note) => ({ ...note })),
          instruments: [...(sf2?.instrumentByPart ?? [])],
        };
        return Promise.resolve();
      },
    };
    app.setRhythmEditDivision(16);
    app.setInputMode(true);
  }, `.Title
Title = {分谱行音色试听}
KeyAndMeters = {1=C,4/4}
.Voice.钢琴.V1
1 2 3 4 |]
.Voice.风物琴.V1
5 6 7 1 |]
`);
  await page.waitForTimeout(180);
  const timbreHit = await page.evaluate(() => {
    const app = window.__app;
    const chord = app.painter.score.parts[1]?.measures[0]?.entries.find((entry) =>
      entry.notes && !entry.rest && Math.abs(entry.position.toFloat()) < 1e-8);
    const note = chord?.notes.find((item) => !item.rest);
    if (!chord || !note) return false;
    app._input.setCursor(app.painter.score, {
      partIndex: 1,
      measureIndex: 0,
      offset: chord.position,
      lane: "rest",
      verticalIndex: 0,
    }, note.pitch);
    app.selectInputFocus(false);
    app.renderInputCursor();
    app.auditionInputCursor(false);
    return true;
  });
  if (!timbreHit) throw new Error("second instrument row has no audition hit point");
  await page.waitForFunction(() => window.__auditionRequest !== null);
  const auditionRequest = await page.evaluate(() => window.__auditionRequest);
  if (auditionRequest.notes.length !== 1
    || auditionRequest.notes[0].part !== 1
    || auditionRequest.instruments.join("|") !== "PianoTone|FengTone") {
    throw new Error(`input audition did not preserve the row's SF2 timbre: ${JSON.stringify(auditionRequest)}`);
  }

  // Audition is driven by the exact semantic selection, not the whole chord
  // or every vertically aligned staff. Successive input clicks also must not
  // issue stopAudition(): a newly previewed tone may overlap a still-ringing
  // prior preview. Each requested note carries its complete notated duration.
  await page.evaluate((text) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "jpw";
    app.setText(text);
    window.__auditionRequests = [];
    window.__auditionStopCalls = 0;
    app._player = {
      stop() {},
      stopAudition() { window.__auditionStopCalls += 1; },
      audition(notes, sf2) {
        window.__auditionRequests.push({
          notes: notes.map((note) => ({ ...note })),
          instruments: [...(sf2?.instrumentByPart ?? [])],
        });
        return Promise.resolve();
      },
    };
    app.setRhythmEditDivision(16);
    app.setInputMode(true);
    // Ignore the intentional stop used while leaving the preceding fixture.
    window.__auditionStopCalls = 0;
  }, `.Title\r
Title = {精确多选试听}\r
KeyAndMeters = {1=C,4/4}\r
.Voice.钢琴.V1\r
4--- |]\r
.Voice.风物琴.V1\r
[56]--- |]\r
`);
  await page.waitForTimeout(180);
  const exactAuditionPoints = await page.evaluate(() => {
    const app = window.__app;
    return app._sourceNotes
      .filter((source) => !source.note.rest && source.note.chord.measure.index === 0)
      .map((source) => {
        const rendered = app.painter.noteGroupEl(source.chord, source.note);
        const rect = rendered?.getBoundingClientRect();
        return rect ? {
          number: source.note.number,
          part: source.partIndex,
          x: (rect.left + rect.right) / 2,
          y: (rect.top + rect.bottom) / 2,
          pitch: source.note.pitch,
        } : null;
      }).filter(Boolean);
  });
  const pointFor = (number, part) => exactAuditionPoints.find((point) =>
    point.number === number && point.part === part);
  const fourPoint = pointFor("4", 0);
  const fivePoint = pointFor("5", 1);
  const sixPoint = pointFor("6", 1);
  if (!fourPoint || !fivePoint || !sixPoint) {
    throw new Error(`exact audition fixture has missing glyphs: ${JSON.stringify(exactAuditionPoints)}`);
  }
  const clickAuditionTone = async (point, modifiers = []) => {
    await page.evaluate(({ number, part, additive }) => {
      const app = window.__app;
      const source = app._sourceNotes.find((candidate) =>
        candidate.partIndex === part && candidate.note.number === number
        && candidate.note.chord.measure.index === 0);
      if (!source) throw new Error(`missing audition source ${part}:${number}`);
      app._input.setCursor(app.painter.score, {
        partIndex: part,
        measureIndex: 0,
        offset: source.note.chord.position,
        lane: "rest",
        verticalIndex: 0,
      }, source.note.pitch);
      app.selectInputFocus(additive);
      app.renderInputCursor();
      app.auditionInputCursor(additive);
    }, { number: point.number, part: point.part, additive: modifiers.includes("Control") });
    await page.waitForTimeout(30);
  };
  await clickAuditionTone(fivePoint);
  await clickAuditionTone(sixPoint, ["Control"]);
  await clickAuditionTone(fourPoint, ["Control"]);
  await clickAuditionTone(fourPoint);
  await clickAuditionTone(fivePoint, ["Control"]);
  const exactAudition = await page.evaluate(() => ({
    requests: window.__auditionRequests,
    stopCalls: window.__auditionStopCalls,
  }));
  const requestedPitches = exactAudition.requests.map((request) =>
    request.notes.map((note) => note.pitch).sort((left, right) => left - right));
  const expectedPitches = [
    [fivePoint.pitch],
    [fivePoint.pitch, sixPoint.pitch].sort((left, right) => left - right),
    [fourPoint.pitch, fivePoint.pitch, sixPoint.pitch].sort((left, right) => left - right),
    [fourPoint.pitch],
    [fourPoint.pitch, fivePoint.pitch].sort((left, right) => left - right),
  ];
  if (exactAudition.stopCalls !== 0
    || JSON.stringify(requestedPitches) !== JSON.stringify(expectedPitches)
    || exactAudition.requests.some((request) => request.notes.some((note) =>
      !Number.isFinite(note.durationSeconds) || note.durationSeconds < 2.5))) {
    throw new Error(`input audition did not preserve exact tones/full duration/overlap: ${JSON.stringify(exactAudition)}`);
  }

  // Wave ornaments always use the canonical square-triplet `[ABA]` spelling.
  // Another delimiter being a triplet is insufficient: square brackets must
  // themselves be assigned to triplets, with no subdivision wrapper.
  const setFinestMordentFixture = async (squareTriplet) => page.evaluate(({ text, squareTriplet }) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 1, instrumentName: "钢琴",
      title: "最细波音", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: null,
      braceMode: squareTriplet ? "arpeggio" : "triplet",
      bracketMode: squareTriplet ? "triplet" : "grace",
      ordering: "pitch-asc", showExplicitRests: true,
    };
    app.setText(text);
    app.setRhythmEditDivision(16);
    app.setInputMode(true);
  }, {
    text: "键盘谱\n4/4拍：\n点=16分音符\nA./0.../0.../0.../\n",
    squareTriplet,
  });
  const clickFinestMordent = async () => {
    const point = await page.evaluate(() => {
      const app = window.__app;
      const source = app._sourceNotes.find((item) => !item.note.rest);
      const element = source ? app.painter.noteGroupEl(source.chord, source.note) : null;
      const rect = element?.getBoundingClientRect();
      return rect ? { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 } : null;
    });
    if (!point) throw new Error("finest-value TXT mordent note is not clickable");
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(80);
    let caret = await page.locator(".score-input-caret").boundingBox();
    if (!caret) {
      // Font/layout measurement can finish one frame after the first pointer
      // event on slower Edge runs. Repeating the exact semantic hit makes the
      // regression deterministic without changing the production behavior.
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(160);
      caret = await page.locator(".score-input-caret").boundingBox();
    }
    if (!caret) throw new Error("finest-value TXT mordent caret is missing");
    await page.mouse.click(caret.x + caret.width / 2, caret.y + caret.height / 2, { button: "right" });
  };
  await setFinestMordentFixture(false);
  await page.waitForTimeout(180);
  await clickFinestMordent();
  if (!await page.getByRole("menuitem", { name: "上波音", exact: true }).isDisabled()) {
    throw new Error("a TXT mordent was enabled while square brackets were not triplets");
  }
  await page.keyboard.press("Escape");
  await setFinestMordentFixture(true);
  await page.waitForTimeout(180);
  await clickFinestMordent();
  const finestMordentButton = page.getByRole("menuitem", { name: "上波音", exact: true });
  if (await finestMordentButton.isDisabled()) {
    throw new Error("square-triplet configuration did not enable a TXT mordent");
  }
  await finestMordentButton.click();
  await page.waitForFunction(() => window.__app.getText().includes("[")
    && document.querySelectorAll("#score-pane .jianpu-ornament").length >= 1);

  // Real two-row TXT path: add three kinds of notation marks through the
  // input context menu, serialize to compact TXT, immediately reparse it, and
  // require all three to remain visible in the resulting piano SVG.
  await page.evaluate(async (text) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    await app.changeDocumentFormat("keyboard");
    app.setRhythmEditDivision(16);
    app.setInputMode(true);
  }, `.Title
Title = {双声部文本谱标记}
KeyAndMeters = {1=C,4/4}
.Voice.RH
1 2 3 4 | 5 6 7 1 |]
.Voice.LH
1, 2, 3, 4, | 5, 6, 7, 1 |]
`);
  await page.waitForTimeout(240);
  const multiTxtHit = await page.evaluate(() => {
    const app = window.__app;
    const pages = [...document.querySelectorAll("#score-pane svg")];
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      const svg = pages[pageIndex];
      const span = app.painter.rhythmInputSpansForPage(pageIndex, svg)
        .find((candidate) => candidate.measureIndex === 1 && candidate.partIndexes.includes(0));
      const anchor = span?.gridAnchors?.find((item) => Math.abs(item.tick - 0.5) < 1e-8);
      const row = span?.partRows?.find((item) => item.partIndex === 0);
      const matrix = svg?.getScreenCTM();
      if (!anchor || !row || !matrix) continue;
      const point = new DOMPoint(anchor.x, (row.yTop + row.yBottom) / 2).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    }
    return null;
  });
  if (!multiTxtHit) throw new Error("two-row TXT annotation position is unavailable");
  await page.mouse.click(multiTxtHit.x, multiTxtHit.y);
  const openMultiTxtMenu = async () => {
    const caret = await page.locator(".score-input-caret").boundingBox();
    if (!caret) throw new Error("two-row TXT input caret is missing");
    await page.mouse.click(caret.x + caret.width / 2, caret.y + caret.height / 2, {
      button: "right",
    });
  };
  await openMultiTxtMenu();
  await page.getByRole("menuitem", { name: "设置当前位置速度…", exact: true }).click();
  await answerAppPrompt("132");
  await openMultiTxtMenu();
  await page.getByRole("menuitem", { name: "从这里换调…", exact: true }).click();
  await page.locator('.key-circle-option[data-fifths="2"]').click();
  await openMultiTxtMenu();
  await page.getByRole("menuitem", { name: "从本小节更换拍号…", exact: true }).click();
  await page.getByRole("button", { name: "3/4", exact: true }).click();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await page.waitForTimeout(280);
  const multiTxtAnnotations = await page.evaluate(() => {
    const app = window.__app;
    const visibleRects = (selector) => [...document.querySelectorAll(selector)]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0).length;
    let meterVisible = false;
    const walk = (item) => {
      if (item?.data?.beats === 3 && item?.data?.beatType === 4) {
        const rect = app.painter.nodeMap.get(item)?.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0) meterVisible = true;
      }
      for (const child of item?.children ?? []) walk(child);
    };
    for (const layoutPage of app.painter.layout.pages) walk(layoutPage);
    return {
      format: app.documentFormat,
      parts: app.painter.score.parts.length,
      tempoModel: app.painter.score.tempoMarks.some((mark) =>
        mark.measure === 1 && Math.abs(mark.offset.toFloat() - 0.5) < 1e-8 && mark.bpm === 132),
      keyModel: app.painter.score.keyMarks.some((mark) =>
        mark.measure === 1 && Math.abs(mark.offset.toFloat() - 0.5) < 1e-8 && mark.fifths === 2),
      meterModel: app.painter.score.parts.every((part) =>
        part.measures[1]?.timeChange
        && part.measures[1].time.beats === 3
        && part.measures[1].time.beatType === 4),
      tempoVisible: visibleRects(".tempo-annotation"),
      keyVisible: visibleRects(".key-signature-entry"),
      meterVisible,
      optionAnnotations: app.slashOptions?.annotations?.length ?? 0,
      text: app.getText(),
    };
  });
  if (multiTxtAnnotations.format !== "keyboard"
    || multiTxtAnnotations.parts !== 2
    || !multiTxtAnnotations.tempoModel
    || !multiTxtAnnotations.keyModel
    || !multiTxtAnnotations.meterModel
    || multiTxtAnnotations.tempoVisible < 1
    || multiTxtAnnotations.keyVisible < 1
    || !multiTxtAnnotations.meterVisible
    || multiTxtAnnotations.optionAnnotations < 3
    || !multiTxtAnnotations.text.includes('"type":"meter","measure":1')) {
    throw new Error(`two-row TXT marks disappeared after immediate reparse: ${JSON.stringify(multiTxtAnnotations)}`);
  }
  const normalizedFooter = multiTxtAnnotations.text.replace(/\r\n/g, "\n");
  if (!/\/[^\n]*\n\n\/\/ @jpeditor [^\n]+(?:\n\/\/ @(?:key|tempo) [^\n]+)*\n?$/.test(normalizedFooter)
    || normalizedFooter.includes("\n\n\n// @jpeditor ")) {
    throw new Error(`TXT machine metadata is not a one-blank-line footer:\n${normalizedFooter}`);
  }

  // Input-mode clicks on notation objects select the semantic mark instead
  // of moving the rhythm caret. Enter edits it and Delete removes it.
  await page.locator("#score-pane .tempo-annotation").last().click();
  let selectedObject = await page.evaluate(() => window.__app._selectedObjects.at(-1)?.kind ?? null);
  if (selectedObject !== "tempo") throw new Error(`tempo mark was not selectable: ${selectedObject}`);
  await page.keyboard.press("Enter");
  await answerAppPrompt("144");
  await page.waitForFunction(() => window.__app.painter.score.tempoMarks.some((mark) => mark.bpm === 144));
  await page.locator("#score-pane .tempo-annotation").last().click();
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => document.querySelectorAll("#score-pane .tempo-annotation.soft-deleted").length >= 1);

  await page.locator("#score-pane .key-signature-entry").last().click();
  selectedObject = await page.evaluate(() => window.__app._selectedObjects.at(-1)?.kind ?? null);
  if (selectedObject !== "key") throw new Error(`key signature was not selectable: ${selectedObject}`);
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => !window.__app.painter.score.keyMarks.some((mark) => mark.fifths === 2));

  const meterObjectPoint = await page.evaluate(() => {
    const app = window.__app;
    let element = null;
    const walk = (item) => {
      if (item?.data?.beats === 3 && item?.data?.beatType === 4) {
        element = app.painter.nodeMap.get(item) ?? element;
      }
      for (const child of item?.children ?? []) walk(child);
    };
    for (const layoutPage of app.painter.layout.pages) walk(layoutPage);
    const rect = element?.getBoundingClientRect();
    return rect ? { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 } : null;
  });
  if (!meterObjectPoint) throw new Error("changed meter has no selectable SVG object");
  await page.mouse.click(meterObjectPoint.x, meterObjectPoint.y);
  selectedObject = await page.evaluate(() => window.__app._selectedObjects.at(-1)?.kind ?? null);
  if (selectedObject !== "meter") throw new Error(`time signature was not selectable: ${selectedObject}`);
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => {
    const measure = window.__app.painter.score.parts[0]?.measures[1];
    return measure?.time.beats === 4 && measure.time.beatType === 4 && !measure.timeChange;
  });

  const currentCaret = await page.locator(".score-input-caret").boundingBox();
  if (!currentCaret) throw new Error("input caret disappeared before text-object test");
  await page.mouse.click(
    currentCaret.x + currentCaret.width / 2,
    currentCaret.y + currentCaret.height / 2,
    { button: "right" },
  );
  await page.getByRole("menuitem", { name: "添加文本…", exact: true }).click();
  await answerAppPrompt("测试文本");
  await page.waitForFunction(() => document.querySelectorAll("#score-pane .score-text-annotation").length >= 1);
  await page.locator("#score-pane .score-text-annotation").last().click();
  selectedObject = await page.evaluate(() => window.__app._selectedObjects.at(-1)?.kind ?? null);
  if (selectedObject !== "text") throw new Error(`score text was not selectable: ${selectedObject}`);
  await page.keyboard.press("Enter");
  await answerAppPrompt("修改后的文本");
  await page.waitForFunction(() => window.__app.painter.score.textMarks.some((mark) => mark.text === "修改后的文本"));
  await page.locator("#score-pane .score-text-annotation").last().click();
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => window.__app.painter.score.textMarks.length === 0);

  const textOrnamentNote = await page.evaluate(() => {
    const app = window.__app;
    const source = app._sourceNotes.find((item) => item.partIndex === 0 && !item.note.rest);
    const rendered = source ? app.painter.noteGroupEls(source.chord, source.note)[0] : null;
    const rect = rendered?.element.getBoundingClientRect();
    return rect ? { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 } : null;
  });
  if (!textOrnamentNote) throw new Error("TXT ornament test has no sounding note");
  await page.mouse.click(textOrnamentNote.x, textOrnamentNote.y);
  const textOrnamentCaret = await page.locator(".score-input-caret").boundingBox();
  if (!textOrnamentCaret) throw new Error("input caret disappeared before TXT ornament test");
  await page.mouse.click(
    textOrnamentCaret.x + textOrnamentCaret.width / 2,
    textOrnamentCaret.y + textOrnamentCaret.height / 2,
    { button: "right" },
  );
  for (const removed of ["延长号", "连接到下一同音", "连奏到下一音"]) {
    if (await page.getByRole("menuitem", { name: removed, exact: true }).count() !== 0) {
      throw new Error(`TXT input menu retained removed command: ${removed}`);
    }
  }
  const unavailableTrill = page.getByRole("menuitem", { name: "Tr 颤音", exact: true });
  if (await unavailableTrill.count() !== 1 || !await unavailableTrill.isDisabled()) {
    throw new Error("TXT Tr command was enabled without a delimiter assigned to trill");
  }
  await page.getByRole("menuitem", { name: "上波音", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelectorAll("#score-pane .jianpu-ornament").length >= 1
    && window.__app.getText().includes("["));
  await page.locator("#score-pane .jianpu-ornament").last().click();
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
  const deletedTextOrnament = await page.evaluate(() => ({
    ornaments: document.querySelectorAll("#score-pane .jianpu-ornament").length,
    text: window.__app.getText(),
    notation: window.__app.getText().split(/\n\/\/ @jpeditor /, 1)[0],
    selected: window.__app._selectedObjects.map((item) => item.kind),
    parts: window.__app.painter.score.parts.length,
    tuplets: window.__app.painter.score.parts.reduce((count, part) => count
      + part.measures.reduce((measureCount, measure) => measureCount
        + measure.entries.filter((entry) => entry.notes?.some((note) => note.tuplet)).length, 0), 0),
  }));
  if (deletedTextOrnament.ornaments !== 0
    || deletedTextOrnament.notation.includes("[")
    || deletedTextOrnament.parts !== 2
    || deletedTextOrnament.tuplets !== 0
    || !deletedTextOrnament.notation.includes("Z\u2063A")
    || !deletedTextOrnament.notation.includes("X\u2063S")) {
    throw new Error(`deleting a TXT mordent did not collapse its realized triplet: ${JSON.stringify(deletedTextOrnament)}`);
  }

  // Grace notes and ornaments remain editable objects while input mode is
  // active; their shortcuts must not accidentally write at the rhythm caret.
  await page.evaluate((text) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    app.setRhythmEditDivision(16);
    app.setInputMode(true);
    const first = app.painter.score.parts[0].measures[0].entries.find((entry) => entry.notes);
    if (!first) throw new Error("grace fixture has no first note");
    app._input.setCursor(app.painter.score, {
      partIndex: 0, measureIndex: 0, offset: first.position,
      division: 16, lane: "rest", verticalIndex: 0,
    });
    app.renderInputCursor();
    app.scorePane.focus({ preventScroll: true });
  }, `.Title\r
KeyAndMeters = {1=C,4/4}\r
.Voice\r
{2}3 4 5 6 |]\r
`);
  await page.waitForFunction(() => document.querySelectorAll("#score-pane .jianpu-grace-number").length === 1);
  await page.locator("#score-pane .jianpu-grace-number").click();
  selectedObject = await page.evaluate(() => window.__app._selectedObjects.at(-1)?.kind ?? null);
  if (selectedObject !== "grace") throw new Error(`input-mode grace was not an object selection: ${selectedObject}`);
  await page.keyboard.press("6");
  await page.waitForFunction(() => /\{6\}3/.test(window.__app.getText()));
  await page.locator("#score-pane .jianpu-grace-number").click();
  await page.keyboard.press("Control+ArrowUp");
  await page.waitForFunction(() => /\{6'\}3/.test(window.__app.getText()));
  const gracePitch = await page.evaluate(() => {
    const source = window.__app._sourceNotes.find((item) => item.grace);
    return source ? { pitch: source.note.pitch, octave: source.note.jpOctave } : null;
  });
  if (!gracePitch || gracePitch.octave !== 1 || gracePitch.pitch < 69) {
    throw new Error(`grace pitch model did not follow degree/octave edits: ${JSON.stringify(gracePitch)}`);
  }
  await page.locator("#score-pane .jianpu-grace-number").click();
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => document.querySelectorAll("#score-pane .jianpu-grace-number").length === 0);

  const ornamentCaret = await page.locator(".score-input-caret").boundingBox();
  if (!ornamentCaret) throw new Error("input caret disappeared before ornament selection test");
  await page.mouse.click(
    ornamentCaret.x + ornamentCaret.width / 2,
    ornamentCaret.y + ornamentCaret.height / 2,
    { button: "right" },
  );
  await page.getByRole("menuitem", { name: "上波音", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("#score-pane .jianpu-ornament").length === 1);
  await page.locator("#score-pane .jianpu-ornament").click();
  selectedObject = await page.evaluate(() => window.__app._selectedObjects.at(-1)?.kind ?? null);
  if (selectedObject !== "ornament") throw new Error(`ornament was not selectable: ${selectedObject}`);
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => document.querySelectorAll("#score-pane .jianpu-ornament").length === 0);

  // JPW keeps a native fermata, but it must be an independently selectable
  // and deletable score object rather than falling through to its note.
  const fermataCaret = await page.locator(".score-input-caret").boundingBox();
  if (!fermataCaret) throw new Error("input caret disappeared before fermata object test");
  await page.mouse.click(
    fermataCaret.x + fermataCaret.width / 2,
    fermataCaret.y + fermataCaret.height / 2,
    { button: "right" },
  );
  await page.getByRole("menuitem", { name: "延长号", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("#score-pane .jianpu-fermata").length === 1);
  await page.locator("#score-pane .jianpu-fermata").click();
  selectedObject = await page.evaluate(() => window.__app._selectedObjects.at(-1)?.kind ?? null);
  if (selectedObject !== "fermata") throw new Error(`fermata was not selectable: ${selectedObject}`);
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => document.querySelectorAll("#score-pane .jianpu-fermata").length === 0);

  // Inside a 3:2 container the duration toolbar represents written values,
  // while the score stores their compressed actual spans. Exercise the real
  // keyboard path for both document formats: 16 -> 32 -> 16 -> 8 -> dotted
  // 8, then one further 16th must leave the bracket as an ordinary tie.
  const selectTupletRoot = async () => {
    const point = await page.evaluate(() => {
      const app = window.__app;
      const source = app._sourceNotes.find((item) =>
        !item.note.rest && item.note.tupletBegin && item.note.tuplet !== null);
      const rendered = source ? app.painter.noteGroupEls(source.chord, source.note)[0] : null;
      const rect = rendered?.element.getBoundingClientRect();
      return rect ? { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 } : null;
    });
    if (!point) throw new Error("variable triplet has no selectable root note");
    await page.mouse.click(point.x, point.y);
  };
  const inspectTupletResize = () => page.evaluate(() => {
    const app = window.__app;
    const entries = app.painter.score.parts[0]?.measures[0]?.entries
      .filter((entry) => entry.notes) ?? [];
    const root = entries.find((entry) => !entry.rest
      && entry.notes.some((note) => note.tupletBegin && note.tuplet));
    const rootNote = root?.notes.find((note) => !note.rest && note.tuplet) ?? null;
    const tuplet = rootNote?.tuplet ?? null;
    const members = tuplet ? entries.filter((entry) =>
      entry.notes.some((note) => note.tuplet === tuplet)) : [];
    const continuation = rootNote?.tieNext?.chord ?? null;
    return {
      duration: root?.duration?.toFloat() ?? null,
      beams: root?.beams ?? null,
      dot: root?.dot ?? null,
      members: members.length,
      tupleRests: members.filter((entry) => entry.rest).map((entry) => ({
        position: entry.position.toFloat(),
        duration: entry.duration?.toFloat() ?? null,
      })),
      rests: entries.filter((entry) => entry.rest).map((entry) => ({
        position: entry.position.toFloat(),
        duration: entry.duration?.toFloat() ?? null,
      })),
      continuationDuration: continuation?.duration?.toFloat() ?? null,
      continuationTuplet: continuation?.notes.some((note) => note.tuplet !== null) ?? null,
      tied: Boolean(rootNote?.tieNext),
      text: app.getText(),
    };
  });
  const exerciseTupletResize = async (label) => {
    await page.evaluate(() => window.__app.setInputDurationDivision(32));
    if (await page.evaluate(() => window.__app._inputDurationDivision) !== 32) {
      throw new Error(`${label}: 32nd written value was not enabled`);
    }
    await selectTupletRoot();
    await page.keyboard.press("Control+ArrowLeft");
    await page.waitForTimeout(180);
    let state = await inspectTupletResize();
    if (Math.abs((state.duration ?? -1) - 1 / 6) > 1e-8
      || state.beams !== 2 || state.dot !== 0) {
      throw new Error(`${label}: global 32nd value shortened a fixed 16th-triplet cell: ${JSON.stringify(state)}`);
    }
    await page.keyboard.press("Control+ArrowRight");
    await page.waitForTimeout(180);
    state = await inspectTupletResize();
    if (Math.abs((state.duration ?? -1) - 1 / 3) > 1e-8 || state.beams !== 1 || state.dot !== 0) {
      throw new Error(`${label}: fixed 16th-triplet step did not merge two cells: ${JSON.stringify(state)}`);
    }
    await page.evaluate(() => window.__app.setInputDurationDivision(64));
    await page.keyboard.press("Control+ArrowLeft");
    await page.waitForTimeout(180);
    state = await inspectTupletResize();
    if (Math.abs((state.duration ?? -1) - 1 / 6) > 1e-8 || state.beams !== 2 || state.dot !== 0) {
      throw new Error(`${label}: global 64th value changed the triplet member step: ${JSON.stringify(state)}`);
    }
    await page.evaluate(() => window.__app.setInputDurationDivision(8));
    await page.keyboard.press("Control+ArrowRight");
    await page.waitForTimeout(180);
    state = await inspectTupletResize();
    if (Math.abs((state.duration ?? -1) - 1 / 3) > 1e-8 || state.beams !== 1 || state.dot !== 0) {
      throw new Error(`${label}: global eighth value changed the fixed 16th-triplet step: ${JSON.stringify(state)}`);
    }
    await page.keyboard.press("Control+ArrowRight");
    await page.waitForTimeout(180);
    state = await inspectTupletResize();
    if (Math.abs((state.duration ?? -1) - 1 / 2) > 1e-8 || state.beams !== 1 || state.dot !== 1) {
      throw new Error(`${label}: three 16ths did not merge into a dotted eighth: ${JSON.stringify(state)}`);
    }
    const beforeOutsideState = state;
    await page.keyboard.press("Control+ArrowRight");
    await page.waitForTimeout(180);
    state = await inspectTupletResize();
    if (Math.abs((state.duration ?? -1) - 1 / 2) > 1e-8
      || state.continuationDuration !== null || state.tied
      || state.text !== beforeOutsideState.text) {
      throw new Error(`${label}: a full triplet was extended outside its bracket: ${JSON.stringify({ beforeOutsideState, state })}`);
    }
    return state;
  };

  await page.evaluate((text) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    app.setRhythmEditDivision(32);
    app.setInputMode(true);
  }, `.Title\r
KeyAndMeters = {1=C,2/4}\r
.Voice\r
{(3}1__ 0__ 0__) 0. |]\r
`);
  await page.waitForTimeout(220);
  const jpwTupletResize = await exerciseTupletResize("JPW");
  if (!jpwTupletResize.text.includes("{(3}")) {
    throw new Error(`JPW: variable triplet marker was lost:\n${jpwTupletResize.text}`);
  }

  await page.evaluate((text) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "number";
    app.slashOptions = {
      kind: "number", voiceCount: 1, instrumentName: "钢琴",
      title: "文本谱三连音时值", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 2, beatType: 4,
      symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: null,
      braceMode: "arpeggio", bracketMode: "triplet", barMode: "grace",
      angleMode: "subdivide", parenMode: "chord", ordering: "pitch-asc",
      showExplicitRests: true,
    };
    app.setText(text);
    app.setRhythmEditDivision(32);
    app.setInputMode(true);
  }, `数字谱
2/4拍：
点=16分音符
[1.0.0.]0../0..../
`);
  await page.waitForTimeout(220);
  await page.evaluate(() => window.__app.setInputDurationDivision(32));
  const txtTupletLimit = await page.evaluate(() => ({
    duration: window.__app._inputDurationDivision,
    text: window.__app.getText(),
    status: document.getElementById("status")?.textContent ?? "",
  }));
  if (txtTupletLimit.duration === 32
    || !txtTupletLimit.text.includes("[")
    || !txtTupletLimit.status.includes("最细只能写到 16 分音符")) {
    throw new Error(`TXT: an unmapped 32nd value was enabled: ${JSON.stringify(txtTupletLimit)}`);
  }

  // Hand-written JPW may close a triplet after two equal members and leave
  // the conventional third cell blank. Typing there through the real app
  // path must complete three written 16ths, not re-quantize all three to 64ths.
  const completedJpwTuple = await page.evaluate((text) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    app.setRhythmEditDivision(16);
    app.setInputDurationDivision(16);
    app.setInputMode(true);
    const FractionCtor = app.painter.score.parts[0].measures[0].position.constructor;
    app._input.setCursor(app.painter.score, {
      partIndex: 0, measureIndex: 0, offset: new FractionCtor(1, 3),
      division: 16, lane: "rest",
    });
    app.inputDegree(3);
    const members = app.painter.score.parts[0]?.measures[0]?.entries
      .filter((entry) => entry.notes?.some((note) => note.tuplet)) ?? [];
    return {
      count: members.length,
      durations: members.map((entry) => entry.duration?.toFloat() ?? null),
      beams: members.map((entry) => entry.beams),
      sounding: members.filter((entry) => !entry.rest).length,
      text: app.getText(),
    };
  }, `.Title
KeyAndMeters = {1=C,4/4}
.Voice
{(3}1__ 2__) |]
`);
  if (!completedJpwTuple
    || completedJpwTuple.count !== 3
    || completedJpwTuple.sounding !== 3
    || completedJpwTuple.durations.some((value) => Math.abs((value ?? -1) - 1 / 6) > 1e-8)
    || completedJpwTuple.beams.some((value) => value !== 2)) {
    throw new Error(`JPW third-member input shrank its triplet: ${JSON.stringify(completedJpwTuple)}`);
  }

  // Filling any of the three explicit zero cells through the real input-mode
  // path must preserve the triplet's written value.  This differs from the
  // legacy missing-third case above: every member already exists, so the
  // editor must replace only its content and must not quantize the fixed 3:2
  // cell a second time after each immediate JPW serialization/reparse.
  const filledExplicitJpwTuple = await page.evaluate((text) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    app.setRhythmEditDivision(16);
    app.setInputDurationDivision(16);
    app.setInputMode(true);
    const offsets = [[0, 1], [1, 6], [1, 3]];
    for (let index = 0; index < offsets.length; index++) {
      // The existing tuplet cell owns its written value. A stale/finer
      // toolbar selection must not halve that cell when its zero is replaced.
      app.setInputDurationDivision(index === 0 ? 32 : 16);
      const FractionCtor = app.painter.score.parts[0].measures[0].position.constructor;
      app._input.setCursor(app.painter.score, {
        partIndex: 0,
        measureIndex: 0,
        offset: new FractionCtor(offsets[index][0], offsets[index][1]),
        division: 16,
        lane: "rest",
      });
      app.inputDegree(index + 1);
    }
    const members = app.painter.score.parts[0]?.measures[0]?.entries
      .filter((entry) => entry.notes?.some((note) => note.tuplet)) ?? [];
    return {
      count: members.length,
      durations: members.map((entry) => entry.duration?.toFloat() ?? null),
      beams: members.map((entry) => entry.beams),
      sounding: members.filter((entry) => !entry.rest).length,
      text: app.getText(),
    };
  }, `.Title
KeyAndMeters = {1=C,4/4}
.Voice
{(3}0__ 0__ 0__) (4 4) 0. |]
`);
  if (!filledExplicitJpwTuple
    || filledExplicitJpwTuple.count !== 3
    || filledExplicitJpwTuple.sounding !== 3
    || filledExplicitJpwTuple.durations.some((value) => Math.abs((value ?? -1) - 1 / 6) > 1e-8)
    || filledExplicitJpwTuple.beams.some((value) => value !== 2)) {
    throw new Error(`JPW explicit triplet input changed its written value: ${JSON.stringify(filledExplicitJpwTuple)}`);
  }

  const fineJpwInput = await page.evaluate((source) => {
    const app = window.__app;
    const states = [];
    for (const division of [32, 64]) {
      app.setInputMode(false);
      app.documentFormat = "jpw";
      app.slashOptions = null;
      app.setText(source);
      app.setRhythmEditDivision(division);
      app.setInputDurationDivision(division);
      app.setInputMode(true);
      const FractionCtor = app.painter.score.parts[0].measures[0].position.constructor;
      const step = new FractionCtor(4, division);
      const setCursor = (offset, pitch = null) => {
        app._input.setCursor(app.painter.score, {
          partIndex: 0,
          measureIndex: 0,
          offset,
          division,
          lane: "rest",
        }, pitch);
      };
      setCursor(new FractionCtor(0));
      app.inputDegree(1);
      setCursor(step);
      app.inputDegree(2);
      setCursor(new FractionCtor(0), 60);
      app.deleteInputFocus();
      setCursor(step, 62);
      app.deleteInputFocus();
      const chords = app.painter.score.parts[0]?.measures[0]?.entries
        .filter((entry) => entry.notes) ?? [];
      const end = chords.reduce((latest, chord) => {
        const value = chord.position.plus(chord.duration);
        return value.compareTo(latest) > 0 ? value : latest;
      }, new FractionCtor(0));
      const rests = chords.filter((chord) => chord.rest)
        .reduce((total, chord) => total.plus(chord.duration), new FractionCtor(0));
      states.push({
        division,
        end: end.toFloat(),
        rests: rests.toFloat(),
        sounding: chords.filter((chord) => !chord.rest).length,
        text: app.getText(),
      });
    }
    return states;
  }, `.Title
KeyAndMeters = {1=C,4/4}
.Voice
0--- |]
`);
  if (!fineJpwInput || fineJpwInput.some((state) =>
    Math.abs(state.end - 4) > 1e-8
    || Math.abs(state.rests - 4) > 1e-8
    || state.sounding !== 0)) {
    throw new Error(`JPW 32nd/64th input-delete changed or swallowed the bar: ${JSON.stringify(fineJpwInput)}`);
  }

  // Exercise the real Alt keyboard path across coincident rest boundaries.
  // The rest following the moved sixteenth repeatedly lands on an existing
  // rest onset; it must stay one zero instead of serializing as `[00]`.
  await page.evaluate((text) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    app.setRhythmEditDivision(16);
    app.setInputDurationDivision(16);
    app.setInputMode(true);
    const note = app.painter.score.parts[0]?.measures[0]?.entries
      .find((entry) => !entry.rest && entry.notes?.some((item) => !item.rest))?.notes[0];
    if (!note) throw new Error("fine Alt fixture has no attack");
    app._input.setCursor(app.painter.score, {
      partIndex: 0,
      measureIndex: 0,
      offset: note.chord.position,
      division: 16,
      lane: "rest",
      verticalIndex: 0,
    }, note.pitch);
    app.selectInputFocus(false);
    app.scorePane.focus({ preventScroll: true });
  }, `.Title
KeyAndMeters = {1=C,4/4}
.Voice
1__ 0__ 0_ 0 0 0 |]
`);
  for (let index = 0; index < 5; index++) {
    await page.keyboard.press("Alt+ArrowRight");
    await page.waitForTimeout(80);
  }
  const fineAltState = await page.evaluate(() => {
    const app = window.__app;
    const chords = app.painter.score.parts[0]?.measures[0]?.entries
      .filter((entry) => entry.notes)
      .sort((left, right) => left.position.compareTo(right.position)) ?? [];
    return {
      positions: chords.map((chord) => chord.position.toFloat()),
      durations: chords.map((chord) => chord.duration?.toFloat() ?? 0),
      restNotes: chords.filter((chord) => chord.rest).map((chord) => chord.notes.length),
      text: app.getText(),
    };
  });
  const fineAltEnd = Math.max(...fineAltState.positions.map((position, index) =>
    position + fineAltState.durations[index]));
  if (Math.abs(fineAltEnd - 4) > 1e-8
    || new Set(fineAltState.positions).size !== fineAltState.positions.length
    || fineAltState.restNotes.some((count) => count !== 1)
    || fineAltState.text.includes("[00]")) {
    throw new Error(`JPW Alt movement merged/moved rests incorrectly: ${JSON.stringify(fineAltState)}`);
  }

  // Ctrl+Right with a 32nd/64th value leaves a non-single-token rest
  // remainder. Verify the actual input-mode serialization after every edit.
  const fineResizeStates = [];
  for (const division of [32, 64]) {
    await page.evaluate(({ text, division }) => {
      const app = window.__app;
      app.setInputMode(false);
      app.documentFormat = "jpw";
      app.slashOptions = null;
      app.setText(text);
      app.setRhythmEditDivision(division);
      app.setInputDurationDivision(division);
      app.setInputMode(true);
      const note = app.painter.score.parts[0]?.measures[0]?.entries
        .find((entry) => !entry.rest && entry.notes?.some((item) => !item.rest))?.notes[0];
      if (!note) throw new Error("fine resize fixture has no attack");
      app._input.setCursor(app.painter.score, {
        partIndex: 0,
        measureIndex: 0,
        offset: note.chord.position,
        division,
        lane: "rest",
        verticalIndex: 0,
      }, note.pitch);
      app.selectInputFocus(false);
      app.scorePane.focus({ preventScroll: true });
    }, {
      division,
      text: `.Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 0 0 0 |]\n`,
    });
    for (let index = 0; index < 3; index++) {
      await page.keyboard.press("Control+ArrowRight");
      await page.waitForTimeout(80);
    }
    fineResizeStates.push(await page.evaluate((division) => {
      const app = window.__app;
      const chords = app.painter.score.parts[0]?.measures[0]?.entries
        .filter((entry) => entry.notes)
        .sort((left, right) => left.position.compareTo(right.position)) ?? [];
      return {
        division,
        positions: chords.map((chord) => chord.position.toFloat()),
        durations: chords.map((chord) => chord.duration?.toFloat() ?? 0),
        text: app.getText(),
      };
    }, division));
  }
  for (const state of fineResizeStates) {
    const end = Math.max(...state.positions.map((position, index) =>
      position + state.durations[index]));
    if (Math.abs(end - 4) > 1e-8
      || new Set(state.positions).size !== state.positions.length) {
      throw new Error(`JPW ${state.division}th Ctrl resize changed the bar: ${JSON.stringify(state)}`);
    }
  }

  // A single dotted member can represent the complete 3:2 span.  Both JPW
  // and TXT previews should engrave only the numeral above the attack; the
  // normal two-hook bracket remains reserved for multi-member tuplets.
  const singleTupletMark = await page.evaluate(async (text) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    const inspect = () => ({
      marks: document.querySelectorAll("#score-pane .tuplet-mark").length,
      numbers: document.querySelectorAll("#score-pane .tuplet-number").length,
      brackets: document.querySelectorAll("#score-pane .tuplet-bracket").length,
    });
    const jpw = inspect();
    await app.changeDocumentFormat("number");
    const number = inspect();
    return { jpw, number, text: app.getText() };
  }, `.Title
KeyAndMeters = {1=C,2/4}
.Voice
{(3}1._) 0. |]
`);
  for (const [format, state] of Object.entries({
    JPW: singleTupletMark.jpw,
    TXT: singleTupletMark.number,
  })) {
    if (state.marks !== 1 || state.numbers !== 1 || state.brackets !== 0) {
      throw new Error(`${format} single-member triplet still drew hooks: ${JSON.stringify(singleTupletMark)}`);
    }
  }
  const ordinaryTupletMark = await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    return {
      numbers: document.querySelectorAll("#score-pane .tuplet-number").length,
      brackets: document.querySelectorAll("#score-pane .tuplet-bracket").length,
    };
  }, `.Title
KeyAndMeters = {1=C,2/4}
.Voice
{(3}1__ 2__ 3__) 0. |]
`);
  if (ordinaryTupletMark.numbers !== 1 || ordinaryTupletMark.brackets !== 1) {
    throw new Error(`ordinary three-member triplet lost its bracket: ${JSON.stringify(ordinaryTupletMark)}`);
  }

  // The actual Alt+ArrowRight event inside a keyboard-TXT eighth triplet is
  // one compressed third. The bracket and written eighth value survive the
  // immediate TXT serialization/reparse.
  await page.evaluate((text) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "number";
    app.slashOptions = {
      kind: "number", voiceCount: 1, instrumentName: "钢琴",
      title: "三连音移动", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: null,
      braceMode: "arpeggio", bracketMode: "triplet", barMode: "grace",
      angleMode: "subdivide", parenMode: "chord", ordering: "pitch-asc",
      showExplicitRests: true,
    };
    app.setText(text);
    app.setRhythmEditDivision(8);
    app.setInputDurationDivision(8);
    app.setInputMode(true);
    const note = app.painter.score.parts[0]?.measures[0]?.entries
      .find((entry) => !entry.rest && entry.notes?.some((item) => item.tuplet))?.notes[0];
    if (!note) return;
    const FractionCtor = app.painter.score.parts[0].measures[0].position.constructor;
    app._input.setCursor(app.painter.score, {
      partIndex: 0, measureIndex: 0, offset: new FractionCtor(0),
      division: 8, lane: "rest",
    });
    app._input.focusPitch = note.pitch;
    app.selectInputFocus(false);
    app.scorePane.focus({ preventScroll: true });
  }, `数字谱
4/4拍：
点=16分音符
[1..0..0..]/0..../0..../0..../
`);
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForTimeout(250);
  const movedTxtTuple = await page.evaluate(() => {
    const app = window.__app;
    const note = app.painter.score.parts[0]?.measures[0]?.entries
      .find((entry) => !entry.rest && entry.notes?.some((item) => item.tuplet))?.notes[0];
    return note ? {
      position: note.chord.position.toFloat(),
      duration: note.chord.duration?.toFloat() ?? null,
      beams: note.chord.beams,
      tuplet: Boolean(note.tuplet),
      text: app.getText(),
    } : null;
  });
  if (!movedTxtTuple
    || Math.abs(movedTxtTuple.position - 1 / 3) > 1e-8
    || Math.abs((movedTxtTuple.duration ?? -1) - 1 / 3) > 1e-8
    || movedTxtTuple.beams !== 1
    || !movedTxtTuple.tuplet
    || !movedTxtTuple.text.includes("[")) {
    throw new Error(`TXT Alt movement used ordinary timing inside a triplet: ${JSON.stringify(movedTxtTuple)}`);
  }

  // JPW fermata is a semantic notation object, not the note itself: clicking
  // the glyph must select the chord-backed object so Delete can remove only
  // the fermata and leave the note/timing intact.
  await page.evaluate((text) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    app.setRhythmEditDivision(16);
    app.setInputMode(true);
  }, `.Title\nTitle = {JPW 延长号对象}\nKeyAndMeters = {1=C,4/4}\n.Voice\n{YanYin}1 2 3 4 |]\n`);
  await page.waitForFunction(() => document.querySelectorAll("#score-pane .jianpu-fermata").length >= 1);
  await page.locator("#score-pane .jianpu-fermata").first().click();
  const fermataSelection = await page.evaluate(() => ({
    kind: window.__app._selectedObjects.at(-1)?.kind ?? null,
    fermata: window.__app.painter.score.parts[0]?.measures[0]?.entries
      .some((entry) => entry.fermata === true) ?? false,
  }));
  if (fermataSelection.kind !== "fermata" || !fermataSelection.fermata) {
    throw new Error(`JPW fermata was not selected as a semantic object: ${JSON.stringify(fermataSelection)}`);
  }
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => document.querySelectorAll("#score-pane .jianpu-fermata").length === 0);
  const fermataDeleted = await page.evaluate(() => ({
    fermata: window.__app.painter.score.parts[0]?.measures[0]?.entries
      .some((entry) => entry.fermata === true) ?? false,
    text: window.__app.getText(),
  }));
  if (fermataDeleted.fermata || fermataDeleted.text.includes("YanYin")) {
    throw new Error(`JPW fermata Delete did not remove the notation: ${JSON.stringify(fermataDeleted)}`);
  }

  // Two voice-owned tuplets may overlap with different inner grids. Keep
  // their independent timing objects, but engrave one longest shared bracket
  // instead of stacking two `3` marks over the same columns.
  const overlapTupletVisual = await page.evaluate((text) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 2, instrumentName: "钢琴",
      title: "重叠三连音", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: null,
      braceMode: "none", bracketMode: "triplet", ordering: "pitch-asc",
      showExplicitRests: true,
      annotations: [
        { type: "triplet", part: 0, voice: 1, measure: 0, offset: 0.25,
          scope: "voice", end: 0.5, members: [0.25, 0.125], restoreUnit: 0.25 },
        { type: "triplet", part: 1, voice: 2, measure: 0, offset: 0,
          scope: "voice", end: 0.5, members: [0.25, 0.25, 0.25], restoreUnit: 0.5 },
      ],
    };
    app.setText(text);
    const tuplets = new Set(app.painter.score.parts.flatMap((part) =>
      part.measures.flatMap((measure) => measure.entries.flatMap((entry) =>
        entry.notes?.flatMap((note) => note.tuplet ? [note.tuplet] : []) ?? []))));
    return {
      tuplets: tuplets.size,
      marks: document.querySelectorAll("#score-pane .tuplet-mark").length,
      diagnostics: document.querySelectorAll("#score-pane .diagnostic-box").length,
      details: [...tuplets].map((tuplet) => ({
        scope: tuplet.scope,
        part: tuplet.partIndex,
        voice: tuplet.voiceIndex,
        measure: tuplet.first.chord.measure.index,
        start: tuplet.actualStart?.toFloat(),
        end: tuplet.actualEnd?.toFloat(),
      })),
    };
  }, `键盘谱\n4/4拍：\n点=16分音符\n[(V\u2063G).\u2063W.\u20630]N.(G\u2063W)./..../..../..../\n\n// @jpeditor {"v":2,"vc":2,"k":"k","s":{".":16},"q":"t","an":[{"type":"triplet","part":0,"voice":1,"measure":0,"offset":0.25,"scope":"voice","end":0.5,"members":[0.25,0.125],"restoreUnit":0.25},{"type":"triplet","part":1,"voice":2,"measure":0,"offset":0,"scope":"voice","end":0.5,"members":[0.25,0.25,0.25],"restoreUnit":0.5}]}\n`);
  if (overlapTupletVisual.tuplets < 2 || overlapTupletVisual.marks !== 1) {
    throw new Error(`overlapping voice tuplets did not share one longest bracket: ${JSON.stringify(overlapTupletVisual)}`);
  }

  // A tuplet with only its middle member sounding must reserve a clear
  // annotation tier, and all three real cells must remain mouse-addressable.
  await page.evaluate((text) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 1, instrumentName: "钢琴",
      title: "中间音三连音", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, tempoBeatUnit: "quarter", fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, multiDurationSymbols: false,
      spaceDivision: null, noteDivision: null,
      braceMode: "none", bracketMode: "triplet", ordering: "pitch-asc",
      showExplicitRests: true,
    };
    app.setText(text);
    app.setRhythmEditDivision(16);
    app.setInputMode(true);
  }, `键盘谱\n4/4拍：\n点=16分音符\n[0(VQ)0]0.../0..../0..../0..../\n`);
  await page.waitForFunction(() => document.querySelectorAll("#score-pane .tuplet-number").length >= 1);
  const tupletGeometry = await page.evaluate(() => {
    const mark = document.querySelector("#score-pane .tuplet-number");
    const markBox = mark?.getBoundingClientRect();
    const memberBoxes = [...document.querySelectorAll("#score-pane .jianpu-number")]
      .map((element) => element.getBoundingClientRect())
      .filter((box) => markBox && box.left < markBox.right + 2 && box.right > markBox.left - 2
        && box.top > markBox.top);
    const overlap = markBox && memberBoxes.some((box) => markBox.bottom > box.top + 1.5);
    const svg = document.querySelector("#score-pane svg");
    const span = svg ? window.__app.painter.rhythmInputSpansForPage(0, svg)
      .find((candidate) => candidate.measureIndex === 0) : null;
    const group = span?.tupletGroups?.[0];
    const row = span?.partRows?.find((item) => item.partIndex === 0);
    const matrix = svg?.getScreenCTM();
    const points = group && row && matrix ? group.anchors.map((anchor) => {
      // Use the rhythm-guide side of the row.  The row's geometric centre can
      // legitimately cross the separately selectable tuplet numeral after the
      // annotation tier grows upward, which would test bracket selection
      // rather than member/cell hit testing.
      const point = new DOMPoint(anchor.x, row.yBottom - 2).matrixTransform(matrix);
      return { x: point.x, y: point.y, tick: anchor.tick };
    }) : [];
    const middleChord = window.__app.painter.score.parts[0]?.measures[0]?.entries.find((entry) =>
      !entry.rest && entry.notes?.filter((note) => !note.rest).length >= 2);
    const pitchRows = middleChord ? middleChord.notes.filter((note) => !note.rest).flatMap((note) => {
      const rendered = window.__app.painter.noteGroupEls(middleChord, note)
        .find((item) => item.page === 0);
      const rect = rendered?.element.getBoundingClientRect();
      return rect ? [{ pitch: note.pitch, top: rect.top }] : [];
    }) : [];
    return { overlap: Boolean(overlap), points, pitchRows };
  });
  if (tupletGeometry.overlap) {
    throw new Error("middle-only tuplet number/bracket overlaps a member number");
  }
  if (tupletGeometry.points.length < 3) {
    throw new Error(`middle-only tuplet did not expose three clickable cells: ${JSON.stringify(tupletGeometry)}`);
  }
  const pitchRows = [...tupletGeometry.pitchRows].sort((left, right) => left.pitch - right.pitch);
  if (pitchRows.length < 2 || pitchRows[0].top <= pitchRows.at(-1).top) {
    throw new Error(`triplet chord pitch rows are inverted: ${JSON.stringify(pitchRows)}`);
  }
  for (const point of tupletGeometry.points.slice(0, 3)) {
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(40);
    const state = await page.evaluate(() => {
      const app = window.__app;
      const svg = document.querySelector("#score-pane svg");
      const span = svg ? app.painter.rhythmInputSpansForPage(0, svg)
        .find((candidate) => candidate.measureIndex === 0) : null;
      return {
        offset: app._input.cursor?.offset.toFloat() ?? null,
      };
    });
    const offset = state.offset;
    if (offset === null || Math.abs(offset - point.tick) > 1e-8) {
      throw new Error(`tuplet member click did not select its exact cell: ${JSON.stringify({ point, ...state })}`);
    }
  }

  if (errors.length > 0) throw new Error(`browser errors:\n${errors.join("\n")}`);
  await page.screenshot({ path: "dist/input-mode-check.png", fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const keypadBox = await page.locator("#score-input-keypad").boundingBox();
  if (!keypadBox || keypadBox.x < -0.5 || keypadBox.x + keypadBox.width > 390.5) {
    throw new Error(`mobile input keypad overflowed the viewport: ${JSON.stringify(keypadBox)}`);
  }
  const toolbarButton = await page.locator("#btn-input-mode").boundingBox();
  if (!toolbarButton || toolbarButton.width < 40) {
    throw new Error(`mobile input-mode toolbar button is not usable: ${JSON.stringify(toolbarButton)}`);
  }
  await page.screenshot({ path: "dist/input-mode-mobile.png", fullPage: false });
  console.log("input-mode-check: ok");
} finally {
  await browser.close();
  server.close();
}
