'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Store, gitExecutable } = require('../core.cjs');
const { KnowledgeRepository, projectFolder, knowledgeURL } = require('../knowledge-repository.cjs');
process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_CONFIG_GLOBAL = '/dev/null';
const git = (cwd, ...args) => execFileSync(gitExecutable, ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t, empty = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worktool-knowledge-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const remote = path.join(base, 'remote.git'); git(base, 'init', '--bare', '--initial-branch=main', remote);
  const writer = path.join(base, 'writer'); git(base, 'clone', remote, writer);
  if (!empty) { fs.writeFileSync(path.join(writer, 'README.md'), 'Original repository documentation\n'); git(writer, 'add', '.'); git(writer, 'commit', '-m', 'Existing docs'); git(writer, 'push', 'origin', 'HEAD'); }
  const store = new Store(path.join(base, 'workspace')), state = store.load();
  state.packages[0].vpsIp='2001:db8::10';
  state.knowledge = { repo: new URL('file://' + remote).href };
  state.projects.push({ id: 'second', name: '示例项目 · 充电工具', description: '第二个独立项目目录' });
  state.docs.push({ id: 'doc-two', projectId: 'second', title: '第二个项目说明', content: '# 原始 Markdown\n\n内容不会被改写。' }, { id: 'general', projectId: '', title: '通用文档', content: '两个项目共享' });
  const original = path.join(base, 'fixture.txt'); fs.writeFileSync(original, '附件内容\n');
  state.docs[0].files = [store.importFile(original)]; state.packages[0].tasks[0].files = [store.importFile(original)];
  store.save(state);
  const library = new KnowledgeRepository(() => store, path.join(base, 'user-data'));
  await library.connect();
  return { base, remote, writer, store, library, directory: library.status().directory };
}
test('Shared repository separates projects, exports Markdown and original attachments, and preserves unrelated files', async t => {
  const { store, library, directory } = await fixture(t);
  const state = store.load(), one = projectFolder(state.projects[0]), two = projectFolder(state.projects[1]);
  assert.notEqual(one, two);
  assert.equal(fs.readFileSync(path.join(directory, 'README.md'), 'utf8'), 'Original repository documentation\n');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'worktool/.manifest.json')));
  const docs = Object.keys(manifest.files);
  assert(docs.some(file => file.startsWith(one + '/docs/')) && docs.some(file => file.startsWith(two + '/docs/')));
  assert(docs.some(file => file.startsWith('worktool/general/docs/')));
  const appDoc=docs.find(file => file.startsWith(one + '/applications/'));
  assert.match(fs.readFileSync(path.join(directory,appDoc),'utf8'),/跳板机 VPS IP 地址：2001:db8::10/);
  const attachment = docs.find(file => file.startsWith(one + '/attachments/'));
  assert.equal(fs.readFileSync(path.join(directory, attachment), 'utf8'), '附件内容\n');
  assert(!docs.some(file => /hub\.json|ai-settings|\.backups/.test(file)));
  const docPath = docs.find(file => file.startsWith(two + '/docs/'));
  assert(fs.readFileSync(path.join(directory, docPath), 'utf8').includes(state.docs[1].content));
  state.docs[1].content = '更新后的文档'; store.save(state);
  assert.equal((await library.refresh()).error, '');
  assert(fs.readFileSync(path.join(directory, docPath), 'utf8').includes('更新后的文档'));
  fs.writeFileSync(path.join(directory, two, 'handwritten.md'), '保留手写文件');
  state.docs = state.docs.filter(doc => doc.id !== 'doc-two'); store.save(state); await library.refresh();
  assert(!fs.existsSync(path.join(directory, docPath)));
  assert.equal(fs.readFileSync(path.join(directory, two, 'handwritten.md'), 'utf8'), '保留手写文件');
});
test('Empty remote can receive an initial commit; later sync pushes exact branch without unrelated tags or files', async t => {
  const { library, directory, remote, store, base } = await fixture(t, true);
  const result = await library.sync(); assert.match(result.output, /同步成功/);
  assert.equal(git(directory, 'rev-parse', 'HEAD'), git(base, '--git-dir=' + remote, 'rev-parse', 'refs/heads/main'));
  git(directory, 'config', 'remote.origin.push', 'HEAD:refs/heads/unwanted');
  git(directory, 'config', 'push.followTags', 'true'); git(directory, 'tag', '-a', 'private-tag', '-m', 'private');
  const state = store.load(); state.docs[0].content = '再次保存'; store.save(state); await library.refresh(); await library.sync();
  assert.equal(git(base, '--git-dir=' + remote, 'for-each-ref', '--format=%(refname)', 'refs/tags', 'refs/heads/unwanted'), '');
  assert.equal(git(directory, 'status', '--porcelain'), '');
  assert.equal(git(directory, 'rev-parse', 'HEAD'), git(base, '--git-dir=' + remote, 'rev-parse', 'refs/heads/main'));
});
test('External edits and deleted documents stop export without losing saved application data', async t => {
  const { library, directory, store } = await fixture(t);
  const state = store.load(), folder = projectFolder(state.projects[0]);
  const file = path.join(directory, folder, 'README.md'); fs.writeFileSync(file, '外部修改');
  state.projects[0].description = '应用中新保存的内容'; store.save(state);
  assert.match((await library.refresh()).error, /外部修改/);
  assert.equal(fs.readFileSync(file, 'utf8'), '外部修改');
  assert.equal(store.load().projects[0].description, '应用中新保存的内容');
  fs.unlinkSync(file); assert.match((await library.refresh()).error, /外部删除/);
});
test('Symlink targets and a forged manifest cannot write or remove files outside the knowledge directory', async t => {
  const { library, directory, base } = await fixture(t);
  const manifestPath = path.join(directory, 'worktool/.manifest.json'), saved = fs.readFileSync(manifestPath);
  fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, files: { '../outside': '0'.repeat(64) } }));
  assert.match((await library.refresh()).error, /路径无效/);
  fs.writeFileSync(manifestPath, saved);
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'README.md'), 'keep');
  fs.renameSync(path.join(directory, 'worktool'), path.join(directory, 'saved-worktool'));
  fs.symlinkSync(outside, path.join(directory, 'worktool'));
  assert.match((await library.refresh()).error, /符号链接/);
  assert.equal(fs.readFileSync(path.join(outside, 'README.md'), 'utf8'), 'keep');
});
test('Unrelated staged edits, changed remote and concurrent instance locks block knowledge sync', async t => {
  const { library, directory, base } = await fixture(t); await library.sync();
  const head = git(directory, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(directory, 'unrelated.txt'), 'must not be uploaded'); git(directory, 'add', 'unrelated.txt');
  await assert.rejects(library.sync(), /其他文件改动/); assert.equal(git(directory, 'rev-parse', 'HEAD'), head);
  git(directory, 'reset', '--', 'unrelated.txt'); fs.unlinkSync(path.join(directory, 'unrelated.txt'));
  fs.writeFileSync(directory + '.lock', 'another instance'); await assert.rejects(library.sync(), /另一个实例/); fs.unlinkSync(directory + '.lock');
  git(directory, 'remote', 'set-url', '--push', 'origin', path.join(base, 'different.git'));
  await assert.rejects(library.sync(), /远端地址已改变/);
});
test('Remote document changes and divergent history are never overwritten', async t => {
  const { library, directory, writer, store, remote, base } = await fixture(t); await library.sync();
  git(writer, 'pull', '--ff-only', 'origin', 'main');
  const file = projectFolder(store.load().projects[0]) + '/README.md'; fs.writeFileSync(path.join(writer, file), 'Remote document edit');
  git(writer, 'add', file); git(writer, 'commit', '-m', 'Remote docs'); git(writer, 'push', 'origin', 'HEAD');
  const head = git(directory, 'rev-parse', 'HEAD'), remoteHead = git(writer, 'rev-parse', 'HEAD');
  await assert.rejects(library.sync(), /远端知识库资料有更新/); assert.equal(git(directory, 'rev-parse', 'HEAD'), head);
  const state = store.load(); state.docs[0].content = 'Local changes'; store.save(state); await library.refresh();
  await assert.rejects(library.sync(), /已分叉/);
  assert.equal(git(base, '--git-dir=' + remote, 'rev-parse', 'HEAD'), remoteHead);
});
test('Knowledge URL validation does not reinterpret legacy code repositories or persist transient status', () => {
  assert.equal(knowledgeURL('git@example.com:team/knowledge.git'), 'git@example.com:team/knowledge.git');
  for (const value of ['https://user:secret@example.com/docs.git', 'ext::command', 'http://example.com/repo', '--upload-pack=x', 'https://example.com/repo?token=secret']) assert.throws(() => knowledgeURL(value));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-config-'));
  try {
    const store = new Store(base), state = store.load();
    assert.equal(state.knowledge.repo, ''); assert(state.projects[0].repo);
    state.__knowledge = { directory: '/local-only/path' }; store.save(state);
    assert(!fs.readFileSync(store.file, 'utf8').includes('/local-only/path'));
    state.knowledge.repo = 'https://user:secret@example.com/docs.git'; assert.throws(() => store.save(state), /不能包含/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
test('Connecting a different workspace cannot delete or replace existing WorkTool documents in the shared repository', async t => {
  const { library, directory, base, store } = await fixture(t); await library.sync();
  const before = fs.readFileSync(path.join(directory, 'worktool/.manifest.json'));
  const other = new Store(path.join(base, 'other-workspace')), state = other.load(); state.knowledge = store.load().knowledge; state.projects[0].description = 'Different workspace'; other.save(state);
  const second = new KnowledgeRepository(() => other, path.join(base, 'user-data'));
  await assert.rejects(second.connect(), /其他工作区/);
  assert.match((await second.refresh()).error, /其他工作区/);
  assert(fs.readFileSync(path.join(directory, 'worktool/.manifest.json')).equals(before));
  assert.equal(git(directory, 'status', '--porcelain'), '');
});
