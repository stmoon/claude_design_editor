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
  // Each layout, with the regions its icon draws: [kind, x, y, w, h] in a 48x28 box.
  const LAYOUTS = [
    ['bottom', '글 위 · 그림 아래',  [['t', 3, 3, 42, 8], ['m', 3, 14, 42, 11]]],
    ['right',  '글 왼쪽 · 그림 오른쪽', [['t', 3, 3, 19, 22], ['m', 25, 3, 20, 22]]],
    ['left',   '그림 왼쪽 · 글 오른쪽', [['m', 3, 3, 20, 22], ['t', 26, 3, 19, 22]]],
    ['top',    '그림 위 · 글 아래',  [['m', 3, 3, 42, 11], ['t', 3, 17, 42, 8]]],
    ['quad',   '2단 · 각 단 글 위 그림 아래',
     [['t', 3, 3, 19, 7], ['m', 3, 12, 19, 13], ['t', 26, 3, 19, 7], ['m', 26, 12, 19, 13]]],
    ['text',   '글만',            [['t', 3, 3, 42, 22]]],
    ['media',  '그림만',           [['m', 3, 3, 42, 22]]],
  ];

  // Text draws as stacked bars, media as a solid block - readable at 48px wide.
  function layoutIcon(name) {
    const spec = LAYOUTS.find((l) => l[0] === name);
    if (!spec) return '';
    const parts = spec[2].map(([kind, x, y, w, h]) => {
      if (kind === 'm') {
        return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="#94a3b8"/>`;
      }
      const n = Math.max(1, Math.min(3, Math.floor(h / 4)));
      return Array.from({ length: n }, (_, i) =>
        `<rect x="${x}" y="${y + i * 4}" width="${i === n - 1 ? Math.round(w * 0.6) : w}"` +
        ` height="2" rx="1" fill="#60a5fa"/>`).join('');
    }).join('');
    return `<svg width="48" height="28" viewBox="0 0 48 28" aria-hidden="true">` +
           `<rect x="0.5" y="0.5" width="47" height="27" rx="3" fill="#fff" stroke="#cbd5e1"/>` +
           parts + `</svg>`;
  }
  const notUI = (el) => !el.hasAttribute('data-cde-ui');

  let cfg = null, deckName = '', current = 0, dirty = false;
  const undoStack = [];
  const UNDO_MAX = 60;
  let lastMtime = 0, saveTimer = null, pendingInsert = null;

  // Deck names are paths now; encode each segment so the slashes survive.
  const deckUrl = (name) => '/deck/' + name.split('/').map(encodeURIComponent).join('/');
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
    // Group by folder so a tree of decks stays readable in one menu.
    const byDir = new Map();
    files.forEach((f) => {
      const cut = f.lastIndexOf('/');
      const dir = cut < 0 ? '' : f.slice(0, cut);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(f);
    });
    byDir.forEach((list, dir) => {
      const parent = dir
        ? sel.appendChild(Object.assign(document.createElement('optgroup'), { label: dir }))
        : sel;
      list.forEach((f) => parent.appendChild(new Option(f.split('/').pop(), f)));
    });
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
      // Only bare E/S belong to the old in-deck editor. Swallowing modified
      // keys here would have eaten Ctrl+S before our own handler ran.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!e.target.isContentEditable && 'eEsS'.includes(e.key)) e.stopImmediatePropagation();
    }, true);

    slides(doc).forEach((s, i) => { s.dataset.cdeSlide = String(i); });
    slides(doc).forEach((s) => normalize(s));
    select(Math.min(current, slides(doc).length - 1));

    doc.querySelectorAll(cfg.editable).forEach((el) => el.setAttribute('contenteditable', 'true'));
    let burst = null;
    doc.addEventListener('beforeinput', (e) => {
      if (!e.target.isContentEditable) return;
      if (!burst) pushUndo();
      clearTimeout(burst);
      burst = setTimeout(() => { burst = null; }, 900);
    });
    doc.addEventListener('input', (e) => { if (e.target.isContentEditable) markDirty(); });

    // Click picks an item; Del removes it. Text keeps normal editing behaviour,
    // so Esc is what steps out of a block before deleting it.
    doc.addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-cde-ui]')) return;
      selectItem(e.target.closest(DELETABLE));
    });
    doc.addEventListener('keydown', shortcuts);
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
    // An explicit pick is always honoured. Only the automatic guess falls back
    // to 'text', or picking a two-area layout on a text-only slide does nothing.
    let name = layout || body.dataset.cdeLayout || guessLayout(body);
    const { media, text } = collect(body);
    const cols = body.style.getPropertyValue('--cde-cols') || guessCols(body);
    if (!layout && !media.length && name !== 'text') name = 'text';

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
    if (rl) rl.forEach((s, i) => {
      s.toggleAttribute('data-cde-current', i === current);
      s.parentElement?.toggleAttribute('data-cde-current', i === current);
    });
    rl?.[current]?.parentElement?.scrollIntoView({ block: 'nearest' });
    // Redrawing the chrome must never be able to block navigation, and a
    // failure in one part must not leave the toolbar describing another slide.
    try {
      fit();
      mountTools();
    } catch (err) {
      say('편집 도구 표시 실패 - ' + err.message, 'bad');
      console.error(err);
    }
    try {
      syncToolbar();
    } catch (err) {
      console.error(err);
    }
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

    // Outer edges: drag the body's own padding in from the top/bottom (vertical
    // layouts) or the left/right (side-by-side ones).
    const vertical = ['bottom', 'top', 'text', 'media'].includes(name);
    const pads = vertical
      ? [['paddingTop', 'y', 'start'], ['paddingBottom', 'y', 'end']]
      : [['paddingLeft', 'x', 'start'], ['paddingRight', 'x', 'end']];
    pads.forEach(([prop, axis, side]) =>
      out.push({ kind: 'pad', host: body, axis, prop, side }));

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

    // Every table row boundary is draggable; the whole table keeps one row
    // height, so the rows stay even however the boundary is moved.
    body.querySelectorAll('table, .tbl').forEach((table) => {
      [...table.querySelectorAll('tbody tr')].forEach((tr) => {
        out.push({ kind: 'trow', host: body, target: table, row: tr, axis: 'y' });
      });
      // Column boundaries, one per gap between the header cells.
      const cells = headCells(table);
      for (let i = 0; i < cells.length - 1; i++) {
        out.push({ kind: 'tcol', host: body, target: table, index: i, axis: 'x' });
      }
    });

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
        h.className = 'cde-handle'
          + (sp.kind === 'pad' ? ' cde-edge' : '')
          + (sp.kind === 'trow' ? ' cde-row' : '')
          + (sp.kind === 'tcol' ? ' cde-col-h' : '');
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
      if (sp.kind === 'tcol') {
        const hb = sp.host.getBoundingClientRect();
        const tb = sp.target.getBoundingClientRect();
        const cell = headCells(sp.target)[sp.index];
        if (!cell) return;
        const cr = cell.getBoundingClientRect();
        h.style.cssText =
          `left:${(cr.right - hb.left) / scale - 13}px;` +
          `top:${(tb.top - hb.top) / scale}px;` +
          `width:26px;height:${tb.height / scale}px`;
        return;
      }
      if (sp.kind === 'trow') {
        const hb = sp.host.getBoundingClientRect();
        const rr = sp.row.getBoundingClientRect();
        const tb = sp.target.getBoundingClientRect();
        h.style.cssText =
          `top:${(rr.bottom - hb.top) / scale - 13}px;` +
          `left:${(tb.left - hb.left) / scale}px;` +
          `width:${tb.width / scale}px;height:26px`;
        return;
      }
      if (sp.kind === 'pad') {
        const cs = getComputedStyle(sp.host);
        const pad = parseFloat(cs[sp.prop]) || 0;
        const full = (sp.axis === 'x' ? sp.host.getBoundingClientRect().width
                                      : sp.host.getBoundingClientRect().height) / scale;
        at = sp.side === 'start' ? pad + 13 : full - pad - 13;
      } else if (sp.kind === 'track') {
        at = boundaryAt(sp);
      } else {
        const hb = sp.host.getBoundingClientRect();
        const ab = sp.a.getBoundingClientRect(), bb = sp.b.getBoundingClientRect();
        at = sp.axis === 'x'
          ? ((ab.right + bb.left) / 2 - hb.left) / scale
          : ((ab.bottom + bb.top) / 2 - hb.top) / scale;
      }
      // Keep the whole 26px handle inside the host, or it becomes ungrabbable
      // once the boundary reaches the very top or the very bottom.
      const hb = sp.host.getBoundingClientRect();
      const span = (sp.axis === 'x' ? hb.width : hb.height) / scale;
      // Edge handles own the outermost band, so the middle one stops short of
      // it - otherwise the two stack up and neither can be grabbed.
      const inset = sp.kind === 'ratio' ? 30 : 0;
      const at2 = Math.max(inset, Math.min(span - 26 - inset, at - 13));
      h.style.cssText = sp.axis === 'x'
        ? `left:${at2}px;top:0;height:100%;width:26px`
        : `top:${at2}px;left:0;width:100%;height:26px`;
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

  // The header row defines the columns; without a thead the first row does.
  function headCells(table) {
    const row = table.querySelector('thead tr') || table.querySelector('tr');
    return row ? [...row.children] : [];
  }

  // Column widths live in a <colgroup>, which survives saving and printing.
  function ensureColgroup(table, n) {
    let cg = table.querySelector(':scope > colgroup');
    if (cg && cg.children.length === n) return cg;
    cg?.remove();
    cg = table.ownerDocument.createElement('colgroup');
    for (let i = 0; i < n; i++) cg.appendChild(table.ownerDocument.createElement('col'));
    table.insertBefore(cg, table.firstChild);
    return cg;
  }

  function resizeCols(sp, clientX) {
    const table = sp.target;
    const cells = headCells(table);
    if (cells.length < 2) return;
    const scale = scaleOf();
    const widths = cells.map((c) => c.getBoundingClientRect().width / scale);
    const total = widths.reduce((a, b) => a + b, 0) || 1;
    const i = sp.index;
    const before = widths.slice(0, i).reduce((a, b) => a + b, 0);
    const pair = widths[i] + widths[i + 1];
    const min = Math.min(pair / 2, Math.max(60, total * 0.08));
    let w = (clientX - table.getBoundingClientRect().left) / scale - before;
    w = Math.max(min, Math.min(pair - min, w));
    widths[i] = w;
    widths[i + 1] = pair - w;
    const cg = ensureColgroup(table, widths.length);
    [...cg.children].forEach((col, k) => {
      col.style.width = (widths[k] / total * 100).toFixed(2) + '%';
    });
    // Auto layout ignores <col> widths once content is wider than the track.
    table.setAttribute('data-cde-fixed', '');
  }

  // Drag any row boundary: the rows above it share the change, so one drag
  // resizes the whole table evenly.
  const ROW_MIN = 2, ROW_MAX = 60;
  function resizeRows(sp, clientY) {
    const rows = [...sp.target.querySelectorAll('tbody tr')];
    const n = rows.indexOf(sp.row) + 1;
    if (n < 1) return;
    const cell = sp.row.querySelector('td, th');
    const pad = parseFloat(getComputedStyle(cell).paddingTop) || 16;
    const delta = (clientY - sp.row.getBoundingClientRect().bottom) / scaleOf();
    const next = Math.max(ROW_MIN, Math.min(ROW_MAX, pad + delta / (2 * n)));
    sp.target.style.setProperty('--cde-trow', next.toFixed(1) + 'px');
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
    pushUndo();

    // Listeners sit on the document so the drag survives leaving the handle.
    const move = (ev) => {
      const hb = sp.host.getBoundingClientRect();
      const inner = sp.axis === 'x'
        ? (ev.clientX - hb.left) / (hb.width || 1)
        : (ev.clientY - hb.top) / (hb.height || 1);
      const scale = scaleOf();
      const full = (sp.axis === 'x' ? hb.width : hb.height) / scale;
      if (sp.kind === 'trow') {
        resizeRows(sp, ev.clientY);
      } else if (sp.kind === 'tcol') {
        resizeCols(sp, ev.clientX);
      } else if (sp.kind === 'pad') {
        const want = sp.side === 'start' ? inner * full : full - inner * full;
        sp.host.style[sp.prop] = Math.max(0, Math.min(full * 0.4, want)).toFixed(0) + 'px';
      } else if (sp.kind === 'track') {
        resizeTrack(sp, inner * full);
      } else {
        // Full range: one area may be pushed all the way shut.
        sp.host.style.setProperty(sp.prop, Math.max(0, Math.min(100, inner * 100)).toFixed(1) + '%');
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
    pushUndo();
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
    const res = await fetch('/_upload?name=' + encodeURIComponent(file.name)
                            + '&deck=' + encodeURIComponent(deckName),
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
    pushUndo();

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
    const name = body?.dataset.cdeLayout || 'text';
    const spec = LAYOUTS.find((l) => l[0] === name);
    $('layIcon').innerHTML = body ? layoutIcon(name) : '';
    $('layName').textContent = body ? (spec ? spec[1] : name) : '레이아웃';
    bar.querySelector('[data-act="pick"]').disabled = !body;
    $('layMenu').querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.layout === name));
    });
    $('cols').textContent = body?.style.getPropertyValue('--cde-cols') || '1';
    bar.querySelectorAll('[data-act^="cols"]').forEach((b) => { b.disabled = !has; });
    bar.querySelector('[data-act="undo"]').disabled = !undoStack.length;
  }

  // Page numbers are baked into each slide, so a reorder has to rewrite them.
  // Frame slides (목차 / 정리) carry an empty foot-num and stay unnumbered.
  function renumber() {
    const numbered = slides(sdoc()).filter((s) => {
      const n = s.querySelector('.foot-num');
      return n && n.textContent.trim() !== '';
    });
    const total = String(numbered.length).padStart(2, '0');
    numbered.forEach((s, i) => {
      const page = String(i + 1).padStart(2, '0');
      const folio = s.querySelector('.folio');
      if (folio) folio.textContent = page;
      s.querySelector('.foot-num').textContent = page + ' / ' + total;
      const bar = s.querySelector('.bar > i');
      if (bar) bar.style.width = Math.round((i + 1) / numbered.length * 100) + '%';
    });
  }

  function moveSlide(from, to) {
    if (from === to || from < 0 || to < 0) return;
    pushUndo();
    const ss = slides(sdoc());
    const host = ss[0].parentElement;
    host.insertBefore(ss[from], to > from ? ss[to].nextSibling : ss[to]);

    const thumbs = [...rdoc().querySelectorAll('.cde-thumb')];
    const rhost = thumbs[0].parentElement;
    rhost.insertBefore(thumbs[from], to > from ? thumbs[to].nextSibling : thumbs[to]);

    slides(sdoc()).forEach((s, i) => { s.dataset.cdeSlide = String(i); });
    slides(rdoc()).forEach((s, i) => { s.dataset.cdeSlide = String(i); });
    renumber();
    layoutRail();
    select(to);
    markDirty('순서 변경 - 저장 대기');
  }

  // Drag a thumbnail to move the slide. A plain click still selects.
  let dragFrom = -1, dragMoved = false;
  function initReorder(doc) {
    const drop = doc.createElement('div');
    drop.className = 'cde-drop';
    drop.setAttribute('data-cde-ui', '');
    drop.style.display = 'none';
    doc.body.appendChild(drop);
    let target = -1;

    doc.addEventListener('pointerdown', (e) => {
      const thumb = e.target.closest?.('.cde-thumb');
      if (!thumb || e.button !== 0) return;
      dragFrom = [...doc.querySelectorAll('.cde-thumb')].indexOf(thumb);
      dragMoved = false;
      target = dragFrom;
      const startY = e.clientY;

      const move = (ev) => {
        if (!dragMoved && Math.abs(ev.clientY - startY) < 6) return;
        if (!dragMoved) { dragMoved = true; thumb.setAttribute('data-cde-drag', ''); }
        const list = [...doc.querySelectorAll('.cde-thumb')];
        target = list.length - 1;
        for (let i = 0; i < list.length; i++) {
          const r = list[i].getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) { target = i; break; }
        }
        const at = list[Math.min(target, list.length - 1)];
        drop.style.display = 'block';
        drop.style.left = at.offsetLeft + 'px';
        drop.style.width = at.offsetWidth + 'px';
        drop.style.top = (target > dragFrom ? at.offsetTop + at.offsetHeight + 4
                                            : at.offsetTop - 8) + 'px';
      };
      const up = () => {
        doc.removeEventListener('pointermove', move);
        doc.removeEventListener('pointerup', up);
        drop.style.display = 'none';
        thumb.removeAttribute('data-cde-drag');
        if (dragMoved) {
          const to = target > dragFrom ? target - 1 : target;
          moveSlide(dragFrom, Math.max(0, to));
        }
        dragFrom = -1;
        setTimeout(() => { dragMoved = false; }, 0);
      };
      doc.addEventListener('pointermove', move);
      doc.addEventListener('pointerup', up);
    });
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
    // Delegated so it survives thumbnails being rebuilt, and so a click
    // anywhere in the strip - badge, padding, slide - still selects.
    doc.addEventListener('click', (e) => {
      const thumb = e.target.closest?.('.cde-thumb');
      if (!thumb) return;
      const list = [...doc.querySelectorAll('.cde-thumb')];
      if (dragMoved) return;          // 방금 끌어 옮긴 것은 선택이 아니다
      const at = list.indexOf(thumb);
      if (at >= 0) select(at);
    });
    doc.addEventListener('keydown', shortcuts);
    initReorder(doc);
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

  // --- undo ------------------------------------------------------------------
  // One entry per action: the slide container as it looked just before it.
  function deckHost() {
    return slides(sdoc())[0]?.parentElement || null;
  }

  function pushUndo() {
    const host = deckHost();
    if (!host) return;
    const clone = host.cloneNode(true);
    clone.querySelectorAll('[data-cde-ui]').forEach((el) => el.remove());
    clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
    clone.querySelectorAll('[data-cde-sel]').forEach((el) => el.removeAttribute('data-cde-sel'));
    clone.querySelectorAll('[data-cde-current]').forEach((el) => el.removeAttribute('data-cde-current'));
    undoStack.push({ html: clone.innerHTML, index: current });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    bar.querySelector('[data-act="undo"]').disabled = false;
  }

  function undo() {
    const step = undoStack.pop();
    const host = deckHost();
    if (!step || !host) return;
    host.innerHTML = step.html;
    const doc = sdoc();
    slides(doc).forEach((s, i) => { s.dataset.cdeSlide = String(i); });
    doc.querySelectorAll(cfg.editable).forEach((el) => el.setAttribute('contenteditable', 'true'));
    current = Math.min(step.index, slides(doc).length - 1);
    select(current);
    markDirty('되돌림 - 저장 대기');
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
    const base = deckName.split('/').pop().replace(/\.html?$/i, '');
    const name = prompt('다른 이름으로 저장 (같은 폴더)', base + '-copy.html');
    if (!name) return;
    const post = (overwrite) => fetch(
      '/_saveas?name=' + encodeURIComponent(name)
      + '&deck=' + encodeURIComponent(deckName) + (overwrite ? '&overwrite=1' : ''),
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
  // Focus lives inside an iframe as soon as a slide is clicked, and key events
  // do not cross that boundary - so the same handler goes on every document.
  function shortcuts(e) {
    const editing = !!(e.target && e.target.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); save(); return; }
      if (k === 'z' && !editing) { e.preventDefault(); undo(); return; }
      return;
    }
    if (e.altKey) return;
    if (e.key === 'PageDown') { e.preventDefault(); select(current + 1); return; }
    if (e.key === 'PageUp') { e.preventDefault(); select(current - 1); return; }
    if (e.key === 'Home' && !editing) { e.preventDefault(); select(0); return; }
    if (e.key === 'End' && !editing) { e.preventDefault(); select(slides(sdoc()).length - 1); return; }
    if (editing) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); select(current + 1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); select(current - 1); }
  }
  document.addEventListener('keydown', shortcuts);

  bar.addEventListener('click', (e) => {
    // closest, not e.target: buttons with an icon or a label span inside would
    // otherwise report the span, whose dataset carries no action.
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'pick') { const m = $('layMenu'); m.hidden = !m.hidden; }
    if (act === 'save') save();
    if (act === 'saveas') saveAs();
    if (act === 'add') askImage(null, null, null);
    if (act === 'undo') undo();
    if (act === 'cols+' || act === 'cols-') {
      pushUndo();
      setCols(Number($('cols').textContent) + (act === 'cols+' ? 1 : -1));
      select(current);
      markDirty();
    }
  });

  function setLayout(name) {
    const slide = currentSlide();
    if (!slide) return;
    pushUndo();
    sdoc().querySelectorAll('.cde-handle').forEach((el) => el.remove());
    normalize(slide, name);
    const body = currentBody();
    body.style.removeProperty('--cde-a');
    body.querySelectorAll('.cde-media').forEach((m) => {
      m.style.removeProperty('--cde-ctpl');
      m.style.removeProperty('--cde-rtpl');
    });
    select(current);
    markDirty();
  }

  (() => {
    const menu = $('layMenu');
    LAYOUTS.forEach(([name, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.layout = name;
      b.innerHTML = layoutIcon(name) + '<span>' + label + '</span>';
      b.addEventListener('click', () => { menu.hidden = true; setLayout(name); });
      menu.appendChild(b);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.lay-pick')) menu.hidden = true;
    });
  })();

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

  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  boot();
})();
