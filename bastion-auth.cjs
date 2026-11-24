'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
function credentials(input) {
  if (!input || typeof input.userName !== 'string' || !input.userName.trim() || input.userName.length > 200 || /[\r\n\0]/.test(input.userName) || typeof input.password !== 'string' || !input.password || input.password.length > 4096 || /\0/.test(input.password)) throw Error('请填写有效的管理平台账号和密码。');
  return { userName: input.userName.trim(), password: input.password };
}
// User-requested local-only storage. Never access Keychain or Electron safeStorage,
// even when encountering the old OS-encrypted format. Local key and ciphertext are
// owner-only files outside the workspace; they are not protection against same-user apps.
class BastionAuth {
  constructor(file) { this.file = file; this.keyFile = file + '.key'; }
  read() {
    if (!fs.existsSync(this.file)) return {};
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (![1,2].includes(value.version) || typeof value.encrypted !== 'string' || !/^[A-Za-z0-9+/=]{1,32768}$/.test(value.encrypted)) throw Error();
      return value;
    } catch { throw Error('自动登录配置无法读取，请重新保存登录信息。'); }
  }
  status() { const v = this.read(); return { saved: !!v.encrypted && v.version === 2, blocked: !!v.blocked, needsReentry: v.version === 1 }; }
  write(value) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, this.file); }
    finally { fs.rmSync(temp, { force: true }); }
  }
  key(create = false) {
    if (!fs.existsSync(this.keyFile) && create) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      try { fs.writeFileSync(this.keyFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    const value = fs.readFileSync(this.keyFile); if (value.length !== 32) throw Error('Invalid local key');
    fs.chmodSync(this.keyFile, 0o600); return value;
  }
  async prepare(input) {
    const value = credentials(input);
    try {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key(true), iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return { version: 2, encrypted: encrypted.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), blocked: false };
    } catch { throw Error('本机登录信息无法保存，请检查文件权限。'); }
  }
  async get() {
    const v = this.read(); if (!v.encrypted || v.blocked) return null;
    if (v.version !== 2) throw Error('旧凭据使用钥匙串，请重新保存平台账号密码；不会读取钥匙串。');
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key(), Buffer.from(v.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(v.tag, 'base64'));
      return credentials(JSON.parse(Buffer.concat([decipher.update(Buffer.from(v.encrypted, 'base64')), decipher.final()]).toString('utf8')));
    } catch { throw Error('无法读取本机登录信息，请重新保存。'); }
  }
  block() { const value = this.read(); if (value.encrypted) this.write({ ...value, blocked: true }); }
  remove() { fs.rmSync(this.file, { force: true }); fs.rmSync(this.keyFile, { force: true }); return { saved: false, blocked: false, needsReentry: false }; }
}
module.exports = { BastionAuth, credentials };
