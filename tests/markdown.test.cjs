'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const markdown = require('../renderer/markdown.js');
const { documentLinkTarget } = require('../document-links.cjs');

test('Markdown reading renders common document structures and read-only tasks', () => {
  const source = '# 标题\n\n## 检查\n\n**粗体**和*斜体*、~~删除~~、`code`\n\n> 引用\n\n1. 第一项\n   - 嵌套项\n\n- [x] 完成\n- [ ] 未完成\n\n| 项目 | 状态 |\n| --- | --- |\n| 示例 | 通过 |\n\n```js\nconst x = "<tag>";\n```\n\n---';
  const html = markdown.render(source);
  for (const pattern of [/<h1 id="md-标题">标题<\/h1>/, /<h2/, /<strong>粗体/, /<em>斜体/, /<s>删除/, /<code>code/, /<blockquote>/, /<ol>/, /<ul>/, /disabled checked/, /disabled aria-label="未完成"/, /<table>/, /<pre><code class="language-js">const x = &quot;&lt;tag&gt;&quot;/, /<hr>/]) assert.match(html, pattern);
  assert.equal(markdown.render('## 重复\n\n## 重复').match(/id="md-重复(?:-1)?"/g).length, 2);
});

test('Untrusted HTML, scripts and unsafe destinations stay inert; images do not load automatically', () => {
  const html = markdown.render('<script>window.bad=true</script>\n\n<img src=x onerror="bad()">\n\n[JS](javascript:alert(1)) [data](data:text/html,bad) [file](file:///tmp/bad) [creds](https://user:pass@example.com)\n\n![tracking](https://example.com/pixel.png)\n\n[spoof](https://example.com/\"data-action=\"delete-doc)');
  assert.doesNotMatch(html, /<(?:script|img|iframe|object)\b/i);
  assert.doesNotMatch(html, /href="(?:javascript|data|file):/i);
  assert.doesNotMatch(html, /data-action="delete-doc"/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /图片：tracking/);
  assert(!markdown.links('[secret](https://user:pass@example.com)').length);
});

test('Only links in the current saved document can open; local links reveal existing files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktool-md-links-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '报告.json'); fs.writeFileSync(file, '{}');
  let content = `[资料](<${file}>)\n\n[关联附件](report.json)\n\n[网页](https://example.com/docs)\n\n[本地服务](http://localhost:8080/)\n\n[标题](#标题)`;
  const store = { load: () => ({ docs: [{ id: 'doc', content, files: [{ name: 'report.json', path: 'attachments/report.json' }] }] }), resolveFile: p => { assert.equal(p, 'attachments/report.json'); return file; } };
  assert.deepEqual(documentLinkTarget(store, 'doc', markdown.links(content)[0]), { kind: 'local', target: fs.realpathSync(file) });
  assert.equal(documentLinkTarget(store, 'doc', 'report.json').target, fs.realpathSync(file));
  assert.deepEqual(documentLinkTarget(store, 'doc', 'https://example.com/docs'), { kind: 'web', target: 'https://example.com/docs' });
  assert.equal(documentLinkTarget(store, 'doc', 'http://localhost:8080/').kind, 'web');
  assert.throws(() => documentLinkTarget(store, 'doc', encodeURI('#标题')), /文档外/);
  assert.throws(() => documentLinkTarget(store, 'missing', 'https://example.com/docs'), /不存在/);
  assert.throws(() => documentLinkTarget(store, 'doc', 'https://other.example.com'), /不存在/);
  content = '[失效文件](missing.txt)';
  assert.throws(() => documentLinkTarget(store, 'doc', 'missing.txt'), /未找到关联文件/);
  assert.throws(() => documentLinkTarget(store, 'doc', 'https://example.com/docs'), /不存在/);
});

test('Bundled Markdown parser is the pinned dependency distribution', () => {
  assert.deepEqual(fs.readFileSync(require.resolve('../renderer/vendor/markdown-it.min.js')), fs.readFileSync(require.resolve('markdown-it/browser')));
});
