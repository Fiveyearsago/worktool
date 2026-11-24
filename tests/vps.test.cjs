'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Store, cleanVpsIp } = require('../core.cjs');

test('Optional VPS address accepts IPv4/IPv6 and rejects hostnames, URLs and ports', () => {
  for (const value of ['', '203.0.113.22', '2001:db8::22']) assert.equal(cleanVpsIp(' '+value+' '), value);
  assert.equal(cleanVpsIp(), '');
  for (const value of [null, 123, {}, 'example.com', 'https://203.0.113.22', '203.0.113.22:3389', '[2001:db8::22]:3389', '300.1.2.3']) {
    assert.throws(() => cleanVpsIp(value), /跳板机 VPS IP 地址/);
  }
});

test('Legacy account records survive adding and clearing VPS IP, invalid save preserves disk', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-vps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir), state = store.load();
  delete state.packages[0].vpsIp;
  state.accounts.push({ id: 'legacy', name: 'Historical account', email: 'legacy@example.com' });
  state.packages[0].gpAccountId = 'legacy';
  store.save(state);
  assert.equal(store.load().packages[0].vpsIp, undefined);
  for (const value of ['203.0.113.22', '2001:db8::22', '']) {
    state.packages[0].vpsIp = value;
    store.save(state);
    const actual = new Store(dir).load();
    assert.equal(actual.packages[0].vpsIp, value);
    assert.equal(actual.packages[0].gpAccountId, 'legacy');
    assert.deepEqual(actual.accounts, state.accounts);
  }
  const before = fs.readFileSync(store.file);
  state.packages[0].vpsIp = 'invalid';
  assert.throws(() => store.save(state), /跳板机 VPS IP 地址/);
  assert.deepEqual(fs.readFileSync(store.file), before);
});
