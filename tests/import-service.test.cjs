const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {Store}=require('../core.cjs');const {ImportService,decodeText}=require('../import-service.cjs');
const fixture='# 资料\n\n应用名：测试导入\n包名：com.example.imported\n分支：release/test\nFlavor: demo\n广告配置：ad-unit-123\n';
function setup(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'worktool-import-'));const store=new Store(path.join(root,'workspace'));return {root,store,service:new ImportService(()=>store)};}
function input(p){return {title:'导入资料',projectId:'demo',projectName:'',records:p.records.map(r=>({...r,selected:true}))};}
test('MD preview is non-mutating; confirmed import retains Markdown and custom config',async()=>{const {root,store,service}=setup(),file=path.join(root,'sample.md');fs.writeFileSync(file,fixture);const before=store.load();const preview=await service.fromFile(file);assert.deepEqual(store.load(),before);assert.equal(fs.existsSync(path.join(store.dir,'attachments')),false);const result=service.commit(preview.token,input(preview));assert.equal(result.added,1);const pkg=result.state.packages.at(-1);assert.equal(pkg.applicationId,'com.example.imported');assert.equal(pkg.tasks.find(t=>t.title.includes('广告')).content,'ad-unit-123');assert.equal(pkg.tasks[0].done,false);const doc=result.state.docs.at(-1);assert.equal(doc.content,fixture);assert.equal(fs.readFileSync(store.resolveFile(doc.files[0].path),'utf8'),fixture);assert.throws(()=>service.commit(preview.token,input(preview)),/过期|保存/);await assert.rejects(service.fromFile(file),/已导入/);});
test('Cancel discards preview without files or data; source preserved',async()=>{const {root,store,service}=setup(),file=path.join(root,'cancel.md');fs.writeFileSync(file,fixture);const p=await service.fromFile(file);service.discard(p.token);assert.throws(()=>service.commit(p.token,input(p)),/过期/);assert.equal(store.load().revision,0);assert.equal(fs.existsSync(path.join(store.dir,'attachments')),false);assert.equal(fs.readFileSync(file,'utf8'),fixture);});
test('Documents can be imported without products into a new project',()=>{const {store,service}=setup(),p=service.fromText('# 说明\n这是一份没有产品字段的说明。');const result=service.commit(p.token,{title:'说明',projectName:'新项目',projectId:'',records:[]});assert.equal(result.added,0);assert.equal(result.state.projects.length,2);assert.equal(result.state.docs.at(-1).projectId,result.projectId);assert.equal(result.state.packages.length,1);assert.equal(new Store(store.dir).load().docs.at(-1).content,p.text);});
test('Duplicate packages, invalid package and duplicate project do not modify state',()=>{const {store,service}=setup();for(const mutation of [i=>i.records[0].applicationId='com.example.demo',i=>i.records[0].applicationId='not valid',i=>{i.projectId='';i.projectName=store.load().projects[0].name}]){const p=service.fromText(fixture),i=input(p),before=store.load();mutation(i);assert.throws(()=>service.commit(p.token,i));assert.deepEqual(store.load(),before);service.discard(p.token);}
});
test('Hash conflict and workspace switch block commits',()=>{let {store,service}=setup();const p=service.fromText(fixture);store.save(store.load());assert.throws(()=>service.commit(p.token,input(p)),/更新/);let active=store;service=new ImportService(()=>active);const second=service.fromText(fixture);active=setup().store;assert.throws(()=>service.commit(second.token,input(second)),/切换/);});
test('Rollback on persistence failure leaves no attachment or imported data',()=>{const {store,service}=setup(),p=service.fromText(fixture),before=store.load(),save=store.save;store.save=()=>{throw Error('simulated disk full')};assert.throws(()=>service.commit(p.token,input(p)),/disk full/);store.save=save;assert.deepEqual(store.load(),before);assert.deepEqual(fs.readdirSync(path.join(store.dir,'attachments')),[]);});
test('Sensitive pasted and edited content is blocked, ordinary Firebase app IDs accepted',()=>{const {service}=setup();assert.throws(()=>service.fromText('password: supersecret'),/敏感/);const p=service.fromText(fixture);assert.throws(()=>service.reparse(p.token,'client_secret: supersecret'),/敏感/);const i=input(p);i.records[0].notes='password: supersecret';assert.throws(()=>service.commit(p.token,i),/敏感/);assert.doesNotThrow(()=>service.fromText('Firebase appId: 1:123:android:abc'));});
test('UTF8/UTF16LE decoding rejects binary/invalid encoding',()=>{assert.equal(decodeText(Buffer.from('中文')),'中文');assert.equal(decodeText(Buffer.concat([Buffer.from([255,254]),Buffer.from('中文','utf16le')])),'中文');assert.throws(()=>decodeText(Buffer.from([0xff,0xff])));assert.throws(()=>decodeText(Buffer.from('a\0b')));});
test('PDF explicitly unsupported; non-Mac image parsing never falls back to network',async()=>{const {root,store}=setup(),service=new ImportService(()=>store,{platform:'win32'}),file=path.join(root,'picture.png');fs.writeFileSync(file,'fake');await assert.rejects(service.fromFile(file),/仅在 Mac/);await assert.rejects(service.fromFile(path.join(root,'x.pdf')),/暂不支持/);});

