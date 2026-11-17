package recordingpipeline

import "regexp"

// DefaultRenderFailureCode names a render failure that no stage claimed.
const DefaultRenderFailureCode = "render_attempt_failed"

var renderFailureCode = regexp.MustCompile(`^render_[a-z_]{1,48}_failed$`)

// SanitizeRenderFailureCode keeps a render worker's failure code only when it has the shape of
// a stage code such as render_download_capture_failed. The code is stored and logged, so it
// never carries worker free text.
func SanitizeRenderFailureCode(code string) string {
	if renderFailureCode.MatchString(code) {
		return code
	}
	return DefaultRenderFailureCode
}
