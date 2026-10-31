import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { launchSaveCheckBrowser, installSavePickerTestBridge } from './browser-save-test-helpers.mjs';

// Uses actual SVG text metrics, screenshots and real keyboard/mouse input.
// Only the operating-system file chooser is replaced; exporters still create
// their actual files. BROWSER_TYPE/BROWSER_EXECUTABLE_PATH select a local engine.
const dist=resolve(process.env.APP_TEST_DIST ?? 'dist');
const output=resolve(process.env.APP_TEST_OUTPUT ?? 'artifacts/notation-update');
const mode=process.env.EXPECT_BASELINE === '1' ? 'baseline' : 'fixed';
const scope=process.argv[2] ?? 'all';
assert(['all','arpeggio','multi','save'].includes(scope), 'scope must be all, arpeggio, multi or save');
const voice='\u2063';
const slashOptions={voiceCount:2,braceMode:'arpeggio',parenMode:'chord',symbolDurations:{'.':16}};
const slashText=body=>`键盘谱\n4/4拍：\n点=16分音符\n花括号=琶音\n圆括号=和弦\n${body}..../0..../0..../0..../\n`;
const fixtures=[
 {name:'upper_only',body:`(XB{${voice}G${voice}J${voice}W})`,groups:[{kind:'local',members:[[0,67],[0,71],[0,74]]}]},
 {name:'lower_only',body:`({XB}${voice}G${voice}J${voice}W)`,groups:[{kind:'local',members:[[1,50],[1,55]]}]},
 {name:'all_cross',body:`{XB${voice}G${voice}J${voice}W}`,groups:[{kind:'cross',members:[[0,67],[0,71],[0,74],[1,50],[1,55]]}]},
 {name:'partial_cross',body:`(X{B${voice}G${voice}J}${voice}W)`,groups:[{kind:'cross',members:[[0,67],[0,71],[1,55]]}]},
 {name:'two_local',body:`({XB}{${voice}G${voice}J}${voice}W)`,groups:[{kind:'local',members:[[1,50],[1,55]]},{kind:'local',members:[[0,67],[0,71]]}]},
 {name:'two_cross',body:`({X${voice}G}{B${voice}J}${voice}W)`,groups:[{kind:'cross',members:[[0,67],[1,50]]},{kind:'cross',members:[[0,71],[1,55]]}]},
];
await mkdir(output,{recursive:true});
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.woff2':'font/woff2','.woff':'font/woff','.otf':'font/otf','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const server=createServer(async(req,res)=>{try{
 const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 const file=resolve(dist,path==='/'?'index.html':path.replace(/^\/+/,''));
 if(!file.startsWith(dist+sep)){res.writeHead(403).end();return;}
 res.writeHead(200,{'content-type':mime[extname(file)]??'application/octet-stream'}).end(await readFile(file));
}catch{res.writeHead(404).end();}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const errors=[],results=[];let browser,page,savedFiles,stage='launch';
async function settle(){
 await page.waitForFunction(()=>window.__app.debounceTimer===undefined&&!window.__app.previewDirty);
 await page.evaluate(()=>document.fonts.ready);
 await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
}
async function load(text,format='keyboard',options={}){
 await page.evaluate(({text,format,options})=>{
  const a=window.__app;
  if(a.inputModeEnabled)a.setInputMode(false);
  // Import context must be installed before setText/loadText captures its
  // undo snapshot, exactly as the application's TXT import path does.
  a.documentFormat=format;
  a.slashOptions=format==='jpw'?null:{
   title:'',subtitle:'',composer:'',arranger:'',lyricist:'',instrumentName:'钢琴',
   tempoBpm:90,fifths:0,beats:4,beatType:4,voiceCount:2,
   symbolDurations:{'.':16},spaceDivision:null,noteDivision:null,
   braceMode:'arpeggio',bracketMode:'triplet',parenMode:'chord',
   ...options,kind:format,
  };
  a.loadText(text,format==='jpw'?'fixture.jpwabc':'fixture.txt');
  assertReload(a);
  function assertReload(app){if(!app.reload(app.getText()))throw new Error('fixture failed to parse');}
  a.setCodePaneCollapsed(true);
  a.setEngravingStyle({...a.engravingStyle,contentScale:1,measuresPerSystem:3,connectBarlines:false,rhythmicSpacingEnabled:true},false);
  a.setRhythmEditDivision(16);a.setInputDurationDivision(16);a.resetDocumentUndo();
  a.scorePane.focus({preventScroll:true});
 },{text,format,options});
 await settle();
}
function model(){
 const a=window.__app,s=a.painter.score;
 const num=x=>x?.toString?.()??null;
 const notes=s.parts.flatMap((p,part)=>p.measures.flatMap(m=>m.entries.flatMap(c=>(c.notes??[]).map(n=>({
  part,measure:m.index,at:num(c.position),duration:num(c.duration),pitch:n.pitch,degree:n.number,rest:n.rest,
  tiePrev:!!n.tiePrev,tieNext:!!n.tieNext,generated:!!c.generatedTimingContinuation,gray:!!c.transparentContinuation,
  arpeggio:c.arpeggio,pitches:c.arpeggioPitches,groups:c.arpeggioPitchGroups,
 })))));
 const events=s.parts.flatMap((p,part)=>p.measures.flatMap(m=>m.entries.flatMap(c=>(c.notes??[]).filter(n=>!n.rest&&!n.tiePrev).map(n=>{
  let tail=n;const visited=new Set([n]);
  while(tail.tieNext){if(visited.has(tail.tieNext))throw new Error('cyclic note tie');tail=tail.tieNext;visited.add(tail);}
  return {part,at:n.absoluteTick.toString(),duration:tail.absoluteTick.plus(tail.chord.duration).minus(n.absoluteTick).toString(),pitch:n.pitch};
 }))));
 events.sort((a,b)=>a.part-b.part||a.at.localeCompare(b.at)||a.pitch-b.pitch||a.duration.localeCompare(b.duration));
 const cross=s.crossPartArpeggios.map(mark=>JSON.parse(JSON.stringify(mark,(_k,v)=>v&&typeof v==='object'&&v.toFloat?v.toString():v)));
 return {text:a.getText(),format:a.documentFormat,options:a.slashOptions,notes,events,cross,diagnostics:a._slashTimingDiagnostics,
  targets:a._input.targets,selected:a._selectedNotes.map(x=>({part:x.source.partIndex,at:num(x.visualNote.chord.position),pitch:x.visualNote.pitch})),
  status:document.querySelector('#status')?.textContent};
}
async function arpeggioSnapshot(dir){
 await mkdir(dir,{recursive:true});await settle();
 const s=await page.evaluate(model);
 const geom=await page.evaluate(()=>{
  const a=window.__app,p=a.painter;
  const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
  const waves=[...document.querySelectorAll('#score-pane .jianpu-arpeggio,#score-pane .jianpu-cross-part-arpeggio')].map(e=>({kind:e.classList.contains('jianpu-cross-part-arpeggio')?'cross':'local',...rect(e)}));
  const vertical=[...document.querySelectorAll('#score-pane svg line')].filter(e=>{
   const x1=Number(e.getAttribute('x1')),x2=Number(e.getAttribute('x2'));
   const st=getComputedStyle(e);return Math.abs(x1-x2)<0.05&&st.stroke!=='none'&&Number(st.opacity)>0&&Number(st.strokeOpacity)>0&&rect(e).height>10;
  }).map(rect);
  const boxes=[];
  for(let part=0;part<p.score.parts.length;part++)for(const c of p.score.parts[part].measures[0]?.entries??[])for(const n of c.notes??[]){
   if(n.rest||c.position.toString()!=='0')continue;
   const g=p.noteGroupEls(c,n)[0];if(!g)continue;
   const item=p.pageItemForTarget(g.element),b=item.bound,ctm=g.element.getScreenCTM();
   const tl=new DOMPoint(b.left,b.top).matrixTransform(ctm),br=new DOMPoint(b.right,b.bottom).matrixTransform(ctm);
   boxes.push({part,pitch:n.pitch,left:tl.x,top:tl.y,right:br.x,bottom:br.y});
  }
  const collisions=waves.flatMap((w,wi)=>vertical.filter(v=>v.right>w.left+0.1&&v.left<w.right-0.1&&v.bottom>w.top&&v.top<w.bottom).map(v=>({wave:wi,line:v})));
  return {waves,vertical,notes:boxes,collisions,svg:document.querySelector('#score-pane svg')?.outerHTML};
 });
 await writeFile(join(dir,'model.json'),JSON.stringify(s,null,2));
 await writeFile(join(dir,'geometry.json'),JSON.stringify({...geom,svg:undefined},null,2));
 await writeFile(join(dir,'page.svg'),geom.svg??'');
 await page.locator('#score-pane').screenshot({path:join(dir,'preview.png')});
 return {model:s,geometry:{...geom,svg:undefined}};
}
// Find a genuinely painted pixel in a screenshot of the SVG note, avoiding
// the centre of a hollow numeral or the editor's transparent hit rectangle.
async function paintedNotePoint(part,at,pitch){
 const box=await page.evaluate(({part,at,pitch})=>{
  const a=window.__app,x=a._sourceNotes.find(x=>x.partIndex===part&&x.chord.measure.index===0&&x.chord.position.toString()===at&&x.note.pitch===pitch&&!x.note.rest);
  if(!x)throw new Error(`missing note ${part}/${at}/${pitch}`);
  const el=a.painter.noteGroupEls(x.chord,x.note)[0].element;el.scrollIntoView({block:'nearest',inline:'nearest'});
  const item=a.painter.pageItemForTarget(el),b=item.bound,m=el.getScreenCTM();
  const p1=new DOMPoint(b.left,b.top).matrixTransform(m),p2=new DOMPoint(b.right,b.bottom).matrixTransform(m);
  return {x:Math.floor(p1.x),y:Math.floor(p1.y),width:Math.ceil(p2.x)-Math.floor(p1.x),height:Math.ceil(p2.y)-Math.floor(p1.y)};
 },{part,at,pitch});
 const shot=join(output,'ink-target.png');const png=await page.screenshot({path:shot,clip:box});
 const ink=await page.evaluate(async base64=>{
  // Decode the already-rendered screenshot. Canvas is only a bitmap reader;
  // all score rendering and font measurement still use the real SVG engine.
  const raster=new Image();raster.src='data:image/png;base64,'+base64;await raster.decode();
  const canvas=document.createElement('canvas');canvas.width=raster.width;canvas.height=raster.height;
  const context=canvas.getContext('2d');context.drawImage(raster,0,0);
  const {data}=context.getImageData(0,0,canvas.width,canvas.height);let best=null,bestDistance=Infinity;
  for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
   const i=(y*canvas.width+x)*4,rgb=[data[i],data[i+1],data[i+2]];
   if(Math.max(...rgb)>=240||Math.min(...rgb)>=180)continue;
   const distance=(x-(canvas.width-1)/2)**2+(y-(canvas.height-1)/2)**2;
   if(distance<bestDistance){bestDistance=distance;best={x:x+.5,y:y+.5};}
  }
  if(!best)throw new Error('No visible note ink in screenshot');return best;
 },png.toString('base64'));
 return {x:box.x+ink.x,y:box.y+ink.y};
}
async function select(specs){
 for(let i=0;i<specs.length;i++){
  const p=await paintedNotePoint(...specs[i]);
  if(i)await page.keyboard.down('Control');
  await page.mouse.click(p.x,p.y);
  if(i)await page.keyboard.up('Control');
 }
 assert.equal((await page.evaluate(model)).selected.length,specs.length,'real painted clicks must select every requested note');
 await page.keyboard.press('n');
 assert.equal((await page.evaluate(model)).targets.length,specs.length,'N must preserve all selected targets');
}
function memberKey(members){return members.map(([part,pitch])=>`${part}:${pitch}`).sort().join(',');}
function actualGroups(snapshot){
 const model=snapshot.model,local=[],seen=new Set();
 for(const n of model.notes){
  if(!n.arpeggio||n.rest||n.at!=='0'||n.measure!==0)continue;
  const key=String(n.part);if(seen.has(key))continue;seen.add(key);
  const groups=n.groups?.length?n.groups:[n.pitches??model.notes.filter(x=>x.part===n.part&&!x.rest&&x.at==='0').map(x=>x.pitch)];
  for(const group of groups)local.push({kind:'local',members:group.map(pitch=>[n.part,pitch])});
 }
 return [...local,...model.cross.map(mark=>({kind:'cross',members:mark.pitches.map(x=>[x.part,x.pitch])}))]
  .map(group=>`${group.kind}/${memberKey(group.members)}`).sort();
}
function geometryChecks(snapshot,expected){
 const g=snapshot.geometry,available=[...g.waves];
 const members=actualGroups(snapshot).join('|')===expected.map(x=>`${x.kind}/${memberKey(x.members)}`).sort().join('|');
 let exactExtents=true,leftOfNotes=true;
 for(const group of expected){
  const selected=g.notes.filter(n=>group.members.some(([part,pitch])=>n.part===part&&n.pitch===pitch));
  const centers=selected.map(n=>(n.top+n.bottom)/2);
  const index=available.findIndex(w=>w.kind===group.kind&&centers.every(y=>y>=w.top&&y<=w.bottom));
  if(index<0){exactExtents=false;continue;}
  const wave=available.splice(index,1)[0];
  leftOfNotes&&=selected.every(n=>wave.right<n.left);
  // Notes outside the member range must not be enclosed by the wave. Notes
  // vertically between two selected members are naturally passed by a span.
  const low=Math.min(...centers),high=Math.max(...centers);
  for(const n of g.notes){
   if(group.members.some(([part,pitch])=>n.part===part&&n.pitch===pitch))continue;
   const y=(n.top+n.bottom)/2;
   if(y<low||y>high)exactExtents&&=y<wave.top||y>wave.bottom;
  }
 }
 return {members,waveCount:g.waves.length===expected.length,exactExtents,leftOfNotes,noBarlineCollision:g.collisions.length===0};
}
async function runArpeggio(){
 for(const fixture of fixtures)for(const connected of [false,true])for(const rhythmic of [true,false]){
  stage=`${fixture.name}-${connected?'connected':'separate'}-${rhythmic?'rhythmic':'legacy'}`;
  await load(slashText(fixture.body),'keyboard',slashOptions);
  await page.evaluate(({connected,rhythmic})=>window.__app.setEngravingStyle({...window.__app.engravingStyle,connectBarlines:connected,rhythmicSpacingEnabled:rhythmic},false),{connected,rhythmic});
  const parsed=await arpeggioSnapshot(join(output,stage,'parsed'));
  const checks=geometryChecks(parsed,fixture.groups);
  if(mode==='fixed')assert(Object.values(checks).every(Boolean),JSON.stringify({stage,checks,geometry:parsed.geometry}));
  results.push({stage,checks,model:parsed.model,geometry:parsed.geometry});
 }
 // Actual application serialization, followed by an unrelated note edit and
 // a fresh reopen, must retain exactly the selected arpeggio members.
 for(const name of ['partial_cross','two_local','two_cross']){
  const fixture=fixtures.find(x=>x.name===name);stage=name+'-edit-roundtrip';
  await load(slashText(fixture.body),'keyboard',slashOptions);
  const before=await page.evaluate(model);
  await select([[0,'0',74]]);await page.keyboard.press('Control+ArrowUp');await settle();
  const changed=await arpeggioSnapshot(join(output,stage,'edited'));
  assert.deepEqual(actualGroups(changed),fixture.groups.map(x=>`${x.kind}/${memberKey(x.members)}`).sort(),'editing excluded W must not enlarge an arpeggio');
  const exported=await page.evaluate(()=>Array.from(window.__app.exportTextDocument('jpw').bytes));
  assert(exported.length>0,'JPW export must contain document bytes');
  await page.keyboard.press('Control+z');await page.waitForFunction(text=>window.__app.getText()===text,before.text);await settle();
  assert.deepEqual((await page.evaluate(model)).events,before.events,'undo must restore the unselected-note edit');
  await load(changed.model.text,'keyboard',changed.model.options);const reopened=await arpeggioSnapshot(join(output,stage,'reopened'));
  assert.deepEqual(actualGroups(reopened),actualGroups(changed));
  assert(Object.values(geometryChecks(reopened,fixture.groups)).every(Boolean));
  const jpw=Buffer.from(exported).subarray(2).toString('utf16le');
  await load(jpw,'jpw');const jpwReopened=await arpeggioSnapshot(join(output,stage,'jpw'));
  assert.deepEqual(actualGroups(jpwReopened),actualGroups(changed),'JPW must retain each exact arpeggio group');
  await page.evaluate(()=>window.__app.changeDocumentFormat('number'));await settle();
  const number=await arpeggioSnapshot(join(output,stage,'number'));
  assert.deepEqual(actualGroups(number),actualGroups(changed),'format conversion must retain each exact arpeggio group');
  results.push({stage,checks:{editPreservesGroups:true,undo:true,reopen:true,jpw:true,number:true}});
 }
}
function expectedEdit(before,specs,kind){
 const keys=new Set(specs.map(([part,_at,pitch])=>`${part}:${pitch}`));
 return before.events.map(n=>{
  if(n.at!=='0'||!keys.has(`${n.part}:${n.pitch}`))return n;
  if(kind==='shorten')return {...n,duration:n.part===0?'3/4':'1/4'};
  if(kind==='extend')return {...n,duration:n.part===0?'1':'3/4'};
  if(kind==='preset')return {...n,duration:'1/2'};
  if(kind==='move')return {...n,at:'1/4'};
  return n;
 }).sort((a,b)=>a.part-b.part||a.at.localeCompare(b.at)||a.pitch-b.pitch||a.duration.localeCompare(b.duration));
}
async function runMulti(){
 const full='.Title\nTitle = {同拍多选回归}\nKeyAndMeters = {1=C,4/4}\n.Voice.RH\n[135] 2 0 0 |]\n.Voice.LH\n[246]_ 0_ 0 0 0 |]\n';
 const movable='.Title\nTitle = {同拍移动回归}\nKeyAndMeters = {1=C,4/4}\n.Voice.RH\n[135]_ 0_ 0 0 0 |]\n.Voice.LH\n[246]_ 0_ 0 0 0 |]\n';
 const specs=[[0,'0',60],[0,'0',64],[1,'0',62]];
 for(const format of ['jpw','keyboard'])for(const kind of ['shorten','extend','move','preset']){
  stage=`${format}-${kind}`;
  await load(kind==='move'?movable:full,'jpw');
  if(format==='keyboard'){await page.evaluate(()=>window.__app.changeDocumentFormat('keyboard'));await settle();await page.evaluate(()=>window.__app.resetDocumentUndo());}
  await select(specs);const before=await page.evaluate(model);
  if(kind==='preset'){
   const point=await paintedNotePoint(1,'0',62);
   await page.mouse.click(point.x,point.y,{button:'right'});
   await page.getByRole('menuitem',{name:'8分音符',exact:true}).click();
  }else await page.keyboard.press(kind==='shorten'?'Control+ArrowLeft':kind==='extend'?'Control+ArrowRight':'Alt+ArrowRight');
  await settle();const after=await page.evaluate(model);
  const expected=expectedEdit(before,specs,kind);
  const checks={allTargets:after.targets.length===specs.length,exactNoteEnds:JSON.stringify(after.events)===JSON.stringify(expected)};
  if(mode==='fixed')assert(Object.values(checks).every(Boolean),JSON.stringify({stage,checks,before:before.events,after:after.events,expected,status:after.status}));
  await writeFile(join(output,stage+'.json'),JSON.stringify({before,after,checks},null,2));
  if(mode==='fixed'){
   await page.keyboard.press('Control+z');await page.waitForFunction(text=>window.__app.getText()===text,before.text);await settle();
   assert.deepEqual((await page.evaluate(model)).events,before.events,'one undo must restore all members');
   await page.keyboard.press('Control+Shift+z');await page.waitForFunction(text=>window.__app.getText()===text,after.text);await settle();
   assert.deepEqual((await page.evaluate(model)).events,after.events,'one redo must restore all members');
   await load(after.text,format,after.options);assert.deepEqual((await page.evaluate(model)).events,after.events,'reopen must keep selected and unselected note ends');
   await page.locator('#score-pane').screenshot({path:join(output,stage+'-reopened.png')});
   if(kind==='move'){
    await select(specs.map(([part,_at,pitch])=>[part,'1/4',pitch]));
    await page.keyboard.press('Alt+ArrowLeft');await settle();
    assert.deepEqual((await page.evaluate(model)).events,before.events,'opposite move must return every selected note without shortening others');
   }
   checks.undo=true;checks.redo=true;checks.reopen=true;
  }
  results.push({stage,checks});
 }
 for(const format of ['jpw','keyboard']){
  stage=`${format}-move-cross-arpeggio`;
  await load(movable,'jpw');
  if(format==='keyboard'){await page.evaluate(()=>window.__app.changeDocumentFormat('keyboard'));await settle();}
  await select([[0,'0',60]]);const point=await paintedNotePoint(0,'0',60);
  await page.mouse.click(point.x,point.y,{button:'right'});
  await page.getByRole('menuitem',{name:'跨谱行琶音',exact:true}).click();await settle();
  await page.evaluate(()=>{window.__app.setInputMode(false);window.__app.resetDocumentUndo();});
  const all=[[0,'0',60],[0,'0',64],[0,'0',67],[1,'0',62],[1,'0',65],[1,'0',69]];
  await select(all);const before=await page.evaluate(model);assert.equal(before.cross.length,1);
  await page.keyboard.press('Alt+ArrowRight');await settle();
  const moved=await arpeggioSnapshot(join(output,stage,'moved'));
  assert.deepEqual(moved.model.events,expectedEdit(before,all,'move'));
  assert.equal(moved.model.cross.length,1);assert.equal(moved.model.cross[0].offset,'1/4');
  assert.deepEqual(moved.model.cross[0].pitches,before.cross[0].pitches);
  assert.equal(moved.geometry.waves.filter(w=>w.kind==='cross').length,1,'moving all members must move the visible arpeggio too');
  await page.keyboard.press('Control+z');await page.waitForFunction(text=>window.__app.getText()===text,before.text);await settle();
  assert.deepEqual((await page.evaluate(model)).events,before.events);assert.equal((await page.evaluate(model)).cross[0].offset,'0');
  await load(moved.model.text,format,moved.model.options);
  const reopened=await arpeggioSnapshot(join(output,stage,'reopened'));
  assert.equal(reopened.geometry.waves.filter(w=>w.kind==='cross').length,1);
  assert.equal(reopened.model.cross[0].offset,'1/4');
  results.push({stage,checks:{membersMoveTogether:true,arpeggioMoves:true,undo:true,reopen:true}});
 }
}
async function runSave(){
 stage='save-ctrl-s';
 const fixture='.Title\nTitle = {选址保存回归}\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 |]\n';
 await load(fixture,'jpw');
 const initialCount=await page.evaluate(()=>window.__testSavePickerEvents.length);
 for(const focus of ['text','selection','input','toolbar']){
  stage='ctrl-s-'+focus;
  await page.evaluate(focus=>{
   const a=window.__app;if(a.inputModeEnabled)a.setInputMode(false);
   a.setText(a.getText()+`// ${focus} saved\n`);
   if(focus==='text'){a.setCodePaneCollapsed(false);a.view.focus();}
   else if(focus==='toolbar')document.querySelector('#btn-export').focus();
   else {a.setCodePaneCollapsed(true);if(focus==='input')a.setInputMode(true);a.scorePane.focus();}
  },focus);
  await settle();const current=await page.evaluate(()=>window.__app.getText());
  const written=savedFiles.next();await page.keyboard.press('Control+s');const file=await written;
  const bytes=await readFile(await file.path());
  assert.deepEqual([...bytes.subarray(0,2)],[255,254]);
  assert.equal(bytes.subarray(2).toString('utf16le'),current,'Ctrl+S must write the actual current score');
  await page.waitForFunction(()=>!window.__app.hasUnsavedChanges());
  assert.equal(await page.evaluate(()=>window.__testSavePickerEvents.length),initialCount+1,'subsequent saves reuse the formal target');
  results.push({stage,checks:{actualBytes:true,dirtyCleared:true,targetReused:true}});
 }
 // Export has its own target and may never replace Ctrl+S's score destination.
 stage='export-target-independent';
 await page.locator('#btn-export').click();const midiSaved=savedFiles.next();
 await page.locator('.modal-box button').getByText('MIDI',{exact:true}).click();
 const midi=await midiSaved;const midiBytes=await readFile(await midi.path());
 assert.equal(midiBytes.subarray(0,4).toString('ascii'),'MThd');assert(midi.suggestedFilename().endsWith('.mid'));
 await page.evaluate(()=>{const a=window.__app;a.setText(a.getText()+'// after MIDI export\n');a.scorePane.focus();});await settle();
 const scoreSaved=savedFiles.next();await page.keyboard.press('Control+s');const document=await scoreSaved;
 assert(document.suggestedFilename().endsWith('.jpwabc'));
 assert.equal(await page.evaluate(()=>window.__testSavePickerEvents.length),initialCount+2);
 await page.waitForFunction(()=>!window.__app.hasUnsavedChanges());
 results.push({stage,checks:{midiBytes:true,documentTargetPreserved:true}});
 stage='ctrl-shift-s-copy';
 await page.evaluate(()=>{const a=window.__app;a.setText(a.getText()+'// copy stays dirty\n');a.scorePane.focus();});await settle();
 const copySaved=savedFiles.next();await page.keyboard.press('Control+Shift+s');await copySaved;
 assert(await page.evaluate(()=>window.__app.hasUnsavedChanges()),'saving an independent copy must preserve formal dirty state');
 assert.equal(await page.evaluate(()=>window.__testSavePickerEvents.length),initialCount+3);
 results.push({stage,checks:{saveAs:true,formalDirtyPreserved:true}});
}
try{
 browser=await launchSaveCheckBrowser();
 page=await browser.newPage({viewport:{width:1600,height:1050},deviceScaleFactor:1});
 savedFiles=await installSavePickerTestBridge(page);
 page.on('pageerror',e=>errors.push({stage,error:e.message}));
 page.on('console',m=>{if(m.type()==='error')errors.push({stage,error:m.text()});});
 await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'networkidle'});
 await page.waitForFunction(()=>window.__app&&document.querySelector('#score-pane svg'));
 if(scope==='all'||scope==='arpeggio')await runArpeggio();
 if(scope==='all'||scope==='multi')await runMulti();
 if(scope==='all'||scope==='save')await runSave();
 savedFiles.assertNoDownloads();
 await writeFile(join(output,'results.json'),JSON.stringify({mode,scope,dist,browser:browser.version(),results,errors},null,2));
 assert.equal(errors.length,0,JSON.stringify(errors));
 console.log(JSON.stringify({mode,scope,cases:results.length,errors,output}));
}catch(error){if(page)await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});await writeFile(join(output,'failure.json'),JSON.stringify({stage,error:String(error?.stack??error),results,errors},null,2));throw error;}
finally{if(browser)await browser.close();await new Promise(done=>server.close(done));}
