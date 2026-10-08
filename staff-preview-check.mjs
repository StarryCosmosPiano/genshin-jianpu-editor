// Read-only staff preview integration regression; run after npm run build.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = join(process.cwd(), "dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".wasm": "application/wasm", ".svg": "image/svg+xml" };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = path === "/" ? "/index.html" : path;
    const data = await readFile(join(root, normalize(file)));
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [], requests = [], checks = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error" && !/favicon/.test(message.text())) errors.push(`${message.text()} ${message.location().url}`); });
page.on("request", request => requests.push(request.url()));
page.on("response", response => { if (response.status() >= 500) errors.push(`HTTP ${response.status()} ${response.url()}`); });
const check = (label, value) => { assert(value, label); checks.push(label); };
const piano = `.Title\nTitle = {五线谱桥接回归}\nInstrument = {钢琴}\nKeyAndMeters = {1=C,4/4}\n.Voice.RH\n[113] {2}4 5 6 |(1--- |1---) |]\n.Voice.LH\n1,--- |5,--- |1,--- |]\n`;
const single = `.Title\nTitle = {单行五线谱回归}\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 |5 6 7 1' |]\n`;
const ready = async () => {
  await page.waitForTimeout(280); // The controller intentionally coalesces model revisions for 200 ms.
  await page.waitForFunction(() => window.__app?.isStaffPreviewCurrent());
  await page.waitForFunction(() => document.querySelector("#staff-pages [data-staff-ref]") && !/正在生成|失败|正在更新/.test(document.getElementById("staff-preview-status").textContent), { timeout: 30000 });
};
const install = async text => {
  await page.evaluate(text => { const app = window.__app; app.setInputMode(false); app.documentFormat = "jpw"; app.slashOptions = null; app.setText(text); }, text);
  if (await page.locator("#staff-pane").isVisible()) await ready();
};
const state = () => page.evaluate(() => {
  const app = window.__app, snap = app.getStaffPreviewSnapshot(), selected = app.getStaffSelectionState();
  return { text: app.getText(), revision: snap.revision, current: snap.current,
    selected: selected.notes.map(note => snap.registry.refFor(note)?.id), primary: selected.primary ? snap.registry.refFor(selected.primary)?.id : null,
    ranges: app.view.state.selection.ranges.map(range => [range.from, range.to]), cursor: app._input.snapshot(), input: app.workspaceSummary().inputEnabled,
    purple: document.querySelectorAll("#staff-pages .staff-selected").length, gold: document.querySelectorAll("#staff-pages .staff-playing").length,
    left: document.querySelectorAll("#score-pane .selected").length, active: document.activeElement?.id,
    staffView: document.getElementById("score-surfaces").dataset.staffView };
});
const targets = () => page.evaluate(() => window.__app.getStaffPreviewSnapshot().registry.targets.map(target => ({
  id: target.ref.id, revision: target.ref.revision, part: target.partIndex, measure: target.measureIndex,
  entry: target.entryIndex, index: target.noteIndex, pitch: target.note.pitch, grace: target.grace,
  tied: Boolean(target.note.tiePrev), source: target.source ? [target.source.from, target.source.to] : null,
})));
const clickStaff = async (id, additive = false) => {
  const hit = page.locator(`#staff-pages [data-staff-ref="${id}"]`).first();
  await hit.click({ modifiers: additive ? ["Control"] : [] });
};
const clickJianpu = async id => {
  const point = await page.evaluate(id => {
    const app = window.__app, target = app.getStaffPreviewSnapshot().registry.targets.find(target => target.ref.id === id);
    const rendered = app.painter.noteGroupEls(target.note.chord, target.note)[0];
    rendered.element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const element = rendered.element.querySelector("text") ?? rendered.element, box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, id);
  await page.mouse.click(point.x, point.y);
};

try {
  await page.goto(process.env.APP_TEST_URL || `http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app?.isStaffPreviewCurrent());
  const unopened = await page.evaluate(() => ({ text: window.__app.getText(), parts: window.__app.painter.score.parts.length,
    registry: window.__app._staffRegistry, mode: document.getElementById("score-surfaces").dataset.staffView }));
  check("default jianpu view", unopened.mode === "jianpu");
  check("closed preview leaves registry lazy", unopened.registry === null);
  check("renderer is not requested before opening", !requests.some(url => /\/renderer[-.]/.test(url)));
  await install(piano);
  const closedPick = (await targets()).find(target => target.part === 0 && target.pitch === 64 && !target.grace);
  await clickJianpu(closedPick.id);
  const before = await state();
  await page.evaluate(() => { window.__staffScoreBeforeOpen = window.__app.painter.score; });
  await page.selectOption("#staff-view-select", "compare");
  await ready();
  check("compare shows both score surfaces", await page.locator("#score-pane").isVisible() && await page.locator("#staff-pane").isVisible());
  check("opening keeps source text unchanged", (await state()).text === before.text);
  check("opening retains the exact authoritative score model", await page.evaluate(() => window.__staffScoreBeforeOpen === window.__app.painter.score));
  check("opening reads the selection made while preview was closed", (await state()).primary === closedPick.id && (await state()).purple > 0);
  const all = await targets();
  check("piano shows selectable notes in both hands", all.some(target => target.part === 1) && await page.locator('[data-staff-ref^="p1"]').count() > 0);
  check("every source note has a staff hit", await page.locator("#staff-pages [data-staff-ref]").count() >= all.length);
  const unisons = all.filter(target => target.part === 0 && target.measure === 0 && target.entry === all[0].entry && target.pitch === 60);
  check("fixture retains two equal-pitch Note objects", unisons.length === 2);
  await clickStaff(unisons[0].id);
  let selected = await state();
  check("staff click synchronizes left and text", selected.primary === unisons[0].id && selected.left > 0 && selected.ranges.some(range => String(range) === String(unisons[0].source)));
  await clickStaff(unisons[1].id, true);
  selected = await state();
  check("Ctrl adds equal-pitch identity separately", selected.selected.includes(unisons[0].id) && selected.selected.includes(unisons[1].id) && selected.selected.length === 2);
  await clickStaff(unisons[0].id, true);
  check("Ctrl toggles only requested equal-pitch identity", (await state()).selected.join() === unisons[1].id);
  const grace = all.find(target => target.grace), tied = all.find(target => target.tied);
  check("fixture contains grace and tied notes", grace && tied);
  await clickStaff(grace.id);
  check("grace note is independently selectable", (await state()).primary === grace.id);
  await clickStaff(tied.id);
  check("tie segment retains exact visual identity", (await state()).primary === tied.id);

  // Stub only playback output; clicks and source selection use real SVG hit areas.
  await page.evaluate(() => {
    const app = window.__app;
    app._player = { state: "stopped", stop() { this.state = "stopped"; app.onPlayChord(null, 0); app.onPlayState("stopped"); },
      async play(score, options, start) { window.__staffPlayStart = { chord: start?.chord, pass: start?.pass }; },
      stopAudition() {}, audition() {} };
  });
  await page.evaluate(() => window.__app.playScore());
  check("toolbar playback starts from clicked visual chord", await page.evaluate(id => {
    const target = window.__app.getStaffPreviewSnapshot().registry.targets.find(target => target.ref.id === id);
    return window.__staffPlayStart.chord === target.note.chord;
  }, tied.id));
  await page.evaluate(id => { const app = window.__app, target = app.getStaffPreviewSnapshot().registry.targets.find(target => target.ref.id === id); app._player.state = "playing"; app.onPlayState("playing"); app.onPlayChord([target.note.chord], 0); }, tied.id);
  check("playback adds gold alongside purple", (await state()).gold > 0 && (await state()).purple > 0);
  await page.locator("#score-pane").hover();
  await page.mouse.wheel(0, 60);
  check("manual jianpu wheel pauses its follow", await page.evaluate(() => window.__app.scorePane.dataset.staffFollow === "paused"));
  await page.locator("#staff-resume-follow").click();
  check("jianpu follow can resume", await page.evaluate(() => window.__app.scorePane.dataset.staffFollow !== "paused"));
  await page.locator("#staff-pane").hover();
  await page.mouse.wheel(0, 100);
  await page.waitForFunction(() => !document.getElementById("staff-resume-follow").hidden);
  check("manual staff wheel pauses follow", await page.locator("#staff-resume-follow").isVisible());
  await page.locator("#staff-resume-follow").click();
  check("resume hides paused-follow action", !(await page.locator("#staff-resume-follow").isVisible()));
  await page.evaluate(() => window.__app.stopPlayback());
  check("stop removes gold while retaining purple", (await state()).gold === 0 && (await state()).purple > 0);

  await clickJianpu(grace.id);
  check("left click mirrors purple on staff", (await state()).primary === grace.id && (await state()).purple > 0);
  await page.evaluate(() => window.__app.playScore());
  check("left interaction replaces the prior staff playback start", await page.evaluate(id => window.__staffPlayStart.chord === window.__app.getStaffPreviewSnapshot().registry.targets.find(target => target.ref.id === id).note.chord, grace.id));
  await page.evaluate(id => { const app = window.__app, source = app.getStaffPreviewSnapshot().registry.targets.find(target => target.ref.id === id).source; app.view.focus(); app.view.dispatch({ selection: { anchor: source.from, head: source.to } }); }, unisons[1].id);
  check("text range mirrors its exact source note", (await state()).selected.includes(unisons[1].id));
  await clickStaff(grace.id);
  const readonly = await state();
  for (const key of ["n", "a", "z", "1", "Delete", "Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) await page.keyboard.press(key);
  selected = await state();
  check("read-only staff keys preserve text and input cursor", selected.text === readonly.text && JSON.stringify(selected.cursor) === JSON.stringify(readonly.cursor) && selected.input === readonly.input);
  await page.evaluate(() => window.__app.setInputMode(true));
  await ready();
  await clickStaff((await targets()).find(target => target.grace).id);
  const inputReadonly = await state();
  await page.keyboard.press("Space");
  for (const key of ["n", "a", "z", "5", "Delete", "ArrowDown"]) await page.keyboard.press(key);
  check("input mode remains read-only under staff focus", (await state()).text === inputReadonly.text && JSON.stringify((await state()).cursor) === JSON.stringify(inputReadonly.cursor));
  await page.evaluate(() => window.__app.setInputMode(false)); await ready();

  const lockedRef = (await targets())[0];
  await clickStaff(lockedRef.id);
  await page.evaluate(() => { const app = window.__app; app.togglePreviewLock(); const position = app.getText().indexOf("五线谱桥接回归"); app.view.dispatch({ changes: { from: position, to: position, insert: "新" } }); });
  const locked = await state();
  check("dirty locked text marks staff snapshot stale", !locked.current);
  await clickStaff(lockedRef.id);
  check("stale SVG clicks cannot select old source spans", (await state()).selected.join() === locked.selected.join());
  await page.evaluate(() => window.__app.togglePreviewLock()); await ready();
  check("unlock refreshes staff snapshot", (await state()).current && (await state()).revision > lockedRef.revision);
  await page.evaluate(() => { window.__staffOldSnapshot = window.__app.getStaffPreviewSnapshot(); window.__staffOldRef = window.__staffOldSnapshot.registry.targets[0].ref; });
  await install(single);
  check("single part is supported", await page.evaluate(() => window.__app.getStaffPreviewAvailability().supported));
  check("cross-document old references and snapshot are invalid", await page.evaluate(() => !window.__staffOldSnapshot.current && !window.__app.selectStaffPreviewNote(window.__staffOldRef)));
  await page.evaluate(() => { window.__app.painter.score.ensemble = true; document.dispatchEvent(new Event("editor:workspace-change")); });
  check("ensemble disables preview with explanation", await page.evaluate(() => !window.__app.getStaffPreviewAvailability().supported && document.querySelector('#staff-view-select option[value="compare"]').disabled && document.getElementById("staff-view-reason").textContent.length > 0));
  await install(piano); await page.selectOption("#staff-view-select", "compare"); await ready();

  const divider = await page.locator("#staff-divider").boundingBox();
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 50); await page.mouse.down();
  await page.mouse.move(divider.x + 110, divider.y + 50); await page.mouse.up();
  check("compare divider changes pane ratio", await page.evaluate(() => parseFloat(document.getElementById("score-surfaces").style.getPropertyValue("--staff-jianpu-ratio")) > 50));
  await clickStaff((await targets())[0].id);
  const zoomBefore = await page.evaluate(() => ({ jp: window.__app.zoom, staff: window.__app.workspaceSummary().zoom }));
  await page.keyboard.press("Control+=");
  const zoomAfter = await page.evaluate(() => ({ jp: window.__app.zoom, staff: window.__app.workspaceSummary().zoom }));
  check("staff zoom is independent of jianpu zoom", zoomAfter.jp === zoomBefore.jp && zoomAfter.staff > zoomBefore.staff);
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForFunction(() => document.getElementById("score-surfaces").dataset.staffView === "staff");
  check("narrow compare switches to a single staff surface", !(await page.locator("#score-pane").isVisible()) && await page.locator("#staff-pane").isVisible());
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForFunction(() => document.getElementById("score-surfaces").dataset.staffView === "compare");
  const long = `.Title\nTitle = {分页五线谱回归}\nKeyAndMeters = {1=C,4/4}\n.Voice\n${Array.from({ length: 60 }, (_, index) => index === 59 ? "1 2 3 4 |]" : "1 2 3 4 |").join("\n")}\n`;
  await install(long);
  await clickStaff((await targets())[0].id);
  await page.keyboard.press("Control+End");
  await page.waitForFunction(() => window.__app.workspaceSummary().page === window.__app.workspaceSummary().pages);
  check("active staff page navigation reaches last page", await page.evaluate(() => window.__app.workspaceSummary().pages > 1 && window.__app.workspaceSummary().page === window.__app.workspaceSummary().pages));
  await page.keyboard.press("Control+Home");
  await page.waitForFunction(() => window.__app.workspaceSummary().page === 1);
  check("active staff page navigation returns to first page", (await page.evaluate(() => window.__app.workspaceSummary().page)) === 1);
  await page.keyboard.press("Control+End");
  await page.evaluate(async text => {
    window.__oldStaffSvgs = [...document.querySelectorAll("#staff-pages svg")];
    await window.__app.importBytes(new TextEncoder().encode(text), "new-staff-document.jpwabc");
  }, long.replace("分页五线谱回归", "新文档五线谱回归"));
  await ready();
  check("opening another file clears old SVG maps and viewport anchor", await page.evaluate(() =>
    window.__oldStaffSvgs.every(svg => !svg.isConnected) && document.getElementById("staff-pane").scrollTop < 48
    && window.__app.workspaceSummary().page === 1));
  check("browser has no runtime or console errors", errors.length === 0);
  console.log(JSON.stringify({ ok: true, checks: checks.length, details: checks }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, completed: checks, browserErrors: errors, state: await state().catch(() => null) }, null, 2));
  throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
