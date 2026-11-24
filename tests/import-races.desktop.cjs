'use strict';
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'worktool-import-races-'));
const workspace = path.join(testRoot, 'workspace');
const checks = [], errors = [];
let app, page;
const pass = name => { checks.push(name); console.log('PASS:', name); };
const action = name => page.locator(`[data-action="${name}"]`).first().click();
const nav = name => page.locator(`[data-page="${name}"]`).first().click();
const state = () => page.evaluate(() => window.hub.load());
const text = 'AppName: Race Demo\nApplicationId: com.example.race';
async function paste(value = text) {
  await nav('import');
  await page.locator('#import-paste').fill(value);
  await action('import-paste');
  await page.locator('.import-banner').waitFor();
}
async function waitMain(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await app.evaluate(predicate)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error('Timed out waiting for controlled main-process operation');
}
async function delayedFile(file) {
  await app.evaluate(({ app, dialog }, file) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.cjs');
    const { ImportService } = require(require('node:path').join(app.getAppPath(), 'import-service.cjs'));
    const original = ImportService.prototype.fromFile;
    globalThis.__fileFinished = false;
    ImportService.prototype.fromFile = async function (...args) {
      ImportService.prototype.fromFile = original;
      globalThis.__testImporter = this;
      try { return await original.apply(this, args); }
      finally { globalThis.__fileFinished = true; }
    };
    dialog.showOpenDialog = () => new Promise(resolve => {
      globalThis.__releaseFile = () => resolve({ canceled: false, filePaths: [file] });
    });
  }, file);
  await action('import-file');
  await page.getByRole('heading', { name: '正在本地识别…' }).waitFor();
}
(async () => {
  const env = { ...process.env, HUB_WORKSPACE: workspace, HUB_USER_DATA: path.join(testRoot, 'user-data') };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env, executablePath: process.env.WORKTOOL_EXECUTABLE || require('electron') });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '工作概览', exact: true }).waitFor();
  if (process.env.WORKTOOL_EXECUTABLE) assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);

  await nav('import');
  await page.locator('#import-paste').fill(text);
  await page.locator('#search').fill('search');
  assert.equal(await page.locator('#import-paste').inputValue(), text);
  await page.locator('#search').fill('');
  await nav('overview');
  await nav('import');
  assert.equal(await page.locator('#import-paste').inputValue(), text);
  pass('Unparsed pasted text survives search and page navigation');

  await action('import-paste');
  await page.locator('.import-banner').waitFor();
  await page.locator('#import-source').evaluate(el => { el.closest('details').open = true; });
  await page.locator('#import-source').fill('');
  await action('import-reparse');
  await page.locator('#toast').getByText(/请填写文字/).waitFor();
  assert.equal(await page.locator('#import-source').inputValue(), '');
  assert.equal(await page.locator('#import-0-applicationId').inputValue(), 'com.example.race');
  assert.equal((await state()).revision, 0);
  await action('import-cancel');
  pass('Empty edited source is rejected without restoring stale text or saving');

  const file = path.join(testRoot, 'late.md');
  fs.writeFileSync(file, 'AppName: Late File\nApplicationId: com.example.late');
  await delayedFile(file);
  await action('import-cancel');
  await paste();
  await app.evaluate(() => globalThis.__releaseFile());
  await waitMain(() => globalThis.__fileFinished && globalThis.__testImporter.sessions.size === 1);
  assert.equal(await page.locator('#import-0-applicationId').inputValue(), 'com.example.race');
  assert.equal((await state()).revision, 0);
  await action('import-cancel');
  pass('Cancelled file result is discarded and cannot replace a newer preview');

  await delayedFile(path.join(testRoot, 'missing.md'));
  await action('import-cancel');
  await paste();
  await page.evaluate(() => { document.querySelector('#toast').textContent = ''; });
  await app.evaluate(() => globalThis.__releaseFile());
  await waitMain(() => globalThis.__fileFinished);
  // A round trip lets the rejected IPC response reach the renderer.
  await page.evaluate(() => window.hub.load());
  assert.doesNotMatch(await page.locator('#toast').textContent(), /ENOENT|操作失败/);
  assert.equal(await page.locator('#import-0-name').inputValue(), 'Race Demo');
  await action('import-cancel');
  pass('Cancelled file errors do not interrupt a newer preview');

  await paste();
  await page.locator('[name="import-project"]').selectOption('demo');
  await page.locator('#import-confirm').check();
  await app.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.cjs');
    const { ImportService } = require(require('node:path').join(app.getAppPath(), 'import-service.cjs'));
    const original = ImportService.prototype.commit;
    globalThis.__commitCalls = 0;
    ImportService.prototype.commit = function (...args) {
      globalThis.__commitCalls++;
      ImportService.prototype.commit = original;
      return new Promise((resolve, reject) => {
        globalThis.__releaseCommit = () => { try { resolve(original.apply(this, args)); } catch (e) { reject(e); } };
      });
    };
  });
  await action('import-save');
  await page.getByRole('heading', { name: '正在保存导入结果…' }).waitFor();
  await waitMain(() => typeof globalThis.__releaseCommit === 'function');
  await nav('sync');
  await page.getByRole('heading', { name: '正在保存导入结果…' }).waitFor();
  assert.equal(await page.locator('[data-action="import-cancel"]').count(), 0);
  assert.equal(await page.locator('[data-action="import-save"]').count(), 0);
  assert.equal((await state()).revision, 0);
  await app.evaluate(() => globalThis.__releaseCommit());
  await page.locator('[data-action="edit-project"]').waitFor();
  assert.equal(await app.evaluate(() => globalThis.__commitCalls), 1);
  assert.equal((await state()).packages.filter(p => p.applicationId === 'com.example.race').length, 1);
  pass('Saving blocks navigation, cancellation and repeat submission until one commit finishes');

  await paste('AppName: Workspace Switch\nApplicationId: com.example.switch');
  await nav('sync');
  const nextWorkspace = path.join(testRoot, 'next-workspace');
  fs.mkdirSync(nextWorkspace);
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, nextWorkspace);
  await action('choose-workspace');
  await page.locator('#toast').getByText('已切换工作区').waitFor();
  await nav('import');
  assert.equal(await page.locator('.import-banner').count(), 0);
  assert.equal(await page.locator('#import-paste').inputValue(), '');
  assert.equal((await state()).revision, 0);
  assert.equal(fs.existsSync(path.join(nextWorkspace, 'attachments')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, 'hub.json'))).packages.length, 2);
  pass('Workspace change clears the preview and leaves both workspaces intact');

  assert.deepEqual(errors, []);
  await app.close(); app = null;
  fs.writeFileSync(path.join(root, 'validation', 'import-races-results.json'), JSON.stringify({ passed: true, time: new Date().toISOString(), checks, errors, testRoot, executable: process.env.WORKTOOL_EXECUTABLE || 'development Electron', limitations: ['Test-only delayed IPC and file chooser results; isolated synthetic workspaces.'] }, null, 2));
})().catch(async error => {
  console.error(error);
  if (page) await page.screenshot({ path: path.join(root, 'validation', 'import-races-failure.png') }).catch(() => {});
  if (app) await app.close().catch(() => {});
  fs.writeFileSync(path.join(root, 'validation', 'import-races-results.json'), JSON.stringify({ passed: false, checks, errors, error: error.stack, testRoot }, null, 2));
  process.exitCode = 1;
});
