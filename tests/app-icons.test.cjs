'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Store } = require('../core.cjs');
const { AppIcons } = require('../app-icons.cjs');
const { snapshot } = require('../knowledge-repository.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktool-icons-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let current = new Store(path.join(root, 'workspace'));
  const file = path.join(root, 'icon.png'); fs.writeFileSync(file, png);
  // Native image decoding and resizing are exercised with real Electron in the desktop suite.
  const image = { isEmpty: () => false, getSize: () => ({ width: 128, height: 128 }), resize: () => image, toPNG: () => png };
  const icons = new AppIcons(() => current, { createFromBuffer: () => image });
  return { root, file, icons, store: current, switchStore() { current = new Store(path.join(root, 'other')); return current; } };
}
test('Icon preview and cancel do not write files; save stores one portable reference and strips previews', t => {
  const { icons, store, file } = fixture(t), before = fs.readFileSync(store.file);
  const canceled = icons.stage(file); icons.discard(canceled.token);
  assert.deepEqual(fs.readFileSync(store.file), before); assert(!fs.existsSync(path.join(store.dir, 'attachments')));
  assert.throws(() => icons.save(store.load(), [{ packageId: 'demo-app', token: canceled.token }]), /失效/);
  const draft = icons.stage(file), state = store.load(); state.__icons = { 'demo-app': 'runtime-only' };
  const saved = icons.save(state, [{ packageId: 'demo-app', token: draft.token }]);
  assert(saved.packages[0].icon.path.startsWith('attachments/'));
  assert.deepEqual(fs.readFileSync(store.resolveFile(saved.packages[0].icon.path)), png);
  assert(!fs.readFileSync(store.file, 'utf8').includes('__icons'));
  assert(icons.previews(saved)['demo-app'].startsWith('data:image/png;base64,'));
  assert.deepEqual(new Store(store.dir).load().packages[0].icon, saved.packages[0].icon);
});
test('Replacing and removing icons preserve previous attachments and export the selected icon', t => {
  const { icons, store, file } = fixture(t);
  function saveIcon() { const draft = icons.stage(file); return icons.save(store.load(), [{ packageId: 'demo-app', token: draft.token }]); }
  const first = saveIcon().packages[0].icon, second = saveIcon();
  assert.notEqual(second.packages[0].icon.path, first.path); assert(fs.existsSync(store.resolveFile(first.path)));
  const exported = snapshot(store, second), appDoc = [...exported.entries()].find(([name]) => name.includes('/applications/'));
  assert.match(appDoc[1].toString(), /!\[应用 Icon\]\(\.\.\/attachments\/.+-icon\.png\)/);
  assert([...exported.entries()].some(([name, bytes]) => name.endsWith('-icon.png') && bytes.equals(png)));
  second.packages[0].icon = null; const removed = icons.save(second);
  assert.equal(removed.packages[0].icon, null); assert(fs.existsSync(store.resolveFile(first.path)));
});
test('Invalid paths, switched workspaces, concurrent edits and failed saves cannot leak or misassign icons', t => {
  const { icons, store, file, switchStore } = fixture(t);
  for (const icon of [{ path: '../outside.png', name: 'bad' }, { path: 'https://example.com/x.png', name: 'bad' }, { path: 'attachments/abc.png', name: 'bad', dataUrl: 'forged' }]) {
    const state = store.load(); state.packages[0].icon = icon; assert.throws(() => icons.save(state), /Icon 格式/);
  }
  const draft = icons.stage(file), stale = store.load(), current = store.load(); current.projects[0].name = 'Changed'; store.save(current);
  assert.throws(() => icons.save(stale, [{ packageId: 'demo-app', token: draft.token }]), /数据已更新/);
  assert(!fs.existsSync(path.join(store.dir, 'attachments')));
  const originalSave = store.save; store.save = () => { throw Error('disk failure'); };
  assert.throws(() => icons.save(store.load(), [{ packageId: 'demo-app', token: draft.token }]), /disk failure/);
  assert.deepEqual(fs.readdirSync(path.join(store.dir, 'attachments')), []); store.save = originalSave;
  const other = switchStore(); assert.throws(() => icons.save(other.load(), [{ packageId: 'demo-app', token: draft.token }]), /失效/);
});
test('Missing image files use a fallback without blocking workspace loading', t => {
  const { icons, store } = fixture(t); const state = store.load(); state.packages[0].icon = { path: 'attachments/00000000-0000-0000-0000-000000000000.png', name: 'missing.png' };
  store.save(state); assert.deepEqual(icons.previews(store.load()), {});
});
