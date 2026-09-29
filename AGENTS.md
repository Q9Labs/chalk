# Chalk

OSS modern real-time collaboration and communication.

Run `pnpm run gate` to verify your work. Also run `apps/api/scripts/gate.sh` for API changes and `apps/sync/scripts/gate.sh` for Sync changes.

- Use the vocabulary in `GLOSSARY.md`; CI checks banned terms.
- Put shared behavior in packages first, then wire it into apps. Don't fix SDK behavior only in a demo.
- Keep product language role-neutral unless an integration needs specific terms.
- For observability or service monitoring changes, read `docs/observability.md`.
- Use `pnpm diag trace <32-hex-trace-id>` for a bounded cross-tool trace brief ([command adapter recipe](https://github.com/Q9Labs/q9stack/blob/main/recipes/diagnostics-command.md)); use `pnpm trace:inspect <chalkdiag:v1:...>` for full Episode evidence and the seven-day retained debugger views.
- The trace brief also reads [Axiom spans and logs](https://github.com/Q9Labs/q9stack/blob/main/recipes/diagnostics-axiom.md); keep its read-only token in `AXIOM_QUERY_TOKEN`.

This repo is public. Keep production identifiers, customer details, private runbooks, and raw debug artifacts out of Git.
