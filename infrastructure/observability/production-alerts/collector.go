// This alert-only executable uses the API module's pinned pgx dependency.
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	_ "embed"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
)

//go:embed state.sql
var stateSQL string

// sfuRetirementDebtSQL ages the oldest unpaid retirement debt, as the API's /readyz
// body does, and gives 0 when none is owed. A healthy fleet pays a debt in seconds.
const sfuRetirementDebtSQL = `select coalesce(extract(epoch from now() - min(created_at)), 0)::bigint from sfu_retirement_debts`

type snapshot struct {
	Tenant        string     `json:"chalk_alert_tenant"`
	TenantName    string     `json:"chalk_alert_tenant_name"`
	ExpiresAt     *time.Time `json:"-"`
	UnknownExpiry int64      `json:"-"`
	Time          string     `json:"_time"`
	Stream        string     `json:"chalk_alert_stream"`
	Rule          string     `json:"chalk_alert_rule"`
	Value         int64      `json:"chalk_alert_value"`
	Summary       string     `json:"chalk_alert_summary"`
	Headline      string     `json:"chalk_alert_headline"`
	Next          string     `json:"chalk_alert_next"`
	Engineers     string     `json:"chalk_alert_engineers"`
	Reason        string     `json:"chalk_alert_reason,omitempty"`
}

