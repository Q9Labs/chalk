package recordernodebootstrap

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestBootstrapRequestPreservesTLSVerificationError(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	endpoint, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client := &Client{baseURL: endpoint, httpClient: http.DefaultClient}
	err = client.doJSON(context.Background(), "/bootstrap", nil, struct{}{}, new(struct{}))
	if !errors.Is(err, ErrBootstrapUnavailable) || !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("TLS request error = %v", err)
	}
}
