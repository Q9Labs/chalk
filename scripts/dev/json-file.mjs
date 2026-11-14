import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const sensitiveKey = /(token|secret|password|credential|private.?key|authorization)/i;

function redact(value, key = "") {
  if (sensitiveKey.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, redact(entry, name)]));
  }
  return value;
}

export async function writeJsonAtomic(path, value, { mode = 0o600, redacted = true } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify(redacted ? redact(value) : value, null, 2)}\n`;
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
