import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..");

const LEGACY_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "legacy token-expired event", regex: /\btoken-expired\b/ },
  { label: "legacy token:expired event", regex: /\btoken:expired\b/ },
  { label: "legacy participant-joined event", regex: /\bparticipant-joined\b/ },
  { label: "legacy participant-left event", regex: /\bparticipant-left\b/ },
  { label: "legacy connection-state-changed event", regex: /\bconnection-state-changed\b/ },
  { label: "legacy hand-raised event", regex: /\bhand-raised\b/ },
  { label: "legacy hand-lowered event", regex: /\bhand-lowered\b/ },
];

const collectSourceFiles = (dir: string): string[] => {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (entry === "__tests__") {
        continue;
      }
      files.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (fullPath.endsWith(".ts") || fullPath.endsWith(".tsx")) {
      files.push(fullPath);
    }
  }

  return files;
};

describe("Event contract dead-path sweep", () => {
  it("contains no legacy pre-dot-notation event identifiers in sdk-core source", () => {
    const files = collectSourceFiles(SRC_ROOT);
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const pattern of LEGACY_PATTERNS) {
        if (pattern.regex.test(content)) {
          violations.push(`${pattern.label} -> ${file}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
