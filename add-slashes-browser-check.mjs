import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.woff2':'font/woff2', '.json':'application/json', '.wasm':'application/wasm' };
const server = createServer(async (req, res) => {
  try { const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = join(process.cwd(), 'dist', normalize(path === '/' ? '/index.html' : path));
    res.writeHead(200, {'content-type':mime[extname(file)] ?? 'application/octet-stream'}); res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({channel:'msedge',headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1040}});
await page.addInitScript(() => localStorage.setItem('jpeditor:workspace-mode:v1', 'desktop'));
const errors = [], results = [];
page.on('pageerror', e => errors.push(e.message));
const check = (label, value) => { assert.ok(value,label); results.push(label); };
const field = name => page.locator(`[data-add-slashes="${name}"]`);
const mapping = symbol => page.locator(`[data-add-slashes-symbol="${symbol}"]`);
const currentText = () => page.evaluate(() => window.__app.getText());
const open = async text => { await page.evaluate(value => { void window.__app.importBytes(new TextEncoder().encode(value),'补斜杠回归.txt'); },text); await page.locator('.add-slashes-dialog').waitFor(); };
const meter = async beats => { await field('beats').fill(String(beats)); await field('beat-type').selectOption('4'); };
const waitConversion = async () => { await page.waitForFunction(() => !document.querySelector('[data-add-slashes="confirm"]').disabled); await field('score-preview').locator('svg').waitFor(); };
const secondStep = async () => { await waitConversion(); await field('confirm').click(); await page.locator('.slash-import-box .slash-score-preview svg').waitFor(); };
const confirmImport = async () => { const dirty = await page.evaluate(() => window.__app.hasUnsavedChanges()); await page.locator('.slash-import-box .modal-footer').getByRole('button',{name:/^导入为/}).click(); if (dirty) await page.getByRole('button', { name: '不保存', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('.slash-import-box') && window.__app.documentFormat === 'keyboard' && document.querySelector('#score-pane svg')); };
const events = () => page.evaluate(() => {
  const score = window.__app.painter.score, attacks = [];
  for (const measure of score.parts[0].measures) for (const chord of measure.entries) {
    if (!Array.isArray(chord.notes)) continue;
    const roots = chord.notes.filter(note => !note.rest && !note.tiePrev); if (!roots.length) continue;
    attacks.push({at:roots[0].absoluteTick.toFloat(), pitches:roots.map(note => note.pitch).sort((a,b)=>a-b), durations:roots.map(note => {
      let length=0,current=note; const seen=new Set(); while(current && !seen.has(current)) { seen.add(current); length+=current.chord.duration.toFloat(); current=current.tieNext; } return length;
    })});
  }
  return {attacks,measures:score.parts[0].measures.length,pickup:score.parts[0].measures[0].pickup,text:window.__app.getText(),options:window.__app.slashOptions};
});
const shot = async name => {
  await page.waitForFunction(()=>!document.querySelector('.slash-score-preview[aria-busy="true"]'));
  await page.screenshot({path:join(process.cwd(),'artifacts','add-slashes',name)});
};
const outsideIsInactive = async dialog => {
  await page.mouse.click(5,5);
  check('outside click leaves import open without a save prompt',await page.locator(dialog).isVisible()
    && await page.locator('.inspector-dirty-prompt,[role="alertdialog"]').count()===0);
  check('background controls are inactive during import',await page.locator('#btn-file-menu').evaluate(el=>!!el.closest('[inert]')));
};
const raw = '速度58\nQV+-JA+-QF+++++\n';
try {
  await mkdir(join(process.cwd(),'artifacts','add-slashes'),{recursive:true});
  await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'networkidle'});
  await page.waitForFunction(() => window.__app && document.querySelector('#score-pane svg'));
  const before = await currentText(); await open(raw);
  check('draft leaves current score unchanged',await currentText()===before);
  check('only actual symbols start with blank timings',await field('beats').inputValue()==='' && await field('confirm').isDisabled() && await mapping('+').inputValue()==='' && await mapping('-').inputValue()==='' && await page.locator('[data-add-slashes-symbol]').count()===2);
  check('fixed initial duration rule removed',!(await page.locator('.add-slashes-dialog').textContent()).includes('初始规则'));
  check('initial meter guide explains both entry paths',(await field('meter-guide').textContent()).includes('先填写拍号')
    && (await field('meter-guide').textContent()).includes('分析拍号'));
  await field('analyze-meter').click();
  check('meter analysis requests source durations instead of inventing them',(await field('meter-analysis-hint').textContent()).includes('请先指定原文符号')
    && await field('beats').inputValue()==='');
  check('first preview defaults to score',await field('score-preview').locator('[data-preview-view="score"]').getAttribute('aria-pressed')==='true');
  await field('score-preview').locator('[data-preview-view="text"]').click();
  check('text preview works before meter is configured',await field('score-preview').locator('.slash-score-preview-text').inputValue()===raw
    && await field('score-preview').locator('.slash-score-preview-text').evaluate(el=>el.readOnly));
  await outsideIsInactive('.add-slashes-dialog');
  await field('score-preview').locator('[data-preview-view="score"]').click();
  await meter(4); await waitConversion();
  check('one original row is preferred as one measure',await mapping('+').inputValue()==='8' && await mapping('-').inputValue()==='16');
  const converted=await field('preview').inputValue();
  check('only slashes are inserted into the original text',converted.replaceAll('/','')===raw && converted.includes('/'));
  check('right preview is a real single-measure score',(await field('score-preview').textContent()).includes('1 小节'));
  await field('score-preview').locator('[data-preview-view="text"]').click();
  check('text preview shows exactly the converted draft',await field('score-preview').locator('.slash-score-preview-text').inputValue()===converted
    && !await field('score-preview').locator('.slash-score-preview-sheet').isVisible());
  await field('source').fill(raw+'说明\n');
  await page.waitForFunction(()=>document.querySelector('[data-add-slashes="score-preview"] .slash-score-preview-text')?.value.includes('说明'));
  check('draft edits refresh text while preserving selected preview mode',await field('score-preview').locator('[data-preview-view="text"]').getAttribute('aria-pressed')==='true');
  await field('source').fill(raw);
  await page.waitForFunction(text=>document.querySelector('[data-add-slashes="score-preview"] .slash-score-preview-text')?.value===text,converted);
  await shot('import-text-preview.png');
  await field('score-preview').locator('[data-preview-view="score"]').click();
  await shot('import-preview.png'); await secondStep();
  check('second settings stage opens before document commit',await currentText()===before && await page.locator('.midi-meter-control input').inputValue()==='4');
  const settingsPreview=page.locator('.slash-import-box .slash-score-preview');
  check('second preview also defaults to score',await settingsPreview.locator('[data-preview-view="score"]').getAttribute('aria-pressed')==='true');
  await settingsPreview.locator('[data-preview-view="text"]').click();
  check('second text preview retains original duration symbols',await settingsPreview.locator('.slash-score-preview-text').inputValue()===converted);
  await outsideIsInactive('.slash-import-box');
  await shot('import-settings-text-preview.png');
  await settingsPreview.locator('[data-preview-view="score"]').click();
  await shot('import-settings-preview.png'); await page.keyboard.press('Escape');
  check('cancel second stage keeps current document',await currentText()===before);
  check('closing import restores background controls',!await page.locator('#btn-file-menu').evaluate(el=>!!el.closest('[inert]')));
  await open(raw); await meter(4); await secondStep();
  await page.locator('.slash-import-box summary').filter({hasText:'标题与署名'}).click();
  const titleRow=page.locator('.slash-import-box .modal-row').filter({has:page.locator('span',{hasText:/^标题$/})});
  await titleRow.locator('input').fill('原行时值核对');
  await page.waitForFunction(() => document.querySelector('.slash-import-box .slash-score-preview svg')?.textContent.includes('原行时值核对'));
  check('settings update isolated live SVG',await currentText()===before);
  await outsideIsInactive('.slash-import-box');
  await confirmImport(); let model=await events();
  check('example has three exact two-note attacks',model.attacks.length===3 && JSON.stringify(model.attacks.map(e=>e.at))==='[0,0.75,1.5]' && model.attacks.every((e,i)=>e.pitches.length===2 && e.durations.every(v=>v===[.75,.75,2.5][i])));
  check('one measure and source timing settings persist',model.measures===1 && model.options.beats===4 && model.options.sourceTimedRows && model.options.adjacentAsChord);
  check('source spelling preserved beneath settings metadata',model.text.includes(converted.trim()) && model.text.includes('// @jpeditor'));
  await page.evaluate(() => { const app=window.__app; app.setText(app.getText()); });
  check('reloading preserves note events',JSON.stringify((await events()).attacks)===JSON.stringify(model.attacks));
  const exported=await page.evaluate(()=>new TextDecoder().decode(window.__app.exportTextDocument('keyboard').bytes));
  await page.evaluate(text=>{void window.__app.importBytes(new TextEncoder().encode(text),'重读.txt');},exported);
  await page.locator('.slash-import-box .slash-score-preview svg').waitFor(); await confirmImport();
  check('saved TXT reopens with its original timing interpretation',JSON.stringify((await events()).attacks)===JSON.stringify(model.attacks));
  const point=await page.evaluate(()=>{
    const app=window.__app;
    const source=app._sourceNotes.find(item=>app.getText().slice(item.from,item.to)==='Q' && item.chord.position.toFloat()===0);
    if(!source) throw new Error('original pitch source Q missing');
    const rendered=app.painter.noteGroupEls(source.chord,source.note)[0]; rendered.element.scrollIntoView({block:'nearest'});
    const bound=app.painter.pageItemForTarget(rendered.element).bound;
    const p=new DOMPoint((bound.left+bound.right)/2,(bound.top+bound.bottom)/2).matrixTransform(rendered.element.getScreenCTM());
    return {x:p.x,y:p.y};
  });
  await page.mouse.click(point.x,point.y);
  check('clicking a preview pitch selects its original source letter',await page.evaluate(()=>window.__app._selectedNotes.some(item=>window.__app.getText().slice(item.source.from,item.source.to)==='Q')));
  await page.keyboard.press('n'); await page.keyboard.press('Control+ArrowUp');
  const edited=await events();
  check('score edit emits normal grammar without source timing flag',!edited.options.sourceTimedRows && edited.attacks[0].pitches.includes(Math.max(...model.attacks[0].pitches)+12));
  await page.keyboard.press('Control+z');
  await page.waitForFunction(()=>window.__app.slashOptions?.sourceTimedRows===true);
  await page.waitForFunction(()=>window.__app.painter.score.parts[0].measures[0].entries.find(chord=>chord.notes?.some(note=>!note.rest))?.notes.some(note=>note.pitch===72));
  check('undo restores original text interpretation and all durations',JSON.stringify((await events()).attacks)===JSON.stringify(model.attacks) && (await events()).options.sourceTimedRows);
  await page.keyboard.press('Escape');
  await open(raw);
  await mapping('+').selectOption('8'); await mapping('-').selectOption('16');
  await field('analyze-meter').click();
  check('explicit meter analysis offers candidates without changing the meter',await page.locator('[data-add-slashes-meter="4/4"]').count()===1 && await field('beats').inputValue()==='');
  await page.locator('[data-add-slashes-meter="4/4"]').click(); await waitConversion();
  await field('analyze-meter').click();
  check('reanalyzing an existing meter does not replace it',await field('beats').inputValue()==='4');
  await secondStep();
  const remapPreview=page.locator('.slash-import-box .slash-score-preview');
  const remapConfirm=page.locator('.slash-import-box .modal-footer').getByRole('button',{name:/^导入为/});
  await remapPreview.locator('[data-preview-view="text"]').click();
  await page.locator('[data-slash-import="multiple-symbols"]').uncheck();
  await page.locator('.slash-symbol-row input').first().fill('.');
  await page.locator('.slash-symbol-row select').first().selectOption('32');
  const dots32=converted.replaceAll('+','....').replaceAll('-','..');
  await page.waitForFunction(text=>document.querySelector('.slash-import-box .slash-score-preview-text')?.value===text,dots32);
  check('second-stage symbol change converts eighth-note plus to four thirty-second dots',!await remapConfirm.isDisabled()
    && !(await remapPreview.textContent()).includes('尚未指定时值'));
  await shot('import-remapped-dots.png');
  await page.locator('.slash-symbol-row select').first().selectOption('8');
  const tooCoarse=await page.locator('[data-slash-import="error"]').textContent();
  check('coarse output duration gives a short minimum-duration error and blocks import',await remapConfirm.isDisabled()
    && tooCoarse.includes('16') && tooCoarse.length<200);
  check('conversion error cannot overflow the preview',await remapPreview.locator('.slash-score-preview-status').evaluate(el=>el.getBoundingClientRect().height<=97));
  await page.locator('.slash-symbol-row select').first().selectOption('16');
  const dots16=converted.replaceAll('+','..').replaceAll('-','.');
  await page.waitForFunction(text=>document.querySelector('.slash-import-box .slash-score-preview-text')?.value===text,dots16);
  await page.locator('.slash-symbol-row select').first().selectOption('32');
  await page.waitForFunction(text=>document.querySelector('.slash-import-box .slash-score-preview-text')?.value===text,dots32);
  check('repeated output changes always start from fixed source timing',!await remapConfirm.isDisabled());
  await confirmImport();
  let remapped=await events();
  check('import applies the rewritten draft with identical onsets and durations',remapped.text.includes(dots32.trim())
    && JSON.stringify(remapped.attacks)===JSON.stringify(model.attacks) && JSON.stringify(remapped.options.symbolDurations)==='{".":32}');
  const remappedFile=await page.evaluate(()=>new TextDecoder().decode(window.__app.exportTextDocument('keyboard').bytes));
  await page.evaluate(text=>{void window.__app.importBytes(new TextEncoder().encode(text),'换写重读.txt');},remappedFile);
  await page.locator('.slash-import-box .slash-score-preview svg').waitFor(); await confirmImport();
  check('rewritten symbol mapping survives save and reopen',JSON.stringify((await events()).attacks)===JSON.stringify(model.attacks)
    && (await events()).options.symbolDurations['.']===32);
  await open('AB*~CD*~EF*****\n'); await meter(4); await waitConversion();
  check('arbitrary source symbols receive equivalent inference',await mapping('*').inputValue()==='8' && await mapping('~').inputValue()==='16' && await page.locator('[data-add-slashes-symbol]').count()===2);
  await mapping('~').selectOption('8'); await meter(3);
  check('meter edits preserve user timing choices',await mapping('~').inputValue()==='8');
  await field('analyze').click();
  check('analysis proposes without overwriting',await page.locator('[data-add-slashes-proposal]').count()>0 && await mapping('~').inputValue()==='8');
  await mapping('~').selectOption(''); await page.waitForFunction(() => document.querySelector('[data-add-slashes="confirm"]').disabled);
  check('unassigned source symbol blocks conversion',(await field('errors').textContent()).includes('~'));
  await field('source').fill('AB@CD@EF@GH@\n'); await page.waitForFunction(() => document.querySelectorAll('[data-add-slashes-symbol]').length===1);
  check('source edits update discovered symbol inventory',await mapping('@').inputValue()===''); await page.keyboard.press('Escape');
  await open('E-T-\nVNAY-=R=-E-BMSW-J-W-Y-\n'); await mapping('-').selectOption('8'); await mapping('=').selectOption('16');
  await meter(4); await secondStep(); await confirmImport(); model=await events();
  check('short first row keeps opening rest fill',!model.pickup && model.attacks[0].at===3 && model.attacks[1].at===3.5 && model.attacks[2].at===4);
  check('following bar timing preserved',model.attacks.length===9 && JSON.stringify(model.attacks.slice(2).map(e=>e.at))==='[4,4.75,5.5,6,6.5,7,7.5]');
  await page.locator('#btn-file-menu').click(); await page.locator('#btn-add-slashes').click(); await page.locator('.add-slashes-dialog').waitFor();
  await field('source').fill('(AB)(CD)(EF)(GH)\n'); await field('note-division').selectOption('4'); await field('adjacent-chord').uncheck(); await meter(4); await waitConversion();
  check('manual tool preserves original parentheses',(await field('preview').inputValue()).replaceAll('/','')==='(AB)(CD)(EF)(GH)\n');
  await page.setViewportSize({width:600,height:900}); await shot('import-preview-narrow.png');
  check('narrow conversion window fits viewport',await page.locator('.add-slashes-dialog').evaluate(el=>el.getBoundingClientRect().right<=innerWidth+1));
  check('narrow controls retain full height above preview',await page.evaluate(()=>document.querySelector('.add-slashes-score').getBoundingClientRect().top>=document.querySelector('.add-slashes-controls').getBoundingClientRect().bottom-1));
  await secondStep(); await shot('import-settings-narrow.png');
  check('narrow settings window fits viewport',await page.locator('.slash-import-box').evaluate(el=>el.getBoundingClientRect().right<=innerWidth+1));
  await confirmImport(); model=await events();
  check('intrinsic chord durations remain simultaneous',model.attacks.length===4 && model.attacks.every((e,i)=>e.at===i && e.pitches.length===2 && e.durations.every(v=>v===1)));
  await page.setViewportSize({width:1440,height:1040});
  await page.evaluate(() => { void window.__app.importBytes(new TextEncoder().encode('键盘谱\nA../B../C../D../\n'),'原有斜杠.txt'); });
  await page.locator('.slash-import-box .slash-score-preview svg').waitFor(); const meterBefore=await page.locator('.midi-meter-control input').inputValue();
  await page.locator('.slash-symbol-row select').first().selectOption('16');
  check('existing slash import meter stable after edits',await page.locator('.midi-meter-control input').inputValue()===meterBefore);
  await page.locator('.slash-import-box').getByRole('button',{name:'取消',exact:true}).click();
  const beforeOtherImports=await currentText();
  await page.evaluate(()=>{
    const midi=Uint8Array.from([77,84,104,100,0,0,0,6,0,0,0,1,1,224,77,84,114,107,0,0,0,20,
      0,255,81,3,7,161,32,0,144,60,64,131,96,128,60,0,0,255,47,0]);
    void window.__app.importBytes(midi,'背景点击.mid');
  });
  await page.locator('.midi-import-box').waitFor(); await outsideIsInactive('.midi-import-box');
  await page.locator('.midi-import-box .modal-footer').getByRole('button',{name:'取消',exact:true}).click();
  check('MIDI explicit cancel restores background without changing document',await currentText()===beforeOtherImports
    && !await page.locator('#btn-file-menu').evaluate(el=>!!el.closest('[inert]')));
  await page.evaluate(()=>{
    const xml='<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>';
    void window.__app.importBytes(new TextEncoder().encode(xml),'背景点击.musicxml');
  });
  await page.locator('.midi-import-box').waitFor(); await outsideIsInactive('.midi-import-box');
  await page.locator('.midi-import-box .modal-footer').getByRole('button',{name:'取消',exact:true}).click();
  check('MusicXML explicit cancel restores background without changing document',await currentText()===beforeOtherImports
    && !await page.locator('#btn-file-menu').evaluate(el=>!!el.closest('[inert]')));
  check('no browser runtime errors',errors.length===0); console.log(JSON.stringify({ok:true,results},null,2));
} catch(error) { console.error(JSON.stringify({results,errors,model:await events(),dialog:await page.locator('.add-slashes-dialog').textContent({timeout:1000}).catch(()=>null)},null,2)); throw error; }
finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
