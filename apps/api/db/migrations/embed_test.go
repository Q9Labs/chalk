package migrations

import (
	"io/fs"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
)

func TestMigrationFilesMergeInOrderAndRejectDuplicateVersions(t *testing.T) {
	files := migrationFiles{
		fstest.MapFS{"002_app.sql": &fstest.MapFile{Data: []byte("app")}},
		fstest.MapFS{"001_feature.sql": &fstest.MapFile{Data: []byte("feature")}},
	}
	entries, err := fs.ReadDir(files, ".")
	if err != nil || len(entries) != 2 || entries[0].Name() != "001_feature.sql" || entries[1].Name() != "002_app.sql" {
		t.Fatalf("migration order = %v, %v", entries, err)
	}
	for _, name := range []string{"001_feature.sql", "002_app.sql"} {
		contents, err := fs.ReadFile(files, name)
		if err != nil || len(contents) == 0 {
			t.Fatalf("read migration %s: %q, %v", name, contents, err)
		}
	}
	files = append(files, fstest.MapFS{"001_feature.sql": &fstest.MapFile{}})
	if _, err := fs.ReadDir(files, "."); err == nil {
		t.Fatal("duplicate migration name must fail")
	}
}

func TestLatestVersionMatchesEmbeddedMigrations(t *testing.T) {
	entries, err := Files.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	versions := make(map[int64]string)
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
		if previous, exists := versions[version]; exists {
			t.Fatalf("duplicate migration version %d: %s and %s", version, previous, entry.Name())
		}
		versions[version] = entry.Name()
		latest = max(latest, version)
	}
	if LatestVersion != latest {
		t.Fatalf("LatestVersion = %d, latest embedded migration = %d", LatestVersion, latest)
	}
}
