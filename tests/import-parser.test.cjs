'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseText, findSecrets } = require('../import-parser.cjs');

test('Markdown product rows map aliases, custom fields and missing values without guessing', () => {
  const { records, warnings } = parseText(`| 所属项目 | 应用名 | 包名 | Git 分支 | flavor | 跳板机 VPS IP 地址 | 域名 |\n| --- | --- | --- | --- | --- | --- | --- |\n| 工具 | WiFi Joy | com.example.wifi | release/wifi | wifi | 203.0.113.10 | https://example.com |\n| 工具 | Charge Cash | | main | cash | | |`);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {projectName:'工具',name:'WiFi Joy',applicationId:'com.example.wifi',branch:'release/wifi',flavor:'wifi',vpsIp:'203.0.113.10',repo:'',notes:'',fields:[{title:'域名',content:'https://example.com'}]});
  assert.equal(records[1].applicationId, '');
  assert.equal(records[1].vpsIp, '');
  assert.ok(warnings.some(w => w.includes('包名')));
});

test('DingTalk vertical config table preserves explanation and unknown config', () => {
  const { records } = parseText(`| AppName | 说明 | 配置内容 |\n| :--- | :---: | ---: |\n| AppName | 显示名称 | Lucky WIFI |\n| 包名 | | com.example.lucky |\n| Adjust App Token | SDK 参数 | public-app-token |\n| Firebase 配置 | 客户端 | 文件另附 |`);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'Lucky WIFI');
  assert.equal(records[0].applicationId, 'com.example.lucky');
  assert.deepEqual(records[0].fields.slice(0,3), [{title:'AppName · 说明',content:'显示名称'}, {title:'Adjust App Token',content:'public-app-token'}, {title:'Adjust App Token · 说明',content:'SDK 参数'}]);
});

test('vertical key/value and headerless tables parse, but unrelated tables do not invent records', () => {
  assert.equal(parseText('| 配置项 | 配置值 |\n| --- | --- |\n| 应用名称 | 示例 |\n| applicationId | com.example.app |').records[0].name, '示例');
  assert.equal(parseText('| AppName | Example |\n| 包名 | com.example.app |').records[0].applicationId, 'com.example.app');
  assert.deepEqual(parseText('| 日期 | 天气 |\n| --- | --- |\n| 今天 | 晴 |').records, []);
});

test('key:value blocks support headings, formatting, blanks and repeated product identities', () => {
  const { records } = parseText('# 资料\n项目：工具\n**应用名**：示例\n\n- 包名: `com.example.one`\nbranch: release/one\n域名: https://example.com\n\n应用名：示例\n包名：com.example.one\nflavor: two');
  assert.equal(records.length, 2);
  assert.equal(records[0].applicationId, 'com.example.one');
  assert.equal(records[0].projectName, '工具');
  assert.equal(records[1].projectName, '');
  assert.equal(records[1].flavor, 'two');
  assert.equal(records[0].fields[0].content, 'https://example.com');
});

test('TSV and CSV preserve quoted commas, embedded newlines and quotes', () => {
  const tsv=parseText('应用名\t包名\t分支\nExample\tcom.example.tsv\tmain');
  assert.equal(tsv.records[0].applicationId, 'com.example.tsv');
  const csv=parseText('appName,applicationId,notes\n"Hello, App",com.example.csv,"first\nsecond ""quote"""');
  assert.equal(csv.records[0].name, 'Hello, App');
  assert.equal(csv.records[0].notes, 'first\nsecond "quote"');
  assert.throws(() => parseText('appName,applicationId\n"unclosed,com.example'), /引号未闭合/);
});

test('escaped pipes and inert markup remain plain text', () => {
  const { records } = parseText('| AppName | 包名 | 备注 |\n| --- | --- | --- |\n| A\\|B | com.example.escape | <script>alert(1)</script> |');
  assert.equal(records[0].name, 'A|B');
  assert.equal(records[0].notes, '<script>alert(1)</script>');
  assert.deepEqual(parseText('https://example.com\n一段普通说明。').records, []);
});

