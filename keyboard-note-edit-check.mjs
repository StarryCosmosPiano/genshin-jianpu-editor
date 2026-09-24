// Real-browser regression for score keyboard entry. Run after npm run build.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const root = join(process.cwd(), 'dist');
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
};
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
    const file = path === '/' ? '/index.html' : path;
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    response.end(await readFile(join(root, file)));
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});
await new Promise(resolve => server.listen(0, resolve));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 960 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

const fixture = '键盘谱\n4/4拍：\n Q (CBDGQ)/ Z (ZG)/ Z (CBQ)/ (ZSGW)(BM) /\n';
const rows = ['ZXCVBNM', 'ASDFGHJ', 'QWERTYU'];
const intervals = [0, 2, 4, 5, 7, 9, 11];
const tonic = 60;
const expected = new Map(rows.flatMap((row, octave) =>
  [...row].map((key, degree) => [key, tonic + intervals[degree] + (octave - 1) * 12])));

const state = () => page.evaluate(() => {
  const app = window.__app;
  return {
    input: app._input.enabled,
    cursor: app._input.snapshot(),
    text: app.getText(),
    selected: app._selectedNotes.length,
    focus: document.activeElement?.id ?? '',
    sourcePitches: app._sourceNotes.map(source => source.note.pitch),
  };
});

async function reset(labels = true) {
  await page.evaluate(({ text, labels }) => {
    const app = window.__app;
    app.setInputMode(false);
    app.documentFormat = 'keyboard';
    app.slashOptions.keyboardKeyLabels = labels;
    app.setText(text);
    app.resetDocumentUndo();
    app.setCodePaneCollapsed(true);
  }, { text: fixture, labels });
  const parsed = await page.evaluate(() => ({
    sources: window.__app._sourceNotes.map(source => ({
      pitch: source.note.pitch, token: window.__app.getText().slice(source.from, source.to),
    })),
    format: window.__app.documentFormat,
    labels: window.__app.slashOptions?.keyboardKeyLabels,
  }));
  assert.ok(parsed.sources.length >= 5, `fixture did not parse five notes: ${JSON.stringify(parsed)}`);
}

async function clickPitch(pitch, chord = false) {
  const point = await page.evaluate(({ pitch, chord }) => {
    const app = window.__app;
    const source = app._sourceNotes.find(item => item.note.pitch === pitch
      && item.chord.notes.length === (chord ? 2 : 1));
    if (!source) return null;
    const rendered = app.painter.noteGroupEls(source.chord, source.note)[0];
    if (!rendered) return null;
    rendered.element.scrollIntoView({ block: 'center' });
    const rect = rendered.element.getBoundingClientRect();
    return {
      x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
      chordIndex: source.chordIndex,
    };
  }, { pitch, chord });
  assert.ok(point, `visible note at pitch ${pitch}`);
  await page.mouse.click(point.x, point.y);
  assert.equal((await state()).selected, 1, 'click selects exactly one score note');
  assert.equal((await state()).focus, 'score-pane', 'score click owns keyboard focus');
  return point.chordIndex;
}

