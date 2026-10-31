import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";

// Run against current sources; this does not rebuild or replace dist/.
const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, clearScreen: false });
await server.listen();
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, hasTouch: true });
// This suite verifies desktop mouse/long-press behavior; touch workspaces have
// their own gesture and layout suite.
await page.addInitScript(() => localStorage.setItem('jpeditor:workspace-mode:v1', 'desktop'));
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(server.resolvedUrls.local[0], { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app?.isStaffPreviewCurrent());
  await page.evaluate(() => {
    const app = window.__app;
    app.documentFormat = "jpw"; app.slashOptions = null; app.setCodePaneCollapsed(true);
    app.setText(".Title\nTitle = {模式检查}\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 | 5 6 7 1' |]");
    app.resetDocumentUndo();
    window.__auditions = []; window.__plays = 0; window.__auditionStops = 0;
    app._player = { state: "stopped", stop() {}, stopAudition() { window.__auditionStops++; },
      async audition(notes) { window.__auditions.push(notes); }, async play() { window.__plays++; } };
  });
  const state = () => page.evaluate(() => ({ mode: window.__app.interactionMode,
    selected: window.__app._selectedNotes.length, origin: window.__app.selectionOrigin,
    cursor: window.__app._input.snapshot(), text: window.__app.getText(), auditions: window.__auditions.length,
    plays: window.__plays, auditionStops: window.__auditionStops }));
  const point = async (index, staff = false) => page.evaluate(({ index, staff }) => {
    const app = window.__app, source = app._sourceNotes[index];
    const element = staff ? Array.from(document.querySelectorAll("#staff-pages [data-staff-ref]")).find(element => {
      const ref = { revision: app._staffRevision, id: element.dataset.staffRef };
      return app.getStaffPreviewSnapshot().registry.resolve(ref)?.note === source.note;
    }) : app.painter.noteGroupEls(source.chord, source.note)[0]?.element;
    const rect = element?.getBoundingClientRect();
    if (!rect) throw new Error("missing note hit geometry");
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  }, { index, staff });
  assert.equal((await state()).mode, "select");
  const first = await point(0); await page.mouse.click(first.x, first.y);
  const selected = await state(); assert.equal(selected.selected, 1); assert.equal(selected.auditions, 1);
  for (const key of ["ArrowUp", "ArrowDown", "Delete", "1", "Control+ArrowRight"]) await page.keyboard.press(key);
  assert.equal((await state()).text, selected.text, "selection keys cannot change score");
  await page.evaluate(() => { const app = window.__app; app.editStaffDuration(8); app.moveStaffPitch("diatonic", 1); app.deleteSelectedScoreItems(); });
  assert.equal((await state()).text, selected.text, "direct mutation entry points also guard selection mode");
  await page.keyboard.press("n"); assert.equal((await state()).mode, "input", "N enters input from selection");
  const nCursor = (await state()).cursor;
  await page.keyboard.press("Shift+N"); assert.equal((await state()).mode, "select", "N exits to selection");
  assert.equal((await state()).selected, 1, "N exit preserves the selected note");
  await page.keyboard.press("n"); assert.deepEqual((await state()).cursor, nCursor, "N reentry restores the input cursor");
  await page.keyboard.press("Escape"); assert.equal((await state()).mode, "view", "Escape still exits to view");
  await page.keyboard.press("n"); assert.equal((await state()).mode, "input", "N enters input from view");
  await page.keyboard.press("n"); assert.equal((await state()).mode, "select", "N exit from view-origin input returns to selection");
  await page.locator("#btn-select-mode").click();
  assert.equal((await state()).mode, "view"); assert.equal((await state()).selected, 0);
  assert.ok((await state()).auditionStops > selected.auditionStops, "view mode stops the previous audition");
  await page.mouse.click(first.x, first.y); assert.equal((await state()).selected, 0, "view cannot select notes");
  await page.evaluate(() => window.__app.scorePane.focus()); await page.keyboard.press("Space");
  assert.equal((await state()).plays, 1, "view mode Space plays from the opening without a selection");
  await page.locator("#btn-select-mode").click();
  const selectedAgain = await point(0); await page.mouse.click(selectedAgain.x, selectedAgain.y);
  await page.locator("#btn-input-mode").click();
  assert.equal((await state()).selected, 1, "entering input preserves single selection");
  await page.keyboard.press("ArrowRight"); const moved = await state();
  await page.locator("#btn-select-mode").click(); await page.locator("#btn-input-mode").click();
  assert.deepEqual((await state()).cursor, moved.cursor, "switch without a new selection restores input cursor");
  await page.locator("#btn-select-mode").click();
  const third = await point(2); await page.mouse.click(third.x, third.y);
  await page.locator("#btn-input-mode").click();
  assert.equal((await state()).cursor.offset, "2", "new selected note determines input position");
  await page.locator("#btn-input-mode").click(); assert.equal((await state()).mode, "view");
  await page.evaluate(() => { const app = window.__app; app.view.dispatch({ changes: { from: 0, insert: "\n" } }); });
  await page.waitForTimeout(250); assert.ok((await state()).text.startsWith("\n"), "text remains editable in view mode");

  await page.locator("#btn-select-mode").click();
  const target = await point(1), beforeMarquee = (await state()).auditions;
  await page.mouse.move(target.left - 12, target.top - 12); await page.mouse.down();
  await page.mouse.move(target.right + 2, target.bottom + 2, { steps: 6 });
  assert.equal(await page.locator(".score-marquee").count(), 1, "jianpu marquee is visible while dragging");
  await page.mouse.up();
  assert.equal((await state()).origin, "marquee"); assert.equal((await state()).selected, 1);
  assert.equal((await state()).auditions, beforeMarquee + 1, "one audition occurs on marquee commit");
  await page.locator("#btn-input-mode").click(); assert.equal((await state()).selected, 1);
  await page.locator("#btn-select-mode").click();
  const additional = await point(0); await page.keyboard.down("Control");
  await page.mouse.click(additional.x, additional.y); await page.keyboard.up("Control");
  assert.equal((await state()).selected, 2, "Ctrl adds another exact note");
  await page.locator("#btn-input-mode").click(); assert.equal((await state()).selected, 2, "entering input preserves every selected note");
  await page.locator("#btn-select-mode").click();
  const cancelTarget = await point(2), beforeCancel = await state();
  await page.mouse.move(cancelTarget.left - 12, cancelTarget.top - 12); await page.mouse.down();
  await page.mouse.move(cancelTarget.right + 2, cancelTarget.bottom + 2);
  await page.keyboard.press("Escape"); await page.mouse.up();
  assert.equal((await state()).selected, beforeCancel.selected, "Escape cancels the marquee without changing the selection");
  assert.equal((await state()).auditions, beforeCancel.auditions, "cancelled marquee is silent");
  const touch = await page.context().newCDPSession(page), jianpuTouchTarget = await point(2);
  const beforeJianpuTouch = (await state()).auditions;
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: jianpuTouchTarget.right + 12, y: jianpuTouchTarget.bottom + 16 }] });
  await page.waitForTimeout(390);
  await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: jianpuTouchTarget.left - 1, y: jianpuTouchTarget.top - 1 }] });
  assert.equal(await page.locator(".score-marquee").count(), 1, "touch hold starts a jianpu marquee");
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  assert.equal((await state()).auditions, beforeJianpuTouch + 1);

  await page.selectOption("#staff-view-select", "staff");
  await page.waitForFunction(() => document.querySelector("#staff-pages [data-staff-ref]"));
  const staffPoint = await point(2, true); await page.mouse.click(staffPoint.x, staffPoint.y);
  assert.equal((await state()).selected, 1);
  await page.keyboard.press("n"); assert.equal((await state()).mode, "input", "staff N enters input");
  await page.keyboard.press("n"); assert.equal((await state()).mode, "select", "staff N exits to selection");
  assert.equal(await page.locator(".staff-selected").first().evaluate(element => getComputedStyle(element).fill), "rgb(201, 182, 228)");
  const staffText = (await state()).text;
  for (const key of ["ArrowUp", "1", ".", "Delete"]) await page.keyboard.press(key);
  assert.equal((await state()).text, staffText, "staff selection mode cannot modify pitch/duration/delete");
  const staffTarget = await point(1, true), beforeStaffMarquee = (await state()).auditions;
  await page.mouse.move(staffTarget.left - 14, staffTarget.top - 14); await page.mouse.down();
  await page.mouse.move(staffTarget.right + 1, staffTarget.bottom + 1, { steps: 6 });
  assert.equal(await page.locator(".staff-marquee").count(), 1);
  await page.mouse.up(); assert.equal((await state()).origin, "marquee");
  assert.equal((await state()).auditions, beforeStaffMarquee + 1);
  const touchTarget = await point(2, true), beforeTouch = (await state()).auditions;
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchTarget.left - 14, y: touchTarget.top - 14 }] });
  await page.waitForTimeout(390);
  await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touchTarget.right + 1, y: touchTarget.bottom + 1 }] });
  assert.equal(await page.locator(".staff-marquee").count(), 1, "touch hold starts a staff marquee");
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  assert.equal((await state()).origin, "marquee");
  assert.equal((await state()).auditions, beforeTouch + 1, "touch marquee auditions exactly once when released");
  await page.locator("#btn-input-mode").click();
  const beforeHorizontal = (await state()).auditions;
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowLeft");
  assert.equal((await state()).auditions, beforeHorizontal, "staff horizontal navigation is silent");
  assert.deepEqual(errors, []);
  console.log("Interaction modes: readonly view, guarded selection, retained selection/cursor, both marquees and staff navigation OK");
} finally { await browser.close(); await server.close(); }
