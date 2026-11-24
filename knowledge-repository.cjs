'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { knowledgeURL } = require('./knowledge-config.cjs');
const gitBinary = process.platform === 'darwin' ? '/usr/bin/git' : 'git';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const slug = value => String(value || '未命名').normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^\.+/, '').slice(0, 60) || '未命名';
const named = item => slug(item.name || item.title) + '-' + hash(String(item.id)).slice(0, 12);
const projectFolder = project => 'worktool/projects/' + named(project);
const MANIFEST = 'worktool/.manifest.json';
const md = value => String(value || '').replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>#|])/g, '\\$1');
const link = (label, file) => `[${md(label)}](${file.split('/').map(encodeURIComponent).join('/')})`;
function safePath(root, relative) {
  if (!relative.startsWith('worktool/') || relative.includes('\\') || relative.split('/').some(x => !x || x === '.' || x === '..' || x.toLowerCase() === '.git')) throw Error('知识库文件路径无效');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw Error('知识库目录或文件不允许符号链接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
function readManifest(root) {
  const file = safePath(root, MANIFEST);
  if (!fs.existsSync(file)) return { version: 1, files: {} };
  if (fs.statSync(file).size > 4 * 1024 * 1024) throw Error('知识库索引过大');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.version !== 1 || !value.files || Array.isArray(value.files) || typeof value.files !== 'object') throw Error('知识库索引无效');
  for (const [name, digest] of Object.entries(value.files)) {
    safePath(root, name);
    if (name === MANIFEST || !/^[a-f0-9]{64}$/.test(digest)) throw Error('知识库索引无效');
  }
  return value;
}
function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function snapshot(store, state) {
  const files = new Map(), put = (file, value) => files.set(file, Buffer.isBuffer(value) ? value : Buffer.from(value));
  function attachments(items, folder, from) {
    return (items || []).map(file => {
      const bytes = fs.readFileSync(store.resolveFile(file.path));
      const destination = folder + '/attachments/' + hash(bytes).slice(0, 16) + '-' + slug(file.name);
      put(destination, bytes);
      return '- ' + link(file.name, path.posix.relative(from, destination));
    }).join('\n');
  }
  function document(doc, folder) {
    const file = folder + '/docs/' + named(doc) + '.md';
    const links = attachments(doc.files, folder, folder + '/docs');
    put(file, '# ' + md(doc.title) + '\n\n' + (doc.content || '') + (links ? '\n\n## 原始附件\n\n' + links : '') + '\n');
    return '- ' + link(doc.title, 'docs/' + named(doc) + '.md');
  }
  const index = ['# 项目知识库', '', '本目录由 WorkTool 保存项目资料；其他目录及未纳入索引的文件保持原样。', ''];
  for (const project of state.projects) {
    const folder = projectFolder(project), docs = state.docs.filter(doc => doc.projectId === project.id);
    const packages = state.packages.filter(pkg => pkg.projectId === project.id);
    index.push('- ' + link(project.name, folder.slice('worktool/'.length) + '/README.md'));
    const applicationLinks = [];
    for (const pkg of packages) {
      const lines = ['# ' + md(pkg.name || pkg.applicationId), '', '- 包名：' + md(pkg.applicationId), '- 分支：' + md(pkg.branch), '- Flavor：' + md(pkg.flavor), '- 跳板机 VPS IP 地址：' + md(pkg.vpsIp), '', pkg.notes || '', '', '## 配置与任务', ''];
      if (pkg.icon) {
        const bytes = fs.readFileSync(store.resolveFile(pkg.icon.path));
        const destination = folder + '/attachments/' + hash(bytes).slice(0, 16) + '-icon.png';
        put(destination, bytes);
        lines.splice(2, 0, '!' + link('应用 Icon', path.posix.relative(folder + '/applications', destination)), '');
      }
      for (const task of pkg.tasks || []) lines.push('### ' + (task.done ? '已完成 · ' : '待完成 · ') + md(task.title), '', task.content || '', '', task.notes || '', '', attachments(task.files, folder, folder + '/applications'), '');
      put(folder + '/applications/' + named(pkg) + '.md', lines.join('\n'));
      applicationLinks.push('- ' + link(pkg.name || pkg.applicationId, 'applications/' + named(pkg) + '.md'));
    }
    put(folder + '/README.md', ['# ' + md(project.name), '', project.description || '', '', '## 项目文档', '', ...docs.map(doc => document(doc, folder)), '', '## 应用资料', '', ...applicationLinks, ''].join('\n'));
  }
  const general = state.docs.filter(doc => !doc.projectId);
  if (general.length) { index.push('', '## 通用知识', ''); for (const doc of general) index.push('- ' + link(doc.title, 'general/docs/' + named(doc) + '.md')); general.forEach(doc => document(doc, 'worktool/general')); }
  put('worktool/README.md', index.join('\n') + '\n');
  return files;
}
class KnowledgeRepository {
  constructor(getStore, userData) { this.getStore = getStore; this.root = path.join(userData, 'knowledge-repositories'); this.busy = false; this.lastError = ''; }
  location(state = this.getStore().load()) {
    const repo = knowledgeURL(state.knowledge?.repo);
    return { repo, directory: repo ? path.join(this.root, hash(repo).slice(0, 24)) : '' };
  }
  status(state = this.getStore().load()) {
    const { repo, directory } = this.location(state);
    return { repo, directory, connected: !!directory && fs.existsSync(path.join(directory, '.git')), busy: this.busy, error: this.lastError, projectPaths: Object.fromEntries(state.projects.map(project => [project.id, projectFolder(project)])) };
  }
  async git(directory, args, allowFailure = false) {
    try { const result = await run(gitBinary, ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); return result.stdout.trim(); }
    catch (error) { if (allowFailure && Number.isInteger(error.code) && error.code !== 0) return null; throw Error('知识库 Git 操作失败，请检查仓库地址、网络及本机 Git 访问权限。'); }
  }
  async verify(directory, repo) {
    if (fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(path.join(directory, '.git')).isSymbolicLink()) throw Error('知识库仓库不允许符号链接');
    if (fs.realpathSync(await this.git(directory, ['rev-parse', '--show-toplevel'])) !== fs.realpathSync(directory)) throw Error('知识库需为独立 Git 仓库');
    for (const args of [['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']]) if (await this.git(directory, args) !== repo) throw Error('知识库远端地址已改变，请检查本地仓库');
  }
  lock(state) {
    fs.mkdirSync(this.root, { recursive: true });
    const file = this.location(state).directory + '.lock';
    let handle;
    try { handle = fs.openSync(file, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw Error('知识库正在被另一个实例处理，请稍后重试'); throw error; }
    return () => { fs.closeSync(handle); fs.unlinkSync(file); };
  }
  export(store, state) {
    const { directory } = this.location(state), previous = readManifest(directory), next = snapshot(store, state);
    // A clone may already contain another workspace's exported documents. Only
    // overwrite/delete versions that this workspace has previously written.
    const checkpointFile = directory + '-' + hash(fs.realpathSync(store.dir)).slice(0, 16) + '.checkpoint.json';
    const checkpoint = fs.existsSync(checkpointFile) ? JSON.parse(fs.readFileSync(checkpointFile, 'utf8')) : { files: {} };
    if (!checkpoint.files || typeof checkpoint.files !== 'object' || Array.isArray(checkpoint.files)) throw Error('知识库本地同步记录无效');
    // Verify all targets before changing any file. Never overwrite an external edit.
    for (const name of new Set([...Object.keys(previous.files), ...Object.keys(checkpoint.files), ...next.keys()])) {
      const target = safePath(directory, name), bytes = fs.existsSync(target) ? fs.readFileSync(target) : null;
      const current = bytes && hash(bytes), desired = next.has(name) ? hash(next.get(name)) : null;
      if (current !== null && current !== checkpoint.files[name] && current !== desired) throw Error('知识库文件被外部修改或属于其他工作区，请先核对：' + name);
      if (current === null && checkpoint.files[name] && desired !== null) throw Error('知识库文件被外部删除，请先核对：' + name);
    }
    for (const [name, bytes] of next) { const target = safePath(directory, name); if (!fs.existsSync(target) || hash(fs.readFileSync(target)) !== hash(bytes)) atomicWrite(target, bytes); }
    for (const name of Object.keys(previous.files)) if (!next.has(name)) fs.rmSync(safePath(directory, name), { force: true });
    const manifest = Buffer.from(JSON.stringify({ version: 1, files: Object.fromEntries([...next].map(([name, bytes]) => [name, hash(bytes)])) }, null, 2));
    const target = safePath(directory, MANIFEST);
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(manifest)) atomicWrite(target, manifest);
    if (!fs.existsSync(checkpointFile) || !fs.readFileSync(checkpointFile).equals(manifest)) atomicWrite(checkpointFile, manifest);
  }
  async refresh(state = this.getStore().load()) {
    if (this.busy) return { ...this.status(state), pending: true };
    const store = this.getStore(), status = this.status(state);
    this.lastError = '';
    if (status.connected) {
      this.busy = true;
      let unlock;
      try { unlock = this.lock(state); await this.verify(status.directory, status.repo); if (store !== this.getStore() || store.load().__baseHash !== state.__baseHash) throw Error('资料已更新，知识库将在下次保存或连接时更新'); this.export(store, state); }
      catch (error) { this.lastError = error.message; }
      finally { unlock?.(); this.busy = false; }
    }
    return this.status(state);
  }
  async connect() {
    if (this.busy) throw Error('知识库正在处理，请稍后');
    const store = this.getStore(), state = store.load(), { repo, directory } = this.location(state);
    if (!repo) throw Error('请先填写共享知识库 Git 仓库地址');
    this.busy = true; this.lastError = '';
    let unlock;
    try {
      unlock = this.lock(state);
      fs.mkdirSync(this.root, { recursive: true });
      if (!fs.existsSync(directory)) {
        const temporary = directory + '-' + crypto.randomUUID();
        try { await this.git(this.root, ['clone', '--no-recurse-submodules', '--', repo, temporary]); fs.renameSync(temporary, directory); }
        finally { fs.rmSync(temporary, { recursive: true, force: true }); }
      }
      await this.verify(directory, repo);
      if (store !== this.getStore() || store.load().__baseHash !== state.__baseHash) throw Error('工作区或资料已更新，请重新连接知识库');
      this.export(store, state);
      return { output: '知识库已连接，项目文档和附件已写入本地仓库。点击「提交并同步」上传到远端。', ...this.status(state) };
    } catch (error) { this.lastError = error.message; throw error; }
    finally { unlock?.(); this.busy = false; }
  }
  async sync() {
    if (this.busy) throw Error('知识库正在处理，请稍后');
    const store = this.getStore(), state = store.load(), { repo, directory } = this.location(state);
    if (!this.status(state).connected) throw Error('请先连接知识库');
    this.busy = true; this.lastError = '';
    let unlock;
    try {
      unlock = this.lock(state);
      await this.verify(directory, repo);
      const previous = readManifest(directory);
      this.export(store, state);
      const owned = new Set([MANIFEST, ...Object.keys(previous.files), ...Object.keys(readManifest(directory).files)]);
      // Refuse unrelated edits/staging instead of committing them with project data.
      const changes = await this.git(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      const dirty = changes ? changes.split('\0').filter(Boolean) : [];
      // git() trims leading spaces, so ask Git for the actual changed paths separately.
      const paths = new Set();
      for (const args of [['diff', '--name-only', '-z'], ['diff', '--cached', '--name-only', '-z'], ['ls-files', '--others', '--exclude-standard', '-z']]) {
        const value = await this.git(directory, args); for (const file of value.split('\0').filter(Boolean)) paths.add(file);
      }
      if ([...paths].some(file => !owned.has(file))) throw Error('知识库有其他文件改动，请先在 Git 工具中处理后再同步');
      const branch = await this.git(directory, ['symbolic-ref', '--short', 'HEAD']);
      await this.git(directory, ['check-ref-format', 'refs/heads/' + branch]);
      if (dirty.length) {
        for (const file of paths) await this.git(directory, ['add', '-A', '--', file]);
        if (await this.git(directory, ['diff', '--cached', '--quiet'], true) === null) await this.git(directory, ['-c', 'user.name=WorkTool', '-c', 'user.email=worktool@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Update project knowledge']);
      }
      await this.git(directory, ['fetch', '--no-tags', '--no-recurse-submodules', 'origin']);
      const incoming = await this.git(directory, ['rev-parse', '--verify', 'refs/remotes/origin/' + branch], true);
      if (incoming) {
        const [ahead, behind] = (await this.git(directory, ['rev-list', '--left-right', '--count', 'HEAD...' + incoming])).split(/\s+/).map(Number);
        if (ahead && behind) throw Error('知识库本地与远端已分叉，请在 Git 工具中合并后重试；不会强制覆盖');
        if (behind) {
          if (await this.git(directory, ['diff', '--name-only', 'HEAD', incoming, '--', 'worktool'])) throw Error('远端知识库资料有更新，请先在 Git 工具中核对合并，再同步；不会覆盖远端文档');
          await this.git(directory, ['merge', '--ff-only', incoming]);
        }
      }
      if (store !== this.getStore() || store.load().__baseHash !== state.__baseHash) throw Error('资料在同步期间发生变化，请再次同步最新资料');
      await this.verify(directory, repo);
      // Remote changes to generated files must be reviewed before publishing again.
      this.export(store, state);
      if (await this.git(directory, ['status', '--porcelain'])) throw Error('远端资料与本地不同，请核对知识库后再次同步');
      await this.git(directory, ['-c', 'push.followTags=false', '-c', 'push.gpgSign=false', 'push', '--no-follow-tags', '--no-force', '--no-recurse-submodules', repo, 'HEAD:refs/heads/' + branch]);
      return { output: '知识库同步成功：项目文档和附件已提交并推送。', ...this.status(state) };
    } catch (error) { this.lastError = error.message; throw error; }
    finally { unlock?.(); this.busy = false; }
  }
}
module.exports = { KnowledgeRepository, snapshot, projectFolder, knowledgeURL };
