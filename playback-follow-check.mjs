import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const server = createServer(async (req, res) => {
  try {
    const file = decodeURIComponent(req.url.split("?")[0]) || "/";
    const path = file === "/" ? "/index.html" : file;
    res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm" })[extname(path)] ?? "application/octet-stream");
    res.end(await readFile(join(process.cwd(), "dist", path)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(process.env.CHECK_BASE_URL ?? `http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    const app = window.__app;
    window.__Player = app.player().constructor;
    window.__plays = []; window.__auditions = [];
    app._player = { state: "stopped", stop() { this.state = "stopped"; }, stopAudition() {},
      async audition(notes) { window.__auditions.push(notes); },
      async play(score, options, start, sf2, selection) {
        window.__plays.push({ bounded: !!selection, count: selection?.size ?? 0,
          measure: start?.chord.measure.index, offset: start?.chord.position.toString() });
      } };
    app.documentFormat = "jpw"; app.slashOptions = null;
    app.setText(".Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n[13] 2 3 4 | 5 6 7 1' |]");
    app.resetDocumentUndo(); app.setInteractionMode("select");
  });
  const point = async index => page.evaluate(index => {
    const app = window.__app, source = app._sourceNotes[index];
    const target = app.painter.noteGroupEls(source.chord, source.note)[0].element;
    const box = target.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, index);
  let p = await point(0); await page.mouse.click(p.x, p.y);
  await page.evaluate(() => window.__app.playScore());
  assert.equal((await page.evaluate(() => window.__plays.at(-1))).bounded, false, "ordinary single click retains tail playback");
  p = await point(1); await page.keyboard.down("Control"); await page.mouse.click(p.x, p.y); await page.keyboard.up("Control");
  await page.evaluate(() => window.__app.playScore());
  assert.deepEqual(await page.evaluate(() => window.__plays.at(-1)), { bounded: true, count: 2, measure: 0, offset: "0" });
  assert.equal(await page.evaluate(() => window.__auditions.at(-1).length), 2, "same-onset selection auditions both notes");
  const beforeAudition = await page.evaluate(() => window.__auditions.length);
  p = await point(2); await page.keyboard.down("Control"); await page.mouse.click(p.x, p.y); await page.keyboard.up("Control");
  assert.equal(await page.evaluate(() => window.__auditions.length), beforeAudition, "selection spanning two onsets is silent");

  const sampled = await page.evaluate(async () => {
    const app = window.__app;
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends EventTarget {
      currentTime = 0; state = "running";
      async resume() { this.state = "running"; }
      async close() { this.state = "closed"; }
    };
    const events = [], states = [];
    const player = new window.__Player(() => {}, state => states.push(state));
    player.loadSf2Instruments = async (_ctx, _options, loaded) => {
      const instrument = { start(event) { events.push(event); }, stop() {}, dispose() {} };
      loaded.push(instrument); return [instrument];
    };
    const selected = new Set([app._sourceNotes[0].note, app._sourceNotes[3].note]);
    try {
      await player.play(app.painter.score, undefined, undefined,
        { bytes: new Uint8Array(), instrumentByPart: [] }, selected);
      const duration = player.duration;
      player.ctx.currentTime = player.startCtxTime + duration - 0.001;
      player.tick(); const beforeEnd = player.state;
      player.ctx.currentTime += 0.002;
      player.tick();
      return { count: events.length, offsets: events.map(event => event.time),
        durations: events.map(event => event.duration), duration, beforeEnd, afterEnd: player.state, states };
    } finally { player.stop(); window.AudioContext = NativeContext; }
  });
  assert.equal(sampled.count, 2, "sampler only schedules selected notes");
  assert.ok(sampled.offsets[1] - sampled.offsets[0] > 1, "sampler retains the gap between selections");
  assert.equal(sampled.beforeEnd, "playing"); assert.equal(sampled.afterEnd, "stopped", "automatically stops at final selected note end");

  await page.selectOption("#staff-view-select", "compare");
  await page.waitForFunction(() => document.getElementById("staff-pane").dataset.staffRevision === String(window.__app.getStaffPreviewSnapshot().revision));
  const precise = await page.evaluate(async () => {
    const app = window.__app, savedPlayer = app._player;
    const selectedNote = app._sourceNotes[1].note, siblingNote = app._sourceNotes[0].note;
    const before = app.view.state.selection.toJSON(), NativeContext = window.AudioContext;
    window.AudioContext = class extends EventTarget {
      currentTime = 0; state = "running";
      async resume() { this.state = "running"; }
      async close() { this.state = "closed"; }
    };
    const player = new window.__Player((chords, pass, notes) => app.onPlayChord(chords, pass, notes), state => app.onPlayState(state));
    app._player = player;
    player.loadSf2Instruments = async (_ctx, _options, loaded) => {
      const instrument = { start() {}, stop() {}, dispose() {} };
      loaded.push(instrument); return [instrument];
    };
    const selection = new Set([selectedNote]);
    try {
      await player.play(app.painter.score, undefined, undefined,
        { bytes: new Uint8Array(), instrumentByPart: [] }, selection);
      selection.clear(); selection.add(siblingNote);
      player.tick();
      const registry = app.getStaffPreviewSnapshot().registry;
      const staffPlaying = note => {
        const id = registry.refFor(note).id;
        const hit = document.querySelector(`#staff-pages [data-staff-ref="${id}"]`);
        if (!hit) throw new Error(`Missing staff hit for ${id}`);
        const glyph = hit.parentElement.querySelector(`[data-staff-glyph="${hit.dataset.staffHit}"]`);
        if (!glyph) throw new Error(`Missing staff glyph for ${id}`);
        return glyph.classList.contains("staff-playing");
      };
      const marks = [...document.querySelectorAll(".cm-playback-source")].map(element => element.textContent);
      const result = { marks, selected: !!app.painter.noteGroupEl(selectedNote.chord, selectedNote, 0).closest(".playing"),
        sibling: !!app.painter.noteGroupEl(siblingNote.chord, siblingNote, 0).closest(".playing"),
        staffSelected: staffPlaying(selectedNote), staffSibling: staffPlaying(siblingNote),
        scope: app.getStaffPlaybackState().notes.length, scopeNote: app.getStaffPlaybackState().notes[0] === selectedNote,
        selectedFilter: getComputedStyle(app.painter.noteGroupEl(selectedNote.chord, selectedNote, 0)).filter,
        addedCursors: document.querySelectorAll(".cm-playback-caret,.score-playback-cursor").length,
        before, after: app.view.state.selection.toJSON() };
      player.stop();
      result.stoppedMarks = document.querySelectorAll(".cm-playback-source").length;
      result.stoppedStaff = document.querySelectorAll(".staff-playing").length;
      result.stoppedScore = document.querySelectorAll("#score-pane .playing").length;
      return result;
    } finally { player.stop(); app._player = savedPlayer; window.AudioContext = NativeContext; }
  });
  assert.deepEqual(precise.marks, ["3"], "text highlights only the selected chord tone");
  assert.equal(precise.selected, true); assert.equal(precise.sibling, false, "jianpu excludes the unselected chord tone");
  assert.equal(precise.staffSelected, true); assert.equal(precise.staffSibling, false, "staff excludes the unselected chord tone");
  assert.equal(precise.scope, 1); assert.equal(precise.scopeNote, true, "player captures the selection before caller mutation");
  assert.ok(precise.selectedFilter.includes("drop-shadow"), "selected chord tone retains the original playback glow");
  assert.equal(precise.addedCursors, 0, "playback uses the original highlight without added cursor shapes");
  assert.deepEqual(precise.before, precise.after, "precise playback preserves text editing selection");
  assert.equal(precise.stoppedMarks, 0); assert.equal(precise.stoppedStaff, 0, "stop clears precise playback marks");
  assert.equal(precise.stoppedScore, 0, "stop removes score playback highlight");
  await page.selectOption("#staff-view-select", "jianpu");

  const highlightAt = async index => page.evaluate(async index => {
    const app = window.__app;
    if (!window.__positionPlayer) {
      window.__playbackSelection = app.view.state.selection.toJSON();
      window.__positionSavedPlayer = app._player; window.__positionNativeContext = window.AudioContext;
      window.AudioContext = class extends EventTarget {
        currentTime = 0; state = "running";
        async resume() { this.state = "running"; }
        async close() { this.state = "closed"; }
      };
      const player = new window.__Player((chords, pass, notes) => app.onPlayChord(chords, pass, notes), state => app.onPlayState(state));
      player.loadSf2Instruments = async (_ctx, _options, loaded) => {
        const instrument = { start() {}, stop() {}, dispose() {} };
        loaded.push(instrument); return [instrument];
      };
      window.__positionPlayer = app._player = player;
      const notes = new Set([app._sourceNotes[0].note, app._sourceNotes[1].note, app._sourceNotes[2].note]);
      await player.play(app.painter.score, undefined, undefined, { bytes: new Uint8Array(), instrumentByPart: [] }, notes);
    }
    const player = window.__positionPlayer;
    const anchor = player.anchors.find(anchor => anchor.chords.includes(app._sourceNotes[index].chord));
    player.ctx.currentTime = player.startCtxTime + anchor.t + 0.001; player.tick();
    const current = app.painter.noteGroupEl(app._sourceNotes[index].chord, app._sourceNotes[index].note, 0);
    const markStyle = getComputedStyle(document.querySelector(".cm-playback-source"));
    return { marks: [...document.querySelectorAll(".cm-playback-source")].map(element => element.textContent),
      scoreMarks: document.querySelectorAll("#score-pane .playing").length,
      scoreX: current.getBoundingClientRect().left,
      filter: getComputedStyle(current).filter,
      currentPlaying: current.classList.contains("playing"),
      firstPlaying: app.painter.noteGroupEl(app._sourceNotes[0].chord, app._sourceNotes[0].note, 0).classList.contains("playing"),
      background: markStyle.backgroundColor, underline: markStyle.boxShadow,
      nestedBackgrounds: [...document.querySelectorAll(".cm-playback-source .cm-score-source-selection")]
        .map(element => getComputedStyle(element).backgroundColor),
      selection: app.view.state.selection.toJSON(), before: window.__playbackSelection };
  }, index);
  const firstPosition = await highlightAt(0);
  assert.deepEqual(firstPosition.marks, ["1", "3"]);
  assert.equal(firstPosition.scoreMarks, 2, "both selected chord tones use the original playback highlight");
  assert.equal(firstPosition.background, "rgb(230, 220, 255)", "text playback keeps its original purple highlight over the selected source");
  assert.ok(firstPosition.nestedBackgrounds.every(color => color === firstPosition.background), "nested source-selection backgrounds cannot cover playback highlight");
  assert.ok(firstPosition.underline.includes("rgb(117, 82, 158)"));
  assert.ok(firstPosition.filter.includes("drop-shadow"), "selection cannot hide the original score playback glow");
  if (process.env.PLAYBACK_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.PLAYBACK_SCREENSHOT_DIR, "playback-selection-highlight-1.png") });
  const secondPosition = await highlightAt(2);
  assert.deepEqual(secondPosition.marks, ["2"]);
  assert.equal(secondPosition.scoreMarks, 1); assert.ok(secondPosition.scoreX > firstPosition.scoreX);
  assert.equal(secondPosition.currentPlaying, true); assert.equal(secondPosition.firstPlaying, false, "score highlight advances to the next selected note");
  assert.deepEqual(secondPosition.selection, secondPosition.before, "playback highlight advances without moving the editing selection");
  if (process.env.PLAYBACK_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.PLAYBACK_SCREENSHOT_DIR, "playback-selection-highlight-2.png") });
  await page.locator("#btn-export").click();
  await page.locator(".modal-box button", { hasText: "PNG（全部页面）" }).click();
  await page.locator(".watermark-dialog").waitFor();
  assert.equal(await page.locator(".watermark-preview .playing").count(), 0,
    "static export preview excludes playback highlight");
  assert.equal(await page.locator("#score-pane .playing").count(), 1,
    "preparing export preserves the live playback highlight");
  await page.locator(".watermark-dialog footer").getByRole("button", { name: "取消", exact: true }).click();
  const cleanup = await page.evaluate(() => {
    const app = window.__app, player = window.__positionPlayer;
    player.ctx.currentTime = player.startCtxTime + player.duration + 0.001; player.tick();
    const ended = document.querySelectorAll(".cm-playback-source,#score-pane .playing").length;
    app.onPlayState("playing");
    app.onPlayChord([app._sourceNotes[0].chord], 0, new Set([app._sourceNotes[0].note]));
    const beforeChange = document.querySelectorAll(".cm-playback-source,#score-pane .playing").length;
    app.setText(app.getText() + "\n");
    return { ended, beforeChange, afterChange: document.querySelectorAll(".cm-playback-source,#score-pane .playing").length };
  });
  assert.equal(cleanup.ended, 0, "natural playback end clears playback highlight");
  assert.equal(cleanup.beforeChange, 2); assert.equal(cleanup.afterChange, 0, "document change and relayout clear stale positions");
  await page.evaluate(() => {
    window.__positionPlayer.stop(); window.__app._player = window.__positionSavedPlayer;
    window.AudioContext = window.__positionNativeContext;
  });
  assert.equal(await page.locator(".cm-playback-source,#score-pane .playing").count(), 0);

  await page.evaluate(() => {
    const app = window.__app;
    app.setText(".Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n" + Array.from({ length: 50 }, (_, i) => `1 2 3 4 |${i === 49 ? "]" : "$(true)"}`).join("\n"));
    app.setCodePaneCollapsed(false);
    app.view.dispatch({ selection: { anchor: 0 } });
    app.view.scrollDOM.scrollTop = 0; app.scorePane.scrollTop = 0;
    window.__textSelection = app.view.state.selection.toJSON();
    app.onPlayState("playing");
    const source = app._sourceNotes.find(source => source.chord.measure.index === 35);
    app.onPlayChord([source.chord], 1);
    window.__followSource = source;
  });
  await page.waitForTimeout(150);
  let following = await page.evaluate(() => {
    const app = window.__app, source = window.__followSource;
    const viewport = app.view.scrollDOM.getBoundingClientRect(), text = app.view.coordsAtPos(source.from);
    const scoreViewport = app.scorePane.getBoundingClientRect();
    const note = app.painter.chordGroupEl(source.chord, 1)?.getBoundingClientRect();
    return { textTop: text?.top, textViewport: [viewport.top, viewport.bottom],
      scoreTop: note?.top, scoreViewport: [scoreViewport.top, scoreViewport.bottom],
      selection: app.view.state.selection.toJSON(), before: window.__textSelection,
      marks: document.querySelectorAll(".cm-playback-source").length };
  });
  assert.deepEqual(following.selection, following.before, "playback does not move text editing selection");
  assert.ok(following.textTop >= following.textViewport[0] && following.textTop < following.textViewport[1]);
  assert.ok(following.scoreTop >= following.scoreViewport[0] && following.scoreTop < following.scoreViewport[1]);
  assert.ok(following.marks > 0, "text has independent playback highlight");
  await page.evaluate(() => {
    const app = window.__app;
    app.view.scrollDOM.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }));
    app.view.scrollDOM.scrollTop = 0;
    app.onPlayChord([app._sourceNotes.at(-1).chord], 1);
  });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__app.view.scrollDOM.scrollTop), 0, "manual text scroll suspends only text follow");
  await page.locator("#text-resume-follow").click();
  await page.waitForTimeout(100);
  assert.ok(await page.evaluate(() => window.__app.view.scrollDOM.scrollTop > 0), "resume returns text to current playback");
  await page.evaluate(() => window.__app.onPlayState("stopped"));
  assert.equal(await page.locator(".cm-playback-source").count(), 0);
  assert.deepEqual(errors, []);
  console.log("playback follow browser checks passed");
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
