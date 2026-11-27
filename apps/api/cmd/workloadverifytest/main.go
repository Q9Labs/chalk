package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
)

type signedRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

type memoryNonces struct{ used map[string]bool }

func (n *memoryNonces) Consume(_ context.Context, nonce string, _ time.Duration) (bool, error) {
	if n.used[nonce] {
		return false, nil
	}
	n.used[nonce] = true
	return true, nil
}

func main() {
	if len(os.Args) != 6 {
		fmt.Fprintln(os.Stderr, "usage: workloadverifytest <request.json> <secret> <environment> <release> <audience>")
		os.Exit(2)
	}
	encoded, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var input signedRequest
	if err := json.Unmarshal(encoded, &input); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	request, err := http.NewRequest(input.Method, "http://control.invalid"+input.Path, strings.NewReader(input.Body))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for name, value := range input.Headers {
		request.Header.Set(name, value)
	}
	authorizer := httpapi.NewHMACWorkloadAuthorizer(httpapi.HMACWorkloadAuthorizerConfig{
		Secret: []byte(os.Args[2]), Environment: os.Args[3], ReleaseID: os.Args[4], Audience: os.Args[5], Nonces: &memoryNonces{used: map[string]bool{}},
	})
	if err := authorizer.AuthorizeWorkload(context.Background(), request, "document-renderer"); err != nil {
		fmt.Fprintf(os.Stderr, "workload verification failed: %v\n", err)
		os.Exit(1)
	}
	for _, header := range []string{"X-Chalk-Journey-ID", "traceparent", "tracestate"} {
		if request.Header.Get(header) == "" {
			fmt.Fprintf(os.Stderr, "signed request omitted %s\n", header)
			os.Exit(1)
		}
	}
	fmt.Println("workload signer/verifier interop ok")
}
