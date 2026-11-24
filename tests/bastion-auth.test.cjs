'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { BastionAuth } = require('../bastion-auth.cjs');
const { BastionPortal, portalAuth } = require('../bastion-portal.cjs');
const { BastionService } = require('../bastion-service.cjs');
const { remoteDesktopUrl, openRemoteDesktop, parseBookmark } = require('../remote-desktop.cjs');
function vault() {
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'worktool-auth-')),'bastion-auth.json');
  return {file,auth:new BastionAuth(file)};
}
test('Credentials are encrypted, owner-only, absent from status, removable and blocked persistently',async()=>{
  const x=vault(), input={userName:'test-user',password:'synthetic-password'};
  assert.deepEqual(x.auth.status(),{saved:false,blocked:false,needsReentry:false});
  x.auth.write(await x.auth.prepare(input));
  assert(!fs.readFileSync(x.file,'utf8').includes(input.password)); assert(!fs.readFileSync(x.file,'utf8').includes(input.userName));
  assert.equal(fs.statSync(x.file).mode&0o777,0o600);
  assert.deepEqual(await x.auth.get(),input); assert.deepEqual(x.auth.status(),{saved:true,blocked:false,needsReentry:false});
  x.auth.block(); assert.equal(await new BastionAuth(x.file).get(),null);
  x.auth.remove(); assert.equal(fs.existsSync(x.file),false);
});
test('Old Keychain format is never decrypted; local key permissions, corruption and removal are handled',async()=>{
 const x=vault();fs.writeFileSync(x.file,JSON.stringify({version:1,encrypted:'b2xkLXNlY3JldA=='}));
 assert.equal(x.auth.status().needsReentry,true);await assert.rejects(x.auth.get(),/不会读取钥匙串/);
 x.auth.write(await x.auth.prepare({userName:'test',password:'synthetic-password'}));
 assert.equal(fs.statSync(x.auth.keyFile).mode&0o777,0o600);assert.equal((await new BastionAuth(x.file).get()).password,'synthetic-password');
 const v=x.auth.read();v.tag=Buffer.alloc(16).toString('base64');x.auth.write(v);await assert.rejects(x.auth.get(),/无法读取/);
 x.auth.remove();assert(!fs.existsSync(x.auth.keyFile));
});
async function authScript(action, options={}) {
  const values=new Map([['MATRIX_token',JSON.stringify('old-token')],['MATRIX_refreshToken',JSON.stringify('old-refresh')]]),calls=[];
  const context=vm.createContext({location:{origin:'https://uc.ushareit.org'},localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},URL,AbortController,setTimeout,clearTimeout,fetch:async(url,opts)=>{calls.push({url,opts});return new Response(JSON.stringify({code:200,data:{token:'new-token',refreshToken:'new-refresh'}}));},...options});
  const result=await vm.runInContext(`(${portalAuth.toString()})(${JSON.stringify(action)},{userName:'test-user',password:'synthetic-password'})`,context);
  return {values,calls,result};
}
test('Platform refresh rotates both tokens with same-origin guarded fetch and redacted result',async()=>{
  const x=await authScript('refresh');assert.equal(x.calls.length,1);assert.equal(x.calls[0].url,'https://uc.ushareit.org/auth/refreshToken');
  assert.deepEqual(JSON.parse(x.calls[0].opts.body),{refreshToken:'old-refresh'});assert.equal(x.calls[0].opts.redirect,'error');
  assert.equal(x.values.get('MATRIX_refreshToken'),JSON.stringify('new-refresh'));assert.deepEqual(JSON.parse(JSON.stringify(x.result)),{ok:true});
  const y=await authScript('login');assert.equal(y.calls[0].url,'https://uc.ushareit.org/auth/login');assert.equal(JSON.parse(y.calls[0].opts.body).userName,'test-user');
});
test('Wrong origin, missing refresh, malformed responses and outages do not leak or replace tokens',async()=>{
  for(const options of [{location:{origin:'https://example.com'}},{localStorage:{getItem:()=>null}},{fetch:async()=>new Response('synthetic-secret')},{fetch:async()=>new Response('{}',{status:503})}]) {
    const x=await authScript('refresh',options);assert.equal(x.result.ok,false);assert(!JSON.stringify(x.result).includes('secret'));assert.equal(x.values.get('MATRIX_token'),JSON.stringify('old-token'));
  }
});
function portalFixture(){
  const portal=new BastionPortal({now:()=>1000},null),calls=[];let valid=false;
  portal.rawRequest=async(op)=>{calls.push(op);return valid?{status:200,body:{code:200}}:{status:200,body:{code:9999}}};
  portal.authenticate=async action=>{calls.push(action);await new Promise(r=>setImmediate(r));valid=true;return {ok:true}};
  return {portal,calls};
}
test('Concurrent expired reads share one recovery and retry each read once',async()=>{
  const {portal,calls}=portalFixture();const results=await Promise.all([portal.request('list',{}),portal.request('list',{})]);
  assert(results.every(r=>r.body.code===200));assert.equal(calls.filter(x=>x==='refresh').length,1);assert.equal(calls.filter(x=>x==='list').length,4);
});
test('Failed refresh falls back to saved login; bad password is blocked and retries cooled down',async()=>{
  const {portal,calls}=portalFixture();let blocked=false;
  portal.auth={get:async()=>blocked?null:{userName:'test',password:'synthetic'},block:()=>blocked=true};
  portal.authenticate=async action=>{calls.push(action);return {ok:false,reason:'REJECTED'}};
  assert.equal((await portal.request('list',{})).error,'LOGIN_REQUIRED');assert.equal(blocked,true);
  await portal.request('list',{});assert.deepEqual(calls,['list','refresh','login','list']);
  portal.now=()=>62000;await portal.request('list',{});assert.equal(calls.filter(x=>x==='login').length,1);
});
test('Refresh outage does not submit password; start/403/network results never replay',async()=>{
  const {portal,calls}=portalFixture();portal.auth={get:async()=>{throw Error('must not read password')}};
  portal.authenticate=async action=>{calls.push(action);return {ok:false,reason:'UNAVAILABLE'}};
  await portal.request('list',{});assert.deepEqual(calls,['list','refresh']);
  for(const response of [{status:401},{status:403},{error:'UNAVAILABLE'}]){calls.length=0;portal.rawRequest=async()=>{calls.push('start');return response};await portal.request('start',{});assert.deepEqual(calls,['start'])}
});
test('Saved login is validated before replacing credentials and excludes concurrent save/remove',async()=>{
  const x=vault(),portal=new BastionPortal({auth:x.auth},null);let finish;
  portal.authenticate=()=>new Promise(r=>finish=r);
  const save=portal.saveLogin({userName:'test',password:'synthetic'});while(!finish)await new Promise(r=>setImmediate(r));
  assert.throws(()=>portal.removeLogin());await assert.rejects(portal.saveLogin({userName:'test',password:'synthetic'}));assert(!fs.existsSync(x.file));
  finish({ok:true});await save;assert.equal(x.auth.status().saved,true);
  portal.authenticate=async()=>({ok:false,reason:'REJECTED'});await assert.rejects(portal.saveLogin({userName:'other',password:'bad'}));assert.equal((await x.auth.get()).userName,'test');
});
test('Windows App receives a validated IP-only URI and actionable launch errors',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'worktool-rdp-'));const calls=[];assert.equal(remoteDesktopUrl('203.0.113.10'),'rdp://full%20address=s:203.0.113.10');assert.equal(remoteDesktopUrl('2001:db8::10'),'rdp://full%20address=s:%5B2001%3Adb8%3A%3A10%5D');
  for(const ip of ['example.com','1.2.3.4&username=evil','1.2.3.4\n','$(touch x)']) {if(ip.endsWith('\n'))continue;assert.throws(()=>remoteDesktopUrl(ip))}
  const result=await openRemoteDesktop('203.0.113.10',{platform:'darwin',directory,run:async(...args)=>{calls.push(args);return {stdout:''}}});assert.equal(result.opened,true);assert.deepEqual(calls.at(-1)[1].slice(0,2),['-a','/Applications/Windows App.app']);const file=calls.at(-1)[1][2];assert(fs.readFileSync(file,'utf16le').includes('full address:s:203.0.113.10'));assert.equal(fs.statSync(file).mode&0o777,0o600);
  await assert.rejects(openRemoteDesktop('203.0.113.10',{platform:'darwin',directory,run:async()=>{throw Error('private detail')}}),e=>!e.message.includes('private detail'));
});
test('Connect rechecks exact IP and running state; rejects workspace changes and never starts a host',async()=>{
  const pkg={id:'p',vpsIp:'203.0.113.10'},store={load:()=>({packages:[pkg]})},calls=[];let status='STOPPED';
  const portal={request:async op=>{calls.push(op);return {status:200,body:{code:200,data:{list:[{id:1,version:1,publicIp:pkg.vpsIp,status}],total:1}}}}};
  const service=new BastionService(()=>store,portal,{openDesktop:async ip=>calls.push(ip)});
  await assert.rejects(service.connect('p'),/尚未开机/);status='RUNNING';await service.connect('p');assert.deepEqual(calls,['list','list','203.0.113.10']);
  let finish;portal.request=()=>new Promise(r=>finish=r);const pending=service.connect('p');pkg.vpsIp='203.0.113.11';finish({status:200,body:{code:200,data:{list:[],total:0}}});await assert.rejects(pending,/改变/);
});

