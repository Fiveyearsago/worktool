'use strict';
// Deterministic, offline parsing. Never evaluates markup or fetches linked content.
const MAX_BYTES = 1024 * 1024;
const MAX_RECORDS = 100;
const CORE = ['projectName', 'name', 'applicationId', 'branch', 'flavor', 'vpsIp', 'repo', 'notes'];
const normalize = value => String(value || '').trim().replace(/^[\s*`#\-]+|[\s*`]+$/g, '').toLowerCase().replace(/[\s_\-()（）/\\:：]/g, '');
const aliases = new Map();
for (const [key, names] of Object.entries({
  projectName: ['项目', '项目名称', '所属项目', 'project', 'projectName'],
  name: ['应用名', '应用名称', '产品名', '产品名称', 'appName', 'app name', 'applicationName', '应用显示名'],
  applicationId: ['包名', '应用包名', 'applicationId', 'package', 'packageName', 'package id', 'bundleId'],
  branch: ['分支', 'Git 分支', '代码分支', 'branch', 'gitBranch'],
  flavor: ['flavor', 'flavour', 'productFlavor', '渠道', '构建变体'],
  vpsIp: ['跳板机 VPS IP 地址', '跳板机 VPS IP', '跳板机IP地址', '跳板机IP', '跳板机地址', 'VPS IP 地址', 'VPS IP', 'VPS地址', 'vpsIp', 'jumpHostIp', 'bastionIp'],
  repo: ['仓库', '代码仓库', '代码仓库地址', 'Git 仓库', 'Git地址', 'repo', 'repository', 'repositoryUrl'],
  notes: ['备注', 'notes', 'note']
})) for (const name of names) aliases.set(normalize(name), key);
const fieldKey = name => aliases.get(normalize(name));
const emptyRecord = () => Object.fromEntries([...CORE.map(key => [key, '']), ['fields', []]]);
const hasContent = record => CORE.some(key => record[key]) || record.fields.length;
function checkText(text) {
  if (typeof text !== 'string') throw Error('导入内容必须是文本');
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw Error('识别文本超过 1 MB，请分批导入');
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}
function cleanValue(value) {
  const s = String(value ?? '').trim();
  // Only remove a single enclosing inline-code wrapper. Do not execute or resolve it.
  return /^`[^`]*`$/.test(s) ? s.slice(1, -1) : s;
}
function splitMarkdown(line) {
  const cells = []; let value = '', escaped = false;
  for (const char of line.trim()) {
    if (escaped) { value += char === '|' || char === '\\' ? char : '\\' + char; escaped = false; }
    else if (char === '\\') escaped = true;
    else if (char === '|') { cells.push(value.trim()); value = ''; }
    else value += char;
  }
  if (escaped) value += '\\';
  cells.push(value.trim());
  if (line.trim().startsWith('|')) cells.shift();
  if (line.trim().endsWith('|') && !line.trim().endsWith('\\|')) cells.pop();
  return cells;
}
function parseDelimited(text, delimiter) {
  const rows = []; let row = [], value = '', quoted = false, quoteClosed = false;
  const finishValue = () => { row.push(value.trim()); value = ''; quoteClosed = false; };
  const finishRow = () => { finishValue(); if (row.some(Boolean)) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') { quoted = false; quoteClosed = true; }
      else value += c;
    } else if (c === '"' && !value.trim() && !quoteClosed) { value = ''; quoted = true; }
    else if (c === delimiter) finishValue();
    else if (c === '\n') finishRow();
    else if (quoteClosed && !/\s/.test(c)) throw Error('CSV 引号后的内容无效，请检查原文');
    else value += c;
  }
  if (quoted) throw Error('CSV 引号未闭合，请检查原文');
  if (value || row.length) finishRow();
  return rows;
}
const separatorRow = cells => cells.length > 1 && cells.every(c => /^:?-{3,}:?$/.test(c.trim()));
const valueHeaders = new Set(['值', '内容', '配置内容', '配置值', 'value', 'content']);
const keyHeaders = new Set(['字段', '字段名', '名称', '配置项', '项目', '参数', '参数名', 'key', 'name', 'appname']);
function verticalLayout(header) {
  const names = header.map(normalize);
  const value = names.findIndex(x => valueHeaders.has(x));
  const key = names.findIndex(x => keyHeaders.has(x));
  return value >= 0 && key >= 0 && key !== value ? { key, value, description: names.findIndex(x => ['说明', '描述', 'description'].includes(x)) } : null;
}
function tableRecognized(rows, resolveField = fieldKey) {
  return rows.length && (verticalLayout(rows[0]) || rows[0].some(cell => resolveField(cell)));
}
function parseText(input, { ocr = false } = {}) {
  const text = checkText(input), records = [], warnings = [];
  let current = emptyRecord();
  const warn = message => { if (!warnings.includes(message)) warnings.push(message); };
  const fieldKey = label => {
    const normalized = normalize(label);
    const key = aliases.get(normalized);
    // Vision can read the capital I in ApplicationId as a lowercase l. Only
    // compensate in OCR labels; identifiers and ordinary text stay untouched.
    if (!key && ocr && normalized === 'applicationld') {
      warn('截图标签 Applicationld 已按 ApplicationId 匹配；字段值未自动修正，请核对包名。');
      return 'applicationId';
    }
    return key;
  };
  const append = record => {
    if (!hasContent(record)) return;
    if (records.length >= MAX_RECORDS) throw Error('一次最多导入 100 条记录，请拆分文档');
    records.push(record);
  };
  const flush = () => { append(current); current = emptyRecord(); };
  function assign(record, label, value, description = '') {
    label = cleanValue(label); value = cleanValue(value);
    if (!label || !value) return;
    const key = fieldKey(label);
    if (key && !record[key]) record[key] = value;
    else if (key && record[key] !== value) {
      record.fields.push({ title: label, content: value });
      warn('同一记录存在重复字段，额外值已保留为自定义字段，请核对。');
    } else if (!key) record.fields.push({ title: label, content: value });
    if (description && key !== 'notes') {
      // Preserve explanatory text without confusing it with the configured value.
      record.fields.push({ title: label + ' · 说明', content: cleanValue(description) });
    }
  }
  function pair(label, value, description) {
    const key = fieldKey(label);
    // Repeated identity labels mark a new product, even when values are identical.
    if ((key === 'name' || key === 'applicationId') && current[key]) flush();
    if (key === 'projectName' && current.projectName && current.projectName !== cleanValue(value)) flush();
    assign(current, label, value, description);
  }
  function table(rows) {
    rows = rows.filter(row => !separatorRow(row));
    if (!rows.length) return;
    const vertical = verticalLayout(rows[0]);
    if (vertical) {
      for (const row of rows.slice(1)) {
        if (row.length !== rows[0].length) warn('表格有不完整行，请对照原文检查。');
        pair(row[vertical.key], row[vertical.value], vertical.description >= 0 ? row[vertical.description] : '');
      }
      return;
    }
    const header = rows[0];
    const headerless = fieldKey(header[0]) && !header.slice(1).some(cell => fieldKey(cell)) && header.length >= 2 && header.length <= 3 &&
      (rows.length === 1 || rows.slice(1).some(row => fieldKey(row[0])));
    if (headerless) {
      for (const row of rows) pair(row[0], row.at(-1), row.length === 3 ? row[1] : '');
      return;
    }
    if (header.some(cell => fieldKey(cell))) {
      flush();
      for (const row of rows.slice(1)) {
        if (!row.some(Boolean)) continue;
        const record = emptyRecord();
        if (row.length !== header.length) warn('表格有不完整行，请对照原文检查。');
        header.forEach((label, i) => assign(record, label, row[i]));
        row.slice(header.length).forEach((value, i) => assign(record, '额外列 ' + (i + 1), value));
        append(record);
      }
      return;
    }
    // Headerless two/three-column key-value tables are accepted only when the
    // first column contains a recognized label somewhere, preventing prose guesses.
    if (rows.some(row => fieldKey(row[0])) && rows.every(row => row.length >= 2 && row.length <= 3)) {
      for (const row of rows) pair(row[0], row.at(-1), row.length === 3 ? row[1] : '');
    } else warn('有表格未能自动匹配字段，原文仍可作为项目文档保存。');
  }
  const lines = text.split('\n');
  // A CSV/TSV export is parsed as a whole to retain quoted multiline cells.
  const first = lines.find(line => line.trim()) || '';
  let fullTable = false;
  for (const delimiter of ['\t', ',']) {
    if (!first.includes(delimiter) || first.includes('|')) continue;
    const firstRow = parseDelimited(first, delimiter)[0];
    if (firstRow && tableRecognized([firstRow], fieldKey)) {
      table(parseDelimited(text, delimiter)); fullTable = true; break;
    }
  }
  if (!fullTable) {
    let fenced = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i], trimmed = line.trim();
      if (/^(```|~~~)/.test(trimmed)) { fenced = !fenced; continue; }
      // Fenced configuration text is still parsed as data, never evaluated.
      if (!fenced && /^#{1,6}\s/.test(trimmed)) { flush(); continue; }
      if (!trimmed) continue;
      if (line.includes('|') && (trimmed.startsWith('|') || lines[i + 1]?.includes('|'))) {
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitMarkdown(lines[i++]));
        i--; table(rows); continue;
      }
      if (line.includes('\t')) {
        const group = [];
        while (i < lines.length && lines[i].includes('\t') && lines[i].trim()) group.push(lines[i++]);
        i--; table(parseDelimited(group.join('\n'), '\t')); continue;
      }
      // Normal key:value blocks, including Markdown bullets and bold keys.
      const match = trimmed.match(/^(?:[-*+]\s+|\d+[.)]\s+)?([^:：\n]{1,100})[:：]\s*(.*)$/);
      if (match) {
        const label = match[1].replace(/^\*\*|\*\*$/g, '').trim();
        const value = match[2].replace(/^\*\*\s*/, '');
        // URL/prose lines are not treated as made-up configuration labels.
        if (!/^https?$/i.test(label) && (fieldKey(label) || !/[。！？.!?]/.test(label))) pair(label, value);
      }
    }
  }
  flush();
  if (!records.length) warn('未识别到项目或产品字段，可保留为文档，或手动补充预览内容。');
  if (records.some(record => !record.applicationId)) warn('部分记录缺少包名；不会自动猜测，请补充或仅保存为文档。');
  if (records.some(record => !record.projectName)) warn('部分记录未写明所属项目，请在预览中选择。');
  return { records, warnings };
}

