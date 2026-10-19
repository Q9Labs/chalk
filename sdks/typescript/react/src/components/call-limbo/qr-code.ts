/** Byte-mode Model 2 QR, Low ECC, mask 0. Invite tokens never leave the call page.
 * Block parameters follow ISO/IEC 18004 (also documented by Project Nayuki's QR generator).
 */
export function inviteQR(text: string): readonly (readonly boolean[])[] | null {
  const bytes = new TextEncoder().encode(text);
  const config = [
    { version: 5, capacity: 106, dataCount: 108, eccCount: 26, blockCount: 1, alignment: [6, 30] },
    { version: 11, capacity: 321, dataCount: 324, eccCount: 20, blockCount: 4, alignment: [6, 30, 54] },
    { version: 20, capacity: 858, dataCount: 861, eccCount: 28, blockCount: 8, alignment: [6, 34, 62, 90] },
  ].find((candidate) => bytes.length <= candidate.capacity);
  if (!config) return null;
  const { version, dataCount, eccCount, blockCount, alignment } = config;
  const bits: number[] = [];
  const append = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(4, 4);
  append(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, dataCount * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, b) => n * 2 + b, 0));
  for (let pad = 0; data.length < dataCount; pad++) data.push(pad % 2 ? 0x11 : 0xec);
  const multiply = (a: number, b: number) => {
    let result = 0;
    for (let i = 7; i >= 0; i--) {
      result = (result << 1) ^ ((result >>> 7) * 0x11d);
      result ^= ((b >>> i) & 1) * a;
    }
    return result;
  };
  const divisor = Array<number>(eccCount).fill(0);
  divisor[eccCount - 1] = 1;
  let root = 1;
  for (let i = 0; i < eccCount; i++) {
    for (let j = 0; j < eccCount; j++) divisor[j] = multiply(divisor[j] ?? 0, root) ^ (divisor[j + 1] ?? 0);
    root = multiply(root, 2);
  }
  const shortDataCount = Math.floor(dataCount / blockCount);
  const shortBlocks = blockCount - (dataCount % blockCount);
  const blocks: { data: number[]; ecc: number[] }[] = [];
  let dataOffset = 0;
  for (let block = 0; block < blockCount; block++) {
    const length = shortDataCount + (block < shortBlocks ? 0 : 1);
    const blockData = data.slice(dataOffset, dataOffset + length);
    dataOffset += length;
    const ecc = Array<number>(eccCount).fill(0);
    for (const byte of blockData) {
      const factor = byte ^ (ecc.shift() ?? 0);
      ecc.push(0);
      for (let i = 0; i < eccCount; i++) ecc[i] = (ecc[i] ?? 0) ^ multiply(divisor[i] ?? 0, factor);
    }
    blocks.push({ data: blockData, ecc });
  }
  const codewords: number[] = [];
  for (let i = 0; i <= shortDataCount; i++)
    for (const block of blocks) {
      const value = block.data[i];
      if (value !== undefined) codewords.push(value);
    }
  for (let i = 0; i < eccCount; i++)
    for (const block of blocks) {
      const value = block.ecc[i];
      if (value !== undefined) codewords.push(value);
    }
  const payload: number[] = [];
  for (const byte of codewords) for (let i = 7; i >= 0; i--) payload.push((byte >>> i) & 1);
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const reserved = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    const row = modules[y],
      mask = reserved[y];
    if (row && mask && x >= 0 && x < size) {
      row[x] = dark;
      mask[x] = true;
    }
  };
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    if (cx === undefined || cy === undefined) continue;
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
  }
  for (let i = 8; i < size - 8; i++) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }
  for (const [iy, cy] of alignment.entries())
    for (const [ix, cx] of alignment.entries()) {
      if ((ix === 0 && iy === 0) || (ix === 0 && iy === alignment.length - 1) || (ix === alignment.length - 1 && iy === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  if (version >= 7) {
    let check = version;
    for (let i = 0; i < 12; i++) check = (check << 1) ^ ((check >>> 11) * 0x1f25);
    const versionBits = (version << 12) | check;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3),
        b = Math.floor(i / 3),
        dark = ((versionBits >>> i) & 1) !== 0;
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  const format = (value: number) => {
    const bit = (i: number) => ((value >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  let check = 8;
  for (let i = 0; i < 10; i++) check = (check << 1) ^ ((check >>> 9) * 0x537);
  format(((8 << 10) | check) ^ 0x5412);
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (!reserved[y]?.[x]) {
          const row = modules[y];
          if (row) row[x] = ((payload[index++] ?? 0) !== 0) !== ((x + y) % 2 === 0);
        }
      }
    }
  }
  return modules;
}
