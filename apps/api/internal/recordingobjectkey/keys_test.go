package recordingobjectkey_test

import (
	"slices"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingobjectkey"
)

func TestKeysKeepTheStoredLayout(t *testing.T) {
	for name, tc := range map[string]struct{ got, want string }{
		"tenant":       {recordingobjectkey.TenantPrefix("t1"), "tenants/t1/"},
		"recordings":   {recordingobjectkey.TenantRecordingsPrefix("t1"), "tenants/t1/recordings/"},
		"bundle":       {recordingobjectkey.CaptureBundle("t1", "r1", 3, 4, "a1"), "tenants/t1/recordings/r1/capture/3/bundles/4/a1.bundle"},
		"presentation": {recordingobjectkey.Presentation("t1", "r1", 3, "h1"), "tenants/t1/recordings/r1/presentation/3/h1"},
		"render":       {recordingobjectkey.Render("t1", "r1", 3, "recording_video", "a1", "mp4"), "tenants/t1/recordings/r1/render/3/recording_video/a1.mp4"},
	} {
		if tc.got != tc.want {
			t.Errorf("%s key = %q, want %q", name, tc.got, tc.want)
		}
	}
}

func TestRetiredCaptureBundlesStayReadable(t *testing.T) {
	want := []string{"temporary/recordings/r1/capture/3/bundles/4/a1.bundle", "recordings/r1/capture/3/bundles/4/a1.bundle"}
	if got := recordingobjectkey.RetiredCaptureBundles("r1", 3, 4, "a1"); !slices.Equal(got, want) {
		t.Fatalf("retired keys = %v, want %v", got, want)
	}
}
