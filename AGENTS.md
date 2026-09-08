# Chalk

OSS modern real-time collaboration and communication.

Run `pnpm run gate` to verify your work. Also run `apps/api/scripts/gate.sh` for API changes and `apps/sync/scripts/gate.sh` for Sync changes.

- Use the vocabulary in `GLOSSARY.md`; CI checks banned terms.
- Put shared behavior in packages first, then wire it into apps. Don't fix SDK behavior only in a demo.
- Keep product language role-neutral unless an integration needs specific terms.
- For observability or service monitoring changes, read `docs/observability.md`.

This repo is public. Keep production identifiers, customer details, private runbooks, and raw debug artifacts out of Git.
