/**
 * True when two snapshot values hold the same data. Arrays and plain objects compare by content;
 * everything else (functions, tracks, class instances) compares by identity, so a value that
 * can't be read as data still counts as changed.
 */
export function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => structurallyEqual(item, right[index]));
  if (Array.isArray(right) || !isPlainObject(left) || !isPlainObject(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && structurallyEqual(Reflect.get(left, key), Reflect.get(right, key)));
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
