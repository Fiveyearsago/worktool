'use strict';
let aiConfig = { hasKey: false, model: 'LongCat-2.5' }, aiBusy = false, aiMessage = '';
async function loadAISettings() {
  try { aiConfig = await api.aiStatus(); if(aiConfig.needsKeyReentry)aiMessage='旧配置不再使用，请重新填写 API Key；不会访问钥匙串。'; importMode = aiConfig.hasKey ? 'longcat' : 'local'; }
  catch { aiMessage = 'AI 配置无法读取，请重新填写并保存。'; }
}
function aiPage() {
  return head('AI 设置', '使用 LongCat 提取截图和资料中的项目字段。') + `<div class="card ai-settings">
    <div class="section-head"><h2>LongCat</h2><span class="badge">${aiConfig.hasKey ? '已保存 API Key' : '尚未配置'}</span></div>
    <p>API Key 以明文保存在本机独立配置文件中，不使用钥匙串；文件仅允许当前用户读写，不随项目 Git 同步。点击测试只发送一条简短测试文字，会产生少量 API 用量。</p>
    <div class="field"><label for="ai-key">API Key</label><input id="ai-key" type="password" autocomplete="off" spellcheck="false" placeholder="${aiConfig.hasKey ? '已保存，留空则保留；填写新 Key 可替换' : '从 LongCat 开放平台复制 API Key'}" ${aiBusy ? 'disabled' : ''}></div>
    <div class="field"><label for="ai-model">模型</label><input id="ai-model" value="${e(aiConfig.model)}" spellcheck="false" ${aiBusy ? 'disabled' : ''}><div class="help">默认 LongCat-2.5，截图识别需要使用支持图片的模型。</div></div>
    <div class="actions">${button('保存配置', 'ai-save', aiBusy ? 'disabled' : '', 'primary')}${button('保存并测试连接', 'ai-test', aiBusy ? 'disabled' : '')}${aiConfig.hasKey ? button('移除 API Key', 'ai-remove', aiBusy ? 'disabled' : '', 'danger') : ''}</div>
    <p id="ai-status" role="status">${e(aiBusy ? '正在处理，请稍候…' : aiMessage)}</p>
    <p>在「导入资料」选择 LongCat AI 后，所选截图或文字会发送到 LongCat 处理。识别结果仍需核对后保存。图片里的敏感内容请在上传前移除。</p>
    ${button('打开 LongCat 开放平台', 'open-url', 'data-url="https://longcat.chat/platform"', 'small')}
  </div>`;
}
async function aiAction(action) {
  if (aiBusy) return;
  const input = { model: $('#ai-model').value.trim(), apiKey: $('#ai-key').value, removeKey: action === 'ai-remove' };
  aiBusy = true; aiMessage = ''; render();
  try {
    aiConfig = await api.aiSave(input);
    importMode = aiConfig.hasKey ? 'longcat' : 'local';
    aiMessage = action === 'ai-remove' ? '已移除本机 API Key。' : '配置已保存。';
    if (action === 'ai-test') {
      const result = await api.aiTest();
      aiMessage = `连接成功 · ${result.model} · ${(result.elapsedMs / 1000).toFixed(1)} 秒。可以开始导入资料。`;
    }
  } catch (error) { aiMessage = error.message || '操作失败，请重试。'; }
  finally { input.apiKey = ''; aiBusy = false; if (page === 'ai') render(); }
}
