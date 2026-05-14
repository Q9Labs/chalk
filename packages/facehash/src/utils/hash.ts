export function stringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    hash = (hash << 5) - hash + character;
    hash &= hash;
  }

  return Math.abs(hash);
}
