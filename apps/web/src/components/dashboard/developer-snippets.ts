// The Connect card's code and the redaction rules for secrets. Pure, so the rules a person relies on (the screen never shows a full secret, Copy gives the whole one) are tested without a browser.

export type SnippetTab = "env" | "curl" | "ts";

/** How a token is coloured. `secret` stands for the API key: drawn redacted, copied in full when Chalk still has it. */
export type Token = { readonly kind: "comment" | "key" | "string" | "value" | "punct" | "plain"; readonly text: string } | { readonly kind: "secret" };
export type SnippetLine = readonly Token[];

export const SNIPPET_TABS: readonly { readonly id: SnippetTab; readonly label: string }[] = [
  { id: "env", label: ".env" },
  { id: "curl", label: "cURL" },
  { id: "ts", label: "TypeScript" },
];

const REDACTION = "•";
const SHOWN_AFTER_PREFIX = 10;
const SHOWN_AT_END = 3;
/** A key's first 13 characters are its public prefix, the one the keys table lists. */
export const KEY_PREFIX_LENGTH = 13;
/** A signing secret's own prefix, `whsec_`. */
export const SIGNING_PREFIX_LENGTH = 6;

/** `chalk_sk_9Wm4••••••••••sH0`: the public prefix and the last characters, with dots between. */
export function maskSecret(secret: string, prefixLength: number): string {
  if (secret.length <= prefixLength + SHOWN_AT_END) return REDACTION.repeat(secret.length);
  return `${secret.slice(0, prefixLength)}${REDACTION.repeat(SHOWN_AFTER_PREFIX)}${secret.slice(-SHOWN_AT_END)}`;
}

/** The dots the snippet draws after a key's prefix. */
export const REDACTED_TAIL = REDACTION.repeat(14);

/** The key as the snippet draws it: its prefix and a row of dots. */
export function redactedKey(prefix: string): string {
  return `${prefix}${REDACTED_TAIL}`;
}

const t = (kind: Exclude<Token["kind"], "secret">, text: string): Token => ({ kind, text });

export function snippetLines(tab: SnippetTab, input: { readonly tenantId: string; readonly apiOrigin: string }): readonly SnippetLine[] {
  const { tenantId, apiOrigin } = input;
  switch (tab) {
    case "env":
      return [[t("comment", "# Chalk credentials, from the Developer page")], [t("key", "CHALK_TENANT_ID"), t("punct", "="), t("value", tenantId)], [t("key", "CHALK_API_KEY"), t("punct", "="), { kind: "secret" }], [t("key", "CHALK_API_URL"), t("punct", "="), t("string", apiOrigin)]];
    case "curl":
      return [
        [t("key", "curl"), t("plain", " "), t("string", `${apiOrigin}/v1/tenants/${tenantId}/spaces`), t("plain", " "), t("punct", "\\")],
        [t("plain", "  "), t("value", "-H"), t("plain", " "), t("string", '"Authorization: Bearer '), { kind: "secret" }, t("string", '"')],
      ];
    case "ts":
      return [
        [t("key", "import"), t("punct", " { "), t("plain", "createChalkServerClient"), t("punct", " } "), t("key", "from"), t("plain", " "), t("string", '"@q9labsai/chalk-client/server"'), t("punct", ";")],
        [],
        [t("key", "const"), t("plain", " chalk "), t("punct", "= "), t("value", "createChalkServerClient"), t("punct", "({")],
        [t("plain", "  apiKey"), t("punct", ": "), t("plain", "process.env."), t("value", "CHALK_API_KEY"), t("punct", "!,")],
        [t("plain", "  tenantId"), t("punct", ": "), t("plain", "process.env."), t("value", "CHALK_TENANT_ID"), t("punct", "!,")],
        [t("plain", "  apiBaseURL"), t("punct", ": "), t("string", `"${apiOrigin}"`), t("punct", ",")],
        [t("punct", "});")],
      ];
  }
}

/** The snippet as plain text. `secret` is the full key when Chalk still has it; otherwise the key is copied as drawn, redacted. */
export function snippetText(lines: readonly SnippetLine[], key: { readonly prefix: string; readonly secret: string | null }): string {
  const secretText = key.secret ?? redactedKey(key.prefix);
  return lines.map((line) => line.map((token) => (token.kind === "secret" ? secretText : token.text)).join("")).join("\n");
}

export function snippetNote(tab: SnippetTab): string {
  return tab === "ts" ? "The key and tenant ID come from your environment. Set them from the .env tab." : "The full secret is shown once, when you create a key. Paste it over the dots, and keep it on your server.";
}
