'use strict';
// Exercise Electron's real OS clipboard. Keep the original contents only in memory
// and restore them if the user has not replaced the test clipboard in the meantime.
async function saveClipboard(app) {
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.__clipboardDigest = async items => {
      const hash = process.getBuiltinModule('crypto').createHash('sha256');
      for (const item of items) for (const type of [...item.types].sort()) {
        const value = await item.getType(type);
        hash.update(type);
        hash.update(value instanceof Blob ? Buffer.from(await value.arrayBuffer()) : JSON.stringify(value));
      }
      return hash.digest('hex');
    };
    const saved = [];
    for (const item of await clipboard.read()) {
      const values = {};
      for (const type of item.types) values[type] = await item.getType(type);
      saved.push(new ClipboardItem(values));
    }
    globalThis.__clipboardBackup = saved;
  });
}
async function writeClipboard(app, { file, text, type = 'image/png' }) {
  await app.evaluate(async ({ clipboard, ClipboardItem }, { file, text, type }) => {
    if (file) {
      const bytes = process.getBuiltinModule('fs').readFileSync(file);
      await clipboard.write([new ClipboardItem({ [type]: new Blob([new Uint8Array(bytes)], { type }) })]);
    } else if (text !== undefined) await clipboard.writeText(text);
    else clipboard.clear();
    globalThis.__clipboardOwned = await globalThis.__clipboardDigest(await clipboard.read());
  }, { file, text, type });
}
async function restoreClipboard(app) {
  return app.evaluate(async ({ clipboard }) => {
    if (!globalThis.__clipboardBackup || !globalThis.__clipboardOwned) return 'unchanged';
    const owned = globalThis.__clipboardOwned; globalThis.__clipboardOwned = null;
    if (await globalThis.__clipboardDigest(await clipboard.read()) !== owned) return 'user-changed';
    if (globalThis.__clipboardBackup.length) await clipboard.write(globalThis.__clipboardBackup);
    else clipboard.clear();
    return 'restored';
  });
}
module.exports = { saveClipboard, writeClipboard, restoreClipboard };
