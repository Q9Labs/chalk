# `@q9labsai/diagnostics-contracts`

Public, versioned TypeScript contracts used by Chalk episode diagnostics. The
package contains the runtime validators, redaction helpers, event/action
contracts, projections, and JSON schemas shared by Chalk clients and services.

Install it alongside a Chalk client when consuming diagnostics types or
runtime validation helpers:

```sh
pnpm add @q9labsai/diagnostics-contracts
```

The package is ESM-first and exports its root API plus the checked-in schema and
fixture files through the `./schemas/*` and `./fixtures/*` subpaths.
