(async () => {
  const MID = __MID__;
  const END = __END__;
  const MAXSCROLL = __MAXSCROLL__;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const listState = () => {
    const c = document.querySelector('bili-comments');
    const sr = c && c.shadowRoot;
    if (!sr) return { ok: false, threads: 0, endText: '', complete: false };
    const end = sr.querySelector('#end');
    const t = end ? (end.innerText || '') : '';
    return { ok: true, threads: sr.querySelectorAll('bili-comment-thread-renderer').length, endText: t.trim().slice(0, 40), complete: t.indexOf(END) >= 0 };
  };
  const deepText = (node) => {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    const tag = (node.tagName || '').toUpperCase();
    if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT') return '';
    let s = '';
    if (node.shadowRoot) s += deepText(node.shadowRoot);
    const kids = node.childNodes || [];
    for (let i = 0; i < kids.length; i++) s += deepText(kids[i]);
    return s;
  };
  try {
    let mountTries = 0;
    for (let i = 0; i < 10; i++) {
      mountTries = i + 1;
      const c = document.querySelector('bili-comments');
      if (c) c.scrollIntoView({ block: 'start' });
      await pause(900);
      const st = listState();
      if (st.ok && st.threads > 0) break;
    }
    let state = listState();
    let loops = 0;
    let last = -1;
    for (let i = 0; i < MAXSCROLL; i++) {
      loops = i + 1;
      window.scrollBy(0, 900);
      await pause(1200);
      state = listState();
      if (state.complete) break;
      const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 5;
      if (state.threads === last && atBottom) break;
      last = state.threads;
    }
    const c = document.querySelector('bili-comments');
    const sr = c && c.shadowRoot;
    const threads = sr ? Array.from(sr.querySelectorAll('bili-comment-thread-renderer')) : [];
    const mine = [];
    for (let ti = 0; ti < threads.length; ti++) {
      const th = threads[ti];
      if (!th.shadowRoot) continue;
      const rends = Array.from(th.shadowRoot.querySelectorAll('bili-comment-renderer'));
      for (const r of rends) {
        let hit = false;
        const scan = (root) => {
          if (!root) return;
          for (const el of root.querySelectorAll('*')) {
            if (el.id === 'user-avatar' && el.getAttribute('data-user-profile-id') === MID) hit = true;
            if (el.shadowRoot) scan(el.shadowRoot);
          }
        };
        scan(r);
        scan(r.shadowRoot);
        if (hit) {
          const txt = deepText(r).replace(/\s+/g, ' ').trim();
          mine.push({ length: txt.length, head: txt.slice(0, 40), has_quark: txt.indexOf('pan.quark.cn') >= 0, has_baidu: txt.indexOf('pan.baidu.com') >= 0 });
        }
      }
    }
    return { ok: true, url: location.href, mount_tries: mountTries, scroll_loops: loops, complete: state.complete === true, threads: threads.length, end_text: state.endText, mine: mine };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) };
  }
})()