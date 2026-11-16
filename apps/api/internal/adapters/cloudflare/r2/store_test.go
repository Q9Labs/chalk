package r2

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

func TestInternalReadsKeepPublicDownloadEndpoint(t *testing.T) {
	internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__local-dashboard-artifacts/local-dashboard/transcript.json" {
			t.Errorf("object request path = %q", r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"cues":[]}`)
	}))
	defer internal.Close()
	public := "http://127.0.0.1:3070/__local-dashboard-artifacts"
	store, err := NewStore(config.R2Config{
		Bucket: "local-dashboard", Endpoint: public,
		InternalEndpoint: internal.URL + "/__local-dashboard-artifacts",
		AccessKeyID:      "local-dashboard", SecretAccessKey: "local-dashboard-secret",
		RequestTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	object, err := store.GetObject(context.Background(), "transcript.json")
	if err != nil {
		t.Fatal(err)
	}
	defer object.Body.Close()
	body, err := io.ReadAll(object.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"cues":[]}` {
		t.Fatalf("object = %q", body)
	}
	signed, err := store.CreateDownloadURL(context.Background(), objectstorage.CreateDownloadURLInput{Key: "transcript.json", ExpiresIn: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(signed.URL, public+"/local-dashboard/transcript.json?") {
		t.Fatalf("browser download must retain the public endpoint, got %q", signed.URL)
	}
}
