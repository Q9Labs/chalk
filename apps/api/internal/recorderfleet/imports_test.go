package recorderfleet_test

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/depcheck"
)

// The fleet controller is provider-neutral: DigitalOcean sits behind its port.
func TestFleetDoesNotDependOnAProvider(t *testing.T) {
	depcheck.Forbid(t, "adapters/digitalocean", "adapters/digitalocean/bootprobe")
}
