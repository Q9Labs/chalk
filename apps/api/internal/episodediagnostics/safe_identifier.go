package episodediagnostics

import (
	"errors"
	"fmt"
	"regexp"
)

// SafeIdentifierStorage is the retention strategy declared by the shared
// Safe ID Class Registry.
type SafeIdentifierStorage string

const (
	SafeIdentifierStorageRaw  SafeIdentifierStorage = "raw"
	SafeIdentifierStorageHMAC SafeIdentifierStorage = "hmac"
)

// SafeIdentifierAlphabet names the bounded value alphabet declared by the
// shared Safe ID Class Registry.
type SafeIdentifierAlphabet string

const (
	SafeIdentifierAlphabetHex   SafeIdentifierAlphabet = "hex"
	SafeIdentifierAlphabetToken SafeIdentifierAlphabet = "token"
	SafeIdentifierAlphabetSafe  SafeIdentifierAlphabet = "safe"
)

// SafeIdentifierClassRule is the Go representation of one machine registry
// class. Keep this map in lockstep with packages/diagnostics-contracts/
// safe-id-classes.v1.json; the parity test loads that file directly.
type SafeIdentifierClassRule struct {
	Storage   SafeIdentifierStorage
	Copyable  bool
	MaxLength int
	Alphabet  SafeIdentifierAlphabet
}

var safeIdentifierClassRegistry = map[string]SafeIdentifierClassRule{
	"chalk.request":     {Storage: SafeIdentifierStorageRaw, Copyable: true, MaxLength: 128, Alphabet: SafeIdentifierAlphabetToken},
	"chalk.command":     {Storage: SafeIdentifierStorageRaw, Copyable: true, MaxLength: 128, Alphabet: SafeIdentifierAlphabetToken},
	"chalk.journey":     {Storage: SafeIdentifierStorageRaw, Copyable: true, MaxLength: 128, Alphabet: SafeIdentifierAlphabetToken},
	"chalk.episode":     {Storage: SafeIdentifierStorageRaw, Copyable: true, MaxLength: 128, Alphabet: SafeIdentifierAlphabetToken},
	"chalk.participant": {Storage: SafeIdentifierStorageRaw, Copyable: true, MaxLength: 128, Alphabet: SafeIdentifierAlphabetToken},
	"chalk.service":     {Storage: SafeIdentifierStorageRaw, Copyable: true, MaxLength: 64, Alphabet: SafeIdentifierAlphabetToken},
	"chalk.retry":       {Storage: SafeIdentifierStorageRaw, Copyable: true, MaxLength: 128, Alphabet: SafeIdentifierAlphabetToken},
	"w3c.trace":         {Storage: SafeIdentifierStorageRaw, Copyable: true, MaxLength: 32, Alphabet: SafeIdentifierAlphabetHex},
	"w3c.span":          {Storage: SafeIdentifierStorageRaw, Copyable: true, MaxLength: 16, Alphabet: SafeIdentifierAlphabetHex},
	"provider":          {Storage: SafeIdentifierStorageHMAC, Copyable: false, MaxLength: 160, Alphabet: SafeIdentifierAlphabetSafe},
	"integration":       {Storage: SafeIdentifierStorageHMAC, Copyable: false, MaxLength: 160, Alphabet: SafeIdentifierAlphabetSafe},
	"diagnostic":        {Storage: SafeIdentifierStorageRaw, Copyable: true, MaxLength: 128, Alphabet: SafeIdentifierAlphabetToken},
	"operation":         {Storage: SafeIdentifierStorageRaw, Copyable: true, MaxLength: 128, Alphabet: SafeIdentifierAlphabetToken},
	"issue":             {Storage: SafeIdentifierStorageRaw, Copyable: true, MaxLength: 128, Alphabet: SafeIdentifierAlphabetToken},
	"event":             {Storage: SafeIdentifierStorageRaw, Copyable: true, MaxLength: 128, Alphabet: SafeIdentifierAlphabetToken},
}

var safeIdentifierHexPattern = regexp.MustCompile(`^[0-9a-fA-F]+$`)
var safeIdentifierSafePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

