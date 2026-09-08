package recordingpresentation

import (
	"strings"
	"testing"
)

func TestNewComposite720PProfile(t *testing.T) {
	t.Parallel()

	profile, err := NewComposite720PProfile(strings.Repeat("a", 64))
	if err != nil {
		t.Fatalf("new profile: %v", err)
	}
	if profile.Version != ProfileVersionComposite720PV1 || profile.Viewport.Width != 1280 || profile.Viewport.Height != 720 {
		t.Fatalf("profile = %#v", profile)
	}
	if _, err := NewComposite720PProfile("not-a-digest"); err == nil {
		t.Fatal("expected invalid UI build digest to fail")
	}
}