async function chordSnapshot() {
  return page.evaluate(() => {
    const app = window.__app;
    const source = app._sourceNotes.find(item => item.chord.notes.length === 2);
    if (!source) return null;
    return {
      pitches: source.chord.notes.map(note => note.pitch).sort((a, b) => a - b),
      duration: source.chord.duration?.toString() ?? null,
      position: source.chord.position.toString(),
      count: source.chord.notes.length,
    };
  });
}

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
  // Import through the actual TXT dialog so the slash-score model and option
  // metadata are initialized just as they are in the product.
  await page.evaluate(text => {
    void window.__app.importBytes(new TextEncoder().encode(text), 'keyboard-entry.txt');
  }, fixture);
  await page.locator('.slash-import-box').waitFor();
  const labels = page.locator('.slash-import-box .modal-row')
    .filter({ hasText: '谱面显示键盘按键' }).locator('input[type="checkbox"]');
  await labels.check();
  await page.getByRole('button', { name: '导入为单行简谱' }).click();
  await page.locator('.slash-import-box').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.__app.slashOptions.keyboardKeyLabels), true);
  assert.equal(await page.evaluate(() => window.__app.documentFormat), 'keyboard');
  assert.equal(await page.evaluate(() => window.__app.slashOptions.fifths), 0,
    'pitch expectations use the imported C tonic');

  // With labels hidden, a selected note enters score input on N and exits on
  // the next N. Both lower- and uppercase letters must work.
  await reset(false);
  await clickPitch(72);
  const beforeN = await state();
  await page.keyboard.press('n');
  assert.equal((await state()).input, true, 'lowercase N enters input mode');
  assert.equal((await state()).cursor?.focusPitch, 72, 'N entry follows the selected note');
  assert.equal((await state()).text, beforeN.text, 'entering input does not edit the document');
  await page.keyboard.press('Shift+N');
  assert.equal((await state()).input, false, 'uppercase N exits input mode when labels are hidden');
  assert.equal((await state()).text, beforeN.text, 'leaving input does not edit a note');

  // The display option must gate all piano-letter edits. Modifiers cannot
  // accidentally write notes, while the established Escape mode exit works.
  await reset(false);
  await clickPitch(72);
  const hiddenText = (await state()).text;
  await page.keyboard.press('q');
  assert.equal((await state()).text, hiddenText, 'piano keys are inert with labels hidden');
  await page.keyboard.press('n');
  await page.keyboard.press('Escape');
  assert.equal((await state()).input, false, 'Escape still exits input mode');

  // N is reserved for entering input mode from an ordinary selection even
  // when labels are shown. Once inside input mode, it is the low-row sixth.
  await reset(true);
  await clickPitch(72);
  const enabledBeforeN = (await state()).text;
  await page.keyboard.press('n');
  assert.equal((await state()).input, true, 'N enters input mode with labels shown');
  assert.equal((await state()).text, enabledBeforeN, 'N entry leaves the note unchanged');
  await page.keyboard.press('n');
  assert.equal((await state()).input, true, 'N pitch entry does not exit input mode');
  assert.equal(await page.evaluate(() => window.__app.inputFocus()?.note.pitch), expected.get('N'),
    'N writes the low-row sixth in input mode');
  await page.keyboard.press('Shift+N');
  assert.equal((await state()).input, true, 'uppercase N remains a pitch key in input mode');
  const inputCursor = (await state()).cursor;
  for (const key of ['z', 'A', 'u']) {
    await page.keyboard.press(key);
    assert.equal(await page.evaluate(() => window.__app.inputFocus()?.note.pitch),
      expected.get(key.toUpperCase()), `${key} retunes the focused input note`);
    assert.equal((await state()).input, true, `${key} retains input mode`);
    assert.equal((await state()).cursor?.offset, inputCursor?.offset,
      `${key} does not advance the input cursor`);
  }
  await page.keyboard.press('Escape');
  assert.equal((await state()).input, false, 'Escape exits when N is a pitch key');

  // Every available pitch key except the ambiguous N is tested against the
  // rendered model, so case handling and all three octave rows are covered.
  for (const [index, [key, pitch]] of [...expected].entries()) {
    if (key === 'N') continue;
    await reset(true);
    const chordIndex = await clickPitch(72);
    const spelling = index % 2 ? key.toLowerCase() : `Shift+${key}`;
    await page.keyboard.press(spelling);
    const actual = await page.evaluate(chordIndex => window.__app._sourceNotes
      .find(source => source.chordIndex === chordIndex && source.chord.notes.length === 1)?.note.pitch,
    chordIndex);
    assert.equal(actual, pitch, `${spelling} should write MIDI pitch ${pitch}`);
    assert.equal((await state()).input, false, `${spelling} must not switch modes`);
  }

  await reset(true);
  await clickPitch(72);
  const untouched = (await state()).text;
  await page.keyboard.press('Control+X');
  await page.keyboard.press('Alt+X');
  assert.equal((await state()).text, untouched, 'Ctrl/Alt piano chords do not edit the score');
  assert.equal((await state()).input, false, 'Ctrl/Alt piano chords do not toggle input mode');

  // A chord click targets one note. Keyboard retuning keeps its partner,
  // rhythmic position, and duration, then Ctrl+Z restores the source.
  await reset(true);
  await clickPitch(67, true);
  const chordBefore = await chordSnapshot();
  const sourceBefore = (await state()).text;
  await page.keyboard.press('q');
  const chordAfter = await chordSnapshot();
  assert.deepEqual(chordAfter?.pitches, [48, 72], 'only selected chord tone changes');
  assert.equal(chordAfter?.count, chordBefore?.count, 'retuning preserves chord cardinality');
  assert.equal(chordAfter?.duration, chordBefore?.duration, 'retuning preserves duration');
  assert.equal(chordAfter?.position, chordBefore?.position, 'retuning preserves timing');
  await page.keyboard.press('Control+Z');
  await page.waitForFunction(text => window.__app.getText() === text, sourceBefore);
  await page.waitForFunction(() => window.__app._sourceNotes
    .some(source => source.chord.notes.length === 2
      && source.chord.notes.some(note => note.pitch === 67)));
  assert.deepEqual((await chordSnapshot())?.pitches, chordBefore?.pitches, 'Ctrl+Z restores both chord pitches');

  // Text focus remains ordinary typing even when keyboard labels are visible.
  await reset(true);
  await page.evaluate(() => {
    const app = window.__app;
    app.setCodePaneCollapsed(false);
    app.view.focus();
    app.view.dispatch({ selection: { anchor: app.view.state.doc.length } });
  });
  const beforeTextTyping = (await state()).text;
  await page.keyboard.press('q');
  await page.keyboard.press('n');
  const typed = await state();
  assert.equal(typed.text, beforeTextTyping + 'qn', 'CodeMirror types piano letters as text');
  assert.equal(typed.input, false, 'text typing does not enter score input mode');

  assert.deepEqual(errors, [], 'browser produced no runtime errors');
  console.log('Keyboard note edit: N hidden-label mode toggle, 20 pitch keys, case, modifiers, chord isolation, text focus, Escape and undo passed.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
