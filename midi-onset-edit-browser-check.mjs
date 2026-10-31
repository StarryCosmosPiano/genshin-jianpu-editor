// Real Edge regression. Build dist first; the private MIDI is supplied by CLI.
// node midi-onset-edit-browser-check.mjs <accompaniment.mid> [artifact-directory]
// Optional: BROWSER_EXECUTABLE_PATH overrides installed Edge;
// MIDI_BROWSER_EXPLICIT_RESTS_ONLY=1 runs only the default explicit-rest mode.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { acceptFixtureImport } from './browser-test-helpers.mjs';

assert(process.argv[2], 'Usage: node midi-onset-edit-browser-check.mjs <accompaniment.mid> [artifact-directory]');
const midiPath = resolve(process.argv[2]);
const bytes = await readFile(midiPath);
const output = process.argv[3] ? resolve(process.argv[3]) : await mkdtemp(join(tmpdir(), 'midi-onset-edit-'));
await mkdir(output, { recursive: true });
const oraclePath = join(output, 'source-oracle.mjs');
await build({ stdin: { contents: `
  import { parseMidi, analyzeMidi, midiToScore } from './src/midi';
  import { buildTimeline } from './src/score/timeline';
  export function oracle(bytes) {
    const midi = parseMidi(new Uint8Array(bytes));
    const analysis = analyzeMidi(midi);
    const score = midiToScore(midi, { outputFormat:'keyboard', quantize:16,
      detectTriplets:true, handMode:'auto', splitPitch:analysis.splitPitch,
      scoreMode:'hands', fifths:0, beats:4, beatType:4, tempoBpm:analysis.tempoBpm }).score;
    return { ppq:midi.ppq, attacks:midi.notes.length, timeline:buildTimeline(score).notes
      .map(n => ({part:n.part,pitch:n.pitch,start:n.t0,end:n.t1})) };
  }`, resolveDir: process.cwd(), sourcefile: 'midi-browser-oracle.ts' },
  outfile: oraclePath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const source = (await import(pathToFileURL(oraclePath).href)).oracle(bytes);
assert.equal(source.ppq, 480, 'focused fixture PPQ');
assert.equal(source.attacks, 1217, 'focused fixture attack count');
await writeFile(join(output, 'source-oracle.json'), JSON.stringify(source, null, 2));
const round = n => Math.round(n * 1e9) / 1e9;
const ordered = notes => notes.map(n => ({...n, start:round(n.start), end:round(n.end)}))
  .sort((a,b) => a.start-b.start || a.part-b.part || a.pitch-b.pitch || a.end-b.end);
const attacks = notes => ordered(notes).map(({part,pitch,start}) => ({part,pitch,start}));
const root = resolve('dist');
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json',
  '.wasm':'application/wasm','.woff2':'font/woff2','.otf':'font/otf','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const server = createServer(async (request,response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const file = resolve(root, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
    if (!file.startsWith(root+sep)) return response.writeHead(403).end();
    response.writeHead(200, {'content-type':mime[extname(file)] ?? 'application/octet-stream'}).end(await readFile(file));
  } catch { response.writeHead(404).end('not found'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));

function snapshot() {
  const app = window.__app, score = app.painter.score;
  const r = n => Math.round(n * 1e9) / 1e9;
  const timeline = [], invalidWritten = [];
  const describe = chord => {
    const tuplet = chord.notes.find(n => n.tuplet)?.tuplet;
    return {position:r(chord.position.toFloat()),duration:r(chord.duration.toFloat()),
      beams:chord.beams,beats:chord.beats,dot:chord.dot,
      continued:chord.transparentContinuation, generated:chord.generatedTimingContinuation,
      tuplet:tuplet ? {start:r(tuplet.memberChords()[0].position.toFloat()),
        members:tuplet.memberChords().length,numerator:tuplet.ratioNumerator,denominator:tuplet.ratioDenominator} : null,
      notes:chord.notes.map(n => ({pitch:n.pitch,rest:n.rest,tiePrev:!!n.tiePrev,tieNext:!!n.tieNext,
        tieEnd:n.tieEnd,tuplet:!!n.tuplet})).sort((a,b) => a.pitch-b.pitch)};
  };
  for (let part=0;part<score.parts.length;part++) for (const measure of score.parts[part].measures)
    for (const chord of measure.entries) {
      if (!chord.notes?.length) continue;
      const tuplet=chord.notes.find(n => n.tuplet)?.tuplet;
      const written=chord.beats/2**chord.beams*(chord.dot ? 2-2**-chord.dot : 1);
      const actual=written*(tuplet ? tuplet.ratioDenominator/tuplet.ratioNumerator : 1);
      if (Math.abs(actual-chord.duration.toFloat())>1e-8)
        invalidWritten.push({part,measure:measure.index,offset:r(chord.position.toFloat()),written,actual,duration:r(chord.duration.toFloat())});
      for (const note of chord.notes) {
        if (note.rest || note.softDeleted || note.tiePrev || note.tieEnd || chord.generatedTimingContinuation || chord.transparentContinuation) continue;
        let last=note; const seen=new Set();
        while (last.tieNext && !seen.has(last)) {seen.add(last);last=last.tieNext;}
        timeline.push({part,pitch:note.pitch,start:r(measure.position.toFloat()+chord.position.toFloat()),
          end:r(last.chord.measure.position.toFloat()+last.chord.position.toFloat()+last.chord.duration.toFloat())});
      }
    }
  timeline.sort((a,b)=>a.start-b.start || a.part-b.part || a.pitch-b.pitch || a.end-b.end);
  return {format:app.documentFormat,explicitRests:app.slashOptions?.showExplicitRests,
    diagnostics:app._slashTimingDiagnostics,counts:score.parts.map(p=>p.measures.length),
    text:app.getText(),timeline,invalidWritten,
    focus:score.parts[1].measures[94].entries.filter(c=>c.notes?.length).map(describe),
    svgs:document.querySelectorAll('#score-pane svg').length};
}
const failures=[], errors=[], results=[];
let snapshotsChecked=0;
const verify=(label,fn)=>{try {fn();} catch(error){failures.push({label,message:String(error.message)});}};
function inspect(data,label,expected,original) {
  snapshotsChecked++;
  verify(label+': all source attacks',()=>assert.deepEqual(attacks(data.timeline),attacks(expected)));
  verify(label+': attack count',()=>assert.equal(data.timeline.length,expected.length));
  verify(label+': silence',()=>assert.deepEqual(data.timeline.filter(n=>n.part===0&&n.pitch===79&&n.start<3),
    [{part:0,pitch:79,start:1.5,end:2},{part:0,pitch:79,start:2,end:2.5}]));
  verify(label+': diagnostics',()=>assert.deepEqual(data.diagnostics,[]));
  verify(label+': written durations',()=>assert.deepEqual(data.invalidWritten,[]));
  verify(label+': measurable SVG',()=>assert(data.svgs>0));
  verify(label+': m95 eight events',()=>assert.equal(data.focus.length,8));
  verify(label+': m95 second triplet',()=>{
    const group=data.focus.filter(c=>c.position>=3-1e-8);
    assert.equal(group.length,3);
    for(const [i,c] of group.entries()) {
      assert(Math.abs(c.position-(3+i/3))<1e-8);
      assert(Math.abs(c.duration-1/3)<1e-8);
      assert.equal(c.beams,1);assert.equal(c.dot,0);
      assert.deepEqual(c.tuplet,{start:3,members:3,numerator:3,denominator:2});
    }
    assert(group[0].notes.some(n=>n.pitch===55&&!n.tiePrev&&!n.tieEnd));
    const oldG=data.focus.find(c=>Math.abs(c.position-8/3)<1e-8).notes.find(n=>n.pitch===55);
    assert.equal(oldG.tieNext,false);
  });
  if(original) {
    verify(label+': untouched LH timeline',()=>assert.deepEqual(data.timeline.filter(n=>n.part===1),original.timeline.filter(n=>n.part===1)));
    verify(label+': untouched m95 notation',()=>assert.deepEqual(data.focus,original.focus));
    verify(label+': full timeline',()=>assert.deepEqual(ordered(data.timeline),ordered(expected)));
  }
}
let browser,page,stage='launch';
function attach(p,label) {
  p.setDefaultTimeout(30000);
  p.on('pageerror',e=>errors.push({label,message:e.message}));
  p.on('console',m=>{if(m.type()==='error')errors.push({label,message:m.text()});});
  p.on('dialog',async d=>{errors.push({label,message:d.message()});await d.dismiss();});
}
async function ready(label) {
  const p=await browser.newPage({viewport:{width:1800,height:1200},deviceScaleFactor:2});attach(p,label);
  await p.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'networkidle'});
  await p.waitForFunction(()=>window.__app&&document.querySelector('#score-pane svg'));
  return p;
}
async function importBytes(p,input,name,format,rests) {
  await p.evaluate(({input,name})=>{
    window.__onsetDone=null;window.__onsetError=null;
    void window.__app.importBytes(Uint8Array.from(input),name).then(ok=>window.__onsetDone=ok)
      .catch(e=>{window.__onsetDone=false;window.__onsetError=String(e.stack??e);});
  },{input:[...input],name});
  if(format) {
    await p.locator('.midi-import-box').waitFor();
    const select=text=>p.locator('.midi-import-box .modal-row').filter({has:p.locator('span').filter({hasText:new RegExp(`^${text}$`)})}).locator('select');
    await select('推荐量化').selectOption('16');await select('导入后格式').selectOption(format);
    await p.getByLabel('保留 0 休止符',{exact:true}).setChecked(rests);
    await acceptFixtureImport(p,p.getByRole('button',{name:'导入并转为简谱',exact:true}));
  } else {
    await p.locator('.slash-import-box').waitFor();
    await acceptFixtureImport(p,p.getByRole('button',{name:'导入为 2 声部简谱',exact:true}));
  }
  await p.waitForFunction(()=>window.__onsetDone!==null,null,{timeout:60000});
  assert(await p.evaluate(()=>window.__onsetDone),await p.evaluate(()=>window.__onsetError));
  await p.evaluate(()=>document.fonts.ready);
}
async function capture(p,path) {
  await p.evaluate(()=>{
    const app=window.__app;app.setEngravingStyle({...app.engravingStyle,measuresPerSystem:3},false);
    const chord=app.painter.score.parts[1].measures[94].entries.find(c=>c.notes?.length);
    app.painter.chordGroupEl(chord).scrollIntoView({block:'center'});
  });
  await p.screenshot({path});
  const clip=await p.evaluate(()=>{
    const painter=window.__app.painter,bounds=[];
    for(const part of painter.score.parts) for(const i of [93,94]) for(const chord of part.measures[i].entries) {
      if(!chord.notes?.length) continue;
      const rect=painter.chordGroupEl(chord)?.getBoundingClientRect();
      if(rect?.width&&rect?.height) bounds.push(rect);
    }
    const x=Math.max(0,Math.min(...bounds.map(r=>r.left))-35),y=Math.max(0,Math.min(...bounds.map(r=>r.top))-50);
    return {x,y,width:Math.min(innerWidth,Math.max(...bounds.map(r=>r.right))+35)-x,
      height:Math.min(innerHeight,Math.max(...bounds.map(r=>r.bottom))+35)-y};
  });
  await p.screenshot({path:path.replace(/\.png$/,'-focus.png'),clip});
}
async function settle(p) {
  await p.waitForFunction(()=>window.__app.debounceTimer===undefined&&!window.__app.previewDirty);
}
async function edit(p,measure,directory,key='6') {
  if(await p.evaluate(()=>window.__app.interactionMode)!=='select') await p.locator('#btn-select-mode').click();
  const target=await p.evaluate(index=>{
    const app=window.__app;
    const entry=app._sourceNotes.find(s=>s.partIndex===0&&s.chord.measure.index===index&&!s.note.rest&&!s.note.tiePrev&&!s.note.tieNext&&!s.note.tieEnd&&s.note.number!=='6');
    if(!entry) return {error:'No untied RH target',sources:app._sourceNotes.slice(0,3).map(s=>Object.keys(s))};
    const rendered=app.painter.noteGroupEls(entry.chord,entry.note)[0];
    rendered.element.scrollIntoView({block:'center'});
    const rect=rendered.element.getBoundingClientRect();
    return {x:rect.x+rect.width/2,y:rect.y+rect.height/2,part:0,pitch:entry.note.pitch,
      start:entry.chord.measure.position.toFloat()+entry.chord.position.toFloat(),
      end:entry.chord.measure.position.toFloat()+entry.chord.position.toFloat()+entry.chord.duration.toFloat()};
  },measure);
  assert(!target.error,JSON.stringify(target));
  await p.mouse.click(target.x,target.y);
  assert.equal(await p.evaluate(()=>window.__app._selectedNotes.length),1,'rendered note selection');
  await p.locator('#btn-input-mode').click();
  assert(await p.evaluate(()=>window.__app._input.enabled),'toolbar enters real input mode');
  // Explicit 0 inserts the chosen entry duration. Choose one quarter to
  // replace the entire m95 opening G4, matching the reported 5→0 edit.
  if(key==='0') await p.locator('[data-input-duration-division="4"]').click();
  const before=await p.evaluate(()=>window.__app.getText());
  await p.keyboard.press(key);
  await p.waitForFunction(previous=>window.__app.getText()!==previous,before);
  await settle(p);
  await writeFile(join(directory,`during-input-m${measure+1}-key${key}.json`),JSON.stringify(await p.evaluate(snapshot),null,2));
  const changed=await p.evaluate(({measure,start})=>{
    const app=window.__app,focus=app.inputFocus();
    const chord=app.painter.score.parts[0].measures[measure].entries.find(c=>c.notes?.length
      &&Math.abs(c.measure.position.toFloat()+c.position.toFloat()-start)<1e-8);
    return {pitch:focus?.note.pitch,rest:chord?.notes.every(n=>n.rest)};
  },{measure,start:target.start});
  if(key==='0') assert(changed.rest,'actual keyboard rest edit');
  else assert.notEqual(changed.pitch,target.pitch,'actual keyboard pitch edit');
  return {...target,newPitch:key==='0'?null:changed.pitch};
}
try {
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH
    ? {executablePath:process.env.BROWSER_EXECUTABLE_PATH} : {channel:'msedge'})});
  for(const format of ['keyboard','number']) for(const rests of process.env.MIDI_BROWSER_EXPLICIT_RESTS_ONLY ? [true] : [true,false]) {
    const label=`${format}-${rests?'rests':'hidden'}`;const directory=join(output,label);await mkdir(directory,{recursive:true});
    for(const {measure,key} of [{measure:1,key:'6'},{measure:94,key:'6'},{measure:94,key:'0'}]) {
      const caseId=`m${measure+1}-key${key}`;
      // Each action starts from a fresh real MIDI import; prior cursor,
      // finalization history and duration preferences cannot pollute it.
      stage=label+`: import-${caseId}`;page=await ready(label);await importBytes(page,bytes,basename(midiPath),format,rests);
      const original=await page.evaluate(snapshot);inspect(original,stage,source.timeline);
      verify(label+': import options',()=>{assert.equal(original.format,format);assert.equal(original.explicitRests,rests);});
      await writeFile(join(directory,`import-${caseId}.json`),JSON.stringify(original,null,2));
      await capture(page,join(directory,`before-${caseId}.png`));
      stage=label+`: edit-${caseId}`;
      const target=await edit(page,measure,directory,key);
      const expected=original.timeline.flatMap(n=>n.part===target.part&&n.pitch===target.pitch&&Math.abs(n.start-target.start)<1e-8
        ? target.newPitch===null?[]:[{...n,pitch:target.newPitch}] :[n]);
      const edited=await page.evaluate(snapshot);inspect(edited,stage,expected,original);
      await writeFile(join(directory,`edited-${caseId}.json`),JSON.stringify(edited,null,2));await capture(page,join(directory,`after-edit-${caseId}.png`));
      await page.locator('#btn-undo').click();
      await settle(page);
      inspect(await page.evaluate(snapshot),label+`: undo-${caseId}`,original.timeline,original);
      await page.locator('#btn-redo').click();
      await settle(page);
      inspect(await page.evaluate(snapshot),label+`: redo-${caseId}`,expected,original);
      // Leaving input is an independent user action and may have its own
      // undo entry. Verify its musical result after testing note undo/redo.
      await page.locator('#score-pane').focus();
      await page.keyboard.press('Escape');
      await settle(page);
      const exited=await page.evaluate(snapshot);
      // Hidden explicit silence is intentionally filled from the preceding
      // attack on finalization. Only this removed RH quarter rest changes:
      // its previous F4@375 extends from376 to377; LH remains exact.
      if(!rests&&key==='0') {
        assert.equal(target.start,376);assert.equal(target.end,377);
        assert(expected.some(n=>n.part===0&&n.pitch===65&&n.start===375&&n.end===376));
      }
      const finalizedExpected=!rests&&key==='0' ? expected.map(n=>n.part===0
        &&n.pitch===65&&n.start===375&&n.end===376?{...n,end:377}:n) : expected;
      inspect(exited,label+`: exit-input-${caseId}`,finalizedExpected,original);
      await writeFile(join(directory,`exited-${caseId}.json`),JSON.stringify(exited,null,2));
      await capture(page,join(directory,`after-exit-${caseId}.png`));
      const saved=await page.evaluate(()=>[...window.__app.documentBytes()]);await writeFile(join(directory,`saved-${caseId}.txt`),new Uint8Array(saved));
      const fresh=await ready(label+' fresh');
      await fresh.evaluate(()=>window.__app.loadText('.Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n0--- |]',null));
      assert.deepEqual(await fresh.evaluate(()=>({format:window.__app.documentFormat,options:window.__app.slashOptions})),
        {format:'jpw',options:null},'fresh TXT import must not inherit prior slash options');
      await importBytes(fresh,saved,`saved-${caseId}.txt`);
      const reopened=await fresh.evaluate(snapshot);inspect(reopened,label+`: fresh-reopen-${caseId}`,finalizedExpected,original);
      verify(label+': saved options',()=>{assert.equal(reopened.format,format);assert.equal(reopened.explicitRests,rests);});
      await writeFile(join(directory,`reopened-${caseId}.json`),JSON.stringify(reopened,null,2));
      await fresh.close();
      results.push({label,measure:measure+1,key,target,stages:6});
      await page.close();page=null;
    }
  }
  await writeFile(join(output,'results.json'),JSON.stringify({passed:!failures.length&&!errors.length,snapshotsChecked,results,failures,errors},null,2));
  assert.equal(errors.length,0,'browser console/runtime errors (see results.json)');
  assert.equal(failures.length,0,'browser regressions (see results.json)');
  console.log(JSON.stringify({passed:true,output,cases:results.length,snapshotsChecked},null,2));
} catch(error) {
  if(page) await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});
  await writeFile(join(output,'failure.json'),JSON.stringify({stage,message:String(error.stack??error),results,failures,errors},null,2));
  throw error;
} finally {if(browser) await browser.close();await new Promise(done=>server.close(done));}
