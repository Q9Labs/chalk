import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const contentDirectory = resolve(import.meta.dirname, "content");

const bannedTerms = [
  /\bmeetings?\b/giu,
  /\brooms?\b/giu,
  new RegExp(["\\bsess", "ions?\\b"].join(""), "giu"),
  /\bcalls?\b/giu,
  new RegExp(["\\bconfer", "ences?\\b"].join(""), "giu"),
  /\badmins?\b/giu,
  /\bbots?\b/giu,
  /\bassistants?\b/giu,
  /\bAI\b/gu,
  /\battendees?\b/giu,
  /\bpeers?\b/giu,
  /\bactors?\b/giu,
  /\bsignals?\b/giu,
  new RegExp(["\\bVideoConfer", "ence\\b"].join(""), "gu"),
  /\bpre-join\b/giu,
  /\blobb(?:y|ies)\b/giu,
  /\bgreen rooms?\b/giu,
  /\bbreakouts?\b/giu,
  /\bhuddles?\b/giu,
  /\brings?\b/giu,
  /\bParticipantAccess\b/gu,
  new RegExp(["\\bChalkSess", "ion\\b"].join(""), "gu"),
];

function proseOnly(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]+`/g, "")
    .replace(/\]\([^)]+\)/g, "]")
    .replace(/\bnative (?:JavaScript )?hosts?\b/giu, "native adapter");
}

describe("docs language", () => {
  it("uses the complete public vocabulary in prose", () => {
    const failures = readdirSync(contentDirectory)
      .filter((filename) => filename.endsWith(".mdx"))
      .flatMap((filename) => {
        const prose = proseOnly(readFileSync(resolve(contentDirectory, filename), "utf8"));
        return bannedTerms.flatMap((pattern) => {
          pattern.lastIndex = 0;
          const matches = Array.from(prose.matchAll(pattern), (match) => match[0]);
          return matches.length ? [`${filename}: ${matches.join(", ")}`] : [];
        });
      });

    expect(failures).toEqual([]);
  });

  it("keeps private operations out of the public API page", () => {
    const publicApi = readFileSync(resolve(contentDirectory, "public-api.mdx"), "utf8");

    expect(publicApi).not.toMatch(/ops\/ingest|telemetry\/journey|monitor-results|opsIngestToken/i);
    expect(publicApi).toMatch(/allowlisted (?:public )?summary/);
    expect(publicApi).toContain("0.0.0-preview");
  });
});
