package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseOptionsRequiresAbsoluteDatabaseURLFileAndKnownTarget(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{name: "missing database URL file", args: []string{"--target", "20260819130000"}, want: "--database-url-file is required"},
		{name: "relative database URL file", args: []string{"--database-url-file", "migration-url", "--target", "20260819130000"}, want: "--database-url-file must be absolute"},
		{name: "missing target", args: []string{"--database-url-file", "/run/chalk/migrate/database-url"}, want: "--target is required"},
		{name: "future target", args: []string{"--database-url-file", "/run/chalk/migrate/database-url", "--target", "99999999999999"}, want: "newer than this image's migration set"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseOptions(tc.args)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("parseOptions() error = %v, want substring %q", err, tc.want)
			}
		})
	}
}

func TestReadDatabaseURLRejectsNonPostgresAndSymlinkFiles(t *testing.T) {
	directory := t.TempDir()
	urlPath := filepath.Join(directory, "database-url")
	if err := os.WriteFile(urlPath, []byte("mysql://example.invalid/database\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readDatabaseURL(urlPath); err == nil || !strings.Contains(err.Error(), "must use PostgreSQL") {
		t.Fatalf("readDatabaseURL() error = %v, want PostgreSQL validation", err)
	}

	targetPath := filepath.Join(directory, "target")
	if err := os.WriteFile(targetPath, []byte("postgres://example.invalid/database"), 0600); err != nil {
		t.Fatal(err)
	}
	symlinkPath := filepath.Join(directory, "database-url-link")
	if err := os.Symlink(targetPath, symlinkPath); err != nil {
		t.Fatal(err)
	}
	if _, err := readDatabaseURL(symlinkPath); err == nil || !strings.Contains(err.Error(), "not regular") {
		t.Fatalf("readDatabaseURL() symlink error = %v, want regular-file validation", err)
	}
}

func TestRedactDatabaseURL(t *testing.T) {
	secret := "postgres://user:password@example.invalid/database"
	err := redactDatabaseURL(errors.New("connect to "+secret+": refused"), secret)
	if err == nil {
		t.Fatal("redactDatabaseURL() returned nil")
	}
	if strings.Contains(err.Error(), secret) || !strings.Contains(err.Error(), "[redacted database URL]") {
		t.Fatalf("redacted error = %q", err)
	}
}
