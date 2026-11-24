'use strict';
// Opt-in: send exactly the provided image to LongCat, preview only, no project save.
if (process.env.WORKTOOL_LIVE_LONGCAT !== '1' || !process.env.WORKTOOL_CLIPBOARD_IMAGE) throw Error('Explicit live opt-in and image path are required.');
const { _electron: electron } = require('playwright-core');
const { saveClipboard, writeClipboard, restoreClipboard } = require('./clipboard-fixture.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktool-clipboard-live-'));
const userData = path.join(temp, 'user-data'), settingsLink = path.join(userData, 'ai-settings.json');
let app, page;
(async () => {
  fs.mkdirSync(userData);
  // Reuse the existing settings read-only; never copy or print the API key.
  fs.symlinkSync(path.join(os.homedir(), 'Library', 'Application Support', 'WorkTool', 'ai-settings.json'), settingsLink);
  const env = { ...process.env, HUB_USER_DATA: userData, HUB_WORKSPACE: path.join(temp, 'workspace') }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env, executablePath: process.env.WORKTOOL_EXECUTABLE || require('electron') });
  page = await app.firstWindow(); await page.getByRole('heading', { name: '工作概览', exact: true }).waitFor();
  await saveClipboard(app);
  await writeClipboard(app, { file: path.resolve(process.env.WORKTOOL_CLIPBOARD_IMAGE) });
  await page.locator('.nav[data-page="import"]').click();
  const started = Date.now();
  await page.locator('[data-action="import-clipboard"]').click();
  await page.waitForFunction(() => document.querySelector('.import-banner') || /Error|失败|无效|没有图片/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 70000 });
  assert.equal(await page.locator('.import-banner').count(), 1, 'Clipboard import failed: ' + await page.locator('#toast').textContent());
  const appName = await page.locator('#import-0-name').inputValue();
  const packageName = await page.locator('#import-0-applicationId').inputValue();
  const appNameMatched = appName === process.env.WORKTOOL_EXPECT_APP;
  const packageNameMatched = packageName === process.env.WORKTOOL_EXPECT_PACKAGE;
  const unchanged = (await page.evaluate(() => window.hub.load())).revision === 0;
  assert(unchanged);
  const report = { passed: true, time: new Date().toISOString(), live: true, executable: process.env.WORKTOOL_EXECUTABLE || 'development Electron', elapsedMs: Date.now() - started, nativeClipboard: true, appNameMatched, packageNameMatched, allExpectedFieldsMatched: appNameMatched && packageNameMatched, configurationFields: await page.locator('[data-import-config]').count(), workspaceUnchanged: unchanged, limitations: ['One user-supplied screenshot, preview only; no project created or existing workspace modified.', 'Clipboard and LongCat API are genuine; no clipboard or HTTP method replacement.'] };
  await page.locator('[data-action="import-cancel"]').click();
  report.clipboardRestore = await restoreClipboard(app);
  await app.close(); app = null;
  fs.writeFileSync(path.join(root, 'validation', 'clipboard-live-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  assert(packageNameMatched, 'Application ID must be copied exactly');
})().catch(error => { fs.writeFileSync(path.join(root, 'validation', 'clipboard-live-failure.json'), JSON.stringify({passed:false,time:new Date().toISOString(),error:error.message},null,2)); console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (app) { await restoreClipboard(app).catch(() => {}); await app.close().catch(() => {}); }
  fs.rmSync(settingsLink, { force: true });
});
