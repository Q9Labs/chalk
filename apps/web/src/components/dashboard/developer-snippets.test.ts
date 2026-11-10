import { expect, it } from "vitest";
import { KEY_PREFIX_LENGTH, maskSecret, redactedKey, SIGNING_PREFIX_LENGTH, snippetLines, snippetText } from "./developer-snippets";

const MINTED = "chalk_sk_9Wm4Tq7XvB2nLc5RkZp0aDfG8hJsH0";
const input = { tenantId: "11111111-1111-4111-8111-111111111111", apiOrigin: "https://api.example.test" };

it("shows a key's public prefix and last three characters and nothing between", () => {
  const shown = maskSecret(MINTED, KEY_PREFIX_LENGTH);
  expect(shown).toBe("chalk_sk_9Wm4••••••••••sH0");
  expect(shown).not.toContain("Tq7XvB2nLc5RkZp0aDfG8hJ");
});

it("keeps a signing secret's own prefix", () => {
  expect(maskSecret("whsec_abcdefghijklmnopqrstuvwxyz", SIGNING_PREFIX_LENGTH)).toBe("whsec_••••••••••xyz");
});

it("hides everything in a secret too short to show a prefix and an end", () => {
  expect(maskSecret("short", KEY_PREFIX_LENGTH)).toBe("•••••");
});

it("draws the snippet's key redacted and copies the whole key when Chalk still has it", () => {
  for (const tab of ["env", "curl"] as const) {
    const lines = snippetLines(tab, input);
    const copied = snippetText(lines, { prefix: "chalk_sk_9Wm4", secret: MINTED });
    expect(copied).toContain(MINTED);
    expect(copied).toContain(input.tenantId);
  }
});

it("copies the snippet with the key as drawn when Chalk no longer has the secret", () => {
  const copied = snippetText(snippetLines("env", input), { prefix: "chalk_sk_9Wm4", secret: null });
  expect(copied).toContain(`CHALK_API_KEY=${redactedKey("chalk_sk_9Wm4")}`);
  expect(copied).not.toContain(MINTED);
});

it("lists the key as a marker the screen redacts, never as text", () => {
  const drawn = snippetLines("curl", input).flat();
  expect(drawn.some((token) => token.kind === "secret")).toBe(true);
  expect(drawn.every((token) => token.kind === "secret" || !token.text.includes("chalk_sk_"))).toBe(true);
});
