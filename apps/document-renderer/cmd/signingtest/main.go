package main

import (
	"encoding/json"
	"fmt"
	"os"

	controlplane "github.com/q9labs/chalk/apps/document-renderer/internal/control"
)

type signedRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

func main() {
	if len(os.Args) != 6 {
		fmt.Fprintln(os.Stderr, "usage: signingtest <secret> <environment> <release> <audience> <journey>")
		os.Exit(2)
	}
	body := []byte(`{"job_id":"00000000-0000-0000-0000-000000000001"}`)
	client := controlplane.NewControlClient("http://control.invalid", os.Args[1], os.Args[2], os.Args[3], os.Args[4]).WithJourney(
		os.Args[5],
		"00-1234567890abcdef1234567890abcdef-abcdef1234567890-01",
		"interop=trace-state",
	)
	encoded, err := json.Marshal(signedRequest{Method: "POST", Path: "/internal/v1/presenting/render/claim", Headers: client.SignedHeaders("POST", "/internal/v1/presenting/render/claim", body), Body: string(body)})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(string(encoded))
}
