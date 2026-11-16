//go:build !unix

package telemetry

// processCPUSeconds reports the CPU time as unknown, because this platform has no getrusage.
func processCPUSeconds() (float64, bool) {
	return 0, false
}
