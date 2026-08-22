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
  const UNWRAP = '.cols, .cols-fig, .col-text, .fig-stack, .cde-text, .cde-media, .cde-col';
  const LAYOUTS = ['bottom', 'right', 'left', 'top', 'quad', 'text', 'media'];
  const notUI = (el) => !el.hasAttribute('data-cde-ui');

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

  function markDirty(msg) {
    dirty = true;
    say(msg || '수정됨 - 저장 대기', 'warn');
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

    // Click picks an item; Del removes it. Text keeps normal editing behaviour,
    // so Esc is what steps out of a block before deleting it.
    doc.addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-cde-ui]')) return;
      selectItem(e.target.closest(DELETABLE));
    });
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { doc.activeElement?.blur?.(); return; }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (doc.activeElement && doc.activeElement.isContentEditable) return;
      const item = doc.querySelector('[data-cde-sel]');
      if (item) { e.preventDefault(); removeItem(item); }
    });
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

  const gridOf = (body) =>
    body.querySelector(':scope > .cols-fig, :scope > .cols, :scope > .cols-wide, :scope > .cols3');
  const isMedia = (el) => el.matches(cfg.media) || !!el.querySelector(cfg.media);

  function guessLayout(body) {
    const grid = gridOf(body);
    // A side-by-side grid only means "text beside media" if it holds a text
    // column. Bullets above a two-figure row are a stack, not a split.
    if (!grid || ![...grid.children].some((c) => !isMedia(c))) return 'bottom';
    return grid.classList.contains('flip') ? 'left' : 'right';
  }

  // Columns come from how the deck already arranged its media, not from a count:
  // a table forced into half a slide is unreadable.
  function guessCols(body) {
    if (body.querySelector('.fig-stack.row')) return '2';
    const grid = gridOf(body);
    if (grid) {
      const n = [...grid.children].filter(isMedia).length;
      if (n >= 2 && ![...grid.children].some((c) => !isMedia(c))) return String(Math.min(n, 3));
    }
    return '1';
  }

  function box(doc, cls, items) {
    const el = doc.createElement('div');
    el.className = cls;
    items.forEach((i) => el.appendChild(i));
    return el;
  }

  function column(doc, texts, media, cols) {
    const col = doc.createElement('div');
    col.className = 'cde-col';
    col.appendChild(box(doc, 'cde-text', texts));
    const m = box(doc, 'cde-media', media);
    m.style.setProperty('--cde-cols', cols);
    col.appendChild(m);
    return col;
  }

  function normalize(slide, layout) {
    const body = slide.querySelector(cfg.body);
    if (!body) return;
    const doc = slide.ownerDocument;
    let name = layout || body.dataset.cdeLayout || guessLayout(body);
    const { media, text } = collect(body);
    const cols = body.style.getPropertyValue('--cde-cols') || guessCols(body);
    if (!media.length && name !== 'text') name = 'text';

    if (name === 'quad') {
      // Two columns, each stacking its own text over its own media.
      const half = (a) => [a.slice(0, Math.ceil(a.length / 2)), a.slice(Math.ceil(a.length / 2))];
      const [t1, t2] = half(text), [m1, m2] = half(media);
      body.replaceChildren(column(doc, t1, m1, cols), column(doc, t2, m2, cols));
    } else {
      const textBox = box(doc, 'cde-text', text);
      const mediaBox = box(doc, 'cde-media', media);
      mediaBox.style.setProperty('--cde-cols', cols);
      body.replaceChildren(textBox, mediaBox);
    }
    body.dataset.cdeLayout = name;
    body.style.setProperty('--cde-cols', cols);
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
    placeHandles();
  }

  // --- in-slide split handles -------------------------------------------
  // A layout can have more than one adjustable boundary; quad has three.
  function splitsOf(body) {
    const name = body.dataset.cdeLayout;
    const kids = (el) => [...el.children].filter(notUI);
    const byOrder = (a, b) => (getComputedStyle(a).order | 0) - (getComputedStyle(b).order | 0);
    const out = [];

    if (['bottom', 'top', 'left', 'right'].includes(name)) {
      const [a, b] = kids(body).sort(byOrder);
      const axis = (name === 'left' || name === 'right') ? 'x' : 'y';
      if (a && b) out.push({ kind: 'ratio', host: body, axis, prop: '--cde-a', a, b });
    } else if (name === 'quad') {
      const cols = kids(body);
      if (cols.length === 2) {
        out.push({ kind: 'ratio', host: body, axis: 'x', prop: '--cde-a', a: cols[0], b: cols[1] });
      }
      cols.forEach((col) => {
        const [a, b] = kids(col);
        if (a && b) out.push({ kind: 'ratio', host: col, axis: 'y', prop: '--cde-row', a, b });
      });
    }

    // Boundaries between the media cells themselves - figure/figure, figure/table.
    body.querySelectorAll('.cde-media').forEach((mbox) => {
      if (kids(mbox).length < 2) return;
      const cs = getComputedStyle(mbox);
      const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length;
      const rows = cs.gridTemplateRows.split(' ').filter(Boolean).length;
      for (let i = 0; i < cols - 1; i++) {
        out.push({ kind: 'track', host: mbox, axis: 'x', prop: '--cde-ctpl', index: i });
      }
      for (let j = 0; j < rows - 1; j++) {
        out.push({ kind: 'track', host: mbox, axis: 'y', prop: '--cde-rtpl', index: j });
      }
    });
    return out;
  }

  // Used track sizes in px, plus the gap between them.
  function tracks(sp) {
    const cs = getComputedStyle(sp.host);
    const list = (sp.axis === 'x' ? cs.gridTemplateColumns : cs.gridTemplateRows)
      .split(' ').filter(Boolean).map(parseFloat);
    const gap = parseFloat(sp.axis === 'x' ? cs.columnGap : cs.rowGap) || 0;
    return { list, gap };
  }

  // Offset of the boundary after track `index`, measured inside the host.
  function boundaryAt(sp) {
    const { list, gap } = tracks(sp);
    let at = 0;
    for (let i = 0; i <= sp.index; i++) at += list[i] + gap;
    return at - gap / 2;
  }

  let splits = [], dragging = false;

  function placeHandles() {
    const doc = sdoc();
    const body = currentBody();
    if (!dragging) splits = body ? splitsOf(body) : [];
    const scale = parseFloat(doc.documentElement.style.getPropertyValue('--cde-scale')) || 1;

    if (!dragging) {
      doc.querySelectorAll('.cde-handle').forEach((el) => el.remove());
      splits.forEach((sp, i) => {
        const h = doc.createElement('div');
        h.className = 'cde-handle';
        h.setAttribute('data-cde-ui', '');
        h.dataset.cdeH = String(i);
        h.dataset.cdeAxis = sp.axis;
        h.addEventListener('pointerdown', startDrag);
        sp.host.appendChild(h);
      });
    }
    splits.forEach((sp, i) => {
      const h = sp.host.querySelector(`:scope > .cde-handle[data-cde-h="${i}"]`);
      if (!h) return;
      let at;
      if (sp.kind === 'track') {
        at = boundaryAt(sp);
      } else {
        const hb = sp.host.getBoundingClientRect();
        const ab = sp.a.getBoundingClientRect(), bb = sp.b.getBoundingClientRect();
        at = sp.axis === 'x'
          ? ((ab.right + bb.left) / 2 - hb.left) / scale
          : ((ab.bottom + bb.top) / 2 - hb.top) / scale;
      }
      h.style.cssText = sp.axis === 'x'
        ? `left:${at - 13}px;top:0;height:100%;width:26px`
        : `top:${at - 13}px;left:0;width:100%;height:26px`;
    });
  }

  const scaleOf = () =>
    parseFloat(sdoc().documentElement.style.getPropertyValue('--cde-scale')) || 1;

  // Move one boundary: the two tracks either side of it trade width, everything
  // else stays put, so the other rows and columns stay aligned.
  function resizeTrack(sp, want) {
    const { list, gap } = tracks(sp);
    const i = sp.index;
    if (list.length < 2) return;
    const before = list.slice(0, i).reduce((a, b) => a + b, 0) + i * gap;
    const pair = list[i] + list[i + 1];
    // Floor scales with the deck so a track never collapses to a sliver.
    const min = Math.min(pair / 2, Math.max(90, list.reduce((a, b) => a + b, 0) * 0.1));
    let first = want - before - gap / 2;
    first = Math.max(min, Math.min(pair - min, first));
    list[i] = first;
    list[i + 1] = pair - first;
    const total = list.reduce((a, b) => a + b, 0) || 1;
    sp.host.style.setProperty(sp.prop,
      list.map((v) => (v / total * list.length).toFixed(4) + 'fr').join(' '));
  }

  function startDrag(e) {
    e.preventDefault();
    const handle = e.currentTarget;
    const sp = splits[Number(handle.dataset.cdeH)];
    if (!sp) return;
    const doc = handle.ownerDocument;
    // Capture keeps a real pointer glued to the handle; synthetic events have
    // no active pointer, so a failure here is not fatal.
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    handle.dataset.cdeDrag = '';
    dragging = true;

    // Listeners sit on the document so the drag survives leaving the handle.
    const move = (ev) => {
      const hb = sp.host.getBoundingClientRect();
      const inner = sp.axis === 'x'
        ? (ev.clientX - hb.left) / (hb.width || 1)
        : (ev.clientY - hb.top) / (hb.height || 1);
      if (sp.kind === 'track') {
        resizeTrack(sp, inner * (sp.axis === 'x' ? hb.width : hb.height) / scaleOf());
      } else {
        sp.host.style.setProperty(sp.prop, Math.max(12, Math.min(88, inner * 100)).toFixed(1) + '%');
      }
      placeHandles();
    };
    const up = () => {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
      delete handle.dataset.cdeDrag;
      dragging = false;
      markDirty();
    };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
  }

  // --- figure tools -------------------------------------------------------
  const DELETABLE = '.cde-media > *, .cde-text > *, .cde-text li';

  // Removing a figure has to undo what adding it did, or the survivor keeps
  // the half-width cell the pair needed.
  function removeItem(item) {
    if (!item || item.hasAttribute('data-cde-ui')) return;
    const mbox = item.parentElement?.closest('.cde-media');
    item.remove();
    if (mbox) {
      // The dragged tracks describe a grid that no longer exists.
      mbox.style.removeProperty('--cde-ctpl');
      mbox.style.removeProperty('--cde-rtpl');
      const left = [...mbox.children].filter(notUI).length;
      const cols = Number(mbox.style.getPropertyValue('--cde-cols')) || 1;
      if (left < cols) setCols(Math.max(1, left));
    }
    const body = currentBody();
    if (body && !body.querySelector('.cde-media > *')) {
      body.style.removeProperty('--cde-a');
      body.querySelectorAll('.cde-col').forEach((c) => c.style.removeProperty('--cde-row'));
    }
    normalize(currentSlide(), body?.dataset.cdeLayout);
    select(current);
    markDirty('삭제됨 - 저장 대기');
  }

  function selectItem(item) {
    sdoc().querySelectorAll('[data-cde-sel]').forEach((el) => el.removeAttribute('data-cde-sel'));
    if (item) item.setAttribute('data-cde-sel', '');
  }

  function delButton(doc, item, small) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'cde-del' + (small ? ' cde-del-sm' : '');
    b.textContent = '\u00d7';
    b.title = '이 항목 삭제 (Del)';
    b.contentEditable = 'false';
    b.setAttribute('data-cde-ui', '');
    b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      removeItem(item);
    });
    item.appendChild(b);
    return b;
  }

  function mountTools() {
    const doc = sdoc();
    doc.querySelectorAll('.cde-plus, .cde-del').forEach((el) => el.remove());
    const body = currentBody();
    if (!body) return;

    body.querySelectorAll('.cde-media').forEach((mbox) => {
      [...mbox.children].filter(notUI).forEach((item, index) => {
        [['left', '왼쪽'], ['right', '오른쪽'], ['top', '위'], ['bottom', '아래']]
          .forEach(([side, label]) => {
            const b = doc.createElement('button');
            b.type = 'button'; b.className = 'cde-plus'; b.textContent = '+';
            b.dataset.cdeSide = side;
            b.title = label + '에 그림 추가';
            b.contentEditable = 'false';
            b.setAttribute('data-cde-ui', '');
            b.addEventListener('click', (e) => {
              e.preventDefault(); e.stopPropagation();
              askImage(mbox, index, side);
            });
            item.appendChild(b);
          });
        delButton(doc, item);
      });
    });

    // Any block, and any bullet, can be removed - not just figures.
    body.querySelectorAll('.cde-text').forEach((tbox) => {
      [...tbox.children].filter(notUI).forEach((item) => delButton(doc, item));
    });
    body.querySelectorAll('.ul > li, .cde-text li').forEach((li) => delButton(doc, li, true));
  }

  function askImage(mbox, index, side) {
    pendingInsert = { mbox, index, side };
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
    const where = pendingInsert;
    pendingInsert = null;

    let mbox = where?.mbox;
    if (!mbox || !body.contains(mbox)) {
      if (!body.querySelector('.cde-media')) normalize(currentSlide(), 'bottom');
      mbox = currentBody().querySelector('.cde-media');
    }

    const fig = doc.createElement('figure');
    fig.className = 'fig';
    const frame = doc.createElement('span');
    frame.className = 'frame';
    const img = doc.createElement('img');
    img.src = src; img.alt = alt || '';
    frame.appendChild(img); fig.appendChild(frame);

    const items = [...mbox.children].filter(notUI);
    let cols = Number(mbox.style.getPropertyValue('--cde-cols')) || 1;
    let at = items.length;
    if (where && where.index !== null) {
      const i = where.index;
      if (where.side === 'left') at = i;
      if (where.side === 'right') at = i + 1;
      if (where.side === 'top') at = Math.max(0, i - cols);
      if (where.side === 'bottom') at = Math.min(items.length, i + cols);
      // A side-by-side insert only reads as side-by-side with a second column.
      if ((where.side === 'left' || where.side === 'right') && cols === 1) cols = 2;
    }

    mbox.insertBefore(fig, items[at] || null);
    setCols(cols);
    if (currentBody().dataset.cdeLayout === 'text') currentBody().dataset.cdeLayout = 'bottom';
    select(current);
    markDirty();
    say('그림 추가 - ' + src, 'ok');
  }

  function setCols(n) {
    const body = currentBody();
    if (!body) return;
    const value = String(Math.max(1, Math.min(6, n)));
    body.style.setProperty('--cde-cols', value);
    body.querySelectorAll('.cde-media').forEach((m) => {
      m.style.setProperty('--cde-cols', value);
      // Hand-dragged tracks no longer match the new grid.
      m.style.removeProperty('--cde-ctpl');
      m.style.removeProperty('--cde-rtpl');
    });
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
    root.querySelectorAll('[data-cde-sel]').forEach((el) => el.removeAttribute('data-cde-sel'));
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
    if (act === 'add') askImage(null, null, null);
    if (act === 'cols+' || act === 'cols-') {
      setCols(Number($('cols').textContent) + (act === 'cols+' ? 1 : -1));
      select(current);
      markDirty();
    }
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
