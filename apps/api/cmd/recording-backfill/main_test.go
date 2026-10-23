package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/r2"
	"github.com/q9labs/chalk/apps/api/internal/config"
)

func TestBackfillRequiresExplicitBoundedBatch(t *testing.T) {
	for _, args := range [][]string{nil, {"--apply"}, {"--batch-size", "0"}, {"--batch-size", "101"}, {"--batch-size", "10", "--timeout", "21m"}, {"--batch-size", "10", "--after-recording", "invalid"}} {
		if err := run(context.Background(), args, &bytes.Buffer{}); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}

func TestBackfillChecksEverySourceObjectWithoutWriting(t *testing.T) {
	for _, test := range []struct {
		name      string
		status    int
		size      string
		available bool
		fails     bool
	}{
		{"retained", 200, "123", true, false},
		{"missing", 404, "", false, false},
		{"empty", 200, "0", false, false},
		{"unverifiable", 403, "", false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var paths []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.Method != http.MethodHead {
					t.Errorf("unexpected storage mutation: %s", req.Method)
				}
				paths = append(paths, req.URL.Path)
				if strings.HasSuffix(req.URL.Path, "/first") {
					w.Header().Set("Content-Length", "20")
					return
				}
				if test.size != "" {
					w.Header().Set("Content-Length", test.size)
				}
				w.WriteHeader(test.status)
			}))
			defer server.Close()
			store, err := r2.NewStore(config.R2Config{Endpoint: server.URL, Bucket: "test", AccessKeyID: "test", SecretAccessKey: "test", RequestTimeout: time.Second})
			if err != nil {
				t.Fatal(err)
			}
			available, err := inspectSources(context.Background(), store, []string{"first", "second"})
			if available != test.available || (err != nil) != test.fails || len(paths) != 2 {
				t.Fatalf("available=%v err=%v paths=%v", available, err, paths)
			}
		})
	}
}
