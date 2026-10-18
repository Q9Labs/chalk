/** Version 5-L, byte mode, mask 0. Keeps invite links local rather than sending them to an image service. */
export function inviteQR(text: string): readonly (readonly boolean[])[] | null {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 106) return null;
  const bits: number[] = [];
  const append = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(4, 4);
  append(bytes.length, 8);
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, 864 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, b) => n * 2 + b, 0));
  for (let pad = 0; data.length < 108; pad++) data.push(pad % 2 ? 0x11 : 0xec);
  const multiply = (a: number, b: number) => {
    let result = 0;
    for (let i = 7; i >= 0; i--) {
      result = (result << 1) ^ ((result >>> 7) * 0x11d);
      result ^= ((b >>> i) & 1) * a;
    }
    return result;
  };
  const divisor = Array<number>(26).fill(0);
  divisor[25] = 1;
  let root = 1;
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) divisor[j] = multiply(divisor[j] ?? 0, root) ^ (divisor[j + 1] ?? 0);
    root = multiply(root, 2);
  }
  const remainder = Array<number>(26).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder.shift() ?? 0);
    remainder.push(0);
    for (let i = 0; i < 26; i++) remainder[i] = (remainder[i] ?? 0) ^ multiply(divisor[i] ?? 0, factor);
  }
  const payload: number[] = [];
  for (const byte of [...data, ...remainder]) for (let i = 7; i >= 0; i--) payload.push((byte >>> i) & 1);
  const size = 37;
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
    [33, 3],
    [3, 33],
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
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(30 + dx, 30 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
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
