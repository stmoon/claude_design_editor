// Claude Design Editor. The deck itself renders in two same-origin iframes -
// one stage, one thumbnail rail - so it keeps its own CSS and prints unchanged.
// The editor never re-implements the deck's look; it only rearranges its DOM.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const bar = document.querySelector('.bar');
  const stage = $('stage'), rail = $('rail'), fileInput = $('file');
  const statusEl = $('status');

  // Wrappers from hand-written decks that the layout model replaces.
  const UNWRAP = '.cols, .cols-fig, .col-text, .fig-stack, .cde-text, .cde-media';
  const LAYOUTS = ['bottom', 'right', 'left', 'top', 'text', 'media'];

  let cfg = null, deckName = '', current = 0, dirty = false;
  let lastMtime = 0, saveTimer = null, pendingInsert = null;

  const deckUrl = (name) => '/deck/' + encodeURIComponent(name);
  const sdoc = () => stage.contentDocument;
  const rdoc = () => rail.contentDocument;
  const slides = (doc) => [...doc.querySelectorAll(cfg.slide)];

  function say(text, tone) {
    statusEl.textContent = text;
    if (tone) statusEl.dataset.tone = tone; else delete statusEl.dataset.tone;
  }

  function markDirty() {
    dirty = true;
    say('수정됨 - 저장 대기', 'warn');
    clearTimeout(saveTimer);
    if ($('autosave').checked) saveTimer = setTimeout(() => save(), 1200);
    syncRailSoon();
  }

  // --- boot -------------------------------------------------------------
  async function boot() {
    cfg = await (await fetch('/_config')).json();
    $('autosave').checked = cfg.autosave !== false;
    const { files } = await (await fetch('/_files')).json();
    const sel = $('deck');
    files.forEach((f) => sel.add(new Option(f, f)));
    deckName = cfg.deck && files.includes(cfg.deck) ? cfg.deck : files[0];
    sel.value = deckName;
    sel.addEventListener('change', () => {
      if (dirty && !confirm('저장하지 않은 변경이 있다. 버릴까?')) {
        sel.value = deckName; return;
      }
      deckName = sel.value; dirty = false; current = 0; load();
    });
    load();
    setInterval(pollFile, 2000);
  }

  function load() {
    stage.src = deckUrl(deckName);
    rail.src = deckUrl(deckName);
    stage.onload = initStage;
    rail.onload = initRail;
  }

  // --- stage ------------------------------------------------------------
  function initStage() {
    const doc = sdoc();
    doc.documentElement.dataset.cde = 'stage';
    doc.documentElement.dataset.cdeEdit = '';
    injectChrome(doc);
    ensureLayoutLink(doc);
    // Any in-deck editor would fight over the same keys and save a half-edited
    // document. Drop its chrome and swallow its shortcuts.
    doc.querySelectorAll('[data-edit-ui]').forEach((el) => el.remove());
    doc.addEventListener('keydown', (e) => {
      if (!e.target.isContentEditable && 'eEsS'.includes(e.key)) e.stopImmediatePropagation();
    }, true);

    slides(doc).forEach((s, i) => { s.dataset.cdeSlide = String(i); });
    slides(doc).forEach((s) => normalize(s));
    select(Math.min(current, slides(doc).length - 1));

    doc.querySelectorAll(cfg.editable).forEach((el) => el.setAttribute('contenteditable', 'true'));
    doc.addEventListener('input', (e) => { if (e.target.isContentEditable) markDirty(); });
    doc.defaultView.addEventListener('resize', fit);
    new ResizeObserver(fit).observe(document.getElementById('stagePane'));
    fetch('/_stat?path=' + encodeURIComponent(deckName))
      .then((r) => r.json()).then((s) => { lastMtime = s.mtime; });
    say('준비됨', 'ok');
  }

  function injectChrome(doc) {
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/_app/cde-chrome.css';
    link.setAttribute('data-cde-ui', '');
    doc.head.appendChild(link);
  }

  // The persistent half of the styling has to live in the saved file too.
  function ensureLayoutLink(doc) {
    if (doc.querySelector('link[href$="cde-layout.css"]')) return;
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'cde-layout.css';
    doc.head.appendChild(link);
  }

  // --- layout model ------------------------------------------------------
  // A body is split into exactly two areas: .cde-text and .cde-media.
  function collect(body) {
    const media = [], text = [];
    (function walk(node) {
      for (const el of [...node.children]) {
        if (el.hasAttribute('data-cde-ui')) continue;
        if (el.matches(cfg.media)) { media.push(el); continue; }
        if (el.matches(UNWRAP) || el.querySelector(cfg.media)) { walk(el); continue; }
        text.push(el);
      }
    })(body);
    return { media, text };
  }

  function guessLayout(body) {
    if (body.querySelector('.cols-fig.flip, .cols.flip')) return 'left';
    if (body.querySelector('.cols-fig, .cols')) return 'right';
    return 'bottom';
  }

  function normalize(slide, layout) {
    const body = slide.querySelector(cfg.body);
    if (!body) return;
    const name = layout || body.dataset.cdeLayout || guessLayout(body);
    const { media, text } = collect(body);
    const doc = slide.ownerDocument;

    const textBox = doc.createElement('div');
    textBox.className = 'cde-text';
    text.forEach((el) => textBox.appendChild(el));
    const mediaBox = doc.createElement('div');
    mediaBox.className = 'cde-media';
    media.forEach((el) => mediaBox.appendChild(el));

    body.replaceChildren(textBox, mediaBox);
    body.dataset.cdeLayout = media.length ? name : 'text';
    if (!body.style.getPropertyValue('--cde-cols')) {
      body.style.setProperty('--cde-cols', String(media.length > 1 ? 2 : 1));
    }
    mediaBox.style.setProperty('--cde-cols', body.style.getPropertyValue('--cde-cols'));
  }

  function currentSlide() { return slides(sdoc())[current] || null; }
  function currentBody() { return currentSlide()?.querySelector(cfg.body) || null; }

  function select(index) {
    const doc = sdoc();
    const list = slides(doc);
    if (!list.length) return;
    current = Math.max(0, Math.min(index, list.length - 1));
    list.forEach((s, i) => s.toggleAttribute('data-cde-current', i === current));
    const rl = rdoc() && slides(rdoc());
    if (rl) rl.forEach((s, i) => s.toggleAttribute('data-cde-current', i === current));
    rl?.[current]?.parentElement?.scrollIntoView({ block: 'nearest' });
    fit();
    mountTools();
    syncToolbar();
  }

  // The deck's own pixel size. Falls back when its stylesheet has not landed
  // yet, or when a deck sizes slides from the viewport instead of fixed px.
  function slideSize(el) {
    const w = el.offsetWidth, h = el.offsetHeight;
    if (w >= 640 && h >= 360) return { w, h };
    return { w: cfg.slideWidth || 1920, h: cfg.slideHeight || 1080 };
  }

  function fit() {
    const slide = currentSlide();
    if (!slide) return;
    const doc = sdoc();
    const pane = document.getElementById('stagePane').getBoundingClientRect();
    const { w, h } = slideSize(slide);
    const k = Math.min((pane.width - 48) / w, (pane.height - 48) / h);
    doc.documentElement.style.setProperty('--cde-scale', String(k));
    placeHandle();
  }

  // --- in-slide split handle ---------------------------------------------
  function placeHandle() {
    const doc = sdoc();
    const body = currentBody();
    const name = body?.dataset.cdeLayout;
    if (!body || !['bottom', 'top', 'left', 'right'].includes(name)) {
      doc.querySelectorAll('.cde-handle').forEach((el) => el.remove());
      return;
    }
    const [first, second] = [...body.children]
      .filter((el) => !el.classList.contains('cde-handle'))
      .sort((a, b) => (getComputedStyle(a).order | 0) - (getComputedStyle(b).order | 0));
    if (!first || !second) return;

    const axis = (name === 'left' || name === 'right') ? 'x' : 'y';
    // Reused across moves: rebuilding mid-drag would drop the live listeners.
    let handle = body.querySelector(':scope > .cde-handle');
    if (!handle) {
      doc.querySelectorAll('.cde-handle').forEach((el) => el.remove());
      handle = doc.createElement('div');
      handle.className = 'cde-handle';
      handle.setAttribute('data-cde-ui', '');
      handle.addEventListener('pointerdown', startDrag);
      body.appendChild(handle);
    }
    handle.dataset.cdeAxis = axis;

    const bb = body.getBoundingClientRect();
    const fb = first.getBoundingClientRect(), sb = second.getBoundingClientRect();
    const scale = parseFloat(doc.documentElement.style.getPropertyValue('--cde-scale')) || 1;
    if (axis === 'x') {
      const mid = (fb.right + sb.left) / 2;
      handle.style.cssText = `left:${(mid - bb.left) / scale - 13}px;top:0;height:100%;width:26px`;
    } else {
      const mid = (fb.bottom + sb.top) / 2;
      handle.style.cssText = `top:${(mid - bb.top) / scale - 13}px;left:0;width:100%;height:26px`;
    }
  }

  function startDrag(e) {
    e.preventDefault();
    const handle = e.currentTarget;
    const body = currentBody();
    if (!body) return;
    const doc = handle.ownerDocument;
    // Capture keeps a real pointer glued to the handle; synthetic events have
    // no active pointer, so a failure here is not fatal.
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    handle.dataset.cdeDrag = '';
    const axis = handle.dataset.cdeAxis;

    // Listeners sit on the document so the drag survives leaving the handle.
    const move = (ev) => {
      const bb = body.getBoundingClientRect();
      const raw = axis === 'x'
        ? (ev.clientX - bb.left) / bb.width
        : (ev.clientY - bb.top) / bb.height;
      body.style.setProperty('--cde-a', Math.max(12, Math.min(88, raw * 100)).toFixed(1) + '%');
      placeHandle();
    };
    const up = () => {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
      delete handle.dataset.cdeDrag;
      markDirty();
    };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
  }

  // --- figure tools -------------------------------------------------------
  function mountTools() {
    const doc = sdoc();
    doc.querySelectorAll('.cde-plus, .cde-del').forEach((el) => el.remove());
    const box = currentBody()?.querySelector('.cde-media');
    if (!box) return;
    [...box.children].forEach((item, index) => {
      if (item.hasAttribute('data-cde-ui')) return;
      [['left', '+'], ['right', '+'], ['top', '+'], ['bottom', '+']].forEach(([side, glyph]) => {
        const b = doc.createElement('button');
        b.type = 'button'; b.className = 'cde-plus'; b.textContent = glyph;
        b.dataset.cdeSide = side;
        b.setAttribute('data-cde-ui', '');
        b.title = { left: '왼쪽에 그림 추가', right: '오른쪽에 그림 추가',
                    top: '위에 그림 추가', bottom: '아래에 그림 추가' }[side];
        b.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          askImage(index, side);
        });
        item.appendChild(b);
      });
      const del = doc.createElement('button');
      del.type = 'button'; del.className = 'cde-del'; del.textContent = '×';
      del.title = '이 그림 삭제';
      del.setAttribute('data-cde-ui', '');
      del.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        item.remove();
        normalize(currentSlide(), currentBody().dataset.cdeLayout);
        select(current); markDirty();
      });
      item.appendChild(del);
    });
  }

  function askImage(index, side) {
    pendingInsert = { index, side };
    fileInput.value = '';
    fileInput.click();
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const res = await fetch('/_upload?name=' + encodeURIComponent(file.name),
                            { method: 'POST', body: file });
    if (!res.ok) { say('업로드 실패', 'bad'); return; }
    const { src } = await res.json();
    insertImage(src, file.name);
  });

  function insertImage(src, alt) {
    const doc = sdoc();
    const body = currentBody();
    if (!body) return;
    let box = body.querySelector('.cde-media');
    if (!box) { normalize(currentSlide(), 'bottom'); box = currentBody().querySelector('.cde-media'); }

    const fig = doc.createElement('figure');
    fig.className = 'fig';
    const frame = doc.createElement('span');
    frame.className = 'frame';
    const img = doc.createElement('img');
    img.src = src; img.alt = alt || '';
    frame.appendChild(img); fig.appendChild(frame);

    const items = [...box.children].filter((el) => !el.hasAttribute('data-cde-ui'));
    let cols = Number(box.style.getPropertyValue('--cde-cols')) || 1;
    const where = pendingInsert;
    let at = items.length;
    if (where) {
      const i = where.index;
      if (where.side === 'left') at = i;
      if (where.side === 'right') at = i + 1;
      if (where.side === 'top') at = Math.max(0, i - cols);
      if (where.side === 'bottom') at = Math.min(items.length, i + cols);
      // A side-by-side insert only reads as side-by-side with a second column.
      if ((where.side === 'left' || where.side === 'right') && cols === 1) cols = 2;
    }
    pendingInsert = null;

    box.insertBefore(fig, items[at] || null);
    setCols(cols);
    if (body.dataset.cdeLayout === 'text') body.dataset.cdeLayout = 'bottom';
    select(current);
    markDirty();
    say('그림 추가 - ' + src, 'ok');
  }

  function setCols(n) {
    const body = currentBody();
    if (!body) return;
    const value = String(Math.max(1, Math.min(6, n)));
    body.style.setProperty('--cde-cols', value);
    body.querySelector('.cde-media')?.style.setProperty('--cde-cols', value);
    $('cols').textContent = value;
  }

  function syncToolbar() {
    const body = currentBody();
    const has = !!body?.querySelector('.cde-media')?.children.length;
    $('layout').value = body?.dataset.cdeLayout || 'text';
    $('layout').disabled = !body;
    $('cols').textContent = body?.style.getPropertyValue('--cde-cols') || '1';
    bar.querySelectorAll('[data-act^="cols"]').forEach((b) => { b.disabled = !has; });
  }

  // --- rail ----------------------------------------------------------------
  function initRail() {
    const doc = rdoc();
    doc.documentElement.dataset.cde = 'rail';
    injectChrome(doc);
    ensureLayoutLink(doc);
    doc.querySelectorAll('[data-edit-ui]').forEach((el) => el.remove());
    slides(doc).forEach((s, i) => { s.dataset.cdeSlide = String(i); });
    slides(doc).forEach((s) => normalize(s));
    layoutRail();
    doc.defaultView.addEventListener('resize', layoutRail);
    new ResizeObserver(layoutRail).observe(document.getElementById('railPane'));
    select(current);
  }

  function layoutRail() {
    const doc = rdoc();
    if (!doc) return;
    const width = doc.documentElement.clientWidth - 24;
    slides(doc).forEach((s, i) => {
      const { w, h } = slideSize(s);
      const k = width / w;
      let thumb = s.parentElement;
      if (!thumb || !thumb.classList.contains('cde-thumb')) {
        thumb = doc.createElement('div');
        thumb.className = 'cde-thumb';
        s.replaceWith(thumb);
        thumb.appendChild(s);
        const no = doc.createElement('span');
        no.className = 'cde-no';
        thumb.appendChild(no);
        thumb.addEventListener('click', () => select(i));
      }
      thumb.querySelector('.cde-no').textContent = String(i + 1);
      thumb.style.width = width + 'px';
      thumb.style.height = Math.round(h * k) + 'px';
      s.style.width = w + 'px';
      s.style.height = h + 'px';
      s.style.transform = `scale(${k})`;
    });
  }

  let railTimer = null;
  function syncRailSoon() {
    clearTimeout(railTimer);
    railTimer = setTimeout(() => {
      const from = currentSlide(), to = rdoc() && slides(rdoc())[current];
      if (!from || !to) return;
      const clone = from.cloneNode(true);
      clone.querySelectorAll('[data-cde-ui]').forEach((el) => el.remove());
      clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
      to.replaceChildren(...clone.childNodes);
      to.dataset.cdeLayout = clone.dataset.cdeLayout || '';
      const body = to.querySelector(cfg.body), src = clone.querySelector(cfg.body);
      if (body && src) { body.dataset.cdeLayout = src.dataset.cdeLayout; body.style.cssText = src.style.cssText; }
      layoutRail();
    }, 250);
  }

  // --- save ------------------------------------------------------------------
  function serialize() {
    const root = sdoc().documentElement.cloneNode(true);
    root.removeAttribute('data-cde');
    root.removeAttribute('data-cde-edit');
    root.removeAttribute('style');
    root.querySelectorAll('[data-cde-ui]').forEach((el) => el.remove());
    root.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
    root.querySelectorAll('[data-cde-slide]').forEach((el) => {
      el.removeAttribute('data-cde-slide');
      el.removeAttribute('data-cde-current');
      el.removeAttribute('style');
    });
    return '<!DOCTYPE html>\n' + root.outerHTML + '\n';
  }

  async function save() {
    clearTimeout(saveTimer);
    if (!sdoc()) return;
    try {
      const res = await fetch(deckUrl(deckName), {
        method: 'PUT',
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: serialize(),
      });
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      const info = await res.json();
      lastMtime = info.mtime; dirty = false;
      say('저장됨 - ' + info.name, 'ok');
    } catch (err) {
      say('저장 실패 - ' + err.message, 'bad');
    }
  }

  async function saveAs() {
    const suggested = deckName.replace(/\.html?$/i, '') + '-copy.html';
    const name = prompt('다른 이름으로 저장 (같은 폴더)', suggested);
    if (!name) return;
    const post = (overwrite) => fetch(
      '/_saveas?name=' + encodeURIComponent(name) + (overwrite ? '&overwrite=1' : ''),
      { method: 'POST', headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: serialize() });
    let res = await post(false);
    if (res.status === 409) {
      if (!confirm(name + ' 이 이미 있다. 덮어쓸까?')) return;
      res = await post(true);
    }
    if (!res.ok) { say('저장 실패', 'bad'); return; }
    const info = await res.json();
    const sel = $('deck');
    if (![...sel.options].some((o) => o.value === info.name)) sel.add(new Option(info.name, info.name));
    deckName = info.name; sel.value = info.name;
    lastMtime = info.mtime; dirty = false;
    say('저장됨 - ' + info.name, 'ok');
  }

  // Someone else edited the file - pick it up unless we have local changes.
  async function pollFile() {
    if (dirty || !deckName) return;
    try {
      const s = await (await fetch('/_stat?path=' + encodeURIComponent(deckName))).json();
      if (lastMtime && s.mtime > lastMtime + 0.001) {
        lastMtime = s.mtime;
        say('파일이 바뀌어 다시 읽음', 'warn');
        load();
      }
    } catch (err) { /* server gone; the next tick retries */ }
  }

  // --- chrome wiring ----------------------------------------------------------
  bar.addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (act === 'save') save();
    if (act === 'saveas') saveAs();
    if (act === 'add') askImage(null, null);
    if (act === 'cols+') { setCols(Number($('cols').textContent) + 1); markDirty(); }
    if (act === 'cols-') { setCols(Number($('cols').textContent) - 1); markDirty(); }
  });

  $('layout').addEventListener('change', (e) => {
    const slide = currentSlide();
    if (!slide) return;
    sdoc().querySelectorAll('.cde-handle').forEach((el) => el.remove());
    normalize(slide, e.target.value);
    currentBody().style.removeProperty('--cde-a');
    select(current);
    markDirty();
  });

  // Rail/stage splitter.
  (() => {
    const grip = $('grip');
    grip.addEventListener('pointerdown', (e) => {
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      document.body.classList.add('dragging');
      const move = (ev) => {
        const w = Math.max(150, Math.min(window.innerWidth * 0.6, ev.clientX));
        document.documentElement.style.setProperty('--rail-w', w + 'px');
        layoutRail();
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.body.classList.remove('dragging');
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  })();

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'PageDown' || e.key === 'ArrowDown') { e.preventDefault(); select(current + 1); }
    if (e.key === 'PageUp' || e.key === 'ArrowUp') { e.preventDefault(); select(current - 1); }
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  boot();
})();
