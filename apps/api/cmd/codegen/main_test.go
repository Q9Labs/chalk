package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// statusConstants returns the string values of the Status* constants declared
// in a package's non-test files, keyed by constant name.
func statusConstants(t *testing.T, directory string) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	fileSet := token.NewFileSet()
	constants := make(map[string]string)
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fileSet, filepath.Join(directory, name), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, declaration := range file.Decls {
			general, ok := declaration.(*ast.GenDecl)
			if !ok || general.Tok != token.CONST {
				continue
			}
			for _, spec := range general.Specs {
				value, ok := spec.(*ast.ValueSpec)
				if !ok {
					continue
				}
				for index, name := range value.Names {
					if !strings.HasPrefix(name.Name, "Status") || index >= len(value.Values) {
						continue
					}
					literal, ok := value.Values[index].(*ast.BasicLit)
					if !ok || literal.Kind != token.STRING {
						continue
					}
					unquoted, err := strconv.Unquote(literal.Value)
					if err != nil {
						t.Fatal(err)
					}
					constants[name.Name] = unquoted
				}
			}
		}
	}
	return constants
}

func TestStatusEnumsCoverDomainStatusConstants(t *testing.T) {
	cases := []struct {
		name      string
		directory string
		schema    string
	}{
		{"transcripts", "../../internal/transcripts", "Transcript"},
		{"recordings", "../../internal/recordings", "Recording"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			constants := statusConstants(t, tc.directory)
			if len(constants) == 0 {
				t.Fatalf("no Status constants found in %s", tc.directory)
			}
			enum := fieldEnum(tc.schema, "status")
			for name, value := range constants {
				if !slices.Contains(enum, value) {
					t.Errorf("%s.%s = %q is missing from the generated %s status enum in cmd/codegen/main.go", tc.name, name, value, tc.schema)
				}
			}
		})
	}
}
