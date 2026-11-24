'use strict';
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Store } = require('../core.cjs');
const root = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktool-markdown-ui-'));
const workspace = path.join(temp, 'workspace'), userData = path.join(temp, 'user-data');
const reference = path.join(temp, 'source report.json'); fs.writeFileSync(reference, '{}');
const source = [
  '# Markdown 阅读验收', '', '正文包含 **重点信息**、*斜体*、~~旧信息~~ 和 `com.example.app`。', '',
  '[跳到验证结果](#验证结果)', '', '> 引用资料：保留原始文档，阅读时显示排版。', '',
  '## 配置表', '', '| 配置 | 内容 |', '| --- | --- |', '| 应用 | WiFi Demo |', '| 分支 | `dev_demo` |', '',
  '1. 第一项', '   - 嵌套说明', '2. 第二项', '', '- [x] 已验证', '- [ ] 待核对', '',
  '```js', 'const value = "<script>文本</script>";', '// ' + 'long line '.repeat(28), '```', '',
  '[网页](https://example.com/docs)', '', '[本地网页](http://localhost:8080/)', '', `[源文件](<${reference}>)`, '',
  '![示例图片](https://example.com/pixel.png)', '', '## 验证结果', '', '**通过**，原文不变。', '',
  '<script>window.markdownUnsafe = true</script>', '', '<button data-action="delete-doc">注入按钮</button>', '',
  '[危险链接](javascript:alert(1))'
].join('\n');
const store = new Store(workspace), initial = store.load(); initial.docs.push({ id: 'md-doc', title: 'Markdown 阅读示例', content: source, projectId: '' }); store.save(initial);
const before = fs.readFileSync(store.file), checks = [], errors = [], requests = []; let app, page;
const pass = name => { checks.push(name); console.log('PASS:', name); };
async function launch() {
  const env = { ...process.env, HUB_WORKSPACE: workspace, HUB_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env, executablePath: process.env.WORKTOOL_EXECUTABLE || require('electron') });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await page.getByRole('heading', { name: '工作概览', exact: true }).waitFor();
  await app.evaluate(({ shell }) => {
    globalThis.__documentLinks = [];
    shell.openExternal = async target => { globalThis.__documentLinks.push({ kind: 'web', target }); };
    shell.showItemInFolder = target => { globalThis.__documentLinks.push({ kind: 'local', target }); };
  });
}
async function openDoc() {
  await page.locator('.nav[data-page=docs]').click();
  await page.locator('[data-action=view-doc][data-id=md-doc]').click();
  await page.locator('.doc-content h1').waitFor();
}
(async () => {
  await launch(); await openDoc();
  assert.equal(await page.locator('.doc-content h1').innerText(), 'Markdown 阅读验收');
  assert.equal(await page.locator('.doc-content h2').count(), 2);
  for (const selector of ['strong', 'em', 's', 'blockquote', 'ol', 'ul ul', 'table', 'pre code']) {
    // The nested list is inside an ordered list for this fixture.
    const actual = selector === 'ul ul' ? 'ol ul' : selector;
    assert(await page.locator('.doc-content ' + actual).count(), actual);
  }
  assert.equal(await page.locator('.md-task input[disabled]').count(), 2);
  assert.equal(await page.locator('.md-task input[checked]').count(), 1);
  assert.equal(await page.locator('.doc-content').evaluate(el => getComputedStyle(el).whiteSpace), 'normal');
  assert.deepEqual(fs.readFileSync(store.file), before);
  pass('Packaged Markdown renders headings, emphasis, nested lists, tables, code and read-only tasks without rewriting source');
  assert.equal(await page.locator('.doc-content script,.doc-content img,.doc-content button,.doc-content iframe').count(), 0);
  assert.equal(await page.evaluate(() => window.markdownUnsafe), undefined);
  assert.deepEqual(requests, []);
  pass('HTML and unsafe links stay inert; document reading sends no external image requests');
  await page.getByRole('link', { name: '跳到验证结果', exact: true }).click();
  assert(await page.locator('#md-验证结果').evaluate(el => { const box = el.getBoundingClientRect(); return box.top >= 0 && box.top < innerHeight; }));
  assert.equal((await app.evaluate(() => globalThis.__documentLinks)).length, 0);
  for (const name of ['网页', '本地网页', '源文件']) await page.getByRole('link', { name, exact: true }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.__documentLinks), [{ kind: 'web', target: 'https://example.com/docs' }, { kind: 'web', target: 'http://localhost:8080/' }, { kind: 'local', target: fs.realpathSync(reference) }]);
  assert(await page.evaluate(() => window.hub.documentOpenLink('md-doc', 'https://not-in-doc.example.com').then(() => false, () => true)));
  assert(page.url().startsWith('file:'));
  pass('Heading links scroll internally; web and local reference clicks use validated IPC and cannot navigate the app');
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: path.join(root, 'validation/markdown-reading.png'), fullPage: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert(await page.locator('.doc-content pre').evaluate(el => el.scrollWidth > el.clientWidth));
  pass('At 900px width, long code scrolls inside its block without overflowing the page');
  await page.locator('[data-action=edit-doc]').click();
  assert.equal(await page.locator('[name=content]').inputValue(), source);
  const updated = source + '\n\n## 新增章节\n\n编辑后仍为 **Markdown**。';
  await page.locator('[name=content]').fill(updated);
  await page.locator('#editor button[type=submit]').click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  await page.locator('.doc-content h2').getByText('新增章节', { exact: true }).waitFor();
  assert.equal(store.load().docs.find(d => d.id === 'md-doc').content, updated);
  await app.close(); app = null; await launch(); await openDoc();
  assert.equal(await page.locator('.doc-content h2').count(), 3);
  assert.equal(store.load().docs.find(d => d.id === 'md-doc').content, updated);
  assert.deepEqual(errors, []);
  pass('Markdown source editing, save, immediate reading and full restart preserve content');
  fs.writeFileSync(path.join(root, 'validation/markdown-desktop-results.json'), JSON.stringify({ passed: true, time: new Date().toISOString(), checks, errors, executable: process.env.WORKTOOL_EXECUTABLE, temp, limitations: ['Synthetic isolated workspace; external browser and Finder calls are captured, not actually launched.'] }, null, 2) + '\n');
})().catch(async error => {
  console.error(error);
  fs.writeFileSync(path.join(root, 'validation/markdown-desktop-results.json'), JSON.stringify({ passed: false, checks, errors, error: error.stack, temp }, null, 2) + '\n');
  process.exitCode = 1;
}).finally(async () => { if (app) await app.close(); });
