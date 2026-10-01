package recorderworker_test

import (
	"os/exec"
	"strings"
	"testing"
)

func TestRecorderBinariesDoNotDependOnHTTPAPI(t *testing.T) {
	for _, binary := range []string{"recorder-capture", "recorder-render", "recorder-node-bootstrap"} {
		t.Run(binary, func(t *testing.T) {
			command := exec.Command("go", "list", "-deps", "github.com/q9labs/chalk/apps/api/cmd/"+binary)
			output, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("list production dependencies: %v\n%s", err, output)
			}
			for _, dependency := range strings.Fields(string(output)) {
				if dependency == "github.com/q9labs/chalk/apps/api/internal/httpapi" || strings.HasPrefix(dependency, "github.com/q9labs/chalk/apps/api/internal/httpapi/") {
					t.Errorf("recorder binary depends on HTTP API package %q", dependency)
				}
			}
		})
	}
}
