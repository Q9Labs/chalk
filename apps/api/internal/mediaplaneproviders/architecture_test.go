package mediaplaneproviders_test

import (
	"os/exec"
	"slices"
	"strings"
	"testing"
)

func TestConsumerPackagesDoNotDependOnConcreteMediaPlaneProviders(t *testing.T) {
	consumers := []string{
		"github.com/q9labs/chalk/apps/api/internal/httpapi",
		"github.com/q9labs/chalk/apps/api/internal/observability",
		"github.com/q9labs/chalk/apps/api/internal/publicinviteapp",
	}
	forbidden := []string{
		"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/rtk",
		"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu",
		"github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders",
	}

	for _, consumer := range consumers {
		t.Run(consumer, func(t *testing.T) {
			command := exec.Command("go", "list", "-deps", "-f", "{{.ImportPath}}", consumer)
			output, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("list dependencies: %v\n%s", err, output)
			}

			dependencies := strings.Fields(string(output))
			for _, concretePackage := range forbidden {
				if slices.Contains(dependencies, concretePackage) {
					t.Errorf("consumer depends on concrete media-plane package %q", concretePackage)
				}
			}
		})
	}
}
