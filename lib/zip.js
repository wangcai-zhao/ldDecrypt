'use strict';

// 最小化的 ZIP 写入器（store 方式，不压缩），无第三方依赖。
// files: [{ name: string, data: Buffer }]  -> 返回完整的 ZIP Buffer。

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function createZip(files) {
  const enc = (s) => Buffer.from(s, 'utf-8');
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = enc(f.name);
    const data = f.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header sig
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // general purpose flag: UTF-8 names
    local.writeUInt16LE(0, 8);           // compression method: store
    local.writeUInt16LE(0, 10);          // last mod time
    local.writeUInt16LE(0, 12);          // last mod date
    local.writeUInt32LE(crc, 14);        // crc-32
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26); // file name length
    local.writeUInt16LE(0, 28);          // extra field length
    chunks.push(local, nameBuf, data);

    const cdr = Buffer.alloc(46);
    cdr.writeUInt32LE(0x02014b50, 0);    // central dir header sig
    cdr.writeUInt16LE(20, 4);            // version made by
    cdr.writeUInt16LE(20, 6);            // version needed
    cdr.writeUInt16LE(0x0800, 8);        // general purpose flag: UTF-8
    cdr.writeUInt16LE(0, 10);            // compression method: store
    cdr.writeUInt16LE(0, 12);            // last mod time
    cdr.writeUInt16LE(0, 14);            // last mod date
    cdr.writeUInt32LE(crc, 16);          // crc-32
    cdr.writeUInt32LE(data.length, 20);  // compressed size
    cdr.writeUInt32LE(data.length, 24);  // uncompressed size
    cdr.writeUInt16LE(nameBuf.length, 28); // file name length
    cdr.writeUInt16LE(0, 30);            // extra field length
    cdr.writeUInt16LE(0, 32);            // file comment length
    cdr.writeUInt16LE(0, 34);            // disk number start
    cdr.writeUInt16LE(0, 36);            // internal file attributes
    cdr.writeUInt32LE(0, 38);            // external file attributes
    cdr.writeUInt32LE(offset, 42);       // relative offset of local header
    central.push(cdr, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);      // end of central dir sig
  end.writeUInt16LE(0, 4);               // number of this disk
  end.writeUInt16LE(0, 6);               // disk where central dir starts
  end.writeUInt16LE(files.length, 8);    // total entries (this disk)
  end.writeUInt16LE(files.length, 10);   // total entries (overall)
  end.writeUInt32LE(centralBuf.length, 12); // size of central dir
  end.writeUInt32LE(offset, 16);         // offset of central dir
  end.writeUInt16LE(0, 20);              // comment length

  return Buffer.concat([...chunks, centralBuf, end]);
}

module.exports = { createZip };
