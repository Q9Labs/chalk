package chalksfu_test

import (
	"runtime"
	"testing"
)

// skipWhereTheSFUDoesNotRun skips a test that starts the SFU as a process: the SFU ships on Linux only,
// and its conformance suite needs real loopback media.
func skipWhereTheSFUDoesNotRun(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the Chalk SFU runs on Linux only")
	}
}
