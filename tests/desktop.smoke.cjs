const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'worktool-desktop-'));
const workspace = path.join(testRoot, 'workspace');
const userData = path.join(testRoot, 'user-data');
const reportDir = path.join(root, 'validation');
fs.mkdirSync(reportDir, { recursive: true });
const checks = [], errors = [];
let app, page;
const pass = name => { checks.push(name); console.log('PASS:', name); };
const state = () => page.evaluate(() => window.hub.load());
const action = name => page.locator(`[data-action="${name}"]`).first().click();
const nav = name => page.locator(`.nav[data-page="${name}"]`).click();
const fill = (name, value) => page.locator(`[name="${name}"]`).fill(value);
const save = async () => {
  await page.locator('#editor button[type=submit]').click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
};
const selectFile = async file => app.evaluate(({ dialog }, selected) => {
  // Only the native chooser is replaced: renderer, preload, IPC and Store remain real.
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
}, file);
async function launch() {
  const env = { ...process.env, HUB_WORKSPACE: workspace, HUB_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [root], env, timeout: 45000,
    executablePath: process.env.WORKTOOL_EXECUTABLE || require('electron'),
  });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '工作概览', exact: true }).waitFor();
  await app.evaluate(({ session }) => session.fromPartition('persist:worktool-bastion').protocol.handle('https', () => new Response('<!doctype html><title>Synthetic login</title>', { headers: { 'Content-Type': 'text/html' } })));
}

