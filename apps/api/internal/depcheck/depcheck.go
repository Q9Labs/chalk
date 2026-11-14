// Package depcheck lets a package pin its import direction in a test: it fails
// when the package, in production code, reaches a forbidden package.
package depcheck

import (
	"os/exec"
	"strings"
	"testing"
)

const module = "github.com/q9labs/chalk/apps/api/internal/"

// Forbid fails the test when the package in the test's working directory depends,
// directly or through any import, on one of the named internal packages.
func Forbid(t *testing.T, forbidden ...string) {
	t.Helper()
	output, err := exec.Command("go", "list", "-deps", "-f", "{{.ImportPath}}", ".").Output()
	if err != nil {
		t.Fatalf("go list -deps: %v", err)
	}
	dependencies := map[string]bool{}
	for _, dependency := range strings.Fields(string(output)) {
		dependencies[dependency] = true
	}
	for _, name := range forbidden {
		if dependencies[module+name] {
			t.Errorf("imports internal/%s, which this package must not reach", name)
		}
	}
}
