// Production Edge integration: real toolbar/commands with an injected Web MIDI device.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = process.env.APP_TEST_URL ? null : createServer(async (request, response) => {
  try {
    const name = normalize(decodeURIComponent((request.url ?? "/").split("?")[0]));
    const data = await readFile(join(process.cwd(), "dist", name === "/" || name === "\\" ? "index.html" : name));
    response.writeHead(200, { "content-type": mime[extname(name)] ?? "text/html" }); response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
if (server) await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = process.env.APP_TEST_URL ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1660, height: 1050 } });
const failures = [], checks = [];
page.on("pageerror", error => failures.push(error.message));
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
await page.addInitScript(() => {
  localStorage.setItem("jpeditor:workspace-mode:v1", "desktop");
  const access = new EventTarget(), port = new EventTarget();
  Object.assign(port, { id: "test-keyboard", name: "测试 MIDI 键盘", manufacturer: "Regression", type: "input", state: "connected", connection: "closed",
    opens: 0, closes: 0, failOpen: false, failClose: false,
    async open() { this.opens++; if (this.failOpen) { this.failOpen = false; throw new Error("模拟设备正被占用"); } this.connection = "open"; return this; },
    async close() { this.closes++; if (this.failClose) { this.failClose = false; throw new Error("模拟驱动暂时无法关闭"); } this.connection = "closed"; return this; } });
  access.inputs = new Map([[port.id, port]]);
  const test = { access, port, requests: [], messages: [], blurOnPermission: true,
    send(data, timestamp) { const event = new Event("midimessage"); Object.defineProperty(event, "data", { value: Uint8Array.from(data) }); if (timestamp !== undefined) Object.defineProperty(event, "timeStamp", { value: timestamp }); test.messages.push({ data, timestamp: event.timeStamp }); port.dispatchEvent(event); },
    plug(connected) { port.state = connected ? "connected" : "disconnected"; access.dispatchEvent(new Event("statechange")); } };
  window.__testMidi = test;
  Object.defineProperty(navigator, "requestMIDIAccess", { configurable: true,
    value: async options => {
      test.requests.push(options);
      // Some embedded browser permission windows report blur without a matching
      // window-focus event. Returning to the actual dialog must restore input.
      if (test.blurOnPermission) window.dispatchEvent(new Event("blur"));
      return access;
    } });
});
const chordAt = (state, at) => state.notes.find(chord => chord.at === at && !chord.rest);
async function state() {
  await page.waitForFunction(() => window.__app && window.__app.debounceTimer === undefined);
  return page.evaluate(() => {
    const app = window.__app, cursor = app._input.cursor;
    return { notes: app.painter.score.parts[0].measures[0].entries.filter(entry => entry.notes).map(chord => ({
      at: chord.position.toString(), duration: chord.duration?.toString(), rest: chord.rest,
      pitches: chord.notes.filter(note => !note.rest).map(note => note.pitch).sort((a, b) => a - b),
    })), cursor: cursor && { measure: cursor.measureIndex, at: cursor.offset.toString() },
    text: app.getText(), status: document.getElementById("status").textContent };
  });
}
async function seed(voice = "0 0 0 0 |]", format = "jpw", prepareInput = true) {
  await page.evaluate(async ({ voice, format, prepareInput }) => {
    const app = window.__app;
    app.setInputMode(false); app.setChordInputMode(false);
    app.documentFormat = "jpw"; app.slashOptions = null;
    app.setText(`.Title\nTitle = MIDI 和弦打谱\nKeyAndMeters = {1=C,4/4}\n.Voice\n${voice}\n`);
    if (format !== "jpw") await app.changeDocumentFormat(format);
    app.setCodePaneCollapsed(true); app.setRhythmEditDivision(16); app.setInputDurationDivision(8);
    app.resetDocumentUndo();
    if (prepareInput) {
      app.setInputMode(true);
      app.setScoreInputPosition({ partIndex: 0, measureIndex: 0, offset: "0", midi: 60 });
    } else app.setInteractionMode("view");
    app.scorePane.focus();
  }, { voice, format, prepareInput });
}
async function gesture(pitches, spacing = 0) {
  await page.evaluate(async ({ pitches, spacing }) => {
    // Device timestamps remain exact when browser work delays event dispatch.
    // Send one captured hardware packet batch rather than using renderer timers
    // as a substitute for MIDI timing (busy layout can delay a 25ms timer).
    const start = performance.now();
    for (let index = 0; index < pitches.length; index++) {
      window.__testMidi.send([0x90, pitches[index], 96], start + index * spacing);
      window.__testMidi.send([0x80, pitches[index], 0], start + index * spacing + 1);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }, { pitches, spacing });
}
async function selectMembers(at, pitches) {
  await page.evaluate(async ({ at, pitches }) => {
    const app = window.__app, registry = app.getStaffPreviewSnapshot().registry;
    const chord = app.painter.score.parts[0].measures[0].entries.find(entry => entry.notes && entry.position.toString() === at);
    const refs = chord.notes.filter(note => pitches.includes(note.pitch)).map(note => registry.refFor(note));
    await app.executeScoreCommand({ type: "select-notes", refs }); app.scorePane.focus();
  }, { at, pitches });
}
try {
  await page.goto(origin);
  await page.waitForFunction(() => window.__app?.painter.score);
  await seed("0 0 0 0 |]", "jpw", !!process.env.MIDI_TEST_START_ACTIVE);
  if (!process.env.MIDI_TEST_START_ACTIVE) {
    check("connection fixture starts from view without a cursor", await page.evaluate(() =>
      !window.__app.inputModeEnabled && window.__app._input.cursor === null));
  }
  await page.getByRole("button", { name: "连接 MIDI 输入设备", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "MIDI 输入设备", exact: true });
  await dialog.waitFor();
  check("only ordinary MIDI permission is requested", await page.evaluate(() => window.__testMidi.requests.every(options => options.sysex === false)));
  await dialog.locator('[name="device"]').click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "应用", exact: true }).click();
  await page.waitForFunction(() => window.__app.getMidiInputState()?.status === "connected");
  check("connecting from view prepares input and its initial cursor", await page.evaluate(() =>
    window.__app.inputModeEnabled && window.__app._input.cursor && window.__app.getMidiInputState().enabled));
  check("connected toolbar switches to MIDI entry", (await page.locator("#btn-input-mode").textContent()).includes("MIDI 打谱"));
  await gesture([60, 64], 25);
  let current = await state();
  check("near simultaneous staccato keys form one chord", JSON.stringify(chordAt(current, "0")?.pitches) === "[60,64]");
  check("MIDI chord uses selected eighth duration and advances once", chordAt(current, "0").duration === "1/2" && current.cursor.at === "1/2");
  await gesture([67]); current = await state();
  check("single key writes a single next note", JSON.stringify(chordAt(current, "1/2")?.pitches) === "[67]" && current.cursor.at === "1");
  await page.keyboard.press("Control+z"); current = await state();
  check("one MIDI gesture is one undo with cursor restoration", !chordAt(current, "1/2") && current.cursor.at === "1/2");
  await page.keyboard.press("Control+Shift+z"); current = await state();
  check("redo restores MIDI note and advanced cursor", chordAt(current, "1/2")?.pitches[0] === 67 && current.cursor.at === "1");
  await page.evaluate(() => { window.__app.setScoreInputPosition({ partIndex: 0, measureIndex: 0, offset: "0", midi: 60 }); window.__app.setInputDurationDivision(16); window.__app.scorePane.focus(); });
  await gesture([62]); current = await state();
  check("normal MIDI replaces occupied chord and retains its duration", JSON.stringify(chordAt(current, "0")?.pitches) === "[62]" && chordAt(current, "0").duration === "1/2" && current.cursor.at === "1/2");
  check("replacement preserves the following attack", chordAt(current, "1/2")?.pitches[0] === 67);
  await page.getByRole("button", { name: "和弦模式", exact: true }).click();
  await page.evaluate(() => { window.__app.setScoreInputPosition({ partIndex: 0, measureIndex: 0, offset: "0", midi: 62 }); window.__app.scorePane.focus(); });
  await gesture([69, 72], 20); current = await state();
  check("MIDI chord mode adds pitches and stays at the existing duration", JSON.stringify(chordAt(current, "0")?.pitches) === "[62,69,72]" && chordAt(current, "0").duration === "1/2" && current.cursor.at === "0");
  await page.evaluate(async () => {
    const app = window.__app, registry = app.getStaffPreviewSnapshot().registry;
    const refs = app.painter.score.parts[0].measures[0].entries.filter(chord => chord.notes && !chord.rest)
      .map(chord => registry.refFor(chord.notes[0]));
    await app.executeScoreCommand({ type: "select-notes", refs }); app.scorePane.focus();
  });
  await gesture([75]); current = await state();
  check("MIDI chord mode adds at every selected position", chordAt(current, "0").pitches.includes(75)
    && chordAt(current, "1/2").pitches.includes(75) && current.cursor.at === "1/2");

  await seed();
  const beforeSignalCheck = (await state()).text;
  const noteCountBeforeDialog = await page.evaluate(() => window.__app.getMidiInputState().receivedNoteOns);
  await page.locator("#btn-midi-input").click(); await dialog.waitFor();
  await gesture([74]);
  check("device settings receive real note events while score writing stays paused", (await state()).text === beforeSignalCheck
    && await page.evaluate(count => window.__app.getMidiInputState().receivedNoteOns === count + 1
      && window.__app.getMidiInputState().lastNote === 74 && !window.__app.getMidiInputState().enabled, noteCountBeforeDialog));
  check("device settings show the last received pitch and why writing is paused", (await dialog.textContent()).includes("MIDI 74")
    && (await dialog.textContent()).includes("写入暂停"));
  check("connected and receiving indicators are distinct while modal is open", (await page.locator("#btn-input-mode").textContent()).includes("MIDI 暂停"));
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await gesture([74]);
  check("closing settings resumes real device events without a new window-focus event", chordAt(await state(), "0")?.pitches[0] === 74);

  await seed();
  await page.evaluate(() => {
    const hidden = document.createElement("div"); hidden.id = "hidden-midi-regression-dialog";
    hidden.className = "modal-overlay"; hidden.setAttribute("role", "dialog"); hidden.setAttribute("aria-modal", "true");
    hidden.hidden = true; document.body.append(hidden);
  });
  await gesture([62]);
  check("an unshown modal element does not silently disable device input", chordAt(await state(), "0")?.pitches[0] === 62);
  await page.evaluate(() => document.getElementById("hidden-midi-regression-dialog").remove());

  await seed();
  await page.evaluate(() => {
    const textInput = document.createElement("input"); textInput.id = "midi-regression-text-input";
    document.body.append(textInput); textInput.focus();
  });
  await gesture([65]);
  check("text field focus pauses note entry without hiding incoming hardware activity", !(await state()).notes.some(chord => !chord.rest)
    && await page.evaluate(() => window.__app.getMidiInputState().lastNote === 65));
  await page.evaluate(() => { document.getElementById("midi-regression-text-input").remove(); window.__app.scorePane.focus(); });
  await gesture([65]);
  check("returning from a text field resumes the selected score cursor", chordAt(await state(), "0")?.pitches[0] === 65);

  await seed();
  await page.evaluate(async () => {
    window.__testMidi.send([0x90, 65, 90]); window.__testMidi.send([0x80, 65, 0]);
    window.dispatchEvent(new Event("blur"));
    await new Promise(resolve => setTimeout(resolve, 90));
  });
  check("window blur cancels the partly collected attack even before focus state settles", !(await state()).notes.some(chord => !chord.rest));
  await page.evaluate(() => Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false }));
  await gesture([67]);
  check("incoming signal while the document is unfocused is observed without score edits", !(await state()).notes.some(chord => !chord.rest)
    && await page.evaluate(() => window.__app.getMidiInputState().lastNote === 67 && !window.__app.getMidiInputState().enabled));
  await page.evaluate(() => { delete document.hasFocus; });
  await gesture([69]);
  check("device events recover from a stale blur latch when the document is focused again", chordAt(await state(), "0")?.pitches[0] === 69);

  await seed("1 0 0 0 |]");
  await page.selectOption("#staff-view-select", "staff");
  const staffReady = () => page.waitForFunction(() => window.__app.isStaffPreviewCurrent()
    && document.getElementById("staff-pane").getAttribute("aria-busy") === "false"
    && document.querySelector("#staff-pages [data-staff-ref]"));
  await staffReady();
  await page.locator("#staff-pages [data-staff-ref]").first().click();
  await gesture([62, 65], 20); await staffReady(); current = await state();
  check("real MIDI events edit the active staff surface and advance by the retained duration",
    JSON.stringify(chordAt(current, "0")?.pitches) === "[62,65]" && current.cursor.at === "1"
    && await page.evaluate(() => window.__app.getActiveScoreSurface() === "staff" && document.activeElement?.id === "staff-pane"));
  await gesture([67]); await staffReady(); current = await state();
  check("staff MIDI entry continues at the advanced cursor", chordAt(current, "1")?.pitches[0] === 67 && current.cursor.at === "3/2");
  await page.selectOption("#staff-view-select", "jianpu");

  for (const format of ["jpw", "keyboard"]) {
    await seed("[1,35'] 2 3 4 |]", format);
    await selectMembers("0", [48]);
    await page.getByRole("button", { name: "和弦模式", exact: true }).click();
    await page.keyboard.press("2"); await page.keyboard.press("4"); current = await state();
    check(`${format}: clicked low member keeps its octave for repeated chord entry`, JSON.stringify(chordAt(current, "0")?.pitches) === "[48,50,53,64,79]");
    check(`${format}: added members keep the existing chord duration`, chordAt(current, "0").duration === "1");
    await seed("[1,35'] 2 3 4 |]", format);
    await selectMembers("0", [48, 64, 79]);
    await page.getByRole("button", { name: "和弦模式", exact: true }).click();
    await page.keyboard.press("2"); await page.keyboard.press("4"); current = await state();
    check(`${format}: whole-chord selection repeatedly uses highest octave`, JSON.stringify(chordAt(current, "0")?.pitches) === "[48,64,74,77,79]");
  }
  await seed("0__ 3__ 0_ 0 0 0 |]");
  await gesture([60]); current = await state();
  check("MIDI entry clips to the next attack and advances by actual duration", chordAt(current, "0")?.duration === "1/4" && current.cursor.at === "1/4" && chordAt(current, "1/4")?.pitches[0] === 64);
  await seed("0__ 3__ 0_ 0 0 0 |]");
  await page.evaluate(() => { window.__app.setStaffInputCursor({ partIndex: 0, measureIndex: 0, offset: "0", midi: 60, step: "C", octave: 4 }); window.__app.insertStaffInputNote({ partIndex: 0, measureIndex: 0, offset: "0", midi: 60, step: "C", octave: 4 }); });
  current = await state();
  check("staff insertion clips an eighth to the available sixteenth", chordAt(current, "0")?.duration === "1/4" && chordAt(current, "1/4")?.pitches[0] === 64);
  const before = current.text;
  await page.evaluate(() => window.__app.setInteractionMode("select"));
  await gesture([75]);
  check("selection mode does not write incoming MIDI", (await state()).text === before);
  await seed();
  await page.evaluate(async () => { window.__testMidi.send([0x90, 65, 90]); window.__testMidi.send([0x80, 65, 0]);
    window.__app.scorePane.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 90)); });
  check("keyboard navigation cancels a pending MIDI group", !(await state()).notes.some(chord => !chord.rest));
  await seed();
  await page.evaluate(async () => { window.__testMidi.send([0x90, 65, 90]); window.__testMidi.send([0x80, 65, 0]); window.__app.setInteractionMode("view"); await new Promise(resolve => setTimeout(resolve, 90)); });
  check("leaving input mode cancels the pending chord batch", !(await state()).notes.some(chord => !chord.rest));
  await page.evaluate(() => window.__testMidi.plug(false));
  await page.waitForFunction(() => window.__app.getMidiInputState()?.selectedDeviceId === null);
  check("device removal clears connection state", await page.locator("#btn-midi-input").getAttribute("aria-pressed") === "false");
  await page.evaluate(() => { window.__testMidi.port.failOpen = true; window.__testMidi.plug(true); });
  const choose = async value => {
    await page.locator("#btn-midi-input").click(); await dialog.waitFor();
    await dialog.locator('[name="device"]').selectOption(value);
    await dialog.getByRole("button", { name: "应用", exact: true }).click();
  };
  await choose("test-keyboard");
  await page.waitForFunction(() => window.__app.getMidiInputState()?.status === "error");
  await choose("test-keyboard");
  await page.waitForFunction(() => window.__app.getMidiInputState()?.status === "connected");
  check("a failed connection can be retried from the device dialog", await page.evaluate(() => window.__testMidi.port.connection === "open"));
  await page.evaluate(() => { window.__testMidi.port.failClose = true; });
  await choose("");
  await page.waitForFunction(() => window.__app.getMidiInputState()?.status === "error");
  const closes = await page.evaluate(() => window.__testMidi.port.closes);
  await choose("");
  await page.waitForFunction(() => window.__app.getMidiInputState()?.status === "ready");
  check("failed disconnect retains ownership for an actual retry", await page.evaluate(count =>
    window.__testMidi.port.closes === count + 1 && window.__testMidi.port.connection === "closed", closes));
  check("no browser runtime errors", failures.length === 0);
  await mkdir("artifacts/midi-entry-20261022", { recursive: true });
  await seed("[1,35'] 2 3 4 |]"); await selectMembers("0", [48, 64, 79]);
  await page.getByRole("button", { name: "和弦模式", exact: true }).click(); await page.keyboard.press("2");
  await page.screenshot({ path: "artifacts/midi-entry-20261022/chord-mode.png" });
  await writeFile("artifacts/midi-entry-20261022/results.json", JSON.stringify({ checks, failures }, null, 2));
  console.log(`MIDI entry browser: ${checks.length} checks passed`);
} catch (error) {
  console.error(await state().catch(() => null));
  console.error(await page.evaluate(() => ({ inputEnabled: window.__app.inputModeEnabled,
    sessionEnabled: window.__app.getMidiInputState()?.enabled, windowActive: window.__app._midiWindowActive,
    documentFocused: document.hasFocus(), activeElement: document.activeElement?.id,
    modalCount: document.querySelectorAll('[role="dialog"][aria-modal="true"], .modal-overlay').length })));
  console.error(await page.evaluate(() => window.__testMidi.messages)); throw error;
} finally { await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
