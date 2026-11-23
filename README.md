# KERFINATOR

**Down with Deutsch.**

An offline HTML5 game library that lives on a USB drive, needs no installation, no admin rights and no internet, and keeps working after the USB drive is unplugged.

The ready-to-copy launcher is in **[`dist/KERFINATOR/`](dist/KERFINATOR)** (no games included). Copy that whole folder to a USB drive, put game folders in `games/`, then open `KERFINATOR.html` → Settings → Advanced → **Build USB library**. End-user instructions are in [`READ ME FIRST.txt`](docs/READ%20ME%20FIRST.txt).

```
KERFINATOR/
  KERFINATOR.html      ← open this (the entire app: one self-contained file)
  READ ME FIRST.txt
  games/               ← one folder per game (a cover.png/.jpg next to it becomes its cover)
  library/             ← generated "USB library" (auto-installs on any laptop)
```

To build a complete USB folder from a folder of games on your own computer (developer tool, needs Node.js):

```bash
node tools/build.js --games my-games --out build/KERFINATOR
```

`my-games/` and `build/` are git-ignored: games stay on your computer and are never pushed to the repository.

---

## How it works (and why)

A web page opened from a file (`file://`) runs under strict browser rules. Every design decision below follows from what Chromium actually allows there. Each was verified by experiment before it was built on.

| Need | What the browser allows from `file://` | What KERFINATOR does |
|---|---|---|
| Read game files next to the launcher | `fetch()`/XHR of `file://` are **blocked**; directory listing is impossible. `<script src>` of neighbouring files **is** allowed. | The USB carries games pre-packed as script files (`library/`). They install with **zero clicks** on first open. |
| Keep games after the USB is removed | IndexedDB and localStorage work on `file://`, and Chromium gives **all `file://` pages one shared storage area** per browser profile. | Games are stored in IndexedDB. Any copy of `KERFINATOR.html` on that computer (USB, Desktop, Downloads) sees the same library. "Save to this computer" writes a copy. |
| Run multi-file games | No Service Worker, no local server. Blob URLs work (fetch, XHR, workers, WebGL textures, no canvas tainting) but are not hierarchical. | Each game runs in its own tab through a **compatibility runtime** that maps every relative path to the right stored file. |
| Separate tab, independent fullscreen | `window.open` from a click works; the new tab is a normal top-level page. | `KERFINATOR.html?play=<id>` turns itself into the game (`document.open/write`). There's no wrapper UI, so F11 and the game's own fullscreen work as usual. |
| Game saves | Storage works, but is shared by every `file://` page. | Each game's localStorage keys, IndexedDB databases and cookies are transparently **namespaced per game**. |

### The game runtime (`src/js/10-runtime.js`)

This is injected as the first script of every game page (and into its Workers). It provides:

