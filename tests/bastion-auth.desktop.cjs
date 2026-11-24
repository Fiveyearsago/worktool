'use strict';
const { _electron: electron } = require('playwright-core');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../core.cjs');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'worktool-auth-ui-')),workspace=path.join(temp,'workspace'),userData=path.join(temp,'user-data');
const store=new Store(workspace),data=store.load();data.packages[0].vpsIp='203.0.113.10';store.save(data);const before=fs.readFileSync(store.file),checks=[];let app,page;
const pass=text=>{checks.push(text);console.log('PASS:',text)};
async function launch(){
 const env={...process.env,HUB_WORKSPACE:workspace,HUB_USER_DATA:userData};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({args:[root],env,executablePath:process.env.WORKTOOL_EXECUTABLE||require('electron')});page=await app.firstWindow();
 await page.getByRole('heading',{name:'工作概览',exact:true}).waitFor();
 await app.evaluate(({session,safeStorage})=>{
  for(const name of ['isAsyncEncryptionAvailable','encryptStringAsync','decryptStringAsync','isEncryptionAvailable','encryptString','decryptString'])safeStorage[name]=()=>{throw Error('Keychain must never be used')};
  globalThis.authFixture={token:'initial-token',refresh:'initial-refresh',login:0,renew:0,reads:0,starts:0,rejectRefresh:false,rejectLogin:false};
  session.fromPartition('persist:worktool-bastion').protocol.handle('https',async request=>{
   const u=new URL(request.url),f=globalThis.authFixture;
   if(u.origin!=='https://uc.ushareit.org')return new Response('',{status:403});
   if(u.pathname==='/index.html')return new Response('<!doctype html><title>Synthetic portal</title><input placeholder="请输入公网IP"><button>查询</button>',{headers:{'Content-Type':'text/html'}});
   if(u.pathname==='/auth/login'){
    f.login++;const b=await request.json();if(f.rejectLogin||b.userName!=='synthetic-user'||b.password!=='synthetic-password')return Response.json({code:400});
    f.token='login-token-'+f.login;f.refresh='login-refresh-'+f.login;return Response.json({code:200,data:{token:f.token,refreshToken:f.refresh}});
   }
   if(u.pathname==='/auth/refreshToken'){
    f.renew++;const b=await request.json();if(f.rejectRefresh||b.refreshToken!==f.refresh)return Response.json({code:401});
    f.token='renew-token-'+f.renew;f.refresh='renew-refresh-'+f.renew;return Response.json({code:200,data:{token:f.token,refreshToken:f.refresh}});
   }
   if(u.pathname==='/system/bastion-host/start'){f.starts++;return Response.json({code:500})}
   if(u.pathname==='/system/bastion-host/list'){
    f.reads++;if(request.headers.get('Authorization')!==f.token)return Response.json({code:9999});
    return Response.json({code:200,data:{total:1,list:[{id:1,version:1,name:'Synthetic host',publicIp:'203.0.113.10',status:'RUNNING'}]}});
   }
   return new Response('',{status:404});
  });
 });
}
const action=name=>page.locator(`[data-action="${name}"]`).click();
const status=text=>page.locator('#bastion-panel .badge').getByText(text,{exact:true}).waitFor();
(async()=>{
 await launch();await page.getByRole('button',{name:'演示应用',exact:true}).click();await status('需要登录');
 await action('bastion-auth');await page.locator('#f-userName').fill('synthetic-user');await page.locator('#f-password').fill('synthetic-password');
 await page.getByRole('button',{name:'保存并验证登录'}).click();await status('已开机');
 assert.equal(await page.locator('[data-action=bastion-connect]').isEnabled(),true);
 assert(!fs.readFileSync(path.join(userData,'bastion-auth.json'),'utf8').includes('synthetic-password'));
 assert.equal(await page.locator('#f-password').inputValue(),'');pass('Native auth settings verify login, save encrypted credentials and clear password field');
 await app.evaluate(()=>{globalThis.authFixture.token='expired'});await action('bastion-check');await status('已开机');
 assert.equal(await app.evaluate(()=>globalThis.authFixture.renew),1);assert.equal(await app.evaluate(()=>globalThis.authFixture.login),1);
 pass('Expired token refreshes automatically and retries status without reopening login');
 await app.evaluate(()=>{globalThis.authFixture.token='expired-again';globalThis.authFixture.rejectRefresh=true});await action('bastion-check');await status('已开机');
 assert.equal(await app.evaluate(()=>globalThis.authFixture.login),2);pass('Rejected refresh falls back to saved login exactly once');
 const count=await app.evaluate(()=>globalThis.authFixture.reads);await page.clock.install();await page.clock.fastForward(65000);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 assert.equal(await app.evaluate(()=>globalThis.authFixture.reads),count);pass('Idle time and window focus still issue no queries');
 await app.close();app=null;await launch();await page.getByRole('button',{name:'演示应用',exact:true}).click();await status('已开机');
 assert.equal(await app.evaluate(()=>globalThis.authFixture.login),1);pass('Encrypted login settings survive restart and restore an expired session');
 await action('bastion-auth');await page.getByRole('button',{name:'关闭自动登录并移除密码'}).click();await page.locator('#modal').waitFor({state:'hidden'});
 assert(!fs.existsSync(path.join(userData,'bastion-auth.json')));assert.equal(await app.evaluate(()=>globalThis.authFixture.starts),0);assert.deepEqual(fs.readFileSync(store.file),before);
 pass('Removing saved password leaves project data unchanged and never starts a host');
 await app.close();app=null;fs.writeFileSync(path.join(root,'validation/bastion-auth-desktop-results.json'),JSON.stringify({passed:true,checks,temp,executable:process.env.WORKTOOL_EXECUTABLE,scope:'Synthetic platform, real local AES-GCM storage; all Keychain APIs throw. No real password or host operation.'},null,2));
})().catch(async error=>{console.error(error);if(app)await app.close().catch(()=>{});fs.writeFileSync(path.join(root,'validation/bastion-auth-desktop-results.json'),JSON.stringify({passed:false,checks,error:error.message},null,2));process.exitCode=1});
