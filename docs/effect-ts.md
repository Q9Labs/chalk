# Effect TS Philosophy

Effect is not mainly about memorizing combinators. It is about learning to see
an application as typed data flow, typed dependencies, typed failures, and typed
runtime behavior.

## Principles

- Keep unsafe platform details at the edge.
- Turn platform things into typed services as early as possible.
- Model dependencies explicitly with `Context` and `Layer`.
- Model failure explicitly instead of throwing random exceptions.
- Let the compiler tell you which services, config, and errors are still
  unhandled.
- Keep domain code free from framework and runtime details.
- Treat HTTP handlers, Workers, CLIs, queues, and cron jobs as adapters around
  the same core program.
- Prefer typed RPC or schemas at boundaries instead of hand-shaped JSON.
- Put cross-cutting behavior like logging, tracing, retries, and metrics in
  middleware or layers.
- Make observability readable; more spans and logs are not automatically better.
- Use the runtime to manage interruption, concurrency, cleanup, and background
  work.

## Boundary Habit

Ask these questions before writing code:

- What is the boundary?
- What are the dependencies?
- What can fail?
- What should be a service?
- What belongs in a `Layer`?
- What should stay platform-specific?
- How can the runtime do the boring correctness work?

## Mental Model

```text
Platform adapter
  Request, env vars, Cloudflare bindings, database handles, execution context

Effect runtime wiring
  Config providers, services, layers, logging, tracing, interruption

Domain application
  Business logic, RPC procedures, schemas, typed errors, pure decisions
```

The goal is to squeeze the unsafe world to the edges, then let TypeScript and
Effect protect the inside.
