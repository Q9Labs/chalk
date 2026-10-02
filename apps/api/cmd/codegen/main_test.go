package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// statusConstants returns the string values of the Status* constants declared
// in a package's non-test files, keyed by constant name.
func statusConstants(t *testing.T, directory string) map[string]string {
	t.Helper()
	packages, err := parser.ParseDir(token.NewFileSet(), directory, func(info fs.FileInfo) bool {
		return !strings.HasSuffix(info.Name(), "_test.go")
	}, 0)
	if err != nil {
		t.Fatal(err)
	}
	constants := make(map[string]string)
	for _, pkg := range packages {
		for _, file := range pkg.Files {
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
