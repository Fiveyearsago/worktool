'use strict';
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Store } = require('../core.cjs');
const root = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktool-bastion-ui-'));
const workspace = path.join(temp, 'workspace'), userData = path.join(temp, 'user-data');
const store = new Store(workspace), initial = store.load(); initial.packages[0].vpsIp = '203.0.113.10'; store.save(initial);
const before = fs.readFileSync(store.file), checks = [], errors = []; let app, page;
const pass = x => { checks.push(x); console.log('PASS:', x); };
async function launch() {
  const env = { ...process.env, HUB_WORKSPACE: workspace, HUB_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env, executablePath: process.env.WORKTOOL_EXECUTABLE || require('electron') });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '工作概览', exact: true }).waitFor();
  await app.evaluate(({ session }) => {
    globalThis.__bastionFixture = { status: 'STOPPED', starts: [], queries: [], version: 4, unauthorized: false, failure: false };
    session.fromPartition('persist:worktool-bastion').protocol.handle('https', async request => {
      const url = new URL(request.url), f = globalThis.__bastionFixture;
      if (url.origin !== 'https://uc.ushareit.org') return new Response('', { status: 403 });
      if (url.pathname === '/index.html') return new Response(`<!doctype html><title>Synthetic UserCenter</title><button id="login">登录测试平台</button><div id="host"></div><script>
        function ready(){document.querySelector('#host').innerHTML='<input placeholder="请输入公网IP"><button id="query">查询</button>';document.querySelector('#query').onclick=()=>document.querySelector('#host').dataset.ip=document.querySelector('input').value;}
        document.querySelector('#login').onclick=()=>{localStorage.setItem('MATRIX_token',JSON.stringify('synthetic-auth'));location.hash='/bastion-host';ready()};
        if(localStorage.getItem('MATRIX_token'))ready();else location.hash='/login?redirect=/bastion-host';
      </script>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (request.headers.get('Authorization') !== 'synthetic-auth' || f.unauthorized) return Response.json({ code: 401 }, { status: 401 });
      if (url.pathname === '/system/bastion-host/list') {
        f.queries.push(url.searchParams.get('publicIp'));
        return Response.json({ code: 200, data: { total: 1, list: [{ id: 23, version: f.version, publicIp: '203.0.113.10', name: 'Synthetic bastion', status: f.status }] } });
      }
      if (url.pathname === '/system/bastion-host/start') {
        f.starts.push(await request.json());
        if (!f.failure) f.status = 'STARTING';
        return Response.json({ code: 200, data: { operationStatus: f.failure ? 'FAILED' : 'SUCCESS', hostStatus: f.status } });
      }
      return new Response('', { status: 404 });
    });
  });
}
const click = name => page.locator(`[data-action="${name}"]`).first().click();
const status = text => page.locator('#bastion-panel .badge').getByText(text, { exact: true }).waitFor();
(async () => {
  await launch();
  await page.getByRole('button', { name: '演示应用', exact: true }).click();
  await status('需要登录');
  assert.equal(await page.locator('[data-action=bastion-start]').isDisabled(), true);
  assert.equal(await app.evaluate(() => globalThis.__bastionFixture.starts.length), 0);
  pass('Unauthenticated automatic query shows login state without issuing a start');
  await click('bastion-open');
  let portal = app.windows().find(p => p !== page); assert(portal);
  await app.evaluate(({ app }) => app.emit('activate'));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow().webContents.getURL().startsWith('https://uc.ushareit.org')), true);
  await portal.getByRole('button', { name: '登录测试平台' }).click();
  assert.equal(await portal.evaluate(() => typeof window.hub), 'undefined');
  assert.equal(await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('https://uc.ushareit.org'));
    const p = w.webContents.getLastWebPreferences(); return p.sandbox && p.contextIsolation && !p.nodeIntegration && !p.preload && p.webSecurity;
  }), true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('https://uc.ushareit.org')).close());
  await page.waitForFunction(() => document.hasFocus());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow().webContents.getURL().startsWith('file:')), true);
  await click('bastion-check'); await status('已关机');
  const queryCount = () => app.evaluate(() => globalThis.__bastionFixture.queries.length);
  const initialQueries = await queryCount();
  await page.clock.install();
  await page.clock.fastForward(65000);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await queryCount(), initialQueries);
  await page.locator('[data-page=packages]').first().click();
  await page.getByRole('button', { name: '演示应用', exact: true }).click(); await status('已关机');
  assert.equal(await queryCount(), initialQueries + 1);
  pass('Detail entry queries once; 65 seconds and focus changes add no requests; reopening queries again');
  await click('bastion-open'); await portal.waitForFunction(() => document.querySelector('#host')?.dataset.ip === '203.0.113.10');
  pass('Isolated portal login enables queries; close returns focus to WorkTool; entrance filters the application IP');
  await page.bringToFront();
  await app.evaluate(() => { globalThis.__bastionFixture.version = 9; });
  await click('bastion-start'); await status('开机中');
  assert.equal(await page.locator('[data-action=bastion-start]').isDisabled(), true);
  assert.deepEqual(await app.evaluate(() => globalThis.__bastionFixture.starts), [{ id: 23, version: 9 }]);
  await click('bastion-check'); await status('开机中');
  assert.equal(await app.evaluate(() => globalThis.__bastionFixture.starts.length), 1);
  pass('One-click start uses freshly queried host version, posts once and remains pending until running');
  await app.evaluate(() => { globalThis.__bastionFixture.status = 'RUNNING'; });
  await click('bastion-check'); await status('已开机');
  assert.equal(await page.locator('[data-action=bastion-start]').isDisabled(), true);
  await page.screenshot({ path: path.join(root, 'validation/bastion-desktop.png'), fullPage: true });
  await app.evaluate(() => { globalThis.__bastionFixture.status = 'STOPPED'; globalThis.__bastionFixture.failure = true; });
  await click('bastion-check'); await status('已关机'); await click('bastion-start');
  await page.locator('#bastion-panel').getByText(/平台报告开机失败/).waitFor();
  pass('Running status is based on follow-up query; business operation failure is displayed as failure');
  await app.evaluate(() => { globalThis.__bastionFixture.unauthorized = true; });
  await click('bastion-check'); await status('需要登录');
  assert.equal(await page.locator('[data-action=bastion-start]').isDisabled(), true);
  assert.deepEqual(fs.readFileSync(store.file), before);
  assert.equal(fs.existsSync(path.join(workspace, 'bastion-session.json')), false);
  pass('Expired login disables start; runtime state and authentication never alter project data');
  await app.close(); app = null; await launch();
  await page.getByRole('button', { name: '演示应用', exact: true }).click(); await status('已关机');
  assert.equal(await app.evaluate(() => globalThis.__bastionFixture.starts.length), 0);
  assert.deepEqual(fs.readFileSync(store.file), before); assert.deepEqual(errors, []);
  pass('Local portal session survives app restart and never automatically starts a stopped host');
  await app.close(); app = null;
  fs.writeFileSync(path.join(root, 'validation/bastion-desktop-results.json'), JSON.stringify({ passed: true, time: new Date().toISOString(), checks, errors, executable: process.env.WORKTOOL_EXECUTABLE, limitations: ['Isolated synthetic workspace, portal page and platform HTTP responses. No real start/stop request was sent.'], temp }, null, 2));
})().catch(async error => {
  console.error(error); if (page) await page.screenshot({ path: path.join(root, 'validation/bastion-desktop-failure.png') }).catch(() => {});
  if (app) await app.close().catch(() => {});
  fs.writeFileSync(path.join(root, 'validation/bastion-desktop-results.json'), JSON.stringify({ passed: false, checks, errors, error: error.stack }, null, 2)); process.exitCode = 1;
});
