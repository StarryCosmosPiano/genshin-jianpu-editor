import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { launchSaveCheckBrowser } from './browser-save-test-helpers.mjs';

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
    const file = join(process.cwd(), 'dist', normalize(path === '/' ? '/index.html' : path));
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await launchSaveCheckBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.on('download', download => errors.push(`Unexpected download: ${download.suggestedFilename()}`));
const check = (name, actual) => { assert.ok(actual, name); checks.push(name); };
const jpw = '.Title\nTitle = {保存保护回归}\nKeyAndMeters = {1=C,4/4}\nTempo = {90}\n.Voice\n1 2 3 4 |]\n';
const dialog = () => page.getByRole('dialog', { name: '乐谱尚未保存', exact: true });
const fixture = async () => page.evaluate(text => window.__app.loadText(text, 'original.jpwabc'), jpw);
const currentText = () => page.evaluate(() => window.__app.getText());
const dirty = () => page.evaluate(() => window.__app.hasUnsavedChanges());

async function verifyDesktopProtocol() {
  const native = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
  native.on('pageerror', error => errors.push(`desktop protocol: ${error.message}`));
  await native.addInitScript(() => {
    window.isTauri = true;
    window.__nativeNow = 1_000_000;
    Date.now = () => window.__nativeNow;
    window.__nativeFiles = new Map(); window.__nativeHistory = new Map(); window.__nativeEvents = new Map();
    window.__nativeSaveDestination = 'C:\\virtual-scores\\song.jpwabc';
    window.__nativeOpenDestination = 'C:\\virtual-scores\\song.jpwabc';
    window.__nativeWriteFailure = false; window.__nativeBackupFailure = false;
    window.__nativeCalls = []; window.__nativeDestroyed = 0;
    let callbackId = 0;
    const callbacks = new Map();
    window.__emitNativeClose = async () => {
      const handlers = window.__nativeEvents.get('tauri://close-requested') ?? [];
      for (const id of handlers) await callbacks.get(id)({ event: 'tauri://close-requested', id, payload: null });
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: callback => { const id = ++callbackId; callbacks.set(id, callback); return id; },
      unregisterCallback: id => callbacks.delete(id),
      invoke: async (command, args, options) => {
        window.__nativeCalls.push(command);
        if (command === 'plugin:event|listen') {
          const handlers = window.__nativeEvents.get(args.event) ?? []; handlers.push(args.handler);
          window.__nativeEvents.set(args.event, handlers); return args.handler;
        }
        if (command === 'plugin:event|unlisten') return;
        if (command === 'plugin:fs|mkdir') return;
        if (command === 'plugin:fs|exists') return true;
        if (command === 'plugin:fs|read_dir') return [];
        if (command === 'plugin:fs|read_file') return window.__nativeFiles.get(args.path) ?? [];
        if (command === 'plugin:dialog|save') return window.__nativeSaveDestination;
        if (command === 'plugin:dialog|open') return window.__nativeOpenDestination;
        if (command === 'plugin:fs|write_file') {
          if (window.__nativeWriteFailure) throw new Error('mock formal write failed');
          const path = decodeURIComponent(options.headers.path);
          window.__nativeFiles.set(path, [...args]); return;
        }
        if (command === 'autosave_write') {
          if (window.__nativeBackupFailure) throw new Error('mock backup publication failed');
          const bytes = new Uint8Array(args.bytes);
          const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
          const existing = window.__nativeHistory.get(args.projectPath) ?? [];
          if (existing[0]?.hash === hash) return { records: existing };
          const id = String(args.createdAt);
          const entry = { id, createdAt: args.createdAt, fileName: `backup-${id}-${id}.jpwabc`, hash, bytes: [...bytes] };
          const records = [entry, ...existing].slice(0, args.maxVersions);
          window.__nativeHistory.set(args.projectPath, records); return { records };
        }
        if (command === 'autosave_list') return (window.__nativeHistory.get(args.projectPath) ?? []).map(({ bytes, ...record }) => record);
        if (command === 'autosave_read') return window.__nativeHistory.get(args.projectPath).find(record => record.id === args.id).bytes;
        if (command === 'plugin:window|close') { await window.__emitNativeClose(); return; }
        if (command === 'plugin:window|destroy') { window.__nativeDestroyed++; return; }
        throw new Error(`Unexpected native protocol call: ${command}`);
      },
    };
  });
  try {
    await native.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
    await native.waitForFunction(() => window.__app && document.querySelector('#score-pane svg')
      && window.__nativeEvents.has('tauri://close-requested'));
    await native.evaluate(text => window.__app.loadText(text, 'C:\\virtual-scores\\song.jpwabc'), jpw);
    check('desktop protocol: history entry is available', !await native.locator('#btn-backup-history').evaluate(element => element.hidden));
    check('desktop protocol: automatic backup defaults disabled', await native.evaluate(() => !window.__app.autoBackupPreferences.enabled));
    await native.locator('#btn-options').click();
    await native.getByText('自动保存与恢复历史', { exact: true }).click();
    await native.getByLabel('开启自动保存', { exact: true }).check();
    check('desktop protocol: settings show the default 2 minutes and 10 versions',
      await native.getByLabel('自动保存间隔（分钟）', { exact: true }).inputValue() === '2'
      && await native.getByLabel('最多保留历史份数', { exact: true }).inputValue() === '10');
    await native.locator('.options-box .modal-footer').getByRole('button', { name: '确定', exact: true }).click();
    await native.evaluate(() => window.__app._autoBackup.tick());
    check('desktop protocol: enabling backup before formal Save creates no recovery copy',
      await native.evaluate(() => !window.__nativeCalls.includes('autosave_write')));
    await native.evaluate(() => window.__app.saveFile());
    check('desktop protocol: formal Save establishes the selected native path',
      await native.evaluate(() => window.__app.filePath === 'C:\\virtual-scores\\song.jpwabc' && !window.__app.hasUnsavedChanges()));
    await native.evaluate(() => { window.__nativeNow += 120_000; return window.__app._autoBackup.tick(); });
    check('desktop protocol: recovery copies use the formal project path and do not alter it',
      await native.evaluate(() => window.__nativeHistory.get('C:\\virtual-scores\\song.jpwabc').length === 1
        && window.__nativeFiles.size === 1 && !window.__app.hasUnsavedChanges()));
    const originalBytes = await native.evaluate(() => window.__nativeFiles.get('C:\\virtual-scores\\song.jpwabc'));
    await native.evaluate(() => { window.__app.setText(window.__app.getText() + '// newer recovery\n'); window.__nativeNow += 120_000; return window.__app._autoBackup.tick(); });
    check('desktop protocol: backup keeps formal dirty and does not overwrite the formal file',
      await native.evaluate(() => window.__app.hasUnsavedChanges())
      && JSON.stringify(await native.evaluate(() => window.__nativeFiles.get('C:\\virtual-scores\\song.jpwabc'))) === JSON.stringify(originalBytes));
    await native.evaluate(() => { window.__nativeBackupFailure = true; window.__app.setText(window.__app.getText() + '// failed backup\n'); window.__nativeNow += 120_000; return window.__app._autoBackup.tick(); });
    check('desktop protocol: failed backup retains prior recovery history',
      await native.evaluate(() => window.__nativeHistory.get('C:\\virtual-scores\\song.jpwabc').length === 2 && window.__app.hasUnsavedChanges()));
    await native.evaluate(() => { window.__nativeBackupFailure = false; });
    await native.locator('#btn-file-menu').click();
    await native.locator('#btn-backup-history').click();
    const recovery = native.getByRole('dialog', { name: '恢复历史', exact: true });
    await recovery.waitFor();
    await recovery.getByLabel('历史版本').selectOption(await native.evaluate(() => window.__nativeHistory.get('C:\\virtual-scores\\song.jpwabc')[1].id));
    await recovery.getByRole('button', { name: '恢复为副本', exact: true }).click();
    const confirmation = native.getByRole('dialog', { name: '乐谱尚未保存', exact: true });
    await confirmation.waitFor();
    await confirmation.getByRole('button', { name: '不保存', exact: true }).click();
    await native.waitForFunction(() => !window.__app.getText().includes('// newer recovery'));
    check('desktop protocol: history restores an unsaved copy without a formal save target',
      await native.evaluate(() => window.__app.hasUnsavedChanges() && window.__app.filePath === null && !window.__app._hasSavedCurrent));
    check('desktop protocol: restoring history leaves the original file intact',
      JSON.stringify(await native.evaluate(() => window.__nativeFiles.get('C:\\virtual-scores\\song.jpwabc'))) === JSON.stringify(originalBytes));
    check('desktop protocol: valid JPW recovery preserves the original text exactly', await native.evaluate(() => window.__app.getText()) === jpw);
    const restoreDraft = async (text, extension, expectsRepair) => {
      await native.evaluate(({ text, extension, fixture }) => {
        const path = `C:\\virtual-scores\\draft.${extension}`;
        window.__nativeOpenDestination = path;
        window.__nativeNow += 120_000;
        let bytes;
        if (extension === 'jpwabc') {
          bytes = [255, 254];
          for (let index = 0; index < text.length; index++) { const unit = text.charCodeAt(index); bytes.push(unit & 255, unit >> 8); }
        } else bytes = [...new TextEncoder().encode(text)];
        const id = String(window.__nativeNow);
        window.__nativeHistory.set(path, [{ id, createdAt: window.__nativeNow, fileName: `backup-${id}-${id}.${extension}`, hash: 'mock verified read', bytes }]);
        window.__app.loadText(fixture, null);
      }, { text, extension, fixture: jpw });
      await native.locator('#btn-file-menu').click();
      await native.locator('#btn-backup-history').click();
      const recovery = native.getByRole('dialog', { name: '恢复历史', exact: true });
      await recovery.waitFor();
      await recovery.getByRole('button', { name: '恢复为副本', exact: true }).click();
      await native.waitForFunction(text => window.__app.getText() === text && window.__app.hasUnsavedChanges(), text);
      check(`desktop protocol: ${expectsRepair ? 'unfinished' : 'valid'} ${extension} recovery preserves every source character`,
        await native.evaluate(text => window.__app.getText() === text && window.__app.filePath === null && !window.__app._hasSavedCurrent, text));
      if (expectsRepair) {
        check(`desktop protocol: unfinished ${extension} recovery clears the old score and leaves the text editable`,
          await native.evaluate(() => window.__app.painter.score.parts.length === 0
            && !document.querySelector('#score-pane svg') && !!document.querySelector('[data-recovery-error]')
            && !window.__app.codePaneCollapsed && !window.__app.isStaffPreviewCurrent()));
      }
    };
    await restoreDraft('// 原始注释与尾空格  \nQ/Q/Q/Q/\n', 'txt', false);
    await restoreDraft('.Title\nTitle = {编辑尚未完成\n', 'jpwabc', true);
    await restoreDraft('// @jpeditor {"v":2,"k":"k","m":[4,4],"nd":4,"s":{".":8},"q":"c"}\n[QW/Q/Q/Q/\n', 'txt', true);
    await native.evaluate(text => { window.__app.loadText(text, 'C:\\virtual-scores\\song.jpwabc'); window.__app.setText(text + '// close unsaved\n'); }, jpw);
    await native.evaluate(() => { void window.__emitNativeClose(); });
    await confirmation.waitFor();
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    check('desktop protocol: cancelled native close never destroys the window', await native.evaluate(() => window.__nativeDestroyed === 0));
    await native.evaluate(() => { window.__nativeWriteFailure = true; void window.__emitNativeClose(); });
    await confirmation.waitFor();
    await confirmation.getByRole('button', { name: '保存', exact: true }).click();
    await native.waitForTimeout(100);
    check('desktop protocol: failed formal Save cancels native close', await native.evaluate(() => window.__nativeDestroyed === 0 && window.__app.hasUnsavedChanges()));
    await native.evaluate(() => { window.__nativeWriteFailure = false; void window.__emitNativeClose(); });
    await confirmation.waitFor();
    await confirmation.getByRole('button', { name: '保存', exact: true }).click();
    await native.waitForFunction(() => window.__nativeDestroyed === 1);
    check('desktop protocol: confirmed Save follows close request through final destroy',
      await native.evaluate(() => window.__nativeCalls.includes('plugin:window|close') && !window.__app.hasUnsavedChanges()));
  } finally { await native.close(); }
}

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__app && document.querySelector('#score-pane svg'));
  check('initial sample is clean', !await dirty());
  check('web history entry is hidden', await page.locator('#btn-backup-history').evaluate(element => element.hidden));
  await fixture();
  check('loaded JPW starts clean', !await dirty());
  await page.evaluate(() => { window.__app.view.dispatch({ changes: { from: 0, insert: '// edit\n' } }); });
  check('source typing marks the document dirty', await dirty());
  const unload = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  check('dirty page requests a browser unload warning', unload);
  await page.evaluate(() => window.__app.undoEdit());
  check('undoing to the saved bytes clears dirty', !await dirty());
  check('clean page has no unload warning', !await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
  }));

  await page.evaluate(() => {
    window.__saveMode = 'success'; window.__savedBytes = [];
    window.showSaveFilePicker = async () => {
      if (window.__saveMode === 'cancel') throw new DOMException('cancelled', 'AbortError');
      return { kind: 'file', name: 'saved.jpwabc', createWritable: async () => {
        let pendingBytes = [];
        return {
        write: async bytes => {
          if (window.__saveMode === 'failure') throw new Error('injected write failure');
          pendingBytes = [...bytes];
          if (window.__saveMode === 'deferred') await new Promise(resolve => { window.__releaseWrite = resolve; });
        }, close: async () => {
          if (window.__saveMode === 'close-failure') throw new Error('injected close failure');
          window.__savedBytes = pendingBytes;
        }, abort: async () => { pendingBytes = []; },
      }; } };
    };
  });
  await page.evaluate(() => window.__app.setText(window.__app.getText() + '// first change\n'));
  check('successful formal Save clears dirty', (await page.evaluate(() => window.__app.saveFile())).status === 'success' && !await dirty());
  const savedText = await currentText();
  check('formal JPW save commits UTF-16LE bytes with the BOM only after close', await page.evaluate(text =>
    window.__savedBytes[0] === 255 && window.__savedBytes[1] === 254
      && new TextDecoder('utf-16le').decode(new Uint8Array(window.__savedBytes.slice(2))) === text, savedText));
  await page.evaluate(() => { window.__saveMode = 'close-failure'; window.__app.setText(window.__app.getText() + '// close must succeed\n'); });
  check('close failure preserves dirty and the previously committed bytes',
    (await page.evaluate(() => window.__app.saveFile())).status === 'failed' && await dirty()
      && await page.evaluate(text => new TextDecoder('utf-16le').decode(new Uint8Array(window.__savedBytes.slice(2))) === text, savedText));
  await page.evaluate(() => { window.__saveMode = 'success'; });
  await page.evaluate(() => window.__app.saveFile());
  await page.evaluate(() => { window.__saveMode = 'deferred'; window.__app.setText(window.__app.getText() + '// captured\n'); window.__pendingSave = window.__app.saveFile(); });
  await page.waitForFunction(() => typeof window.__releaseWrite === 'function');
  await page.evaluate(() => { window.__app.setText(window.__app.getText() + '// later edit\n'); window.__releaseWrite(); });
  check('edits during a pending write remain dirty', (await page.evaluate(() => window.__pendingSave)).status === 'success' && await dirty());
  await page.evaluate(() => { window.__saveMode = 'success'; });
  await page.evaluate(() => window.__app.saveFile());
  check('subsequent formal Save acknowledges the latest bytes', !await dirty());
  await page.evaluate(() => window.__app.setText(window.__app.getText() + '// copy only\n'));
  const beforeSaveAsHandle = await page.evaluate(() => window.__app._browserSaveHandle.name);
  check('Save As writes a copy without clearing formal dirty', (await page.evaluate(() => window.__app.saveFileAs())).status === 'success' && await dirty());
  check('Save As keeps the current formal target', await page.evaluate(() => window.__app._browserSaveHandle.name) === beforeSaveAsHandle);
  await page.evaluate(() => { window.__saveMode = 'deferred'; window.__releaseWrite = null; window.__foreignSave = window.__app.saveFile(); });
  await page.waitForFunction(() => typeof window.__releaseWrite === 'function');
  await page.evaluate(text => { window.__app.loadText(text, 'replacement.jpwabc'); window.__releaseWrite(); }, jpw);
  check('a late Save completion cannot acknowledge or establish the replacement document target',
    (await page.evaluate(() => window.__foreignSave)).status === 'cancelled'
    && !await dirty() && await page.evaluate(() => !window.__app._hasSavedCurrent && window.__app._browserSaveHandle === null));
  await page.evaluate(() => { window.__saveMode = 'success'; });

  // Real typing updates the source immediately and parsing only after debounce.
  await fixture();
  await page.evaluate(() => window.__app.changeDocumentFormat('keyboard'));
  await page.evaluate(() => window.__app.saveFile());
  await page.evaluate(() => {
    const app = window.__app, text = app.getText();
    const from = text.indexOf('90');
    app.view.dispatch({ changes: { from, to: from + 2, insert: '96' } });
    window.__debouncedSave = app.saveFile();
  });
  check('Save before delayed parsing captures the current source', (await page.evaluate(() => window.__debouncedSave)).status === 'success');
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__app.reload(window.__app.getText()));
  check('delayed parsing and explicit same-source reload do not make saved bytes dirty', !await dirty());

  // Unsupported browsers must keep the unsaved document and explain the usable path.
  await fixture();
  await page.evaluate(() => {
    window.__restoreSavePicker = window.showSaveFilePicker;
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true, writable: true });
    window.__app.setText(window.__app.getText() + '// no API must not acknowledge\n');
    window.__unsupportedSave = window.__app.saveFile();
  });
  const unavailable = page.getByRole('dialog', { name: '无法保存到本地', exact: true });
  await unavailable.waitFor();
  check('unsupported browser explains desktop and supported browser choices',
    (await unavailable.textContent()).includes('Chrome / Edge') && (await unavailable.textContent()).includes('桌面版'));
  await unavailable.getByRole('button', { name: '知道了', exact: true }).click();
  check('unsupported browser returns failed and preserves dirty without a fake save target',
    (await page.evaluate(() => window.__unsupportedSave)).status === 'failed' && await dirty()
      && await page.evaluate(() => !window.__app._hasSavedCurrent && window.__app._browserSaveHandle === null));
  await page.evaluate(() => { window.showSaveFilePicker = window.__restoreSavePicker; });

  // A cancelled write must leave both the source and file-session target intact.
  await fixture();
  await page.evaluate(() => { window.__app.setText(window.__app.getText() + '// unsaved\n'); window.__saveMode = 'cancel'; void window.__app.createDocument('jpw'); });
  await dialog().waitFor();
  await dialog().getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.app-dialog-layer'));
  check('cancelling the Save picker cancels replacement', (await currentText()).includes('// unsaved') && await dirty());
  await page.evaluate(() => { window.__saveMode = 'failure'; void window.__app.createDocument('jpw'); });
  await dialog().waitFor();
  await dialog().getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.app-dialog-layer'));
  check('failed Save cancels replacement', (await currentText()).includes('// unsaved') && await dirty());
  await page.evaluate(() => { void window.__app.createDocument('jpw'); });
  await dialog().waitFor();
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  check('replacement Cancel keeps the edited document', (await currentText()).includes('// unsaved'));
  await page.evaluate(() => { void window.__app.createDocument('jpw'); });
  await dialog().waitFor();
  await dialog().getByRole('button', { name: '不保存', exact: true }).click();
  await page.waitForFunction(() => !window.__app.getText().includes('// unsaved'));
  check('explicit Discard permits replacement', !await dirty());

  await fixture();
  await page.evaluate(() => { window.__app.setText(window.__app.getText() + '// imported later\n'); window.__saveMode = 'success'; });
  const beforeImport = await currentText();
  await page.evaluate(() => { void window.__app.importBytes(new TextEncoder().encode('速度90\nQ/Q/Q/Q/\n'), 'cancelled.txt'); });
  await page.locator('.slash-import-box').waitFor();
  await page.locator('.slash-import-box .modal-footer').getByRole('button', { name: '取消', exact: true }).click();
  check('cancelled import preserves source and dirty baseline', await currentText() === beforeImport && await dirty());
  check('cancelled import keeps the original source path', await page.evaluate(() => window.__app.filePath === null && window.__app._suggestedSavePath === 'original.jpwabc'));
  await page.locator('#btn-options').click();
  await page.getByText('自动保存与恢复历史', { exact: true }).click();
  check('web backup settings explain the desktop boundary', (await page.locator('.options-box').textContent()).includes('仅用于桌面版'));
  await mkdir(join(process.cwd(), 'artifacts', 'save-backup'), { recursive: true });
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'save-backup', 'web-settings.png') });
  await page.locator('.options-box .modal-footer').getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(errors, []);
  assert(savedText.includes('// first change'));
  const capabilities = JSON.parse(await readFile(join(process.cwd(), 'src-tauri', 'capabilities', 'default.json'), 'utf8'));
  for (const permission of ['core:window:allow-close', 'core:window:allow-destroy']) {
    assert.equal(capabilities.permissions.filter(value => value === permission).length, 1);
  }
  await verifyDesktopProtocol();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
