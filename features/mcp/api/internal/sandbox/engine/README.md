# Code-mode runtime decision

Reviewed 1 November 2026. This is an application-level MCP tool design, not a
new transport or a claim of a standard MCP sandbox.

## Pattern and runtime

[Cloudflare Code Mode](https://blog.cloudflare.com/code-mode-mcp) separates API
discovery from server-side execution in an isolate with restricted capabilities.
[Anthropic's MCP code-execution pattern](https://www.anthropic.com/engineering/code-execution-with-mcp)
similarly loads tools progressively and filters intermediate results in code.
Chalk follows that two-tool, server-side pattern and supplies only explicitly
bound operations, not HTTP access or arbitrary client SDKs.

The [2026-07-28 MCP release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
adds a stateless core, routing headers, discovery caching and extensions. It does
not supply a portable sandbox. The current official Go SDK is already v1.8.0
on the parent PR, with this protocol and 2025-11-25 compatibility; both endpoints
retain that SDK, stateless JSON responses and no-store policy.

QuickJS-NG v0.18.0 compiled to WASM under wazero v1.12.0 gives two independently
enforced boundaries: QuickJS allocation/stack/interrupt limits, and WASM linear
memory plus context-driven termination. C engine defects remain inside the WASM
address space; wazero itself and the two Go host functions are trusted. A fresh
instance prevents prototype or global-state leakage between executions. Only
compiled machine code is cached.

Alternatives considered:

- goja is convenient and interruptible, but allocates guest objects on the Go
  heap and cannot enforce a per-guest hard memory ceiling. That rules it out.
- Native QuickJS bindings add a cgo/native-engine escape boundary to the API
  process. The WASM build keeps engine memory inside a bounded linear memory.
- Cloudflare Dynamic Workers/V8 isolates are established for Cloudflare-hosted
  Code Mode, but would add a second remote execution service and credential/RPC
  boundary. Chalk already has a Go process and shared in-process operations.
- Higher-level QuickJS/WASM wrappers can expose proxy Go objects, filesystem
  loaders and real clocks. This small C shim compiles only the engine, not
  `quickjs-libc`, and registers only serialized calls and output instead.

The guest is single-threaded. Its hard five-second wall deadline also bounds
guest CPU to at most five CPU-seconds, including C builtins; QuickJS's cumulative
1,000-poll interrupt budget cuts off ordinary bytecode loops earlier. This is
not a wazero instruction-fuel API. Host database/provider calls use the same
deadline and cooperative request cancellation as the existing application ports.
The 32 MiB cap covers all guest linear memory, not Go compiler/runtime overhead.
An endpoint-wide four-slot admission limit bounds simultaneous guest heaps and
transpilers. TypeScript uses esbuild's bounded-source Transform API only: no
build, bundling, plugins, filesystem resolution, external source maps or server.

WASI is instantiated with defaults: no env, preopens, stdio, network, system
clock hooks or host entropy. Its deterministic fallback clocks/randomness are
not host access. There is no JS module loader or std/os module. Clock, random,
shared-memory and finalization JS globals are removed before user code. Only
JSON crosses the bridge; prototype pollution cannot traverse into Go objects.
The dispatcher validates the existing input schema, then calls the very same
typed handler, scope checks, tenant policy, rate limits, budgets and audit as
the curated tool. Partial writes are deliberately not rolled back or retried.

## Supply chain and rebuild

New runtime dependencies are pinned, actively maintained and not archived:

- [QuickJS-NG v0.18.0](https://github.com/quickjs-ng/quickjs/releases/tag/v0.18.0),
  released 1 November 2026, approximately 4,000 GitHub stars; MIT license is
  included as `QUICKJS-LICENSE`. Exact source commit:
  `d7215b0ad3fc2c562e8317fd9bca058fd4863804`.
- [wazero v1.12.0](https://github.com/tetratelabs/wazero/releases/tag/v1.12.0),
  released May 2026, approximately 6,400 stars, with repository activity in
  October 2026. Already an indirect API dependency through SQL tooling;
  upgraded from v1.9.0 and now used directly by this feature.
- [esbuild v0.28.2](https://github.com/evanw/esbuild/releases/tag/v0.28.2),
  released August 2026, approximately 40,000 stars. Only its Go Transform API
  executes; development-server HTTP vulnerabilities are not an execution path.

The OSV commit query for the exact QuickJS source returned no matching advisory
on the review date. Go dependencies are additionally checked by the API's
govulncheck and repository OSV gates. A negative scan is not a security proof;
the sandbox/auth changes still need independent security review before merge.

The checked-in WASM avoids production compiler/network dependencies. `build.sh`
downloads SHA-256-verified QuickJS source and WASI SDK 29, maps build paths for
determinism, and builds only `bridge.c` plus engine sources. Rebuild on Linux:

```sh
bash features/mcp/api/internal/sandbox/engine/build.sh
```

Compare a clean rebuild without replacing the artifact:

```sh
bash features/mcp/api/internal/sandbox/engine/build.sh --check
```

Expected `quickjs.wasm` SHA-256:
`a7d7b693955b5b6656af4e4ea621ef9ef1d8fa820aee137d54923ece6177fc74`.
Update the artifact, pins, digest, vulnerability review and abuse tests together
when updating the engine or bridge. WASM behavior tests exercise the embedded
artifact, not a native substitute.
