package mcptools

import (
	"go/parser"
	"go/token"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The tool catalog reaches the application only through the ports Bind receives.
// It may name the shared scope list, and nothing else of the API.
func TestToolsImportNoApplicationCode(t *testing.T) {
	const scopeList = "github.com/q9labs/chalk/apps/api/internal/authentication"
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), file, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, spec := range parsed.Imports {
			path, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				t.Fatal(err)
			}
			if strings.HasPrefix(path, "github.com/q9labs/") && path != scopeList {
				t.Errorf("%s imports %s", file, path)
			}
		}
	}
}