func main() {
	if err := run(); err != nil {
		// Do not print pgx/HTTP errors: they can contain private connection details.
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	mode := ""
	if len(os.Args) == 2 {
		mode = os.Args[1]
	} else if len(os.Args) != 1 {
		return errors.New("usage: collector [--check|--test|--clear-test]")
	}
	var snapshots []snapshot
	var collectionErr error
	switch mode {
	case "--test", "--clear-test":
		value := int64(1)
		if mode == "--clear-test" {
			value = 0
		}
		snapshots = []snapshot{{Rule: "delivery-test", Value: value, Summary: "TEST: Chalk production alert delivery proof; no user failure was induced."}}
	case "", "--check":
		snapshots, collectionErr = collectState(ctx, http.DefaultClient, os.Getenv("CHALK_DATABASE_URL"), os.Getenv("CHALK_ALERT_SYNC_READY_URL"), sfuProbesFromEnv())
	default:
		return errors.New("unknown collector mode")
	}
	if mode == "" || mode == "--check" {
		snapshots = append(snapshots, collectCertificateExpiry(ctx, sfuProbesFromEnv(), os.Getenv("CHALK_ALERT_DIRECT_DOOR_URL"), time.Now())...)
	}
	for i := range snapshots {
		formatMessage(&snapshots[i])
		snapshots[i].Engineers = "For engineers: " + snapshots[i].Rule + "; open the affected Axiom dataset and run | search <episode-id> using the affected Episode ID."
		if snapshots[i].Rule == "sync-readiness" {
			snapshots[i].Engineers = "For engineers: sync-readiness; inspect /readyz and sync.readiness.failed events, then systemctl status chalk-alert-state.timer chalk-alert-state.service."
		}
		if snapshots[i].Rule == "certificate-expiry" {
			snapshots[i].Engineers = "For engineers: certificate-expiry; run `openssl s_client -connect <host>:443 </dev/null | openssl x509 -noout -enddate` for the door, or deploy/certs for the SFU, then the renewal steps in the production-alerts README."
		}
		if snapshots[i].Rule == "sfu-readiness" {
			snapshots[i].Engineers = "For engineers: sfu-readiness; open /readyz on the node through the SFU deploy tunnel and read its media telemetry journal lines."
		}
		if snapshots[i].Time == "" {
			snapshots[i].Time = time.Now().UTC().Format(time.RFC3339Nano)
		}
		snapshots[i].Stream = "production-state-v2"
	}
	if mode == "--check" {
		if err := json.NewEncoder(os.Stdout).Encode(snapshots); err != nil {
			return err
		}
		return collectionErr
	}
	token, dataset := ingestConfig(os.Getenv("OTEL_EXPORTER_OTLP_LOGS_HEADERS"))
	if value := os.Getenv("CHALK_ALERT_AXIOM_TOKEN"); value != "" {
		token = value
	}
	if value := os.Getenv("CHALK_ALERT_LOG_DATASET"); value != "" {
		dataset = value
	}
	if token == "" || dataset == "" {
		return errors.New("Axiom ingest token and log dataset are required")
	}
	if err := ingest(ctx, http.DefaultClient, "https://api.axiom.co/v1/datasets/"+url.PathEscape(dataset)+"/ingest", token, snapshots); err != nil {
		return err
	}
	return collectionErr
}

func message(rule string) (headline, impact, next string) {
	switch rule {
	case "recording":
		return "A class was not recorded", "The Recording stopped before it finished, so there is no complete video for this class.", "An engineer must check immediately whether any retained source can be recovered; a complete video cannot be promised."
	case "recording-stop":
		return "A Recording has not finished stopping", "Capture finished more than two minutes ago, but Sync still reports stopping. This can block Episode end and another Episode in the same Space.", "An engineer must check capture-stopped callback delivery and pipeline maintenance now."
	case "sync-readiness":
		return "Sync has stayed unready", "Sync was unready in at least four minute samples in five minutes and the latest sample is still unready. Joining or reconnecting may fail; existing sockets may still work.", "An engineer must check Sync readiness and its dependency diagnostics now."
	case "sfu-readiness":
		return "An own SFU node is refusing new calls or unreachable", "At least one own SFU node was unhealthy in at least four minute samples in five minutes and the latest sample is still unhealthy. New calls may fail to start on it, and live calls may drop if the node is unreachable.", "An engineer must check the SFU nodes' readiness, load and network now."
	case "certificate-expiry":
		return "A Chalk certificate is close to expiring", "A certificate that the own SFU or the direct door needs will expire soon, or the direct door could not complete a TLS handshake. Once it expires, calls on that path fail or fall back to the slower Tunnel.", "An engineer must renew it now: the own SFU certificates with deploy/certs and deploy, the direct door by checking that its proxy can renew over port 443."
	case "sfu-retirement-debt":
		return "An own SFU node is not answering retire requests", "The oldest unpaid retirement debt has stayed above its age limit. A node that never acknowledges a retire keeps the stale sessions of moved or ended Episodes until it restarts.", "An engineer must find the silent node and restart it if it is up but not answering control calls."
	case "export":
		return "A class video could not be produced", "The class was recorded, but turning it into a video file failed or is taking longer than 14 hours.", "An engineer needs to fix the cause and retry the Export before the retained Recording expires; check its source cleanup deadline now."
	case "transcript":
		return "A class transcript failed or is taking longer than 30 minutes", "The video is not affected.", "An engineer needs to check the source expiry and retry before it expires; a transcript cannot be promised."
	case "webhook":
		return "A customer's system was not told about a class event", "Chalk tried several times to reach the customer's server and gave up, so their attendance or Recording records may be out of date.", "An engineer must check the customer's server now, then redeliver the event; automatic retries have ended."
	default:
		return "TEST: Chalk alert delivery", "No customer failure was induced.", "This only tests notification delivery; no customer action is needed."
	}
}

func formatMessage(item *snapshot) {
	item.Headline, item.Summary, item.Next = message(item.Rule)
	if item.Rule == "sync-readiness" || item.Rule == "sfu-readiness" || (item.Rule == "certificate-expiry" && item.Value > 0) {
		item.Summary += " Latest readiness reason: " + item.Reason + "."
	}
	if item.Tenant != "" {
		item.TenantName = safeTenantName(item.TenantName)
		item.Summary = "Tenant: " + item.TenantName + ". " + item.Summary
	}
	if item.ExpiresAt != nil {
		if item.ExpiresAt.Before(time.Now()) {
			item.Next = "The earliest affected source expired at " + item.ExpiresAt.UTC().Format(time.RFC3339) + "; recovery is not promised. An engineer must check what remains now."
		} else {
			item.Next += " Earliest affected source expires at " + item.ExpiresAt.UTC().Format(time.RFC3339) + "."
		}
	}
	if (item.Rule == "export" || item.Rule == "transcript") && item.Value > 0 && item.UnknownExpiry > 0 {
		item.Next += " Some source expiry times are unknown; an engineer must check them now."
	}
}

func collectState(ctx context.Context, client *http.Client, databaseURL, readinessURL string, sfu []sfuProbe) ([]snapshot, error) {
	// Preserve the independent readiness observations even if the SQL snapshot fails.
	readiness := []snapshot{collectReadiness(ctx, client, readinessURL)}
	if len(sfu) > 0 {
		readiness = append(readiness, collectSFUFleetReadiness(ctx, sfu))
	}
	databaseCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	snapshots, err := collect(databaseCtx, databaseURL)
	return append(snapshots, readiness...), err
}

func collectReadiness(ctx context.Context, client *http.Client, endpoint string) snapshot {
	if endpoint == "" {
		endpoint = "http://127.0.0.1:14100/readyz"
	}
	item := snapshot{Rule: "sync-readiness", Value: 1, Reason: "unreachable", Time: time.Now().UTC().Format(time.RFC3339Nano)}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		item.Reason = "invalid_probe_url"
		return item
	}
	// A redirect to a healthy landing page must not turn a failed probe green.
	probeClient := *client
	probeClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := probeClient.Do(request)
	if err != nil {
		return item
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusOK {
		item.Value, item.Reason = 0, "ready"
		return item
	}
	item.Reason = fmt.Sprintf("http_%d", response.StatusCode)
	var health struct {
		Reason       string `json:"reason"`
		Dependencies struct {
			Reason string `json:"reason"`
		} `json:"dependencies"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 32*1024)).Decode(&health) == nil {
		reason := health.Dependencies.Reason
		if reason == "" {
			reason = health.Reason
		}
		// Only protocol reason codes leave the probe; never export response bodies.
		switch reason {
		case "database_unavailable", "database_not_writable_primary", "incompatible_database_migration", "unsupported_postgres_version",
			"unsafe_database_durability", "synchronous_commit_disabled", "lifecycle_intent_lag", "synchronous_standby_not_configured",
			"synchronous_standby_unavailable", "synchronous_standby_lag", "required_process_unavailable", "readiness_process_unavailable",
			"lifecycle_consumer_unavailable", "lifecycle_consumer_initializing", "lifecycle_consumer_stale",
			"external_operation_consumer_unavailable", "external_operation_consumer_initializing", "external_operation_consumer_stale",
			"notification_listener_unavailable", "retention_cleanup_unavailable", "provider_bridge_not_configured", "provider_bridge_unavailable",
			"non_production_stateholder", "development_token_verifier", "invalid_token_verifier", "probe_failed":
			item.Reason = reason
		}
	}
	return item
}

// sfuProbe locates one own-SFU node's readiness endpoint. ServerName is the
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
	item := snapshot{Rule: "sfu-readiness", Value: 1, Reason: "tls_config", Time: time.Now().UTC().Format(time.RFC3339Nano)}
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

// Certificate expiry warns twice. The 21-day and the 7-day text differ, so Axiom
// groups them apart and notifies again at 7 days.
const (
	certWarnWindow   = 21 * 24 * time.Hour
	certUrgentWindow = 7 * 24 * time.Hour
)

// certReading is one certificate the collector can see. A failed reading carries
// the allowlisted reason that needs an engineer; it never holds TLS error text.
type certReading struct {
	label    string
	notAfter time.Time
	failure  string
}

// collectCertificateExpiry gives one global row when a certificate source is
// configured and none otherwise. Value 1 means a certificate expires within 21
// days, has expired, or the direct door cannot finish a TLS handshake. An SFU node
// that cannot be reached is the readiness row's concern, not this one's.
func collectCertificateExpiry(ctx context.Context, probes []sfuProbe, doorURL string, now time.Time) []snapshot {
	var readings []certReading
	if len(probes) > 0 {
		if notAfter, ok := fileCertificateNotAfter(probes[0].ClientCertFile); ok {
			readings = append(readings, certReading{label: "the API client certificate for the own SFU", notAfter: notAfter})
		}
	}
	for _, probe := range probes {
		if notAfter, ok := sfuServerCertificateNotAfter(ctx, probe); ok {
			readings = append(readings, certReading{label: "an own SFU server certificate", notAfter: notAfter})
		}
	}
	if doorURL != "" {
		readings = append(readings, doorCertificate(ctx, doorURL))
	}
	if len(readings) == 0 {
		return nil
	}
	item := snapshot{Rule: "certificate-expiry", Reason: "all_valid", Time: now.UTC().Format(time.RFC3339Nano)}
	worst := time.Duration(1<<63 - 1)
	for _, reading := range readings {
		if reading.failure != "" {
			item.Value, item.Reason = 1, reading.failure
			return []snapshot{item}
		}
		if left := reading.notAfter.Sub(now); left < worst && left <= certWarnWindow {
			worst = left
			item.Value = 1
			switch {
			case left <= 0:
				item.Reason = reading.label + " has expired"
			case left <= certUrgentWindow:
				item.Reason = reading.label + " expires within 7 days"
			default:
				item.Reason = reading.label + " expires within 21 days"
			}
		}
	}
	return []snapshot{item}
}

func fileCertificateNotAfter(path string) (time.Time, bool) {
	pemBytes, err := os.ReadFile(path)
	if err != nil {
		return time.Time{}, false
	}
	for {
		var block *pem.Block
		block, pemBytes = pem.Decode(pemBytes)
		if block == nil {
			return time.Time{}, false
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		leaf, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return time.Time{}, false
		}
		return leaf.NotAfter, true
	}
}

func sfuServerCertificateNotAfter(ctx context.Context, probe sfuProbe) (time.Time, bool) {
	client, err := sfuClient(probe)
	if err != nil {
		return time.Time{}, false
	}
	return leafNotAfter(ctx, probe.URL, client.Transport.(*http.Transport).TLSClientConfig)
}

func doorCertificate(ctx context.Context, doorURL string) certReading {
	reading := certReading{label: "the direct door certificate", failure: "the direct door could not finish a TLS handshake"}
	notAfter, ok := leafNotAfter(ctx, doorURL, &tls.Config{MinVersion: tls.VersionTLS12})
	if ok {
		reading.notAfter, reading.failure = notAfter, ""
	}
	return reading
}

// leafNotAfter completes a verified TLS handshake with the URL's host and reads the
// server certificate's expiry. A TLS error says nothing here: callers decide what
// a failed handshake means.
func leafNotAfter(ctx context.Context, rawURL string, config *tls.Config) (time.Time, bool) {
	target, err := url.Parse(rawURL)
	if err != nil || target.Scheme != "https" || target.Hostname() == "" {
		return time.Time{}, false
	}
	port := target.Port()
	if port == "" {
		port = "443"
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	dialer := tls.Dialer{Config: config}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(target.Hostname(), port))
	if err != nil {
		return time.Time{}, false
	}
	defer conn.Close()
	chain := conn.(*tls.Conn).ConnectionState().PeerCertificates
	if len(chain) == 0 {
		return time.Time{}, false
	}
	return chain[0].NotAfter, true
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

func safeTenantName(name string) string {
	name = strings.Map(func(r rune) rune {
		// Keep JSON quoting and Discord layout safe without exporting customer payloads.
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || strings.ContainsRune("`*_<>[]\\", r) {
			return ' '
		}
		return r
	}, name)
	name = strings.Join(strings.Fields(name), " ")
	runes := []rune(name)
	if len(runes) > 80 {
		name = string(runes[:80]) + "…"
	}
	if name == "" {
		return "Unnamed Tenant"
	}
	return name
}

