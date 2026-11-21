//go:build !faultinject

package recorderworker

// dropCaptureRTP in a release build is always false: the fault hook exists only under the
// faultinject build tag so no shipped binary can drop media on demand.
func dropCaptureRTP() bool { return false }
