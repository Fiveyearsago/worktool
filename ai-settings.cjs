'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const DEFAULT_MODEL = 'LongCat-2.5';

// User-requested local storage: plaintext, owner-only permissions, outside the workspace.
// Never access macOS Keychain or Electron safeStorage, including for older configurations.
class AISettings {
  constructor(file) { this.file = file; }
  read() {
    if (!fs.existsSync(this.file)) return { model: DEFAULT_MODEL };
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof value.model !== 'string' || !/^[\w.-]{1,100}$/.test(value.model) || (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || value.apiKey.length > 4096 || /[\r\n]/.test(value.apiKey)))) throw Error();
      return value;
    } catch { throw Error('AI 配置无法读取，请在 AI 设置中重新保存。'); }
  }
  status() {
    const value = this.read();
    return { provider: 'longcat', model: value.model, hasKey: !!value.apiKey, needsKeyReentry: !!value.encryptedKey && !value.apiKey };
  }
  async credentials() {
    const value = this.read();
    if (!value.apiKey) throw Error(value.encryptedKey ? '旧配置使用钥匙串加密，请在 AI 设置中重新填写 API Key；不会访问钥匙串。' : '请先在「AI 设置」中保存 LongCat API Key。');
    return { model: value.model, apiKey: value.apiKey };
  }
  save(input) {
    let temporary;
    try {
      if (!input || typeof input.model !== 'string' || !/^[\w.-]{1,100}$/.test(input.model.trim())) throw Error('请填写有效的模型名称。');
      if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n]/.test(input.apiKey))) throw Error('API Key 格式无效。');
      let previous;
      try { previous = this.read(); } catch { previous = {}; }
      const next = { model: input.model.trim() };
      if (!input.removeKey) {
        const key = input.apiKey?.trim() || previous.apiKey;
        if (key) next.apiKey = key;
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      temporary = this.file + '.' + crypto.randomUUID() + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
      return this.status();
    } finally { if (temporary) fs.rmSync(temporary, { force: true }); }
  }
}
module.exports = { AISettings, DEFAULT_MODEL };
