package recordingpipeline

// ErrorCodeCaptureEmpty marks a capture that committed no media bundle: nothing was heard or seen.
const ErrorCodeCaptureEmpty = "capture_empty"

// CaptureBundleCounts are the committed bundles of one capture. A gap bundle covers time with no media.
type CaptureBundleCounts struct {
	MediaBundles int
	GapBundles   int
}

// CaptureObservations are what the recorder saw while it captured, reported when the capture
// completes. The API stores them so an operator can see a capture that ran with no packets without
// decrypting its manifest. A recorder that predates them, or a completion that never ran a
// capture, sends none.
type CaptureObservations struct {
	Tracks  int
	Packets int64
}