function secretKind(label) {
  const key = normalize(label).replace(/["'{}\[\],]/g, '');
  if (/^(firebase)?(apikey|appkey|appid|applicationid)$/.test(key) || /^(adjust)?apptoken$/.test(key)) return '';
  if (/^(password|passwd|pwd|密码|登录密码|账号密码|口令|认证pin|bankingpin)$/.test(key)) return '密码';
  if (/(privatekey|私钥|serviceaccountkey|服务账号密钥)/.test(key)) return '私钥';
  if (/^(token|accesstoken|refreshtoken|sessiontoken|idtoken|bearertoken|authtoken|authorization|访问令牌|刷新令牌|会话令牌)$/.test(key)) return '认证令牌';
  if (/(clientsecret|apisecret|secretkey|secretaccesskey|secret$|客户端密钥)/.test(key)) return '密钥';
  return '';
}
function findSecrets(input) {
  const text = checkText(input), found = new Set();
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(text)) found.add('私钥');
  const inspect = (label, value) => { const kind = secretKind(label); if (kind && cleanValue(value)) found.add(kind); };
  // Inspect parsed fields/columns without ever returning a secret value.
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/^\s*(?:[-*+]\s+)?["'`*]*([^:：=\n]{1,100}?)['"`*]*\s*[:：=]\s*(.+)$/);
    if (match) inspect(match[1], match[2]);
    // JSON properties may appear on a single line, not just one property per line.
    for (const m of line.matchAll(/["']([^"']+)["']\s*:\s*(?:["']([^"']+)["']|([^,}\s]+))/g)) inspect(m[1], m[2] || m[3]);
  }
  for (const delimiter of ['|', '\t', ',']) {
    let rows;
    try { rows = delimiter === '|' ? lines.filter(line => line.includes('|')).map(splitMarkdown) : parseDelimited(text, delimiter); }
    catch { continue; }
    rows = rows.filter(row => !separatorRow(row));
    for (const row of rows) if (row.length >= 2) inspect(row[0], row.at(-1));
    const secretColumns = new Map();
    for (const row of rows) {
      for (const [column, label] of secretColumns) inspect(label, row[column]);
      row.forEach((label, column) => { if (secretKind(label)) secretColumns.set(column, label); });
    }
  }
  if (/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/i.test(text)) found.add('认证令牌');
  return [...found];
}
module.exports = { parseText, findSecrets };