func collect(ctx context.Context, databaseURL string) ([]snapshot, error) {
	if databaseURL == "" {
		return nil, errors.New("CHALK_DATABASE_URL is required")
	}
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return nil, errors.New("invalid database configuration")
	}
	config.RuntimeParams["default_transaction_read_only"] = "on"
	config.RuntimeParams["statement_timeout"] = "5000"
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return nil, errors.New("alert state database connection failed")
	}
	defer conn.Close(ctx)
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, errors.New("alert state read-only transaction failed")
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, stateSQL)
	if err != nil {
		return nil, errors.New("alert state query failed")
	}
	defer rows.Close()
	var snapshots []snapshot
	seenRules := make(map[string]bool)
	for rows.Next() {
		var item snapshot
		if err := rows.Scan(&item.Rule, &item.Tenant, &item.TenantName, &item.Value, &item.ExpiresAt, &item.UnknownExpiry); err != nil {
			return nil, errors.New("alert state result decoding failed")
		}
		seenRules[item.Rule] = true
		snapshots = append(snapshots, item)
	}
	rows.Close()
	if rows.Err() != nil || len(seenRules) != 5 {
		return nil, errors.New("alert state snapshot incomplete")
	}
	// A failed debt read keeps the job and webhook rows, but still fails the service.
	var oldestDebtSeconds int64
	if err := tx.QueryRow(ctx, sfuRetirementDebtSQL).Scan(&oldestDebtSeconds); err != nil {
		return snapshots, errors.New("sfu retirement debt query failed")
	}
	return append(snapshots, snapshot{Rule: "sfu-retirement-debt", Value: oldestDebtSeconds}), nil
}

func ingestConfig(headers string) (token, dataset string) {
	for _, header := range strings.Split(headers, ",") {
		key, value, ok := strings.Cut(header, "=")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		decoded, err := url.QueryUnescape(value)
		if err != nil {
			continue
		}
		value = decoded
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "authorization":
			token = strings.TrimPrefix(value, "Bearer ")
		case "x-axiom-dataset":
			dataset = value
		}
	}
	return token, dataset
}

func ingest(ctx context.Context, client *http.Client, endpoint, token string, snapshots []snapshot) error {
	body, err := json.Marshal(snapshots)
	if err != nil {
		return errors.New("alert snapshot encoding failed")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return errors.New("alert ingest request failed")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return errors.New("alert snapshot delivery failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("alert snapshot ingest rejected")
	}
	var result struct {
		Ingested int `json:"ingested"`
		Failed   int `json:"failed"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil || result.Failed != 0 || result.Ingested != len(snapshots) {
		return errors.New("alert snapshot ingest incomplete")
	}
	fmt.Println("alert snapshot delivered")
	return nil
}
