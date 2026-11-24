'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
function fixture() {
  const events = {}, timers = new Map(), paints = [], calls = [];
  const panel = { set outerHTML(html) { paints.push(html); } };
  let id = 0;
  const context = vm.createContext({ state: { packages: [{ id: 'a', vpsIp: '203.0.113.10' }, { id: 'b', vpsIp: '203.0.113.11' }] }, page: 'packages', selected: 'a', e: s => String(s ?? '').replace(/</g, '&lt;'), button: (label, action, attrs) => `<button ${attrs}>${label}</button>`,
    api: { bastionStatus: async packageId => { calls.push(packageId); return { status: 'STOPPED', label: '已关机', canStart: true, checkedAt: Date.now() }; } },
    document: { hidden: false, hasFocus: () => true, querySelector: () => panel, addEventListener: (name, fn) => events[name] = fn }, window: { addEventListener: (name, fn) => events[name] = fn },
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id), Date });
  const run = code => vm.runInContext(code, context);
  run(fs.readFileSync(require.resolve('../renderer/bastion.js'), 'utf8'));
  return { context, run, events, timers, paints, calls };
}
test('Late status cannot paint a different app or a reset workspace', async () => {
  for (const change of ["selected='b'", 'resetBastionView()']) {
    const f = fixture(); let resolve; f.context.api.bastionStatus = () => new Promise(r => resolve = r);
    const work = f.run('queryBastion()'); const count = f.paints.length; f.run(change);
    resolve({ status: 'RUNNING', label: 'old result', checkedAt: Date.now() }); await work;
    assert.equal(f.paints.length, count); assert.equal(f.timers.size, 0);
  }
});
test('Each detail entry queries once; rerenders, elapsed time and focus do not query again', async () => {
  const f = fixture(), tick = () => new Promise(resolve => setImmediate(resolve));
  f.run('refreshBastionView()'); await tick(); assert.deepEqual(f.calls, ['a']);
  f.run("bastionViews.get(bastionKey(state.packages[0])).result.checkedAt=1;refreshBastionView()"); await tick();
  f.events.focus?.(); f.events.visibilitychange?.(); await tick();
  assert.deepEqual(f.calls, ['a']); assert.equal(f.timers.size, 0);
  f.run("page='projects';selected=null;refreshBastionView();page='packages';selected='a';refreshBastionView()"); await tick();
  assert.deepEqual(f.calls, ['a', 'a']);
  await f.run('queryBastion()'); assert.deepEqual(f.calls, ['a', 'a', 'a']);
  f.run("state.packages[0].vpsIp='203.0.113.12';refreshBastionView()"); await tick();
  assert.deepEqual(f.calls, ['a', 'a', 'a', 'a']); assert.equal(f.timers.size, 0);
  assert(f.paints.every(html => html.startsWith('<div id="bastion-panel"')));
});