test('failed reparse retains the last accepted document and digest',()=>{
 const {service}=setup(),p=service.fromText(fixture);
 const invalid='AppName,ApplicationId\n'+Array.from({length:101},(_,i)=>`App${i},com.example.a${i}`).join('\n');
 assert.throws(()=>service.reparse(p.token,invalid),/100 条/);
 const result=service.commit(p.token,input(p));
 assert.equal(result.state.docs.at(-1).content,fixture);
 assert.equal(result.state.docs.at(-1).sourceDigest,p.sourceDigest);
});

test('edited pasted source gets a fresh digest and cannot bypass source deduplication',()=>{
 const {service}=setup(),first=service.fromText('# 已有说明');
 service.commit(first.token,{title:'已有',projectId:'demo',records:[]});
 const second=service.fromText('# 新说明');
 service.reparse(second.token,'# 已有说明');
 assert.throws(()=>service.commit(second.token,{title:'重复',projectId:'demo',records:[]}),/已导入/);
 service.reparse(second.token,'# 修改后的说明');
 const doc=service.commit(second.token,{title:'新说明',projectId:'demo',records:[]}).state.docs.at(-1);
 assert.notEqual(doc.sourceDigest,second.sourceDigest);
 assert.equal(doc.content,'# 修改后的说明');
});

test('OCR source mode and warnings survive reparse while original bytes stay intact',()=>{
 const {store,service}=setup(),bytes=Buffer.from('synthetic image fixture');
 const p=service.preview('AppName: OCR\nApplicationld: com.example.ocr',{name:'test.png',ext:'png',bytes,ocr:true,warnings:['请核对截图']});
 const result=service.reparse(p.token,p.text+'\nBranch: main');
 assert.equal(result.records[0].applicationId,'com.example.ocr');
 assert.ok(result.warnings.includes('请核对截图'));
 const saved=service.commit(p.token,input({...p,records:result.records}));
 assert.deepEqual(fs.readFileSync(store.resolveFile(saved.state.docs.at(-1).files[0].path)),bytes);
});

test('workspace switch during extraction creates no preview in the new workspace',async()=>{
 const {root,store}=setup();let active=store;
 // Node acts as a controlled extractor here; real Vision is covered on desktop.
 const file=path.join(root,'controlled.png');
 fs.writeFileSync(file,'process.stdout.write("AppName: Delayed\\nApplicationId: com.example.delayed");');
 const service=new ImportService(()=>active,{platform:'darwin',nativeExecutable:process.execPath});
 const pending=service.fromFile(file);active=setup().store;
 await assert.rejects(pending,/工作区已切换/);
 assert.equal(service.sessions.size,0);
 assert.equal(store.load().revision,0);assert.equal(active.load().revision,0);
});


test('VPS IP imports persist separately from legacy accounts and reject malformed addresses atomically',()=>{
 const {service,store}=setup();
 const p=service.fromText(fixture+'跳板机 VPS IP 地址：203.0.113.10\n');
 const i=input(p);i.records[0].vpsIp='203.0.113.10:3389';
 const before=store.load();assert.throws(()=>service.commit(p.token,i),/IP 地址/);assert.deepEqual(store.load(),before);
 assert.equal(fs.existsSync(path.join(store.dir,'attachments')),false);
 i.records[0].vpsIp=' 2001:db8::10 ';i.records[0].gpAccount='legacy ignored';
 const result=service.commit(p.token,i);
 assert.equal(result.state.packages.at(-1).vpsIp,'2001:db8::10');
 assert.equal(result.state.packages.at(-1).gpAccountId,undefined);
 assert.deepEqual(result.state.accounts,before.accounts);
 assert.equal(new Store(store.dir).load().packages.at(-1).vpsIp,'2001:db8::10');
});
