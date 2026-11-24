'use strict';
const { cleanVpsIp } = require('./core.cjs');
const { PORTAL_URL } = require('./bastion-service.cjs');
const { credentials: cleanCredentials } = require('./bastion-auth.cjs');
const ORIGIN = 'https://uc.ushareit.org';
function needsLogin(response) {
  return response?.error === 'LOGIN_REQUIRED' || response?.status === 401 || [401, 8888, 8889, 7777, 7778, 9999, 9998, 3333].includes(Number(response?.body?.code));
}
// Runs only at the platform origin. Never return tokens, passwords or raw auth responses.
async function portalAuth(action, credentials) {
  if (location.origin !== 'https://uc.ushareit.org' || !['refresh', 'login'].includes(action)) return { ok: false, reason: 'UNAVAILABLE' };
  const read = key => { try { const value = JSON.parse(localStorage.getItem('MATRIX_' + key)); return typeof value === 'string' && value.length <= 16384 ? value : ''; } catch { return ''; } };
  const token = read('token'), refreshToken = read('refreshToken');
  if (action === 'refresh' && !refreshToken) return { ok: false, reason: 'MISSING' };
  if (action === 'login' && (!credentials?.userName || !credentials?.password)) return { ok: false, reason: 'MISSING' };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(new URL(action === 'refresh' ? '/auth/refreshToken' : '/auth/login', location.origin).href, {
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
      body: JSON.stringify(action === 'refresh' ? { refreshToken } : { userName: credentials.userName, password: credentials.password })
    });
    if (response.status >= 500 || response.status === 429) return { ok: false, reason: 'UNAVAILABLE' };
    if (response.status === 401 || response.status === 403) return { ok: false, reason: 'REJECTED' };
    const text = await response.text(); if (text.length > 65536) return { ok: false, reason: 'UNAVAILABLE' };
    const body = JSON.parse(text), data = body?.data;
    if (!response.ok || Number(body.code) !== 200) return { ok: false, reason: 'REJECTED' };
    if (!data || typeof data.token !== 'string' || !data.token || data.token.length > 16384) return { ok: false, reason: 'UNAVAILABLE' };
    localStorage.setItem('MATRIX_token', JSON.stringify(data.token));
    // Some platform deployments issue only an access token. Never retain another
    // account's previous refresh token; saved-login fallback handles the next expiry.
    if (typeof data.refreshToken === 'string' && data.refreshToken && data.refreshToken.length <= 16384) localStorage.setItem('MATRIX_refreshToken', JSON.stringify(data.refreshToken));
    else localStorage.removeItem('MATRIX_refreshToken');
    return { ok: true };
  } catch { return { ok: false, reason: 'UNAVAILABLE' }; }
  finally { clearTimeout(timer); credentials = undefined; }
}
// Runs in an isolated world of the portal's own origin. Credentials never leave that window.
async function portalRequest(operation, input) {
  if (location.origin !== 'https://uc.ushareit.org') return { error: 'LOGIN_REQUIRED' };
  let token;
  try { token = JSON.parse(localStorage.getItem('MATRIX_token')); } catch {}
  if (typeof token !== 'string' || !token || token.length > 16384) return { error: 'LOGIN_REQUIRED' };
  const isStart = operation === 'start';
  if (!isStart && operation !== 'list') return { error: 'UNAVAILABLE' };
  const url = new URL(isStart ? '/system/bastion-host/start' : '/system/bastion-host/list', location.origin);
  if (!isStart) { url.searchParams.set('pageNum', '1'); url.searchParams.set('pageSize', '100'); url.searchParams.set('publicIp', input.ip); }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), isStart ? 30000 : 12000);
  try {
    const response = await fetch(url.href, { method: isStart ? 'POST' : 'GET', headers: { Authorization: token, ...(isStart ? { 'Content-Type': 'application/json' } : {}) },
      ...(isStart ? { body: JSON.stringify({ id: input.id, version: input.version }) } : {}), credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal });
    if (response.status === 401 || response.status === 403) return { status: response.status, body: {} };
    const text = await response.text();
    if (text.length > 2000000) return { error: 'UNAVAILABLE' };
    try { return { status: response.status, body: JSON.parse(text) }; } catch { return { error: 'UNAVAILABLE' }; }
  } catch { return { error: 'UNAVAILABLE' }; }
  finally { clearTimeout(timer); token = undefined; }
}
function filterPortal(ip) {
  if (location.origin !== 'https://uc.ushareit.org' || !location.hash.startsWith('#/bastion-host')) return false;
  const fill = () => {
    const input = document.querySelector('input[placeholder="请输入公网IP"]');
    const query = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '查询');
    if (!input || !query) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ip);
    input.dispatchEvent(new Event('input', { bubbles: true })); query.click(); return true;
  };
  if (fill()) return true;
  const observer = new MutationObserver(() => { if (fill()) { observer.disconnect(); clearTimeout(timer); } });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const timer = setTimeout(() => observer.disconnect(), 10000);
  return false;
}
class BastionPortal {
  constructor({ BrowserWindow, session, auth, now = Date.now }, parent) {
    this.BrowserWindow = BrowserWindow; this.session = session; this.auth = auth; this.now = now; this.parent = parent;
    this.window = null; this.ready = null; this.filterIp = ''; this.disposed = false;
    this.authGeneration = 0; this.recovery = null; this.retryAfter = 0;
  }
  async ensure() {
    if (this.disposed) throw Error('closed');
    if (this.window && !this.window.isDestroyed()) { if (this.ready) await this.ready; return this.window; }
    const ses = this.session.fromPartition('persist:worktool-bastion');
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    const window = this.window = new this.BrowserWindow({ width: 1140, height: 800, show: false, parent: this.parent,
      title: '跳板机管理平台 · WorkTool', webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    const allowed = url => { try { return new URL(url).origin === ORIGIN; } catch { return false; } };
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const event of ['will-navigate', 'will-redirect']) window.webContents.on(event, (e, url) => { if (!allowed(url)) e.preventDefault(); });
    window.on('close', e => {
      if (!this.disposed) {
        e.preventDefault(); window.hide();
        // macOS does not reliably return focus from a hidden child window to its parent.
        setImmediate(() => {
          if (this.parent && !this.parent.isDestroyed()) {
            if (this.parent.isMinimized()) this.parent.restore();
            this.parent.show(); this.parent.focus();
          }
        });
      }
    });
    window.webContents.on('did-finish-load', () => this.applyFilter());
    window.webContents.on('did-navigate-in-page', () => this.applyFilter());
    this.ready = window.loadURL(PORTAL_URL);
    try { await this.ready; } catch { if (!window.isDestroyed()) window.destroy(); this.window = null; throw Error('平台页面无法加载'); }
    finally { this.ready = null; }
    return window;
  }
  async rawRequest(operation, input) {
    try {
      const window = await this.ensure();
      if (new URL(window.webContents.getURL()).origin !== ORIGIN) return { error: 'LOGIN_REQUIRED' };
      return await window.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${portalRequest.toString()})(${JSON.stringify(operation)},${JSON.stringify(input)})` }]);
    } catch { return { error: 'UNAVAILABLE' }; }
  }
  async authenticate(action, credentials) {
    try {
      const window = await this.ensure();
      if (new URL(window.webContents.getURL()).origin !== ORIGIN) return { ok: false, reason: 'UNAVAILABLE' };
      return await window.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${portalAuth.toString()})(${JSON.stringify(action)},${JSON.stringify(credentials)})` }]);
    } catch { return { ok: false, reason: 'UNAVAILABLE' }; }
  }
  async recover(generation = this.authGeneration) {
    if (generation !== this.authGeneration) return { ok: true };
    if (this.recovery) return this.recovery;
    if (this.savingLogin) return { ok: false, reason: 'COOLDOWN' };
    if (this.now() < this.retryAfter) return { ok: false, reason: 'COOLDOWN' };
    this.recovery = (async () => {
      let result = await this.authenticate('refresh');
      if (!result.ok && ['MISSING', 'REJECTED'].includes(result.reason) && this.auth) {
        let credentials;
        try {
          credentials = await this.auth.get();
          if (credentials) {
            result = await this.authenticate('login', credentials);
            if (!result.ok && result.reason === 'REJECTED') this.auth.block();
          }
        } catch { result = { ok: false, reason: 'CREDENTIALS_UNAVAILABLE' }; }
        finally { credentials = undefined; }
      }
      if (result.ok) { this.authGeneration++; this.retryAfter = 0; }
      else this.retryAfter = this.now() + 60000;
      return result;
    })();
    try { return await this.recovery; } finally { this.recovery = null; }
  }
  async request(operation, input) {
    const generation = this.authGeneration;
    const result = await this.rawRequest(operation, input);
    // Read-only retry only: an uncertain or rejected start is never automatically replayed.
    if (operation !== 'list' || !needsLogin(result)) return result;
    const recovered = await this.recover(generation);
    if (!recovered.ok) return { error: 'LOGIN_REQUIRED', authReason: recovered.reason };
    return this.rawRequest(operation, input);
  }
  async saveLogin(input) {
    if (!this.auth) throw Error('自动登录不可用');
    if (this.recovery || this.savingLogin) throw Error('正在处理登录，请稍后保存。');
    this.savingLogin = true;
    let value;
    try {
      value = cleanCredentials(input);
      const prepared = await this.auth.prepare(value);
      const result = await this.authenticate('login', value);
      if (!result.ok) throw Error(result.reason === 'REJECTED' ? '登录未通过，请核对账号密码，或在平台完成验证。' : '平台暂时无法连接，未保存登录信息。');
      this.auth.write(prepared); this.authGeneration++; this.retryAfter = 0;
      return this.auth.status();
    } finally { value = undefined; this.savingLogin = false; }
  }
  removeLogin() {
    if (this.recovery || this.savingLogin) throw Error('正在处理登录，请稍后关闭自动登录。');
    return this.auth.remove();
  }
  async refreshLogin() {
    const result = await this.recover();
    if (!result.ok) throw Error(({ MISSING: '平台未提供可续期的凭证，请保存账号密码以启用自动登录。', REJECTED: '平台拒绝续期或登录，请更新自动登录信息，或在管理平台完成验证。', COOLDOWN: '刚才的登录恢复未成功，请稍后再试，或直接保存并验证登录信息。', CREDENTIALS_UNAVAILABLE: '已保存的登录信息无法读取，请重新保存。' })[result.reason] || '平台暂时无法连接，请稍后重试。');
    return { refreshed: true };
  }
  async applyFilter() {
    if (!this.filterIp || !this.window || this.window.isDestroyed() || !this.window.isVisible()) return;
    try { await this.window.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${filterPortal.toString()})(${JSON.stringify(this.filterIp)})` }]); } catch {}
  }
  async open(ip) {
    this.filterIp = cleanVpsIp(ip);
    const window = await this.ensure(); window.show(); window.focus();
    if (window.webContents.getURL().includes('#/login')) {
      if ((await this.recover()).ok) await window.loadURL(PORTAL_URL);
    } else if (!window.webContents.getURL().includes('#/bastion-host')) await window.loadURL(PORTAL_URL);
    await this.applyFilter();
  }
  dispose() { this.disposed = true; if (this.window && !this.window.isDestroyed()) this.window.destroy(); }
}
module.exports = { BastionPortal, portalRequest, portalAuth, needsLogin, filterPortal };
