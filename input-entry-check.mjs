import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const file = path === '/' ? '/index.html' : path;
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(join(process.cwd(), 'dist', file)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, resolve));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const fixture = '.Title\nTitle = {输入起点}\nKeyAndMeters = {1=C,4/4}\n.Voice.Piano.V1\n1 2 [35] 4 | 5--- | 6 7 1 2 |]\n.Voice.Piano.V2\n0--- | 0--- | 0--- |]';
const reset = async (text = fixture) => page.evaluate(text => {
  const app = window.__app;
  app.setInputMode(false);
  app.documentFormat = 'jpw'; app.slashOptions = null;
  app.setText(text); app.resetDocumentUndo();
  app._entryAuditions = 0;
  app.auditionInputCursor = () => { app._entryAuditions++; };
}, text);
const clickNote = async (number, modifier) => {
  const target = page.locator('#score-pane g.entry text').filter({ hasText: new RegExp(`^${number}$`) }).first();
  await target.click(modifier ? { modifiers: ['Control'] } : {});
};
const snapshot = () => page.evaluate(() => ({ cursor: window.__app._input.snapshot(), text: window.__app.getText(), scroll: window.__app.scorePane.scrollTop }));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
  await reset();
  const initial = await snapshot();
  await page.locator('#btn-input-mode').click();
  assert.equal((await snapshot()).cursor, null, 'no selection must wait for a click');
  await page.keyboard.press('3');
  assert.equal((await snapshot()).text, initial.text, 'waiting input must not mutate');
  assert.equal(await page.evaluate(() => window.__app.workspaceSummary().waitingForInput), true);
  await clickNote('2');
  assert.equal((await snapshot()).cursor.offset, '1');

  await reset();
  await clickNote('2');
  await page.locator('#btn-input-mode').click();
  assert.equal((await snapshot()).cursor.offset, '1', 'score entry follows selected note');
  assert.equal((await snapshot()).text, initial.text);

  await reset();
  await clickNote('2'); await clickNote('5', true);
  await page.locator('#btn-input-mode').click();
  let cursor = (await snapshot()).cursor;
  assert.equal(cursor.offset, '2', 'multi selection uses last active chord');
  assert.equal(cursor.focusPitch, 67, 'entry retains selected chord pitch');

  await reset();
  await page.evaluate(() => {
    const app = window.__app; app.setCodePaneCollapsed(false);
    const source = app._sourceNotes.find(s => s.note.number === '7');
    app.view.focus();
    app.view.dispatch({ selection: { anchor: source.to, head: source.from } });
  });
  await page.locator('#btn-input-mode').click();
  cursor = (await snapshot()).cursor;
  assert.equal(cursor.measureIndex, 2); assert.equal(cursor.offset, '1');
  assert.equal(cursor.focusPitch, 71);

  // A pending edit moves the source range and changes the resulting pitch.
  await reset();
  await page.evaluate(() => {
    const app = window.__app;
    const source = app._sourceNotes.find(s => s.note.number === '2');
    app.view.focus();
    app.view.dispatch({ changes: { from: source.from, to: source.to, insert: "6'" }, selection: { anchor: source.from, head: source.from + 2 } });
    app.setInputMode(true);
  });
  cursor = (await snapshot()).cursor;
  assert.equal(cursor.offset, '1'); assert.equal(cursor.focusPitch, 81);

  // Grey tied segments are visual positions, never the attack source's beat.
  await reset('.Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n(1--- |1---) |]');
  const continuation = await page.evaluate(() => {
    const app = window.__app;
    for (const part of app.painter.score.parts) for (const measure of part.measures) for (const chord of measure.entries) {
      for (const note of chord.notes ?? []) {
        if (!note.tiePrev) continue;
        const group = app.painter.noteGroupEls(chord, note)[0];
        if (!group) continue;
        const box = group.element.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2, measureIndex: measure.index, offset: chord.position.toString() };
      }
    }
    return null;
  });
  assert.ok(continuation, 'fixture contains a visible tied continuation');
  await page.mouse.click(continuation.x, continuation.y);
  await page.evaluate(() => {
    const app = window.__app;
    app.setEngravingPreview({ ...app.engravingStyle, systemGapScale: 1.1 });
    app.setEngravingPreview(null);
  });
  await page.locator('#btn-input-mode').click();
  cursor = (await snapshot()).cursor;
  assert.equal(cursor.measureIndex, continuation.measureIndex);
  assert.equal(cursor.offset, continuation.offset);

  await reset('.Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n{(3}1_ 2_ 3_) 4 5 6 |]');
  await clickNote('2');
  await page.locator('#btn-input-mode').click();
  assert.equal((await snapshot()).cursor.offset, '1/3', 'triplet entry is exact');

  // New-document boundary clears old mode, source origin and cursor.
  await page.evaluate(async () => { await window.__app.importBytes(new TextEncoder().encode('.Title\n.Voice\n7--- |]'), 'new.jpwabc'); });
  assert.equal(await page.evaluate(() => window.__app.inputModeEnabled), false);
  await page.locator('#btn-input-mode').click();
  assert.equal((await snapshot()).cursor, null);

  await reset('.Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n' + '1 2 3 4 | '.repeat(120) + ']');
  await page.evaluate(() => {
    const app = window.__app; app.setCodePaneCollapsed(true);
    app.scorePane.scrollTop = 1700;
  });
  const beforeScroll = (await snapshot()).scroll;
  await page.locator('#btn-input-mode').click();
  assert.equal((await snapshot()).cursor, null);
  assert.ok(Math.abs((await snapshot()).scroll - beforeScroll) < 2, 'waiting entry preserves viewport');
  assert.equal(await page.evaluate(() => window.__app._entryAuditions), 0);
  await page.locator('#btn-select-mode').click();
  const crossPage = await page.evaluate(() => {
    const app = window.__app;
    const source = app._sourceNotes.find(s => s.chord.measure.index === 70 && s.note.number === '2');
    const element = app.painter.noteGroupEls(source.chord, source.note)[0].element;
    element.scrollIntoView({ block: 'center' });
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  await page.mouse.click(crossPage.x, crossPage.y);
  const selectedScroll = (await snapshot()).scroll;
  await page.locator('#btn-input-mode').click();
  cursor = (await snapshot()).cursor;
  assert.equal(cursor.measureIndex, 70); assert.equal(cursor.offset, '1');
  assert.ok(Math.abs((await snapshot()).scroll - selectedScroll) < 2, 'cross-page entry preserves visible position');
  await page.locator('#btn-select-mode').click();
  await page.locator('#btn-input-mode').click();
  assert.equal((await snapshot()).cursor, null, 'reentry does not restore previous input session');
  assert.deepEqual(errors, []);
  console.log('Input entry: waiting, score/text active end, pending parse, chord/multiselect, grey continuation, triplet, document reset and scroll passed.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
