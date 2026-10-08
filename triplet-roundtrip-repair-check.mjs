import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const cases = JSON.parse(await readFile('fixtures/triplet-roundtrip-repairs.json', 'utf8'));
const out = join(process.cwd(), 'artifacts', 'triplet-repair-browser');
await mkdir(out, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = url === '/' ? '/index.html' : url;
    const bytes = await readFile(join(process.cwd(), 'dist', normalize(file)));
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const results = [];
const snapshot = () => page.evaluate(() => {
  const app = window.__app;
  const score = app.painter.score;
  const notes = score.parts.flatMap((part, partIndex) => part.measures.flatMap(measure =>
    measure.entries.filter(entry => entry.notes?.length).flatMap(chord => chord.notes
      .filter(note => !note.rest && !note.tiePrev).map(note => {
        let last = note;
        const seen = new Set();
        while (last.tieNext && !seen.has(last)) { seen.add(last); last = last.tieNext; }
        return { part: partIndex, pitch: note.pitch,
          start: Math.round((measure.position.toFloat() + chord.position.toFloat()) * 192),
          end: Math.round((last.chord.measure.position.toFloat() + last.chord.position.toFloat()
            + last.chord.duration.toFloat()) * 192) };
      })))).sort((a, b) => a.part - b.part || a.start - b.start || a.pitch - b.pitch || a.end - b.end);
  const tuplets = score.parts.map(part => part.measures.flatMap(measure => {
    const objects = new Set(measure.entries.flatMap(chord => (chord.notes ?? []).map(note => note.tuplet).filter(Boolean)));
    return [...objects].map(tuplet => ({ start: tuplet.actualStart?.toString(), end: tuplet.actualEnd?.toString(),
      measure: part.measures.indexOf(measure), members: tuplet.memberChords().length }));
  }));
  return { text: app.getText(), notes, tuplets,
    errors: app._slashTimingDiagnostics.filter(d => d.severity === 'error') };
});
const fraction = text => { const [a, b = '1'] = text.split('/'); return Number(a) / Number(b); };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
  for (const item of cases) {
    const op = item.operation;
    await page.evaluate(({ text, division }) => {
      const app = window.__app;
      app.documentFormat = text.startsWith('键盘谱') ? 'keyboard' : 'number';
      app.setText(text);
      app.setInputMode(true);
      app.setInputDurationDivision(division);
      app._inputDurationDotted = false;
    }, { text: item.beforeText, division: op.span === '1/2' ? 8 : 16 });
    await page.waitForTimeout(300);
    const before = await snapshot();
    assert.deepEqual(before.errors, [], `${item.id}: before`);
    const target = await page.evaluate(op => {
      const app = window.__app;
      const source = app._sourceNotes.find(s => s.partIndex === op.part - 1
        && s.chord.measure === app.painter.score.parts[op.part - 1].measures[op.measure - 1]
        && s.chord.position.toString() === op.offset && !s.note.rest);
      const element = source && app.painter.noteGroupEls(source.chord, source.note)[0]?.element;
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }, op);
    assert(target, `${item.id}: source glyph`);
    await page.mouse.click(target.x, target.y);
    await page.mouse.click(target.x, target.y, { button: 'right' });
    const menu = page.getByRole('menuitem', { name: '在光标处创建三连音', exact: true });
    assert(await menu.isVisible() && !await menu.isDisabled(), `${item.id}: create menu`);
    await menu.click();
    await page.waitForTimeout(300);
    if (item.id === 'R8-S0') {
      for (const [at, key] of [['29/12', '2'], ['31/12', '3']]) {
        const hit = await page.evaluate(at => {
          const app = window.__app;
          const chord = app.painter.score.parts[0].measures[0].entries.find(e =>
            e.position.toString() === at && e.notes?.some(n => n.tuplet));
          const element = chord && app.painter.noteGroupEls(chord, chord.notes[0])[0]?.element;
          if (!element) return null;
          const box = element.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        }, at);
        assert(hit, 'member glyph');
        await page.mouse.click(hit.x, hit.y);
        assert.deepEqual(await page.evaluate(() => ({ part: window.__app._input.cursor?.partIndex,
          at: window.__app._input.cursor?.offset.toString() })), { part: 0, at });
        await page.keyboard.press(key);
        await page.waitForTimeout(200);
      }
    }
    const after = await snapshot();
    assert.deepEqual(after.errors, [], `${item.id}: after`);
    const start = ((op.measure - 1) * 4 + fraction(op.offset)) * 192;
    const end = start + fraction(op.span) * 192;
    const outside = notes => notes.filter(n => n.part !== op.part - 1 || n.start < start || n.start >= end);
    assert.deepEqual(outside(after.notes), outside(before.notes), `${item.id}: another sound changed`);
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.evaluate(() => {
        const app = window.__app;
        const text = app.serializeCurrentScoreDocument();
        if (text === null) throw new Error('serialization failed');
        app.setText(text);
        app.reload();
      });
      await page.waitForTimeout(250);
      const current = await snapshot();
      assert.deepEqual(current.errors, [], `${item.id}: save ${cycle}`);
      assert.deepEqual(current.notes, after.notes, `${item.id}: playback after save ${cycle}`);
      assert.deepEqual(current.tuplets, after.tuplets, `${item.id}: groups after save ${cycle}`);
    }
    results.push({ id: item.id, before, after });
    await page.screenshot({ path: join(out, `${item.id}.png`) });
  }
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'results.json'), JSON.stringify({ results }, null, 2));
  console.log('triplet-roundtrip-repair-browser: six menu/keyboard cases, 18 save cycles, unaffected voices and playback OK');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
