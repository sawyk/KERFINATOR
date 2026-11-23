/* KERFINATOR core: namespace, small utilities, MIME table. */
'use strict';
var K = window.K = {
  VERSION: '1.1.0',
  // Captured before the launcher touches the DOM: the exact source of this
  // file, used by "Save to this computer".
  SOURCE: '<!DOCTYPE html>\n' + document.documentElement.outerHTML
};

K.uid = function (prefix) {
  var a = new Uint8Array(8); crypto.getRandomValues(a);
  return (prefix || '') + Date.now().toString(36) + Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('').slice(0, 10);
};

K.launcherUrl = function () { return location.href.split(/[?#]/)[0]; };
K.launcherDir = function () { var u = K.launcherUrl(); return u.slice(0, u.lastIndexOf('/') + 1); };
K.launcherFile = function () { var u = K.launcherUrl(); return decodeURIComponent(u.slice(u.lastIndexOf('/') + 1)); };

K.ext = function (path) {
  var b = String(path).toLowerCase().split('/').pop();
  var i = b.lastIndexOf('.');
  return i < 0 ? '' : b.slice(i + 1);
};

K.MIME = {
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  json: 'application/json', map: 'application/json', css: 'text/css', txt: 'text/plain', xml: 'application/xml',
  csv: 'text/csv', md: 'text/plain', glsl: 'text/plain', vert: 'text/plain', frag: 'text/plain', tmx: 'application/xml',
  tsx: 'application/xml', fnt: 'text/plain', atlas: 'text/plain', yaml: 'text/plain', yml: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', cur: 'image/x-icon',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac', weba: 'audio/webm', mid: 'audio/midi', midi: 'audio/midi',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', eot: 'application/vnd.ms-fontobject',
  zip: 'application/zip', pdf: 'application/pdf'
};
K.mimeOf = function (path) {
  var p = String(path).toLowerCase().replace(/\.(gz|br)$/, '');
  return K.MIME[K.ext(p)] || 'application/octet-stream';
};
K.IMAGE_EXT = /^(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/;
K.isImage = function (p) { return K.IMAGE_EXT.test(K.ext(p)); };
K.isHTML = function (p) { return /^(html?|xhtml)$/.test(K.ext(p)); };

K.formatBytes = function (n) {
  if (!isFinite(n) || n < 0) return '—';
  var u = ['bytes', 'KB', 'MB', 'GB', 'TB'], i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
};
K.formatDuration = function (ms) {
  if (!ms || ms < 60000) return ms && ms >= 1000 ? 'Under a minute' : 'Not played yet';
  var m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  if (h === 0) return m + ' min';
  return h + ' h ' + (m % 60) + ' min';
};
K.formatAgo = function (t) {
  if (!t) return 'Never';
  var s = (Date.now() - t) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
  return new Date(t).toLocaleDateString();
};

K.sha256 = async function (data) {
  var buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  var h = await crypto.subtle.digest('SHA-256', buf);
  return Array.prototype.map.call(new Uint8Array(h), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
};

K.slugify = function (s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'game';
};

K.prettyName = function (name) {
  var s = String(name).replace(/\.(zip|html?)$/i, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s && s === s.toLowerCase()) s = s.replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  return s || 'Untitled game';
};

// Base64 helpers that stay fast for large binaries.
K.b64encode = function (u8) {
  var out = '', CH = 0x8000;
  for (var i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(out);
};
K.b64decode = function (s) {
  var bin = atob(s), u8 = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
};
K.blobToBase64 = function (blob) {
  return new Promise(function (res, rej) {
    var fr = new FileReader();
    fr.onload = function () { var s = String(fr.result); res(s.slice(s.indexOf(',') + 1)); };
    fr.onerror = function () { rej(fr.error); };
    fr.readAsDataURL(blob);
  });
};

// Read the text of an HTML file, honouring a legacy <meta charset>.
K.readHTMLText = async function (blob) {
  var head = new Uint8Array(await blob.slice(0, 2048).arrayBuffer());
  var sniff = new TextDecoder('latin1').decode(head);
  var m = /<meta[^>]+charset\s*=\s*["']?([\w\-]+)/i.exec(sniff);
  var cs = m ? m[1].toLowerCase() : 'utf-8';
  if (cs !== 'utf-8' && cs !== 'utf8') {
    try { return new TextDecoder(cs).decode(await blob.arrayBuffer()); } catch (e) { /* unknown label */ }
  }
  return blob.text();
};

K.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

K.loadScript = function (src) {
  return new Promise(function (res, rej) {
    var s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = function () { s.remove(); res(); };
    s.onerror = function () { s.remove(); rej(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  });
};
