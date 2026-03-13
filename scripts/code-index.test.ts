import { describe, expect, test } from "bun:test";

import { chunkSource } from "./code-index";

describe("chunkSource", () => {
  test("splits TypeScript by exported symbols", () => {
    const source = `
export function joinRoom() {
  return true;
}

export class RoomClient {
  connect() {
    return "ok";
  }
}
`.trim();
    const chunks = chunkSource("packages/sdk-core/src/client.ts", source);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.symbol).toBe("joinRoom");
    expect(chunks[1]?.symbol).toBe("RoomClient");
  });

  test("captures markdown headings as chunk symbols", () => {
    const source = `
# Chalk

Intro

## Quick Start

\`\`\`bash
bun run dev
\`\`\`
`.trim();
    const chunks = chunkSource("README.md", source);
    expect(chunks[0]?.symbol).toBe("Chalk");
    expect(chunks[1]?.symbol).toBe("Quick Start");
  });
});
