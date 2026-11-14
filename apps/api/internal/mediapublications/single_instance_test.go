package mediapublications

import (
	"os"
	"strings"
	"testing"
)

// The evidence stores of Service live in one process. This pins the deployment
// fact they rely on: the API is one container with a fixed name, which Podman
// cannot start twice.
func TestAPIDeploymentIsASingleNamedContainer(t *testing.T) {
	quadlet, err := os.ReadFile("../../../../infrastructure/managed-episode/quadlet/chalk-api.container.in")
	if err != nil {
		t.Fatalf("read the API quadlet: %v", err)
	}
	if got := strings.Count(string(quadlet), "\nContainerName=chalk-api\n"); got != 1 {
		t.Fatalf("the API quadlet must name exactly one fixed container, found %d; move the evidence stores out of process before running more API instances", got)
	}
}
