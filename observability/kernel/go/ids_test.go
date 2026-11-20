package obs

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type vectorFile struct {
	Format []struct {
		Kind, ID string
		Scope    []string
		Expect   string
		Error    bool
	}
	Parse []struct {
		Text   string
		Expect json.RawMessage
		Error  string
	}
	Resolve []struct {
		Text       string
		Candidates []Target
		Expect     json.RawMessage
	}
	DiagnosticCode []struct{ ID, Expect string } `json:"diagnostic_code"`
	FlagsHash      []struct {
		Flags     map[string]any
		Canonical string
		Expect    string
		Error     bool
	} `json:"flags_hash"`
}

// loadVectors finds observability/registry/vectors.json above the package, wherever the kernel was copied.
func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		data, err := os.ReadFile(filepath.Join(dir, "observability", "registry", "vectors.json"))
		if err == nil {
			var vectors vectorFile
			if err := json.Unmarshal(data, &vectors); err != nil {
				t.Fatal(err)
			}
			return vectors
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("observability/registry/vectors.json not found above the package")
		}
		dir = parent
	}
}

// sameJSON compares a result with an expectation through the same JSON shape the TypeScript kernel produces.
func sameJSON[T any](t *testing.T, label string, got T, want json.RawMessage) {
	t.Helper()
	var expected T
	if err := json.Unmarshal(want, &expected); err != nil {
		t.Fatalf("%s: %v", label, err)
	}
	gotJSON, _ := json.Marshal(got)
	wantJSON, _ := json.Marshal(expected)
	if string(gotJSON) != string(wantJSON) {
		t.Errorf("%s:\n got %s\nwant %s", label, gotJSON, wantJSON)
	}
}

func TestFormatHandleVectors(t *testing.T) {
	for _, vector := range loadVectors(t).Format {
		got, err := FormatHandle(vector.Kind, vector.ID, vector.Scope)
		switch {
		case vector.Error && err == nil:
			t.Errorf("FormatHandle(%s, %q) = %q, want an error", vector.Kind, vector.ID, got)
		case !vector.Error && got != vector.Expect:
			t.Errorf("FormatHandle(%s, %q, %v) = %q, %v, want %q", vector.Kind, vector.ID, vector.Scope, got, err, vector.Expect)
		}
	}
}

func TestParseHandleVectors(t *testing.T) {
	for _, vector := range loadVectors(t).Parse {
		got, err := ParseHandle(vector.Text)
		if vector.Error != "" {
			var handleErr HandleError
			if !errors.As(err, &handleErr) || string(handleErr) != vector.Error {
				t.Errorf("ParseHandle(%q) error = %v, want %s", vector.Text, err, vector.Error)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseHandle(%q): %v", vector.Text, err)
			continue
		}
		sameJSON(t, "ParseHandle("+vector.Text+")", got, vector.Expect)
	}
}

func TestResolveHandleVectors(t *testing.T) {
	for _, vector := range loadVectors(t).Resolve {
		handle, err := ParseHandle(vector.Text)
		if err != nil {
			t.Fatalf("ParseHandle(%q): %v", vector.Text, err)
		}
		sameJSON(t, "ResolveHandle("+vector.Text+")", ResolveHandle(handle, vector.Candidates), vector.Expect)
	}
}

func TestDiagnosticCodeVectors(t *testing.T) {
	for _, vector := range loadVectors(t).DiagnosticCode {
		if got, err := DiagnosticCode(vector.ID); got != vector.Expect || err != nil {
			t.Errorf("DiagnosticCode(%s) = %q, %v, want %s", vector.ID, got, err, vector.Expect)
		}
	}
}

func TestFlagsHashVectors(t *testing.T) {
	for _, vector := range loadVectors(t).FlagsHash {
		canonical, err := CanonicalFlags(vector.Flags)
		hash, hashErr := FlagsHash(vector.Flags)
		if vector.Error {
			if err == nil || hashErr == nil {
				t.Errorf("FlagsHash(%v) = %q, want an error", vector.Flags, hash)
			}
			continue
		}
		if canonical != vector.Canonical || hash != vector.Expect {
			t.Errorf("FlagsHash(%v) = %s %q, want %s %q", vector.Flags, hash, canonical, vector.Expect, vector.Canonical)
		}
	}
}

func TestLegacyHashMatchesTheParticipantHash(t *testing.T) {
	const id = "0f8fad5b-d9cb-469f-a165-70867728950e"
	handle, err := ParseHandle(LegacyHash(id))
	if err != nil {
		t.Fatal(err)
	}
	got := ResolveHandle(handle, []Target{{Kind: "participant", ID: id, LegacyHash: LegacyHash(id)}})
	if got.Status != "unique" || got.Match.ID != id {
		t.Errorf("ResolveHandle(legacy hash) = %+v", got)
	}
}
