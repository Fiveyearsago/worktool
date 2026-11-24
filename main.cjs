'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, clipboard, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Store, gitStatus, gitSync, syncPlan } = require('./core.cjs');
const { ImportService, extensions: importExtensions } = require('./import-service.cjs');
const { AISettings } = require('./ai-settings.cjs');
const { LongCatClient } = require('./longcat-client.cjs');
const { prepareImagesAsync } = require('./ai-image.cjs');
const { KnowledgeRepository } = require('./knowledge-repository.cjs');
const { BastionService } = require('./bastion-service.cjs');
const { BastionPortal } = require('./bastion-portal.cjs');
const { BastionAuth } = require('./bastion-auth.cjs');
const { openRemoteDesktop } = require('./remote-desktop.cjs');
const { documentLinkTarget } = require('./document-links.cjs');
const { AppIcons } = require('./app-icons.cjs');
let importer, store, win, configFile, bastionPortal;
const operations = new Map();
app.setName('WorkTool');
if (process.env.HUB_USER_DATA) {
  fs.mkdirSync(process.env.HUB_USER_DATA, { recursive: true });
  app.setPath('userData', path.resolve(process.env.HUB_USER_DATA));
}
function allowed(e) {
  if (e.sender !== win.webContents || e.senderFrame !== win.webContents.mainFrame) throw Error('非法调用');
}
async function importOperation(options, run) {
  const mode = options?.mode || 'local';
  if (!['local', 'longcat'].includes(mode)) throw Error('识别方式无效');
  const requestId = options?.requestId;
  if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length > 100 || operations.has(requestId))) throw Error('无效的识别请求');
  if (operations.size >= 3) throw Error('请等待已有识别完成');
  const controller = new AbortController();
  if (requestId) operations.set(requestId, controller);
  try { return await run({ mode, signal: controller.signal }); }
  finally { if (requestId) operations.delete(requestId); }
}
app.whenReady().then(() => {
  configFile = path.join(app.getPath('userData'), 'settings.json');
  let dir = path.join(app.getPath('userData'), 'workspace');
  if (fs.existsSync(configFile)) dir = JSON.parse(fs.readFileSync(configFile)).workspace;
  store = new Store(process.env.HUB_WORKSPACE || dir);
  const knowledge = new KnowledgeRepository(() => store, app.getPath('userData'));
  const icons = new AppIcons(() => store, nativeImage);
  const withKnowledge = async state => ({ ...state, __knowledge: await knowledge.refresh(state), __icons: icons.previews(state) });
  const aiSettings = new AISettings(path.join(app.getPath('userData'), 'ai-settings.json'));
  const aiClient = new LongCatClient(aiSettings);
  importer = new ImportService(() => store, {
    nativeExecutable: app.isPackaged ? path.join(process.resourcesPath, 'native', 'worktool-extract') : path.join(__dirname, 'native', 'worktool-extract'),
    aiClient, prepareImages: bytes => prepareImagesAsync(bytes, {nativeImage,BrowserWindow})
  });
  win = new BrowserWindow({ width: 1360, height: 900, minWidth: 900, minHeight: 640, title: 'WorkTool', backgroundColor: '#f5f7fb', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.loadFile('renderer/index.html');
  const bastionAuth = new BastionAuth(path.join(app.getPath('userData'), 'bastion-auth.json'));
  bastionPortal = new BastionPortal({ BrowserWindow, session, auth: bastionAuth }, win);
  const bastion = new BastionService(() => store, bastionPortal, { openDesktop: ip => openRemoteDesktop(ip, { directory: path.join(app.getPath('userData'), 'remote-desktop'), helper: app.isPackaged ? path.join(process.resourcesPath, 'native', 'worktool-connect') : path.join(__dirname, 'native', 'worktool-connect') }) });
  win.on('closed', () => bastionPortal.dispose());
  const handlers = {
    pickAppIcon: async () => {
      const targetStore = store;
      const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: '应用 Icon（PNG / JPEG）', extensions: ['png', 'jpg', 'jpeg'] }] });
      if (result.canceled) return null;
      return icons.stage(result.filePaths[0], targetStore);
    },
    discardAppIcon: (_e, token) => icons.discard(token),
    documentOpenLink: async (_e, documentId, href) => {
      const link = documentLinkTarget(store, documentId, href);
      if (link.kind === 'web') await shell.openExternal(link.target);
      else shell.showItemInFolder(link.target);
    },
    bastionStatus: (_e, packageId) => bastion.status(packageId),
    bastionStart: (_e, packageId) => bastion.start(packageId),
    bastionOpen: (_e, packageId) => bastion.open(packageId),
    bastionConnect: (_e, packageId) => bastion.connect(packageId),
    bastionAccessibility: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'),
    bastionAuthStatus: () => bastionAuth.status(),
    bastionAuthSave: (_e, input) => bastionPortal.saveLogin(input),
    bastionAuthRemove: () => bastionPortal.removeLogin(),
    bastionAuthRefresh: () => bastionPortal.refreshLogin(),
    aiStatus: () => aiSettings.status(),
    aiSave: (_e, input) => aiSettings.save(input),
    aiTest: () => aiClient.test(),
    importChoose: (_e, options) => importOperation(options, async opts => {
      const current = store;
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: options?.imagesOnly ? '项目截图' : '项目资料', extensions: options?.imagesOnly ? ['png','jpg','jpeg','webp'] : importExtensions }] });
      if (r.canceled) return null;
      if (current !== store) throw Error('工作区已切换，请重新导入');
      if (opts.mode === 'longcat') opts.signal.throwIfAborted();
      const result = await importer.fromFile(r.filePaths[0], opts);
      if (current !== store) { importer.discard(result.token); throw Error('工作区已切换，请重新导入'); }
      return result;
    }),
    importPath: (_e, file, options) => importOperation(options, opts => {
      if(typeof file !== 'string' || !path.isAbsolute(file)) throw Error('拖入文件路径无效');
      return importer.fromFile(file, opts);
    }),
    importClipboard: (_e, options) => importOperation({ ...options, mode: 'longcat' }, async opts => {
      const current = store;
      const items = await clipboard.read();
      opts.signal.throwIfAborted();
      // Electron exposes native screenshot formats (including macOS TIFF) as PNG.
      const item = items.find(item => item.types.includes('image/png')) || items.find(item => item.types.includes('image/jpeg'));
      if (!item) throw Error('剪贴板中没有图片，请先复制截图');
      const blob = await item.getType(item.types.includes('image/png') ? 'image/png' : 'image/jpeg');
      if (blob.size > 20 * 1024 * 1024) throw Error('图片超过 20 MB，请裁剪后重试');
      const bytes = Buffer.from(await blob.arrayBuffer());
      opts.signal.throwIfAborted();
      if (current !== store) throw Error('工作区已切换，请重新导入');
      const image = nativeImage.createFromBuffer(bytes);
      if(image.isEmpty()) throw Error('剪贴板中没有图片，请先复制截图');
      return importer.fromImage(image.toPNG(), opts);
    }),
    importText: (_e, text, options) => importOperation(options, opts => importer.fromText(text, opts)),
    importReparse: (_e, token, text, options) => importOperation(options, opts => opts.mode === 'longcat' ? importer.reparseAI(token, text, opts) : importer.reparse(token, text)),
    importUpdateText: (_e, token, text) => importer.updateText(token, text),
    importCancel: (_e, requestId) => { operations.get(requestId)?.abort(); },
    importDiscard: (_e, token) => importer.discard(token),
    importCommit: async (_e, token, input) => { const result = importer.commit(token, input); result.state = await withKnowledge(result.state); return result; },
    load: () => withKnowledge(store.load()), save: (_e, s, drafts) => withKnowledge(icons.save(s, drafts)),
    knowledgeConnect: () => knowledge.connect(),
    knowledgeSync: () => knowledge.sync(),
    knowledgeStatus: () => knowledge.status(),
    knowledgeOpen: async () => { const status = knowledge.status(); if (!status.connected) throw Error('请先连接知识库'); const result = await shell.openPath(status.directory); if (result) throw Error(result); },
    pickFile: async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: '文档和图片（请勿导入秘密）', extensions: ['md', 'txt', 'pdf', 'png', 'jpg', 'jpeg', 'webp', 'csv'] }] });
      return r.canceled ? null : store.importFile(r.filePaths[0]);
    },
    openFile: async (_e, p) => { const result = await shell.openPath(store.resolveFile(p)); if (result) throw Error(result); },
    openUrl: async (_e, u) => {
      const url = new URL(u); if (url.protocol !== 'https:' || url.username || url.password) throw Error('只允许 HTTPS 链接');
      await shell.openExternal(url.href);
    },
    gitStatus: () => gitStatus(store.dir),
    gitSync: async () => {
      const targetStore = store, plan = syncPlan(targetStore.dir);
      const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['取消', '确认同步'], defaultId: 0, cancelId: 0, message: '同步会连接当前仓库远端，并推送已提交内容。请确认没有秘密或未经允许的公司资料。', detail: '推送地址：' + plan.pushUrl + '\n目标分支：' + plan.ref + '\n提交：' + plan.head + '\n不会自动提交，也不会覆盖冲突。' });
      if (r.response !== 1) return { output: '已取消同步' };
      if (store !== targetStore) throw Error('工作区已改变，请重新确认');
      return gitSync(targetStore.dir, plan);
    },
    chooseWorkspace: async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], message: '选择空目录或已有 WorkTool 工作区' });
      if (r.canceled) return null;
      const next = new Store(r.filePaths[0]);
      for (const controller of operations.values()) controller.abort();
      store = next;
      fs.writeFileSync(configFile, JSON.stringify({ workspace: store.dir }));
      return withKnowledge(store.load());
    }
  };
  for (const [k, fn] of Object.entries(handlers)) ipcMain.handle('hub:' + k, (e, ...args) => { allowed(e); return fn(e, ...args); });
}).catch(e => { dialog.showErrorBox('启动失败', e.message); app.quit(); });
app.on('before-quit', () => bastionPortal?.dispose());
app.on('activate', () => {
  if (win && !win.isDestroyed() && !BrowserWindow.getAllWindows().some(w => w.isVisible())) { win.show(); win.focus(); }
});
app.on('window-all-closed', () => { for (const controller of operations.values()) controller.abort(); app.quit(); });
