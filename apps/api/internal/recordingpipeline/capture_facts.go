package recordingpipeline

// ErrorCodeCaptureEmpty marks a capture that committed no media bundle: nothing was heard or seen.
const ErrorCodeCaptureEmpty = "capture_empty"

// CaptureBundleCounts are the committed bundles of one capture. A gap bundle covers time with no media.
type CaptureBundleCounts struct {
	MediaBundles int
	GapBundles   int
}
