package migrations

import (
	"strconv"
	"strings"
	"testing"
)

func TestLatestVersionMatchesEmbeddedMigrations(t *testing.T) {
	entries, err := Files.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	var latest int64
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		prefix, _, _ := strings.Cut(entry.Name(), "_")
		version, err := strconv.ParseInt(prefix, 10, 64)
		if err != nil {
			t.Fatalf("invalid embedded migration %q: %v", entry.Name(), err)
		}
		latest = max(latest, version)
	}
	if LatestVersion != latest {
		t.Fatalf("LatestVersion = %d, latest embedded migration = %d", LatestVersion, latest)
	}
}
