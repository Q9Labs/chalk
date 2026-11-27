package worker

import (
	"fmt"
	"os"
	"sync"
)

var namespaceFallbackLogOnce sync.Once

func useIsolatedNamespaces() bool {
	if os.Getenv("AWS_LAMBDA_RUNTIME_API") != "" || os.Getenv("RENDERER_LAMBDA") == "1" {
		return false
	}
	if !isolatedNamespacesAvailable() {
		namespaceFallbackLogOnce.Do(func() {
			fmt.Fprintln(os.Stderr, "renderer namespace sandbox unavailable: kernel.apparmor_restrict_unprivileged_userns=1; using the Lambda-compatible no-namespace boundary")
		})
		return false
	}
	return true
}
