import { createHash } from "node:crypto";

const PROD_API_URL = "https://chalk-api.q9labs.ai";

function getFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function main(): Promise<void> {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL?.trim() || PROD_API_URL;
  const apiKey = process.env.EXPO_PUBLIC_CHALK_API_KEY?.trim();

  if (!apiKey) {
    console.log(`No production mobile host API key configured; skipping host-key verification for ${apiUrl}`);
    return;
  }

  const response = await fetch(`${apiUrl}/api/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const details = body ? ` ${body.slice(0, 200)}` : "";
    throw new Error(`Production mobile host API key verification failed (${response.status}).${details}`);
  }

  console.log(`Verified production mobile host API key fingerprint ${getFingerprint(apiKey)} against ${apiUrl}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
