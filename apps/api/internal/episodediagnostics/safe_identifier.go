package episodediagnostics

// SafeIdentifierStorage is the retention strategy declared by the shared
// Safe ID Class Registry.

// SafeIdentifierAlphabet names the bounded value alphabet declared by the
// shared Safe ID Class Registry.

// SafeIdentifierClassRule is the Go representation of one machine registry
// class. Keep this map in lockstep with packages/diagnostics-contracts/
// safe-id-classes.v1.json; the parity test loads that file directly.

// SafeIdentifierRules returns a copy of the machine registry representation.
// Returning a copy prevents callers from changing projection behavior through
// a mutable package-level map.

// ValidSafeIdentifierValue reports whether a raw value satisfies a known
// registry class. It does not make HMAC-only values copyable.

// SafeIdentifierFor applies the shared registry to a value before it crosses
// the diagnostic projection boundary. HMAC-only and unknown classes never
// expose their source value. Invalid raw values are represented as an
// explicit omission instead of escaping the bounded contract.

// ValidateSafeIdentifier checks the object emitted in a diagnostic projection
// against the shared registry. Unknown classes follow the registry's
// unknownClass rule and are therefore HMAC-only, non-copyable, and opaque.

// safeIdentifier remains local to the projection package so existing callers
// retain their omission semantics while all behavior is registry-driven.
