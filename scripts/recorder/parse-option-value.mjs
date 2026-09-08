export function parseOptionValue(argv, index, name, numeric) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  if (!numeric) return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${name} must be a non-negative number`);
  return parsed;
}
