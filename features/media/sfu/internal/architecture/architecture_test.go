// Package architecture holds the static checks that keep the SFU's structure from drifting: the
// direction of its imports, and the size and complexity limits of its code. It has no code of its
// own; the checks are tests so the SFU gate runs them with everything else.
package architecture_test

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const (
	module = "github.com/q9labs/chalk/features/media/sfu/"
	// maxFileLines is the longest a file may be unless sizeBaseline names it.
	maxFileLines = 300
	// maxFuncLines and maxComplexity bound one function. A function above them is split by
	// responsibility, not trimmed to the number.
	maxFuncLines  = 75
	maxComplexity = 15
)

// sizeBaseline lists the files allowed over maxFileLines, each with the one job that keeps it whole.
// The set only shrinks: a file under the limit must leave it.
var sizeBaseline = map[string]string{}

// layers say which SFU packages each package may import, so imports run one way: config, then
// media, then the transports (control, telemetry), then the binary.
var layers = map[string][]string{
	"internal/config":    {},
	"internal/media":     {"internal/config", "protocol"},
	"internal/control":   {"internal/config", "internal/media", "protocol"},
	"internal/telemetry": {"internal/config", "internal/media"},
	"cmd/sfu":            {"internal/config", "internal/control", "internal/media", "internal/telemetry"},
}

func TestImportsRunOneWay(t *testing.T) {
	out, err := exec.Command("go", "list", "-f", `{{.ImportPath}} {{join .Imports " "}}`, "../../...").Output()
	if err != nil {
		t.Fatalf("go list: %v", err)
	}
	for line := range strings.SplitSeq(strings.TrimSpace(string(out)), "\n") {
		fields := strings.Fields(strings.ReplaceAll(line, module, ""))
		pkg, imports := fields[0], fields[1:]
		allowed, governed := layers[pkg]
		if !governed {
			continue
		}
		for _, imported := range imports {
			if strings.HasPrefix(imported, "github.com/") || !strings.Contains(imported, "/") && imported != "protocol" {
				continue // third party or standard library
			}
			if (strings.HasPrefix(imported, "internal/") || strings.HasPrefix(imported, "protocol")) && !slices.Contains(allowed, imported) {
				t.Errorf("%s imports %s, which the layers do not allow (allowed: %v)", pkg, imported, allowed)
			}
		}
	}
}

// codeRoots are the directories this check covers, relative to the repository root.
var codeRoots = []string{"features/media", "features/scorecard", "infrastructure/sfu"}

func TestFilesStayUnderTheSizeLimit(t *testing.T) {
	root := repositoryRoot(t)
	seen := map[string]bool{}
	for _, dir := range codeRoots {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return err
			}
			rel, _ := filepath.Rel(root, path)
			if isData(rel) {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil || bytes.IndexByte(data, 0) >= 0 {
				return err
			}
			seen[rel] = true
			if problem := sizeProblem(rel, bytes.Count(data, []byte("\n"))); problem != "" {
				t.Error(problem)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	for rel := range sizeBaseline {
		if !seen[rel] {
			t.Errorf("sizeBaseline names %s, which does not exist", rel)
		}
	}
}

// sizeProblem judges one file's line count against the limit and the baseline.
func sizeProblem(rel string, lines int) string {
	reason, listed := sizeBaseline[rel]
	switch {
	case lines > maxFileLines && !listed:
		return fmt.Sprintf("%s has %d lines, over %d: split it by responsibility, or list it in sizeBaseline with its one job", rel, lines, maxFileLines)
	case listed && lines <= maxFileLines:
		return fmt.Sprintf("%s has %d lines and no longer needs its sizeBaseline entry", rel, lines)
	case listed && strings.TrimSpace(reason) == "":
		return fmt.Sprintf("%s is in sizeBaseline without a reason", rel)
	}
	return ""
}

// isData reports whether a path is data or prose rather than code.
func isData(rel string) bool {
	if strings.Contains(rel, "/testdata/") || strings.Contains(rel, "/node_modules/") {
		return true
	}
	switch filepath.Ext(rel) {
	case ".md", ".json", ".sdp", ".ivf", ".csv", ".lock", ".sum":
		return true
	}
	return false
}

func TestFunctionsStayWithinTheLimits(t *testing.T) {
	sfu := filepath.Join(repositoryRoot(t), "features/media/sfu")
	fset := token.NewFileSet()
	err := filepath.WalkDir(sfu, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || filepath.Ext(path) != ".go" {
			return err
		}
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			where := fset.Position(fn.Pos())
			rel, _ := filepath.Rel(sfu, where.Filename)
			if lines := fset.Position(fn.End()).Line - where.Line + 1; lines > maxFuncLines {
				t.Errorf("%s:%d %s has %d lines, over %d", rel, where.Line, fn.Name.Name, lines, maxFuncLines)
			}
			if complexity := cyclomatic(fn); complexity > maxComplexity {
				t.Errorf("%s:%d %s has cyclomatic complexity %d, over %d", rel, where.Line, fn.Name.Name, complexity, maxComplexity)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// cyclomatic counts the decisions in a function, closures included.
func cyclomatic(fn *ast.FuncDecl) int {
	count := 1
	ast.Inspect(fn, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt:
			count++
		case *ast.CaseClause:
			if n.List != nil {
				count++
			}
		case *ast.CommClause:
			if n.Comm != nil {
				count++
			}
		case *ast.BinaryExpr:
			if n.Op == token.LAND || n.Op == token.LOR {
				count++
			}
		}
		return true
	})
	return count
}

// repositoryRoot is the repository's top directory, five levels above this package.
func repositoryRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../../../../..")
	if err != nil {
		t.Fatal(err)
	}
	return root
}
