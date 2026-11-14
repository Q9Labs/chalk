package internal_test

import (
	"os/exec"
	"slices"
	"strings"
	"testing"
)

const internalPrefix = "github.com/q9labs/chalk/apps/api/internal/"

// goList returns the packages a package imports, directly or through its
// dependencies, as paths under internal/.
func goList(t *testing.T, pkg string, template string) []string {
	t.Helper()
	out, err := exec.Command("go", "list", "-f", template, "./"+pkg).Output()
	if err != nil {
		t.Fatalf("go list %s: %v", pkg, err)
	}
	var result []string
	for _, line := range strings.Fields(string(out)) {
		if name, ok := strings.CutPrefix(line, internalPrefix); ok {
			result = append(result, name)
		}
	}
	slices.Sort(result)
	return result
}

// Packages a lower layer must not reach, even through its dependencies.
func TestForbiddenImportDirections(t *testing.T) {
	forbidden := map[string][]string{
		// MCP authorization needs a public-address check, not webhook delivery.
		"mcpauth": {"webhooks"},
	}
	for pkg, banned := range forbidden {
		deps := goList(t, pkg, `{{join .Deps "\n"}}`)
		for _, name := range banned {
			if slices.Contains(deps, name) {
				t.Errorf("%s depends on %s; move the shared piece to a lower package", pkg, name)
			}
		}
	}
}

// The tool catalog reaches the application only through the ports Bind
// receives. It may name the shared scope list, and nothing else of the API.
func TestToolCatalogImportsOnlyTheScopeList(t *testing.T) {
	for _, name := range goList(t, "mcptools", `{{join .Imports "\n"}}`) {
		if name != "authentication" {
			t.Errorf("mcptools imports %s; pass it through the ports Bind receives", name)
		}
	}
}

// config and observability sit below the domain packages, but each still
// imports some of them. The lists hold today's edges and can only shrink: a
// new edge fails, and so does a listed edge that is gone, so the list is
// edited down with the fix.
func TestLegacyDirectionDebtOnlyShrinks(t *testing.T) {
	legacy := map[string][]string{
		"config":        {"apikeys", "artifactpolicy", "authentication", "mediaplane", "recordingpipeline", "spaces", "tenantlimits", "tenants"},
		"observability": {"accessgrants", "adapters/postgres/sqlc", "apikeys", "captureplane", "capturesignaling", "mediaplane", "mediaplaneproviders", "recordingpipeline"},
	}
	for pkg, listed := range legacy {
		actual := slices.DeleteFunc(goList(t, pkg, `{{join .Imports "\n"}}`), func(name string) bool { return name == "utilities" })
		for _, name := range actual {
			if !slices.Contains(listed, name) {
				t.Errorf("%s imports %s, a new edge from below the domain; invert it", pkg, name)
			}
		}
		for _, name := range listed {
			if !slices.Contains(actual, name) {
				t.Errorf("%s no longer imports %s; remove it from the list", pkg, name)
			}
		}
	}
}
