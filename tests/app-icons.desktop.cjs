'use strict';
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Store } = require('../core.cjs');
const root = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktool-icons-ui-'));
const workspace = path.join(temp, 'workspace'), userData = path.join(temp, 'user-data');
const store = new Store(workspace), checks = [], errors = []; let app, page, firstImage;
const pass = text => { checks.push(text); console.log('PASS:', text); };
const files = () => fs.existsSync(path.join(workspace, 'attachments')) ? fs.readdirSync(path.join(workspace, 'attachments')) : [];
const action = name => page.locator(`[data-action="${name}"]`).first().click();
async function launch() {
  const env = { ...process.env, HUB_WORKSPACE: workspace, HUB_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env, executablePath: process.env.WORKTOOL_EXECUTABLE || require('electron') });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '工作概览', exact: true }).waitFor();
}
async function picker(file, canceled = false) {
  await app.evaluate(({ dialog }, value) => { dialog.showOpenDialog = async () => ({ canceled: value.canceled, filePaths: value.canceled ? [] : [value.file] }); }, { file, canceled });
  await page.locator('#choose-app-icon').click();
  await page.waitForFunction(() => !document.querySelector('#choose-app-icon')?.disabled);
}
async function save() { await page.locator('#editor button[type=submit]').click(); await page.locator('#modal').waitFor({ state: 'hidden' }); }
async function assertImage(selector) { await page.waitForFunction(sel => { const img = document.querySelector(sel); return img?.complete && img.naturalWidth > 0; }, selector); }
(async () => {
  await launch();
  const images = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 768;
    const x = c.getContext('2d'); x.fillStyle = '#26765f'; x.fillRect(0, 0, 1024, 768); x.fillStyle = '#fff'; x.font = 'bold 240px sans-serif'; x.fillText('A', 380, 470);
    const png = c.toDataURL('image/png'); x.fillStyle = '#3366cc'; x.fillRect(0, 0, 1024, 768); x.fillStyle = '#fff'; x.fillText('B', 380, 470); return { png, jpeg: c.toDataURL('image/jpeg') };
  });
  const one = path.join(temp, 'one.png'), two = path.join(temp, 'two.jpg'), invalid = path.join(temp, 'invalid.png');
  fs.writeFileSync(one, Buffer.from(images.png.split(',')[1], 'base64')); fs.writeFileSync(two, Buffer.from(images.jpeg.split(',')[1], 'base64')); fs.writeFileSync(invalid, 'not an image');
  await page.getByRole('button', { name: '演示应用', exact: true }).click(); await action('edit-package');
  const before = fs.readFileSync(store.file);
  await picker(one, true); assert.equal(await page.locator('#package-icon-editor img').count(), 0);
  await picker(one); await assertImage('#package-icon-editor img'); assert.deepEqual(files(), []);
  await page.locator('#cancel-modal').click(); assert.deepEqual(fs.readFileSync(store.file), before); assert.deepEqual(files(), []);
  pass('Canceling the native chooser or preview leaves application data and attachments unchanged');
  await action('edit-package'); await picker(invalid); await page.locator('#form-error').getByText(/无法读取图标/).waitFor(); assert.deepEqual(files(), []);
  await picker(one); await save(); await assertImage('.app-title .app-icon img');
  firstImage = store.load().packages[0].icon; assert.equal(firstImage.name, 'one.png');
  assert.equal(files().length, 1); assert(!fs.readFileSync(store.file, 'utf8').includes('data:image'));
  assert.equal(await page.locator('.app-title img').evaluate(img => img.naturalWidth), 512);
  assert.equal(await page.locator('.app-title img').evaluate(img => img.naturalHeight), 384);
  pass('Invalid files are rejected; PNG becomes a 512px proportional preview and saves as a portable attachment reference');
  for (const route of ['overview', 'packages', 'projects']) {
    await page.locator(`.nav[data-page=${route}]`).click();
    if (route === 'projects') await page.locator('[data-action=view-project]').first().click();
    await assertImage('.app-identity img');
    assert.equal(await page.locator('.app-identity img').evaluate(img => getComputedStyle(img).objectFit), 'contain');
  }
  await page.screenshot({ path: path.join(root, 'validation/app-icons-project.png'), fullPage: true });
  pass('The application icon appears beside the name in overview, package list and project detail');
  await page.getByRole('button', { name: '演示应用', exact: true }).click(); await action('edit-package');
  await picker(two); await save(); await assertImage('.app-title img');
  const replacement = store.load().packages[0].icon; assert.notEqual(replacement.path, firstImage.path); assert.equal(replacement.name, 'two.jpg');
  assert(fs.existsSync(store.resolveFile(firstImage.path)));
  await action('edit-package'); await page.locator('#remove-app-icon').click(); await page.locator('#cancel-modal').click();
  assert.deepEqual(store.load().packages[0].icon, replacement);
  await action('edit-package'); await page.locator('#remove-app-icon').click(); await save(); assert.equal(await page.locator('.app-title img').count(), 0); assert.equal(store.load().packages[0].icon, null);
  await action('edit-package'); await picker(one); await save();
  await app.close(); app = null; await launch(); await assertImage('.app-identity img');
  pass('JPEG replacement, canceled removal, saved removal and full restart preserve the selected icon correctly');
  await page.locator('.nav[data-page=packages]').click(); await action('new-package');
  await page.locator('[name=projectId]').selectOption('demo'); await page.locator('[name=name]').fill('New icon app'); await page.locator('[name=applicationId]').fill('com.example.icon');
  await picker(two); await save(); assert.equal(await page.locator('.app-identity img').count(), 2);
  pass('New applications can select and save their own independent icon');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'validation/app-icons-desktop-results.json'), JSON.stringify({ passed: true, time: new Date().toISOString(), checks, errors, executable: process.env.WORKTOOL_EXECUTABLE, temp, limitations: ['Synthetic isolated workspace; native file chooser returns fixture paths; actual decoding, IPC, persistence and image display run in the packaged app.'] }, null, 2) + '\n');
})().catch(error => { console.error(error); fs.writeFileSync(path.join(root, 'validation/app-icons-desktop-results.json'), JSON.stringify({ passed: false, checks, errors, error: error.stack, temp }, null, 2) + '\n'); process.exitCode = 1; }).finally(async () => { if (app) await app.close(); });
