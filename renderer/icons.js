'use strict';
function applicationIcon(pkg, size = '', preview = state?.__icons?.[pkg.id]) {
  const valid = typeof preview === 'string' && /^data:image\/png;base64,[a-z\d+/=]+$/i.test(preview);
  const label = (pkg.name || pkg.applicationId || '应用') + ' Icon';
  return `<span class="app-icon ${size}" title="${e(valid ? label : pkg.icon ? '图标不可用，请重新选择' : '未设置应用 Icon')}">${valid ? `<img src="${preview}" alt="${e(label)}">` : `<span aria-hidden="true">${e(Array.from(pkg.name || pkg.applicationId || '应')[0])}</span>`}</span>`;
}
function createPackageIconEditor(pkg) {
  let value = pkg.icon || null, draft = null, preview = state?.__icons?.[pkg.id], busy = false, closed = false;
  const discard = token => { if (token && api.discardAppIcon) void api.discardAppIcon(token).catch(() => {}); };
  const dispose = () => { closed = true; discard(draft?.token); draft = null; };
  const editor = {
    html: '<div class="field"><label>应用 Icon</label><div id="package-icon-editor"></div><div class="help">选择 PNG / JPG 图片，保存后显示在应用列表和详情中。</div></div>',
    value() { if (busy) throw Error('请等待图标读取完成'); return value; },
    drafts(packageId) { return draft ? [{ packageId, token: draft.token }] : []; },
    mount() {
      const dialog = $('#modal'), form = $('#editor'), host = $('#package-icon-editor');
      const active = () => !closed && dialog.open && $('#editor') === form;
      function draw() {
        host.innerHTML = `<div class="icon-editor-row">${applicationIcon(pkg, 'large', preview || '')}<div><div class="icon-file-name">${e(draft?.name || value?.name || '尚未选择图标')}</div><div class="actions"><button type="button" id="choose-app-icon" class="btn small" ${busy ? 'disabled' : ''}>${busy ? '读取中…' : value || draft ? '更换图标' : '选择图标'}</button><button type="button" id="remove-app-icon" class="btn small" ${busy || (!value && !draft) ? 'disabled' : ''}>移除图标</button></div></div></div>`;
        $('#choose-app-icon').onclick = async () => {
          if (busy) return; busy = true; draw();
          try {
            const next = await api.pickAppIcon();
            if (!active()) { discard(next?.token); return; }
            if (next) { discard(draft?.token); draft = next; value = null; preview = next.dataUrl; }
          } catch (error) { if (active()) $('#form-error').textContent = error.message || String(error); }
          finally { busy = false; if (active()) draw(); }
        };
        $('#remove-app-icon').onclick = () => { discard(draft?.token); draft = null; value = null; preview = ''; draw(); };
      }
      dialog.addEventListener('close', dispose, { once: true }); draw();
    }
  };
  return editor;
}
