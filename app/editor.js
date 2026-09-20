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
  const UNWRAP = '.cols, .cols-fig, .col-text, .fig-stack, .cde-text, .cde-media, .cde-col,'
               + '.body-text, .body-media, .body-col';

  // Some decks ship this very layout model under their own names: data-layout
  // with .body-text / .body-media and --split / --row / --ctpl / --rtpl. Their
  // stylesheet keys on those names, so the editor reads and writes whichever
  // set a body already uses instead of renaming it.
  const CDE_NAMES = { media: '.cde-media', a: '--cde-a', row: '--cde-row',
                      ctpl: '--cde-ctpl', rtpl: '--cde-rtpl' };
  const DECK_NAMES = { media: '.body-media', a: '--split', row: '--row',
                       ctpl: '--ctpl', rtpl: '--rtpl' };
  const deckNative = (body) =>
    body.dataset.cdeLayout === undefined && body.dataset.layout !== undefined;
  const namesOf = (body) => (deckNative(body) ? DECK_NAMES : CDE_NAMES);
  const layoutName = (body) => (body ? (body.dataset.cdeLayout ?? body.dataset.layout ?? '') : '');
  const notUI = (el) => !el.hasAttribute('data-cde-ui');

  // A slideless file has no .body and none of a deck's classes, so its text is
  // described by plain tags instead. Blocks are what a click picks there.
  const DOC_EDIT = 'h1, h2, h3, h4, h5, h6, p, li, dt, dd, td, th, caption,'
                 + 'blockquote, figcaption, pre > code';
  // Items, not whole lists: a click on a bullet picks that one bullet.
  const DOC_BLOCKS = 'h1, h2, h3, h4, h5, h6, p, li, dt, dd, table, pre,'
                   + 'blockquote, figure';

  let cfg = null, deckName = '', current = 0, dirty = false;
  const undoStack = [];
  const UNDO_MAX = 60;
  let lastMtime = 0, saveTimer = null, pendingInsert = null;

  // Deck names are paths now; encode each segment so the slashes survive.
  const deckUrl = (name) => '/deck/' + name.split('/').map(encodeURIComponent).join('/');
  const sdoc = () => stage.contentDocument;
  const rdoc = () => rail.contentDocument;
  const slides = (doc) => [...doc.querySelectorAll(cfg.slide)];

  function syncUrl() {
    const q = '?deck=' + encodeURIComponent(deckName) + '&slide=' + (current + 1);
    if (location.search !== q) history.replaceState(null, '', q);
  }

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
    // ?deck=<path>&slide=<n> reopens the same file and slide, so a bookmark or
    // a reload lands where the work was.
    const want = new URLSearchParams(location.search);
    const wantDeck = want.get('deck');
    deckName = wantDeck && files.includes(wantDeck) ? wantDeck
      : cfg.deck && files.includes(cfg.deck) ? cfg.deck : files[0];
    current = Math.max(0, (Number(want.get('slide')) || 1) - 1);
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
    syncUrl();
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
    dropDeckUi(doc);

    slides(doc).forEach((s, i) => { s.dataset.cdeSlide = String(i); });
    // No normalising on open. A deck may use its own layout - .lead, .cols,
    // .note, custom grids - and rewriting it into the two-area model just
    // because the file was opened would silently destroy the design.
    setPanelMode();
    select(Math.min(current, slides(doc).length - 1));

    makeEditable(doc);
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
      selectItem(e.target.closest(docMode ? DOC_BLOCKS : DELETABLE));
    });
    doc.addEventListener('pointermove', (e) => {
      if (!docMode || e.target.closest('[data-cde-ui]')) return;
      const item = e.target.closest(DOC_BLOCKS);
      if (item && item !== docTool(doc).cdeItem) showDocTool(item);
    }, { passive: true });
    doc.addEventListener('keydown', shortcuts);
    doc.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { doc.activeElement?.blur?.(); return; }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (doc.activeElement && doc.activeElement.isContentEditable) return;
      const item = doc.querySelector('[data-cde-sel]');
      if (item) { e.preventDefault(); removeItem(item); }
    });
    doc.defaultView.addEventListener('resize', fit);
    doc.defaultView.addEventListener('scroll', () => markOutline(), { passive: true });
    new ResizeObserver(fit).observe(document.getElementById('stagePane'));
    fetch('/_stat?path=' + encodeURIComponent(deckName))
      .then((r) => r.json()).then((s) => { lastMtime = s.mtime; });
    say('준비됨', 'ok');
  }

  const editableSelector = () => (docMode ? cfg.editable + ',' + DOC_EDIT : cfg.editable);

  function makeEditable(doc) {
    doc.querySelectorAll(editableSelector()).forEach((el) => {
      if (!el.closest('[data-cde-ui]')) el.setAttribute('contenteditable', 'true');
    });
  }

  // A deck brings chrome of its own - an in-deck editor, a present button. It
  // fights the editor over the same keys, and anything it appended at runtime
  // would land in the saved file, so it goes before either iframe is wired up.
  function dropDeckUi(doc) {
    doc.querySelectorAll(cfg.deckUi).forEach((el) => el.remove());
    doc.addEventListener('keydown', (e) => {
      // Only the bare letters belong to that chrome - E/S to an in-deck editor,
      // F to a present button. Swallowing modified keys here would have eaten
      // Ctrl+S before our own handler ran.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!e.target.isContentEditable && 'eEsSfF'.includes(e.key)) e.stopImmediatePropagation();
    }, true);
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
    delete body.dataset.layout;
    body.style.setProperty('--cde-cols', cols);
  }

  // --- 등분 배치 -----------------------------------------------------------
  // A body is a stack of bands; a band is a row of equal cells. The spec is one
  // digit per band - '2-1' is two cells over one. Any cell takes any content.
  const GRIDS = [
    ['1', '한 칸'],
    ['2', '좌우 2등분'],
    ['1-1', '위아래 2등분'],
    ['2-1', '위 2 · 아래 1'],
    ['1-2', '위 1 · 아래 2'],
    ['2-2', '2 x 2'],
    ['3', '3단'],
    ['1-1-1', '위아래 3등분'],
  ];
  const bandSizes = (spec) => spec.split('-').map((n) => Math.max(1, Math.min(6, Number(n) || 1)));
  const bandsOf = (body) => [...body.querySelectorAll(':scope > .cde-band')];
  const cellsOf = (band) => [...band.querySelectorAll(':scope > .cde-cell')];
  const isGrid = (body) => !!body && body.dataset.cdeGrid !== undefined;
  const gridSpec = (body) => bandsOf(body).map((b) => cellsOf(b).length).join('-');

  function gridIcon(spec) {
    const rows = bandSizes(spec);
    const h = (22 - (rows.length - 1) * 3) / rows.length;
    let y = 3, parts = '';
    rows.forEach((n) => {
      const w = (42 - (n - 1) * 3) / n;
      for (let i = 0; i < n; i++) {
        parts += `<rect x="${(3 + i * (w + 3)).toFixed(1)}" y="${y.toFixed(1)}"`
               + ` width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="#94a3b8"/>`;
      }
      y += h + 3;
    });
    return '<svg width="48" height="28" viewBox="0 0 48 28" aria-hidden="true">'
         + '<rect x="0.5" y="0.5" width="47" height="27" rx="3" fill="#fff" stroke="#cbd5e1"/>'
         + parts + '</svg>';
  }

  const newCell = (doc) => {
    const el = doc.createElement('div');
    el.className = 'cde-cell';
    return el;
  };
  const newBand = (doc, n) => {
    const b = doc.createElement('div');
    b.className = 'cde-band';
    for (let i = 0; i < n; i++) b.appendChild(newCell(doc));
    return b;
  };

  // The written-down shape has to follow the DOM, or a hand-added cell would
  // still be sized as if it were not there.
  function syncGrid(body) {
    if (!isGrid(body)) return;
    const bands = bandsOf(body);
    body.dataset.cdeGrid = gridSpec(body);
    body.style.setProperty('--cde-rows', String(bands.length));
    bands.forEach((b) => b.style.setProperty('--cde-cells', String(cellsOf(b).length)));
    body.querySelectorAll('.cde-cell').forEach((c) => {
      c.toggleAttribute('data-cde-empty', ![...c.children].filter(notUI).length);
    });
  }

  // Everything the body holds, wrappers peeled off, in reading order.
  function blocksOf(body) {
    const out = [];
    (function walk(node) {
      [...node.children].filter(notUI).forEach((el) => {
        if (el.matches(UNWRAP) || el.matches('.cde-band, .cde-cell')) { walk(el); return; }
        out.push(el);
      });
    })(body);
    return out;
  }

  function applyGrid(spec) {
    const slide = currentSlide(), body = currentBody();
    if (!slide || !body) return;
    pushUndo();
    const doc = slide.ownerDocument;
    body.querySelectorAll('[data-cde-ui]').forEach((el) => el.remove());
    const items = blocksOf(body);
    const bands = bandSizes(spec).map((n) => newBand(doc, n));
    body.replaceChildren(...bands);
    const cells = bands.flatMap((b) => cellsOf(b));
    // One block per cell in reading order; whatever is left stacks in the last.
    items.forEach((el, i) => cells[Math.min(i, cells.length - 1)].appendChild(el));
    delete body.dataset.cdeLayout;
    delete body.dataset.layout;
    ['--cde-a', '--cde-rtpl', '--cde-ctpl', '--split', '--cde-cols'].forEach(
      (prop) => body.style.removeProperty(prop));
    body.dataset.cdeGrid = spec;
    syncGrid(body);
    select(current);
    markDirty('배치 변경 - 저장 대기');
  }

  function addCell(cell, side) {
    const band = cell.parentElement, body = currentBody();
    if (!band || !body) return;
    pushUndo();
    const doc = cell.ownerDocument;
    if (side === 'left' || side === 'right') {
      band.insertBefore(newCell(doc), side === 'left' ? cell : cell.nextSibling);
      band.style.removeProperty('--cde-ctpl');
    } else {
      body.insertBefore(newBand(doc, 1), side === 'top' ? band : band.nextSibling);
      body.style.removeProperty('--cde-rtpl');
    }
    syncGrid(body);
    select(current);
    markDirty('칸 추가 - 저장 대기');
  }

  function removeCell(cell) {
    const band = cell.parentElement, body = currentBody();
    if (!band || !body) return;
    if (cellsOf(band).length === 1 && bandsOf(body).length === 1) {
      say('마지막 칸은 지울 수 없다', 'warn');
      return;
    }
    pushUndo();
    // Content moves next door rather than disappearing with the cell.
    const rest = [...cell.children].filter(notUI);
    const siblings = cellsOf(band).filter((c) => c !== cell);
    const other = siblings[0]
      || cellsOf(band.previousElementSibling || band.nextElementSibling || band)[0];
    if (other && rest.length) rest.forEach((el) => other.appendChild(el));
    cell.remove();
    band.style.removeProperty('--cde-ctpl');
    if (!cellsOf(band).length) { band.remove(); body.style.removeProperty('--cde-rtpl'); }
    syncGrid(body);
    select(current);
    markDirty('칸 삭제 - 저장 대기');
  }

  // What an empty cell offers. Images go through the upload path instead.
  const NEW_BLOCK = {
    list: (doc) => {
      const ul = doc.createElement('ul');
      ul.className = 'ul';
      ['첫 항목', '둘째 항목'].forEach((t) => {
        const li = doc.createElement('li');
        li.textContent = t;
        ul.appendChild(li);
      });
      return ul;
    },
    table: (doc) => {
      const table = doc.createElement('table');
      table.className = 'tbl';
      const thead = doc.createElement('thead');
      const hr = doc.createElement('tr');
      ['항목', '설명', '비고'].forEach((t) => {
        const th = doc.createElement('th');
        th.textContent = t;
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      const tbody = doc.createElement('tbody');
      for (let r = 0; r < 2; r++) {
        const tr = doc.createElement('tr');
        for (let c = 0; c < 3; c++) tr.appendChild(doc.createElement('td'));
        tbody.appendChild(tr);
      }
      table.append(thead, tbody);
      return table;
    },
    code: (doc) => {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = 'cmake -S . -B build\ncmake --build build';
      pre.appendChild(code);
      return pre;
    },
  };

  function insertInto(cell, kind) {
    if (kind === 'image') { askImage(null, null, null, cell); return; }
    pushUndo();
    cell.appendChild(NEW_BLOCK[kind](cell.ownerDocument));
    makeEditable(sdoc());
    syncGrid(currentBody());
    select(current);
    markDirty('내용 추가 - 저장 대기');
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
    syncUrl();
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
    const name = layoutName(body);
    const nm = namesOf(body);
    const kids = (el) => [...el.children].filter(notUI);
    const byOrder = (a, b) => (getComputedStyle(a).order | 0) - (getComputedStyle(b).order | 0);
    const out = [];

    // Outer edges: drag the body's own padding in from the top/bottom (vertical
    // layouts) or the left/right (side-by-side ones).
    const vertical = !name || ['bottom', 'top', 'text', 'media'].includes(name);
    const pads = vertical
      ? [['paddingTop', 'y', 'start'], ['paddingBottom', 'y', 'end']]
      : [['paddingLeft', 'x', 'start'], ['paddingRight', 'x', 'end']];
    pads.forEach(([prop, axis, side]) =>
      out.push({ kind: 'pad', host: body, axis, prop, side }));

    if (isGrid(body)) {
      const bands = bandsOf(body);
      for (let i = 0; i < bands.length - 1; i++) {
        out.push({ kind: 'track', host: body, axis: 'y', prop: '--cde-rtpl', index: i });
      }
      bands.forEach((band) => {
        for (let i = 0; i < cellsOf(band).length - 1; i++) {
          out.push({ kind: 'track', host: band, axis: 'x', prop: '--cde-ctpl', index: i });
        }
      });
    } else if (['bottom', 'top', 'left', 'right'].includes(name)) {
      const [a, b] = kids(body).sort(byOrder);
      const axis = (name === 'left' || name === 'right') ? 'x' : 'y';
      if (a && b) out.push({ kind: 'ratio', host: body, axis, prop: nm.a, a, b });
    } else if (name === 'quad') {
      const cols = kids(body);
      if (cols.length === 2) {
        out.push({ kind: 'ratio', host: body, axis: 'x', prop: nm.a, a: cols[0], b: cols[1] });
      }
      cols.forEach((col) => {
        const [a, b] = kids(col);
        if (a && b) out.push({ kind: 'ratio', host: col, axis: 'y', prop: nm.row, a, b });
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
    body.querySelectorAll(nm.media).forEach((mbox) => {
      if (kids(mbox).length < 2) return;
      const cs = getComputedStyle(mbox);
      const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length;
      const rows = cs.gridTemplateRows.split(' ').filter(Boolean).length;
      for (let i = 0; i < cols - 1; i++) {
        out.push({ kind: 'track', host: mbox, axis: 'x', prop: nm.ctpl, index: i });
      }
      for (let j = 0; j < rows - 1; j++) {
        out.push({ kind: 'track', host: mbox, axis: 'y', prop: nm.rtpl, index: j });
      }
    });
    // Any other grid the deck itself built - a two-column .cols, say - gets the
    // same boundaries. With no variable to write into, the track sizes go on the
    // element, which saves and prints the same way.
    // One boundary, one handle: an element already modelled on an axis - a ratio,
    // a media track, a band - is left alone on that axis.
    const known = new Map();
    out.forEach((sp) => {
      if (sp.kind !== 'ratio' && sp.kind !== 'track') return;
      if (!known.has(sp.host)) known.set(sp.host, new Set());
      known.get(sp.host).add(sp.axis);
    });
    [body, ...body.querySelectorAll('*')].forEach((el) => {
      if (el.closest('table') || el.hasAttribute('data-cde-ui')) return;
      if (el.matches('.cde-media, .cde-band, .cde-cell')) return;
      const cs = getComputedStyle(el);
      if (!cs.display.includes('grid')) return;
      if ([...el.children].filter(notUI).length < 2) return;
      const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length;
      const rows = cs.gridTemplateRows.split(' ').filter(Boolean).length;
      const done = known.get(el);
      if (!done?.has('x')) {
        for (let i = 0; i < cols - 1; i++) {
          out.push({ kind: 'track', host: el, axis: 'x', prop: 'grid-template-columns', index: i });
        }
      }
      if (!done?.has('y')) {
        for (let j = 0; j < rows - 1; j++) {
          out.push({ kind: 'track', host: el, axis: 'y', prop: 'grid-template-rows', index: j });
        }
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
    // The attribute is what the stylesheet keys on, so the spacing applies
    // wherever the table sits - and keeps applying with the editor closed.
    sp.target.dataset.cdeTrow = '';
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
  // .body > * covers decks that have not been normalised into the two-area model.
  // Nearest wins, so the deck's own wrappers are listed too - clicking a table
  // inside a deck's .cols picks the table, not the half of the slide holding it.
  const DELETABLE = '.cde-media > *, .cde-text > *, .cde-text li,'
                  + '.cde-cell > *, .cde-cell li,'
                  + '.body-text > *, .body-media > *, .body-col > *,'
                  + '.cols > *, .cols-fig > *, .cols3 > *, .fig-stack > *,'
                  + '.body > *, .body li';

  // Removing a figure has to undo what adding it did, or the survivor keeps
  // the half-width cell the pair needed.
  function removeItem(item) {
    if (!item || item.hasAttribute('data-cde-ui')) return;
    pushUndo();
    if (docMode) {
      const list = item.parentElement;
      item.remove();
      // A list with no items left would still save, and still indent.
      if (list?.matches('ul, ol, dl') && !list.querySelector(':scope > li, :scope > dt, :scope > dd')) {
        list.remove();
      }
      showDocTool(null);
      markDirty('삭제됨 - 저장 대기');
      return;
    }
    const cell = item.parentElement?.closest('.cde-cell');
    if (cell) {
      item.remove();
      syncGrid(currentBody());
      select(current);
      markDirty('삭제됨 - 저장 대기');
      return;
    }
    const native = item.parentElement?.closest('.body-media');
    if (native) {
      item.remove();
      removedFromNative(native);
      select(current);
      markDirty('삭제됨 - 저장 대기');
      return;
    }
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
    if (body?.dataset.cdeLayout) normalize(currentSlide(), body.dataset.cdeLayout);
    select(current);
    markDirty('삭제됨 - 저장 대기');
  }

  // A deck-native media box sizes its grid from --cols; the dragged tracks
  // described the old grid. An emptied box goes, and the text takes the slide.
  function removedFromNative(mbox) {
    const body = mbox.closest('.body');
    const left = [...mbox.children].filter(notUI).length;
    mbox.style.removeProperty('--ctpl');
    mbox.style.removeProperty('--rtpl');
    if (!left) {
      mbox.remove();
      if (body) {
        body.style.removeProperty('--split');
        body.style.setProperty('--cols', '1');
        if (body.querySelector('.body-text')) body.dataset.layout = 'text';
      }
      return;
    }
    const cols = Number(mbox.style.getPropertyValue('--cols')) || 1;
    if (left < cols) {
      mbox.style.setProperty('--cols', String(left));
      body?.style.setProperty('--cols', String(left));
    }
  }

  function selectItem(item) {
    sdoc().querySelectorAll('[data-cde-sel]').forEach((el) => el.removeAttribute('data-cde-sel'));
    if (item) item.setAttribute('data-cde-sel', '');
    try { syncToolbar(); } catch (err) { console.error(err); }
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

  // A new block below takes the look of the one it came from: same tag and
  // classes, placeholder text, a list keeps only its first bullet.
  function addBelow(item) {
    pushUndo();
    const copy = item.cloneNode(true);
    copy.querySelectorAll('[data-cde-ui]').forEach((el) => el.remove());
    copy.removeAttribute('data-cde-sel');
    if (copy.matches('ul, ol')) [...copy.children].slice(1).forEach((el) => el.remove());
    const leaves = [copy, ...copy.querySelectorAll('[contenteditable]')]
      .filter((el) => el.hasAttribute('contenteditable') && !el.querySelector('[contenteditable]'));
    (leaves.length ? leaves : [copy]).forEach((el) => { el.textContent = '새 내용'; });
    item.after(copy);
    makeEditable(item.ownerDocument);
    select(current);
    selectItem(copy);
    const target = copy.isContentEditable ? copy : copy.querySelector('[contenteditable]');
    if (target) {
      target.focus();
      item.ownerDocument.getSelection().selectAllChildren(target);
    }
    markDirty('추가됨 - 저장 대기');
  }

  function addBelowButton(doc, item) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'cde-add';
    b.textContent = '+';
    b.title = '아래에 같은 형식으로 추가';
    b.contentEditable = 'false';
    b.setAttribute('data-cde-ui', '');
    b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      addBelow(item);
    });
    item.appendChild(b);
    return b;
  }

  function mountTools() {
    const doc = sdoc();
    doc.querySelectorAll('.cde-plus, .cde-del, .cde-add, .cde-minus, .cde-pick, .cde-grip')
       .forEach((el) => el.remove());
    const body = currentBody();
    if (!body) return;

    if (isGrid(body)) { cellTools(doc, body); return; }

    // Deck-native media boxes get delete only; adding keeps to the editor's
    // own model, which insertImage builds.
    body.querySelectorAll('.body-media').forEach((mbox) => {
      [...mbox.children].filter(notUI).forEach((item) => delButton(doc, item));
    });

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

    // Any block, and any bullet, can be removed - not just figures. Deck-native
    // bodies name their text box .body-text, so both names get the tools.
    body.querySelectorAll('.cde-text, .body-text').forEach((tbox) => {
      [...tbox.children].filter(notUI).forEach((item) => {
        delButton(doc, item);
        addBelowButton(doc, item);
      });
    });
    body.querySelectorAll('.ul > li, .cde-text li').forEach((li) => delButton(doc, li, true));
  }

  // Every cell can grow a neighbour, be removed, take new content, and hand its
  // blocks to another cell.
  function cellTools(doc, body) {
    body.querySelectorAll('.cde-cell').forEach((cell) => {
      [['left', '왼쪽에 칸 추가'], ['right', '오른쪽에 칸 추가'],
       ['top', '위에 행 추가'], ['bottom', '아래에 행 추가']].forEach(([side, title]) => {
        const b = doc.createElement('button');
        b.type = 'button'; b.className = 'cde-plus'; b.textContent = '+';
        b.dataset.cdeSide = side;
        b.title = title;
        b.contentEditable = 'false';
        b.setAttribute('data-cde-ui', '');
        b.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          addCell(cell, side);
        });
        cell.appendChild(b);
      });

      const minus = doc.createElement('button');
      minus.type = 'button'; minus.className = 'cde-minus'; minus.textContent = '\u2212';
      minus.title = '이 칸 삭제';
      minus.contentEditable = 'false';
      minus.setAttribute('data-cde-ui', '');
      minus.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        removeCell(cell);
      });
      cell.appendChild(minus);

      const pick = doc.createElement('div');
      pick.className = 'cde-pick';
      pick.contentEditable = 'false';
      pick.setAttribute('data-cde-ui', '');
      [['list', '글목록'], ['image', '그림'], ['table', '표'], ['code', '코드']]
        .forEach(([kind, label]) => {
          const b = doc.createElement('button');
          b.type = 'button';
          b.textContent = label;
          b.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            insertInto(cell, kind);
          });
          pick.appendChild(b);
        });
      cell.appendChild(pick);

      [...cell.children].filter(notUI).forEach((item) => {
        delButton(doc, item);
        gripButton(doc, item);
      });
    });
    body.querySelectorAll('.cde-cell li').forEach((li) => delButton(doc, li, true));
  }

  // Dragging text would fight with editing it, so a block travels by its grip.
  function gripButton(doc, item) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'cde-grip';
    b.textContent = '\u2059';
    b.title = '끌어서 다른 칸으로';
    b.contentEditable = 'false';
    b.setAttribute('data-cde-ui', '');
    b.addEventListener('pointerdown', (e) => startCellDrag(e, item));
    item.appendChild(b);
    return b;
  }

  // Move one block into whatever cell it is dropped on.
  function startCellDrag(e, item) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const doc = item.ownerDocument;
    const grip = e.currentTarget;
    try { grip.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    let target = null;
    item.setAttribute('data-cde-lift', '');

    const move = (ev) => {
      const under = doc.elementFromPoint(ev.clientX, ev.clientY);
      const cell = under && under.closest ? under.closest('.cde-cell') : null;
      if (cell === target) return;
      target?.removeAttribute('data-cde-drop');
      target = cell;
      target?.setAttribute('data-cde-drop', '');
    };
    const up = () => {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
      item.removeAttribute('data-cde-lift');
      target?.removeAttribute('data-cde-drop');
      if (target && target !== item.parentElement) {
        pushUndo();
        target.appendChild(item);
        syncGrid(currentBody());
        select(current);
        markDirty('칸 이동 - 저장 대기');
      }
    };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
  }

  function askImage(mbox, index, side, cell) {
    pendingInsert = { mbox, index, side, cell };
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

  function newFigure(doc, src, alt) {
    const fig = doc.createElement('figure');
    fig.className = 'fig';
    const frame = doc.createElement('span');
    frame.className = 'frame';
    const img = doc.createElement('img');
    img.src = src; img.alt = alt || '';
    frame.appendChild(img); fig.appendChild(frame);
    return fig;
  }

  function insertImage(src, alt) {
    const doc = sdoc();
    const body = currentBody();
    if (!body) return;
    const where = pendingInsert;
    pendingInsert = null;
    pushUndo();

    // A grid body has no media area - the picture lands in a cell.
    if (isGrid(body)) {
      const cell = (where?.cell && body.contains(where.cell)) ? where.cell
        : body.querySelector('.cde-cell[data-cde-empty]') || body.querySelector('.cde-cell');
      if (!cell) return;
      cell.appendChild(newFigure(doc, src, alt));
      syncGrid(body);
      select(current);
      markDirty();
      say('그림 추가 - ' + src, 'ok');
      return;
    }

    let mbox = where?.mbox;
    if (!mbox || !body.contains(mbox)) {
      if (!body.querySelector('.cde-media')) normalize(currentSlide(), 'bottom');
      mbox = currentBody().querySelector('.cde-media');
    }

    const fig = newFigure(doc, src, alt);

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

  // --- 글자 크기 --------------------------------------------------------------
  // Sizes are written back as px on the blocks themselves, so a saved deck keeps
  // them with the editor closed - printing included.
  const FS_STEP = 1.08;
  const FS_TEXT = 'p, li, td, th, dt, dd, code, pre, blockquote, figcaption,'
                + '.lead, .card, .ul, .tbl, h1, h2, h3, h4';

  // A picked block on its own, otherwise every text block on the slide.
  function fontTargets() {
    const doc = sdoc();
    const root = doc.querySelector('[data-cde-sel]') || currentBody()
      || (docMode ? doc.body : null);
    if (!root) return null;
    const list = [root, ...root.querySelectorAll(FS_TEXT)]
      .filter((el) => !el.hasAttribute('data-cde-ui') && !el.closest('[data-cde-ui]'));
    return { root, list };
  }

  function scaleFont(mul) {
    const targets = fontTargets();
    if (!targets) return;
    const { root, list } = targets;
    const was = Number(root.dataset.cdeFs) || 1;
    const now = Math.max(0.5, Math.min(2.5, was * mul));
    if (Math.abs(now - was) < 0.001) { say('더 조절할 수 없다', 'warn'); return; }
    pushUndo();
    const step = now / was;
    // Measure everything before writing: sizing a parent first would leave the
    // children inheriting the new size and scaling it a second time.
    const sizes = list.map((el) => parseFloat(el.style.fontSize)
      || parseFloat(getComputedStyle(el).fontSize) || 16);
    list.forEach((el, i) => { el.style.fontSize = (sizes[i] * step).toFixed(2) + 'px'; });
    root.dataset.cdeFs = now.toFixed(3);
    syncToolbar();
    markDirty('글자 크기 - 저장 대기');
  }

  function syncToolbar() {
    const body = currentBody();
    const grid = isGrid(body) ? gridSpec(body) : '';
    const known = grid ? GRIDS.find((g) => g[0] === grid) : null;
    $('layIcon').innerHTML = grid ? gridIcon(grid) : '';
    $('layName').textContent = !body ? '배치'
      : known ? known[1] : grid ? '분할 ' + grid : '덱 원래 배치';
    bar.querySelector('[data-act="pick"]').disabled = !body;
    $('layMenu').querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.layout === grid));
    });
    const band = grid ? selectedCell()?.parentElement : null;
    const has = grid
      ? true
      : !!body?.querySelector('.cde-media')?.children.length;
    $('cols').textContent = grid
      ? String(cellsOf(band || bandsOf(body)[0]).length)
      : (body?.style.getPropertyValue('--cde-cols') || '1');
    bar.querySelectorAll('[data-act^="cols"]').forEach((b) => { b.disabled = !has; });
    const fsRoot = sdoc()?.querySelector('[data-cde-sel]') || body
      || (docMode ? sdoc()?.body : null);
    $('fs').textContent = Math.round((Number(fsRoot?.dataset.cdeFs) || 1) * 100) + '%';
    // A document has no .body to point at, but its text still scales.
    bar.querySelectorAll('[data-act^="fs"]').forEach((b) => { b.disabled = !body && !docMode; });
    bar.querySelector('[data-act="undo"]').disabled = !undoStack.length;
  }

  // The cell the toolbar acts on: the one holding the selection, else the last.
  function selectedCell() {
    const body = currentBody();
    if (!isGrid(body)) return null;
    const sel = sdoc().querySelector('[data-cde-sel]');
    const cells = [...body.querySelectorAll('.cde-cell')];
    return sel?.closest('.cde-cell') || cells[cells.length - 1] || null;
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

  // The rail renders the same deck a second time, so any change to the deck's
  // shape - order, a new page, undo - is mirrored by re-copying the stage.
  const thumbOf = (s) => (s.parentElement?.classList.contains('cde-thumb') ? s.parentElement : s);

  function railFollow() {
    const rd = rdoc();
    const rs = rd ? slides(rd) : [];
    if (!rs.length) return;
    const last = thumbOf(rs[rs.length - 1]);
    const host = last.parentElement, next = last.nextSibling;
    rs.forEach((s) => thumbOf(s).remove());
    slides(sdoc()).forEach((s, i) => {
      const copy = s.cloneNode(true);
      copy.querySelectorAll('[data-cde-ui]').forEach((el) => el.remove());
      copy.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
      copy.removeAttribute('data-cde-sel');
      copy.dataset.cdeSlide = String(i);
      host.insertBefore(copy, next);
    });
    layoutRail();
  }

  function moveSlide(from, to) {
    const ss = slides(sdoc());
    if (from === to || from < 0 || to < 0 || from >= ss.length || to >= ss.length) return;
    pushUndo();
    const host = ss[0].parentElement;
    host.insertBefore(ss[from], to > from ? ss[to].nextSibling : ss[to]);
    slides(sdoc()).forEach((s, i) => { s.dataset.cdeSlide = String(i); });
    renumber();
    railFollow();
    select(to);
    markDirty('순서 변경 - 저장 대기');
  }

  // A new page is the page above it with the wording taken out: same layout,
  // same footer and section furniture, so the deck keeps one look.
  const KEEP_TEXT = '.kicker, .course, .presenter, .foot-sec, .folio, .foot-num';

  function addSlide() {
    const from = slides(sdoc())[current];
    if (!from) return;
    pushUndo();
    const copy = from.cloneNode(true);
    copy.removeAttribute('data-cde-current');
    copy.querySelectorAll('[data-cde-ui]').forEach((el) => el.remove());
    copy.querySelectorAll('[data-cde-sel]').forEach((el) => el.removeAttribute('data-cde-sel'));
    copy.querySelectorAll(cfg.editable).forEach((el) => {
      if (!el.closest(KEEP_TEXT)) el.textContent = '';
    });
    from.after(copy);
    slides(sdoc()).forEach((s, i) => { s.dataset.cdeSlide = String(i); });
    makeEditable(sdoc());
    renumber();
    railFollow();
    select(current + 1);
    markDirty('슬라이드 추가 - 저장 대기');
  }

  // Del in the slide list removes the whole page. One slide has to survive:
  // with none left there is no deck host left to undo back into.
  function removeSlide(index) {
    const ss = slides(sdoc());
    if (index < 0 || index >= ss.length) return;
    if (ss.length < 2) { say('마지막 슬라이드는 지울 수 없다', 'warn'); return; }
    pushUndo();
    ss[index].remove();
    slides(sdoc()).forEach((s, i) => { s.dataset.cdeSlide = String(i); });
    renumber();
    railFollow();
    select(Math.min(index, slides(sdoc()).length - 1));
    markDirty('슬라이드 삭제 - Ctrl+Z 로 되돌린다');
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
        target = list.length;
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
        if (thumb.hasPointerCapture(e.pointerId)) thumb.releasePointerCapture(e.pointerId);
        thumb.removeEventListener('pointermove', move);
        thumb.removeEventListener('pointerup', up);
        thumb.removeEventListener('pointercancel', up);
        drop.style.display = 'none';
        thumb.removeAttribute('data-cde-drag');
        if (dragMoved) {
          const to = target > dragFrom ? target - 1 : target;
          moveSlide(dragFrom, Math.max(0, to));
        }
        dragFrom = -1;
        setTimeout(() => { dragMoved = false; }, 0);
      };
      thumb.setPointerCapture(e.pointerId);
      thumb.addEventListener('pointermove', move);
      thumb.addEventListener('pointerup', up);
      thumb.addEventListener('pointercancel', up);
    });
  }

  // --- outline ---------------------------------------------------------------
  // A deck is a run of slides; some files are one long document instead. With
  // no slide to thumbnail, the left panel lists the document's 장절 headings.
  let docMode = false;

  const plainText = (el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll('[data-cde-ui]').forEach((x) => x.remove());
    return c.textContent.trim();
  };

  function setPanelMode() {
    docMode = !slides(sdoc()).length;
    sdoc().documentElement.toggleAttribute('data-cde-doc', docMode);
    rail.hidden = docMode;
    $('addSlide').hidden = docMode;
    $('outline').hidden = !docMode;
    if (docMode) buildOutline();
  }

  function buildOutline() {
    const box = $('outline'), doc = sdoc();
    const heads = [...doc.querySelectorAll(cfg.heading || 'h1, h2, h3')].filter(notUI);
    box.replaceChildren();
    if (!heads.length) {
      box.innerHTML = '<p class="empty">장절 제목이 없다</p>';
      return;
    }
    heads.forEach((h, i) => {
      h.dataset.cdeHead = String(i);
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.level = h.tagName.slice(1);
      b.textContent = plainText(h) || '(제목 없음)';
      b.addEventListener('click', () => {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        markOutline(i);
      });
      box.appendChild(b);
    });
    markOutline();
  }

  // Which 장절 the reader is in: the last heading at or above the fold.
  function markOutline(force) {
    const box = $('outline'), doc = sdoc();
    if (!docMode || !doc) return;
    let at = force;
    if (at == null) {
      const heads = [...doc.querySelectorAll('[data-cde-head]')];
      const top = (doc.defaultView.scrollY || doc.documentElement.scrollTop || 0) + 48;
      at = 0;
      heads.forEach((h, i) => { if (h.offsetTop <= top) at = i; });
    }
    [...box.children].forEach((b, i) => b.toggleAttribute('data-cur', i === at));
  }

  // --- 문서 단락 도구 ----------------------------------------------------------
  // A document can run to hundreds of paragraphs, so one floating tool follows
  // the pointer instead of a button being planted inside every block.
  function docTool(doc) {
    let tool = doc.body.querySelector(':scope > .cde-doctool');
    if (tool) return tool;
    tool = doc.createElement('div');
    tool.className = 'cde-doctool';
    tool.contentEditable = 'false';
    tool.setAttribute('data-cde-ui', '');
    tool.hidden = true;
    [['sub', '+', '세부 항목 추가'], ['del', '×', '이 단락 삭제 (Esc 후 Del)']]
      .forEach(([act, label, title]) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.dataset.act = act;
        b.textContent = label;
        b.title = title;
        tool.appendChild(b);
      });
    tool.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      const item = tool.cdeItem;
      if (!act || !item?.isConnected) return;
      if (act === 'del') removeItem(item); else addSubItem(item);
    });
    doc.body.appendChild(tool);
    return tool;
  }

  function showDocTool(item) {
    const doc = sdoc();
    const tool = docTool(doc);
    tool.cdeItem = item;
    tool.hidden = !item;
    if (!item) return;
    tool.querySelector('[data-act="sub"]').hidden = item.tagName !== 'LI';
    // The body is the positioning context, so the tool scrolls with the text.
    const r = item.getBoundingClientRect(), b = doc.body.getBoundingClientRect();
    const room = doc.documentElement.clientWidth - b.left - 64;
    tool.style.top = (r.top - b.top) + 'px';
    tool.style.left = Math.min(r.right - b.left - 1, room) + 'px';
  }

  // A top-level bullet grows a nested list; a sub-item gets a sibling below it,
  // so clicking + again keeps adding at the same depth.
  function addSubItem(li) {
    const doc = li.ownerDocument;
    pushUndo();
    const item = doc.createElement('li');
    item.textContent = '새 세부 항목';
    if (li.parentElement.parentElement?.closest('li')) {
      li.after(item);
    } else {
      const list = li.querySelector(':scope > ul, :scope > ol')
        || li.appendChild(doc.createElement('ul'));
      list.appendChild(item);
    }
    makeEditable(doc);
    // Nested editables share their outer host; a selection inside is what
    // puts the caret there, ready to type over the placeholder.
    item.focus();
    const range = doc.createRange();
    range.selectNodeContents(item);
    doc.getSelection().removeAllRanges();
    doc.getSelection().addRange(range);
    selectItem(item);
    showDocTool(item);
    markDirty('세부 항목 추가 - 저장 대기');
  }

  // --- rail ----------------------------------------------------------------
  function initRail() {
    const doc = rdoc();
    doc.documentElement.dataset.cde = 'rail';
    injectChrome(doc);
    ensureLayoutLink(doc);
    dropDeckUi(doc);
    slides(doc).forEach((s, i) => { s.dataset.cdeSlide = String(i); });
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
    doc.addEventListener('keydown', (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (doc.activeElement && doc.activeElement.isContentEditable) return;
      e.preventDefault();
      removeSlide(current);
    });
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
      if (docMode) { buildOutline(); return; }
      const from = currentSlide(), to = rdoc() && slides(rdoc())[current];
      if (!from || !to) return;
      const clone = from.cloneNode(true);
      clone.querySelectorAll('[data-cde-ui]').forEach((el) => el.remove());
      clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
      to.replaceChildren(...clone.childNodes);
      if (clone.dataset.cdeLayout !== undefined) to.dataset.cdeLayout = clone.dataset.cdeLayout;
      const body = to.querySelector(cfg.body), src = clone.querySelector(cfg.body);
      if (body && src) {
        if (src.dataset.cdeLayout !== undefined) body.dataset.cdeLayout = src.dataset.cdeLayout;
        body.style.cssText = src.style.cssText;
      }
      layoutRail();
    }, 250);
  }

  // --- undo ------------------------------------------------------------------
  // One entry per action: the slide container as it looked just before it.
  function deckHost() {
    // A document is one long page: its own body is what an undo step holds.
    return slides(sdoc())[0]?.parentElement || (docMode ? sdoc().body : null);
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
    makeEditable(doc);
    renumber();
    railFollow();
    current = Math.min(step.index, slides(doc).length - 1);
    select(current);
    markDirty('되돌림 - 저장 대기');
  }

  // --- save ------------------------------------------------------------------
  function serialize() {
    const root = sdoc().documentElement.cloneNode(true);
    root.removeAttribute('data-cde');
    root.removeAttribute('data-cde-edit');
    root.removeAttribute('data-cde-doc');
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
    syncUrl();
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
    if (e.altKey) {
      if (editing) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSlide(current, current + 1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveSlide(current, current - 1); }
      return;
    }
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

  $('addSlide').addEventListener('click', addSlide);

  bar.addEventListener('click', (e) => {
    // closest, not e.target: buttons with an icon or a label span inside would
    // otherwise report the span, whose dataset carries no action.
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'pick') { const m = $('layMenu'); m.hidden = !m.hidden; }
    if (act === 'save') save();
    if (act === 'saveas') saveAs();
    if (act === 'add') askImage(null, null, null);
    if (act === 'undo') undo();
    if (act === 'fs+') { scaleFont(FS_STEP); return; }
    if (act === 'fs-') { scaleFont(1 / FS_STEP); return; }
    if (act === 'cols+' || act === 'cols-') {
      const cell = selectedCell();
      if (cell) {
        if (act === 'cols+') addCell(cell, 'right'); else removeCell(cell);
        return;
      }
      pushUndo();
      setCols(Number($('cols').textContent) + (act === 'cols+' ? 1 : -1));
      select(current);
      markDirty();
    }
  });

  (() => {
    const menu = $('layMenu');
    GRIDS.forEach(([spec, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.layout = spec;
      b.innerHTML = gridIcon(spec) + '<span>' + label + '</span>';
      b.addEventListener('click', () => { menu.hidden = true; applyGrid(spec); });
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
