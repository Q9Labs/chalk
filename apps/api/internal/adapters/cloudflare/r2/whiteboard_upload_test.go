package r2

import (
	"context"
	"encoding/base64"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

func TestWhiteboardPresignBindsConditionalCreateAndMetadata(t *testing.T) {
	store, err := NewStore(config.R2Config{
		Bucket: "fixture", Endpoint: "https://storage.example.test", AccessKeyID: "fixture-key",
		SecretAccessKey: "fixture-secret", RequestTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	signed, err := store.CreateUploadURL(context.Background(), objectstorage.CreateUploadURLInput{
		Key: "whiteboard/fixture", ContentType: "image/png", ContentLength: 1024,
		ChecksumSHA256: base64.StdEncoding.EncodeToString(make([]byte, 32)),
		ExpiresIn:      time.Minute, IfNoneMatch: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	address, err := url.Parse(signed.URL)
	if err != nil {
		t.Fatal(err)
	}
	headers := strings.Split(address.Query().Get("X-Amz-SignedHeaders"), ";")
	for _, name := range []string{"content-length", "content-type", "if-none-match", "x-amz-checksum-sha256"} {
		if !slices.Contains(headers, name) {
			t.Errorf("signed headers %v do not bind %q", headers, name)
		}
	}
}
