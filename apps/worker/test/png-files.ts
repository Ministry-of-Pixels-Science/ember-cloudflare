// PNGs that any decoder reads, as large as their pixels: zlib's stored blocks hold the pixels as they are,
// three bytes each, so one is as large as a detailed screenshot of its size, where a test needs a picture
// too large to show by itself that Cloudflare Images can still make a preview of.

const encoder = new TextEncoder();

/** The table of CRC-32's remainders, which a PNG's chunks are checked with. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Adler-32, which a zlib stream ends with. */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A chunk of `type` holding `data`, with its length first and its CRC last. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(12 + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(encoder.encode(type), 4);
  bytes.set(data, 8);
  view.setUint32(8 + data.length, crc32(bytes.subarray(4, 8 + data.length)));
  return bytes;
}

/** `data` as a zlib stream of stored blocks, which hold at most 65,535 bytes each. */
function stored(data: Uint8Array): Uint8Array {
  const most = 65_535;
  const blocks = Math.max(1, Math.ceil(data.length / most));
  const bytes = new Uint8Array(2 + 5 * blocks + data.length + 4);
  const view = new DataView(bytes.buffer);
  bytes.set([0x78, 0x01]);
  let at = 2;
  for (let n = 0; n < blocks; n++) {
    const block = data.subarray(n * most, (n + 1) * most);
    view.setUint8(at, n === blocks - 1 ? 1 : 0);
    view.setUint16(at + 1, block.length, true);
    view.setUint16(at + 3, ~block.length & 0xffff, true);
    bytes.set(block, at + 5);
    at += 5 + block.length;
  }
  view.setUint32(at, adler32(data));
  return bytes;
}

/** An RGB PNG `width` by `height` whose rows go from black to white, stored rather than compressed. */
export function storedPng(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  // Each row starts with its filter, 0 for none.
  const row = 1 + 3 * width;
  const pixels = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) pixels.fill(Math.floor((255 * y) / Math.max(1, height - 1)), y * row + 1, (y + 1) * row);
  const chunks = [chunk("IHDR", header), chunk("IDAT", stored(pixels)), chunk("IEND", new Uint8Array())];
  const bytes = new Uint8Array(8 + chunks.reduce((length, part) => length + part.length, 0));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  chunks.reduce((at, part) => (bytes.set(part, at), at + part.length), 8);
  return bytes;
}
