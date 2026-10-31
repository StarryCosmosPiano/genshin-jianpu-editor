import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

// Current source or an explicit preview URL; never rebuilds shared dist/.
const server = process.env.MOBILE_TEST_URL ? null : await createServer({ server: { host: "127.0.0.1", port: 19200 + Math.floor(Math.random() * 1000), strictPort: false, hmr: false }, clearScreen: false });
if (server) await server.listen();
const url = process.env.MOBILE_TEST_URL || server.resolvedUrls.local[0];
const browser = await chromium.launch(process.env.BROWSER_EXECUTABLE_PATH
  ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH, headless: true } : { channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const output = process.env.MOBILE_TEST_OUTPUT || resolve("artifacts/mobile-workspace-20261018/ui");
await mkdir(output, { recursive: true });
const touch = await context.newCDPSession(page);
const touchEvent = (type, points) => touch.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((point, index) => ({ ...point, id: point.id ?? index + 1 })) });
const waitMode = mode => page.waitForFunction(mode => window.__app?.getScoreEditorState().mode === mode, mode);
const state = () => page.evaluate(() => ({ ...window.__app.getScoreEditorState(), text: window.__app.getText(),
  selected: window.__app._selectedNotes.map(item => ({ part: item.source.partIndex, pitch: item.source.note.pitch,
    measure: item.source.measureIndex, offset: item.source.chord.position.toString() })) }));
