'use strict';
const { _electron: electron } = require('playwright-core');
const { saveClipboard, writeClipboard, restoreClipboard } = require('./clipboard-fixture.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'worktool-transfers-')),checks=[],errors=[];
let app,page;
const pass=name=>{checks.push(name);console.log('PASS:',name);};
const action=name=>page.locator(`[data-action="${name}"]`).first().click();
const nav=name=>page.locator(`.nav[data-page="${name}"]`).click();
async function drop(files,selector){
 await page.evaluate(()=>{const previous=document.querySelector('#test-native-input');previous?.remove();const input=document.createElement('input');input.type='file';input.multiple=true;input.id='test-native-input';input.style.display='none';document.body.append(input);});
 await page.locator('#test-native-input').setInputFiles(files);
 await page.evaluate(selector=>{const d=new DataTransfer();for(const f of document.querySelector('#test-native-input').files)d.items.add(f);const zone=document.querySelector(selector);zone.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:d}));zone.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:d}));document.querySelector('#test-native-input').remove();},selector);
}
async function pasteImage(){
 await page.locator('#modal[open] [data-import-drop], #import-drop-zone, .import-banner').first().evaluate(el=>{el.tabIndex=0;el.focus();});
 await page.keyboard.press(process.platform==='darwin'?'Meta+v':'Control+v');
}
(async()=>{
 const env={...process.env,HUB_USER_DATA:path.join(temp,'user-data'),HUB_WORKSPACE:path.join(temp,'workspace')};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({args:[root],env,executablePath:process.env.WORKTOOL_EXECUTABLE||require('electron')});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
 await page.getByRole('heading',{name:'工作概览',exact:true}).waitFor();
 const textFile=path.join(temp,'drag.md');fs.writeFileSync(textFile,'项目名称：拖动项目\n应用名：拖动应用\n包名：com.example.drag\n');
 await nav('import');await drop([textFile],'#import-drop-zone');await page.locator('.import-banner').waitFor();
 assert.equal(await page.locator('#import-0-applicationId').inputValue(),'com.example.drag');
 assert.equal((await page.evaluate(()=>window.hub.load())).revision,0);await action('import-cancel');
 pass('Disk-backed File drag passes through sandbox preload and IPC into local preview');
 await drop([textFile,textFile],'#import-drop-zone');await page.locator('#toast').getByText(/一次拖入一个/).waitFor();assert.equal(await page.locator('.import-banner').count(),0);
 const bad=path.join(temp,'unsupported.pdf');fs.writeFileSync(bad,'synthetic');await drop([bad],'#import-drop-zone');await page.locator('#toast').getByText(/暂不支持/).waitFor();
 pass('Multiple files and unsupported formats are rejected without replacing data');
 await page.evaluate(()=>window.hub.aiSave({model:'LongCat-2.5',apiKey:'synthetic-transfer-key'}));await page.reload();await page.getByRole('heading',{name:'工作概览',exact:true}).waitFor();
 await saveClipboard(app);
 const imagePath=path.join(temp,'project.png');
 await app.evaluate(({nativeImage},file)=>{
   const fs=process.getBuiltinModule('fs'),image=nativeImage.createFromBitmap(Buffer.alloc(640*320*4,255),{width:640,height:320});fs.writeFileSync(file,image.toPNG());globalThis.__transferCalls=0;
   globalThis.fetch=async()=>{globalThis.__transferCalls++;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'项目名称：截图项目\n项目说明：自动填入说明\n代码仓库：https://example.com/drag.git',project:{name:'截图项目',description:'自动填入说明',repo:'https://example.com/drag.git'},records:[],warnings:[]})}}]}));};
 },imagePath);
 await nav('import');
 await writeClipboard(app,{text:'普通文字粘贴验收'});await page.locator('#import-paste').focus();await page.keyboard.press(process.platform==='darwin'?'Meta+v':'Control+v');
 assert.equal(await page.locator('#import-paste').inputValue(),'普通文字粘贴验收');
 await action('import-clipboard');await page.locator('#toast').getByText(/剪贴板中没有图片/).waitFor();
 await writeClipboard(app,{});await action('import-clipboard');await page.locator('#toast').getByText(/剪贴板中没有图片/).waitFor();
 assert.equal(await app.evaluate(()=>globalThis.__transferCalls),0);assert.equal((await page.evaluate(()=>window.hub.load())).revision,0);
 pass('Real text paste works; text-only and empty clipboards show a useful message without contacting AI');
 if(process.platform==='darwin'){
   const tiff=path.join(temp,'screenshot.tiff');require('node:child_process').execFileSync('/usr/bin/sips',['-s','format','tiff',imagePath,'--out',tiff],{stdio:'ignore'});
   await writeClipboard(app,{file:tiff,type:'electron application/osclipboard;format="public.tiff"'});
   await action('import-clipboard');await page.locator('.import-banner').waitFor();
   assert.equal(await page.locator('[name="import-project-name"]').inputValue(),'截图项目');await action('import-cancel');
   await app.evaluate(()=>{globalThis.__transferCalls=0;});
   pass('Native macOS TIFF screenshot is read as PNG through the real Electron clipboard');
 }
 await writeClipboard(app,{file:imagePath});
 await nav('projects');await action('new-project');
 const ordinaryTextAllowed=await page.locator('[name="name"]').evaluate(el=>{const d=new DataTransfer();d.setData('text/plain','ordinary text');const e=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d});el.dispatchEvent(e);return !e.defaultPrevented;});assert(ordinaryTextAllowed);
 await pasteImage();await page.locator('.import-banner').waitFor();assert.equal(await page.locator('[name="import-project-name"]').inputValue(),'截图项目');assert.equal(await page.locator('[name="import-knowledge-repo"]').inputValue(),'');
 await pasteImage();await page.locator('#toast').getByText(/先完成或取消/).waitFor();assert.equal(await app.evaluate(()=>globalThis.__transferCalls),1);await action('import-cancel');
 pass('Real keyboard image paste opens project preview; ordinary text paste is untouched; pending preview is protected');
 await nav('projects');await action('new-project');await drop([imagePath],'#modal [data-import-drop]');await page.locator('.import-banner').waitFor();
 assert.equal(await page.locator('[name="import-project-description"]').inputValue(),'自动填入说明');await page.locator('#import-confirm').check();await action('import-save');await page.locator('[data-action="edit-project"]').waitFor();
 const saved=await page.evaluate(()=>window.hub.load());assert.equal(saved.projects.at(-1).name,'截图项目');assert.equal(saved.projects.at(-1).repo,'');assert.equal(saved.docs.at(-1).files[0].name,'project.png');
 pass('Dragging a screenshot into New Project fills all project fields and saves without typing');
 await nav('import');await pasteImage();await page.locator('#toast').getByText(/已导入/).waitFor();assert.equal(await app.evaluate(()=>globalThis.__transferCalls),2);
 pass('Clipboard image deduplication blocks another API request for the saved original');
 assert.deepEqual(errors,[]);const clipboardRestore=await restoreClipboard(app);await app.close();app=null;
 fs.writeFileSync(path.join(root,'validation','import-transfers-results.json'),JSON.stringify({passed:true,time:new Date().toISOString(),checks,errors,clipboardRestore,executable:process.env.WORKTOOL_EXECUTABLE||'development Electron',limitations:['Drag DOM events use real disk-backed File objects and real preload/IPC; Finder gestures were not automated.','AI responses are substituted. Image paste uses the real OS clipboard and keyboard shortcut without clipboard API replacements.']},null,2));
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(root,'validation','import-transfers-failure.png')}).catch(()=>{});if(app){await restoreClipboard(app).catch(()=>{});await app.close().catch(()=>{});}process.exitCode=1;});
