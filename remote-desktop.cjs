'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { cleanVpsIp } = require('./core.cjs');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const CLIENT = '/Applications/Windows App.app/Contents/MacOS/Windows App';
function remoteDesktopUrl(value, settings = {}) {
  const ip = cleanVpsIp(value); if (!ip) throw Error('请先填写跳板机 IP。');
  const address = ip.includes(':') ? `[${ip}]` : ip;
  let url = `rdp://full%20address=s:${encodeURIComponent(address)}`;
  for (const key of ['username', 'domain', 'gatewayhostname', 'gatewayusername']) {
    const value = settings[key];
    if (typeof value === 'string' && value && value.length <= 512 && !/[\r\n\0]/.test(value)) url += `&${key}=s:${encodeURIComponent(value)}`;
  }
  if (settings.gatewayhostname) url += '&gatewayusagemethod=i:1';
  return url;
}
function parseBookmark(text, ip) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^(full address|username|domain|gatewayhostname|gatewayusername):s:(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  let host = values['full address'] || '';
  if (host.startsWith('[')) host = host.replace(/^\[([^\]]+)\](?::3389)?$/, '$1');
  else if (/^\d+\.\d+\.\d+\.\d+:3389$/.test(host)) host = host.slice(0,-5);
  return host === ip ? values : null;
}
async function savedConnection(ip, run) {
  const { stdout } = await run(CLIENT, ['--script', 'bookmark', 'list'], { timeout: 10000, maxBuffer: 1024 * 1024 });
  const entries = [...stdout.matchAll(/^"(.*)",\s*([A-Fa-f0-9-]{36})\s*$/gm)].map(m => ({name:m[1].replace(/""/g,'"'),id:m[2]}));
  if (entries.length > 100) throw Error('保存的连接较多，请直接从 Windows App 选择。');
  const matches = [];
  for (const { id, name } of entries) {
    const { stdout: exported } = await run(CLIENT, ['--script', 'bookmark', 'export', id], { timeout: 5000, maxBuffer: 128 * 1024 });
    const settings = parseBookmark(exported, ip); if (settings) matches.push({ ...settings, name, id });
  }
  if (matches.length > 1) throw Error('此 IP 在 Windows App 中有多个连接，请直接在客户端选择。');
  return matches[0] || {};
}
function connectionFile(ip, settings, directory) {
  const address = ip.includes(':') ? `[${ip}]` : ip;
  const lines = [`full address:s:${address}`];
  for (const key of ['username', 'domain', 'gatewayhostname', 'gatewayusername']) {
    const value = settings[key];
    if (typeof value === 'string' && value && value.length <= 512 && !/[\r\n\0]/.test(value)) lines.push(`${key}:s:${value}`);
  }
  if (settings.gatewayhostname) lines.push('gatewayusagemethod:i:1');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, crypto.createHash('sha256').update(ip).digest('hex').slice(0,24) + '.rdp');
  fs.writeFileSync(file, '\uFEFF' + lines.join('\r\n') + '\r\n', { encoding: 'utf16le', mode: 0o600 }); fs.chmodSync(file, 0o600);
  return file;
}
async function openRemoteDesktop(ip, { platform = process.platform, run = promisify(execFile), directory, helper } = {}) {
  if (platform !== 'darwin') throw Error('此入口目前支持 macOS 的 Windows App，请在 Windows App 中连接该 IP。');
  remoteDesktopUrl(ip); // Validate before invoking any external process.
  let settings;
  try { settings = await savedConnection(ip, run); }
  catch { throw Error('无法匹配 Windows App 的已保存连接，请打开 Windows App 核对该 IP 是否唯一。'); }
  if (settings.id && helper) {
    await run('/usr/bin/open', ['-a', '/Applications/Windows App.app'], { timeout: 10000 });
    const { stdout } = await run(helper, [settings.name], { timeout: 10000, maxBuffer: 4096 });
    const status = stdout.trim();
    if (status === 'ACCESSIBILITY_REQUIRED') return { opened: false, requiresAccessibility: true, name: settings.name };
    if (status !== 'OPENED') throw Error(status === 'CLIENT_DIALOG_OPEN' ? '请先处理 Windows App 当前的登录或证书窗口，再连接。' : '未找到唯一可见的已保存连接，请在 Windows App 展开设备列表、清空搜索后重试。');
    return { opened: true, ip, client: 'Windows App', name: settings.name, savedConnection: true };
  }
  if (!directory) throw Error('远程连接目录未配置。');
  const file = connectionFile(ip, settings, directory);
  try { await run('/usr/bin/open', ['-a', '/Applications/Windows App.app', file], { timeout: 10000 }); }
  catch { throw Error('无法打开 Windows App，请先安装或打开一次 Windows App 后重试。'); }
  return { opened: true, ip, client: 'Windows App' };
}
module.exports = { remoteDesktopUrl, openRemoteDesktop, savedConnection, parseBookmark, connectionFile };
