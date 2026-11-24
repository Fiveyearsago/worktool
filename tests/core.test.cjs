const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {Store,gitStatus,gitExecutable}=require('../core.cjs');
test('general knowledge saves without a project but rejects missing project references',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-general-'));
 const store=new Store(dir),state=store.load();
 state.docs.push({id:'general',projectId:'',title:'通用知识',content:'可独立保存'});
 store.save(state);
 assert.equal(new Store(dir).load().docs.at(-1).projectId,'');
 state.docs.at(-1).projectId='missing';
 assert.throws(()=>store.save(state),/文档所属项目不存在/);
 fs.rmSync(dir,{recursive:true,force:true});
});
test('save persistence, conflict guard, backups',()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'hub-'));const st=new Store(d),s=st.load();s.projects[0].name='测试';st.save(s);assert.equal(new Store(d).load().projects[0].name,'测试');assert.throws(()=>st.save({...s,revision:0}),/更新/);assert.equal(fs.readdirSync(path.join(d,'.backups')).length,1);});
test('validation prevents orphan, invalid imports and traversal',()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'hub-'));const st=new Store(d),s=st.load();s.projects=[];assert.throws(()=>st.save(s),/不存在/);assert.throws(()=>st.resolveFile('../x'),/不允许/);assert.throws(()=>st.importFile('/tmp/private.pem'),/密钥/);assert.match(gitStatus(d).output,/未初始化/);});
test('refuse nonempty workspace',()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'hub-'));fs.writeFileSync(path.join(d,'other'),'safe');assert.throws(()=>new Store(d),/空目录/);});
test('template snapshot and imported document persist',()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'hub-'));const st=new Store(d),s=st.load();s.packages[0].tasks=s.templates[0].steps.map(t=>({...t,done:false,content:'',notes:'',files:[]}));s.templates[0].steps[0].title='new title';assert.equal(s.packages[0].tasks[0].title,'确定包名');const src=path.join(os.tmpdir(),'hub-note.txt');fs.writeFileSync(src,'hello');const f=st.importFile(src);s.packages[0].tasks[0].files.push(f);st.save(s);assert.equal(fs.readFileSync(st.resolveFile(f.path),'utf8'),'hello');assert.equal(new Store(d).load().packages[0].tasks[0].files.length,1);});
test('invalid JSON is never silently reset',()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'hub-'));fs.writeFileSync(path.join(d,'hub.json'),'{broken');assert.throws(()=>new Store(d));assert.equal(fs.readFileSync(path.join(d,'hub.json'),'utf8'),'{broken');});
test('git sync refuses dirty and unrelated parent repo',()=>{const {execFileSync}=require('node:child_process');const {gitSync}=require('../core.cjs');const d=fs.mkdtempSync(path.join(os.tmpdir(),'hub-'));new Store(d);execFileSync(gitExecutable,['init',d]);assert.throws(()=>gitSync(d),/未提交/);const sub=path.join(d,'sub');new Store(sub);assert.throws(()=>gitSync(sub),/独立/);});
test('git fast-forward sync and divergence protection with local test remote',()=>{
 const {execFileSync}=require('node:child_process'),{gitSync}=require('../core.cjs');
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'hub-git-')),remote=path.join(base,'remote.git'),a=path.join(base,'a'),b=path.join(base,'b');
 const git=(cwd,...args)=>execFileSync(gitExecutable,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(base,'init','--bare',remote);git(base,'clone',remote,a);
 for(const d of [a]){git(d,'config','user.email','test@example.com');git(d,'config','user.name','Test');}
 new Store(a);git(a,'add','hub.json');git(a,'commit','-m','seed');git(a,'push','-u','origin','HEAD');git(base,'clone',remote,b);git(b,'config','user.email','test@example.com');git(b,'config','user.name','Test');
 fs.writeFileSync(path.join(a,'a.txt'),'one');git(a,'add','.');git(a,'commit','-m','one');gitSync(a);gitSync(b);assert.equal(fs.readFileSync(path.join(b,'a.txt'),'utf8'),'one');
 fs.writeFileSync(path.join(a,'a.txt'),'two');git(a,'add','.');git(a,'commit','-m','two');gitSync(a);
 fs.writeFileSync(path.join(b,'b.txt'),'other');git(b,'add','.');git(b,'commit','-m','other');assert.throws(()=>gitSync(b),/分叉/);assert.equal(fs.readFileSync(path.join(b,'a.txt'),'utf8'),'one');
});

