//go:build linux

package worker

import (
	"context"
	"os"
	"testing"
	"time"
)

func init() {
	if os.Getenv("RENDER_CHILD_MODE") == "selftest" {
		os.Exit(0)
	}
}

func TestIsolatedChildEnvironmentAndProcessSetup(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AWS_ACCESS_KEY_ID", "must-not-reach-child")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := runIsolatedChild(ctx, executable, "selftest"); err != nil {
		t.Fatalf("isolated child: %v", err)
	}
}