const fixture = ".Title\nTitle = {触屏编辑检查}\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 | 5 6 7 1' | 2' 3' 4' 5' | 6' 7' 1'' 2'' |]";
async function setFixture() {
  await page.evaluate(text => {
    const app = window.__app;
    app.documentFormat = "jpw"; app.slashOptions = null; app.setCodePaneCollapsed(true); app.setText(text);
    app.resetDocumentUndo();
    app._player = { state: "stopped", stop() {}, stopAudition() {}, async audition() {}, async play() {} };
  }, fixture);
  await page.waitForFunction(() => window.__app.getScoreEditorState().ready && document.querySelector("#score-pane svg"));
  await page.waitForTimeout(120);
}
async function notePoint(index = 0, staff = false) {
  return page.evaluate(({ index, staff }) => {
    const app = window.__app, source = app._sourceNotes[index];
    const element = staff ? [...document.querySelectorAll("#staff-pages [data-staff-ref]")].find(element =>
      app.getStaffPreviewSnapshot().registry.resolve({ revision: app._staffRevision, id: element.dataset.staffRef })?.note === source.note)
      : app.painter.noteGroupEls(source.chord, source.note).find(item => item.element.isConnected)?.element;
    const rect = element?.getBoundingClientRect();
    if (!rect) throw new Error("Missing visible note geometry");
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  }, { index, staff });
}
async function tapNote(index = 0, staff = false) {
  const point = await notePoint(index, staff);
  await page.touchscreen.tap(point.x, point.y);
  await page.waitForTimeout(80);
  if (await page.locator(".mobile-candidate-list").count()) await page.locator(".mobile-candidate-list button").first().tap();
  await page.waitForTimeout(80);
}
async function assertShell(width, height, expectedMode) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(140);
  const shell = await page.evaluate(() => {
    const app = document.getElementById("app"), score = document.getElementById("score-surfaces");
    const visible = selector => [...document.querySelectorAll(selector)].filter(node => node.getBoundingClientRect().height && !node.closest("[hidden]"));
    return { mode: document.documentElement.dataset.workspaceMode, dock: document.documentElement.dataset.mobileDock,
      overflow: app.scrollWidth > app.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1,
      score: { width: score.clientWidth, height: score.clientHeight },
      targets: visible("#mobile-workspace-bar > button, [data-mobile-mode], .mobile-degree-key").map(node => ({ label: node.getAttribute("aria-label"), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })) };
  });
  assert.equal(shell.mode, expectedMode, `${width}×${height} mode`);
  assert.equal(shell.overflow, false, `${width}×${height} horizontal overflow`);
  assert(shell.score.width > 200 && shell.score.height > 150, `${width}×${height} score remains usable: ${JSON.stringify(shell)}`);
  for (const target of shell.targets) assert(target.width >= 43.5 && target.height >= 43.5,
    `${width}×${height} target smaller than 44px: ${JSON.stringify(target)}`);
  return shell;
}
async function assertTargetVisible(surface) {
  await page.waitForFunction(surface => {
    const app = window.__app;
    const pane = document.getElementById(surface === "staff" ? "staff-pane" : "score-pane");
    const viewport = pane.getBoundingClientRect();
    const targets = [...pane.querySelectorAll(surface === "staff" ? '[data-staff-input-overlay="cursor"]'
      : ".score-input-cursor .score-input-triangle,.score-input-cursor .score-input-note-placeholder")];
    if (surface === "jianpu") {
      const focus = app.inputFocus();
      const note = focus && app.painter.noteGroupEl(focus.chord, focus.note);
      if (note?.isConnected) targets.push(note);
    }
    return targets.length > 0 && targets.every(node => {
      const rect = node.getBoundingClientRect();
      return rect.top >= viewport.top - .5 && rect.bottom <= viewport.bottom + .5
        && rect.left >= viewport.left - .5 && rect.right <= viewport.right + .5;
    });
  }, surface);
}
try {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__app?.executeScoreCommand && document.getElementById("mobile-workspace-bar"));
  assert.equal(await page.locator("#code-workspace").isVisible(), false, "fresh phone starts on the score, not a full-screen text pane");
  assert.equal(await page.locator("#score-pane").isVisible(), true);
  await setFixture();
  await assertShell(390, 844, "phone");
  await page.locator('[data-mobile-mode="input"]').tap(); await waitMode("input");
  await tapNote(0);
  const beforeInput = await state();
  await page.locator('[data-mobile-degree="5"]').tap();
  await page.waitForFunction(text => window.__app.getText() !== text, beforeInput.text);
  const typed = await state();
  assert.equal(typed.selected[0]?.pitch ?? 67, 67, "touch number command writes requested degree");
  await page.locator("#mobile-undo").tap();
  await page.waitForFunction(text => window.__app.getText() === text, beforeInput.text);
  await page.locator("#mobile-redo").tap();
  await page.waitForFunction(text => window.__app.getText() === text, typed.text);
  await page.locator("#mobile-keyboard-switch").tap();
  await page.getByRole("button", { name: "原琴21键 QWERTYU / ASDFGHJ / ZXCVBNM", exact: true }).tap();
  assert.equal(await page.locator(".mobile-lyre-key").count(), 21);
  await page.locator('[data-lyre-key="Q"]').tap();
  await page.waitForFunction(() => window.__app.getScoreEditorState().cursor?.midi === 72);
  await page.locator("#mobile-undo").tap(); await page.waitForFunction(text => window.__app.getText() === text, typed.text);
  await page.locator("#mobile-keyboard-switch").tap();
  await page.getByRole("button", { name: "音名 C–B", exact: true }).tap();
  await page.selectOption("#mobile-octave", "0");
  await page.locator('[data-input-letter="E"]').tap();
  await page.waitForFunction(() => window.__app.getScoreEditorState().cursor?.midi === 64);
  await page.locator("#mobile-undo").tap(); await page.waitForFunction(text => window.__app.getText() === text, typed.text);
  await page.locator("#mobile-keyboard-switch").tap();
  await page.getByRole("button", { name: "数字简谱 1–7", exact: true }).tap();
  await tapNote(0);

  const scoreBox = await page.locator("#score-pane").boundingBox();
  const center = { x: scoreBox.x + scoreBox.width / 2, y: scoreBox.y + Math.min(180, scoreBox.height / 2) };
  const beforePinch = await state();
  const geometryBefore = await page.evaluate(() => ({ width: document.querySelector("#score-pane .score-page-wrap").getBoundingClientRect().width,
    zoom: window.__app.zoom, page: [window.__app.painter.pageWidth, window.__app.painter.pageHeight] }));
  await touchEvent("touchStart", [{ x: center.x - 35, y: center.y }, { x: center.x + 35, y: center.y }]);
  await touchEvent("touchMove", [{ x: center.x - 70, y: center.y }, { x: center.x + 70, y: center.y }]);
  await page.waitForTimeout(60);
  await touchEvent("touchEnd", []);
  await page.waitForTimeout(100);
  const geometryAfter = await page.evaluate(() => ({ width: document.querySelector("#score-pane .score-page-wrap").getBoundingClientRect().width,
    zoom: window.__app.zoom, page: [window.__app.painter.pageWidth, window.__app.painter.pageHeight] }));
  assert(geometryAfter.width > geometryBefore.width * 1.8, "mobile page can grow beyond viewport width");
  assert(geometryAfter.zoom > geometryBefore.zoom * 1.8, "pinch changes application zoom");
  assert.deepEqual(geometryAfter.page, geometryBefore.page, "pinch preserves paper dimensions");
  assert.equal((await state()).text, beforePinch.text, "pinch cannot insert or edit notes");
  assert.deepEqual((await state()).selected, beforePinch.selected, "pinch cannot select an accidental note");
  const scrollBefore = await page.locator("#score-pane").evaluate(node => node.scrollTop);
  await touchEvent("touchStart", [{ x: center.x, y: center.y }]);
  await touchEvent("touchMove", [{ x: center.x, y: center.y - 70 }]);
  await touchEvent("touchEnd", []);
  await page.waitForTimeout(120);
  assert(await page.locator("#score-pane").evaluate(node => node.scrollTop) > scrollBefore, "single-finger drag pans score");
  assert.equal((await state()).text, beforePinch.text, "pan cannot insert notes");
  await page.evaluate(() => { window.__app.resetZoom(); window.__app.scorePane.scrollTop = 0; window.__app.scorePane.scrollLeft = 0; });
  await page.waitForTimeout(140);

  await page.locator('[data-mobile-mode="select"]').tap(); await waitMode("select");
  await page.getByRole("button", { name: "清除选区", exact: true }).tap();
  await page.locator('[data-selection-tool="multiple"]').tap();
  await tapNote(0); await tapNote(2);
  assert((await state()).selection.noteCount >= 2, "touch multi-select does not need Ctrl");
  await page.locator('[data-selection-tool="single"]').tap();
  await tapNote(0);
  await page.locator('[data-selection-tool="range"]').tap();
  await tapNote(3);
  assert((await state()).selection.noteCount >= 4, "touch range selection does not need Shift");
  await page.locator('[data-selection-tool="marquee"]').tap();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const marqueePoint = await notePoint(1);
  const beforeMarqueeCancel = await state();
  await touchEvent("touchStart", [{ x: marqueePoint.left - 8, y: marqueePoint.top - 8 }]);
  await touchEvent("touchMove", [{ x: marqueePoint.right + 5, y: marqueePoint.bottom + 5 }]);
  await page.locator(".touch-score-marquee").waitFor({ state: "visible" });
  assert.equal(await page.locator(".touch-score-marquee").count(), 1);
  await touchEvent("touchStart", [{ x: marqueePoint.right + 5, y: marqueePoint.bottom + 5 }, { x: marqueePoint.right + 55, y: marqueePoint.bottom + 5 }]);
  await touchEvent("touchEnd", []);
  assert.deepEqual((await state()).selected, beforeMarqueeCancel.selected, "second touch cancels marquee without committing a new selection");
  await page.locator('[data-selection-tool="single"]').tap();
  await tapNote(1);
  const hold = await notePoint(1), textBeforeHold = (await state()).text;
  await touchEvent("touchStart", [{ x: hold.x, y: hold.y }]);
  await page.waitForTimeout(550);
  await touchEvent("touchEnd", []);
  if (await page.locator(".mobile-candidate-list").count()) await page.locator(".mobile-candidate-list button").first().tap();
  await page.waitForTimeout(80);
  assert.equal(await page.locator("#mobile-tab-edit").getAttribute("aria-selected"), "true", "long press opens editing actions");
  assert.equal((await state()).text, textBeforeHold, "long press alone cannot alter score");
  await page.locator('[data-mobile-mode="input"]').tap(); await waitMode("input");
  const preserved = await state();
  await assertShell(320, 700, "phone");
  await assertShell(768, 1024, "tablet");
  assert.equal((await state()).text, preserved.text, "workspace resizing preserves document");
  assert.equal((await state()).mode, "input", "workspace resizing preserves interaction mode");
  const narrowCompare = await page.locator('#mobile-surface-select option[value="compare"]').isDisabled();
  assert.equal(narrowCompare, true, "768px cannot squeeze two 420px scores");
  await assertShell(1024, 900, "tablet");
  await page.selectOption("#mobile-surface-select", "compare");
  await page.waitForFunction(() => document.querySelector("#staff-pages [data-staff-ref]"));
  const sizes = await page.evaluate(() => [document.getElementById("score-pane").clientWidth, document.getElementById("staff-pane").clientWidth]);
  assert(sizes.every(size => size >= 420), `both compare panes remain at least 420px: ${sizes}`);
  assert.equal((await state()).mode, "view", "compare is preview-only");
  assert.equal(await page.locator("#mobile-command-dock").isVisible(), false, "compare hides editing tools");
  await page.selectOption("#mobile-surface-select", "staff");
  await page.locator('[data-mobile-mode="input"]').tap(); await waitMode("input");
  const textBeforeStaffTap = (await state()).text;
  await tapNote(0, true);
  assert.equal((await state()).text, textBeforeStaffTap, "staff touch only selects/positions; it cannot insert directly");
  assert.equal(await page.locator(".mobile-number-keyboard").isVisible(), false, "staff has no numeric touch keyboard");
  assert.equal(await page.locator(".mobile-letter-keyboard").isVisible(), true, "staff uses its own named pitch keyboard");
  const penPoint = await notePoint(1, true);
  await touch.send("Input.dispatchMouseEvent", { type: "mousePressed", x: penPoint.x, y: penPoint.y, button: "left", buttons: 1, clickCount: 1, pointerType: "pen" });
  await touch.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: penPoint.x, y: penPoint.y, button: "left", buttons: 0, clickCount: 1, pointerType: "pen" });
  await page.waitForTimeout(100);
  assert.equal((await state()).text, textBeforeStaffTap, "pen contact also only selects/positions in touch workspace");
  await page.selectOption("#mobile-surface-select", "jianpu");
  const landscape = await assertShell(844, 390, "tablet");
  assert.equal(landscape.dock, "right", "short landscape docks tools at the side");
  await page.screenshot({ path: join(output, "landscape.png") });
  const split = await assertShell(500, 400, "phone");
  assert.equal(split.dock, "bottom", "narrow split view preserves the score width");
  assert.equal(await page.locator("#mobile-dock-fold").getAttribute("aria-expanded"), "false", "narrow short split view begins with tools folded");
  await assertShell(390, 844, "phone");
  assert.equal(await page.locator("#mobile-dock-fold").getAttribute("aria-expanded"), "true", "leaving compact split view restores tool expansion");
  await page.screenshot({ path: join(output, "phone.png") });

  // Exercise the real navigation and zoom controls with a far-away music
  // position. Neither rotation nor a view change may rewrite or reflow paper.
  const beforeTargetCheckText = (await state()).text;
  const longScore = ".Title\nTitle = {长谱输入位置检查}\nKeyAndMeters = {1=C,4/4}\n.Voice\n"
    + Array(120).fill("1 2 3 4 |").join("\n") + "]\n";
  await page.evaluate(text => window.__app.setText(text), longScore);
  await page.waitForFunction(() => window.__app.getScoreEditorState().ready && window.__app._sourceNotes.length >= 480);
  await page.getByRole("button", { name: "跳到声部、小节或首尾", exact: true }).tap();
  await page.getByLabel("跳转小节号", { exact: true }).fill("48");
  await page.getByRole("button", { name: "定位到指定小节", exact: true }).tap();
  await page.waitForFunction(() => window.__app.getScoreEditorState().cursor?.measureIndex === 47);
  for (const offset of ["1", "2", "3"]) {
    await page.getByRole("button", { name: "向后移动光标", exact: true }).tap();
    await page.waitForFunction(offset => window.__app.getScoreEditorState().cursor?.offset === offset, offset);
  }
  const targetBefore = await state();
  const paperBefore = await page.evaluate(() => [window.__app.painter.pageWidth, window.__app.painter.pageHeight]);
  await assertTargetVisible("jianpu");
  await assertShell(844, 390, "tablet");
  await assertTargetVisible("jianpu");
  await assertShell(390, 844, "phone");
  await page.locator("#mobile-view-tools").tap();
  for (let index = 0; index < 4; index++) await page.getByRole("button", { name: "放大谱面", exact: true }).tap();
  await page.getByRole("button", { name: "关闭面板", exact: true }).tap();
  await assertTargetVisible("jianpu");
  assert.deepEqual((await state()).cursor, targetBefore.cursor, "rotation and explicit zoom preserve the music cursor");
  assert.equal((await state()).text, targetBefore.text, "rotation and explicit zoom preserve score contents");
  assert.deepEqual(await page.evaluate(() => [window.__app.painter.pageWidth, window.__app.painter.pageHeight]), paperBefore,
    "viewport controls preserve full-page paper dimensions");
  await page.selectOption("#mobile-surface-select", "staff");
  await page.waitForFunction(() => document.querySelector('#staff-pages [data-staff-input-overlay="cursor"]'));
  await page.getByRole("button", { name: "准备下方和弦音", exact: true }).tap();
  await page.waitForFunction(() => window.__app.getScoreEditorState().chordSide === "below");
  await assertShell(844, 390, "tablet");
  await assertTargetVisible("staff");
  await assertShell(390, 844, "phone");
  await page.locator("#mobile-view-tools").tap();
  for (let index = 0; index < 4; index++) await page.getByRole("button", { name: "放大谱面", exact: true }).tap();
  await page.getByRole("button", { name: "关闭面板", exact: true }).tap();
  await assertTargetVisible("staff");
  assert.equal((await state()).text, targetBefore.text, "pending staff chord and view changes never write a note");
  await page.selectOption("#mobile-surface-select", "jianpu");
  await page.evaluate(text => { const app = window.__app; app.setText(text); app.resetZoom(); }, beforeTargetCheckText);
  await page.waitForFunction(() => window.__app.getScoreEditorState().ready && window.__app._sourceNotes.length === 16);

  await page.locator("#mobile-more").tap();
  await page.getByRole("button", { name: "切换文本谱", exact: true }).tap();
  const beforeKeyboardText = (await state()).text;
  await page.evaluate(() => {
    const app = window.__app;
    app.setText(".Title\nTitle = {文本光标检查}\nKeyAndMeters = {1=C,4/4}\n.Voice\n" + Array(120).fill("1 2 3 4 |").join("\n") + "]");
    app.view.dispatch({ selection: { anchor: app.view.state.doc.length }, scrollIntoView: true });
  });
  await page.locator("#code-pane .cm-content").focus();
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 410 });
    window.visualViewport.dispatchEvent(new Event("resize"));
  });
  await page.waitForTimeout(100);
  const keyboard = await page.evaluate(() => ({ shown: document.documentElement.dataset.mobileKeyboard,
    height: document.getElementById("app").getBoundingClientRect().height, text: document.getElementById("code-workspace").getBoundingClientRect().bottom }));
  assert.equal(keyboard.shown, "true"); assert(keyboard.height <= 411 && keyboard.text <= 411, "visible viewport bounds text editor above keyboard");
  await page.waitForFunction(() => {
    const app = window.__app, caret = app.view.coordsAtPos(app.view.state.selection.main.head), pane = document.getElementById("code-pane").getBoundingClientRect();
    return caret && caret.top >= pane.top && caret.bottom <= pane.bottom;
  });
  await page.locator("#mobile-close-text").tap();
  await page.evaluate(() => { delete window.visualViewport.height; window.visualViewport.dispatchEvent(new Event("resize")); });
  await page.evaluate(text => window.__app.setText(text), beforeKeyboardText);
  await page.waitForFunction(() => window.__app.getScoreEditorState().ready);
  await page.waitForTimeout(100);
  for (const theme of ["dark", "light"]) {
    await page.locator("#mobile-more").tap();
    assert.equal(await page.locator("#app").evaluate(node => node.inert), true, "modal menu makes the score inert");
    const beforeMenuKey = (await state()).text;
    await page.keyboard.press("1");
    assert.equal((await state()).text, beforeMenuKey, "modal keyboard cannot edit the hidden score");
    await page.getByRole("button", { name: "应用设置", exact: true }).tap();
    await page.locator(".options-box .modal-row").filter({ has: page.locator("span", { hasText: /^外观$/ }) }).locator("select").selectOption(theme);
    await page.locator(".options-box .modal-footer").getByRole("button", { name: "确定", exact: true }).tap();
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    const appearance = await page.evaluate(() => ({ paper: getComputedStyle(document.querySelector("#score-pane .score-page-wrap")).backgroundColor,
      background: getComputedStyle(document.getElementById("mobile-command-dock")).backgroundColor,
      text: getComputedStyle(document.querySelector(".mobile-degree-key")).color,
      overflow: document.documentElement.scrollWidth > innerWidth + 1 }));
    assert.equal(appearance.paper, "rgb(255, 255, 255)", `${theme}: paper stays white`);
    assert.equal(appearance.overflow, false, `${theme}: mobile workspace stays within viewport`);
    assert.notEqual(appearance.background, appearance.text, `${theme}: touch buttons have distinct ink/background`);
    await page.locator("#mobile-more").tap();
    await page.getByRole("button", { name: "排版设置", exact: true }).tap();
    const form = await page.locator("#inspector-pane").evaluate(node => ({ rect: node.getBoundingClientRect().toJSON(),
      background: getComputedStyle(node).backgroundColor, text: getComputedStyle(node).color,
      footer: node.querySelector(".inspector-footer").getBoundingClientRect().toJSON() }));
    assert(form.rect.left >= 0 && form.rect.right <= 391 && form.footer.bottom <= 845, `${theme}: floating form fits touch viewport`);
    assert.notEqual(form.background, form.text, `${theme}: floating form text remains visible`);
    await page.locator("#inspector-pane .inspector-footer").getByRole("button", { name: "取消", exact: true }).tap();
  }
  await page.screenshot({ path: join(output, "phone-light.png") });
  await page.locator("#mobile-more").tap();
  await page.locator('.mobile-sheet select[aria-label="工作区模式"]').selectOption("desktop");
  await page.waitForFunction(() => document.documentElement.dataset.workspaceMode === "desktop");
  assert.equal(await page.locator("#toolbar").isVisible(), true, "explicit desktop mode restores original toolbar");
  assert.equal((await state()).text, textBeforeStaffTap, "switching presentation cannot change score");
  assert.deepEqual(errors, [], "no uncaught browser errors");
  console.log(`Mobile workspace: touch editing, viewport matrix, pan/pinch arbitration, selection, staff, keyboard and desktop restore OK. Screenshots: ${output}`);
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png") }).catch(() => undefined);
  console.error("Failure context:", await page.evaluate(() => ({ dataset: { ...document.documentElement.dataset },
    state: window.__app?.getScoreEditorState(), inert: document.getElementById("app")?.inert,
    layers: [...document.body.children].map(node => ({ tag: node.tagName, class: node.className, display: getComputedStyle(node).display })),
    html: document.getElementById("mobile-command-dock")?.outerHTML.slice(0, 1800) })).catch(() => null));
  console.error("Screenshot:", join(output, "failure.png"));
  throw error;
} finally { await context.close(); await browser.close(); if (server) await server.close(); }
