'use strict';
const fs = require('node:fs');
const path = require('node:path');
const markdown = require('./renderer/markdown.js');

function documentLinkTarget(store, documentId, href) {
  const doc = store.load().docs.find(d => d.id === documentId);
  if (!doc || typeof href !== 'string' || !markdown.links(doc.content).includes(href)) throw Error('文档链接不存在，请重新打开文档');
  const kind = markdown.linkKind(href);
  if (kind === 'web') return { kind, target: new URL(href).href };
  if (kind !== 'local') throw Error('此链接不能在文档外打开');
  let decoded;
  try { decoded = decodeURIComponent(href); } catch { throw Error('文件链接格式无效'); }
  if (/[\u0000-\u001f\u007f]/.test(decoded) || /^[\\]{2}|^\/\//.test(decoded)) throw Error('文件链接格式无效');
  let target;
  if (path.isAbsolute(decoded)) target = decoded;
  else {
    const file = doc.files?.find(f => f.path === decoded || f.name === decoded || './' + f.name === decoded);
    if (!file) throw Error('未找到关联文件；请使用本机绝对路径或已关联的附件名');
    target = store.resolveFile(file.path);
  }
  if (!fs.existsSync(target)) throw Error('本机未找到此文件，可能来自其他电脑');
  // Reveal files instead of executing a path supplied by imported Markdown.
  return { kind, target: fs.realpathSync(target) };
}
module.exports = { documentLinkTarget };
