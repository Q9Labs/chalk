package main

import (
	"crypto/tls"
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestHTTPRecorderPortsDoNotReuseControlPlaneTLSIdentityForObjectStorage(t *testing.T) {
	base, err := url.Parse("https://control.example")
	if err != nil {
		t.Fatal(err)
	}
	controlTransport := &http.Transport{TLSClientConfig: &tls.Config{Certificates: []tls.Certificate{{}}}}
	control := &http.Client{Transport: controlTransport}
	ports, err := newHTTPRecorderPorts(base, control)
	if err != nil {
		t.Fatal(err)
	}
	objectTransport, ok := ports.object.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("object transport type = %T", ports.object.Transport)
	}
	if objectTransport == controlTransport || objectTransport.TLSClientConfig != nil {
		t.Fatal("object storage transport reused the control-plane client certificate")
	}
}

func TestParseKeyFrameInterval(t *testing.T) {
	for value, want := range map[string]time.Duration{"": 0, "0": 0, " 10s ": 10 * time.Second, "2s": 2 * time.Second} {
		got, err := parseKeyFrameInterval(value)
		if err != nil || got != want {
			t.Fatalf("parseKeyFrameInterval(%q) = %v, %v; want %v", value, got, err, want)
		}
	}
	for _, value := range []string{"1s", "11m", "ten", "-5s"} {
		if _, err := parseKeyFrameInterval(value); err == nil {
			t.Fatalf("parseKeyFrameInterval(%q) accepted", value)
		}
	}
}
