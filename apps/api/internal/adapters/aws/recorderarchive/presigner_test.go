package recorderarchive

import (
	"context"
	"net/url"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

func TestPresignCoversStartupWindowAndDownload(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "archive-test")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "archive-test-not-a-secret")
	t.Setenv("AWS_SESSION_TOKEN", "")
	archive := recorderfleet.ArchiveSpec{Bucket: "example-artifacts", Region: "ap-southeast-1", SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Key: "recorder/capture/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tar.gz"}
	for _, timeout := range []time.Duration{10 * time.Minute, 45 * time.Minute} {
		signed, err := Presign(context.Background(), archive, timeout)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := url.Parse(signed)
		if err != nil {
			t.Fatal(err)
		}
		lifetime, err := time.ParseDuration(parsed.Query().Get("X-Amz-Expires") + "s")
		if err != nil || lifetime != timeout+5*time.Minute {
			t.Fatalf("presign lifetime = %s, %v", lifetime, err)
		}
	}
	for _, timeout := range []time.Duration{0, -time.Second, 7 * 24 * time.Hour} {
		if _, err := Presign(context.Background(), archive, timeout); err == nil {
			t.Fatalf("unsupported startup window accepted: %s", timeout)
		}
	}
}
