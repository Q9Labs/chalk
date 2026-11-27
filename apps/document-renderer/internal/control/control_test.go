package control

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestControlRequestsCarryOnlyOpaqueCapability(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("x-chalk-render-capability"); got != "job-capability" {
			t.Errorf("capability header = %q", got)
		}
		for _, header := range []string{"x-chalk-workload-environment", "x-chalk-workload-release", "x-chalk-workload-role"} {
			if got := r.Header.Get(header); got != "" {
				t.Errorf("ambient workload header %s = %q", header, got)
			}
		}
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client := NewControlClient(server.URL).WithCapability("job-capability")
	if err := client.Complete(context.Background(), Assignment{}); err != nil {
		t.Fatal(err)
	}
}
