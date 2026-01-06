# Compact Documentation (comdoc)

**Principle:** If it can be said in 5 lines, don't use 10.

## Rules

1. **Same info, fewer lines** - Cut words, not meaning
2. **Tables > prose** - Structured data beats paragraphs
3. **No filler** - Remove "basically", "essentially", "in order to", "it should be noted"
4. **One fact per line** - No compound sentences when avoidable
5. **Headers as summaries** - Reader should get gist from headers alone

## Format Priority

```
1. Table (structured, scannable)
2. Bullet list (sequential/related items)
3. Code block (commands, examples)
4. Single sentence (last resort)
```

## Process

| Step | Action                                  |
| ---- | --------------------------------------- |
| 1    | Read full doc, extract core facts       |
| 2    | Group related facts                     |
| 3    | Pick minimal format per group           |
| 4    | Delete everything that doesn't add info |
| 5    | Verify: same takeaways, fewer lines?    |

## Anti-patterns

- "This section will explain..." → just explain
- "It is important to note that..." → state the fact
- "In this document we will..." → delete
- Repeating info in different words → pick one
- Examples that restate the rule → cut or replace rule with example

## Test

> Can someone get the same understanding in half the reading time? If no, cut more.
