'use strict';
const { cleanVpsIp } = require('./core.cjs');
const PORTAL_URL = 'https://uc.ushareit.org/index.html?#/bastion-host';
const STATUS_LABELS = { RUNNING: '已开机', STOPPED: '已关机', STARTING: '开机中', STOPPING: '关机中', UNKNOWN: '状态未知', ERROR: '主机异常', NOT_FOUND: '云端不存在', DELETED: '已删除' };
class BastionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function failure(code, message) { throw new BastionError(code, message); }
function unwrap(response) {
  if (response?.error === 'LOGIN_REQUIRED') failure('LOGIN_REQUIRED', response.authReason ? '自动恢复登录未成功，请登录管理平台或更新自动登录信息。' : '请先登录跳板机管理平台');
  if (response?.error) failure('UNAVAILABLE', '暂时无法连接管理平台，请稍后刷新');
  const code = Number(response?.body?.code);
  if (response?.status === 401 || [401, 8888, 8889, 7777, 7778, 9999, 9998, 3333].includes(code)) failure('LOGIN_REQUIRED', '平台登录已失效，请重新登录');
  if (response?.status === 403 || code === 403) failure('FORBIDDEN', '当前账号没有此操作权限，请在管理平台核对');
  if (response?.status < 200 || response?.status >= 300 || code !== 200) failure('REJECTED', '平台未完成请求，请刷新状态或在平台查看操作记录');
  return response.body.data;
}
function hostFromList(data, ip) {
  if (!data || !Array.isArray(data.list) || !Number.isSafeInteger(data.total) || data.total < 0) failure('BAD_RESPONSE', '平台返回格式已变化，请从管理平台查看');
  // The website supports fuzzy IP search. Never operate on a partial match or an incomplete result set.
  if (data.total > data.list.length) failure('AMBIGUOUS', '平台返回多页结果，请在平台精确核对该 IP');
  const matches = data.list.filter(h => h && h.publicIp === ip);
  if (matches.length === 0) failure('NOT_REGISTERED', '平台中未找到此 IP，请检查应用配置');
  if (matches.length !== 1) failure('AMBIGUOUS', '此 IP 对应多条主机记录，请先在平台核对');
  const h = matches[0];
  if (!(Number.isSafeInteger(h.id) && h.id > 0 || typeof h.id === 'string' && /^[1-9][0-9]{0,19}$/.test(h.id)) || !Number.isSafeInteger(h.version) || h.version < 0) failure('BAD_RESPONSE', '主机标识或版本无效，请在管理平台查看');
  return { id: h.id, version: h.version, ip, name: typeof h.name === 'string' ? h.name.slice(0, 200) : '', status: Object.hasOwn(STATUS_LABELS, h.status) ? h.status : 'UNKNOWN' };
}
class BastionService {
  constructor(getStore, portal, { now = Date.now, openDesktop } = {}) {
    this.getStore = getStore; this.portal = portal; this.now = now; this.openDesktop = openDesktop; this.connecting = new Set();
    this.reads = new Map(); this.starts = new Set(); this.pending = new Map();
  }
  target(packageId) {
    if (typeof packageId !== 'string') failure('INVALID_TARGET', '请先选择应用');
    const store = this.getStore(), pkg = store.load().packages.find(p => p.id === packageId);
    if (!pkg) failure('INVALID_TARGET', '应用已不存在，请重新选择');
    const ip = cleanVpsIp(pkg.vpsIp);
    if (!ip) failure('NO_IP', '请先在应用基本配置中填写跳板机 IP');
    return { store, packageId, ip };
  }
  current(t) {
    const current = this.target(t.packageId);
    if (current.store !== t.store || current.ip !== t.ip) failure('TARGET_CHANGED', '工作区或跳板机 IP 已改变，请重新查询');
  }
  async lookup(t) {
    const data = unwrap(await this.portal.request('list', { ip: t.ip }));
    this.current(t);
    return hostFromList(data, t.ip);
  }
  present(h) {
    if (h.status === 'RUNNING' || ['ERROR', 'NOT_FOUND', 'DELETED'].includes(h.status)) this.pending.delete(h.ip);
    let pending = this.pending.get(h.ip);
    // A request from yesterday must not block today's manual start after scheduled shutdown.
    // Keep the uncertainty visible, but only re-enable an explicit click after a fresh STOPPED result.
    const expired = pending && this.now() - pending.at > 660000 && h.status === 'STOPPED';
    if (expired) { this.pending.delete(h.ip); pending = null; }
    const waiting = pending && ['STOPPED', 'UNKNOWN', 'STARTING'].includes(h.status);
    return { ip: h.ip, name: h.name, status: waiting ? 'STARTING' : h.status,
      label: waiting ? (pending.uncertain || this.now() - pending.at > 120000 ? '开机结果待确认' : '开机中') : STATUS_LABELS[h.status],
      canStart: h.status === 'STOPPED' && !pending && !this.starts.has(h.ip), checkedAt: this.now(),
      message: waiting ? '已发起开机，请点击「刷新状态」查看进度；请勿重复提交。' : expired ? '此前开机结果未确认；当前平台显示已关机，可核对后手动重试。' : '', portalUrl: PORTAL_URL };
  }
  errorResult(error, ip = '') {
    return { ip, status: error instanceof BastionError ? error.code : 'UNAVAILABLE', label: error?.code === 'LOGIN_REQUIRED' ? '需要登录' : '查询未完成', canStart: false, checkedAt: this.now(), message: error instanceof BastionError ? error.message : '暂时无法查询平台状态，请稍后重试', portalUrl: PORTAL_URL };
  }
  async status(packageId) {
    let t;
    try {
      t = this.target(packageId);
      let read = this.reads.get(t.ip);
      if (!read) {
        read = this.lookup(t).finally(() => { if (this.reads.get(t.ip) === read) this.reads.delete(t.ip); });
        this.reads.set(t.ip, read);
      }
      const h = await read; this.current(t); return this.present(h);
    } catch (error) { return this.errorResult(error, t?.ip); }
  }
  async start(packageId) {
    let t;
    try {
      t = this.target(packageId);
      if (this.starts.has(t.ip)) failure('BUSY', '开机请求正在处理中，请勿重复点击');
      this.starts.add(t.ip);
      try {
        const h = await this.lookup(t); // Always refresh id/version immediately before a mutation.
        if (h.status !== 'STOPPED' || this.pending.has(t.ip)) return this.present(h);
        this.current(t);
        this.pending.set(t.ip, { at: this.now(), uncertain: true });
        let data;
        try { data = unwrap(await this.portal.request('start', { id: h.id, version: h.version })); }
        catch (error) {
          if (['LOGIN_REQUIRED', 'FORBIDDEN', 'REJECTED'].includes(error.code)) this.pending.delete(t.ip);
          throw error;
        }
        if (data?.operationStatus === 'SUCCESS') this.pending.set(t.ip, { at: this.now(), uncertain: false });
        else if (['FAILED', 'FAILURE', 'ERROR'].includes(data?.operationStatus)) {
          this.pending.delete(t.ip); failure('START_FAILED', '平台报告开机失败，请在管理平台查看操作日志');
        }
        this.current(t);
        // A successful HTTP request is not proof that the host is running.
        return this.present(await this.lookup(t));
      } finally { this.starts.delete(t.ip); }
    } catch (error) {
      const result = this.errorResult(error, t?.ip);
      if (t && this.pending.has(t.ip)) result.message = '开机请求结果尚未确认，请刷新状态或打开管理平台核对；不会自动重复开机。';
      return result;
    }
  }
  async open(packageId) { const t = this.target(packageId); await this.portal.open(t.ip); return { opened: true, ip: t.ip }; }
  async connect(packageId) {
    const t = this.target(packageId);
    if (this.connecting.has(t.ip)) failure('BUSY', '正在打开 Windows App，请稍候。');
    this.connecting.add(t.ip);
    try {
      const h = await this.lookup(t); this.current(t);
      if (h.status !== 'RUNNING') failure('NOT_RUNNING', '跳板机尚未开机，请先开机并刷新状态。');
      if (!this.openDesktop) failure('UNAVAILABLE', '当前系统不支持此连接入口。');
      return await this.openDesktop(t.ip);
    } finally { this.connecting.delete(t.ip); }
  }
}
module.exports = { BastionService, BastionError, hostFromList, unwrap, STATUS_LABELS, PORTAL_URL };
