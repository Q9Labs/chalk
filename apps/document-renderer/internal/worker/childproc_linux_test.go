//go:build linux

package worker

import (
	"context"
	"os"
	"strings"
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
		if os.Getenv("RENDER_TEST_QEMU") == "1" && strings.Contains(err.Error(), "invalid argument") {
			t.Skipf("qemu-user cannot create the Linux network namespace: %v", err)
		}
		t.Fatalf("isolated child: %v", err)
	}
}
