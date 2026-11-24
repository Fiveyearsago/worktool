'use strict';
const { _electron: electron } = require('playwright-core');
const { saveClipboard, writeClipboard, restoreClipboard } = require('./clipboard-fixture.cjs');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..'), testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'worktool-ai-desktop-'));
const workspace = path.join(testRoot, 'workspace'), userData = path.join(testRoot, 'user-data');
const checks = [], errors = []; let app, page;
const pass = name => { checks.push(name); console.log('PASS:', name); };
const action = name => page.locator(`[data-action="${name}"]`).first().click();
const nav = name => page.locator(`.nav[data-page="${name}"]`).click();
const state = () => page.evaluate(() => window.hub.load());
const calls = () => app.evaluate(() => globalThis.__aiCalls.length);
async function waitMain(predicate) { for(let i=0;i<100;i++){if(await app.evaluate(predicate))return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Timed out waiting for main process'); }
async function launch() {
  const env = { ...process.env, HUB_WORKSPACE: workspace, HUB_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env, executablePath: process.env.WORKTOOL_EXECUTABLE || require('electron') });
  page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('heading', { name: '工作概览', exact: true }).waitFor();
  await app.evaluate(({safeStorage})=>{for(const name of ['isAsyncEncryptionAvailable','encryptStringAsync','decryptStringAsync','isEncryptionAvailable','encryptString','decryptString'])safeStorage[name]=()=>{throw Error('Keychain must not be used');};});
  await app.evaluate(() => {
    globalThis.__aiCalls = []; globalThis.__aiMode = 'ok'; globalThis.__aiAborted = false;
    globalThis.fetch = async (url, opts) => {
      if (url !== 'https://api.longcat.chat/openai/v1/chat/completions') throw Error('unexpected endpoint');
      const body = JSON.parse(opts.body); globalThis.__aiCalls.push(body);
      if (globalThis.__aiMode === 'delay') return new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => { globalThis.__aiAborted = true; reject(opts.signal.reason); }, { once: true });
      });
      if (globalThis.__aiMode === 'unauthorized') return new Response('synthetic-secret', { status: 401 });
      const data = { project: { name: '截图创建项目', description: '截图中的项目说明', repo: 'https://example.com/screenshot.git' }, text: '应用名：截图应用\n包名：com.example.screenshot', records: [{ projectName: '合成项目', name: 'AI 导入应用', applicationId: 'com.example.ai.desktop', branch: 'Release/AI', flavor: 'global', vpsIp: '203.0.113.20', repo: '', notes: '<script>test</script>', fields: [{ title: '域名', content: 'https://example.com' }] }], warnings: [] };
      if(globalThis.__projectOnly)data.records=[];
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: body.max_tokens === 16 ? 'OK' : JSON.stringify(data) } }] }));
    };
  });
}
(async () => {
  await launch();
  await saveClipboard(app);
  if (process.env.WORKTOOL_EXECUTABLE) assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  await nav('ai');
  assert.equal(await page.locator('#ai-model').inputValue(), 'LongCat-2.5');
  await page.locator('#ai-key').fill('synthetic-longcat-desktop-key');
  await action('ai-test');
  await page.locator('#ai-status').getByText(/连接成功/).waitFor({ timeout: 45000 });
  assert.equal(await page.locator('#ai-key').inputValue(), '');
  const diskSettings = fs.readFileSync(path.join(userData, 'ai-settings.json'), 'utf8');
  assert.equal(JSON.parse(diskSettings).apiKey, 'synthetic-longcat-desktop-key');
  assert.equal(fs.statSync(path.join(userData, 'ai-settings.json')).mode & 0o777, 0o600);
  assert.equal((await page.evaluate(() => window.hub.aiStatus())).hasKey, true);
  assert.equal(await calls(), 1);
  await page.screenshot({ path: path.join(root, 'validation', 'ai-settings.png') });
  pass('Local owner-only settings, password input clearing, IPC status and connection test');
  await nav('import'); assert.equal(await page.locator('#import-mode').inputValue(), 'longcat');
  const original = '# 合成资料\n说明原文必须保留。';
  await page.locator('#import-paste').fill(original); await action('import-paste');
  await page.locator('.import-banner').waitFor();
  assert.equal(await page.locator('#import-source').inputValue(), original);
  assert.equal(await page.locator('#import-0-applicationId').inputValue(), 'com.example.ai.desktop');
  assert.equal(await page.locator('#import-0-branch').inputValue(), 'Release/AI');
  assert.equal(await page.locator('#import-0-vpsIp').inputValue(), '203.0.113.20');
  assert.equal((await state()).revision, 0);
  await page.locator('#import-0-name').fill('人工确认后的应用名');
  await page.locator('[name="import-project"]').selectOption('demo');
  await page.locator('#import-confirm').check();
  const countBeforeSave = await calls(); await action('import-save');
  await page.locator('[data-action="edit-project"]').waitFor();
  assert.equal(await calls(), countBeforeSave);
  assert.equal((await state()).packages.at(-1).name, '人工确认后的应用名');
  assert.equal((await state()).docs.at(-1).content, original);
  assert.equal((await state()).packages.at(-1).vpsIp, '203.0.113.20');
  assert.equal(fs.existsSync(path.join(workspace, 'ai-settings.json')), false);
  pass('AI text preview, exact identifiers, original text and manual edits persist without a second API call');

  await nav('import');
  const screenshot = path.join(testRoot, 'synthetic.png'); await page.screenshot({ path: screenshot });
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, screenshot);
  await action('import-file'); await page.locator('.import-banner').waitFor();
  assert.match(await page.locator('#import-source').inputValue(), /截图应用/);
  const sentImage = await app.evaluate(() => globalThis.__aiCalls.at(-1).messages[1].content[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.equal(sentImage, true);
  await page.screenshot({ path: path.join(root, 'validation', 'ai-import-preview.png') });
  await action('import-cancel');
  pass('Screenshot decoding, image_url transport and AI preview without Vision');

  await nav('projects'); await action('new-project');
  await page.locator('#project-from-clipboard').waitFor();
  await app.evaluate(() => { globalThis.__projectOnly=true; });
  await writeClipboard(app, {file:screenshot});
  await page.locator('#project-from-clipboard').click(); await page.locator('.import-banner').waitFor();
  assert.equal(await page.locator('[name="import-project-name"]').inputValue(),'截图创建项目');
  assert.equal(await page.locator('[name="import-project-description"]').inputValue(),'截图中的项目说明');
  assert.equal(await page.locator('[name="import-knowledge-repo"]').inputValue(),'');
  assert.equal(await page.locator('[data-import-row]').count(),0);
  await page.locator('#import-confirm').check(); await action('import-save'); await page.locator('[data-action="edit-project"]').waitFor();
  const created=(await state()).projects.find(x=>x.name==='截图创建项目');
  assert(created);assert.equal(created.repo,'');assert.equal(created.description,'截图中的项目说明');
  pass('New project → paste screenshot → auto-filled project-only metadata → create without manual entry');
  await nav('import');
  await app.evaluate(()=>{globalThis.__projectOnly=false;});

  const imageResult = await app.evaluate(({ app, nativeImage }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.cjs');
    const { prepareImages } = require(require('node:path').join(app.getAppPath(), 'ai-image.cjs'));
    const large = nativeImage.createFromBitmap(Buffer.alloc(3200 * 3200 * 4, 255), { width: 3200, height: 3200 });
    const result = prepareImages(large.toPNG(), nativeImage);
    return { count: result.images.length, sizes: result.images.map(x => nativeImage.createFromDataURL(x).getSize()) };
  });
  assert.equal(imageResult.count, 4); assert(imageResult.sizes.every(s => s.width * s.height <= 5242880));
  pass('Large screenshot splits into valid tiles while preserving text resolution');

  const docsBeforeCancel = (await state()).docs.length;
  await app.evaluate(() => { globalThis.__aiMode = 'delay'; });
  await page.locator('#import-paste').fill('应被取消的合成资料'); await action('import-paste');
  await page.getByRole('heading', { name: '正在使用 LongCat 识别…' }).waitFor();
  await waitMain(() => globalThis.__aiCalls.at(-1).messages[1].content === '应被取消的合成资料');
  await action('import-cancel'); await page.locator('#import-paste').waitFor();
  await waitMain(() => globalThis.__aiAborted);
  assert.equal(await page.locator('.import-banner').count(), 0); assert.equal((await state()).docs.length, docsBeforeCancel);
  pass('Cancel aborts the transport and creates no preview or saved data');

  await app.evaluate(() => { globalThis.__aiMode = 'unauthorized'; });
  await page.locator('#import-paste').fill('鉴权失败资料'); await action('import-paste');
  await page.locator('#toast').getByText(/API Key 无效/).waitFor();
  assert.doesNotMatch(await page.locator('#toast').textContent(), /synthetic-secret/);
  assert.equal(await page.locator('#import-paste').inputValue(), '鉴权失败资料');
  pass('Authentication error is actionable, redacted and retains pasted source');

  await restoreClipboard(app);
  await app.close(); app = null; await launch();
  await nav('ai'); assert.equal((await page.evaluate(() => window.hub.aiStatus())).hasKey, true);
  await action('ai-test'); await page.locator('#ai-status').getByText(/连接成功/).waitFor();
  await action('ai-remove'); await page.locator('#ai-status').getByText(/已移除/).waitFor();
  assert.equal((await page.evaluate(() => window.hub.aiStatus())).hasKey, false);
  await nav('import'); assert.equal(await page.locator('#import-mode').inputValue(), 'local');
  pass('Local credentials survive restart and removal returns imports to offline mode');
  assert.deepEqual(errors, []);
  await app.close(); app = null;
  fs.writeFileSync(path.join(root, 'validation', 'ai-desktop-results.json'), JSON.stringify({ passed: true, time: new Date().toISOString(), checks, errors, testRoot, executable: process.env.WORKTOOL_EXECUTABLE || 'development Electron', limitations: ['Synthetic fixtures and mocked HTTP responses; real LongCat credential/latency/accuracy not tested. Native file chooser is substituted.'] }, null, 2));
})().catch(async error => {
  console.error(error);
  if (page) await page.screenshot({ path: path.join(root, 'validation', 'ai-desktop-failure.png') }).catch(() => {});
  if (app) { await restoreClipboard(app).catch(() => {}); await app.close().catch(() => {}); }
  fs.writeFileSync(path.join(root, 'validation', 'ai-desktop-results.json'), JSON.stringify({ passed: false, checks, errors, error: error.stack, testRoot }, null, 2));
  process.exitCode = 1;
});
