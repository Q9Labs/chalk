package recordingpresentation

import (
	"testing"
)

func TestNewComposite720PProfile(t *testing.T) {
	t.Parallel()

	profile, err := NewComposite720PProfile()
	if err != nil {
		t.Fatalf("new profile: %v", err)
	}
	if profile.Version != ProfileVersionComposite720PV1 || profile.Viewport.Width != 1280 || profile.Viewport.Height != 720 {
		t.Fatalf("profile = %#v", profile)
	}
	if profile.UIBuildSHA256 != "" {
		t.Fatal("new profile unexpectedly pins a UI build")
	}
}
