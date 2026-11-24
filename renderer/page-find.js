'use strict';
// Only rendered page text is searched. Queries stay in memory and are never sent
// to the main process, saved with workspace data, or interpolated as HTML.
const PageFind = (() => {
  let key = '', term = '', marks = [], current = -1, observer, root, timer;
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function toolbar(nextKey) {
    if (key !== nextKey) { key = nextKey; term = ''; current = -1; }
    return `<div class="page-find" role="search" aria-label="本页搜索"><label class="page-find-input"><span aria-hidden="true">⌕</span><input id="page-find" type="search" autocomplete="off" spellcheck="false" maxlength="200" aria-label="搜索本页内容" placeholder="搜索本页内容…" value="${escape(term)}"><kbd>⌘F</kbd></label><span id="page-find-count" role="status" aria-live="polite"></span><button class="find-control" data-action="page-find-prev" aria-label="上一个匹配" title="上一个（Shift+Enter）">↑</button><button class="find-control" data-action="page-find-next" aria-label="下一个匹配" title="下一个（Enter）">↓</button><button class="find-control" data-action="page-find-clear" aria-label="清除本页搜索" title="清除（Esc）">×</button></div>`;
  }
  function disconnect() { observer?.disconnect(); clearTimeout(timer); }
  function watch() {
    if (!root) return;
    observer ||= new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => apply(false), 60);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  }
  function updateCount() {
    const count = document.querySelector('#page-find-count');
    if (!count) return;
    count.textContent = term ? marks.length ? `${current + 1} / ${marks.length}` : '无匹配' : '';
    document.querySelectorAll('[data-action="page-find-prev"],[data-action="page-find-next"]').forEach(button => button.disabled = !marks.length);
    document.querySelector('[data-action="page-find-clear"]').disabled = !term;
  }
  function select(index, scroll) {
    marks[current]?.classList.remove('current-match');
    current = marks.length ? (index + marks.length) % marks.length : -1;
    const active = marks[current];
    active?.classList.add('current-match');
    if (scroll && active) active.scrollIntoView({ block: 'center', behavior: 'auto' });
    updateCount();
  }
  function apply(scroll = false) {
    disconnect();
    if (!root?.isConnected) return;
    const previous = current;
    for (const mark of root.querySelectorAll('mark.page-match')) {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent));
      parent.normalize();
    }
    marks = []; current = -1;
    const needle = term.trim();
    for (const task of root.querySelectorAll('.task')) {
      const body = task.querySelector('.task-body');
      task.classList.toggle('search-expanded', !!needle && !!body && body.textContent.toLocaleLowerCase().includes(needle.toLocaleLowerCase()));
    }
    if (needle) {
      const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!node.textContent.trim() || !parent || parent.closest('script,style,textarea,input,select,option,[hidden],[aria-hidden="true"],[data-find-ignore]') || !parent.getClientRects().length) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        const matches = [...node.textContent.matchAll(pattern)];
        if (!matches.length) continue;
        const fragment = document.createDocumentFragment(); let offset = 0;
        for (const match of matches) {
          fragment.append(document.createTextNode(node.textContent.slice(offset, match.index)));
          const mark = document.createElement('mark'); mark.className = 'page-match'; mark.textContent = match[0];
          fragment.append(mark); marks.push(mark); offset = match.index + match[0].length;
        }
        fragment.append(document.createTextNode(node.textContent.slice(offset))); node.replaceWith(fragment);
      }
    }
    select(scroll ? 0 : Math.min(Math.max(previous, 0), marks.length - 1), scroll);
    watch();
  }
  function mount() {
    disconnect(); root = document.querySelector('#content');
    if (!document.querySelector('#page-find')) { term = ''; key = ''; marks = []; current = -1; return; }
    apply(false);
  }
  function input(value) { term = value; current = -1; apply(true); }
  function action(name) {
    if (name === 'page-find-clear') {
      const field = document.querySelector('#page-find'); field.value = ''; input(''); field.focus();
    } else select(current + (name === 'page-find-prev' ? -1 : 1), true);
  }
  function focus() { const field = document.querySelector('#page-find'); if (field) { field.focus(); field.select(); } return !!field; }
  return { toolbar, mount, input, action, focus, refresh: () => apply(false) };
})();