test('content hash rejects equal-revision external edits and stays out of disk JSON',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'hub-hash-')),st=new Store(d),s=st.load();
 const other=JSON.parse(fs.readFileSync(st.file));other.projects[0].name='external';fs.writeFileSync(st.file,JSON.stringify(other));
 assert.throws(()=>st.save(s),/更新/);assert.equal(st.load().projects[0].name,'external');
 const fresh=st.load();st.save(fresh);assert.equal(JSON.parse(fs.readFileSync(st.file)).__baseHash,undefined);
});
test('exclusive lock refuses competing writes and backup symlink is rejected',()=>{
 const crypto=require('node:crypto');const d=fs.mkdtempSync(path.join(os.tmpdir(),'hub-lock-')),st=new Store(d),s=st.load();
 const lock=path.join(os.tmpdir(),'worktool-'+crypto.createHash('sha256').update(fs.realpathSync(d)).digest('hex')+'.lock');
 fs.writeFileSync(lock,'occupied');assert.throws(()=>st.save(s),/正在写入/);fs.unlinkSync(lock);
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'hub-outside-'));fs.symlinkSync(outside,path.join(d,'.backups'));
 assert.throws(()=>st.save(s),/符号链接/);assert.deepEqual(fs.readdirSync(outside),[]);assert.equal(st.load().revision,0);
});
test('sync rejects malformed remote, tracked backups and changed approval; pushes only upstream ref',()=>{
 const {execFileSync}=require('node:child_process'),{gitSync,syncPlan}=require('../core.cjs');
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'hub-safe-git-')),remote=path.join(base,'remote.git'),a=path.join(base,'a'),b=path.join(base,'b');
 const git=(cwd,...args)=>execFileSync(gitExecutable,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(base,'init','--bare',remote);git(base,'clone',remote,a);git(a,'config','user.email','test@example.com');git(a,'config','user.name','Test');new Store(a);git(a,'add','hub.json');git(a,'commit','-m','seed');git(a,'push','-u','origin','HEAD');git(base,'clone',remote,b);git(b,'config','user.email','test@example.com');git(b,'config','user.name','Test');
 const approved=syncPlan(a);assert.equal(approved.pushUrl,remote);assert.match(approved.ref,/^refs\/heads\//);
 git(a,'config','remote.origin.push','HEAD:refs/heads/unwanted');git(a,'config','push.followTags','true');git(a,'tag','-a','private-tag','-m','do not push');
 fs.writeFileSync(path.join(a,'note.txt'),'safe');git(a,'add','note.txt');git(a,'commit','-m','note');assert.throws(()=>gitSync(a,approved),/改变/);gitSync(a,syncPlan(a));
 assert.equal(git(base,'--git-dir='+remote,'for-each-ref','--format=%(refname)','refs/tags','refs/heads/unwanted'),'');
 gitSync(b);const before=git(b,'rev-parse','HEAD');fs.writeFileSync(path.join(a,'hub.json'),'{bad');git(a,'add','hub.json');git(a,'commit','-m','bad data');git(a,'push','origin','HEAD:'+approved.ref);
 assert.throws(()=>gitSync(b));assert.equal(git(b,'rev-parse','HEAD'),before);assert.doesNotThrow(()=>JSON.parse(fs.readFileSync(path.join(b,'hub.json'))));
 fs.mkdirSync(path.join(b,'.backups'));fs.writeFileSync(path.join(b,'.backups','private.json'),'private');git(b,'add','.backups');git(b,'commit','-m','tracked backup');assert.throws(()=>gitSync(b),/备份/);
});
test('failed atomic rename preserves original data and caller revision',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'hub-atomic-')),st=new Store(d),s=st.load(),before=fs.readFileSync(st.file,'utf8'),rename=fs.renameSync;
 s.projects[0].name='pending';fs.renameSync=()=>{throw Error('simulated rename failure')};
 try{assert.throws(()=>st.save(s),/simulated/);}finally{fs.renameSync=rename;}
 assert.equal(fs.readFileSync(st.file,'utf8'),before);assert.equal(s.revision,0);assert.equal(fs.readdirSync(d).some(n=>n.endsWith('.tmp')),false);
});
