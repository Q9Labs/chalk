package recorderworker

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadUIBuildRegistryAcceptsBoundedCurrentAndRetainedBuilds(t *testing.T) {
	current := strings.Repeat("a", 64)
	retained := strings.Repeat("b", 64)
	path := writeUIBuildRegistryFixture(t, `{"schema_version":"recording_ui_build_registry.v1","builds":[{"sha256":"`+current+`","directory":"client"},{"sha256":"`+retained+`","directory":"retained-clients/`+retained+`"}]}`)

	registry, err := LoadUIBuildRegistry(path)
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	if !registry.Supports(current) || !registry.Supports(retained) || registry.Supports(strings.Repeat("c", 64)) {
		t.Fatalf("registry support set is incorrect")
	}
}

func TestLoadUIBuildRegistryRejectsUnsafeDirectoryAndDuplicateDigest(t *testing.T) {
	sha256 := strings.Repeat("a", 64)
	for _, document := range []string{
		`{"schema_version":"recording_ui_build_registry.v1","builds":[{"sha256":"` + sha256 + `","directory":"../client"}]}`,
		`{"schema_version":"recording_ui_build_registry.v1","builds":[{"sha256":"` + sha256 + `","directory":"client"},{"sha256":"` + sha256 + `","directory":"retained-clients/` + sha256 + `"}]}`,
	} {
		if _, err := LoadUIBuildRegistry(writeUIBuildRegistryFixture(t, document)); !errors.Is(err, ErrInvalidUIBuildRegistry) {
			t.Fatalf("unsafe registry error = %v", err)
		}
	}
}

func writeUIBuildRegistryFixture(t *testing.T, document string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "recording-ui-builds.json")
	if err := os.WriteFile(path, []byte(document), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
