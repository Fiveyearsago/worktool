'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vendor/markdown-it.min.js'));
  else root.WorkToolMarkdown = factory(root.markdownit);
})(globalThis, function (MarkdownIt) {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
  const escape = md.utils.escapeHtml;

  function linkKind(href) {
    if (!href || /[\u0000-\u001f\u007f]/.test(href)) return null;
    if (href.startsWith('#')) return 'anchor';
    if (/^https?:\/\//i.test(href)) {
      try { const url = new URL(href); return url.username || url.password ? null : 'web'; } catch { return null; }
    }
    if (/^[a-z]:[\\/]/i.test(href)) return 'local';
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || /^[\\]{2}|^\/\//.test(href)) return null;
    return 'local';
  }
  function linkOpen(href, title) {
    const kind = linkKind(href);
    if (!kind) return '<span class="md-link-text">';
    const hint = title || (kind === 'local' ? '在文件管理器中显示：' + href : href);
    return `<a href="${kind === 'local' ? '#' : escape(href)}" data-action="markdown-link" data-href="${escape(href)}" title="${escape(hint)}">`;
  }
  md.renderer.rules.link_open = (tokens, i) => linkOpen(tokens[i].attrGet('href'), tokens[i].attrGet('title'));
  md.renderer.rules.link_close = (tokens, i) => {
    let depth = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (tokens[j].type === 'link_close') depth++;
      if (tokens[j].type === 'link_open') {
        if (depth-- === 0) return linkKind(tokens[j].attrGet('href')) ? '</a>' : '</span>';
      }
    }
    return '</span>';
  };
  // Images are explicit links, so opening a document never fetches remote content.
  md.renderer.rules.image = (tokens, i) => {
    const token = tokens[i], href = token.attrGet('src'), alt = token.content || '图片';
    return `${linkOpen(href, token.attrGet('title'))}图片：${escape(alt)}${linkKind(href) ? '</a>' : '</span>'}`;
  };
  md.renderer.rules.table_open = () => '<div class="md-table-wrap"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';
  md.core.ruler.after('inline', 'reading_format', state => {
    const seen = new Map();
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i], inline = state.tokens[i + 1];
      if (token.type === 'heading_open' && inline?.type === 'inline') {
        const text = inline.children.filter(t => ['text', 'code_inline', 'image'].includes(t.type)).map(t => t.content).join('');
        const slug = text.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').trim().replace(/\s/g, '-') || 'section';
        const count = seen.get(slug) || 0; seen.set(slug, count + 1);
        token.attrSet('id', 'md-' + slug + (count ? '-' + count : ''));
      }
      if (token.type === 'list_item_open' && state.tokens[i + 2]?.type === 'inline') {
        const child = state.tokens[i + 2].children?.[0];
        const task = child?.type === 'text' && /^\[([ xX])\]\s+/.exec(child.content);
        if (task) {
          child.content = child.content.slice(task[0].length);
          const checkbox = new state.Token('html_inline', '', 0);
          checkbox.content = `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''} aria-label="${task[1] !== ' ' ? '已完成' : '未完成'}"> `;
          state.tokens[i + 2].children.unshift(checkbox);
          token.attrJoin('class', 'md-task');
        }
      }
    }
  });
  function links(source) {
    const result = new Set();
    function visit(tokens) {
      for (const token of tokens) {
        if (token.type === 'link_open' || token.type === 'image') {
          const href = token.attrGet(token.type === 'image' ? 'src' : 'href');
          if (linkKind(href)) result.add(href);
        }
        if (token.children) visit(token.children);
      }
    }
    visit(md.parse(String(source || ''), {}));
    return [...result];
  }
  return { render: source => md.render(String(source || '')), links, linkKind };
});
