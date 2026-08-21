# Chalk docs session log

## 2026-08-19: scope and architecture

Hasan chose a builder-first public docs launch inside `apps/web` at `/docs`.
The first page explains why Chalk exists, Quickstart follows it, and the launch
set covers TypeScript, React, React Native, the Excalidraw-backed whiteboard,
webhooks, and public endpoints. The docs reuse the landing visual system and
follow `~/.codex/writing-style.md` plus `GLOSSARY.md`.

The implementation uses MDX for maintainable prose, a typed local manifest for
navigation and search, and build-time Shiki highlighting. Production is out of
scope until Hasan gives separate approval.

## 2026-08-19: implementation and visual pass

The first launch now has 27 substantive pages across Start, Concepts, SDKs,
Features, Platform, and Operations. Page bodies load on demand. Search, mobile
navigation, linked headings, copyable Shiki code, previous and next links,
route metadata, and a useful unknown-page state are in place.

The browser pass covered desktop, tablet, and mobile widths. It found and fixed
the crowded tablet layout, focus trapping and restoration in both dialogs, the
mobile search label, and code styling inside highlighted blocks. Focused types
and 11 docs tests pass. Public API copy is limited to customer operations and
labeled preview; reserved webhook schemas are not presented as live events.

## 2026-08-19: proof and handoff

A fresh driver completed Why Chalk, Quickstart, code copy, search, Whiteboard,
React, React Native, no-results, unknown-page recovery, and mobile navigation
without a product finding. The fixed-size desktop recording is crisp and its
shared Drive link returns HTTP 200 without Google cookies.

The docs-only full gate passed on the remote M4 mini after the gate surfaced
and we fixed formatter, vocabulary-test, generated-code, and same-name test
policy gaps. The production build emits 27 route-specific HTML files. The docs
shell is 3,062 bytes gzip and MDX bodies remain separate lazy chunks.
