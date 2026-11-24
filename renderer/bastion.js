'use strict';
const bastionViews = new Map();
let bastionEpoch = 0, bastionActiveKey = null;
function bastionTarget() { return page === 'packages' && selected ? state?.packages.find(p => p.id === selected) : null; }
function bastionKey(p) { return `${bastionEpoch}:${p.id}:${p.vpsIp}`; }
function bastionPanel(p) {
  if (!p.vpsIp) return '<div id="bastion-panel" class="bastion-panel"><span class="muted">填写跳板机 IP 后，可在这里查询状态和开机。</span></div>';
  const item = bastionViews.get(bastionKey(p)), result = item?.result;
  const busy = item?.busy;
  const disabled = busy ? 'disabled' : '';
  const status = result?.label || '尚未查询';
  const time = result?.checkedAt ? new Date(result.checkedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  return `<div id="bastion-panel" class="bastion-panel" aria-live="polite"><div class="bastion-summary"><strong>跳板机</strong><span class="badge ${result?.status === 'RUNNING' ? '' : 'yellow'}">${e(busy === 'start' ? '正在提交开机…' : status)}</span>${result?.name ? `<span class="muted">${e(result.name)}</span>` : ''}</div><p class="help">${e(result?.message || '进入详情时查询一次；可点击「刷新状态」更新。')}${time ? ` · 最近查询 ${e(time)}` : ''}</p><div class="actions">${button(busy === 'check' ? '查询中…' : '刷新状态', 'bastion-check', disabled, 'small')}${button(busy === 'connect' ? '正在打开…' : '连接跳板机', 'bastion-connect', result?.status === 'RUNNING' && !busy ? '' : 'disabled', 'small primary')}${button('一键开机', 'bastion-start', result?.canStart && !busy ? '' : 'disabled', 'small primary')}${button(result?.status === 'LOGIN_REQUIRED' ? '登录管理平台' : '打开管理平台', 'bastion-open', '', 'small')}${button('平台自动登录', 'bastion-auth', '', 'small')}</div>${item?.connectionMessage ? `<p class="help">${e(item.connectionMessage)}</p>` : ''}${item?.requiresAccessibility ? button('打开辅助功能设置','bastion-accessibility','','small') : ''}</div>`;
}
function paintBastion() {
  const p = bastionTarget(), panel = document.querySelector('#bastion-panel');
  if (p && panel) panel.outerHTML = bastionPanel(p);
}
async function queryBastion(operation = 'check') {
  const p = bastionTarget();
  if (!p?.vpsIp || !api.bastionStatus) return;
  const key = bastionKey(p), previous = bastionViews.get(key);
  if (previous?.busy) return;
  const item = { result: previous?.result, busy: operation };
  bastionViews.set(key, item); paintBastion();
  try { item.result = await (operation === 'start' ? api.bastionStart(p.id) : api.bastionStatus(p.id)); }
  catch { item.result = { status: 'UNAVAILABLE', label: '查询未完成', message: operation === 'start' ? '开机结果未确认，请刷新或打开管理平台核对。' : '暂时无法查询，请稍后刷新。', canStart: false }; }
  finally { item.busy = false; }
  const current = bastionTarget();
  if (!current || bastionKey(current) !== key) return; // Discard late UI results after navigation, edits or workspace switches.
  paintBastion();
}
function refreshBastionView() {
  const p = bastionTarget();
  const key = p?.vpsIp ? bastionKey(p) : null;
  if (key === bastionActiveKey) return;
  bastionActiveKey = key;
  if (key && api.bastionStatus) void queryBastion();
}
function resetBastionView() { bastionViews.clear(); bastionEpoch++; bastionActiveKey = null; }
async function bastionAction(action) {
  const p = bastionTarget(); if (!p) return;
  if (action === 'bastion-accessibility') { await api.bastionAccessibility(); return; }
  if (action === 'bastion-auth') { await editBastionAuth(); return; }
  if (action === 'bastion-connect') {
    const key = bastionKey(p), item = bastionViews.get(key);
    if (!item || item.busy || item.result?.status !== 'RUNNING') return;
    item.busy = 'connect'; paintBastion();
    try { const result = await api.bastionConnect(p.id); item.requiresAccessibility = !!result.requiresAccessibility; item.connectionMessage = result.requiresAccessibility ? '复用 Windows App 已保存的连接需要辅助功能权限。请在系统设置中允许 WorkTool，然后再次连接；WorkTool 不读取远程桌面密码。' : '已打开 Windows App 连接 ' + (result.name || p.vpsIp); toast(item.connectionMessage); }
    catch (error) { item.connectionMessage = error.message; throw error; }
    finally { item.busy = false; if (bastionTarget() && bastionKey(bastionTarget()) === key) paintBastion(); }
    return;
  }
  if (action === 'bastion-open') { await api.bastionOpen(p.id); return; }
  if (action === 'bastion-start' && !bastionViews.get(bastionKey(p))?.result?.canStart) return;
  await queryBastion(action === 'bastion-start' ? 'start' : 'check');
}

async function editBastionAuth() {
  const status = await api.bastionAuthStatus();
  let submitting = false;
  modal('管理平台自动登录', `<p>进入应用详情或手动刷新时，会自动续期现有登录凭证。凭证完全失效后，可使用这里保存的账号自动登录。</p><p class="help">账号密码使用本机密钥加密；密钥与凭据文件仅允许当前用户读写，不使用钥匙串，不随项目同步。平台密码与 Windows App 的远程桌面密码独立。</p><p>${status.needsReentry ? '旧配置使用钥匙串，请重新保存一次平台账号密码；不会访问钥匙串。' : status.saved ? status.blocked ? '已保存的账号登录失败，自动尝试已暂停，请更新密码。' : '已保存登录信息，自动登录已开启。' : '尚未保存账号密码；现有会话仍可自动续期。'}</p>` + field('userName','管理平台账号','','text') + field('password','管理平台密码','','password') + `<div class="actions"><button type="button" class="btn small" id="bastion-auth-refresh">续期当前登录</button>${status.saved || status.needsReentry ? '<button type="button" class="btn small danger" id="bastion-auth-remove">关闭自动登录并移除密码</button>' : ''}</div>`, async values => {
    submitting = true;
    const controls = Array.from($('#modal').querySelectorAll('button,input')); controls.forEach(c => c.disabled = true);
    try {
      await api.bastionAuthSave(values);
      $('#modal').close(); toast('登录已验证，自动登录已开启'); await queryBastion();
    } finally { values.password = ''; if ($('#f-password')) $('#f-password').value = ''; submitting = false; controls.forEach(c => c.disabled = false); }
  });
  const dialog = $('#modal');
  $('button[type=submit]', dialog).textContent = '保存并验证登录';
  $('#f-password').autocomplete = 'off'; $('#f-userName').autocomplete = 'off';
  dialog.addEventListener('cancel', ev => { if (submitting) ev.preventDefault(); });
  dialog.addEventListener('close', () => { if ($('#f-password')) $('#f-password').value = ''; }, { once: true });
  const run = async (operation, message) => {
    submitting = true;
    const controls = Array.from(dialog.querySelectorAll('button,input')); controls.forEach(c => c.disabled = true);
    try { await operation(); dialog.close(); toast(message); await queryBastion(); }
    catch (error) { $('#form-error').textContent = error.message; }
    finally { submitting = false; controls.forEach(c => c.disabled = false); }
  };
  $('#bastion-auth-refresh').onclick = () => run(() => api.bastionAuthRefresh(), '当前登录已续期');
  if ($('#bastion-auth-remove')) $('#bastion-auth-remove').onclick = () => run(() => api.bastionAuthRemove(), '已关闭密码自动登录，现有会话仍可续期');
}
