// Browser interaction regression for score picking -> CodeMirror selections ->
// input-mode shortcut isolation -> playback start anchor.
// Usage: npm run build && node selection-shot.mjs [out.png]
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (path === "/") path = "/index.html";
    const data = await readFile(join(root, normalize(path)));
    res.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.message));

const fixture = `.Title
Title = {点选改音测试}
KeyAndMeters = {1=C,4/4}
Tempo = {96}
TempoMarks = {1@1=tempo:108}
.Voice
1 2 [3'5'] 4 | 5 6 7 1' |]
`;

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  const builtInMetadata = await page.evaluate(() => window.__app.getText());
  for (const expected of [
    "标题 = Avid - 86—不存在的战区—",
    "副标题 = 86—Eighty Six— ED",
    "作曲 = 泽野弘之(Hiroyuki Sawano)",
    "编曲 = 星宇StarryCosmos",
    "作词 = cAnON.",
  ]) {
    if (!builtInMetadata.includes(expected)) {
      throw new Error(`built-in Avid metadata is missing: ${expected}\n${builtInMetadata.slice(0, 500)}`);
    }
  }
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
  }, fixture);
  const scoreSettingsButton = page.locator("#btn-score-settings");
  const unavailableScoreSettings = await scoreSettingsButton.evaluate((button) => ({
    unavailable: button.classList.contains("format-unavailable"),
    ariaDisabled: button.getAttribute("aria-disabled"),
    title: button.getAttribute("title"),
  }));
  if (!unavailableScoreSettings.unavailable
    || unavailableScoreSettings.ariaDisabled !== "true"
    || unavailableScoreSettings.title !== "JPW 格式不支持乐谱设置") {
    throw new Error(
      `JPW score settings button did not expose its unavailable state: ${
        JSON.stringify(unavailableScoreSettings)
      }`,
    );
  }
  await scoreSettingsButton.click({ force: true });
  await page.waitForFunction(() =>
    document.querySelector("#toolbar-notice.visible")?.textContent
      === "JPW 格式不支持乐谱设置");

  const dropped = await page.evaluate((text) => {
    const file = new File([text], "drag-import.jpwabc", {
      type: "application/octet-stream",
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const target = document.querySelector("#code-pane");
    target.dispatchEvent(new DragEvent("dragenter", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
    const overlayVisible = document.body.classList.contains("file-drag-active");
    target.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
    return overlayVisible;
  }, fixture);
  if (!dropped) throw new Error("whole-editor file drag did not expose its direct-import target");
  await page.waitForFunction((text) => window.__app.getText() === text, fixture);
  await page.waitForFunction(() => document.querySelectorAll("#score-pane g.entry").length >= 8);

  const paneLayout = await page.evaluate(() => {
    const app = window.__app;
    const code = document.querySelector("#code-workspace");
    const score = document.querySelector("#score-pane");
    app.setCodePaneCollapsed(false);
    app.setCodePaneSide("right");
    const movedRight = code.getBoundingClientRect().left >= score.getBoundingClientRect().right;
    app.toggleCodePane();
    const collapsed = getComputedStyle(code).display === "none"
      && document.querySelector("#code-pane-toggle")?.getAttribute("aria-expanded") === "false";
    app.toggleCodePane();
    app.setCodePaneSide("left");
    return {
      movedRight,
      collapsed,
      restoredLeft: code.getBoundingClientRect().right <= score.getBoundingClientRect().left,
    };
  });
  if (!paneLayout.movedRight || !paneLayout.collapsed || !paneLayout.restoredLeft) {
    throw new Error(`collapsible/reversible editor pane layout failed: ${JSON.stringify(paneLayout)}`);
  }

  const previewLockBefore = await page.evaluate(() => {
    const app = window.__app;
    const before = document.querySelector("#score-pane")?.innerHTML ?? "";
    const title = app.getText().indexOf("点选改音测试");
    app.togglePreviewLock();
    app.view.dispatch({ changes: { from: title, to: title + 6, insert: "锁定预览测试" } });
    return before;
  });
  await page.waitForTimeout(350);
  const previewStayedLocked = await page.evaluate((before) => ({
    unchanged: (document.querySelector("#score-pane")?.innerHTML ?? "") === before,
    active: document.querySelector("#btn-preview-lock")?.classList.contains("active"),
  }), previewLockBefore);
  if (!previewStayedLocked.unchanged || !previewStayedLocked.active) {
    throw new Error(`preview lock did not suspend live relayout: ${JSON.stringify(previewStayedLocked)}`);
  }
  await page.locator("#btn-preview-lock").click();
  await page.waitForFunction((before) =>
    (document.querySelector("#score-pane")?.innerHTML ?? "") !== before
    && !document.querySelector("#btn-preview-lock")?.classList.contains("active"), previewLockBefore);

  const liveStyleBefore = await page.evaluate(() => ({
    metaX: window.__app.engravingStyle.publicationMetaX,
    scoreHtml: document.querySelector("#score-pane")?.innerHTML ?? "",
    source: window.__app.getText(),
  }));
  await page.locator("#btn-layout-style").click();
  const engravingUi = await page.evaluate(() => {
    const controls = document.querySelector(".engraving-controls");
    const pane = document.querySelector("#inspector-pane");
    if (!(controls instanceof HTMLElement) || !(pane instanceof HTMLElement)) return null;
    return {
      sectionCount: controls.querySelectorAll(":scope > details.engraving-section").length,
      openCount: controls.querySelectorAll(":scope > details.engraving-section[open]").length,
      floating: pane.classList.contains("inspector-floating")
        && getComputedStyle(pane).position === "fixed"
        && pane.getBoundingClientRect().width >= 540,
      scoreWidth: document.querySelector("#score-pane").getBoundingClientRect().width,
      panelId: pane.dataset.inspectorId,
    };
  });
  if (!engravingUi
    || engravingUi.sectionCount !== 7
    || engravingUi.openCount < 1
    || !engravingUi.floating
    || engravingUi.scoreWidth < 500
    || engravingUi.panelId !== "layout") {
    throw new Error(`engraving inspector accordion is incorrect: ${JSON.stringify(engravingUi)}`);
  }
  await page.locator('input[name="publicationMetaX"]').evaluate((input) => {
    input.value = "0.25";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(() =>
    Math.abs(window.__app.painter.layout.options.engravingStyle.publicationMetaX - 0.25) < 1e-8);
  const draftState = await page.evaluate((expectedMetaX) => ({
    metaX: window.__app.engravingStyle.publicationMetaX,
    scoreHtml: document.querySelector("#score-pane")?.innerHTML ?? "",
    source: window.__app.getText(),
    hasNewControls: [
      "publicationTitleX",
      "publicationTitleYOffset",
      "publicationMetaX",
      "publicationMetaYOffset",
      "publicationFirstSystemGap",
      "publicationCreditX",
    ].every((name) => document.querySelector(`input[name="${name}"]`)),
    expectedMetaX,
  }), liveStyleBefore.metaX);
  if (draftState.metaX !== liveStyleBefore.metaX
    || draftState.scoreHtml === liveStyleBefore.scoreHtml
    || draftState.source !== liveStyleBefore.source
    || !draftState.hasNewControls) {
    throw new Error(`engraving draft did not preview on the live score: ${JSON.stringify({
      liveMetaBefore: liveStyleBefore.metaX,
      draftMeta: draftState.metaX,
      scoreChanged: draftState.scoreHtml !== liveStyleBefore.scoreHtml,
      sourceChanged: draftState.source !== liveStyleBefore.source,
      hasNewControls: draftState.hasNewControls,
    })}`);
  }
  await page.getByRole("button", { name: "应用到全部简谱" }).click();
  await page.waitForFunction(() =>
    Math.abs(window.__app.engravingStyle.publicationMetaX - 0.25) < 1e-8);
  const appliedStyle = await page.evaluate((beforeHtml) => ({
    scoreChanged: (document.querySelector("#score-pane")?.innerHTML ?? "") !== beforeHtml,
    metaX: window.__app.engravingStyle.publicationMetaX,
    publicationMetaCount: document.querySelectorAll("#score-pane .publication-meta").length,
  }), liveStyleBefore.scoreHtml);
  if (!appliedStyle.scoreChanged
    || appliedStyle.metaX !== 0.25
    || appliedStyle.publicationMetaCount === 0) {
    throw new Error(`engraving draft was not applied on confirmation: ${JSON.stringify(appliedStyle)}`);
  }

  const noteText = (value) => page.locator("#score-pane g.entry text").filter({ hasText: new RegExp(`^${value}$`) }).first();
  await noteText("1").click();
  let state = await page.evaluate(() => ({
    selectedSvg: document.querySelectorAll("#score-pane g.selected").length,
    source: window.__app.view.state.selection.ranges.map((range) =>
      window.__app.view.state.doc.sliceString(range.from, range.to)),
    scoreFocused: document.activeElement?.id === "score-pane",
  }));
  if (state.selectedSvg !== 1 || state.source.join("|") !== "1" || !state.scoreFocused) {
    throw new Error(`single score selection did not sync to the editor: ${JSON.stringify(state)}`);
  }

  const ordinarySelectionText = await page.evaluate(() => window.__app.getText());
  await page.keyboard.press("5");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Control+ArrowRight");
  await page.waitForTimeout(100);
  if (await page.evaluate(() => window.__app.getText()) !== ordinarySelectionText) {
    throw new Error("ordinary score selection accepted input-only digit/timing shortcuts");
  }
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => /\.Voice\s+1' 2/.test(window.__app.getText()));

  await noteText("2").click({ modifiers: ["Control"] });
  state = await page.evaluate(() => ({
    selectedSvg: document.querySelectorAll("#score-pane g.selected").length,
    source: window.__app.view.state.selection.ranges.map((range) =>
      window.__app.view.state.doc.sliceString(range.from, range.to)).sort(),
    sourceHighlights: document.querySelectorAll(".cm-score-source-selection").length,
  }));
  if (state.selectedSvg !== 2 || state.source.join("|") !== "1'|2" || state.sourceHighlights < 2) {
    throw new Error(`multi-selection did not preserve both source ranges: ${JSON.stringify(state)}`);
  }

  await page.locator("#score-pane svg").first().click({
    position: { x: 4, y: 4 },
    modifiers: ["Control"],
  });
  state = await page.evaluate(() => ({
    selectedNotes: window.__app._selectedNotes.length,
    selectedSvg: document.querySelectorAll("#score-pane g.selected").length,
  }));
  if (state.selectedNotes !== 2 || state.selectedSvg !== 2) {
    throw new Error(`Ctrl-click miss cleared the existing multi-selection: ${JSON.stringify(state)}`);
  }

  await page.keyboard.press("7");
  await page.waitForTimeout(80);
  if (!/\.Voice\s+1' 2/.test(await page.evaluate(() => window.__app.getText()))) {
    throw new Error("ordinary multi-selection accepted a direct 1–7 pitch shortcut");
  }
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => /\.Voice\s+1'' 2'/.test(window.__app.getText()));
  await page.keyboard.press("Control+Z");
  await page.waitForFunction(() => /\.Voice\s+1' 2/.test(window.__app.getText()));
  await noteText("1").first().click();
  await noteText("2").first().click({ modifiers: ["Control"] });

  await page.keyboard.press("Delete");
  state = await page.evaluate(() => ({
    selected: window.__app._selectedNotes.length,
    deleted: document.querySelectorAll("#score-pane g.soft-deleted").length,
    modelDeleted: window.__app._sourceNotes.filter((source) => source.note.softDeleted).length,
  }));
  if (state.selected !== 0 || state.deleted < 2 || state.modelDeleted !== 2) {
    throw new Error(`score Delete did not create restorable translucent notes: ${JSON.stringify(state)}`);
  }
  await page.keyboard.press("Control+Z");
  await page.waitForFunction(() =>
    document.querySelectorAll("#score-pane g.soft-deleted").length === 0
    && window.__app._sourceNotes.every((source) => !source.note.softDeleted));
  // Undo also queues the editor's 200 ms parse. Let it finish before the
  // next deletion so the pending undo render cannot replace its hit target.
  await page.waitForTimeout(300);

  await noteText("1").first().click();
  await page.keyboard.press("Backspace");
  const deletedNote = page.locator("#score-pane g.soft-deleted").first();
  await deletedNote.dblclick();
  await page.waitForFunction(() => document.querySelectorAll("#score-pane g.soft-deleted").length === 0);

  const tempoMarker = page.locator("#score-pane g.tempo-annotation").first();
  await tempoMarker.click();
  await page.keyboard.press("Delete");
  if (await tempoMarker.evaluate((element) => !element.classList.contains("soft-deleted"))) {
    throw new Error("tempo marker did not become translucent after score deletion");
  }
  await tempoMarker.dblclick();
  if (await tempoMarker.evaluate((element) => element.classList.contains("soft-deleted"))) {
    throw new Error("double-click did not restore a softly deleted tempo marker");
  }

  const sourceToScore = await page.evaluate(() => {
    const app = window.__app;
    const source = app._sourceNotes.find((item) => !item.grace && item.note.number === "3");
    if (!source) return null;
    app.view.focus();
    app.view.dispatch({ selection: { anchor: source.from, head: source.to } });
    return {
      selectedNotes: app._selectedNotes.length,
      selectedText: app.view.state.doc.sliceString(
        app.view.state.selection.main.from,
        app.view.state.selection.main.to,
      ),
    };
  });
  if (!sourceToScore || sourceToScore.selectedNotes !== 1 || !sourceToScore.selectedText) {
    throw new Error(`source selection did not highlight its rendered note: ${JSON.stringify(sourceToScore)}`);
  }

  const dragBox = await page.evaluate(() => {
    const entries = [...document.querySelectorAll("#score-pane g.entry")].slice(0, 3);
    const rects = entries.map((entry) => entry.getBoundingClientRect());
    return {
      left: Math.min(...rects.map((rect) => rect.left)) - 2,
      top: Math.min(...rects.map((rect) => rect.top)) - 2,
      right: Math.max(...rects.map((rect) => rect.right)) + 2,
      bottom: Math.max(...rects.map((rect) => rect.bottom)) + 2,
    };
  });
  await page.mouse.move(dragBox.left, dragBox.top);
  await page.mouse.down();
  await page.mouse.move(dragBox.right, dragBox.bottom, { steps: 6 });
  await page.mouse.up();
  state = await page.evaluate(() => ({
    selectedNotes: window.__app._selectedNotes.length,
    nativeScoreSelection: (() => {
      const selection = window.getSelection();
      const pane = document.querySelector("#score-pane");
      return Boolean(selection?.anchorNode && pane?.contains(selection.anchorNode));
    })(),
  }));
  if (state.selectedNotes < 3 || state.nativeScoreSelection) {
    throw new Error(`drag selection failed or leaked a native blue selection: ${JSON.stringify(state)}`);
  }

  await page.waitForTimeout(300);
  if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: false });
  const selectedPlayback = await page.evaluate(async () => {
    let start;
    const app = window.__app;
    app._player = {
      stop() {}, stopAudition() {}, async audition() {},
      async play(_score, _options, value) { start = value; },
    };
    await app.playScore();
    const primary = app._selectedNotes.at(-1);
    return Boolean(start && primary && start.chord === primary.source.chord && start.pass === primary.verse);
  });
  if (!selectedPlayback) throw new Error("playback did not start at the current score selection");

  await page.locator("#score-pane svg").first().click({ position: { x: 4, y: 4 } });
  const clearedPlayback = await page.evaluate(async () => {
    let start = "not-called";
    const app = window.__app;
    app._player = {
      stop() {}, stopAudition() {}, async audition() {},
      async play(_score, _options, value) { start = value; },
    };
    await app.playScore();
    return {
      selected: app._selectedNotes.length,
      selectedSvg: document.querySelectorAll("#score-pane g.selected").length,
      startsAtOpening: start === undefined,
    };
  });
  if (clearedPlayback.selected !== 0 || clearedPlayback.selectedSvg !== 0 || !clearedPlayback.startsAtOpening) {
    throw new Error(`clearing the selection did not restore opening playback: ${JSON.stringify(clearedPlayback)}`);
  }

  const duplicateSelectionFixture = `.Title
KeyAndMeters = {1=C,4/4}
.Voice
3__ [35]_ 6- 7- |]
`;
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    app.setRhythmEditDivision(16);
    app.setInputDurationDivision(16);
    app.setInputMode(true);
  }, duplicateSelectionFixture);
  await noteText("3").first().click();
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForTimeout(180);
  const transientDuplicateSelection = await page.evaluate(() => ({
    text: window.__app.getText(),
    selected: window.__app._selectedNotes.length,
    duplicateChord: window.__app.painter.score.parts[0].measures[0].entries
      .some((entry) => entry.notes?.filter((note) => note.number === "3").length === 2),
  }));
  if (transientDuplicateSelection.selected !== 1
    || !transientDuplicateSelection.duplicateChord) {
    throw new Error(
      `same-pitch move was not kept while selected: ${JSON.stringify(transientDuplicateSelection)}`,
    );
  }
  await page.locator("#score-pane svg").first().click({ position: { x: 4, y: 4 } });
  await page.waitForFunction(() =>
    window.__app.getText().includes("[35]")
    && !window.__app.getText().includes("[335]"));
  const committedDuplicateSelection = await page.evaluate(() => ({
    selected: window.__app._selectedNotes.length,
    duplicateChord: window.__app.painter.score.parts[0].measures[0].entries
      .some((entry) => entry.notes?.filter((note) => note.number === "3").length > 1),
  }));
  if (committedDuplicateSelection.selected !== 0
    || committedDuplicateSelection.duplicateChord) {
    throw new Error(
      `same-pitch move was not merged after deselection: ${JSON.stringify(committedDuplicateSelection)}`,
    );
  }

  const duplicateNumberFixture = `数字谱
4/4拍：
点=16分音符
3.(35).../1..../2..../3..../
`;
  await page.evaluate((text) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = "number";
    app.slashOptions = {
      kind: "number", voiceCount: 1,
      title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, spaceDivision: null, noteDivision: null,
      braceMode: "grace", bracketMode: "triplet",
    };
    app.setText(text);
    app.setRhythmEditDivision(16);
    app.setInputDurationDivision(16);
    app.setInputMode(true);
  }, duplicateNumberFixture);
  await noteText("3").first().click();
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForFunction(() => window.__app.getText().includes("(335)"));
  const transientNumberDuplicate = await page.evaluate(() => ({
    selected: window.__app._selectedNotes.length,
    sources: window.__app._sourceNotes.filter((source) =>
      source.note.absoluteTick.toString() === "1/4"
      && source.note.number === "3").length,
  }));
  if (transientNumberDuplicate.selected !== 1 || transientNumberDuplicate.sources !== 2) {
    throw new Error(
      `TXT same-pitch move was not kept while selected: ${JSON.stringify(transientNumberDuplicate)}`,
    );
  }
  await page.locator("#score-pane svg").first().click({ position: { x: 4, y: 4 } });
  await page.waitForFunction(() =>
    window.__app.getText().includes("(35)")
    && !window.__app.getText().includes("(335)"));

  const jpwGrace = `.Title
KeyAndMeters = {1=C,4/4}
.Voice
{2'}3 4 5 6 |]
`;
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    app.setInputMode(false);
  }, jpwGrace);
  await page.waitForFunction(() =>
    document.querySelectorAll("#score-pane .jianpu-grace-note").length === 1
    && window.__app._sourceNotes.some((source) => source.grace));
  await page.locator("#score-pane .jianpu-grace-number").click();
  state = await page.evaluate(() => ({
    source: window.__app.view.state.selection.ranges.map((range) =>
      window.__app.view.state.doc.sliceString(range.from, range.to)),
    selectedGrace: document.querySelectorAll("#score-pane .jianpu-grace-note.selected").length,
  }));
  if (state.source.join("|") !== "2'" || state.selectedGrace !== 1) {
    throw new Error(`clicking a JPW grace note did not select its exact source: ${JSON.stringify(state)}`);
  }
  await page.evaluate(() => window.__app.setInputMode(true));
  await page.locator("#score-pane .jianpu-grace-number").click();
  await page.keyboard.press("6");
  await page.waitForFunction(() => /\{6'\}3/.test(window.__app.getText()));
  await page.locator("#score-pane .jianpu-grace-number").click();
  await page.keyboard.press("Control+ArrowDown");
  await page.waitForFunction(() => /\{6\}3/.test(window.__app.getText()));
  const jpwGraceSourceSelection = await page.evaluate(() => {
    const app = window.__app;
    const source = app._sourceNotes.find((item) => item.grace);
    if (!source) return null;
    app.view.focus();
    app.view.dispatch({ selection: { anchor: source.from, head: source.to } });
    return {
      text: app.view.state.doc.sliceString(source.from, source.to),
      selected: app._selectedNotes.length,
      graceVisual: document.querySelectorAll("#score-pane .jianpu-grace-note.selected").length,
    };
  });
  if (!jpwGraceSourceSelection || jpwGraceSourceSelection.text !== "6"
    || jpwGraceSourceSelection.selected !== 1 || jpwGraceSourceSelection.graceVisual !== 1) {
    throw new Error(`JPW grace source selection did not highlight the grace visual: ${JSON.stringify(jpwGraceSourceSelection)}`);
  }
  const graceBeamPoint = await page.locator("#score-pane .jianpu-grace-beam line").first().evaluate((line) => {
    const x = (Number(line.getAttribute("x1")) + Number(line.getAttribute("x2"))) / 2;
    const y = (Number(line.getAttribute("y1")) + Number(line.getAttribute("y2"))) / 2;
    const matrix = line.getScreenCTM();
    if (!matrix) throw new Error("grace beam has no screen transform");
    const point = new DOMPoint(x, y).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(graceBeamPoint.x, graceBeamPoint.y);
  state = await page.evaluate(() => ({
    source: window.__app.view.state.selection.ranges.map((range) =>
      window.__app.view.state.doc.sliceString(range.from, range.to)),
    selectedGrace: document.querySelectorAll("#score-pane .jianpu-grace-note.selected").length,
  }));
  if (state.source.join("|") !== "6" || state.selectedGrace !== 1) {
    throw new Error(`clicking a grace beam did not select its grace pitch: ${JSON.stringify(state)}`);
  }
  if (process.argv[3]) {
    await page.evaluate(() => {
      window.__app.deselect();
      window.__app.setZoom(4);
    });
    await page.locator("#score-pane g.entry").first().screenshot({ path: process.argv[3] });
    await page.evaluate(() => window.__app.setZoom(1));
  }

  const numberSlash = `数字谱
4/4拍：
点=八分音符
{2}1./2./3./4./
`;
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "number";
    app.slashOptions = {
      kind: "number", title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 8 }, spaceDivision: null, noteDivision: null, braceMode: "grace",
    };
    app.setText(text);
    app.setInputMode(false);
  }, numberSlash);
  await page.waitForFunction(() => window.__app.documentFormat === "number" &&
    document.querySelectorAll("#score-pane g.entry").length >= 4);
  await page.locator("#score-pane .jianpu-grace-number").click();
  state = await page.evaluate(() => ({
    source: window.__app.view.state.selection.ranges.map((range) =>
      window.__app.view.state.doc.sliceString(range.from, range.to)),
    mapped: window.__app._sourceNotes.length,
  }));
  if (state.source.join("|") !== "2" || state.mapped !== 5) {
    throw new Error(`number slash grace selection did not map to its TXT pitch: ${JSON.stringify(state)}`);
  }
  await page.evaluate(() => window.__app.setInputMode(true));
  await noteText("1").click();
  state = await page.evaluate(() => ({
    source: window.__app.view.state.selection.ranges.map((range) =>
      window.__app.view.state.doc.sliceString(range.from, range.to)),
    mapped: window.__app._sourceNotes.length,
  }));
  if (state.source.join("|") !== "1" || state.mapped !== 5) {
    throw new Error(`number slash-score selection did not map to its TXT pitch: ${JSON.stringify(state)}`);
  }
  const numberRhythmBeforePitch = await page.evaluate(() => window.__app.painter.score.parts[0].measures[0].entries
    .filter((entry) => entry.notes?.length)
    .map((entry) => [entry.position.toFloat(), entry.duration.toFloat(), entry.rest]));
  await page.keyboard.press("5");
  await page.waitForTimeout(160);
  const numberPitchEdit = await page.evaluate(() => {
    const entries = window.__app.painter.score.parts[0].measures[0].entries.filter((entry) => entry.notes?.length);
    return { number: entries[0].notes[0].number, grace: entries[0].graceNotes.map((note) => note.number),
      rhythm: entries.map((entry) => [entry.position.toFloat(), entry.duration.toFloat(), entry.rest]) };
  });
  // One dot is an eighth followed by an eighth rest in this fixture. A
  // pitch-only edit must preserve that rhythm rather than require `5..`,
  // which would lengthen the attack to a quarter and erase its silence.
  if (numberPitchEdit.number !== "5" || numberPitchEdit.grace.join("") !== "2"
    || JSON.stringify(numberPitchEdit.rhythm) !== JSON.stringify(numberRhythmBeforePitch)) {
    throw new Error(`number TXT input-mode digit changed pitch/rhythm incorrectly: ${JSON.stringify(numberPitchEdit)}`);
  }
  await page.keyboard.press("Control+ArrowUp");
  await page.waitForFunction(() => window.__app.painter.score.parts[0].measures[0].entries
    .find((entry) => entry.notes?.length)?.notes[0].jpOctave === 1);
  await page.evaluate(() => window.__app.setInputMode(false));
  await noteText("5").click();
  const slashPlayback = await page.evaluate(async () => {
    let start;
    const app = window.__app;
    app._player = {
      stop() {}, stopAudition() {}, async audition() {},
      async play(_score, _options, value) { start = value; },
    };
    await app.playScore();
    const primary = app._selectedNotes.at(-1);
    return Boolean(start && primary && start.chord === primary.source.chord && start.pass === primary.verse);
  });
  if (!slashPlayback) throw new Error("number slash-score playback did not start at the selected pitch");

  const keyboardSlash = `键盘谱
4/4拍：
点=八分音符
{Q}A./S./D./F./
`;
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 8 }, spaceDivision: null, noteDivision: null, braceMode: "grace",
    };
    app.setText(text);
    app.setInputMode(false);
  }, keyboardSlash);
  await page.waitForFunction(() => window.__app.documentFormat === "keyboard" &&
    document.querySelectorAll("#score-pane g.entry").length >= 4);
  await page.locator("#score-pane .jianpu-grace-number").click();
  state = await page.evaluate(() => ({
    source: window.__app.view.state.selection.ranges.map((range) =>
      window.__app.view.state.doc.sliceString(range.from, range.to)),
  }));
  if (state.source.join("|") !== "Q") {
    throw new Error(`keyboard slash grace selection did not map to its TXT key: ${JSON.stringify(state)}`);
  }
  await page.evaluate(() => window.__app.setInputMode(true));
  await noteText("1").click();
  state = await page.evaluate(() => ({
    source: window.__app.view.state.selection.ranges.map((range) =>
      window.__app.view.state.doc.sliceString(range.from, range.to)),
  }));
  if (state.source.join("|") !== "A") {
    throw new Error(`keyboard slash-score selection did not map to its TXT key: ${JSON.stringify(state)}`);
  }
  const keyboardRhythmBeforePitch = await page.evaluate(() => window.__app.painter.score.parts[0].measures[0].entries
    .filter((entry) => entry.notes?.length)
    .map((entry) => [entry.position.toFloat(), entry.duration.toFloat(), entry.rest]));
  await page.keyboard.press("3");
  await page.waitForFunction(() => window.__app.painter.score.parts[0].measures[0].entries
    .find((entry) => entry.notes?.length)?.notes[0].number === "3");
  const keyboardRhythmAfterPitch = await page.evaluate(() => window.__app.painter.score.parts[0].measures[0].entries
    .filter((entry) => entry.notes?.length)
    .map((entry) => [entry.position.toFloat(), entry.duration.toFloat(), entry.rest]));
  if (JSON.stringify(keyboardRhythmAfterPitch) !== JSON.stringify(keyboardRhythmBeforePitch)) {
    throw new Error("keyboard TXT pitch entry changed the attack/rest durations");
  }
  await page.keyboard.press("Control+ArrowUp");
  await page.waitForFunction(() => window.__app.painter.score.parts[0].measures[0].entries
    .find((entry) => entry.notes?.length)?.notes[0].jpOctave === 1);

  const keyboardKeyLabelState = await page.evaluate(() => {
    const app = window.__app;
    const text = "键盘谱\n4/4拍：\nQ../'Q../A../,V../\n";
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", keyboardKeyLabels: true, voiceCount: 1,
      title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 8 }, spaceDivision: null, noteDivision: null,
      braceMode: "grace", bracketMode: "triplet",
    };
    app.setText(text);
    const notes = app.painter.score.parts[0].measures[0].entries
      .filter((entry) => !entry.rest)
      .map((entry) => entry.notes.find((note) => !note.rest));
    return {
      labels: notes.map((note) => note?.displayText ?? "").join(""),
      octaves: notes.map((note) => note?.displayOctave ?? null),
      underlying: notes.map((note) => note?.number ?? "").join(""),
      visible: [...document.querySelectorAll("#score-pane g.entry text")]
        .map((item) => item.textContent ?? ""),
    };
  });
  if (keyboardKeyLabelState.labels !== "QQAV"
    || keyboardKeyLabelState.octaves.join(",") !== "0,1,0,-1"
    || !/^[1-7]+$/.test(keyboardKeyLabelState.underlying)
    || !keyboardKeyLabelState.visible.includes("Q")
    || !keyboardKeyLabelState.visible.includes("A")
    || !keyboardKeyLabelState.visible.includes("V")) {
    throw new Error(`keyboard-key staff display failed: ${JSON.stringify(keyboardKeyLabelState)}`);
  }

  const keyboardChordCenters = await page.evaluate(() => {
    const app = window.__app;
    const text = "\u952e\u76d8\u8c31\n4/4\u62cd\uff1a\n(WJ)../A../S../D../\n";
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", keyboardKeyLabels: true, voiceCount: 1,
      title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 8 }, spaceDivision: null, noteDivision: null,
      braceMode: "grace", bracketMode: "triplet",
    };
    app.setText(text);
    const glyphs = [...document.querySelectorAll("#score-pane g.entry text")];
    const centerOf = (label) => {
      const glyph = glyphs.find((item) => item.textContent === label);
      if (!glyph) return null;
      const rect = glyph.getBoundingClientRect();
      return rect.left + rect.width / 2;
    };
    return { w: centerOf("W"), j: centerOf("J") };
  });
  if (keyboardChordCenters.w === null
    || keyboardChordCenters.j === null
    || Math.abs(keyboardChordCenters.w - keyboardChordCenters.j) > 0.75) {
    throw new Error(`keyboard chord rows are not centered: ${JSON.stringify(keyboardChordCenters)}`);
  }

  const keyboardQBaseline = await page.evaluate(() => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", keyboardKeyLabels: true, voiceCount: 1,
      title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 8 }, spaceDivision: null, noteDivision: null,
      braceMode: "grace", bracketMode: "triplet",
    };
    app.setText("\u952e\u76d8\u8c31\n4/4\u62cd\uff1a\nH../Q../W../T../\n");
    const glyphs = [...document.querySelectorAll("#score-pane g.entry text")];
    const baselineOf = (label) =>
      glyphs.find((item) => item.textContent === label)?.getCTM()?.f ?? null;
    return { h: baselineOf("H"), q: baselineOf("Q"), w: baselineOf("W") };
  });
  if (keyboardQBaseline.h === null
    || keyboardQBaseline.q === null
    || keyboardQBaseline.w === null
    || Math.abs(keyboardQBaseline.h - keyboardQBaseline.w) > 0.5
    || keyboardQBaseline.q <= (keyboardQBaseline.h + keyboardQBaseline.w) / 2 + 0.35) {
    throw new Error(`keyboard Q baseline was not lowered visually: ${JSON.stringify(keyboardQBaseline)}`);
  }

  const hiddenTieLayout = await page.evaluate(() => {
    const app = window.__app;
    const text = "\u952e\u76d8\u8c31\n4/4\u62cd\uff1a\n\u70b9=\u516b\u5206\u97f3\u7b26\n"
      + "-/-/-/(\u2063Q Z)../\n../../\u2063W../X../\n";
    const render = (hideTieLabels) => {
      app.documentFormat = "keyboard";
      app.slashOptions = {
        kind: "keyboard", keyboardKeyLabels: true, keyboardHideTieLabels: hideTieLabels,
        keyboardTieAsZero: false, voiceCount: 2, instrumentName: "\u94a2\u7434",
        title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
        tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
        symbolDurations: { ".": 8 }, spaceDivision: null, noteDivision: null,
        braceMode: "none", bracketMode: "none",
      };
      app.setText(text);
      const part = app.painter.score.parts[0];
      const continuation = part?.measures[1]?.entries.find((entry) =>
        entry.transparentContinuation && Math.abs(entry.position.toFloat()) < 1e-8);
      const following = part?.measures[1]?.entries.find((entry) =>
        Array.isArray(entry.notes)
        && !entry.transparentContinuation
        && entry.position.toFloat() > 1e-8);
      const note = continuation?.notes.find((item) => !item.rest);
      const textNode = continuation && note
        ? app.painter.noteGroupEl(continuation, note)?.querySelector("text")
        : null;
      const followingNode = following
        ? app.painter.chordGroupEl(following)?.querySelector("text")
        : null;
      const box = textNode?.getBoundingClientRect();
      const followingBox = followingNode?.getBoundingClientRect();
      return {
        label: textNode?.textContent ?? "",
        visibility: textNode?.getAttribute("visibility") ?? "",
        width: box?.width ?? 0,
        followingX: followingBox?.left ?? null,
      };
    };
    return { shown: render(false), hidden: render(true) };
  });
  if (!hiddenTieLayout.shown.label
    || hiddenTieLayout.hidden.label !== hiddenTieLayout.shown.label
    || hiddenTieLayout.shown.visibility === "hidden"
    || hiddenTieLayout.hidden.visibility !== "hidden"
    || hiddenTieLayout.shown.width <= 0
    || Math.abs(hiddenTieLayout.hidden.width - hiddenTieLayout.shown.width) > 0.5
    || hiddenTieLayout.shown.followingX === null
    || hiddenTieLayout.hidden.followingX === null
    || Math.abs(hiddenTieLayout.hidden.followingX - hiddenTieLayout.shown.followingX) > 0.75) {
    throw new Error(`hidden tied keyboard label changed layout: ${JSON.stringify(hiddenTieLayout)}`);
  }

  const markerText = `键盘谱
4/4拍：
\u2063Q../A../S../D../
`;
  const markerPositions = await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 2,
      title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 8 }, spaceDivision: null, noteDivision: null,
      braceMode: "grace", bracketMode: "triplet",
    };
    app.setText(text);
    const source = app._sourceNotes.find((item) => item.markerCount === 1);
    app.view.dispatch({ selection: { anchor: source.markerFrom } });
    app.view.focus();
    return { markerFrom: source.markerFrom, from: source.from, to: source.to };
  }, markerText);
  await page.keyboard.press("ArrowRight");
  const skippedMarker = await page.evaluate(() => window.__app.view.state.selection.main.head);
  if (skippedMarker !== markerPositions.to) {
    throw new Error(`ArrowRight did not cross U+2063 with its visible pitch: ${skippedMarker} !== ${markerPositions.to}`);
  }
  await page.keyboard.press("ArrowLeft");
  const skippedBack = await page.evaluate(() => window.__app.view.state.selection.main.head);
  if (skippedBack !== markerPositions.markerFrom) {
    throw new Error(`ArrowLeft stopped inside U+2063 run: ${skippedBack} !== ${markerPositions.markerFrom}`);
  }
  await page.evaluate((to) => {
    const app = window.__app;
    app.view.dispatch({ selection: { anchor: to } });
    app.view.focus();
  }, markerPositions.to);
  await page.keyboard.press("Backspace");
  await page.waitForFunction(() => !window.__app.getText().includes("\u2063Q"));
  const markerDeletedWithPitch = await page.evaluate(() => ({
    hasMarker: window.__app.getText().includes("\u2063"),
    scoreLine: window.__app.getText().split("\n").find((line) => line.includes("../")),
  }));
  if (markerDeletedWithPitch.hasMarker || markerDeletedWithPitch.scoreLine?.includes("Q")) {
    throw new Error(`deleting a marked pitch left its invisible marker: ${JSON.stringify(markerDeletedWithPitch)}`);
  }

  const multiMarkerText = `键盘谱
4/4拍：
\u2063\u2063Q../A../S../D../
`;
  const multiMarkerPositions = await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 3,
      title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 8 }, spaceDivision: null, noteDivision: null,
      braceMode: "grace", bracketMode: "triplet",
    };
    app.setText(text);
    const source = app._sourceNotes.find((item) => item.markerCount === 2);
    app.view.dispatch({ selection: { anchor: source.markerFrom + 1 } });
    app.view.focus();
    return { markerFrom: source.markerFrom, from: source.from, to: source.to };
  }, multiMarkerText);
  await page.keyboard.press("ArrowRight");
  if (await page.evaluate(() => window.__app.view.state.selection.main.head)
    !== multiMarkerPositions.to) {
    throw new Error("ArrowRight did not cross a multi-marker U+2063 run with its pitch");
  }
  await page.keyboard.press("ArrowLeft");
  if (await page.evaluate(() => window.__app.view.state.selection.main.head)
    !== multiMarkerPositions.markerFrom) {
    throw new Error("ArrowLeft did not skip an entire multi-marker U+2063 run");
  }
  await page.evaluate(({ markerFrom, from }) => {
    const app = window.__app;
    app.view.dispatch({ selection: { anchor: markerFrom, head: from } });
    app.view.focus();
  }, multiMarkerPositions);
  await page.keyboard.press("Delete");
  if (await page.evaluate(() => window.__app.getText()) !== multiMarkerText) {
    throw new Error("a U+2063 voice marker was deleted without its pitch");
  }
  await page.evaluate(({ from, to }) => {
    const app = window.__app;
    app.view.dispatch({ selection: { anchor: from, head: to } });
    app.view.focus();
  }, multiMarkerPositions);
  await page.keyboard.press("Delete");
  const multiMarkerDelete = await page.evaluate(() => window.__app.getText());
  if (multiMarkerDelete.includes("\u2063") || multiMarkerDelete.includes("Q../")) {
    throw new Error(`deleting a pitch did not remove its complete U+2063 prefix: ${multiMarkerDelete}`);
  }

  const adjacentMarkerText = `键盘谱
4/4拍：
.\u2063N.\u2063A.\u2063N./
`;
  const adjacentMarkerPositions = await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 2,
      title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, spaceDivision: null, noteDivision: null,
      braceMode: "grace", bracketMode: "triplet",
    };
    app.setText(text);
    const sources = app._sourceNotes.filter((item) => item.markerCount === 1);
    app.view.dispatch({ selection: { anchor: sources[0].markerFrom } });
    app.view.focus();
    return sources.map((source) => ({
      markerFrom: source.markerFrom,
      from: source.from,
      to: source.to,
    }));
  }, adjacentMarkerText);
  await page.keyboard.press("ArrowRight");
  const adjacentMarkerForward = await page.evaluate(() => ({
    head: window.__app.view.state.selection.main.head,
    selectedModel: window.__app._selectedNotes.length,
    selectedSvg: document.querySelectorAll("#score-pane g.selected").length,
  }));
  if (adjacentMarkerForward.head !== adjacentMarkerPositions[0].to
    || adjacentMarkerForward.selectedModel !== 0
    || adjacentMarkerForward.selectedSvg !== 0) {
    throw new Error(
      `crossing .U+2063N selected or stopped before the note: ${
        JSON.stringify(adjacentMarkerForward)
      }`,
    );
  }
  await page.keyboard.press("ArrowLeft");
  const adjacentMarkerBackward = await page.evaluate(() => ({
    head: window.__app.view.state.selection.main.head,
    selectedModel: window.__app._selectedNotes.length,
    selectedSvg: document.querySelectorAll("#score-pane g.selected").length,
  }));
  if (adjacentMarkerBackward.head !== adjacentMarkerPositions[0].markerFrom
    || adjacentMarkerBackward.selectedModel !== 0
    || adjacentMarkerBackward.selectedSvg !== 0) {
    throw new Error(
      `crossing N backwards over U+2063 selected or stopped inside it: ${
        JSON.stringify(adjacentMarkerBackward)
      }`,
    );
  }

  const jpwFormatFixture = `.Title
Title = {格式转换测试}
KeyAndMeters = {1=A,4/4}
.Voice
1 2 3 4 |5 6 7 1' |]
`;
  const jpwFormatConversion = await page.evaluate(async (text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    app.setRhythmEditDivision(64);
    app.setInputDurationDivision(64);
    await app.changeDocumentFormat("number");
    const numberText = app.getText();
    const numberSources = app._sourceNotes.map((source) =>
      app.view.state.doc.sliceString(source.from, source.to));
    const numberGrid = app.engravingStyle.rhythmGuideDivision;
    const numberDuration = app._inputDurationDivision;
    const activeGrid = document.querySelector(
      "#rhythm-grid-control button.active",
    )?.dataset.rhythmDivision ?? null;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    await app.changeDocumentFormat("keyboard");
    return {
      numberText,
      numberSources,
      numberGrid,
      numberDuration,
      activeGrid,
      keyboardText: app.getText(),
      keyboardSources: app._sourceNotes.map((source) =>
        app.view.state.doc.sliceString(source.from, source.to)),
    };
  }, jpwFormatFixture);
  if (!jpwFormatConversion.numberText.includes("\n1..../2..../3..../4..../")
    || jpwFormatConversion.numberText.includes("\n-1..../")
    || jpwFormatConversion.numberSources.join("|") !== "1|2|3|4|5|6|7|+1"
    // TXT without an explicit finer duration cannot retain JPW's 64th-note
    // grid or writing value; both clamp to the mapped sixteenth boundary.
    || jpwFormatConversion.numberGrid !== 16
    || jpwFormatConversion.numberDuration !== 16
    || jpwFormatConversion.activeGrid !== "16"
    || !jpwFormatConversion.keyboardText.includes("\nA..../S..../D..../F..../")
    || jpwFormatConversion.keyboardSources.join("|") !== "A|S|D|F|G|H|J|Q") {
    throw new Error(`JPW keyboard/number conversion is inaccurate: ${JSON.stringify(jpwFormatConversion)}`);
  }

  const voicedRestConversion = await page.evaluate(async (text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    await app.changeDocumentFormat("keyboard");
    const score = app.painter.score;
    const rightMeasure = score.parts[0]?.measures[0];
    const leftMeasure = score.parts[1]?.measures[0];
    return {
      format: app.documentFormat,
      text: app.getText(),
      rightHasFourthBeatRest: rightMeasure?.entries.some((entry) =>
        entry.rest && entry.position.equals(3)) ?? false,
      leftSoundingDuration: leftMeasure?.entries
        .filter((entry) => !entry.rest)
        .reduce((sum, entry) => sum + entry.duration.toFloat(), 0) ?? 0,
    };
  }, `.Title
Instrument = {钢琴}
KeyAndMeters = {1=C,4/4}
.Voice.RH
1 2 3 0 |]
.Voice.LH
6,--- |]
`);
  if (voicedRestConversion.format !== "keyboard"
    || !voicedRestConversion.text.includes("\u20630")
    || !voicedRestConversion.rightHasFourthBeatRest
    || voicedRestConversion.leftSoundingDuration !== 4) {
    throw new Error(
      `JPW voice-specific rest conversion failed: ${JSON.stringify(voicedRestConversion)}`,
    );
  }

  const dottedLongValue = await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    return [...document.querySelectorAll("#score-pane text")]
      .map((element) => element.textContent ?? "")
      .filter((value) => value.includes("\u00b7"));
  }, `.Title
KeyAndMeters = {1=C,4/4}
.Voice
(1- 1) 2 |]
`);
  if (!dottedLongValue.some((value) => value.includes("1\u00b7"))) {
    throw new Error(
      `dotted half note did not render its augmentation dot: ${JSON.stringify(dottedLongValue)}`,
    );
  }

  const mixedRecognitionText = `键盘谱
4/4拍：
点=八分音符
Q../W../E../R../
A../S../D../F../
数字谱
1../2../3../4../
5../6../7../1../
`;
  const mixedRecognitionSwitch = await page.evaluate(async (text) => {
    const app = window.__app;
    const body = (value) => value.replace(
      /^\s*\/\/\s*@jpeditor\s+\{[^\n]*\}\s*\r?\n?/gm,
      "",
    );
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 1, title: "", subtitle: "", composer: "",
      arranger: "", lyricist: "", tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 8 }, spaceDivision: null, noteDivision: null,
      braceMode: "none", bracketMode: "none",
    };
    app.setText(text);
    const originalBody = body(app.getText());
    await app.changeDocumentFormat("number");
    const numberBody = body(app.getText());
    const numberSources = app._sourceNotes.map((source) =>
      app.view.state.doc.sliceString(source.from, source.to));
    const numberMeasures = app.painter.score.parts[0]?.measures.length ?? 0;
    await app.changeDocumentFormat("keyboard");
    const keyboardBody = body(app.getText());
    const keyboardSources = app._sourceNotes.map((source) =>
      app.view.state.doc.sliceString(source.from, source.to));
    const keyboardMeasures = app.painter.score.parts[0]?.measures.length ?? 0;
    return {
      originalBody,
      numberBody,
      keyboardBody,
      numberSources,
      keyboardSources,
      numberMeasures,
      keyboardMeasures,
      format: app.documentFormat,
    };
  }, mixedRecognitionText);
  if (mixedRecognitionSwitch.originalBody !== mixedRecognitionSwitch.numberBody
    || mixedRecognitionSwitch.originalBody !== mixedRecognitionSwitch.keyboardBody
    || mixedRecognitionSwitch.numberMeasures !== 2
    || mixedRecognitionSwitch.keyboardMeasures !== 2
    || mixedRecognitionSwitch.numberSources.join("|") !== "1|2|3|4|5|6|7|1"
    || mixedRecognitionSwitch.keyboardSources.join("|") !== "Q|W|E|R|A|S|D|F"
    || mixedRecognitionSwitch.format !== "keyboard") {
    throw new Error(
      `keyboard/number recognition switch rewrote or cross-parsed mixed TXT: ${JSON.stringify(mixedRecognitionSwitch)}`,
    );
  }

  const availableScoreSettings = await scoreSettingsButton.evaluate((button) => ({
    unavailable: button.classList.contains("format-unavailable"),
    ariaDisabled: button.getAttribute("aria-disabled"),
  }));
  if (availableScoreSettings.unavailable || availableScoreSettings.ariaDisabled !== "false") {
    throw new Error(
      `keyboard score settings button remained unavailable: ${JSON.stringify(availableScoreSettings)}`,
    );
  }
  await scoreSettingsButton.click();
  const scoreSettingsBox = page.locator('#inspector-pane[data-inspector-id="score"]');
  await scoreSettingsBox.waitFor();
  const settingsTitle = await scoreSettingsBox.locator(".inspector-title").textContent();
  if (settingsTitle !== "乐谱") {
    throw new Error(`top score settings did not open the current-score editor: ${settingsTitle}`);
  }
  const keyboardLabelsToggle = scoreSettingsBox.locator("label.modal-row")
    .filter({ hasText: "谱面显示键盘按键" }).locator('input[type="checkbox"]');
  const tieAsZeroRow = scoreSettingsBox.locator("label.modal-row")
    .filter({ hasText: "延音用 0 替代" });
  const hideTieLabelsRow = scoreSettingsBox.locator("label.modal-row")
    .filter({ hasText: "隐藏延音字母" });
  await keyboardLabelsToggle.check();
  if (!await tieAsZeroRow.isVisible() || !await hideTieLabelsRow.isVisible()) {
    throw new Error("keyboard continuation display options did not appear with key labels enabled");
  }
  await keyboardLabelsToggle.uncheck();
  if (await tieAsZeroRow.isVisible() || await hideTieLabelsRow.isVisible()) {
    throw new Error("keyboard continuation display options remained visible with key labels disabled");
  }
  const tempoInput = scoreSettingsBox.locator("label.modal-row")
    .filter({ hasText: "速度（BPM）" }).locator("input");
  await tempoInput.fill("123");
  await scoreSettingsBox.locator(".inspector-close").click();
  if (!await scoreSettingsBox.locator(".inspector-dirty-prompt").isVisible()) {
    throw new Error("dirty score settings did not offer inline apply/discard/continue");
  }
  await scoreSettingsBox.getByRole("button", { name: "继续编辑" }).click();
  if (!await scoreSettingsBox.isVisible()) {
    throw new Error("continue editing closed score settings");
  }
  await scoreSettingsBox.getByRole("button", { name: "应用到当前乐谱" }).click();
  await page.waitForFunction(() =>
    !document.querySelector('#inspector-pane[data-inspector-id="score"]')
    && window.__app.slashOptions?.tempoBpm === 123
    && window.__app.painter.score.tempoBpm === 123);
  const appliedScoreSettings = await page.evaluate(() => ({
    format: window.__app.documentFormat,
    tempo: window.__app.slashOptions?.tempoBpm,
    scoreTempo: window.__app.painter.score.tempoBpm,
    metadata: /\/\/\s*@jpeditor\s+\{[^\n]*"bpm":123/.test(window.__app.getText()),
    keyboardBody: /Q\.\.\/W\.\.\/E\.\.\/R\.\.\//.test(window.__app.getText()),
    numberBody: /1\.\.\/2\.\.\/3\.\.\/4\.\.\//.test(window.__app.getText()),
  }));
  if (appliedScoreSettings.format !== "keyboard"
    || appliedScoreSettings.tempo !== 123
    || appliedScoreSettings.scoreTempo !== 123
    || !appliedScoreSettings.metadata
    || !appliedScoreSettings.keyboardBody
    || !appliedScoreSettings.numberBody) {
    throw new Error(`score settings did not apply non-destructively: ${JSON.stringify(appliedScoreSettings)}`);
  }

  const metadataExports = await page.evaluate(() => {
    const decoder = new TextDecoder();
    const withMetadata = decoder.decode(window.__app.exportTextDocument("keyboard", true, true).bytes);
    const withoutMetadata = decoder.decode(window.__app.exportTextDocument("keyboard", true, false).bytes);
    return {
      withMetadata: /\/\/\s*@jpeditor\s+\{/.test(withMetadata),
      withoutMetadata: /\/\/\s*@jpeditor\s+\{/.test(withoutMetadata),
      keptKeyboard: /Q\.\.\/W\.\.\/E\.\.\/R\.\.\//.test(withoutMetadata),
      keptNumber: /1\.\.\/2\.\.\/3\.\.\/4\.\.\//.test(withoutMetadata),
    };
  });
  if (!metadataExports.withMetadata || metadataExports.withoutMetadata
    || !metadataExports.keptKeyboard || !metadataExports.keptNumber) {
    throw new Error(`optional TXT metadata export is incorrect: ${JSON.stringify(metadataExports)}`);
  }

  await page.locator("#btn-export").click();
  let exportBox = page.locator(".modal-box").filter({ hasText: "键盘谱 TXT" });
  if (await exportBox.getByRole("button", { name: "PNG（全部页面）" }).count() !== 1
    || await exportBox.getByRole("button", { name: "PDF（全部页面）" }).count() !== 1
    || await exportBox.getByRole("button", { name: "MusicXML" }).count() !== 1) {
    throw new Error("score export menu is missing all-page PNG, PDF or MusicXML");
  }
  const pngDownloadPromise = page.waitForEvent("download");
  await exportBox.getByRole("button", { name: "PNG（全部页面）" }).click();
  const pngOptionsBox = page.locator(".modal-box").filter({ hasText: "透明背景" });
  await pngOptionsBox.waitFor();
  const pngChecks = pngOptionsBox.locator('input[type="checkbox"]');
  if (await pngChecks.count() !== 2 || !await pngChecks.nth(0).isChecked()) {
    throw new Error("PNG export does not default to a transparent background");
  }
  await pngChecks.nth(1).check();
  await pngOptionsBox.getByRole("button", { name: "导出" }).click();
  const pngDownload = await pngDownloadPromise;
  const pngDownloadPath = await pngDownload.path();
  const pngDownloadBytes = pngDownloadPath ? await readFile(pngDownloadPath) : null;
  if (!pngDownload.suggestedFilename().endsWith(".zip")
    || !pngDownloadBytes
    || pngDownloadBytes[0] !== 0x50
    || pngDownloadBytes[1] !== 0x4b) {
    throw new Error("PNG ZIP export did not create a valid downloadable archive");
  }

  await page.locator("#btn-export").click();
  exportBox = page.locator(".modal-box").filter({ hasText: "键盘谱 TXT" });
  const pdfDownloadPromise = page.waitForEvent("download");
  await exportBox.getByRole("button", { name: "PDF（全部页面）" }).click();
  const pdfDownload = await pdfDownloadPromise;
  const pdfDownloadPath = await pdfDownload.path();
  const pdfDownloadBytes = pdfDownloadPath ? await readFile(pdfDownloadPath) : null;
  if (!pdfDownload.suggestedFilename().endsWith(".pdf")
    || !pdfDownloadBytes
    || pdfDownloadBytes.subarray(0, 5).toString() !== "%PDF-") {
    throw new Error("PDF export did not create a valid downloadable PDF");
  }
  if (process.argv[7]) {
    await mkdir(dirname(process.argv[7]), { recursive: true });
    await pdfDownload.saveAs(process.argv[7]);
  }

  await page.locator("#btn-export").click();
  exportBox = page.locator(".modal-box").filter({ hasText: "键盘谱 TXT" });
  const musicXmlDownloadPromise = page.waitForEvent("download");
  await exportBox.getByRole("button", { name: "MusicXML" }).click();
  const musicXmlDownload = await musicXmlDownloadPromise;
  const musicXmlDownloadPath = await musicXmlDownload.path();
  const musicXmlDownloadBytes = musicXmlDownloadPath
    ? await readFile(musicXmlDownloadPath)
    : null;
  const musicXmlDownloadText = musicXmlDownloadBytes?.toString("utf-8") ?? "";
  if (!musicXmlDownload.suggestedFilename().endsWith(".musicxml")
    || !musicXmlDownloadText.includes('<score-partwise version="4.0">')
    || !musicXmlDownloadText.includes("<part-list>")
    || !musicXmlDownloadText.includes("<measure ")) {
    throw new Error("MusicXML export did not create a valid downloadable partwise score");
  }

  await page.locator("#btn-export").click();
  exportBox = page.locator(".modal-box").filter({ hasText: "键盘谱 TXT" });
  await exportBox.getByRole("button", { name: "键盘谱 TXT" }).click();
  const slashExportBox = page.locator(".modal-box")
    .filter({ hasText: "键盘谱 / 数字谱导出设置" });
  await slashExportBox.waitFor();
  const exportChecks = slashExportBox.locator('input[type="checkbox"]');
  if (await exportChecks.count() !== 2
    || !await exportChecks.nth(0).isChecked()
    || !await exportChecks.nth(1).isChecked()) {
    throw new Error("slash TXT export options are not both checked by default");
  }
  await exportChecks.nth(1).uncheck();
  if (!/下次打开无法自动读取/.test(await slashExportBox.textContent())) {
    throw new Error("disabling @jpeditor metadata did not show the manual-settings warning");
  }
  await slashExportBox.getByRole("button", { name: "取消" }).click();

  const twoVoiceColorText = `键盘谱
4/4拍：
点=八分音符
(\u2063Q Z)../\u2063W../X../Z../
`;
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.textVoiceColoring = true;
    app.slashVoiceColors[0] = "#dc2626";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 2, instrumentName: "钢琴",
      title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 8 }, spaceDivision: null, noteDivision: null,
      braceMode: "none", bracketMode: "none",
    };
    app.setText(text);
  }, twoVoiceColorText);
  await page.waitForFunction(() => document.querySelectorAll(".cm-slash-voice").length >= 2);
  await page.locator("#btn-file-menu").click();
  await page.locator("#btn-options").click();
  let optionsBox = page.locator(".options-box");
  let textColorToggle = optionsBox.locator("label.modal-row")
    .filter({ hasText: "文本声部着色" }).locator('input[type="checkbox"]');
  if (!await textColorToggle.isChecked()) {
    throw new Error("text voice coloring master switch was not enabled initially");
  }
  await textColorToggle.uncheck();
  await page.locator(".modal-overlay").click({ position: { x: 2, y: 2 } });
  const unsaved = page.getByRole("dialog", { name: "设置尚未保存", exact: true });
  await unsaved.getByRole("button", { name: "继续编辑", exact: true }).click();
  if (await optionsBox.count() !== 1) throw new Error("dirty settings must remain open after Continue editing");
  await optionsBox.getByRole("button", { name: "确定" }).click();
  await page.waitForFunction(() =>
    window.__app.textVoiceColoring === false
    && document.querySelectorAll(".cm-slash-voice").length === 0);
  const preservedVoiceColor = await page.evaluate(() => window.__app.slashVoiceColors[0]);
  if (preservedVoiceColor !== "#dc2626") {
    throw new Error(`disabling text voice colors deleted the saved color: ${preservedVoiceColor}`);
  }
  await page.locator("#btn-file-menu").click();
  await page.locator("#btn-options").click();
  optionsBox = page.locator(".options-box");
  textColorToggle = optionsBox.locator("label.modal-row")
    .filter({ hasText: "文本声部着色" }).locator('input[type="checkbox"]');
  if (await textColorToggle.isChecked()) {
    throw new Error("text voice coloring master switch did not persist its disabled state");
  }
  await textColorToggle.check();
  await optionsBox.getByRole("button", { name: "确定" }).click();
  await page.waitForFunction(() =>
    window.__app.textVoiceColoring === true
    && document.querySelectorAll(".cm-slash-voice").length >= 2);

  const prefixedArpeggioSlash = `键盘谱
4/4拍：
点=16分音符
花括号=琶音
{,NZCB}A..../..../-/-/
`;
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 16 }, spaceDivision: null, noteDivision: null, braceMode: "arpeggio",
    };
    app.setText(text);
  }, prefixedArpeggioSlash);
  await page.waitForFunction(() => window.__app._sourceNotes.length === 5 &&
    document.querySelectorAll("#score-pane .jianpu-arpeggio").length === 1);
  const arpeggioMapping = await page.evaluate(async () => {
    const app = window.__app;
    const sources = [...app._sourceNotes];
    const chord = sources[0]?.chord;
    let exactReverseMapping = true;
    for (const source of sources) {
      app.view.dispatch({ selection: { anchor: source.from, head: source.to } });
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      if (app._selectedNotes.length !== 1 || app._selectedNotes[0].source.note !== source.note) {
        exactReverseMapping = false;
      }
    }
    const continuation = chord?.measure.entries.find((entry) => entry.transparentContinuation);
    return {
      text: sources.map((source) => app.view.state.doc.sliceString(source.from, source.to)),
      sameChord: sources.every((source) => source.chord === chord),
      exactReverseMapping,
      tiedContinuation: Boolean(continuation && continuation.notes.length === 5 &&
        continuation.notes.every((note) => note.tieEnd && note.tiePrev?.chord === chord)),
    };
  });
  if (arpeggioMapping.text.join("|") !== ",N|Z|C|B|A" ||
    !arpeggioMapping.sameChord || !arpeggioMapping.exactReverseMapping ||
    !arpeggioMapping.tiedContinuation) {
    throw new Error(`prefixed arpeggio highlighting or tie mapping is inaccurate: ${JSON.stringify(arpeggioMapping)}`);
  }
  const arpeggioClickPoints = await page.evaluate(() => {
    const app = window.__app;
    return app._sourceNotes.map((source) => {
      const element = app.painter.noteGroupEl(source.chord, source.note);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        text: app.view.state.doc.sliceString(source.from, source.to),
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    });
  });
  if (arpeggioClickPoints.some((point) => !point)) {
    throw new Error("a prefixed arpeggio tone has no clickable score visual");
  }
  for (const point of arpeggioClickPoints) {
    await page.mouse.click(point.x, point.y);
    state = await page.evaluate(() => ({
      source: window.__app.view.state.selection.ranges.map((range) =>
        window.__app.view.state.doc.sliceString(range.from, range.to)),
    }));
    if (state.source.join("|") !== point.text) {
      throw new Error(`clicking arpeggio tone ${point.text} selected the wrong TXT range: ${JSON.stringify(state)}`);
    }
  }
  if (process.argv[4]) {
    await page.evaluate(() => {
      window.__app.deselect();
      window.__app.setZoom(3);
    });
    await page.locator("#score-pane .score-page").first().screenshot({ path: process.argv[4] });
    await page.evaluate(() => window.__app.setZoom(1));
  }

  // A tied chord may be split into different written durations at a barline.
  // Its stacked-note geometry must depend on pitches/octave dots, not on the
  // number of reduction beams attached only to the bottom rhythmic baseline.
  const crossMeasureChordFixture = `.Title
Title = {跨小节和弦高度}
KeyAndMeters = {1=C,4/4}
Tempo = {90}
.Voice
([6'6]__ |[6'6]-) |]
`;
  const crossMeasureChordHeight = await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
    const chords = app.painter.score.parts[0]?.measures
      .flatMap((measure) => measure.entries)
      .filter((entry) => Array.isArray(entry.notes) && entry.notes.length === 2)
      .slice(0, 2) ?? [];
    const gaps = chords.map((chord) => {
      const centers = chord.notes.map((note) => {
        const element = app.painter.noteGroupEl(chord, note);
        const rect = element?.getBoundingClientRect();
        return rect ? rect.top + rect.height / 2 : Number.NaN;
      });
      return Math.abs(centers[0] - centers[1]);
    });
    return {
      chordCount: chords.length,
      beams: chords.map((chord) => chord.beams),
      gaps,
      tied: chords[1]?.notes.every((note) => note.tieEnd) ?? false,
    };
  }, crossMeasureChordFixture);
  if (crossMeasureChordHeight.chordCount !== 2
    || crossMeasureChordHeight.beams.join(",") !== "2,0"
    || !crossMeasureChordHeight.tied
    || crossMeasureChordHeight.gaps.some((gap) => !Number.isFinite(gap))
    || Math.abs(crossMeasureChordHeight.gaps[0] - crossMeasureChordHeight.gaps[1]) > 0.75) {
    throw new Error(
      `cross-measure tied chord height changed with its written duration: ${
        JSON.stringify(crossMeasureChordHeight)
      }`,
    );
  }

  const crossSystemContinuationText = `键盘谱
4/4拍：
点=八分音符
-/-/-/(\u2063Q Z)../
../../\u2063W../X../
`;
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "keyboard";
    app.slashOptions = {
      kind: "keyboard", voiceCount: 2, instrumentName: "钢琴",
      title: "", subtitle: "", composer: "", arranger: "", lyricist: "",
      tempoBpm: 90, fifths: 0, beats: 4, beatType: 4,
      symbolDurations: { ".": 8 }, spaceDivision: null, noteDivision: null,
      braceMode: "none", bracketMode: "none",
    };
    app.setText(text);
    app.setEngravingStyle({ ...app.engravingStyle, measuresPerSystem: 1 }, false);
  }, crossSystemContinuationText);
  await page.waitForFunction(() =>
    document.querySelectorAll("#score-pane .tie-system-incoming").length >= 2
    && document.querySelectorAll("#score-pane .tie-system-outgoing").length >= 2);
  const crossSystemContinuation = await page.evaluate(() => {
    const app = window.__app;
    const continuations = app.painter.score.parts.map((part) =>
      part.measures[1]?.entries.find((entry) =>
        entry.transparentContinuation
        && Math.abs(entry.position.toFloat()) < 1e-8));
    const fills = continuations.flatMap((chord) =>
      chord?.notes.map((note) =>
        app.painter.noteGroupEl(chord, note)?.querySelector("text")?.getAttribute("fill")) ?? []);
    return {
      incoming: document.querySelectorAll("#score-pane .tie-system-incoming").length,
      outgoing: document.querySelectorAll("#score-pane .tie-system-outgoing").length,
      curveHeights: [...document.querySelectorAll(
        "#score-pane .tie-system-incoming path, #score-pane .tie-system-outgoing path",
      )].map((path) => path.getBBox().height),
      tied: continuations.length === 2 && continuations.every((chord) =>
        chord?.notes.every((note) =>
          note.tieEnd && note.tiePrev && note.tiePrev.tieNext === note)),
      transparent: continuations.every((chord) => chord?.transparentContinuation),
      fills,
    };
  });
  if (crossSystemContinuation.incoming < 2
    || crossSystemContinuation.outgoing < 2
    || !crossSystemContinuation.tied
    || !crossSystemContinuation.transparent
    || crossSystemContinuation.curveHeights.length < 4
    || crossSystemContinuation.curveHeights.some((height) => height < 3)
    || crossSystemContinuation.fills.length < 2
    || crossSystemContinuation.fills.some((fill) => !fill || fill === "#000000")) {
    throw new Error(
      `cross-system multi-voice continuation lost its tie or grey rendering: ${
        JSON.stringify(crossSystemContinuation)
      }`,
    );
  }
  if (process.argv[5]) {
    await page.locator("#score-pane .score-page").first().screenshot({ path: process.argv[5] });
  }

  const ensembleDraftFixture = `.Title
Title = {总谱排版草稿隔离}
KeyAndMeters = {1=C,4/4}
Tempo = {90}
.Voice.钢琴.V1
1 2 3 4 |]
.Voice.钢琴.V2
1, 2, 3, 4, |]
.Voice.小提琴.V1
5' 6' 7' 1'' |]
`;
  await page.evaluate((text) => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(text);
  }, ensembleDraftFixture);
  await page.waitForFunction(() =>
    document.querySelectorAll("#score-pane .ensemble-system").length > 0);
  const ensembleBefore = await page.evaluate(() => ({
    html: document.querySelector("#score-pane")?.innerHTML ?? "",
    metaY: window.__app.engravingStyle.publicationMetaYOffset,
    metaTransform: document.querySelector("#score-pane .publication-meta")?.getAttribute("transform"),
    source: window.__app.getText(),
  }));
  await page.locator("#btn-layout-style").click();
  await page.locator('input[name="publicationMetaYOffset"]').evaluate((input) => {
    input.value = "2.4";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(() =>
    Math.abs(window.__app.painter.layout.options.engravingStyle.publicationMetaYOffset - 2.4) < 1e-8);
  const ensembleDraftIsolation = await page.evaluate((before) => ({
    scoreChanged: (document.querySelector("#score-pane")?.innerHTML ?? "") !== before.html,
    styleUnchanged: window.__app.engravingStyle.publicationMetaYOffset === before.metaY,
    sourceUnchanged: window.__app.getText() === before.source,
    previewHasEnsemble: document.querySelectorAll("#score-pane .ensemble-system").length > 0,
  }), ensembleBefore);
  if (process.argv[6]) {
    await page.locator("#inspector-pane").screenshot({ path: process.argv[6] });
  }
  await page.locator("#inspector-pane .inspector-close").click();
  if (!await page.locator("#inspector-pane .inspector-dirty-prompt").isVisible()) {
    throw new Error("closing a dirty engraving inspector did not show the inline choice");
  }
  await page.getByRole("button", { name: "继续编辑" }).click();
  if (await page.locator("#inspector-pane").isHidden()) {
    throw new Error("continue editing closed the dirty engraving inspector");
  }
  await page.locator("#inspector-pane .inspector-footer").getByRole("button", { name: "取消" }).click();
  await page.waitForFunction((before) =>
    document.getElementById("inspector-pane").hidden
    && window.__app.painter.layout.options.engravingStyle.publicationMetaYOffset === before.metaY,
  ensembleBefore);
  const ensembleAfterCancel = await page.evaluate(() =>
    document.querySelector("#score-pane .publication-meta")?.getAttribute("transform"));
  if (!ensembleDraftIsolation.scoreChanged
    || !ensembleDraftIsolation.styleUnchanged
    || !ensembleDraftIsolation.sourceUnchanged
    || !ensembleDraftIsolation.previewHasEnsemble
    || ensembleAfterCancel !== ensembleBefore.metaTransform) {
    throw new Error(
      `engraving ensemble preview/cancel failed: ${
        JSON.stringify({ ...ensembleDraftIsolation, restored: ensembleAfterCancel === ensembleBefore.metaTransform })
      }`,
    );
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(80);
  const portraitLayout = await page.evaluate(() => {
    const toolbar = document.querySelector("#toolbar");
    const body = document.querySelector("#body");
    const code = document.querySelector("#code-workspace");
    const score = document.querySelector("#score-pane");
    const toggle = document.querySelector("#code-pane-toggle");
    const controls = [...document.querySelectorAll("#toolbar > button, #toolbar > select")];
    return {
      toolbarFitsHeight: toolbar.scrollHeight <= toolbar.clientHeight + 1,
      controlsUnclipped: controls.every((control) =>
        control.scrollWidth <= control.clientWidth + 1
        && control.scrollHeight <= control.clientHeight + 1),
      bodyDirection: getComputedStyle(body).flexDirection,
      codePosition: getComputedStyle(code).position,
      codeWidth: code.getBoundingClientRect().width,
      scoreWidth: score.getBoundingClientRect().width,
      toggleWidth: toggle.getBoundingClientRect().width,
      viewportWidth: innerWidth,
    };
  });
  if (!portraitLayout.toolbarFitsHeight
    || !portraitLayout.controlsUnclipped
    || portraitLayout.bodyDirection !== "row"
    || portraitLayout.codePosition !== "absolute"
    || portraitLayout.codeWidth > 340
    || portraitLayout.scoreWidth < portraitLayout.viewportWidth - 20
    || portraitLayout.toggleWidth > 20) {
    throw new Error(`portrait responsive layout failed: ${JSON.stringify(portraitLayout)}`);
  }
  await page.locator("#btn-layout-style").click();
  const portraitInspector = await page.evaluate(() => {
    const pane = document.querySelector("#inspector-pane");
    const score = document.querySelector("#score-pane");
    const rect = pane.getBoundingClientRect();
    return {
      position: getComputedStyle(pane).position,
      right: rect.right,
      left: rect.left,
      top: rect.top,
      bottom: rect.bottom,
      height: innerHeight,
      headerVisible: pane.querySelector(".inspector-header")?.getBoundingClientRect().bottom <= innerHeight,
      footerVisible: pane.querySelector(".inspector-footer")?.getBoundingClientRect().top < innerHeight,
      scoreWidth: score.getBoundingClientRect().width,
      viewportWidth: innerWidth,
    };
  });
  if (portraitInspector.position !== "fixed"
    || portraitInspector.left < 0
    || portraitInspector.right > portraitInspector.viewportWidth + 1
    || portraitInspector.top < 0
    || portraitInspector.bottom > portraitInspector.height + 1
    || !portraitInspector.headerVisible
    || !portraitInspector.footerVisible
    || portraitInspector.scoreWidth < portraitInspector.viewportWidth - 20) {
    throw new Error(`portrait floating inspector escaped or resized score: ${JSON.stringify(portraitInspector)}`);
  }
  await page.locator("#inspector-pane .inspector-close").click();
  await page.waitForFunction(() => document.getElementById("inspector-pane").hidden);
  await page.locator("#btn-file-menu").click();
  await page.locator("#btn-options").click();
  await page.waitForSelector(".modal-overlay .modal-box");
  const portraitModal = await page.evaluate(() => {
    const box = document.querySelector(".modal-overlay .modal-box").getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      width: innerWidth,
      height: innerHeight,
    };
  });
  if (portraitModal.left < -1
    || portraitModal.right > portraitModal.width + 1
    || portraitModal.top < -1
    || portraitModal.bottom > portraitModal.height + 1) {
    throw new Error(`portrait modal escaped the viewport: ${JSON.stringify(portraitModal)}`);
  }
  await page.locator(".modal-footer button").first().click();

  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(80);
  const landscapeLayout = await page.evaluate(() => {
    const body = document.querySelector("#body");
    const toolbar = document.querySelector("#toolbar");
    const controls = [...document.querySelectorAll("#toolbar > button, #toolbar > select")];
    return {
      bodyDirection: getComputedStyle(body).flexDirection,
      toolbarFitsHeight: toolbar.scrollHeight <= toolbar.clientHeight + 1,
      controlsUnclipped: controls.every((control) =>
        control.scrollWidth <= control.clientWidth + 1
        && control.scrollHeight <= control.clientHeight + 1),
      codeWidth: document.querySelector("#code-pane").getBoundingClientRect().width,
      scoreWidth: document.querySelector("#score-pane").getBoundingClientRect().width,
    };
  });
  if (landscapeLayout.bodyDirection !== "row"
    || !landscapeLayout.toolbarFitsHeight
    || !landscapeLayout.controlsUnclipped
    || landscapeLayout.codeWidth < 200
    || landscapeLayout.scoreWidth < 300) {
    throw new Error(`landscape responsive layout failed: ${JSON.stringify(landscapeLayout)}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  const musicXmlFixture = [...await readFile("examples/piano-demo.musicxml")];
  await page.evaluate((input) => {
    void window.__app.importBytes(Uint8Array.from(input), "dialog-test.musicxml");
  }, musicXmlFixture);
  const musicXmlImportBox = page.locator(".modal-box")
    .filter({ hasText: "MusicXML 导入" });
  await musicXmlImportBox.waitFor();
  const musicXmlDialogState = await musicXmlImportBox.evaluate((box) => ({
    hasOutputFormat: [...box.querySelectorAll("label")].some((label) =>
      label.textContent?.includes("导入后格式")),
    hasTextDivision: [...box.querySelectorAll("label")].some((label) =>
      label.textContent?.includes("文本谱最短时值")),
    hasMetadata: box.textContent?.includes("标题与署名"),
    hasInstrumentMapping: box.textContent?.includes("乐器与声部"),
    hasMeterTempo: box.textContent?.includes("调号、拍号与速度"),
  }));
  if (Object.values(musicXmlDialogState).some((value) => !value)) {
    throw new Error(
      `MusicXML import dialog omitted MIDI-style conversion controls: ${
        JSON.stringify(musicXmlDialogState)
      }`,
    );
  }
  await musicXmlImportBox.locator("label")
    .filter({ hasText: "导入后格式" })
    .locator("select")
    .selectOption("keyboard");
  await musicXmlImportBox.getByRole("button", { name: "导入并转为简谱" }).click();
  await page.waitForFunction(() =>
    window.__app.documentFormat === "keyboard"
    && !document.querySelector(".modal-box"));

  const beforeFailedImport = await page.evaluate(() => window.__app.getText());
  await page.evaluate(async () => {
    await window.__app.importBytes(
      new TextEncoder().encode("<score-partwise><part-list>"),
      "broken.musicxml",
    );
  });
  const failureBox = page.locator(".import-failure-overlay .modal-box");
  await failureBox.waitFor();
  const failureState = await failureBox.evaluate((box) => ({
    title: box.querySelector(".modal-title")?.textContent,
    text: box.textContent,
    role: box.getAttribute("role"),
  }));
  const afterFailedImport = await page.evaluate(() => window.__app.getText());
  if (failureState.title !== "导入失败"
    || failureState.role !== "alertdialog"
    || !failureState.text?.includes("当前正在编辑的乐谱没有被替换")
    || afterFailedImport !== beforeFailedImport) {
    throw new Error(
      `failed MusicXML import did not show a non-destructive error prompt: ${
        JSON.stringify(failureState)
      }`,
    );
  }
  await failureBox.getByRole("button", { name: "确定" }).click();

  if (errors.filter((error) =>
    !/favicon/.test(error) && !/MusicXML 导入失败/.test(error)).length > 0) {
    throw new Error(`browser errors: ${errors.join("\n")}`);
  }
  const result = {
    text: await page.evaluate(() => window.__app.getText()),
    singleSelection: true,
    multiSelection: true,
    keyboardPitchEdit: true,
    numberSlashPitchEdit: true,
    keyboardSlashPitchEdit: true,
    jpwFormatConversion: true,
    mixedRecognitionSwitch: true,
    scoreSettingsAvailability: true,
    scoreSettingsApplied: true,
    engravingInspectorLivePreview: true,
    engravingInlineDirtyGuard: true,
    builtInMetadata: true,
    pngZipExport: true,
    pdfExport: true,
    musicXmlExport: true,
    musicXmlImportDialog: true,
    importFailurePrompt: true,
    optionalMetadataExport: true,
    textVoiceColorToggle: true,
    arpeggioHighlighting: true,
    keyboardQBaseline: true,
    hiddenTieLabelLayout: true,
    crossMeasureChordHeight: true,
    crossSystemContinuation: true,
    ensembleDraftIsolation: true,
    invisibleVoiceMarkerAtomicity: true,
    portraitResponsiveLayout: true,
    landscapeResponsiveLayout: true,
    selectedPlayback,
    slashPlayback,
    clearedPlayback,
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  server.close();
}
