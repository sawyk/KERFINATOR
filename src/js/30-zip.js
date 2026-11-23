/* Minimal ZIP reader (stored + deflate, ZIP64 aware). Uses the browser's
   native DecompressionStream, so nothing is bundled and nothing is slow.
   Entries are read lazily from slices of the original File. */
K.zip = (function () {
  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }
  function u64(dv, o) { return dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296; }

  async function read(file) {
    var size = file.size;
    if (size < 22) throw new Error('This .zip file is empty or damaged.');
    var tailLen = Math.min(size, 65557 + 20);
    var tail = new DataView(await file.slice(size - tailLen).arrayBuffer());
    var eocd = -1;
    for (var i = tail.byteLength - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('This file is not a valid .zip archive.');
    var count = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOff = u32(tail, eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      var loc = eocd - 20;
      if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
        var z64off = u64(tail, loc + 8);
        var z = new DataView(await file.slice(z64off, z64off + 56).arrayBuffer());
        if (u32(z, 0) === 0x06064b50) { count = u64(z, 32); cdSize = u64(z, 40); cdOff = u64(z, 48); }
      }
    }
    var cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
    var entries = [], p = 0, utf8 = new TextDecoder('utf-8');
    while (p + 46 <= cd.byteLength && u32(cd, p) === 0x02014b50) {
      var flags = u16(cd, p + 8), method = u16(cd, p + 10);
      var csize = u32(cd, p + 20), usize = u32(cd, p + 24);
      var nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32);
      var lho = u32(cd, p + 42);
      var name = utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen));
      var x = p + 46 + nlen, xend = x + xlen;
      while (x + 4 <= xend) {
        var id = u16(cd, x), len = u16(cd, x + 2), q = x + 4;
        if (id === 0x0001) {
          if (usize === 0xffffffff) { usize = u64(cd, q); q += 8; }
          if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; }
          if (lho === 0xffffffff) { lho = u64(cd, q); q += 8; }
        }
        x += 4 + len;
      }
      p = xend + clen;
      if (/\/$/.test(name)) continue;
      entries.push({ name: name.replace(/\\/g, '/'), method: method, csize: csize, usize: usize, offset: lho, encrypted: !!(flags & 1) });
    }
    return entries;
  }

  async function extract(file, e) {
    if (e.encrypted) throw new Error('"' + e.name + '" is password-protected. Extract the archive first, then import the folder.');
    var lh = new DataView(await file.slice(e.offset, e.offset + 30).arrayBuffer());
    if (u32(lh, 0) !== 0x04034b50) throw new Error('The .zip archive is damaged near "' + e.name + '".');
    var start = e.offset + 30 + u16(lh, 26) + u16(lh, 28);
    var raw = file.slice(start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8) {
      var stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return await new Response(stream).blob();
    }
    throw new Error('"' + e.name + '" uses a compression method this browser cannot read. Re-create the .zip with standard settings, or extract it and import the folder.');
  }

  // → [{path, file: Blob, size}]
  async function unpack(file, onProgress) {
    var entries = await read(file), out = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i.test(e.name)) continue;
      var blob = await extract(file, e);
      out.push({ path: e.name, file: blob, size: blob.size });
      if (onProgress && i % 25 === 0) onProgress(i / entries.length);
    }
    return out;
  }
  return { read: read, unpack: unpack };
})();
