# Effect in Chalk

The default client API is Promise-based. Effect consumers use the optional `@q9labsai/chalk-client/effect` entry point; don't add Effect to the default consumer dependency graph.

HTTP schemas and Effect bindings are generated in `sdks/typescript/client/src/generated/`. Change their source and regenerate rather than editing output; see [contract-codegen.md](contract-codegen.md).

Keep platform services in adapters/layers and typed domain programs independent of the runtime. Use Effect for dependencies, errors, interruption, and cleanup—not a second set of wrappers around the same API.
