package recordingpresentation

import (
	"testing"
)

func TestNewComposite720PProfile(t *testing.T) {
	t.Parallel()

	profile, err := NewComposite720PProfile("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err != nil {
		t.Fatalf("new profile: %v", err)
	}
	if profile.Version != ProfileVersionComposite720PV1 || profile.Viewport.Width != 1280 || profile.Viewport.Height != 720 {
		t.Fatalf("profile = %#v", profile)
	}
	if profile.UIBuildSHA256 != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Fatal("new profile lost its rollback compatibility digest")
	}
}

func TestNewComposite720PProfileRequiresRollbackDigest(t *testing.T) {
	for _, digest := range []string{"", "invalid"} {
		if _, err := NewComposite720PProfile(digest); err == nil {
			t.Fatalf("accepted invalid rollback digest %q", digest)
		}
	}
}
