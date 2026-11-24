'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { validate, validateIcon } = require('./core.cjs');
const MAX_PNG = 2 * 1024 * 1024;
class AppIcons {
  constructor(getStore, nativeImage) { this.getStore = getStore; this.nativeImage = nativeImage; this.pending = new Map(); }
  expire() { for (const [token, item] of this.pending) if (Date.now() - item.created > 30 * 60 * 1000 || item.store !== this.getStore()) this.pending.delete(token); }
  stage(file, targetStore = this.getStore()) {
    this.expire();
    if (targetStore !== this.getStore()) throw Error('工作区已切换，请重新选择图标');
    if (!['.png', '.jpg', '.jpeg'].includes(path.extname(file).toLowerCase())) throw Error('图标支持 PNG、JPG 和 JPEG 图片');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw Error('请选择不超过 10 MB 的图标图片');
    const bytes = fs.readFileSync(file), image = this.nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw Error('无法读取图标，请使用有效的 PNG 或 JPEG 图片');
    const { width, height } = image.getSize();
    if (width < 16 || height < 16 || width > 4096 || height > 4096) throw Error('图标宽高需在 16 到 4096 像素之间');
    const ratio = Math.min(1, 512 / Math.max(width, height));
    const png = image.resize({ width: Math.round(width * ratio), height: Math.round(height * ratio), quality: 'best' }).toPNG();
    if (png.length > MAX_PNG) throw Error('图标内容过大，请换一张较小的图片');
    if (this.pending.size >= 20) throw Error('待保存图标过多，请先完成或取消编辑');
    const token = crypto.randomUUID(), name = path.basename(file).slice(0, 300);
    this.pending.set(token, { store: targetStore, bytes: png, name, created: Date.now() });
    return { token, name, dataUrl: 'data:image/png;base64,' + png.toString('base64') };
  }
  discard(token) { this.pending.delete(token); }
  previews(state) {
    const store = this.getStore(), result = {};
    for (const pkg of state.packages) {
      if (!pkg.icon) continue;
      try {
        validateIcon(pkg.icon);
        const file = store.resolveFile(pkg.icon.path);
        if (fs.statSync(file).size > MAX_PNG) continue;
        const bytes = fs.readFileSync(file);
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) continue;
        const image = this.nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) continue;
        const size = image.getSize(); if (size.width > 512 || size.height > 512) continue;
        result[pkg.id] = 'data:image/png;base64,' + bytes.toString('base64');
      } catch { /* A missing icon must not stop the rest of the workspace loading. */ }
    }
    return result;
  }
  save(input, drafts = []) {
    this.expire();
    const store = this.getStore(), state = structuredClone(input); delete state.__icons;
    validate(state);
    if (!Array.isArray(drafts) || drafts.length > 100) throw Error('图标保存请求无效');
    const ids = new Set(), staged = drafts.map(draft => {
      const pkg = state.packages.find(p => p.id === draft?.packageId), item = this.pending.get(draft?.token);
      if (!pkg || !item || item.store !== store || ids.has(pkg.id)) throw Error('图标预览已失效，请重新选择');
      ids.add(pkg.id); return { pkg, item, token: draft.token };
    });
    const current = store.load();
    if (state.revision !== current.revision || state.__baseHash !== current.__baseHash) throw Error('数据已更新，请重新加载后再保存');
    const created = [];
    try {
      if (staged.length) {
        const folder = path.join(store.dir, 'attachments'); fs.mkdirSync(folder, { recursive: true });
        if (fs.lstatSync(folder).isSymbolicLink()) throw Error('附件目录不允许符号链接');
        for (const { pkg, item } of staged) {
          const relative = 'attachments/' + crypto.randomUUID() + '.png', file = path.join(store.dir, relative);
          fs.writeFileSync(file, item.bytes, { flag: 'wx', mode: 0o600 }); created.push(file);
          pkg.icon = { path: relative, name: item.name };
        }
      }
      const saved = store.save(state);
      for (const { token } of staged) this.pending.delete(token);
      return saved;
    } catch (error) { for (const file of created) fs.rmSync(file, { force: true }); throw error; }
  }
}
module.exports = { AppIcons, validateIcon };
