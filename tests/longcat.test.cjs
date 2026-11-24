'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { AISettings } = require('../ai-settings.cjs');
const { LongCatClient, parseResult, ENDPOINT } = require('../longcat-client.cjs');
const { Store } = require('../core.cjs');
const { ImportService } = require('../import-service.cjs');
const row = () => ({ projectName: '测试项目', name: '测试应用', applicationId: 'com.example.ai', branch: 'Main', flavor: '', vpsIp: '203.0.113.20', repo: '', notes: '', fields: [{ title: '域名', content: 'https://example.com' }] });
const extracted = () => ({ text: 'AppName: 测试应用\nApplicationId: com.example.ai', records: [row()], warnings: [] });
const credentials = { credentials: async () => ({ apiKey: 'synthetic-key', model: 'LongCat-2.5' }) };
const response = (data = extracted(), finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: JSON.stringify(data) } }] }));
function fixture(aiClient) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktool-ai-'));
  const store = new Store(path.join(root, 'workspace'));
  return { root, store, service: new ImportService(() => store, { aiClient, platform: 'win32', prepareImages: () => ({ images: ['data:image/png;base64,c3ludGhldGlj'], warnings: [] }) }) };
}
test('Settings save an owner-only local key, expose only status and preserve/replace/remove it', async () => {
  const { root, store } = fixture(); const file = path.join(root, 'user-data', 'ai-settings.json');
  const settings = new AISettings(file);
  assert.equal(settings.status().hasKey, false);
  const status = settings.save({ model: 'LongCat-2.5', apiKey: 'synthetic-key-private' });
  assert.equal(status.hasKey, true); assert.equal(JSON.stringify(status).includes('private'), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).apiKey, 'synthetic-key-private');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal((await new AISettings(file).credentials()).apiKey, 'synthetic-key-private');
  settings.save({ model: 'LongCat-2.5', apiKey: '' }); assert.equal((await settings.credentials()).apiKey, 'synthetic-key-private');
  settings.save({ model: 'LongCat-2.5', apiKey: 'replacement' }); assert.equal((await settings.credentials()).apiKey, 'replacement');
  assert.equal(fs.readdirSync(store.dir).includes('ai-settings.json'), false);
  settings.save({ model: 'LongCat-2.5', removeKey: true }); await assert.rejects(settings.credentials(), /请先/);
});
test('Legacy encrypted settings require reentry and never access a keychain', async () => {
  const { root } = fixture(); const file = path.join(root, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ model: 'LongCat-2.5', encryptedKey: 'old-encrypted-test-value' }));
  const settings = new AISettings(file);
  assert.equal(settings.status().hasKey, false); assert.equal(settings.status().needsKeyReentry, true);
  await assert.rejects(settings.credentials(), /重新填写/);
  settings.save({ model: 'LongCat-2.5', apiKey: 'replacement' });
  assert.equal(settings.status().needsKeyReentry, false);
  assert.equal((await settings.credentials()).apiKey, 'replacement');
  assert.equal(fs.readFileSync(file, 'utf8').includes('encryptedKey'), false);
  assert.throws(() => settings.save({ model: 'LongCat-2.5', apiKey: 'invalid\nkey' }), /格式/);
  assert.equal((await settings.credentials()).apiKey, 'replacement');
});
test('LongCat uses official endpoint, disabled thinking, one request and bounded JSON output', async () => {
  let count = 0;
  const client = new LongCatClient(credentials, { fetchImpl: async (url, opts) => {
    count++; assert.equal(url, ENDPOINT); assert.equal(opts.redirect, 'error'); assert.equal(opts.headers.Authorization, 'Bearer synthetic-key');
    const body = JSON.parse(opts.body); assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.model, 'LongCat-2.5'); assert.equal(body.stream, false);
    assert.equal(body.messages[1].content, '资料'); return response();
  } });
  const result = await client.extract({ text: '资料' }); assert.equal(result.records[0].branch, 'Main'); assert.equal(count, 1);
});
test('Image content is sent as image_url blocks without local OCR', async () => {
  let body;
  const client = new LongCatClient(credentials, { fetchImpl: async (_, opts) => { body = JSON.parse(opts.body); return response(); } });
  await client.extract({ images: ['data:image/png;base64,YQ=='] });
  assert.equal(body.messages[1].content[1].image_url.url, 'data:image/png;base64,YQ==');
});
test('Schema rejects wrong types, excessive candidates and malformed JSON, preserves exact IDs', () => {
  assert.equal(parseResult('```json\n' + JSON.stringify(extracted()) + '\n```').records[0].applicationId, 'com.example.ai');
  assert.throws(() => parseResult('hello'), /JSON/);
  for (const mutate of [x => { x.records = {}; }, x => { x.records = Array.from({ length: 101 }, row); }, x => { x.records[0].applicationId = 42; }, x => { x.records[0].fields = null; }]) {
    const x = extracted(); mutate(x); assert.throws(() => parseResult(JSON.stringify(x)), /格式|结构|过多/);
  }
});
test('HTTP failures are actionable without exposing response credentials or retrying', async () => {
  for (const [status, pattern] of [[401, /Key 无效/], [402, /余额/], [429, /频繁/], [503, /暂时不可用/]]) {
    let calls = 0;
    const client = new LongCatClient(credentials, { fetchImpl: async () => { calls++; return new Response('synthetic-secret-do-not-display', { status }); } });
    await assert.rejects(client.extract({ text: 'text' }), error => { assert.match(error.message, pattern); assert.doesNotMatch(error.message, /synthetic-secret/); return true; });
    assert.equal(calls, 1);
  }
});
test('Truncated, empty and oversized responses cannot become import candidates', async () => {
  for (const fetchImpl of [async () => response(extracted(), 'length'), async () => new Response('{}'), async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
    await assert.rejects(new LongCatClient(credentials, { fetchImpl }).extract({ text: 'test' }), /LongCat/);
  }
});
test('Network errors redact transport details; cancellation and timeout stop waiting', async () => {
  await assert.rejects(new LongCatClient(credentials, { fetchImpl: async () => { throw Error('synthetic-key'); } }).test(), error => !error.message.includes('synthetic-key'));
  const fetchImpl = (_, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
  const controller = new AbortController();
  const pending = new LongCatClient(credentials, { fetchImpl }).extract({ text: 'test', signal: controller.signal });
  setTimeout(() => controller.abort(), 5); await assert.rejects(pending, /取消/);
  // Keep the event loop alive because AbortSignal.timeout uses an unref'ed timer.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(new LongCatClient(credentials, { fetchImpl, timeoutMs: 5 }).test(), /超时/); }
  finally { clearTimeout(keepAlive); }
});
test('AI text import preserves original text and manual fields; save makes no second AI request', async () => {
  let calls = 0;
  const { store, service } = fixture({ extract: async () => { calls++; return extracted(); } });
  const text = '# 完整原文\n说明保留不变';
  const p = await service.fromText(text, { mode: 'longcat' });
  assert.equal(p.text, text); assert.equal(p.records[0].applicationId, 'com.example.ai'); assert.equal(store.load().revision, 0);
  service.updateText(p.token, text + '\n人工备注');
  p.records[0].name = '人工修正';
  const saved = service.commit(p.token, { title: 'AI', projectId: 'demo', records: p.records.map(x => ({ ...x, selected: true })) });
  assert.equal(saved.state.docs.at(-1).content, text + '\n人工备注'); assert.equal(saved.state.packages.at(-1).name, '人工修正'); assert.equal(calls, 1);
});
test('AI screenshot bypasses platform OCR and retains original attachment bytes', async () => {
  const { root, store, service } = fixture({ extract: async () => extracted() });
  const file = path.join(root, 'synthetic.png'), bytes = Buffer.from('synthetic-image'); fs.writeFileSync(file, bytes);
  const p = await service.fromFile(file, { mode: 'longcat' }); assert.equal(p.text, extracted().text);
  const saved = service.commit(p.token, { title: '截图', projectId: 'demo', records: [] });
  assert.deepEqual(fs.readFileSync(store.resolveFile(saved.state.docs.at(-1).files[0].path)), bytes);
});
test('Sensitive or oversized text is blocked before contacting LongCat', async () => {
  let calls = 0;
  const { service } = fixture({ extract: async () => { calls++; return extracted(); } });
  await assert.rejects(service.fromText('password: secret', { mode: 'longcat' }), /敏感/);
  await assert.rejects(service.fromText('a'.repeat(1024 * 1024 + 1), { mode: 'longcat' }), /1 MB/);
  assert.equal(calls, 0);
});
test('Workspace changes and stale asynchronous responses never create previews', async () => {
  for (const switchStore of [false, true]) {
    let release; const { store } = fixture(); let active = store;
    const service = new ImportService(() => active, { aiClient: { extract: () => new Promise(resolve => { release = resolve; }) } });
    const pending = service.fromText('待提取资料', { mode: 'longcat' });
    if (switchStore) active = fixture().store; else store.save(store.load());
    release(extracted()); await assert.rejects(pending, /工作区已切换或更新/); assert.equal(service.sessions.size, 0);
  }
});
test('Failed or cancelled AI reparse retains last accepted text and cannot revive discarded previews', async () => {
  const { service } = fixture({ extract: async () => extracted() });
  const p = await service.fromText('原始资料', { mode: 'longcat' });
  service.aiClient.extract = async () => { throw Error('test failure'); };
  await assert.rejects(service.reparseAI(p.token, '新资料')); assert.equal(service.session(p.token).text, '原始资料');
  let release; service.aiClient.extract = () => new Promise(resolve => { release = resolve; });
  const pending = service.reparseAI(p.token, '新资料'); service.discard(p.token); release(extracted());
  await assert.rejects(pending, /过期/); assert.equal(service.sessions.size, 0);
});

test('Project-only images create full project metadata without inventing application records', async () => {
  const data = parseResult(JSON.stringify({ text: '项目名称：截图项目\n项目说明：项目说明原文\n仓库地址：https://example.com/project.git', project: { name: '截图项目', description: '项目说明原文', repo: 'https://example.com/project.git' }, records: [], warnings: [] }));
  const { store, service } = fixture({ extract: async () => data });
  const before = store.load();
  const p = await service.fromImage(Buffer.from('synthetic-project-image'));
  assert.equal(p.project.name, '截图项目'); assert.equal(p.records.length, 0);
  const saved = service.commit(p.token, { title: p.project.name, projectName: p.project.name, projectDescription: p.project.description, projectRepo: p.project.repo, records: [] });
  const project = saved.state.projects.find(x => x.id === saved.projectId);
  assert.equal(project.name, '截图项目'); assert.equal(project.description, '项目说明原文'); assert.equal(project.repo, 'https://example.com/project.git');
  assert.equal(saved.state.packages.length, before.packages.length);
  assert.equal(saved.state.docs.at(-1).projectId, project.id);
  assert.deepEqual(fs.readFileSync(store.resolveFile(saved.state.docs.at(-1).files[0].path)), Buffer.from('synthetic-project-image'));
});
test('Invalid project metadata and empty clipboard are rejected; existing projects are not overwritten', async () => {
  assert.throws(() => parseResult(JSON.stringify({ ...extracted(), project: { name: 7, description: '', repo: '' } })), /格式/);
  let calls = 0;
  const { service, store } = fixture({ extract: async () => { calls++; return { ...extracted(), project: { name: '新名字', description: '新说明', repo: 'https://example.com' } }; } });
  await assert.rejects(service.fromImage(Buffer.alloc(0)), /没有图片/); assert.equal(calls, 0);
  const before = store.load().projects[0];
  const p = await service.fromImage(Buffer.from('synthetic'));
  const saved = service.commit(p.token, { title: '资料', projectId: before.id, projectName: '新名字', projectDescription: '新说明', projectRepo: 'https://example.com', records: [] });
  assert.deepEqual(saved.state.projects[0], before);
});


test('AI import retains explicit VPS IP and leaves absent IP blank instead of using legacy account',()=>{
 const data=extracted();data.records[0].vpsIp='2001:db8::20';
 assert.equal(parseResult(JSON.stringify(data)).records[0].vpsIp,'2001:db8::20');
 delete data.records[0].vpsIp;data.records[0].gpAccount='203.0.113.99';
 assert.equal(parseResult(JSON.stringify(data)).records[0].vpsIp,'');
});
