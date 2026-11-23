/* KERFINATOR launcher UI */
K.app = (function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  var ICON = {
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>'
  };

  /* ---------------- shared helpers ---------------- */
  // action: optional {label, run} shown as a button in the toast
  function toast(msg, kind, ms, action) {
    var t = el('div', { class: 'toast ' + (kind || ''), role: kind === 'err' ? 'alert' : 'status' }, [el('span', { text: msg })]);
    function close() { t.classList.add('leaving'); setTimeout(function () { t.remove(); }, 300); }
    if (action) t.appendChild(el('button', { class: 'toast-act', text: action.label, onclick: function () { close(); action.run(); } }));
    var box = $('#toasts');
    box.appendChild(t);
    while (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(close, ms || (action ? 9000 : kind === 'err' ? 8000 : 4200));
  }
  function download(blob, name) {
    var a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 30000);
  }
  function ask(o) {
    var d = $('#dlg-confirm');
    $('#cf-title').textContent = o.title;
    $('#cf-body').textContent = o.body || '';
    $('#cf-ok').textContent = o.ok || 'OK';
    $('#cf-ok').className = 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary');
    $('#cf-check-wrap').hidden = !o.check;
    $('#cf-check').checked = !!o.checkDefault;
    if (o.check) $('#cf-check-label').textContent = o.check;
    return new Promise(function (res) {
      function fin(ok) { d.close(); $('#cf-ok').onclick = $('#cf-cancel').onclick = null; d.onclose = null; res({ ok: ok, checked: $('#cf-check').checked }); }
      $('#cf-ok').onclick = function () { fin(true); };
      $('#cf-cancel').onclick = function () { fin(false); };
      d.onclose = function () { res({ ok: false, checked: false }); };
      d.showModal();
      (o.danger ? $('#cf-cancel') : $('#cf-ok')).focus();
    });
  }

  // Object URLs for thumbnails, cached per game version so they're not leaked.
  var thumbCache = {};
  function thumbUrl(item) {
    var key = item.id + ':' + (item.game.updated || 0) + ':' + (item.user.thumbAt || 0) + ':' + (item.user.shotAt || 0);
    var c = thumbCache[item.id];
    if (c && c.key === key) return c.url;
    if (c) URL.revokeObjectURL(c.url);
    if (!item.thumb) return '';
    var url = URL.createObjectURL(item.thumb);
    thumbCache[item.id] = { key: key, url: url };
    return url;
  }

  /* ---------------- state ---------------- */
  var items = [], byId = {};
  var ui = { filter: 'all', sort: 'title', query: '' };
  try { Object.assign(ui, JSON.parse(localStorage.getItem('kerf:ui') || '{}'), { query: '' }); } catch (e) {}
  function saveUi() { try { localStorage.setItem('kerf:ui', JSON.stringify({ filter: ui.filter, sort: ui.sort })); } catch (e) {} }

  async function refresh() {
    items = await K.lib.all();
    byId = {};
    items.forEach(function (it) { byId[it.id] = it; });
    renderLibrary();
    if (openGameId && byId[openGameId]) fillGameDialog(byId[openGameId]);
  }
  var refreshTimer = null;
  function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 60); }

  /* ---------------- navigation ---------------- */
  function show(view) {
    $$('.tab').forEach(function (t) {
      var on = t.dataset.view === view;
      t.classList.toggle('is-active', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    ['library', 'import', 'system'].forEach(function (v) { $('#view-' + v).hidden = v !== view; });
    if (view === 'system') renderSystem();
    window.scrollTo(0, 0);
  }
  function currentView() { var t = $('.tab.is-active'); return t ? t.dataset.view : 'library'; }

  /* ---------------- library ---------------- */
  var cards = {}, recentCards = {};
  function launch(id) {
    var it = byId[id];
    if (!it) return;
    if (it.game.installing) { toast('“' + it.title + '” is still being installed.', ''); return; }
    var r = K.lib.launch(id);
    if (r === 'running') {
      toast('“' + it.title + '” is already open in another tab. Playing it in two tabs at once can overwrite your progress.', '', 9000,
        { label: 'Open anyway', run: function () { if (!K.lib.launch(id, true)) blocked(); } });
    } else if (!r) blocked();
  }
  function blocked() {
    toast('The browser blocked the game tab. Select the blocked pop-up icon at the right of the address bar, choose “Always allow”, then try again.', 'err', 12000);
  }
  async function toggleFav(id) {
    await K.db.updateUser(id, function (u) { u.fav = !u.fav; });
    await refresh();
  }
  function makeCard(id, recent) {
    var fav = el('button', { class: 'icon-btn fav', 'aria-pressed': 'false', title: 'Favorite' });
    fav.innerHTML = ICON.star;
    var more = el('button', { class: 'icon-btn more', title: 'Details', 'aria-label': 'Details' });
    more.innerHTML = ICON.more;
    var img = el('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    var title = el('span', { class: 'card-title' });
    var meta = recent ? el('span', { class: 'card-meta' }) : null;
    var hit = el('button', { class: 'card-hit' }, [el('div', { class: 'cover' }, [img, el('span', { class: 'play-glyph', 'aria-hidden': 'true' })])]);
    var foot = el('div', { class: 'card-foot' }, [el('div', { class: 'card-text' }, [title, meta]), fav, more]);
    var root = el('article', { class: 'card' }, [el('div', { class: 'card-frame' }, [el('div', { class: 'card-inner' }, [hit, foot])])]);
    hit.addEventListener('click', function () { launch(id); });
    hit.addEventListener('contextmenu', function (e) { e.preventDefault(); openGame(id); });
    fav.addEventListener('click', function () { toggleFav(id); });
    more.addEventListener('click', function () { openGame(id); });
    return { root: root, img: img, title: title, meta: meta, fav: fav, hit: hit, more: more, sig: '' };
  }
  function updateCard(c, it) {
    var sig = it.title + '|' + it.user.fav + '|' + thumbUrl(it) + '|' + it.game.installing + '|' + (c.meta ? it.user.last : '');
    if (c.sig === sig) return;
    c.sig = sig;
    c.title.textContent = it.title;
    c.root.title = it.title;
    var src = thumbUrl(it);
    if (c.img.getAttribute('src') !== src) c.img.src = src;
    c.fav.setAttribute('aria-pressed', it.user.fav ? 'true' : 'false');
    c.fav.setAttribute('aria-label', (it.user.fav ? 'Remove ' : 'Add ') + it.title + (it.user.fav ? ' from favorites' : ' to favorites'));
    c.hit.setAttribute('aria-label', 'Play ' + it.title);
    c.more.setAttribute('aria-label', 'Details for ' + it.title);
    c.root.classList.toggle('is-busy', !!it.game.installing);
    if (c.meta) c.meta.textContent = K.formatAgo(it.user.last);
  }

  function matches(it, terms) {
    if (!terms.length) return true;
    var t = it._lt || (it._lt = it.title.toLowerCase());
    return terms.every(function (w) { return t.indexOf(w) >= 0; });
  }
  var SORTS = {
    title: function (a, b) { return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }); },
    recent: function (a, b) { return (b.user.last || 0) - (a.user.last || 0) || SORTS.title(a, b); },
    added: function (a, b) { return (b.game.added || 0) - (a.game.added || 0) || SORTS.title(a, b); },
    play: function (a, b) { return (b.user.play || 0) - (a.user.play || 0) || SORTS.title(a, b); }
  };
  function visibleItems() {
    var terms = ui.query.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(function (it) { return (ui.filter !== 'fav' || it.user.fav) && matches(it, terms); }).sort(SORTS[ui.sort] || SORTS.title);
  }
  function renderLibrary() {
    var list = visibleItems();
    var grid = $('#grid'), frag = document.createDocumentFragment();
    var live = {};
    list.forEach(function (it) {
      var c = cards[it.id] || (cards[it.id] = makeCard(it.id, false));
      updateCard(c, it); frag.appendChild(c.root); live[it.id] = 1;
    });
    for (var id in cards) if (!byId[id]) { cards[id].root.remove(); delete cards[id]; }
    grid.textContent = '';
    grid.appendChild(frag);

    // recently played (hidden while searching or filtering favorites)
    var recent = items.filter(function (it) { return it.user.last; }).sort(SORTS.recent).slice(0, 8);
    var showRecent = !ui.query && ui.filter === 'all' && recent.length > 0 && items.length > 3;
    $('#recent').hidden = !showRecent;
    if (showRecent) {
      var rf = document.createDocumentFragment();
      recent.forEach(function (it) {
        var c = recentCards[it.id] || (recentCards[it.id] = makeCard(it.id, true));
        updateCard(c, it); rf.appendChild(c.root);
      });
      $('#recent-row').textContent = '';
      $('#recent-row').appendChild(rf);
    }
    for (var rid in recentCards) if (!byId[rid]) delete recentCards[rid];

    $('#grid-title').textContent = ui.query ? 'Search results' : (ui.filter === 'fav' ? 'Favorites' : 'All games');
    $('#count').textContent = list.length + (list.length === 1 ? ' game' : ' games');
    $$('.seg button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.filter === ui.filter ? 'true' : 'false'); });
    $('#sort').value = ui.sort;

    var empty = $('#empty');
    empty.textContent = '';
    if (list.length) { empty.hidden = true; return; }
    empty.hidden = false;
    if (!items.length) {
      var busy = K.usb.state.installing;
      empty.appendChild(el('h3', { text: busy ? 'Installing games from the USB drive' : 'Your library is empty' }));
      empty.appendChild(el('p', { text: busy ? 'Games appear here as soon as each one is copied into this browser.' : 'Import a game folder, a .zip archive or a single .html file. Imported games stay on this computer, so they keep working without the USB drive.' }));
      if (!busy) empty.appendChild(el('button', { class: 'btn btn-primary', text: 'Import games', onclick: function () { show('import'); } }));
    } else if (ui.query) {
      empty.appendChild(el('h3', { text: 'No games match “' + ui.query + '”' }));
      empty.appendChild(el('p', { text: ui.filter === 'fav' ? 'Only favorites are being searched. Switch to All to search every game.' : 'Check the spelling, or search for part of the title.' }));
    } else {
      empty.appendChild(el('h3', { text: 'No favorites yet' }));
      empty.appendChild(el('p', { text: 'Select the star on any game to keep it here.' }));
    }
  }

  /* ---------------- game details dialog ---------------- */
  var openGameId = null;
  function openGame(id) {
    var it = byId[id];
    if (!it) return;
    openGameId = id;
    fillGameDialog(it);
    $('#dg-title').value = it.title;
    var d = $('#dlg-game');
    if (!d.open) d.showModal();
  }
  function fillGameDialog(it) {
    var g = it.game, u = it.user;
    $('#dg-img').src = thumbUrl(it);
    if (document.activeElement !== $('#dg-title')) $('#dg-title').value = it.title;
    $('#dg-play').textContent = K.formatDuration(u.play);
    $('#dg-last').textContent = K.formatAgo(u.last);
    $('#dg-launches').textContent = String(u.launches || 0);
    $('#dg-size').textContent = K.formatBytes(g.size) + ', ' + g.files + ' files';
    var sel = $('#dg-entry');
    sel.textContent = '';
    var cands = (g.candidates && g.candidates.length ? g.candidates : [g.entry]).slice();
    if (cands.indexOf(it.entry) < 0) cands.unshift(it.entry);
    cands.forEach(function (p) { sel.appendChild(el('option', { value: p, text: p })); });
    sel.value = it.entry;
    $('#dg-entry-wrap').hidden = cands.length < 2;
    $('#dg-source').textContent = (g.source === 'usb' ? 'Installed from the USB library' : 'Imported') + ' on ' + new Date(g.added).toLocaleDateString() + '. Stored in this browser.';
    var fav = $('#dg-fav');
    fav.textContent = u.fav ? 'Remove from favorites' : 'Add to favorites';
    fav.setAttribute('aria-pressed', u.fav ? 'true' : 'false');
    var diag = K.lib.diagnostics(it.id), box = $('#dg-diag');
    box.textContent = '';
    var lines = [];
    if (diag && diag.fatal === 'isolation') lines.push('Last session: this game needs cross-origin isolation, which browsers only allow on web servers.');
    if (diag && diag.missing && diag.missing.length) lines.push('Last session: missing file' + (diag.missing.length > 1 ? 's' : '') + ': ' + diag.missing.slice(0, 6).join(', ') + '. The game folder may be incomplete; import it again from a complete copy.');
    if (diag && diag.external && diag.external.length) lines.push('Last session: the game tried to load files from the internet, which KERFINATOR blocks.');
    if (g.external && g.external.length && !(diag && diag.external && diag.external.length)) lines.push('This game references online files (' + g.external.slice(0, 2).join(', ') + '). Parts of it may not work offline.');
    lines.forEach(function (l) { box.appendChild(el('p', { text: l })); });
    box.hidden = !lines.length;
    var gid = it.id;
    K.lib.outsideSaves(gid).then(function (o) { if (openGameId === gid) $('#dg-outside').hidden = !o.count; }, function () {});
  }
  async function saveTitle() {
    var id = openGameId, it = byId[id];
    if (!it) return;
    var v = $('#dg-title').value.trim();
    if (!v || v === it.title) { $('#dg-title').value = it.title; return; }
    await K.db.updateUser(id, function (u) { u.title = v === it.game.title ? undefined : v; });
    await refresh();
    toast('Renamed to “' + v + '”.', 'ok');
  }

  /* ---------------- cover picker ---------------- */
  // source: {images: [paths], getBlob(path) -> Promise<Blob>}; resolves {path}|{file}|{generated}|null
  function pickCover(source) {
    var d = $('#dlg-cover'), grid = $('#dc-grid'), urls = [];
    grid.textContent = '';
    return new Promise(function (res) {
      var settled = false;
      function fin(v) { if (settled) return; settled = true; d.close(); urls.forEach(URL.revokeObjectURL); res(v); }
      d.onclose = function () { fin(null); };
      $('#dc-generated').onclick = function () { fin({ generated: true }); };
      $('#dc-upload').onclick = function () { $('#in-cover').value = ''; $('#in-cover').click(); };
      $('#in-cover').onchange = function () { var f = $('#in-cover').files[0]; if (f) fin({ file: f }); };
      var imgs = source.images || [];
      if (!imgs.length) grid.appendChild(el('p', { class: 'cover-empty', text: 'This game has no images to choose from. Use an image from this computer or a generated cover.' }));
      imgs.forEach(function (p) {
        var img = el('img', { alt: '' });
        var b = el('button', { class: 'cover-opt', title: p, onclick: function () { fin({ path: p }); } }, [img, el('span', { text: p.split('/').pop() })]);
        grid.appendChild(b);
        source.getBlob(p).then(function (blob) { if (blob) { var u = URL.createObjectURL(blob); urls.push(u); img.src = u; } });
      });
      d.showModal();
    });
  }
  async function changeGameCover() {
    var it = byId[openGameId];
    if (!it) return;
    var id = it.id;
    var choice = await pickCover({
      images: it.game.images || [],
      getBlob: async function (p) { var r = await K.db.get('files', [id, p]); return r && r.b; }
    });
    if (!choice) return;
    var blob = null;
    if (choice.path) { var r = await K.db.get('files', [id, choice.path]); blob = r && r.b; }
    if (choice.file) blob = choice.file;
    var thumb = await K.thumbs.make(blob, it.title);
    await K.db.updateUser(id, function (u) { u.thumb = thumb; u.thumbAt = Date.now(); });
    await refresh();
    toast('Cover updated.', 'ok');
  }

  /* ---------------- import ---------------- */
  var rows = [];
  function setImportStatus(t) { $('#import-status').textContent = t || ''; }
  async function processSources(sources) {
    if (!sources.length) return;
    show('import');
    setImportStatus('Reading files…');
    try {
      var found = await K.importer.prepare(sources, setImportStatus);
      found.forEach(addRow);
      var ready = found.filter(function (f) { return !f.error; }).length;
      setImportStatus(found.length === 1 ? '' : found.length + ' item' + (found.length === 1 ? '' : 's') + ' found, ' + ready + ' playable.');
    } catch (e) {
      setImportStatus('');
      toast('Import failed: ' + (e.message || e), 'err');
    }
    updateImportActions();
  }

  function rowState(r) {
    if (r.info.error) return 'error';
    if (r.done) return 'added';
    if (r.busy) return 'adding';
    if (r.info.duplicateOf && !r.dupChoice) return 'duplicate';
    if (r.info.duplicateInBatch && !r.dupChoice) return 'duplicate';
    if (r.info.needsEntryChoice && !r.entryChosen) return 'choose';
    if (r.info.sameTitleAs && !r.dupChoice) return 'choose';
    return 'ready';
  }
  function addRow(info) {
    var r = { info: info, title: info.title || info.name, entry: info.entry, cover: info.cover, coverFile: null, generated: false, done: null, busy: false, progress: 0 };
    r.el = el('div', { class: 'imp' });
    rows.push(r);
    renderRow(r);
    $('#import-list').appendChild(r.el);
  }
  function fileOf(r, path) { var f = r.info.files && r.info.files.find(function (x) { return x.path === path; }); return f ? f.file : null; }
  function renderRow(r) {
    var info = r.info, st = rowState(r), box = r.el;
    box.className = 'imp is-' + st;
    box.textContent = '';
    if (r.coverUrl) { URL.revokeObjectURL(r.coverUrl); r.coverUrl = null; }

    // cover
    var coverBtn;
    if (!info.error) {
      var blob = r.generated ? null : (r.coverFile || (r.cover ? fileOf(r, r.cover) : null));
      var inner = blob ? el('img', { alt: '' }) : el('div', { class: 'gen', text: r.title });
      if (blob) { r.coverUrl = URL.createObjectURL(blob); inner.src = r.coverUrl; }
      coverBtn = el('button', { class: 'imp-cover', title: 'Change cover', disabled: st === 'added' || st === 'adding' }, [inner, el('span', { text: st === 'added' ? 'Cover' : 'Change cover' })]);
      coverBtn.addEventListener('click', async function () {
        var c = await pickCover({ images: info.images || [], getBlob: async function (p) { return fileOf(r, p); } });
        if (!c) return;
        r.generated = !!c.generated; r.coverFile = c.file || null; r.cover = c.path || (c.generated ? null : r.cover);
        renderRow(r);
      });
    } else coverBtn = el('div', { class: 'imp-cover' }, [el('div', { class: 'gen', text: '!' })]);
    box.appendChild(coverBtn);

    // body
    var body = el('div', { class: 'imp-body' });
    if (info.error) {
      body.appendChild(el('strong', { class: 'card-title', text: info.name || 'Import' }));
      body.appendChild(el('p', { class: 'imp-msg err', text: info.error }));
    } else {
      var tIn = el('input', { type: 'text', value: r.title, maxlength: '100', 'aria-label': 'Title', disabled: st === 'added' || st === 'adding' });
      tIn.addEventListener('input', function () { r.title = tIn.value; });
      body.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Title' }), tIn]));
      if (info.candidates && info.candidates.length > 1 && st !== 'added') {
        var sel = el('select', { 'aria-label': 'Start page', disabled: st === 'adding' });
        info.candidates.forEach(function (p) { sel.appendChild(el('option', { value: p, text: p })); });
        sel.value = r.entry;
        sel.addEventListener('change', function () {
          var titles = info.candidateTitles || {}, auto = titles[r.entry] || info.title;
          if (r.title === auto && titles[sel.value]) r.title = titles[sel.value];
          r.entry = sel.value; r.entryChosen = true; renderRow(r); updateImportActions();
        });
        body.appendChild(el('label', { class: 'field' }, [el('span', { text: st === 'choose' && info.needsEntryChoice && !r.entryChosen ? 'Several start pages were found. Which one starts the game?' : 'Start page' }), sel]));
      }
      body.appendChild(el('div', { class: 'imp-meta' }, [
        el('span', { text: info.count + ' file' + (info.count === 1 ? '' : 's') }),
        el('span', { text: K.formatBytes(info.size) }),
        el('span', { text: 'Starts at ' + r.entry })
      ]));
      (info.warnings || []).forEach(function (w) { body.appendChild(el('p', { class: 'imp-msg warn', text: w })); });
      if (st === 'duplicate') {
        body.appendChild(el('p', { class: 'imp-msg warn', text: info.duplicateOf ? 'This exact game is already in your library as “' + info.duplicateOf.title + '”.' : 'This game appears twice in this import.' }));
      } else if (info.sameTitleAs && !r.dupChoice && st === 'choose') {
        body.appendChild(el('p', { class: 'imp-msg warn', text: 'A different version of “' + info.sameTitleAs.title + '” is already in your library. Update it (keeps playtime, favorites and saves) or add this as a separate game?' }));
      } else if (st === 'choose') {
        body.appendChild(el('p', { class: 'imp-msg warn', text: 'Choose the start page, then add the game.' }));
      }
      if (st === 'added') body.appendChild(el('p', { class: 'imp-msg ok', text: 'Added to your library and ready to play — even without the USB drive.' }));
      if (r.error) body.appendChild(el('p', { class: 'imp-msg err', text: r.error }));
    }
    box.appendChild(body);

    // actions
    var side = el('div', { class: 'imp-side' });
    function btn(label, cls, fn) { side.appendChild(el('button', { class: 'btn ' + (cls || ''), text: label, onclick: fn })); }
    if (st === 'ready') btn('Add to library', 'btn-primary', function () { commitRow(r); });
    if (st === 'choose' && info.sameTitleAs && !r.dupChoice) {
      btn('Update existing', 'btn-primary', function () { r.dupChoice = 'update'; commitRow(r); });
      btn('Add as new game', '', function () { r.dupChoice = 'new'; renderRow(r); updateImportActions(); });
    } else if (st === 'choose') btn('Add to library', 'btn-primary', function () { r.entryChosen = true; commitRow(r); });
    if (st === 'duplicate') {
      btn('Add a copy anyway', '', function () { r.dupChoice = 'copy'; commitRow(r); });
    }
    if (st === 'adding') {
      side.appendChild(el('span', { class: 'imp-msg', text: 'Adding… ' + Math.round(r.progress * 100) + '%' }));
      var bar = el('div', { class: 'bar' }, [el('i', { style: 'width:' + Math.round(r.progress * 100) + '%' })]);
      side.appendChild(bar);
    }
    if (st === 'added') btn('Play now', 'btn-primary', function () { launch(r.done.id); });
    if (st !== 'adding') btn(st === 'added' || st === 'error' ? 'Dismiss' : 'Skip', 'btn-quiet', function () { removeRow(r); });
    box.appendChild(side);
  }
  function removeRow(r) {
    if (r.coverUrl) URL.revokeObjectURL(r.coverUrl);
    r.el.remove();
    rows.splice(rows.indexOf(r), 1);
    updateImportActions();
  }
  async function commitRow(r) {
    if (r.busy || r.done) return;
    r.busy = true; r.error = null; r.progress = 0; renderRow(r); updateImportActions();
    var lastPaint = 0;
    try {
      var opts = {
        title: r.title.trim() || r.info.title, entry: r.entry,
        cover: r.generated ? null : r.cover, coverFile: r.generated ? null : r.coverFile,
        copy: r.dupChoice === 'copy',
        onProgress: function (p) { r.progress = p; var now = Date.now(); if (now - lastPaint > 120) { lastPaint = now; renderRow(r); } }
      };
      if (r.dupChoice === 'update' && r.info.sameTitleAs) { opts.id = r.info.sameTitleAs.id; opts.source = r.info.sameTitleAs.source; opts.usbKey = r.info.sameTitleAs.usbKey; }
      r.done = await K.importer.commit(r.info, opts);
      r.info.files = null; // release references to the original files
      await refresh();
    } catch (e) {
      r.error = e.message || String(e);
    }
    r.busy = false;
    renderRow(r);
    updateImportActions();
    if (r.done && !batchMode) toast('“' + r.done.title + '” added to your library.', 'ok');
  }
  function updateImportActions() {
    var ready = rows.filter(function (r) { return rowState(r) === 'ready'; }).length;
    var finished = rows.filter(function (r) { var s = rowState(r); return s === 'added' || s === 'error'; }).length;
    $('#import-actions').hidden = !rows.length;
    $('#import-all').disabled = ready === 0;
    $('#import-all').textContent = ready > 1 ? 'Add all ' + ready + ' ready games' : 'Add ready game';
    $('#import-clear').disabled = finished === 0;
  }
  var batchMode = false;
  async function addAllReady() {
    var list = rows.filter(function (r) { return rowState(r) === 'ready'; });
    batchMode = list.length > 1;
    for (var i = 0; i < list.length; i++) await commitRow(list[i]);
    batchMode = false;
    var added = list.filter(function (r) { return r.done; }).length, failed = list.length - added;
    if (list.length > 1) toast(added + ' game' + (added === 1 ? '' : 's') + ' added to your library.' + (failed ? ' ' + failed + ' could not be added; see the list.' : ''), failed ? 'err' : 'ok');
  }

  /* ---------------- USB / system ---------------- */
  function renderInstall(st) {
    var box = $('#install');
    if (!st.installing || !st.current) {
      box.hidden = true;
      if (st.errors && st.errors.length && !renderInstall.reported) {
        renderInstall.reported = true;
        toast('Some USB games could not be installed: ' + st.errors.join(' '), 'err', 12000);
      }
      return;
    }
    renderInstall.reported = false;
    box.hidden = false;
    var pct = Math.round(st.progress * 100);
    $('#install-label').textContent = 'Copying games from the USB drive: ' + st.current.title + ' (' + st.current.index + ' of ' + st.current.total + ')';
    $('#install-pct').textContent = pct + '%';
    $('#install-bar').style.width = pct + '%';
  }
  async function renderStrip() {
    var strip = $('#strip');
    var cat = K.usb.state.catalog;
    var dismissed = localStorage.getItem('kerf:strip-dismissed') === '1';
    if (!cat || !cat.games.length || dismissed || localStorage.getItem('kerf:saved')) { strip.hidden = true; return; }
    var busy = K.usb.state.installing || (await K.usb.pending()).length > 0;
    strip.textContent = '';
    strip.appendChild(el('p', { text: (busy ? 'Copying the USB drive\u2019s games to this computer. ' : 'The USB drive\u2019s games are on this computer now. ') + 'To play without the drive, save KERFINATOR here too.' }));
    strip.appendChild(el('button', { class: 'btn btn-primary btn-small', text: 'Save to this computer', onclick: saveLauncher }));
    strip.appendChild(el('button', { class: 'x', 'aria-label': 'Dismiss', text: '×', onclick: function () { localStorage.setItem('kerf:strip-dismissed', '1'); strip.hidden = true; } }));
    strip.hidden = false;
  }
  async function saveLauncher() {
    var blob = new Blob([K.SOURCE], { type: 'text/html' });
    if (window.showSaveFilePicker) {
      try {
        var h = await window.showSaveFilePicker({ suggestedName: 'KERFINATOR.html', startIn: 'desktop', types: [{ description: 'KERFINATOR launcher', accept: { 'text/html': ['.html'] } }] });
        var w = await h.createWritable(); await w.write(blob); await w.close();
        localStorage.setItem('kerf:saved', String(Date.now()));
        toast('Saved as ' + h.name + '. Next time, open that file to start KERFINATOR without the USB.', 'ok', 9000);
        renderStrip(); renderSystem();
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    download(blob, 'KERFINATOR.html');
    localStorage.setItem('kerf:saved', String(Date.now()));
    toast('KERFINATOR.html was saved to your Downloads folder. Move it to your Desktop if you like, and open it next time.', 'ok', 10000);
    renderStrip(); renderSystem();
  }
  async function renderSystem() {
    $('#version').textContent = K.VERSION;
    if (navigator.storage && navigator.storage.estimate) {
      try {
        var est = await navigator.storage.estimate();
        var pct = est.quota ? Math.min(100, est.usage / est.quota * 100) : 0;
        $('#quota-bar').style.width = Math.max(pct, 0.5) + '%';
        $('#quota-text').textContent = items.length + ' game' + (items.length === 1 ? '' : 's') + ' using ' + K.formatBytes(est.usage) + '. Room for ' + K.formatBytes(Math.max(0, est.quota - est.usage)) + ' more.';
      } catch (e) {}
    }
    var persisted = false;
    try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (e) {}
    $('#persist-text').textContent = persisted
      ? 'Protected: the browser won\u2019t delete your games to free up disk space.'
      : 'If the disk gets very full, the browser may delete your games to make room. Protect them to prevent that.';
    $('#persist').hidden = persisted;
    var saved = Number(localStorage.getItem('kerf:saved') || 0);
    $('#saved-text').textContent = saved ? 'Saved on ' + new Date(saved).toLocaleDateString() + '. Open that copy of KERFINATOR.html to play without the drive.' : '';
    var cat = K.usb.state.catalog;
    if (cat) {
      var pend = await K.usb.pending();
      $('#usb-text').textContent = 'This USB drive has ' + cat.games.length + ' game' + (cat.games.length === 1 ? '' : 's') + '. ' +
        (pend.length ? pend.length + ' still need' + (pend.length === 1 ? 's' : '') + ' to be copied to this computer.' : 'All of them are on this computer.');
      $('#usb-install').disabled = !pend.length || K.usb.state.installing;
    } else {
      $('#usb-text').textContent = 'This copy of KERFINATOR isn\u2019t on a USB drive with games (normal for a copy saved to this computer). To get new games, open KERFINATOR from the USB drive, or use Import.';
      $('#usb-install').disabled = true;
    }
    $('#auto-install').checked = await K.db.kvGet('autoInstall', true);
    var lb = await K.db.kvGet('lastBackup', 0);
    $('#backup-text').textContent = lb ? 'Last backup: ' + new Date(lb).toLocaleDateString() + '.' : 'No backup yet.';
    renderBuildButton();
  }
  /* Build USB library. The button can never get stuck: while a build runs it
     shows progress and a Stop button, and it always comes back afterwards. */
  var building = null;
  function renderBuildButton() {
    var btn = $('#build-usb'), note = $('#build-note'), ok = !!window.showDirectoryPicker;
    btn.disabled = !ok || !!building;
    $('#build-stop').hidden = !building;
    if (!building) btn.textContent = 'Build USB library';
    note.hidden = ok;
    if (!ok) note.textContent = 'This browser can\u2019t save to folders, so it can\u2019t build the USB library. Open KERFINATOR in Microsoft Edge or Google Chrome to build it. (Playing works in any of them.)';
  }
  async function buildUsb() {
    if (building) return;
    var root;
    try { root = await window.showDirectoryPicker({ id: 'kerf-usb', mode: 'readwrite' }); }
    catch (e) {
      if (e && e.name === 'AbortError') return;
      toast(e && e.name === 'SecurityError' ? 'The browser won\u2019t allow that folder. Keep KERFINATOR in a folder on the USB drive (not the drive itself) and choose that folder.' : 'That folder can\u2019t be used: ' + (e && e.message), 'err', 10000);
      return;
    }
    var ctl = building = { stopped: false };
    var log = $('#build-log'), last = null, lastProgress = Date.now(), warned = false, stopNow;
    log.hidden = false; log.textContent = '';
    renderBuildButton();
    $('#build-usb').textContent = 'Building…';
    function line(m) {
      if (ctl !== building) return;   // a stopped build that is still finishing in the background
      lastProgress = Date.now();
      if (m.type === 'progress') { if (!last || !last.classList.contains('progress')) { last = el('li', { class: 'progress' }); log.appendChild(last); } last.textContent = m.text; }
      else { if (last && last.classList.contains('progress')) last.remove(); last = el('li', { class: m.type, text: m.text }); log.appendChild(last); }
      log.scrollTop = log.scrollHeight;
    }
    var watchdog = setInterval(function () {
      if (!warned && Date.now() - lastProgress > 45000) {
        warned = true;
        line({ type: 'warn', text: 'Still waiting for the USB drive. Slow drives can take a few minutes for big games. If nothing changes, select Stop, check the drive is plugged in, and try again.' });
      }
    }, 5000);
    var stopped = new Promise(function (res) { stopNow = res; });
    $('#build-stop').onclick = function () { ctl.stopped = true; stopNow(); };
    try {
      var out = await Promise.race([K.usb.build(root, line, ctl), stopped.then(function () { var e = new Error('Stopped. The USB library still works exactly as it did before.'); e.stopped = true; throw e; })]);
      line({ type: 'ok', text: 'Done: ' + out.length + ' game' + (out.length === 1 ? '' : 's') + ' in the USB library. Anyone who opens KERFINATOR.html from this drive gets them automatically.' });
      toast('USB library built: ' + out.length + ' game' + (out.length === 1 ? '' : 's') + '.', 'ok');
    } catch (e) {
      line({ type: e && e.stopped ? 'warn' : 'error', text: (e && e.message) || String(e) });
      if (e && e.name === 'NotAllowedError') line({ type: 'warn', text: 'The browser wasn\u2019t allowed to save to the drive. Select Build USB library again and choose “Edit files” / “Allow” when asked.' });
    } finally {
      clearInterval(watchdog);
      building = null;
      renderBuildButton();
    }
  }
  async function eraseAll() {
    var a = await ask({ title: 'Erase KERFINATOR from this browser?', body: 'Every game, favorite, playtime record and save stored by KERFINATOR in this browser will be deleted. This cannot be undone. Export a backup first if you might want your saves back.', ok: 'Erase everything', danger: true });
    if (!a.ok) return;
    var games = await K.db.getAll('games');
    for (var i = 0; i < games.length; i++) await K.lib.wipeSaves(games[i].id);
    for (var j = localStorage.length - 1; j >= 0; j--) { var k = localStorage.key(j); if (k && /^(kerf:|kfg:|kfc:)/.test(k)) localStorage.removeItem(k); }
    if (indexedDB.databases) {
      var dbs = await indexedDB.databases();
      for (var d = 0; d < dbs.length; d++) if (dbs[d].name && dbs[d].name.indexOf('kfg:') === 0) indexedDB.deleteDatabase(dbs[d].name);
    }
    var db = await K.db.open(); db.close();
    await new Promise(function (res) { var r = indexedDB.deleteDatabase('kerfinator'); r.onsuccess = r.onerror = r.onblocked = function () { res(); }; });
    location.reload();
  }

  /* ---------------- wiring ---------------- */
  function wire() {
    $$('.tab').forEach(function (t) { t.addEventListener('click', function () { show(t.dataset.view); }); });
    var search = $('#search');
    search.addEventListener('input', function () {
      ui.query = search.value.trim();
      if (currentView() !== 'library') show('library');
      renderLibrary();
    });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { search.value = ''; ui.query = ''; renderLibrary(); search.blur(); }
      if (e.key === 'Enter') { var v = visibleItems(); if (v.length) launch(v[0].id); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '') && !document.querySelector('dialog[open]')) {
        e.preventDefault(); search.focus();
      }
    });
    $$('.seg button').forEach(function (b) { b.addEventListener('click', function () { ui.filter = b.dataset.filter; saveUi(); renderLibrary(); }); });
    $('#sort').addEventListener('change', function () { ui.sort = $('#sort').value; saveUi(); renderLibrary(); });

    // game dialog
    $('#dlg-game').addEventListener('close', function () { openGameId = null; });
    $('#dg-title').addEventListener('change', saveTitle);
    $('#dg-title').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('#dg-title').blur(); } });
    $('#dg-play-btn').addEventListener('click', function () { if (openGameId) launch(openGameId); });
    $('#dg-fav').addEventListener('click', function () { if (openGameId) toggleFav(openGameId); });
    $('#dg-cover-btn').addEventListener('click', changeGameCover);
    $('#dg-outside-btn').addEventListener('click', async function () {
      var id = openGameId, it = byId[id];
      if (!it) return;
      if (K.lib.isRunning(id)) { toast('Close “' + it.title + '” first, then try again.', 'err'); return; }
      var a = await ask({
        title: 'Use the progress from outside KERFINATOR?', ok: 'Use that progress', danger: true,
        body: 'The saves this game made when it was opened directly replace its saves in KERFINATOR. Its current KERFINATOR progress for those saves is lost; export a backup first (Settings) if you might want it back.'
      });
      if (!a.ok) return;
      try {
        var r = await K.lib.useOutsideSaves(id);
        $('#dg-outside').hidden = true;
        toast('Done: ' + r.count + ' save' + (r.count === 1 ? '' : 's') + ' brought over. Start the game to continue where you left off.', 'ok', 7000);
      } catch (e) { toast('That didn\u2019t work: ' + (e.message || e) + '. Close every tab of this game and try again.', 'err', 10000); }
    });
    $('#dg-entry').addEventListener('change', async function () {
      var id = openGameId, v = $('#dg-entry').value, it = byId[id];
      await K.db.updateUser(id, function (u) { u.entry = v === it.game.entry ? undefined : v; });
      await refresh();
      toast('Start page set to ' + v + '.', 'ok');
    });
    $('#dg-remove').addEventListener('click', async function () {
      var id = openGameId, it = byId[id];
      if (!it) return;
      var a = await ask({
        title: 'Remove “' + it.title + '”?', ok: 'Remove', danger: true,
        body: 'The game files are deleted from this browser. ' + (it.game.source === 'usb' ? 'It will be installed again the next time KERFINATOR is opened from the USB drive.' : 'You can import it again later.'),
        check: 'Also delete its saves, playtime and favorite', checkDefault: false
      });
      if (!a.ok) return;
      $('#dlg-game').close();
      await K.lib.remove(id, a.checked);
      if (it.game.source === 'usb' && !a.checked) toast('Removed. Saves were kept and will return if the game is installed again.', 'ok');
      else toast('“' + it.title + '” removed.', 'ok');
    });

    // import
    var dz = $('#dropzone');
    var dragDepth = 0;
    document.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
      e.preventDefault(); dragDepth++;
      if (currentView() !== 'import') show('import');
      dz.classList.add('is-over');
    });
    document.addEventListener('dragover', function (e) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
    document.addEventListener('dragleave', function () { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dz.classList.remove('is-over'); });
    document.addEventListener('drop', function (e) {
      e.preventDefault(); dragDepth = 0; dz.classList.remove('is-over');
      if (!e.dataTransfer) return;
      var grabbed = K.importer.grabDrop(e.dataTransfer);
      if (!grabbed.length) return;
      setImportStatus('Reading dropped files…');
      K.importer.sourcesFromDrop(grabbed).then(processSources, function (err) { setImportStatus(''); toast('Could not read the dropped files: ' + (err.message || err), 'err'); });
    });
    $('#pick-folder').addEventListener('click', function () { $('#in-folder').value = ''; $('#in-folder').click(); });
    $('#pick-files').addEventListener('click', function () { $('#in-files').value = ''; $('#in-files').click(); });
    $('#in-folder').addEventListener('change', function () { processSources(K.importer.sourcesFromFolderInput($('#in-folder').files)); });
    $('#in-files').addEventListener('change', function () { processSources(K.importer.sourcesFromFileInput($('#in-files').files)); });
    $('#import-all').addEventListener('click', addAllReady);
    $('#import-clear').addEventListener('click', function () {
      rows.slice().forEach(function (r) { var s = rowState(r); if (s === 'added' || s === 'error') removeRow(r); });
      setImportStatus('');
    });

    // system
    $('#persist').addEventListener('click', async function () {
      var ok = false;
      try { ok = await navigator.storage.persist(); } catch (e) {}
      toast(ok ? 'Storage protected.' : 'The browser declined for now. It usually agrees after KERFINATOR has been used for a while.', ok ? 'ok' : '');
      renderSystem();
    });
    $('#save-launcher').addEventListener('click', saveLauncher);
    $('#auto-install').addEventListener('change', async function () {
      await K.db.kvSet('autoInstall', $('#auto-install').checked);
      if ($('#auto-install').checked) K.usb.installAll();
    });
    $('#usb-install').addEventListener('click', function () { K.usb.installAll(); });
    $('#backup').addEventListener('click', async function () {
      $('#backup').disabled = true;
      try {
        var blob = await K.backup.create();
        download(blob, 'KERFINATOR-backup-' + new Date().toISOString().slice(0, 10) + '.json');
        toast('Backup saved to your Downloads folder (' + K.formatBytes(blob.size) + ').', 'ok');
      } catch (e) { toast('Backup failed: ' + (e.message || e), 'err'); }
      $('#backup').disabled = false;
      renderSystem();
    });
    $('#restore').addEventListener('click', function () { $('#in-restore').value = ''; $('#in-restore').click(); });
    $('#in-restore').addEventListener('change', async function () {
      var f = $('#in-restore').files[0];
      if (!f) return;
      var a = await ask({ title: 'Restore this backup?', body: 'Saves in the backup replace the current saves of the same games. Favorites, titles and covers are restored; playtime keeps the higher value.', ok: 'Restore' });
      if (!a.ok) return;
      try {
        var res = await K.backup.restore(f);
        await refresh();
        var missing = res.library.filter(function (g) { return !byId[g.id]; }).length;
        toast('Restored data for ' + res.games + ' games (' + res.keys + ' save entries, ' + res.databases + ' save databases).' + (missing ? ' ' + missing + ' of those games are not installed here yet; their saves will be waiting when you add them.' : ''), 'ok', 10000);
        if (res.failed) toast(res.failed + ' save entries did not fit in browser storage.', 'err');
      } catch (e) { toast(e.message || String(e), 'err'); }
    });
    $('#build-usb').addEventListener('click', buildUsb);
    $('#erase').addEventListener('click', eraseAll);

    // live updates from game tabs
    var foldTimer = null;
    window.addEventListener('storage', function (e) {
      if (!e.key) return;
      if (e.key.indexOf('kerf:pt:') === 0) { K.lib.refreshRunning(); clearTimeout(foldTimer); foldTimer = setTimeout(K.lib.foldSessions, 400); }
      if (e.key.indexOf('kerf:diag:') === 0 && openGameId && byId[openGameId]) fillGameDialog(byId[openGameId]);
      if (e.key === 'kerf:shot') refreshSoon();
    });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { K.lib.refreshRunning().then(K.lib.foldSessions); refreshSoon(); } });
    window.addEventListener('focus', K.lib.refreshRunning);
    setInterval(function () { if (document.visibilityState === 'visible') K.lib.refreshRunning(); }, 3000);
    setInterval(function () { if (document.visibilityState === 'visible') K.lib.foldSessions(); }, 30000);
    K.lib.onChange(refreshSoon);
    K.usb.onChange(function (st) {
      renderInstall(st);
      if (currentView() === 'system') renderSystem();
      if (!items.length) renderLibrary();
      if (!st.installing && !$('#strip').hidden) renderStrip();
    });
  }

  async function start() {
    wire();
    try {
      await K.db.open();
    } catch (e) {
      $('#grid').textContent = '';
      var empty = $('#empty');
      empty.hidden = false; empty.textContent = '';
      empty.appendChild(el('h3', { text: 'Browser storage is not available' }));
      empty.appendChild(el('p', { text: (e && e.message ? e.message + ' ' : '') + 'KERFINATOR needs browser storage to keep games. Private/guest windows and some managed browser policies block it. Open KERFINATOR in a normal window of Microsoft Edge or Google Chrome.' }));
      return;
    }
    await K.lib.refreshRunning();
    await K.lib.foldSessions();
    await refresh();
    var cat = await K.usb.detect();
    renderStrip();
    if (cat && await K.db.kvGet('autoInstall', true)) K.usb.installAll();
  }

  return { start: start, toast: toast, show: show, refresh: refresh };
})();
