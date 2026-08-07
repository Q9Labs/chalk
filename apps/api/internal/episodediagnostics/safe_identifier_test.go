package episodediagnostics

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

type safeIdentifierRegistryFixture struct {
	SchemaVersion string                       `json:"schemaVersion"`
	Version       int                          `json:"version"`
	UnknownClass  safeIdentifierUnknownFixture `json:"unknownClass"`
	Classes       []safeIdentifierClassFixture `json:"classes"`
}

type safeIdentifierUnknownFixture struct {
	Storage       SafeIdentifierStorage `json:"storage"`
	Copyable      bool                  `json:"copyable"`
	UnknownReason UnknownReason         `json:"unknownReason"`
}

type safeIdentifierClassFixture struct {
	IDClass   string                 `json:"idClass"`
	Storage   SafeIdentifierStorage  `json:"storage"`
	Copyable  bool                   `json:"copyable"`
	MaxLength int                    `json:"maxLength"`
	Alphabet  SafeIdentifierAlphabet `json:"alphabet"`
}

func TestSafeIdentifierRegistryMatchesMachineFixtureAndProjection(t *testing.T) {
	fixture := loadSafeIdentifierRegistryFixture(t)
	if fixture.SchemaVersion != "SafeIdClassRegistry/v1" || fixture.Version != 1 {
		t.Fatalf("registry envelope = schema %q version %d, want SafeIdClassRegistry/v1 v1", fixture.SchemaVersion, fixture.Version)
	}
	if !reflect.DeepEqual(fixture.UnknownClass, safeIdentifierUnknownFixture{Storage: SafeIdentifierStorageHMAC, Copyable: false, UnknownReason: UnknownProviderOpaque}) {
		t.Fatalf("unknownClass = %+v, want HMAC/non-copyable/provider_opaque", fixture.UnknownClass)
	}

	rules := SafeIdentifierRules()
	if len(rules) != len(fixture.Classes) {
		t.Fatalf("Go registry has %d classes, machine registry has %d", len(rules), len(fixture.Classes))
	}
	for _, class := range fixture.Classes {
		t.Run(class.IDClass, func(t *testing.T) {
			rule, ok := rules[class.IDClass]
			if !ok {
				t.Fatalf("class is missing from Go registry")
			}
			wantRule := SafeIdentifierClassRule{Storage: class.Storage, Copyable: class.Copyable, MaxLength: class.MaxLength, Alphabet: class.Alphabet}
			if !reflect.DeepEqual(rule, wantRule) {
				t.Fatalf("Go rule = %+v, machine rule = %+v", rule, wantRule)
			}

			value := safeIdentifierFixtureValue(class)
			projected, ok := SafeIdentifierFor(class.IDClass, value).(SafeIdentifier)
			if !ok {
				t.Fatalf("projection type = %T, want SafeIdentifier", SafeIdentifierFor(class.IDClass, value))
			}
			if class.Storage == SafeIdentifierStorageHMAC {
				if projected.Value != "" || projected.Copyable || projected.UnknownReason != UnknownProviderOpaque {
					t.Fatalf("HMAC-only projection = %+v, want omitted/non-copyable/provider_opaque", projected)
				}
			} else if projected.Value != value || projected.Copyable != class.Copyable || projected.UnknownReason != "" {
				t.Fatalf("raw projection = %+v, want value %q/copyable=%t", projected, value, class.Copyable)
			}
			if err := ValidateSafeIdentifier(projected); err != nil {
				t.Fatalf("projected identifier failed registry validation: %v", err)
			}
		})
	}
}

func TestSafeIdentifierUnknownAndInvalidValuesAreOpaque(t *testing.T) {
	unknown, ok := SafeIdentifierFor("future.backend", "customer-provider-id").(SafeIdentifier)
	if !ok || unknown.Value != "" || unknown.Copyable || unknown.UnknownReason != UnknownProviderOpaque {
		t.Fatalf("unknown class projection = %+v, want HMAC/non-copyable/provider_opaque", unknown)
	}
	if err := ValidateSafeIdentifier(unknown); err != nil {
		t.Fatalf("unknown class projection failed validation: %v", err)
	}

	invalid, ok := SafeIdentifierFor("w3c.span", "not-hex").(SafeIdentifier)
	if !ok || invalid.Value != "" || invalid.Copyable || invalid.UnknownReason != UnknownInvalid {
		t.Fatalf("invalid raw projection = %+v, want omitted/non-copyable/invalid", invalid)
	}
	if err := ValidateSafeIdentifier(invalid); err != nil {
		t.Fatalf("invalid raw projection failed validation: %v", err)
	}

	for _, class := range []string{"provider", "integration"} {
		identifier, ok := SafeIdentifierFor(class, "raw-secret").(SafeIdentifier)
		if !ok || identifier.Value != "" || identifier.Copyable || identifier.UnknownReason != UnknownProviderOpaque {
			t.Fatalf("%s projection = %+v, want HMAC/non-copyable/provider_opaque", class, identifier)
		}
	}
}

func TestSafeIdentifierRegistryIncludesNewChalkClasses(t *testing.T) {
	for _, idClass := range []string{"chalk.participant", "chalk.service", "chalk.retry"} {
		identifier, ok := SafeIdentifierFor(idClass, "chalk-id_01").(SafeIdentifier)
		if !ok || identifier.IDClass != idClass || identifier.Value != "chalk-id_01" || !identifier.Copyable || identifier.UnknownReason != "" {
			t.Fatalf("%s projection = %+v, want raw copyable identifier", idClass, identifier)
		}
	}
}

func loadSafeIdentifierRegistryFixture(t *testing.T) safeIdentifierRegistryFixture {
	t.Helper()
	_, sourcePath, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	fixturePath := filepath.Join(filepath.Dir(sourcePath), "..", "..", "..", "..", "packages", "diagnostics-contracts", "safe-id-classes.v1.json")
	contents, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read machine Safe ID registry %s: %v", fixturePath, err)
	}
	var fixture safeIdentifierRegistryFixture
	if err := json.Unmarshal(contents, &fixture); err != nil {
		t.Fatalf("decode machine Safe ID registry: %v", err)
	}
	return fixture
}

func safeIdentifierFixtureValue(class safeIdentifierClassFixture) string {
	switch class.Alphabet {
	case SafeIdentifierAlphabetHex:
		return strings.Repeat("a", min(class.MaxLength, 16))
	case SafeIdentifierAlphabetSafe:
		return "opaque-id_01"
	default:
		return "chalk-id_01"
	}
}
