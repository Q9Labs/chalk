package main

import (
	"crypto/tls"
	"net/http"
	"net/url"
	"testing"
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
