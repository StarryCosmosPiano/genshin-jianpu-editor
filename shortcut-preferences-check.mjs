// End-to-end keyboard shortcut regression. Run after `npm run build`.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2" };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    const data = await readFile(join(process.cwd(), "dist", file));
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

async function notePoint() {
  return page.evaluate(() => {
    const app = window.__app;
    const source = app._sourceNotes.find((item) => item.note.number === "3") ?? app._sourceNotes[0];
    const element = app.painter.noteGroupEls(source.chord, source.note)[0].element;
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
}

async function selectNote() {
  const point = await notePoint();
  await page.mouse.click(point.x, point.y);
  assert.ok(await page.evaluate(() => window.__app._selectedNotes.length > 0), "score note selected");
}

async function settleShortcutSurface(surface) {
  await page.waitForFunction(() => window.__app.debounceTimer === undefined && !window.__app.previewDirty);
  if (surface === "staff") await page.waitForFunction(() => {
    const app = window.__app, pane = document.getElementById("staff-pane");
    return app.isStaffPreviewCurrent() && pane.dataset.staffRevision === String(app.getStaffPreviewSnapshot().revision)
      && pane.getAttribute("aria-busy") === "false";
  });
}

async function resetArrowFixture(surface, input) {
  await page.evaluate(() => {
    const app = window.__app;
    app.setInputMode(false); app.setInteractionMode("select");
    app.documentFormat = "jpw"; app.slashOptions = null;
    app.setText(".Title\nTitle = {方向键互换}\nKeyAndMeters = {1=C,4/4}\n.Voice.RH\n4 0 0 0 |]\n.Voice.LH\n1 0 0 0 |]\n");
    app.setCodePaneCollapsed(true); app.resetDocumentUndo();
    app._player = { state: "stopped", stop() {}, stopAudition() {}, async audition() {} };
  });
  await page.selectOption("#staff-view-select", surface);
  await settleShortcutSurface(surface);
  if (surface === "staff") {
    const id = await page.evaluate(() => window.__app.getStaffPreviewSnapshot().registry.targets
      .find(item => !item.grace && !item.note.rest && item.partIndex === 0).ref.id);
    await page.locator(`#staff-pages [data-staff-ref="${id}"]`).first().click();
  } else await selectNote();
  if (input) await page.keyboard.press("n");
  await settleShortcutSurface(surface);
}

async function arrowState() {
  return page.evaluate(() => {
    const app = window.__app;
    return {
      notes: app.painter.score.parts.flatMap((part, index) => part.measures.flatMap(measure =>
        measure.entries.flatMap(chord => (chord.notes ?? []).filter(note => !note.rest).map(note => ({
          part: index, pitch: note.pitch, at: chord.position.toString(), duration: chord.duration.toString(),
        }))))).sort((a, b) => a.part - b.part || a.pitch - b.pitch),
      selected: app._selectedNotes.map(item => ({ part: item.source.partIndex, pitch: item.visualNote.pitch })),
    };
  });
}

async function checkExchangedArrows(customized) {
  for (const surface of ["jianpu", "staff"]) {
    for (const input of [false, true]) {
      await resetArrowFixture(surface, input);
      const baseline = await arrowState();
      const context = `${customized ? "saved" : "default"} ${surface}/${input ? "input" : "selection"}`;
      const partDown = customized ? "F10" : "Control+Alt+ArrowDown";
      const partUp = customized ? "F11" : "Control+Alt+ArrowUp";
      const pitchUp = customized ? "F12" : "Alt+ArrowUp";
      const pitchDown = customized ? "F8" : "Alt+ArrowDown";
      await page.keyboard.press(pitchUp); await settleShortcutSurface(surface);
      let actual = await arrowState();
      if (input) {
        assert.deepEqual(actual.selected, [{ part: 0, pitch: surface === "staff" ? 66 : 67 }],
          `${context}: pitch key preserves its surface-specific meaning`);
        await page.keyboard.press(pitchDown); await settleShortcutSurface(surface);
      }
      assert.deepEqual((await arrowState()).notes, baseline.notes, `${context}: selection does not edit pitch / input reverses`);
      await page.keyboard.press(partDown); await settleShortcutSurface(surface);
      actual = await arrowState();
      assert.deepEqual(actual.selected, [{ part: 1, pitch: 65 }], `${context}: part key moves the note without transposing`);
      assert.deepEqual(actual.notes, baseline.notes.map(note => note.pitch === 65 ? { ...note, part: 1 } : note)
        .sort((a, b) => a.part - b.part || a.pitch - b.pitch), `${context}: movement preserves onset and duration`);
      await page.keyboard.press(partUp); await settleShortcutSurface(surface);
      assert.deepEqual((await arrowState()).notes, baseline.notes, `${context}: reverse part key restores both parts`);
    }
  }
}

try {
  const origin = process.env.APP_TEST_URL || `http://127.0.0.1:${server.address().port}/`;
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.locator("#btn-options").click();
  await page.locator(".modal-box button").filter({ hasText: "设置快捷键…" }).click();
  assert.equal(await page.getByRole("dialog", { name: "快捷键编辑" }).isVisible(), true);
  await mkdir(join(process.cwd(), "artifacts", "ui"), { recursive: true });
  await page.screenshot({ path: join(process.cwd(), "artifacts", "ui", "shortcuts.png") });
  const search = page.getByRole("searchbox", { name: "搜索快捷键" });
  await search.fill("输入音级 1");
  const degreeRow = page.locator(".shortcut-row").filter({ hasText: "输入音级 1" });
  await degreeRow.locator(".shortcut-key button").first().click();
  await page.keyboard.press("F2");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  assert.ok((await page.evaluate(() => localStorage.getItem("jpeditor.ui.shortcuts.v1")))?.includes("F2"),
    "Apply persists the captured shortcut");
  await page.locator(".modal-footer button").first().click();

  await page.locator("#btn-options").click();
  await page.locator(".modal-box button").filter({ hasText: "设置快捷键…" }).click();
  await search.fill("输入音级 1");
  await degreeRow.locator(".shortcut-key button").first().click();
  await page.keyboard.press("F3");
  await page.getByRole("button", { name: "取消", exact: true }).last().click();
  assert.ok((await page.evaluate(() => localStorage.getItem("jpeditor.ui.shortcuts.v1")))?.includes("F2"),
    "Cancel preserves the applied shortcut");
  await page.locator(".modal-footer button").first().click();

  await page.evaluate(() => {
    localStorage.setItem("jpeditor.ui.shortcuts.v1", JSON.stringify({
      "score.toggleInput": ["F9"], "input.octaveUp": ["w"], "input.degree1": ["F2"],
      "voice.1": ["Alt+q"], "voice.2": ["Mod+/"], "page.zoomIn": ["Alt+g"],
      "text.command.17": ["F8"],
      "text.command.39": ["Mod+Shift+a", "Alt+2"],
      "text.command.20": ["F4"],
      "text.command.20.shift": ["F6"],
    }));
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(() => {
    const app = window.__app;
    app.documentFormat = "jpw";
    app.slashOptions = null;
    app.setText(".Title\nTitle = {快捷键回归}\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 | 5 6 7 1' |]");
    app.reload(app.getText());
    window.__shortcutPlayback = { starts: 0 };
    app._player = {
      state: "stopped", stopAudition() {}, async audition() {}, stop() {},
      async play() { window.__shortcutPlayback.starts++; },
    };
  });

  await selectNote();
  const beforePitch = await page.evaluate(() => window.__app._selectedNotes.at(-1).source.note.pitch);
  await page.keyboard.press("w");
  assert.equal(await page.evaluate(() => window.__app._selectedNotes.at(-1)?.source.note.pitch), beforePitch,
    "input shortcut cannot edit selection-mode pitch");
  await selectNote();
  await page.keyboard.press("Space");
  assert.equal(await page.evaluate(() => window.__shortcutPlayback.starts), 1,
    "selection Space starts playback");
  await page.keyboard.press("F9");
  assert.equal(await page.evaluate(() => window.__app.interactionMode), "input", "custom N action enters input");
  await page.keyboard.press("F9");
  assert.equal(await page.evaluate(() => window.__app.interactionMode), "select", "custom N action exits to selection");
  await page.selectOption("#staff-view-select", "staff");
  await page.waitForSelector("#staff-pages [data-staff-ref]");
  await page.locator("#staff-pages [data-staff-ref]").first().click();
  await page.keyboard.press("F9");
  assert.equal(await page.evaluate(() => window.__app.interactionMode), "input", "custom staff N action enters input");
  await page.keyboard.press("F9");
  assert.equal(await page.evaluate(() => window.__app.interactionMode), "select", "custom staff N action exits to selection");
  await page.selectOption("#staff-view-select", "jianpu"); await selectNote();

  await page.evaluate(() => { window.__app.setInputMode(true); window.__app.scorePane.focus(); });
  await page.keyboard.press("w");
  assert.equal(await page.evaluate(() => window.__app._selectedNotes.at(-1)?.source.note.pitch), beforePitch + 12,
    "custom input shortcut changes octave in input mode");
  const beforeInput = await page.evaluate(() => window.__app.getText());
  await page.keyboard.press("F2");
  assert.notEqual(await page.evaluate(() => window.__app.getText()), beforeInput,
    "custom input key changes the score");
  const afterInput = await page.evaluate(() => window.__app.getText());
  await page.keyboard.press("1");
  assert.equal(await page.evaluate(() => window.__app.getText()), afterInput,
    "old degree key no longer writes");
  const beforeCursor = await page.evaluate(() => window.__app._input.cursor.offset.toFloat());
  await page.keyboard.press("Space");
  assert.ok(await page.evaluate(() => window.__app._input.cursor.offset.toFloat()) > beforeCursor,
    "input Space advances");
  assert.equal(await page.evaluate(() => window.__shortcutPlayback.starts), 1,
    "input Space does not start playback");

  await page.evaluate(() => {
    const app = window.__app;
    app.setInputMode(false);
    app.setCodePaneCollapsed(false);
    app.view.focus();
    app.view.dispatch({ selection: { anchor: app.view.state.doc.length } });
  });
  const textBefore = await page.evaluate(() => window.__app.getText());
  await page.keyboard.press("Space");
  assert.equal(await page.evaluate(() => window.__app.getText()), textBefore + " ",
    "text Space types a space");
  assert.equal(await page.evaluate(() => window.__shortcutPlayback.starts), 1);
  await page.keyboard.press("Control+Shift+A");
  assert.equal(await page.evaluate(() => {
    const view = window.__app.view;
    return view.state.selection.main.from === 0
      && view.state.selection.main.to === view.state.doc.length;
  }), true, "custom text select-all key selects the document");
  await page.evaluate(() => {
    const view = window.__app.view;
    view.dispatch({ selection: { anchor: view.state.doc.length } });
  });
  await page.keyboard.press("F6");
  assert.equal(await page.evaluate(() => {
    const view = window.__app.view;
    return view.state.selection.main.from === view.state.doc.length - 1
      && view.state.selection.main.to === view.state.doc.length;
  }), true, "custom Shift+ArrowLeft selection extends by one character");

  // Voice assignment is shared by score and text contexts; a custom Alt chord
  // must still supply the old Digit1 code expected by the existing handler.
  await page.evaluate(async () => {
    const app = window.__app;
    await app.changeDocumentFormat("keyboard");
    app.setInputMode(false);
    app.view.focus();
    const source = app._sourceNotes[0];
    app.view.dispatch({ selection: { anchor: source.from, head: source.to } });
  });
  await page.keyboard.press("Alt+q");
  assert.equal(await page.evaluate(() => window.__app.slashOptions.voiceCount), 2,
    "custom voice key assigns voice in text editor");
  const markerStart = await page.evaluate(() => {
    const app = window.__app;
    const marked = app._sourceNotes.find((source) => source.markerCount > 0);
    if (!marked) return null;
    app.view.focus();
    app.view.dispatch({ selection: { anchor: marked.from + 1 } });
    return marked.markerFrom;
  });
  assert.notEqual(markerStart, null, "voice assignment created an invisible marker");
  await page.keyboard.press("F4");
  assert.equal(await page.evaluate(() => window.__app.view.state.selection.main.head), markerStart,
    "remapped text left arrow skips invisible voice marker atomically");
  await page.keyboard.press("Alt+2");
  assert.equal(await page.evaluate(() => {
    const view = window.__app.view;
    return view.state.selection.main.from === 0
      && view.state.selection.main.to === view.state.doc.length;
  }), true, "text command takes the old voice shortcut");
  await page.evaluate(() => {
    const app = window.__app;
    const marked = app._sourceNotes.find((source) => source.markerCount > 0);
    app.view.dispatch({ selection: { anchor: marked.from, head: marked.to } });
  });
  await page.keyboard.press("Control+/");
  assert.equal(await page.evaluate(() => window.__app._sourceNotes[0].markerCount), 0,
    "voice command takes a displaced CodeMirror default");

  await page.evaluate(() => window.__app.scorePane.focus());
  const zoomBefore = await page.evaluate(() => window.__app.zoom);
  await page.keyboard.press("Alt+g");
  assert.ok(await page.evaluate(() => window.__app.zoom) > zoomBefore,
    "custom global zoom key changes zoom");

  await page.locator("#btn-options").click();
  await page.locator(".modal-box button").filter({ hasText: "设置快捷键…" }).click();
  await search.fill("分配到声部 V2");
  const voiceRow = page.locator(".shortcut-row").filter({ hasText: "分配到声部 V2" });
  await voiceRow.locator(".shortcut-key button").first().click();
  await page.keyboard.press(".");
  assert.match(await page.locator(".shortcut-recording").textContent(), /不能占用普通文字或符号/,
    "plain period cannot replace text input in a voice shortcut");
  await page.keyboard.press("Shift+=");
  assert.match(await page.locator(".shortcut-recording").textContent(), /不能占用普通文字或符号/,
    "shifted symbol cannot replace text input");
  await page.keyboard.press("Escape");
  await search.fill("当前音升八度");
  const octaveRow = page.locator(".shortcut-row").filter({ hasText: "当前音升八度" });
  await octaveRow.locator(".shortcut-key button").first().click();
  await page.keyboard.press("Alt+ArrowDown");
  assert.equal(await page.getByRole("button", { name: "应用", exact: true }).isDisabled(), true,
    "overlapping score bindings block Apply");
  await page.getByRole("button", { name: "取消", exact: true }).last().click();
  await page.locator(".modal-footer button").first().click();

  await page.evaluate(() => localStorage.setItem("jpeditor.ui.shortcuts.v1", "{}"));
  await page.reload({ waitUntil: "networkidle" });
  await checkExchangedArrows(false);
  // Old saved action IDs continue to dispatch their original operation even
  // though each operation's canonical Alt/Mod+Alt event has changed.
  await page.evaluate(() => localStorage.setItem("jpeditor.ui.shortcuts.v1", JSON.stringify({
    "score.movePartDown": ["F10"], "score.movePartUp": ["F11"],
    "input.partDown": ["F10"], "input.partUp": ["F11"],
    "staff.partDown": ["F10"], "staff.partUp": ["F11"],
    "input.degreeUp": ["F12"], "input.degreeDown": ["F8"],
    "staff.semitoneUp": ["F12"], "staff.semitoneDown": ["F8"],
  })));
  await page.reload({ waitUntil: "networkidle" });
  await checkExchangedArrows(true);

  assert.deepEqual(errors, []);
  console.log("shortcut preferences browser: settings, apply/cancel/conflict, score/input/voice/text/page keys, exchanged arrows and saved overrides OK");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
