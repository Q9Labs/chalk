package recordingpresentation

import (
	"encoding/json"
	"strings"
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
	encoded, err := json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "uiBuildSha256") {
		t.Fatal("new profile contains retired UI digest")
	}
}
