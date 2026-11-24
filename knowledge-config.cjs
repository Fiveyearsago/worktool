'use strict';
function knowledgeURL(value = '') {
  if (typeof value !== 'string' || value.length > 2000 || /[\r\n\0]/.test(value)) throw Error('知识库 Git 仓库地址无效');
  const input = value.trim();
  if (!input) return '';
  if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(input)) return input;
  let url;
  try { url = new URL(input); } catch { throw Error('知识库地址需为 HTTPS 或 SSH Git 地址'); }
  if (!['https:', 'ssh:', 'file:'].includes(url.protocol) || url.password || (url.protocol === 'https:' && url.username) || url.search || url.hash || !url.pathname || url.pathname === '/') throw Error('知识库地址需为 HTTPS 或 SSH Git 地址，不能包含密码或令牌');
  if (url.protocol === 'file:' && (url.host || url.username)) throw Error('本地 Git 地址无效');
  return input;
}
function validateKnowledgeConfig(value) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('知识库配置无效');
  knowledgeURL(value.repo);
}
module.exports = { knowledgeURL, validateKnowledgeConfig };
