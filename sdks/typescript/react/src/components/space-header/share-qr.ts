/** Byte-mode QR, error correction L, mask 0. Quiet zone is included by ShareQR. */
export function shareQr(text: string): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 271) return null;
  const version = bytes.length <= 134 ? 6 : 10;
  const size = version * 4 + 17;
  const capacity = version === 6 ? 136 : 274;
  const blockLengths = version === 6 ? [68, 68] : [68, 68, 69, 69];
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(4, 4);
  append(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((value, bit) => value * 2 + bit, 0));
  for (let pad = 0; data.length < capacity; pad++) data.push(pad % 2 ? 0x11 : 0xec);
  const multiply = (a: number, b: number) => {
    let value = 0;
    for (let i = 7; i >= 0; i--) {
      value = (value << 1) ^ ((value >>> 7) * 0x11d);
      value ^= ((b >>> i) & 1) * a;
    }
    return value;
  };
  const divisor = new Array<number>(18).fill(0);
  divisor[17] = 1;
  let root = 1;
  for (let i = 0; i < 18; i++) {
    for (let j = 0; j < 18; j++) divisor[j] = multiply(divisor[j] ?? 0, root) ^ (divisor[j + 1] ?? 0);
    root = multiply(root, 2);
  }
  let offset = 0;
  const blocks = blockLengths.map((length) => {
    const block = data.slice(offset, offset + length);
    offset += length;
    const ec = new Array<number>(18).fill(0);
    for (const byte of block) {
      const factor = byte ^ (ec.shift() ?? 0);
      ec.push(0);
      for (let i = 0; i < 18; i++) ec[i] = (ec[i] ?? 0) ^ multiply(divisor[i] ?? 0, factor);
    }
    return { data: block, ec };
  });
  const words: number[] = [];
  for (let i = 0; i < Math.max(...blockLengths); i++)
    for (const block of blocks) {
      const word = block.data[i];
      if (word !== undefined) words.push(word);
    }
  for (let i = 0; i < 18; i++) for (const block of blocks) words.push(block.ec[i] ?? 0);
  const matrix = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, value: boolean) => {
    const row = matrix[y];
    const occupied = reserved[y];
    if (row && occupied && x >= 0 && x < size) {
      row[x] = value;
      occupied[x] = true;
    }
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
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
  const positions = version === 6 ? [6, 34] : [6, 28, 50];
  for (const y of positions)
    for (const x of positions) {
      if ((x === 6 && (y === 6 || y === size - 7)) || (y === 6 && x === size - 7)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  let remainder = 8; // L = 01, mask 000
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const format = ((8 << 10) | remainder) ^ 0x5412;
  const bit = (i: number) => ((format >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const value = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, ((value >>> i) & 1) !== 0);
      set(b, a, ((value >>> i) & 1) !== 0);
    }
  }
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (reserved[y]?.[x]) continue;
        const value = (((words[index >>> 3] ?? 0) >>> (7 - (index & 7))) & 1) !== 0;
        const row = matrix[y];
        if (row) row[x] = value !== ((x + y) % 2 === 0);
        index++;
      }
    }
  }
  return matrix;
}
