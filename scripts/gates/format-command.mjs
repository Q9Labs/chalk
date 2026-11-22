// Windows caps a command line near 8,000 characters, so a very large change checks the whole tree instead of listing every file.
const MAX_LISTED_FILES = 100;

export function formatCommandFor(files) {
  if (files.length === 0) return null;
  return ["pnpm", "exec", "oxfmt", "--check", ...(files.length > MAX_LISTED_FILES ? ["."] : files)];
}
