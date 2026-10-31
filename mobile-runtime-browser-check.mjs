import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { launchSaveCheckBrowser } from './browser-save-test-helpers.mjs';

const output = resolve('artifacts/mobile-runtime');
await mkdir(output, { recursive: true });
const dist = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = resolve(dist, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
    if (!file.startsWith(dist + sep)) throw new Error('outside dist');
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await launchSaveCheckBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [], requests = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (/\.sf2(?:\?|$)/i.test(request.url()) && !/[?&](?:import|url)(?:&|$)/.test(request.url())) requests.push(request.url()); });
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
await page.addInitScript(() => {
  localStorage.setItem('jpeditor:workspace-mode:v1', 'phone');
  const NativeAudioContext = window.AudioContext;
  window.__audioContexts = 0;
  window.AudioContext = class extends NativeAudioContext {
    constructor(...args) { super(...args); window.__audioContexts++; }
  };
});
try {
  await page.goto(process.env.MOBILE_TEST_URL ?? `http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__app && document.getElementById('mobile-command-dock'));
  await page.evaluate(() => document.fonts.ready);
  check('phone editor mounts before any SF2 request', requests.length === 0);
  check('phone editor starts without an audio device', await page.evaluate(() => window.__audioContexts === 0));
  const longText = '.Title\nTitle = {触屏长谱回归}\nKeyAndMeters = {1=C,4/4}\nTempo = {90}\n.Voice\n'
    + Array.from({ length: 480 }, () => '1 2 3 4 |').join('\n') + ']\n';
  await page.evaluate(text => {
    const app = window.__app;
    app.documentFormat = 'jpw'; app.slashOptions = null; app.loadText(text, 'long.jpwabc');
    if (!app.reload(app.getText())) throw new Error('long score failed to parse');
    app.setCodePaneCollapsed(true); app.setInputMode(false);
  }, longText);
  await page.waitForFunction(() => window.__app.painter.pageCount > 4 && document.querySelectorAll('#score-pane svg.score-page').length <= 4);
  const before = await page.evaluate(() => ({ text: window.__app.getText(), pages: window.__app.painter.pageCount,
    source: window.__app.painter.score.parts.flatMap(p => p.measures.flatMap(m => m.entries.flatMap(c => c.notes?.map(n => n.pitch) ?? []))) }));
  check('long score retains one wrapper per printed page', await page.evaluate(() => window.__app.pageEls.length === window.__app.painter.pageCount));
  await page.evaluate(() => window.__app.goToPage(window.__app.painter.pageCount - 2));
  await page.waitForFunction(() => {
    const a = window.__app;
    return !!a.pageEls[a.painter.pageCount - 2]?.querySelector('svg') && !a.pageEls[0]?.querySelector('svg')
      && document.querySelectorAll('#score-pane svg.score-page').length <= 4;
  });
  check('scroll to last pages releases the first SVG', true);
  const exportResult = await page.evaluate(async () => {
    const a = window.__app;
    const live = a.pageEls.flatMap(wrap => [...wrap.querySelectorAll('svg')]);
    const source = await a.getPageExportSource();
    return { pages: source.pages.length, everyPageHasNotes: source.pages.every(p => p.svg.querySelectorAll('text').length > 0),
      unchanged: live.every(svg => svg.isConnected), mounted: document.querySelectorAll('#score-pane svg.score-page').length };
  });
  check('all printed pages export while offscreen SVG stays unmounted', exportResult.pages === before.pages && exportResult.everyPageHasNotes && exportResult.unchanged && exportResult.mounted <= 4);
  await page.evaluate(() => window.__app.goToPage(0));
  await page.waitForFunction(() => !!window.__app.pageEls[0]?.querySelector('svg') && !window.__app.pageEls.at(-1)?.querySelector('svg'));
  check('remount preserves exact document text', await page.evaluate(text => window.__app.getText() === text, before.text));
  await page.screenshot({ path: resolve(output, 'phone-long-score.png') });

  // Exercise the real local sampler and audio device. No synthetic player replaces it.
  await page.evaluate(async () => {
    const a = window.__app;
    const settingsBefore = localStorage.getItem('jpeditor-render-settings');
    await a.ensureSoundfonts();
    window.__catalogKeptSettings = settingsBefore === localStorage.getItem('jpeditor-render-settings');
    const entry = a.soundfontCatalog.find(entry => entry.instruments.length);
    if (!entry) throw new Error('bundled SF2 missing');
    a.setPlaybackSoundSettings('sf2', entry.id, {});
    a.loadText('.Title\nKeyAndMeters = {1=C,4/4}\nTempo = {60}\n.Voice\n1 2 3 4 |]\n', 'audio.jpwabc');
  });
  check('background audio catalog does not commit unrelated settings drafts', await page.evaluate(() => window.__catalogKeptSettings));
  await page.locator('#mobile-play').click();
  await page.waitForFunction(() => window.__app._player?.state === 'playing', { timeout: 60000 });
  await page.evaluate(() => { window.__firstBank = window.__app._player.bank; window.__app.stopPlayback(); });
  await page.locator('#mobile-play').click();
  await page.waitForFunction(() => window.__app._player?.state === 'playing');
  check('replay reuses the same audio context and decoded bank', await page.evaluate(() => window.__audioContexts === 1 && window.__app._player.bank === window.__firstBank));
  await page.evaluate(async () => { await window.__app._player.ctx.suspend(); });
  await page.waitForFunction(() => window.__app._player?.state === 'stopped');
  check('audio suspension stops playback UI', await page.locator('#mobile-play').getAttribute('aria-pressed') !== 'true');
  await page.locator('#mobile-play').click();
  await page.waitForFunction(() => window.__app._player?.state === 'playing');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
  });
  check('background transition stops audio and follow state', await page.evaluate(() => window.__app._player.state === 'stopped'));
  await page.evaluate(async () => {
    const a = window.__app, p = a._player, sf2 = a.sf2PlaybackOptions();
    for (let i = 0; i < 12; i++) await p.audition([{ pitch: 60 + i % 7, part: 0, durationSeconds: 10 }], sf2);
  });
  check('rapid auditions share one bank with bounded overlap', await page.evaluate(() => window.__audioContexts === 1 && window.__app._player.auditionSessions.size === 8));
  await page.evaluate(() => window.__app.stopPlayback());
  check('stop releases audition voices but keeps reusable device', await page.evaluate(() => window.__app._player.auditionSessions.size === 0 && window.__app._player.ctx.state !== 'closed'));
  await page.locator('#mobile-more').click();
  await page.getByRole('combobox', { name: '工作区模式', exact: true }).selectOption('desktop');
  await page.locator('#btn-play').click();
  await page.waitForFunction(() => window.__app._player?.state === 'playing');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
  });
  check('touch device still stops in background with desktop layout selected', await page.evaluate(() => window.__app._player.state === 'stopped'));
  check('no uncaught browser errors', errors.length === 0);
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ checks, errors, sf2Requests: requests.length, pages: before.pages }, null, 2));
  console.log(`PASS mobile runtime: ${checks.length} checks, ${before.pages} printed pages, ${requests.length} SF2 request(s)`);
} catch (error) {
  await page.screenshot({ path: resolve(output, 'failure.png') });
  console.error({ errors, checks, state: await page.evaluate(() => ({ pages: window.__app?.painter.pageCount,
    mounted: document.querySelectorAll('#score-pane svg.score-page').length, mode: document.documentElement.dataset.workspaceMode })) }); throw error;
} finally { await browser.close(); await new Promise(done => server.close(done)); }