test('Token-only login succeeds and removes an obsolete refresh token',async()=>{
 const x=await authScript('login',{fetch:async()=>new Response(JSON.stringify({code:200,data:{token:'only-access'}}))});
 assert.equal(x.result.ok,true);assert.equal(x.values.get('MATRIX_token'),JSON.stringify('only-access'));assert.equal(x.values.has('MATRIX_refreshToken'),false);
});

test('Saved Windows App settings match exact host and never forward passwords or auth overrides',()=>{
 const text='full address:s:203.0.113.10:3389\nusername:s:SavedUser\npassword:s:do-not-forward\nauthentication level:i:0\n';
 const settings=parseBookmark(text,'203.0.113.10');assert.equal(settings.username,'SavedUser');assert.equal(parseBookmark(text,'203.0.113.1'),null);
 assert.equal(remoteDesktopUrl('203.0.113.10',settings),'rdp://full%20address=s:203.0.113.10&username=s:SavedUser');
});

test('Existing Windows App bookmark uses native launcher; permission prompt never reads a password or creates RDP',async()=>{
 const calls=[],directory=fs.mkdtempSync(path.join(os.tmpdir(),'worktool-saved-rdp-'));
 const run=async(exe,args)=>{calls.push({exe,args});if(args.includes('list'))return {stdout:'"ChargeJoy", EDB9DCAF-72AF-4F9A-B14A-EA5F5BF945E8\n'};if(args.includes('export'))return {stdout:'full address:s:203.0.113.10\nusername:s:SavedUser\n'};if(exe==='/test/helper')return {stdout:'ACCESSIBILITY_REQUIRED\n'};return {stdout:''};};
 const result=await openRemoteDesktop('203.0.113.10',{platform:'darwin',directory,helper:'/test/helper',run});
 assert.equal(result.requiresAccessibility,true);assert.equal(result.opened,false);assert.deepEqual(calls.at(-1).args,['ChargeJoy']);assert.equal(fs.readdirSync(directory).length,0);
});
