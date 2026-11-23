#!/usr/bin/env node
/* KERFINATOR end-to-end test suite (Chromium via Playwright, file:// only).

   Simulates the real lifecycle: a USB drive with the launcher and packed
   games, a fresh browser profile, importing many kinds of game structures,
   launching games in their own tabs, saves, playtime, favorites, backup and
   restore, unplugging the USB and continuing from a copy on the "desktop",
   and the maintainer's USB builder. Any request to the network fails the run.

   Usage:  node tests/e2e.js            (set KERF_TMP to choose the work dir) */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const makeFixtures = require('./make-fixtures');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(process.env.KERF_TMP || os.tmpdir(), 'kerf-e2e-'));
const SHOTS = path.join(TMP, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
let failures = 0, passes = 0;
function ok(cond, name, detail) {
  if (cond) { passes++; console.log('  ✓ ' + name); }
  else { failures++; console.log('  ✗ ' + name + (detail !== undefined ? '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
function section(t) { console.log('\n' + t); }
const fileUrl = (p) => 'file://' + p.split(path.sep).map(encodeURIComponent).join('/').replace(/^%3A/, ':');

(async () => {
  execSync('node tools/build.js', { cwd: ROOT, stdio: 'ignore' });
  // A USB drive: the shipped launcher plus the demo games packed as a USB library.
  const { packGame, writeCatalog } = require(path.join(ROOT, 'tools', 'build.js'));
  const DEMO = path.join(ROOT, 'tests', 'demo-games');
  const USB = path.join(TMP, 'usb', 'KERFINATOR');
  fs.cpSync(path.join(ROOT, 'dist', 'KERFINATOR'), USB, { recursive: true });
  fs.mkdirSync(path.join(USB, 'library'), { recursive: true });
  writeCatalog(path.join(USB, 'library'), fs.readdirSync(DEMO).sort().map((n) => {
    fs.cpSync(path.join(DEMO, n), path.join(USB, 'games', n), { recursive: true });
    return packGame(n, path.join(DEMO, n), path.join(USB, 'library'));
  }));
  const FX = makeFixtures(path.join(TMP, 'fx'));
  const DESKTOP = path.join(TMP, 'desktop');
  fs.mkdirSync(DESKTOP);

  const network = [];
  async function newContext(profile) {
    const ctx = await chromium.launchPersistentContext(path.join(TMP, profile), { acceptDownloads: true, viewport: { width: 1400, height: 900 } });
    await ctx.route(/^(https?|wss?):\/\//, (route) => { network.push(route.request().url()); route.abort(); });
    await ctx.setOffline(true);
    return ctx;
  }
  const ctx = await newContext('profile');
  const errors = [];
  function watch(page, label) {
    page.on('pageerror', (e) => errors.push(label + ': ' + e.message));
    // Resource failures are checked by URL below; these are the ones a test expects.
    page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(label + ' console: ' + m.text()); });
    page.on('requestfailed', (r) => {
      const u = r.url();
      if (/example\.invalid|not-there\.png|missing\.json/.test(u)) return;
      if (/library\/catalog\.js$/.test(u) && /desktop/.test(label)) return; // the computer copy has no USB library next to it
      errors.push(label + ' request failed: ' + u.slice(-90));
    });
  }
  let page = await ctx.newPage();
  watch(page, 'launcher');

  /* ------------------------------------------------------------ */
  section('1. First launch from the USB drive (zero-click install)');
  await page.goto(fileUrl(path.join(USB, 'KERFINATOR.html')));
  await page.waitForFunction(() => document.querySelectorAll('#grid .card').length === 3 && !K.usb.state.installing, null, { timeout: 20000 }).catch(() => {});
  ok((await page.locator('#grid .card').count()) === 3, 'USB games installed automatically');
  ok(await page.locator('#strip').isVisible(), 'USB banner explains how to keep KERFINATOR');
  await page.screenshot({ path: path.join(SHOTS, '01-library-usb.png') });

  /* ------------------------------------------------------------ */
  section('2. Importing');
  await page.click('.tab[data-view=import]');
  async function importFolder(dir) { await page.setInputFiles('#in-folder', dir); }
  const row = (title) => page.locator('.imp', { has: page.locator(`input[value="${title}"]`) });
  async function addRow(title) {
    await row(title).waitFor({ timeout: 10000 });
    await row(title).locator('button', { hasText: 'Add to library' }).click();
    await row(title).locator('.imp-msg.ok').waitFor({ timeout: 15000 });
  }
  await importFolder(path.join(FX, 'kitchen-sink'));
  await addRow('Kitchen Sink Test');
  ok(true, 'folder import (kitchen sink)');
  await importFolder(path.join(FX, 'module-game'));
  await addRow('Module Test');
  ok(true, 'folder import (ES modules)');

  await page.setInputFiles('#in-files', [path.join(FX, 'nested-game.zip'), path.join(FX, 'tiny-game.html')]);
  await row('Nested Zip Game').waitFor({ timeout: 10000 });
  await row('Tiny Single File').waitFor({ timeout: 10000 });
  ok(/game\/index\.html/.test(await row('Nested Zip Game').locator('.imp-meta').innerText()), 'zip: nested start page detected (game/index.html)');
  ok((await row('Nested Zip Game').locator('.imp-cover img').count()) === 1, 'zip: cover image detected (thumbnail.png)');
  await page.click('#import-all');
  await row('Nested Zip Game').locator('.imp-msg.ok').waitFor({ timeout: 15000 });
  await row('Tiny Single File').locator('.imp-msg.ok').waitFor({ timeout: 15000 });
  ok(true, '"Add all" imports .zip and single .html');

  await page.setInputFiles('#in-files', [path.join(FX, 'singles', 'self-writer.html'), path.join(FX, 'singles', 'big-single.html')]);
  await row('Big Single File').waitFor({ timeout: 15000 });
  ok(true, 'title found in a single-file game larger than 8 MB');
  ok((await row('Self Writer').count()) === 1, 'several .html files picked together become separate games');
  await page.click('#import-all');
  await row('Big Single File').locator('.imp-msg.ok').waitFor({ timeout: 20000 });
  await row('Self Writer').locator('.imp-msg.ok').waitFor({ timeout: 20000 });

  await importFolder(path.join(FX, 'ambiguous'));
  const amb = page.locator('.imp.is-choose');
  await amb.waitFor({ timeout: 10000 });
  ok(/Which one starts the game/.test(await amb.innerText()), 'ambiguous start page asks the user');
  const ambRow = page.locator('.imp', { has: page.locator('select option[value="beta.html"]') });
  await ambRow.locator('select').selectOption('beta.html');
  ok((await ambRow.locator('.field input').inputValue()) === 'Beta', 'title follows the chosen start page');
  await ambRow.locator('button', { hasText: 'Add to library' }).click();
  await page.locator('.imp.is-added', { hasText: 'beta.html' }).waitFor({ timeout: 10000 }).catch(() => {});
  ok((await page.locator('.imp.is-added', { has: page.locator('input[value="Beta"]') }).count()) === 1, 'chosen start page is used (title from beta.html)');

  await importFolder(path.join(FX, 'not-a-game'));
  await page.locator('.imp.is-error').waitFor({ timeout: 10000 });
  ok(/No web page/.test(await page.locator('.imp.is-error').innerText()), 'folder without a game gives a clear error');

  await importFolder(path.join(FX, 'collection'));
  await row('Collection One').waitFor({ timeout: 10000 });
  ok((await row('Collection Two').count()) === 1, 'a folder of game folders becomes separate games');
  await page.click('#import-all');
  await row('Collection Two').locator('.imp-msg.ok').waitFor({ timeout: 15000 });

  await importFolder(path.join(FX, 'webgl-shot'));
  await addRow('WebGL Shot Test');
  await importFolder(path.join(FX, 'multipage'));
  await addRow('Multi Page');
  ok(/internet/.test(await row('Multi Page').innerText()), 'warns about online dependencies at import');

  await importFolder(path.join(FX, 'kitchen-sink'));
  await page.locator('.imp.is-duplicate').waitFor({ timeout: 10000 });
  ok(/already in your library/.test(await page.locator('.imp.is-duplicate').innerText()), 'duplicate import detected');

  // drag-and-drop of loose files (synthetic drop)
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['<!DOCTYPE html><title>Dropped Game</title><script>window.__DONE=true;window.__T={drop:"ok"}<\/script>'], 'dropped.html', { type: 'text/html' }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await addRow('Dropped Game');
  ok(true, 'drag-and-drop import');
  await page.screenshot({ path: path.join(SHOTS, '02-import.png'), fullPage: true });

  if (fs.existsSync(path.join(FX, 'phaser-game'))) {
    await importFolder(path.join(FX, 'phaser-game'));
    await addRow('Phaser Engine Test');
    ok(true, 'folder import (Phaser 3 game)');
  } else console.log('  (Phaser not installed: run npm install to include the real-engine test)');

  // a file that cannot be read must fail the import instead of storing an empty file
  const unreadable = await page.evaluate(async () => {
    try {
      await K.importer.commit({ fp: 'f'.repeat(64), size: 75, files: [{ path: 'index.html', file: new Blob(['<title>x</title>']), size: 16 }, { path: 'a.png', file: new Blob([]), size: 75 }], entry: 'index.html', title: 'Unreadable' }, {});
      return 'imported';
    } catch (e) { return e.message + ' | left behind: ' + (await K.db.filesOf('g' + 'f'.repeat(12))).length; }
  });
  ok(/could not be read \(a\.png\).*left behind: 0/.test(unreadable), 'unreadable files fail the import cleanly', unreadable);

  await page.click('#import-clear');
  await page.click('.tab[data-view=library]');
  const total = await page.locator('#grid .card').count();
  const HAS_PHASER = fs.existsSync(path.join(FX, 'phaser-game'));
  const TOTAL = HAS_PHASER ? 16 : 15;
  ok(total === TOTAL, 'library contains all games', total);

  /* ------------------------------------------------------------ */
  section('3. Launching games in their own tab');
  // Close a game tab the way a person does (unload handlers run, so the game records the end of its session).
  async function closeTab(p) { const closed = p.waitForEvent('close'); await p.close({ runBeforeUnload: true }); await closed; }
  async function launch(title, flag = '__DONE') {
    const [gp] = await Promise.all([ctx.waitForEvent('page'), page.click(`#grid .card-hit[aria-label="Play ${title}"]`)]);
    watch(gp, title);
    await gp.waitForFunction((f) => window[f], flag, { timeout: 15000 }).catch(() => {});
    return gp;
  }
  let gp = await launch('Kitchen Sink Test');
  let T = await gp.evaluate(() => window.__T);
  ok(T && Object.keys(T).length >= 23, 'kitchen sink ran all checks', T && Object.keys(T).length);
  for (const [k, v] of Object.entries(T || {})) ok(v === 'ok', 'kitchen: ' + k, v);
  ok(/\?play=g[0-9a-f]{12}&s=/.test(gp.url()), 'game runs in a separate tab with its own URL');
  ok(await gp.evaluate(() => !document.getElementById('app') && !document.querySelector('.top')), 'no launcher UI around the game');
  ok(await gp.evaluate(() => document.fullscreenEnabled), 'game tab can use fullscreen');
  await gp.waitForTimeout(1600);
  ok((await gp.locator('kerf-notice').count()) === 0, 'deliberate probes for missing files (404) raise no warning');
  const kitchenId = new URL(gp.url()).searchParams.get('play');
  await gp.reload();
  await gp.waitForFunction(() => window.__DONE, null, { timeout: 15000 }).catch(() => {});
  ok(await gp.evaluate(() => window.__T && window.__T.fetch === 'ok'), 'reloading a game tab restarts the game');
  await closeTab(gp);

  gp = await launch('Kitchen Sink Test');
  ok((await gp.evaluate(() => [window.__RUNS, window.__IDB])).join() === '3,3', 'saves persist between sessions (localStorage + IndexedDB)', await gp.evaluate(() => [window.__RUNS, window.__IDB]));
  await closeTab(gp);
  const raw = await page.evaluate((id) => ({ ns: localStorage.getItem('kfg:' + id + ':runs'), plain: localStorage.getItem('runs'), cookie: localStorage.getItem('kfc:' + id) }), kitchenId);
  ok(raw.ns === '3' && raw.plain === null, 'game saves are namespaced per game', raw);
  ok(/kc/.test(raw.cookie || ''), 'cookie saves are kept per game');
  ok((await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).some((n) => n === 'kfg:' + kitchenId + ':sinkdb'), 'game databases are namespaced per game');

  gp = await launch('Module Test');
  T = await gp.evaluate(() => window.__T);
  for (const [k, v] of Object.entries(T || { modules: 'did not run' })) ok(v === 'ok', 'modules: ' + k, v);
  await closeTab(gp);

  await page.waitForTimeout(10);
  for (const [title, check] of [['Self Writer', (t) => t.selfWriter === 'ok'], ['Big Single File', (t) => t.big === 'ok'], ['Nested Zip Game', (t) => t.zipScript === 'ok' && t.unicodeNames === 'ok'], ['Tiny Single File', (t) => t.single === 'ok'], ['Beta', (t) => t.page === 'beta'], ['Collection Two', (t) => t.c === 'two'], ['Dropped Game', (t) => t.drop === 'ok']]) {
    gp = await launch(title);
    ok(check((await gp.evaluate(() => window.__T)) || {}), 'launch: ' + title);
    await closeTab(gp);
  }
  if (HAS_PHASER) {
    gp = await launch('Phaser Engine Test');
    T = await gp.evaluate(() => window.__T);
    for (const [k, v] of Object.entries(T || { phaser: 'did not start' })) ok(v === 'ok', 'phaser: ' + k, v);
    await gp.screenshot({ path: path.join(SHOTS, '07-phaser.png') });
    await closeTab(gp);
  }
  for (const [title, flag] of [['Deutsch Destroyer', '__DD_READY'], ['Core Breach', '__CB_READY'], ['Signal Lost', '__SL_READY']]) {
    gp = await launch(title, flag);
    ok(!!(await gp.evaluate((f) => window[f], flag)), 'demo game runs: ' + title);
    await closeTab(gp);
  }

  gp = await launch('Multi Page');
  await gp.locator('kerf-notice').waitFor({ state: 'attached', timeout: 6000 }).catch(() => {});
  ok((await gp.locator('kerf-notice').count()) === 1, 'missing file / online dependency is reported in the game tab');
  await Promise.all([gp.waitForURL(/page=level2\.html/, { timeout: 8000 }).catch(() => {}), gp.click('#next')]);
  await gp.waitForFunction(() => window.__LEVEL2, null, { timeout: 8000 }).catch(() => {});
  ok(!!(await gp.evaluate(() => window.__LEVEL2)), 'links between pages of a game work');
  const multiId = new URL(gp.url()).searchParams.get('play');
  await closeTab(gp);
  const diag = await page.evaluate((id) => JSON.parse(localStorage.getItem('kerf:diag:' + id) || 'null'), multiId);
  ok(diag && diag.missing.includes('img/not-there.png'), 'launcher receives the problem report', diag);

  /* ------------------------------------------------------------ */
  section('4. Playtime, recently played, favorites, search');
  gp = await launch('Signal Lost', '__SL_READY');
  await gp.bringToFront();
  await gp.waitForTimeout(7000);
  await closeTab(gp);
  await page.bringToFront();
  await page.evaluate(() => K.lib.foldSessions());
  const play1 = await page.evaluate(async () => (await K.db.get('user', 'u-signal-lost')).play);
  ok(play1 >= 5000 && play1 < 15000, 'playtime counted while the game was open (~7 s)', play1);
  await page.waitForTimeout(6000);
  await page.evaluate(() => K.lib.foldSessions());
  const play2 = await page.evaluate(async () => (await K.db.get('user', 'u-signal-lost')).play);
  ok(play2 === play1, 'playtime stops when the game tab is closed', [play1, play2]);
  await page.evaluate(() => K.app.refresh());
  ok(await page.locator('#recent').isVisible(), 'recently played shelf is shown');
  ok((await page.locator('#recent-row .card-title').first().innerText()) === 'Signal Lost', 'most recent game is first');

  // A game that is already open is not opened twice by accident
  gp = await launch('Tiny Single File');
  const pagesBefore = ctx.pages().length;
  await page.bringToFront();
  await page.click('#grid .card-hit[aria-label="Play Tiny Single File"]');
  await page.locator('.toast', { hasText: 'already open in another tab' }).waitFor({ timeout: 5000 }).catch(() => {});
  ok((await page.locator('.toast', { hasText: 'already open in another tab' }).count()) === 1 && ctx.pages().length === pagesBefore, 'warns instead of opening a running game twice');
  const [again] = await Promise.all([ctx.waitForEvent('page'), page.locator('.toast-act', { hasText: 'Open anyway' }).click()]);
  ok(!!again, '"Open anyway" still opens it');
  await closeTab(again); await closeTab(gp);
  await page.waitForTimeout(300);
  ok(!(await page.evaluate(() => K.lib.isRunning((window.__tinyId = null) || '')) ) && !(await page.evaluate(async () => K.lib.isRunning((await K.db.getAll('games')).find((g) => g.title === 'Tiny Single File').id))), 'a closed game is not reported as open');
  // a tab that dies without closing normally (crash) is detected through its released lock
  gp = await launch('Tiny Single File');
  await gp.waitForTimeout(500);
  await gp.close();                     // no unload handlers: like a crash
  await page.waitForTimeout(4500);
  await page.evaluate(() => K.lib.refreshRunning());
  ok(!(await page.evaluate(async () => K.lib.isRunning((await K.db.getAll('games')).find((g) => g.title === 'Tiny Single File').id))), 'a crashed game tab is not reported as open');
  await page.evaluate(() => K.lib.foldSessions());

  // Games without cover art get a screenshot from play (WebGL, captured right after a frame)
  const coverBefore = await page.evaluate(async () => { const g = (await K.db.getAll('games')).find((x) => x.title === 'WebGL Shot Test'); return { id: g.id, cover: g.cover }; });
  gp = await launch('WebGL Shot Test');
  await gp.bringToFront();
  await gp.waitForTimeout(34000);
  await closeTab(gp);
  await page.bringToFront();
  const shot = await page.evaluate(async (id) => { const u = await K.db.get('user', id); return u && u.shot ? { size: u.shot.size, type: u.shot.type, stage: u.shotStage } : null; }, coverBefore.id);
  ok(coverBefore.cover === null && shot && shot.size > 2000 && shot.stage === 1, 'a screenshot from play becomes the cover', shot);
  const shown = await page.evaluate(async (id) => { const it = (await K.lib.all()).find((x) => x.id === id); return it.thumb === it.user.shot; }, coverBefore.id);
  ok(shown, 'the library shows the screenshot cover');

  await page.locator('#grid .card', { hasText: 'Core Breach' }).locator('.fav').click();
  await page.waitForTimeout(300);
  await page.reload();
  await page.locator('#grid .card').first().waitFor();
  ok((await page.locator('#grid .card', { hasText: 'Core Breach' }).locator('.fav').getAttribute('aria-pressed')) === 'true', 'favorite persists after reload');
  await page.click('.seg button[data-filter=fav]');
  ok((await page.locator('#grid .card').count()) === 1, 'favorites filter');
  await page.click('.seg button[data-filter=all]');
  await page.fill('#search', 'core');
  ok((await page.locator('#grid .card').count()) === 1, 'search filters as you type');
  await page.fill('#search', 'zzqx');
  ok(/No games match/.test(await page.locator('#empty').innerText()), 'search with no results explains itself');
  await page.fill('#search', '');
  ok((await page.locator('#dg-play').count()) === 1 && (await page.evaluate(() => K.formatDuration(9000))) === 'Under a minute', 'duration formatting');

  // details dialog: playtime display + rename
  await page.locator('#grid .card', { hasText: 'Tiny Single File' }).locator('.more').click();
  await page.fill('#dg-title', 'Tiny Renamed');
  await page.press('#dg-title', 'Enter');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  ok((await page.locator('#grid .card', { hasText: 'Tiny Renamed' }).count()) === 1, 'rename from the details dialog');
  // importing a newer version of a game offers to update it in place
  const tinyBefore = await page.evaluate(async () => (await K.db.getAll('games')).find((g) => g.title === 'Tiny Single File').id);
  await page.click('.tab[data-view=import]');
  await importFolder(path.join(FX, 'tiny-v2'));
  const upd = page.locator('.imp.is-choose', { hasText: 'different version' });
  await upd.waitFor({ timeout: 10000 });
  await upd.locator('button', { hasText: 'Update existing' }).click();
  await page.locator('.imp.is-added').last().waitFor({ timeout: 10000 });
  await page.click('#import-clear');
  await page.click('.tab[data-view=library]');
  const tinyAfter = await page.evaluate(async () => (await K.db.getAll('games')).filter((g) => g.title === 'Tiny Single File').map((g) => g.id));
  ok(tinyAfter.length === 1 && tinyAfter[0] === tinyBefore && (await page.locator('#grid .card', { hasText: 'Tiny Renamed' }).count()) === 1, 'updating a game keeps its identity, custom title and saves', tinyAfter);
  gp = await launch('Tiny Renamed');
  ok((await gp.evaluate(() => window.__T.version)) === 2, 'updated game runs the new version');
  await closeTab(gp);

  // a changed game on the USB drive updates in place on next launch, keeping playtime
  const sl2 = path.join(TMP, 'signal-lost-v2');
  fs.cpSync(path.join(DEMO, 'signal-lost'), sl2, { recursive: true });
  fs.appendFileSync(path.join(sl2, 'signal-lost.html'), '\n<!-- v2 -->\n');
  const entry2 = packGame('signal-lost', sl2, path.join(USB, 'library'));
  const catFile = path.join(USB, 'library', 'catalog.js');
  const catText = fs.readFileSync(catFile, 'utf8');
  const cat = JSON.parse(catText.slice(catText.indexOf('(') + 1, catText.lastIndexOf(')')));
  const oldFp = cat.games.find((g) => g.key === 'signal-lost').fp;
  cat.games = cat.games.map((g) => (g.key === 'signal-lost' ? entry2 : g));
  fs.writeFileSync(catFile, 'KERFINATOR_CATALOG(' + JSON.stringify(cat) + ');');
  await page.reload();
  for (let i = 0; i < 60; i++) {
    const g = await page.evaluate(() => K.db.get('games', 'u-signal-lost'));
    if (g && g.fp === entry2.fp && !g.installing) break;
    await page.waitForTimeout(250);
  }
  const slNow = await page.evaluate(async () => ({ g: await K.db.get('games', 'u-signal-lost'), u: await K.db.get('user', 'u-signal-lost') }));
  ok(slNow.g.fp === entry2.fp && slNow.g.fp !== oldFp && slNow.u.play === play1, 'changed USB game is updated in place; playtime kept');
  await page.locator('#grid .card').first().waitFor();

  await page.screenshot({ path: path.join(SHOTS, '03-library-full.png') });
  await page.locator('#grid .card', { hasText: 'Signal Lost' }).locator('.more').click();
  await page.waitForTimeout(250);
  ok(/s|min/.test(await page.locator('#dg-play').innerText()), 'details show playtime', await page.locator('#dg-play').innerText());
  await page.screenshot({ path: path.join(SHOTS, '04-details.png') });
  await page.keyboard.press('Escape');

  /* ------------------------------------------------------------ */
  section('5. Backup and restore');
  await page.click('.tab[data-view=system]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '05-system.png'), fullPage: true });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#backup')]);
  const backupPath = path.join(TMP, 'backup.json');
  await dl.saveAs(backupPath);
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  ok(backup.kerfinator === 'backup' && backup.local['kfg:' + kitchenId + ':runs'] === '3', 'backup contains save data', Object.keys(backup.local).length);
  ok(backup.idb.some((d) => d.name === 'kfg:' + kitchenId + ':sinkdb'), 'backup contains game databases');
  await page.evaluate(async (id) => { await K.lib.wipeSaves(id); await K.db.updateUser('u-core-breach', (u) => { u.fav = false; }); }, kitchenId);
  await page.setInputFiles('#in-restore', backupPath);
  await page.click('#cf-ok');
  await page.locator('.toast.ok', { hasText: 'Restored' }).waitFor({ timeout: 10000 });
  await page.click('.tab[data-view=library]');
  ok((await page.locator('#grid .card', { hasText: 'Core Breach' }).locator('.fav').getAttribute('aria-pressed')) === 'true', 'restore brings back favorites');
  gp = await launch('Kitchen Sink Test');
  ok((await gp.evaluate(() => [window.__RUNS, window.__IDB])).join() === '4,4', 'restore brings back localStorage and IndexedDB saves', await gp.evaluate(() => [window.__RUNS, window.__IDB]));
  await closeTab(gp);

  /* ------------------------------------------------------------ */
  section('6. Unplugging the USB and playing from a copy on this computer');
  // The "Save to this computer" button writes K.SOURCE; check it is the same as the file.
  const saved = await page.evaluate(() => K.SOURCE);
  ok(saved.length > 100000 && saved.includes('KERF_RUNTIME') && !saved.includes('k-play"'), 'launcher can reproduce itself for saving');
  fs.writeFileSync(path.join(DESKTOP, 'KERFINATOR.html'), saved);
  await page.close();
  fs.rmSync(path.join(TMP, 'usb'), { recursive: true, force: true });
  page = await ctx.newPage();
  watch(page, 'desktop launcher');
  await page.goto(fileUrl(path.join(DESKTOP, 'KERFINATOR.html')));
  await page.locator('#grid .card').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  ok((await page.locator('#grid .card').count()) === TOTAL, 'all games still in the library without the USB', await page.locator('#grid .card').count());
  ok(!(await page.locator('#strip').isVisible()), 'no USB banner on the computer copy');
  gp = await launch('Core Breach', '__CB_READY');
  ok(!!(await gp.evaluate(() => window.__CB_READY)), 'USB game plays with the USB removed');
  await closeTab(gp);
  gp = await launch('Kitchen Sink Test');
  T = await gp.evaluate(() => window.__T);
  ok(T && Object.values(T).every((v) => v === 'ok') && (await gp.evaluate(() => window.__RUNS)) === 5, 'imported game plays with all assets and saves');
  await closeTab(gp);

  /* ------------------------------------------------------------ */
  section('7. Maintainer: Build USB library');
  const readTree = (dir, base = '') => fs.readdirSync(dir).flatMap((n) => {
    const full = path.join(dir, n), rel = base ? base + '/' + n : n;
    return fs.statSync(full).isDirectory() ? readTree(full, rel) : [[rel, fs.readFileSync(full).toString('base64')]];
  });
  const srcGames = {};
  for (const g of ['kitchen-sink', 'module-game', 'ambiguous', 'not-a-game']) srcGames[g] = readTree(path.join(FX, g));
  srcGames['deutsch-destroyer'] = readTree(path.join(DEMO, 'deutsch-destroyer'));
  const built = await page.evaluate(async (games) => {
    // In-memory stand-in for the folder the maintainer picks with showDirectoryPicker()
    // (the real picker needs a person; the builder only uses the standard handle methods).
    const nf = () => new DOMException('Not found', 'NotFoundError');
    function mkFile(name) {
      return { kind: 'file', name, data: new Blob([]), async getFile() { return new File([this.data], name); },
        async createWritable() { const parts = [], self = this; return { async write(x) { parts.push(x); }, async close() { self.data = new Blob(parts); } }; } };
    }
    function mkDir(name) {
      return { kind: 'directory', name, children: new Map(),
        async getDirectoryHandle(n, o) { let c = this.children.get(n); if (!c) { if (!(o && o.create)) throw nf(); c = mkDir(n); this.children.set(n, c); } return c; },
        async getFileHandle(n, o) { let c = this.children.get(n); if (!c) { if (!(o && o.create)) throw nf(); c = mkFile(n); this.children.set(n, c); } return c; },
        async removeEntry(n) { this.children.delete(n); },
        async *entries() { for (const e of [...this.children]) yield e; } };
    }
    const usb = mkDir('KERFINATOR');
    const gdir = await usb.getDirectoryHandle('games', { create: true });
    for (const [name, files] of Object.entries(games)) {
      const gd = await gdir.getDirectoryHandle(name, { create: true });
      for (const [p, b64] of files) {
        const parts = p.split('/'); let d = gd;
        for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create: true });
        const fh = await d.getFileHandle(parts.at(-1), { create: true }), w = await fh.createWritable();
        await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); await w.close();
      }
    }
    const log = [];
    const out = await K.usb.build(usb, (m) => log.push(m));
    const out2log = []; await K.usb.build(usb, (m) => out2log.push(m)); // second run: nothing re-packed
    const files = [];
    async function walk(d, pre) { for await (const [n, h] of d.entries()) { if (h.kind === 'directory') await walk(h, pre + n + '/'); else files.push([pre + n, await (await h.getFile()).text()]); } }
    await walk(await usb.getDirectoryHandle('library'), '');
    return { count: out.length, log: log.map((l) => l.type + ': ' + l.text), log2: out2log.map((l) => l.type + ': ' + l.text), files };
  }, srcGames);
  ok(built.count === 4, 'builder packed the 4 valid games', built.count);
  ok(built.log.some((l) => /not-a-game: skipped/.test(l)), 'builder skips folders that are not games');
  ok(built.log.some((l) => /ambiguous: several possible start pages/.test(l)), 'builder warns about ambiguous start pages');
  ok(built.log2.filter((l) => /unchanged/.test(l)).length === 4, 'rebuilding skips unchanged games');
  const USB2 = path.join(TMP, 'usb2', 'KERFINATOR');
  for (const [p, text] of built.files) { fs.mkdirSync(path.dirname(path.join(USB2, 'library', p)), { recursive: true }); fs.writeFileSync(path.join(USB2, 'library', p), text); }
  fs.writeFileSync(path.join(USB2, 'KERFINATOR.html'), saved);
  const ctx2 = await newContext('profile2');
  const p2 = await ctx2.newPage();
  watch(p2, 'second laptop');
  await p2.goto(fileUrl(path.join(USB2, 'KERFINATOR.html')));
  await p2.waitForFunction(() => document.querySelectorAll('#grid .card').length === 4 && !K.usb.state.installing, null, { timeout: 20000 }).catch(() => {});
  ok((await p2.locator('#grid .card').count()) === 4, 'a drive built in the browser auto-installs on another laptop');
  const [g2] = await Promise.all([ctx2.waitForEvent('page'), p2.click('#grid .card-hit[aria-label="Play Kitchen Sink Test"]')]);
  await g2.waitForFunction(() => window.__DONE, null, { timeout: 15000 }).catch(() => {});
  const T2 = await g2.evaluate(() => window.__T);
  ok(T2 && Object.values(T2).every((v) => v === 'ok'), 'builder output runs every kitchen-sink check', T2);
  await p2.setViewportSize({ width: 390, height: 844 });
  await p2.bringToFront();
  await p2.screenshot({ path: path.join(SHOTS, '06-phone-width.png'), fullPage: true });
  await ctx2.close();

  /* ------------------------------------------------------------ */
  section('8. Offline, privacy and errors');
  const launcherRequests = network.filter((u) => !/example\.invalid/.test(u));
  ok(launcherRequests.length === 0, 'KERFINATOR made no network requests', launcherRequests);
  ok(network.some((u) => /example\.invalid/.test(u)) , 'the test game’s own online request was blocked (expected)');
  ok(errors.length === 0, 'no unexpected errors in any tab', errors.slice(0, 8));

  // removing a game keeps its saves unless asked
  await page.bringToFront();
  await page.locator('#grid .card', { hasText: 'Collection One' }).locator('.more').click();
  await page.click('#dg-remove');
  await page.click('#cf-ok');
  await page.waitForTimeout(500);
  ok((await page.locator('#grid .card', { hasText: 'Collection One' }).count()) === 0, 'remove a game');

  await ctx.close();
  console.log('\n' + passes + ' passed, ' + failures + ' failed.  Screenshots: ' + SHOTS);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