(async () => {
  await launch();
  assert.equal((await state()).projects.length, 1);
  if (process.env.WORKTOOL_EXECUTABLE) {
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    pass('Packaged executable runs bundled app rather than development source');
  }
  pass('Real Electron window, sandboxed preload and IPC load');

  await action('new-project');
  await fill('name', '应被取消');
  await page.locator('#cancel-modal').click();
  assert.equal((await state()).projects.length, 1);
  await action('new-project');
  await fill('name', '验收项目 A');
  await fill('description', '合成测试数据，不含公司资料');
  await fill('knowledgeRepo', 'https://example.com/test/project-a.git');
  await save();
  const projectId = (await state()).projects.find(p => p.name === '验收项目 A').id;
  assert.equal((await state()).knowledge.repo,'https://example.com/test/project-a.git');
  pass('Project create, cancel and persisted shared knowledge repository');

  assert.equal(await page.locator('[data-page=accounts]').count(), 0);

  await nav('templates');
  await action('new-template');
  await fill('name', '验收新包流程');
  for (const [i, title] of ['确定包名', '配置域名', '临时步骤'].entries()) {
    await page.locator('#add-step').click();
    await page.locator(`[data-step-index="${i}"]`).fill(title);
  }
  await page.locator('[data-remove="2"]').click();
  await page.locator('[data-move="1"][data-dir="-1"]').click();
  await save();
  let template = (await state()).templates.find(t => t.name === '验收新包流程');
  assert.deepEqual(template.steps.map(s => s.title), ['配置域名', '确定包名']);
  pass('Custom template add, remove, reorder and save');

  await nav('packages');
  await action('new-package');
  await page.locator('[name=projectId]').selectOption(projectId);
  await fill('name', '验收应用 A1');
  await fill('applicationId', 'com.example.acceptance.a1');
  await fill('branch', 'release/acceptance');
  await fill('flavor', 'acceptanceChina');
  await fill('vpsIp', ' 203.0.113.22 ');
  await save();
  const packageId = (await state()).packages.find(p => p.name === '验收应用 A1').id;
  await page.locator(`[data-action=view-package][data-id="${packageId}"]`).first().click();
  assert.equal((await state()).packages.find(p => p.id === packageId).vpsIp, '203.0.113.22');
  assert.equal(await page.locator('[name=gpAccountId]').count(), 0);
  await page.getByRole('heading', { name: '应用基本配置', exact: true }).waitFor();
  await action('edit-package');
  await fill('vpsIp', '203.0.113.22:3389');
  const beforeInvalidIp = await state();
  await page.locator('#editor button[type=submit]').click();
  await page.locator('#toast').getByText(/有效的跳板机 VPS IP 地址/).waitFor();
  assert.deepEqual(await state(), beforeInvalidIp);
  await fill('vpsIp', ' 2001:db8::22 '); await save();
  assert.equal((await state()).packages.find(p => p.id === packageId).vpsIp, '2001:db8::22');
  await action('edit-package'); await fill('vpsIp', ''); await save();
  assert.equal((await state()).packages.find(p => p.id === packageId).vpsIp, '');
  await action('edit-package'); await fill('vpsIp', '203.0.113.22'); await save();
  pass('VPS basic config accepts IPv4/IPv6/blank, trims values and rejects invalid IP without data loss');
  await action('apply-template');
  await page.locator('[name=templateId]').selectOption(template.id);
  await save();
  assert.equal((await state()).packages.find(p => p.id === packageId).tasks.length, 2);
  await page.locator('[data-task]').first().check();
  await page.waitForFunction(() => document.querySelector('.task.done'));
  await action('edit-task');
  await fill('content', 'https://acceptance.example.com');
  await fill('notes', '测试配置说明');
  const attachment = path.join(testRoot, '验收说明.txt');
  fs.writeFileSync(attachment, '这是一份合成附件。\n');
  await selectFile(attachment);
  await page.locator('#pick-file').click();
  await page.locator('#file-list').getByText('验收说明.txt').waitFor();
  await save();
  let pkg = (await state()).packages.find(p => p.id === packageId);
  assert.equal(pkg.tasks[0].done, true);
  assert.equal(pkg.tasks[0].content, 'https://acceptance.example.com');
  assert.equal(fs.readFileSync(path.join(workspace, pkg.tasks[0].files[0].path), 'utf8'), '这是一份合成附件。\n');
  pass('Package mapping, template application, task completion/content/notes and real attachment copy');
  await page.screenshot({ path: path.join(reportDir, 'desktop-package.png'), fullPage: true });

  await nav('templates');
  await page.locator(`[data-action=edit-template][data-id="${template.id}"]`).click();
  await page.locator('[data-step-index="0"]').fill('新模板步骤');
  await save();
  assert.equal((await state()).packages.find(p => p.id === packageId).tasks[0].title, '配置域名');
  pass('Template edits preserve existing package task snapshot');

  await nav('packages');
  for (const term of ['验收应用 A1', 'com.example.acceptance.a1', 'release/acceptance', 'acceptanceChina', '203.0.113.22', '验收项目 A']) {
    await page.locator('#search').fill(term);
    assert.equal(await page.locator('tbody tr').count(), 1, term);
  }
  await page.locator('#search').fill('no-such-application');
  assert.equal(await page.locator('tbody tr').count(), 0);
  await page.locator('#search').fill('');
  await action('new-package');
  await page.locator('[name=projectId]').selectOption(projectId);
  await fill('name', '重复包名');
  await fill('applicationId', 'com.example.acceptance.a1');
  await page.locator('#editor button[type=submit]').click();
  await page.locator('#form-error').getByText('此包名已存在').waitFor();
  await page.locator('#cancel-modal').click();
  pass('Search by name/package/project/branch/flavor/VPS IP and duplicate package rejection');

  await nav('docs');
  await action('new-doc');
  await fill('title', '通用知识验收');
  await fill('content', '# 通用说明\n<script>window.bad=true</script>');
  await save();
  const doc = (await state()).docs.find(d => d.title === '通用知识验收');
  assert.equal(doc.projectId, '');
  await page.locator(`[data-action=view-doc][data-id="${doc.id}"]`).click();
  assert.equal(await page.locator('#content script').count(), 0);
  assert.equal(await page.evaluate(() => window.bad), undefined);
  assert.match(await page.locator('.doc-content').textContent(), /<script>/);
  pass('General knowledge saves without project; Markdown HTML remains inert text');

  await nav('sync');
  await action('git-status');
  await page.locator('#git-output').getByText(/尚未初始化 Git/).waitFor();
  const beforeInvalid = await state();
  const invalid = path.join(testRoot, 'not-a-workspace');
  fs.mkdirSync(invalid);
  fs.writeFileSync(path.join(invalid, 'keep.txt'), 'do not overwrite');
  await selectFile(invalid);
  await action('choose-workspace');
  await page.locator('#toast').getByText(/空目录/).waitFor();
  assert.deepEqual(await state(), beforeInvalid);
  assert.equal(fs.readFileSync(path.join(invalid, 'keep.txt'), 'utf8'), 'do not overwrite');
  pass('Git status and nonempty workspace rejection without changing active data');

  const persisted = await state();
  await nav('overview');
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(reportDir, 'desktop-overview.png'), fullPage: true });
  await app.close();
  app = null;
  await launch();
  assert.deepEqual(await state(), persisted);
  assert.ok(fs.readdirSync(path.join(workspace, '.backups')).length > 0);
  pass('Full app close/relaunch preserves projects, VPS IP, templates, tasks, notes, files and docs');
  assert.deepEqual(errors, []);
  pass('No renderer page errors');
  await app.close();
  app = null;
  fs.writeFileSync(path.join(reportDir, 'desktop-results.json'), JSON.stringify({
    passed: true, time: new Date().toISOString(), platform: process.platform, arch: process.arch,
    executable: process.env.WORKTOOL_EXECUTABLE || 'development Electron',
    checks, errors, testRoot,
    limitations: ['Native file chooser was stubbed; actual IPC, attachment copy and persistence were tested.', 'No network Git remote or production data was used.'],
  }, null, 2));
})().catch(async error => {
  console.error(error);
  if (page) await page.screenshot({ path: path.join(reportDir, 'desktop-failure.png') }).catch(() => {});
  if (app) await app.close().catch(() => {});
  fs.writeFileSync(path.join(reportDir, 'desktop-results.json'), JSON.stringify({ passed: false, checks, errors, error: error.stack, testRoot }, null, 2));
  process.exitCode = 1;
});
