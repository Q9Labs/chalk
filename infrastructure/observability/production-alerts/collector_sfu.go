package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// sfuProbe locates one Chalk SFU node's readiness endpoint. ServerName is the
// name in the node's certificate, which the API also verifies, because the URL
// usually holds an address.
type sfuProbe struct {
	URL, ServerName, ClientCertFile, ClientKeyFile, CAFile string
}

// sfuProbesFromEnv returns one probe per node. CHALK_ALERT_SFU_READY_URLS holds a
// comma-separated list and CHALK_ALERT_SFU_READY_URL a single node; both may be
// set. No node means the SFU is not in production yet, so the collector emits no
// SFU row.
func sfuProbesFromEnv() []sfuProbe {
	var probes []sfuProbe
	seen := make(map[string]bool)
	for _, endpoint := range append(strings.Split(os.Getenv("CHALK_ALERT_SFU_READY_URLS"), ","), os.Getenv("CHALK_ALERT_SFU_READY_URL")) {
		endpoint = strings.TrimSpace(endpoint)
		if endpoint == "" || seen[endpoint] {
			continue
		}
		seen[endpoint] = true
		probes = append(probes, sfuProbe{
			URL:            endpoint,
			ClientCertFile: os.Getenv("CHALK_ALERT_SFU_CLIENT_CERT"),
			ClientKeyFile:  os.Getenv("CHALK_ALERT_SFU_CLIENT_KEY"),
			CAFile:         os.Getenv("CHALK_ALERT_SFU_CA"),
			ServerName:     os.Getenv("CHALK_ALERT_SFU_SERVER_NAME"),
		})
	}
	return probes
}

// collectSFUFleetReadiness probes every node at once and folds them into the one
// global row the monitor reads: unhealthy when any node is, with the reason of the
// first unhealthy node in list order. A single node gives exactly its own row.
func collectSFUFleetReadiness(ctx context.Context, probes []sfuProbe) snapshot {
	nodes := make([]snapshot, len(probes))
	var wg sync.WaitGroup
	for i, probe := range probes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			nodes[i] = collectSFUReadiness(ctx, probe)
		}()
	}
	wg.Wait()
	for _, node := range nodes {
		if node.Value > 0 {
			return node
		}
	}
	return nodes[0]
}

// sfuReadiness is the subset of the SFU /readyz body the alert reads. The node
// incarnation and every other identifier are deliberately not decoded.
type sfuReadiness struct {
	PacketBudget    *int `json:"packetBudget"`
	ReservedPackets *int `json:"reservedPackets"`
	Host            struct {
		AdmissionReason string `json:"admissionReason"`
	} `json:"host"`
}

// collectSFUReadiness fails closed: every path that cannot prove readiness emits
// value 1 with an allowlisted reason. It never exports error text or response
// bodies, because TLS and HTTP errors can hold addresses and certificate names.
func collectSFUReadiness(ctx context.Context, probe sfuProbe) snapshot {
	item := snapshot{Rule: ruleSFUReadiness, Value: 1, Reason: "tls_config", Time: time.Now().UTC().Format(time.RFC3339Nano)}
	client, err := sfuClient(probe)
	if err != nil {
		return item
	}
	item.Reason = "unreachable"
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, probe.URL, nil)
	if err != nil {
		return item
	}
	response, err := client.Do(request)
	if err != nil {
		return item
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
	case http.StatusServiceUnavailable:
		item.Reason = "draining"
		return item
	default:
		item.Reason = "http_status"
		return item
	}
	item.Reason = "invalid_response"
	var ready sfuReadiness
	if json.NewDecoder(io.LimitReader(response.Body, 32*1024)).Decode(&ready) != nil ||
		ready.PacketBudget == nil || ready.ReservedPackets == nil || *ready.PacketBudget <= 0 || *ready.ReservedPackets < 0 {
		return item
	}
	switch ready.Host.AdmissionReason {
	case "":
	// pacer_queue_delay is what SFU builds before scheduler_latency report; drop it once no node runs one.
	case "cpu_steal", "cpu_busy", "scheduler_latency", "pacer_queue_delay", "pacer_drops", "udp_buffer_errors":
		item.Reason = "admission_" + ready.Host.AdmissionReason
		return item
	default:
		return item
	}
	if *ready.ReservedPackets*10 >= *ready.PacketBudget*9 {
		item.Reason = "packet_budget"
		return item
	}
	item.Value, item.Reason = 0, "ready"
	return item
}

func sfuClient(probe sfuProbe) (*http.Client, error) {
	if !strings.HasPrefix(probe.URL, "https://") {
		return nil, fmt.Errorf("plaintext URL")
	}
	certificate, err := tls.LoadX509KeyPair(probe.ClientCertFile, probe.ClientKeyFile)
	if err != nil {
		return nil, fmt.Errorf("client certificate")
	}
	caPEM, err := os.ReadFile(probe.CAFile)
	if err != nil {
		return nil, fmt.Errorf("certificate authority")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("certificate authority")
	}
	return &http.Client{
		Transport: &http.Transport{
			TLSClientConfig:   &tls.Config{Certificates: []tls.Certificate{certificate}, RootCAs: roots, ServerName: probe.ServerName, MinVersion: tls.VersionTLS13},
			DisableKeepAlives: true,
		},
		// A redirect must not turn a failed probe green.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}, nil
}
