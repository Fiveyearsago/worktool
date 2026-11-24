'use strict';
// Opt-in only: uses the user's saved LongCat credential for two synthetic images.
if (process.env.WORKTOOL_LIVE_LONGCAT !== '1') throw Error('Set WORKTOOL_LIVE_LONGCAT=1 to explicitly run paid live image checks.');
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..'), testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'worktool-image-live-'));
let app;
(async () => {
  const env = { ...process.env, HUB_USER_DATA: path.join(testRoot, 'user-data'), HUB_WORKSPACE: path.join(testRoot, 'workspace') }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env, executablePath: process.env.WORKTOOL_EXECUTABLE || require('electron') });
  const page = await app.firstWindow(); await page.getByRole('heading', { name: '工作概览', exact: true }).waitFor();
  const checks = [];
  for (const withApplication of [false, true]) {
    const result = await app.evaluate(async ({ app, BrowserWindow, nativeImage }, { testRoot, withApplication }) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.cjs');
      const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
      const { Store } = require(path.join(app.getAppPath(), 'core.cjs'));
      const { ImportService } = require(path.join(app.getAppPath(), 'import-service.cjs'));
      const { AISettings } = require(path.join(app.getAppPath(), 'ai-settings.cjs'));
      const { LongCatClient } = require(path.join(app.getAppPath(), 'longcat-client.cjs'));
      const { prepareImagesAsync } = require(path.join(app.getAppPath(), 'ai-image.cjs'));
      const fields = [['项目名称', '图文验收项目'], ['项目说明', '用于验证截图自动创建项目'], ['代码仓库', 'https://example.com/demo.git']];
      if (withApplication) fields.push(['应用名', '截图应用'], ['包名', 'com.example.image.demo'], ['分支', 'Release/Images'], ['Flavor', 'global']);
      const window = new BrowserWindow({ show: false, width: 1100, height: 750, webPreferences: { sandbox: true } });
      let bytes, webp;
      try {
        await window.loadURL('data:text/html;charset=utf8,' + encodeURIComponent('<html><body style="background:white;color:#111;padding:35px;font:26px Arial"><h2>项目基本信息</h2><table border="1" cellpadding="12" style="border-collapse:collapse;width:100%">' + fields.map(([key, value]) => '<tr><td>' + key + '</td><td>' + value + '</td></tr>').join('') + '</table></body></html>'));
        await window.webContents.executeJavaScript('document.fonts.ready');
        bytes = (await window.capturePage()).toPNG();
        const dataURL = 'data:image/png;base64,' + bytes.toString('base64');
        webp = await window.webContents.executeJavaScript(`(async()=>{const i=new Image();i.src=${JSON.stringify(dataURL)};await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;c.getContext('2d').drawImage(i,0,0);return c.toDataURL('image/webp');})()`);
      } finally { window.destroy(); }
      const decoded = nativeImage.createFromBuffer(bytes);
      const variants = { png: bytes, jpg: decoded.toJPEG(95), jpeg: decoded.toJPEG(95), webp: Buffer.from(webp.split(',')[1], 'base64') };
      const formats=[];for(const [type,bytes] of Object.entries(variants))formats.push({type,decoded:(await prepareImagesAsync(bytes,{nativeImage,BrowserWindow})).images.length>0});
      const file = path.join(testRoot, withApplication ? 'project-with-application.png' : 'project-only.png'); fs.writeFileSync(file, bytes);
      const store = new Store(path.join(testRoot, withApplication ? 'with-app-workspace' : 'project-only-workspace'));
      const aiClient = new LongCatClient(new AISettings(path.join(os.homedir(), 'Library', 'Application Support', 'WorkTool', 'ai-settings.json')));
      const service = new ImportService(() => store, { aiClient, prepareImages: bytes => prepareImagesAsync(bytes, {nativeImage,BrowserWindow}) });
      const preview = await service.fromFile(file, { mode: 'longcat' });
      const p = preview.project;
      const validProject = p.name === '图文验收项目' && p.description === '用于验证截图自动创建项目' && p.repo === 'https://example.com/demo.git';
      const validApps = withApplication ? preview.records.length === 1 && preview.records[0].applicationId === 'com.example.image.demo' && preview.records[0].branch === 'Release/Images' && preview.records[0].name === '截图应用' && preview.records[0].flavor === 'global' : preview.records.length === 0;
      let saved = false;
      if (validProject && validApps) {
        const result = service.commit(preview.token, { title: p.name, projectName: p.name, projectDescription: p.description, projectRepo: p.repo, records: preview.records.map(x => ({ ...x, selected: true })) });
        const project = result.state.projects.find(x => x.id === result.projectId);
        saved = project.name === p.name && project.description === p.description && project.repo === p.repo && result.added === (withApplication ? 1 : 0);
      }
      return { withApplication, validProject, validApps, saved, project: p, records: preview.records, elapsedMs: preview.elapsedMs, formats, fixture: file };
    }, { testRoot, withApplication });
    checks.push(result);
    fs.writeFileSync(path.join(root, 'validation', 'longcat-live-image-20261113.json'), JSON.stringify({ time: new Date().toISOString(), live: true, passed: checks.length === 2 && checks.every(x => x.validProject && x.validApps && x.saved && x.formats.every(f => f.decoded)), checks, limitations: ['Synthetic screenshots only; user project data was not uploaded or changed.', 'Only PNG was sent to LongCat; JPEG and WebP were decoded locally.', 'Saves used isolated temporary workspaces.'] }, null, 2));
    console.log(JSON.stringify(result));
    assert(result.validProject && result.validApps && result.saved && result.formats.every(f => f.decoded), 'Image extraction and auto-creation must preserve fields');
  }
  await app.close(); app = null;
})().catch(async error => { console.error(error.message); if (app) await app.close().catch(() => {}); process.exitCode = 1; });
