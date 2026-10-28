# TypeScript SDK guidance

These packages are public. Keep their APIs, compatibility, and examples understandable to consumers; put shared behavior in the SDK rather than only in an app. Edit generator inputs, not `src/generated/**`.

## Boundaries

- Expose intended public APIs through package entrypoints; avoid deep imports into another package's internals. Keep related code and tests easy to find.
- The default Space client offers Promise-based operations and synchronous `subscribe`/`getSnapshot`. Keep Effect-specific APIs on the `@q9labsai/chalk-client/effect` subpath.
- Where a subsystem already uses Effect, follow its Layers and scoped cleanup. Check the installed Effect version when using its APIs. Other client code, including Sync, is not universally Effect-native.
- Validate external options, wire data, and stored records at their boundaries. Keep errors useful and never silently discard failures.

## React and styling

- Avoid effects when rendering, event handling, or an external-store subscription is the better fit. The SDK Semgrep rule requires a reasoned exception for each `useEffect`.
- Preserve accessible names, keyboard behavior, and visible focus. Use the existing theme tokens; the React and React Native package lint scripts check their token rules.

## Verification

Test observable SDK behavior, including through the published entrypoint where it matters. Use deterministic controls for time and external failures, and place focused tests near the behavior they cover.

Package scripts provide `check-types`, `test`, `build`, and `lint`; the repository gate also runs the relevant shared checks, including Semgrep. Choose the checks that cover the change.
