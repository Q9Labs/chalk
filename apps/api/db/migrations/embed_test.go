package migrations

import (
	"io/fs"
	"strconv"
	"strings"
	"testing"
)

func TestLatestVersionMatchesEmbeddedMigrationSet(t *testing.T) {
	var latest int64
	err := fs.WalkDir(Files, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".sql") {
			return nil
		}
		versionText := strings.SplitN(path, "_", 2)[0]
		version, err := strconv.ParseInt(versionText, 10, 64)
		if err != nil {
			return err
		}
		if version > latest {
			latest = version
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk embedded migrations: %v", err)
	}
	if latest == 0 {
		t.Fatal("embedded migration set is empty")
	}
	if LatestVersion != latest {
		t.Fatalf("LatestVersion = %d, want %d", LatestVersion, latest)
	}
}