// SafeIdentifierRules returns a copy of the machine registry representation.
// Returning a copy prevents callers from changing projection behavior through
// a mutable package-level map.
func SafeIdentifierRules() map[string]SafeIdentifierClassRule {
	rules := make(map[string]SafeIdentifierClassRule, len(safeIdentifierClassRegistry))
	for idClass, rule := range safeIdentifierClassRegistry {
		rules[idClass] = rule
	}
	return rules
}

// ValidSafeIdentifierValue reports whether a raw value satisfies a known
// registry class. It does not make HMAC-only values copyable.
func ValidSafeIdentifierValue(idClass, value string) bool {
	rule, known := safeIdentifierClassRegistry[idClass]
	return known && validSafeIdentifierValue(rule, value)
}

// SafeIdentifierFor applies the shared registry to a value before it crosses
// the diagnostic projection boundary. HMAC-only and unknown classes never
// expose their source value. Invalid raw values are represented as an
// explicit omission instead of escaping the bounded contract.
func SafeIdentifierFor(idClass, value string) any {
	if value == "" {
		return nil
	}
	rule, known := safeIdentifierClassRegistry[idClass]
	if !known || rule.Storage == SafeIdentifierStorageHMAC {
		return SafeIdentifier{IDClass: idClass, Copyable: false, UnknownReason: UnknownProviderOpaque}
	}
	if !validSafeIdentifierValue(rule, value) {
		return SafeIdentifier{IDClass: idClass, Copyable: false, UnknownReason: UnknownInvalid}
	}
	return SafeIdentifier{IDClass: idClass, Value: value, Copyable: rule.Copyable}
}

// ValidateSafeIdentifier checks the object emitted in a diagnostic projection
// against the shared registry. Unknown classes follow the registry's
// unknownClass rule and are therefore HMAC-only, non-copyable, and opaque.
func ValidateSafeIdentifier(identifier SafeIdentifier) error {
	if !safeClassPattern.MatchString(identifier.IDClass) {
		return errors.New("safe identifier class is not a safe class name")
	}
	rule, known := safeIdentifierClassRegistry[identifier.IDClass]
	if !known {
		if identifier.Value != "" || identifier.Copyable || identifier.UnknownReason != UnknownProviderOpaque {
			return errors.New("unknown safe identifier classes are HMAC-only and non-copyable")
		}
		return nil
	}
	if rule.Storage == SafeIdentifierStorageHMAC {
		if identifier.Value != "" || identifier.Copyable || identifier.UnknownReason != UnknownProviderOpaque {
			return fmt.Errorf("safe identifier class %s is HMAC-only and non-copyable", identifier.IDClass)
		}
		return nil
	}
	if identifier.Value == "" {
		if identifier.Copyable || identifier.UnknownReason == "" {
			return fmt.Errorf("safe identifier class %s requires a value or an explicit omission reason", identifier.IDClass)
		}
		return nil
	}
	if identifier.Copyable != rule.Copyable {
		return fmt.Errorf("safe identifier class %s requires copyable=%t", identifier.IDClass, rule.Copyable)
	}
	if !validSafeIdentifierValue(rule, identifier.Value) {
		return fmt.Errorf("safe identifier value does not satisfy class %s", identifier.IDClass)
	}
	if !identifier.Copyable && identifier.UnknownReason == "" {
		return fmt.Errorf("non-copyable safe identifier class %s requires an unknown reason", identifier.IDClass)
	}
	return nil
}

func validSafeIdentifierValue(rule SafeIdentifierClassRule, value string) bool {
	if value == "" || len(value) > rule.MaxLength {
		return false
	}
	switch rule.Alphabet {
	case SafeIdentifierAlphabetHex:
		return safeIdentifierHexPattern.MatchString(value)
	case SafeIdentifierAlphabetToken:
		return safeTokenPattern.MatchString(value)
	case SafeIdentifierAlphabetSafe:
		return safeIdentifierSafePattern.MatchString(value)
	default:
		return false
	}
}

// safeIdentifier remains local to the projection package so existing callers
// retain their omission semantics while all behavior is registry-driven.
func safeIdentifier(idClass, value string) any {
	return SafeIdentifierFor(idClass, value)
}