test('duplicate rows remain separate and conflicting non-identity fields are preserved', () => {
  const { records } = parseText('应用名: A\n包名: com.example.a\n分支: main\n分支: release\n应用名: B\n包名: com.example.a');
  assert.equal(records.length, 2);
  assert.equal(records[0].branch, 'main');
  assert.deepEqual(records[0].fields, [{title:'分支',content:'release'}]);
});

test('unsupported or empty content returns no invented product, malformed rows are warned', () => {
  assert.deepEqual(parseText(''), {records:[],warnings:['未识别到项目或产品字段，可保留为文档，或手动补充预览内容。']});
  const result=parseText('AppName,包名,分支\nExample,com.example.a');
  assert.equal(result.records[0].branch, '');
  assert.ok(result.warnings.some(w=>w.includes('不完整')));
});

test('limits are byte-based and 100 records are accepted without silent truncation', () => {
  assert.throws(() => parseText('中'.repeat(400000)), /1 MB/);
  assert.throws(() => parseText(null), /文本/);
  const table = count => 'AppName,包名\n' + Array.from({length:count},(_,i)=>`App${i},com.example.a${i}`).join('\n');
  assert.equal(parseText(table(100)).records.length, 100);
  assert.throws(() => parseText(table(101)), /100 条/);
});

test('findSecrets returns risk labels only for secret content in text, JSON and tables', () => {
  assert.deepEqual(findSecrets('password: never-return-this'), ['密码']);
  assert.ok(findSecrets('{"private_key":"never-return-private", "client_secret":"never-return-secret"}').includes('私钥'));
  assert.ok(findSecrets('-----BEGIN PRIVATE KEY-----\nmaterial\n-----END PRIVATE KEY-----').includes('私钥'));
  assert.ok(findSecrets('| 字段 | 配置内容 |\n| --- | --- |\n| access_token | never-return-token |').includes('认证令牌'));
  assert.ok(findSecrets('AppName,password\nA,\nB,hidden').includes('密码'));
  assert.ok(findSecrets('Authorization: Bearer abcdefghijklmnop').includes('认证令牌'));
  assert.equal(JSON.stringify(findSecrets('password: never-return-this')).includes('never-return-this'), false);
});

test('public client identifiers and empty secret fields are not classified as secrets', () => {
  const text = 'AppName: Example\napplicationId: com.example.app\nFirebase api_key: public-client-key\nAdjust App Token: public-app-token\n{"api_key":"public-client-key", "appId":"1:123:android:abc"}\npassword:';
  assert.deepEqual(findSecrets(text), []);
});

test('Vision Applicationld label maps only in OCR mode, never repairs identifier values', () => {
  const text = 'AppName: Screenshot Demo\nApplicationld: com.example.ocr\nBranch: release/ocr\nFlavor: demo';
  assert.equal(parseText(text).records[0].applicationId, '');
  const result = parseText(text, { ocr: true });
  assert.equal(result.records[0].applicationId, 'com.example.ocr');
  assert.ok(result.warnings.some(w => w.includes('Applicationld')));
  assert.equal(parseText('AppName\tApplicationld\nDemo\tcom.examp1e.ocr', { ocr: true }).records[0].applicationId, 'com.examp1e.ocr');
  assert.equal(parseText('AppName:\tDemo\nApplicationld:\tcom.example.ocr', { ocr: true }).records[0].applicationId, 'com.example.ocr');
});

test('a horizontal header without data must not become a product', () => {
  assert.deepEqual(parseText('AppName,ApplicationId').records, []);
  assert.deepEqual(parseText('| 应用名 | 包名 | 分支 |\n| --- | --- | --- |').records, []);
});


test('VPS aliases map IPv4 and IPv6 without guessing from unrelated hosts or legacy accounts', () => {
  for (const label of ['跳板机 VPS IP 地址', '跳板机IP', 'VPS IP', 'vpsIp', 'jumpHostIp']) {
    assert.equal(parseText(`应用名：A\n包名：com.example.a\n${label}：2001:db8::10`).records[0].vpsIp, '2001:db8::10');
  }
  const result=parseText('应用名：A\n包名：com.example.a\nGP 账号：legacy\nAPI服务器：203.0.113.55');
  assert.equal(result.records[0].vpsIp, '');
  assert.ok(result.records[0].fields.some(f=>f.title==='GP 账号' && f.content==='legacy'));
});
