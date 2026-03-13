# Code Index Setup

Minimal note. Future revisit.

## Goal

Local semantic code search for Chalk. Keep it local. No hosted service.

## Recommended stack

- Ollama
- `embeddinggemma`
- small Bun CLI in `scripts/`
- local artifact dir: `.code-index/`

## Steps

```bash
ollama pull embeddinggemma
```

Add root scripts:

```json
{
  "code:index": "bun run ./scripts/code-index.ts index",
  "code:search": "bun run ./scripts/code-index.ts search",
  "code:stats": "bun run ./scripts/code-index.ts stats"
}
```

Implementation shape:

- walk repo files
- chunk by headings / exported symbols
- embed via Ollama `POST /api/embed`
- store in `.code-index/index.json`
- hybrid rank: lexical boost + cosine similarity
- cache unchanged chunks by content hash

Useful checks:

```bash
bun run code:index packages/sdk-core/src
bun run code:search "join retry"
bun run code:stats
```

Reality check:

- worth it as sidekick to `rg`
- not replacement for `rg`
- best for fuzzy queries, ownership, feature-location

If we want prebuilt instead next time:

- Continue: local embeddings + codebase retrieval
- Sourcegraph: heavier, stronger search/nav
- Aider repo map: cheap, non-embedding fallback
