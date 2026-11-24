'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'), vm = require('node:vm');
const { BastionService, hostFromList, unwrap } = require('../bastion-service.cjs');
const { portalRequest } = require('../bastion-portal.cjs');
const ok = data => ({ status: 200, body: { code: 200, data } });
const host = overrides => ({ id: 23, version: 4, publicIp: '203.0.113.10', name: 'Synthetic host', status: 'STOPPED', ...overrides });
function setup() {
  let pkg = { id: 'p', vpsIp: '203.0.113.10' }, row = host();
  const store = { load: () => ({ packages: [pkg] }) }, calls = [];
  let active = store;
  const portal = { request: async (action, input) => { calls.push({ action, input }); return action === 'list' ? ok({ list: [row], total: 1 }) : ok({ operationStatus: 'SUCCESS', hostStatus: 'STARTING' }); }, open: async ip => calls.push({ action: 'open', ip }) };
  const service = new BastionService(() => active, portal);
  return { service, portal, calls, pkg, row, switchStore: () => { active = { load: store.load }; } };
}
test('Lookup maps platform state and requires one exact IP, complete page, id and version', () => {
  assert.equal(hostFromList({ list: [host({ publicIp: '203.0.113.100' }), host()], total: 2 }, '203.0.113.10').id, 23);
  for (const data of [{ list: [host(), host()], total: 2 }, { list: [host()], total: 101 }, { list: [], total: 0 }, { list: [host({ version: undefined })], total: 1 }]) assert.throws(() => hostFromList(data, '203.0.113.10'));
  assert.equal(hostFromList({ list: [host({ status: 'NEW_STATE' })], total: 1 }, '203.0.113.10').status, 'UNKNOWN');
});
test('HTTP/business authentication, permission and failures cannot appear as running', () => {
  for (const response of [{ status: 401 }, { status: 200, body: { code: 9999 } }, { status: 403 }, { status: 200, body: { code: 500, message: 'private detail' } }, { error: 'UNAVAILABLE' }]) assert.throws(() => unwrap(response), error => !error.message.includes('private detail'));
});
test('Queries and portal entrance never issue start requests or mutate workspace records', async () => {
  const { service, calls, pkg } = setup(), original = structuredClone(pkg);
  assert.equal((await service.status('p')).status, 'STOPPED');
  assert.equal((await service.status('p')).canStart, true);
  await service.open('p');
  assert.deepEqual(calls.map(c => c.action), ['list', 'list', 'open']); assert.deepEqual(pkg, original);
  assert.equal((await service.start('missing')).status, 'INVALID_TARGET');
});
test('Start refreshes id/version, posts once and waits for observed RUNNING', async () => {
  const { service, calls, row } = setup();
  await service.status('p'); row.version = 8;
  const result = await service.start('p');
  assert.equal(result.status, 'STARTING'); assert.equal(result.canStart, false);
  assert.deepEqual(calls.find(c => c.action === 'start').input, { id: 23, version: 8 });
  await service.start('p'); assert.equal(calls.filter(c => c.action === 'start').length, 1);
  row.status = 'RUNNING'; assert.equal((await service.status('p')).status, 'RUNNING');
  row.status = 'STOPPED'; assert.equal((await service.status('p')).canStart, true);
});
test('Concurrent clicks and aliases of the same IP cannot post twice', async () => {
  const { service, portal, calls } = setup(), original = portal.request;
  let finish; portal.request = async (action, input) => action === 'start' ? (calls.push({ action, input }), new Promise(resolve => { finish = resolve; })) : original(action, input);
  const first = service.start('p'); while (!finish) await new Promise(r => setImmediate(r));
  assert.equal((await service.start('p')).status, 'BUSY'); finish(ok({ operationStatus: 'SUCCESS' })); await first;
  assert.equal(calls.filter(c => c.action === 'start').length, 1);
});
test('Workspace/IP changes while resolving a host prevent a later start mutation', async () => {
  for (const change of ['workspace', 'ip']) {
    const x = setup(); let finish;
    x.portal.request = async action => { x.calls.push(action); return new Promise(resolve => { finish = resolve; }); };
    const result = x.service.start('p');
    change === 'workspace' ? x.switchStore() : x.pkg.vpsIp = '203.0.113.11';
    finish(ok({ list: [host()], total: 1 }));
    assert.equal((await result).status, 'TARGET_CHANGED'); assert.deepEqual(x.calls, ['list']);
  }
});
test('Already running, transitioning, unknown and deleted hosts never receive a start', async () => {
  for (const status of ['RUNNING', 'STARTING', 'STOPPING', 'UNKNOWN', 'NOT_FOUND', 'DELETED', 'ERROR']) {
    const x = setup(); x.row.status = status; const r = await x.service.start('p');
    assert.equal(r.canStart, false); assert(!x.calls.some(c => c.action === 'start'));
  }
});
test('Business operation failure is surfaced and ambiguous network outcome is not retried', async () => {
  for (const response of [ok({ operationStatus: 'FAILED' }), { error: 'UNAVAILABLE' }, ok({ operationStatus: 'UNRECOGNIZED' })]) {
    const x = setup(), original = x.portal.request;
    x.portal.request = async (action, input) => action === 'start' ? (x.calls.push({ action, input }), response) : original(action, input);
    const result = await x.service.start('p'); assert.notEqual(result.status, 'RUNNING');
    if (response.body?.data?.operationStatus === 'FAILED') assert.equal(result.status, 'START_FAILED');
    else { await x.service.start('p'); assert.equal(x.calls.filter(c => c.action === 'start').length, 1); }
  }
});
test('Invalid or missing IP never reaches the network', async () => {
  const x = setup();
  for (const ip of ['', 'example.com', '203.0.113.10:3389']) { x.pkg.vpsIp = ip; assert.equal((await x.service.status('p')).canStart, false); }
  assert.equal(x.calls.length, 0);
});
test('An old uncertain start cannot block a later day after a fresh stopped status', async () => {
  const x = setup(); let now = 1000; x.service.now = () => now;
  await x.service.start('p'); now += 660001;
  const result = await x.service.status('p'); assert.equal(result.status, 'STOPPED'); assert.equal(result.canStart, true);
  assert.equal(x.calls.filter(c => c.action === 'start').length, 1);
});
async function scriptRequest(operation, input, overrides = {}) {
  const calls = [], context = vm.createContext({ location: { origin: 'https://uc.ushareit.org' }, localStorage: { getItem: key => key === 'MATRIX_token' ? JSON.stringify('synthetic-auth') : null }, URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ code: 200, data: {} }), { status: 200 }); }, ...overrides });
  const result = await vm.runInContext(`(${portalRequest.toString()})(${JSON.stringify(operation)},${JSON.stringify(input)})`, context);
  return { result, calls };
}
test('Portal request uses verified same-origin API and keeps credentials out of results', async () => {
  const { result, calls } = await scriptRequest('list', { ip: '2001:db8::10' });
  const url = new URL(calls[0].url); assert.equal(url.origin, 'https://uc.ushareit.org'); assert.equal(url.pathname, '/system/bastion-host/list'); assert.equal(url.searchParams.get('publicIp'), '2001:db8::10');
  assert.equal(calls[0].options.headers.Authorization, 'synthetic-auth'); assert.equal(calls[0].options.redirect, 'error'); assert(!JSON.stringify(result).includes('synthetic-auth'));
  const started = await scriptRequest('start', { id: 23, version: 8 }); assert.equal(started.calls[0].options.method, 'POST'); assert.equal(started.calls[0].options.body, '{"id":23,"version":8}');
});
test('Missing session and wrong origin cause no requests; invalid responses are redacted', async () => {
  for (const overrides of [{ localStorage: { getItem: () => null } }, { location: { origin: 'https://example.com' } }]) {
    const r = await scriptRequest('list', { ip: '203.0.113.10' }, overrides); assert.equal(r.result.error, 'LOGIN_REQUIRED'); assert.equal(r.calls.length, 0);
  }
  const r = await scriptRequest('start', {}, { fetch: async () => { throw Error('sensitive transport message'); } }); assert.equal(r.result.error, 'UNAVAILABLE');
});