- **Static rewriting.** HTML attributes (`src`, `href` on `<link>`, `srcset`, `poster`, inline styles), CSS `url()`/`@import`, and ES-module specifiers via a generated import map (including `import.meta.url` and the game's own import maps). This uses a lossless text rewriter, so unusual but working markup survives.
- **Live interception.** `fetch` (including HEAD and 404 for missing files), `XMLHttpRequest`, element `src`/`href` setters, `setAttribute`, `innerHTML`/`insertAdjacentHTML`, `element.style` URL properties, `new Audio()`, `FontFace`, `Worker` (files handed over as Blobs, because workers get their own opaque origin), `document.write`, `window.open`, links between game pages, and `history.pushState`.
- **Tolerant path lookup.** Lookup is exact, then case-insensitive (many games are authored on Windows), then by unique suffix. `document.currentScript.src` reads back as a hierarchical virtual URL, so Emscripten/Unity/Godot base-path logic works.
- **Engine compatibility.** Unity-style `*.gz` builds are decompressed as a web server would. `location.protocol` checks that refuse `file:` see `https:`.
- **Saves.** Per-game namespacing of storage, IndexedDB and emulated cookies.
- **Playtime.** Counted only while the game tab is visible, and never after it closes.
- **Automatic covers.** Games without cover art get a real screenshot after 30 s and 2.5 min of visible play (captured right after a frame, so WebGL works), checked so blank or loading screens aren't used.
- **One copy at a time.** Each game tab holds a Web Lock, so KERFINATOR knows exactly which games are open (even after a crash) and warns before opening a second copy that could overwrite progress.
- **Diagnostics.** If a game is missing files, tries to reach the internet, or needs a server-only feature, a small notice appears in the game tab and the launcher shows the details.

### Verified (automated test suite)

`npm test` runs `tests/e2e.js` on real Chromium against `file://` with the network blocked. **116 checks** cover:

- Zero-click USB install.
- Import of folders, `.zip` archives (nested wrapper folder, Unicode names), single `.html` files (including several picked at once, and self-unpacking single-file packs over 8 MB), drag-and-drop and folder collections.
- Start-page and cover detection, ambiguous start pages, invalid folders, duplicates, unreadable files, and updating a game in place.
- Launching in a separate tab, and reload.
- Every loading path above, including WebGL textures, Web Audio, WASM streaming, workers with `importScripts`, ES modules with import maps and dynamic imports, gzip builds, and links between game pages.
- **A real Phaser 3 game** (WebGL renderer, loader, spritesheets, audio).
- Save persistence and per-game isolation (localStorage, IndexedDB, cookies).
- Playtime accuracy (counts while open, stops when closed); running-game detection, including crashed tabs; screenshot covers from a WebGL game.
- Recently played, favorites, search and renaming.
- Backup and restore of saves (including IndexedDB values with `Date`/`Uint8Array`).
- **Deleting the USB drive and continuing from a Desktop copy.**
- The maintainer's USB builder, end-to-end on a second "laptop" profile.
- Zero network requests made by KERFINATOR.

Performance check: a 2,000-file game with a 120 MB data file imported in under 2 s, and launched and verified byte-exact in 1.7 s. As a USB pack (23 chunks) it auto-installed in 4.6 s.

Not automatable, therefore not verified by the suite: the native folder picker of **Build USB library** (`showDirectoryPicker`). The builder logic itself is tested with an equivalent directory handle. Edge and Chrome share the Chromium engine the tests run on. Other browsers (Firefox) are not targeted: they isolate each `file://` folder's storage, which defeats unplug-and-continue.

---

## Limits to know (honest list)

- **Storage is per browser profile.** Edge and Chrome, different Windows accounts, or different browser profiles each have their own library. A new computer needs the USB once (or an import), plus a backup restore for saves.
- **Clearing site data / private windows** delete the library. KERFINATOR requests persistent storage and offers backups. Restored saves re-attach to games automatically because game ids derive from game content.
- **Isolation between games is by naming, not a security boundary.** Every `file://` page shares one storage origin in Chromium, so true per-game origins are impossible without a web server. Namespacing prevents games from colliding with or overwriting each other's saves (or KERFINATOR's data). A deliberately malicious game could still read them, so import games only from trusted sources. Game tabs are opened without a handle to the launcher.
- **Some games cannot run offline from a file:** anything that needs online services, and builds that require cross-origin isolation (`SharedArrayBuffer`: multi-threaded Godot 4 / Unity exports). KERFINATOR detects and reports these.
- `localStorage` space (~10 MB) is shared by all games; IndexedDB space is large (a share of free disk).
- Building the USB library needs Edge or Chrome (File System Access API) and the KERFINATOR folder to be inside a folder on the drive, not the drive's root.

---

## Maintaining the library

- **On the USB:** put each game in its own folder under `games/`, then **Settings → Advanced → Build USB library**. Re-run after any change; unchanged games are skipped. Optional `kerf.json` per game: `{"title": "…", "entry": "index.html", "cover": "cover.png"}`.
- **On one computer:** the **Import** tab (drag and drop, or the buttons).
- No code changes or rebuilds are ever needed to add games.

## Developing KERFINATOR itself

The launcher is plain JavaScript/CSS with no frameworks or runtime dependencies, split into readable modules under `src/`:

| File | Role |
|---|---|
| `src/index.html`, `src/styles.css` | markup and styles (embedded Chakra Petch font, OFL) |
| `js/00-core.js` | namespace, utilities, MIME table |
| `js/10-runtime.js` | the in-game compatibility runtime (self-contained) |
| `js/20-db.js` | IndexedDB layer |
| `js/30-zip.js` | ZIP reader (native `DecompressionStream`) |
| `js/40-analyze.js` | start page / title / cover / duplicate detection |
| `js/50-thumbs.js` | cover thumbnails and generated covers |
| `js/60-importer.js`, `js/65-library.js` | importing; library, playtime, saves |
| `js/70-usb.js` | USB auto-install and USB library builder |
| `js/75-backup.js` | backup / restore |
| `js/80-player.js` | game-tab bootstrap |
| `js/90-app.js`, `js/99-boot.js` | launcher UI and entry point |

```bash
node tools/build.js    # → dist/KERFINATOR (single-file launcher + demo games + USB library)
npm install            # dev only: Phaser, for the real-engine test
npm test               # end-to-end suite (Playwright + Chromium)
```

`tests/demo-games/` holds three small original games (*Deutsch Destroyer*, *Core Breach*, *Signal Lost*) used by the test suite as a USB library; `tools/gen-demo-assets.js` regenerates their sound and sprite files. Each uses a different structure (classic scripts plus assets; ES modules plus import map plus IndexedDB; single file).
