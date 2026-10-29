package migrations

import (
	"embed"
	"errors"
	"io"
	"io/fs"
	"sort"

	whiteboard "github.com/q9labs/chalk/features/whiteboard/api/db/migrations"
)

// Files is the immutable migration set shipped in the API and migrator images.
//
//go:embed *.sql
var core embed.FS

// Files preserves one chronological migration set across app and feature ownership.
var Files = migrationFiles{core, whiteboard.Files}

type migrationFiles []fs.FS

func (sources migrationFiles) Open(name string) (fs.File, error) {
	for _, source := range sources {
		file, err := source.Open(name)
		if err == nil {
			return file, nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
	}
	return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
}

func (sources migrationFiles) ReadFile(name string) ([]byte, error) {
	file, err := sources.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(file)
}

func (sources migrationFiles) ReadDir(name string) ([]fs.DirEntry, error) {
	entries := []fs.DirEntry{}
	seen := map[string]bool{}
	for _, source := range sources {
		items, err := fs.ReadDir(source, name)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			if seen[item.Name()] {
				return nil, &fs.PathError{Op: "readdir", Path: item.Name(), Err: fs.ErrExist}
			}
			seen[item.Name()] = true
			entries = append(entries, item)
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	return entries, nil
}

const LatestVersion int64 = 20261029160000
