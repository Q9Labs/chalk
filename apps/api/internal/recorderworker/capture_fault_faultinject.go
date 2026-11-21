//go:build faultinject

package recorderworker

import (
	"os"
	"sync"
)

var captureFault = sync.OnceValue(func() string { return os.Getenv("CHALK_RECORDER_FAULT") })

// dropCaptureRTP under the faultinject tag reads CHALK_RECORDER_FAULT once per process:
// "drop_rtp" makes every capture reader discard media, the deterministic empty-capture fault.
func dropCaptureRTP() bool { return captureFault() == "drop_rtp" }
