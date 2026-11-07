package media

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadRSS(t *testing.T) {
	path := filepath.Join(t.TempDir(), "statm")
	if err := os.WriteFile(path, []byte("5000 1200 300 10 0 900 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, known := readRSS(path)
	if want := 1200 * uint64(os.Getpagesize()); !known || got != want {
		t.Fatalf("readRSS = %d, %v; want %d, true", got, known, want)
	}
	if _, known := readRSS(filepath.Join(t.TempDir(), "missing")); known {
		t.Fatal("a missing file reported a reading")
	}
}
