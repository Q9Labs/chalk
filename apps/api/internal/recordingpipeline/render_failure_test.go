package recordingpipeline

import "testing"

func TestSanitizeRenderFailureCodeKeepsOnlyStageCodes(t *testing.T) {
	for code, want := range map[string]string{
		"render_download_capture_failed": "render_download_capture_failed",
		"render_commit_failed":           "render_commit_failed",
		"render_attempt_failed":          DefaultRenderFailureCode,
		"":                               DefaultRenderFailureCode,
		"Render_Commit_Failed":           DefaultRenderFailureCode,
		"render_commit_failed\nsecret":   DefaultRenderFailureCode,
		"render_https://host/key_failed": DefaultRenderFailureCode,
	} {
		if got := SanitizeRenderFailureCode(code); got != want {
			t.Errorf("SanitizeRenderFailureCode(%q) = %q, want %q", code, got, want)
		}
	}
}
