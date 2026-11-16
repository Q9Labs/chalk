// This alert-only executable uses the API module's pinned pgx dependency.
package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
)

//go:embed state.sql
var stateSQL string

// sfuRetirementDebtSQL ages the oldest unpaid retirement debt, as the API's /readyz
// body does, and gives 0 when none is owed. A healthy fleet pays a debt in seconds.
const sfuRetirementDebtSQL = `select coalesce(extract(epoch from now() - min(created_at)), 0)::bigint from sfu_retirement_debts`

// chalk_alert_rule values the collector writes; the .apl files and monitors.json in this folder read the same names.
const (
	ruleDeliveryTest      = "delivery-test"
	ruleRecording         = "recording"
	ruleRecordingStop     = "recording-stop"
	ruleSyncReadiness     = "sync-readiness"
	ruleSFUReadiness      = "sfu-readiness"
	ruleCertificateExpiry = "certificate-expiry"
	ruleSFURetirementDebt = "sfu-retirement-debt"
	ruleExport            = "export"
	ruleTranscript        = "transcript"
	ruleWebhook           = "webhook"
)

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
	// Certificate checks run on their own clock, apart from the database and
	// readiness probes, so a slow node cannot delay or drop any other alert row.
	var certificates chan []snapshot
	if mode == "" || mode == "--check" {
		certificates = make(chan []snapshot, 1)
		go func() {
			certificates <- collectCertificateExpiry(context.Background(), sfuProbesFromEnv(), os.Getenv("CHALK_ALERT_DIRECT_DOOR_URL"), time.Now())
		}()
	}
	switch mode {
	case "--test", "--clear-test":
		value := int64(1)
		if mode == "--clear-test" {
			value = 0
		}
		snapshots = []snapshot{{Rule: ruleDeliveryTest, Value: value, Summary: "TEST: Chalk production alert delivery proof; no user failure was induced."}}
	case "", "--check":
		snapshots, collectionErr = collectState(ctx, http.DefaultClient, os.Getenv("CHALK_DATABASE_URL"), os.Getenv("CHALK_ALERT_SYNC_READY_URL"), sfuProbesFromEnv())
	default:
		return errors.New("unknown collector mode")
	}
	if certificates != nil {
		snapshots = append(snapshots, <-certificates...)
	}
	for i := range snapshots {
		formatMessage(&snapshots[i])
		snapshots[i].Engineers = "For engineers: " + snapshots[i].Rule + "; open the affected Axiom dataset and run | search <episode-id> using the affected Episode ID."
		healthEngineers(&snapshots[i])
		if snapshots[i].Rule == ruleCertificateExpiry {
			snapshots[i].Engineers = "For engineers: certificate-expiry; run `openssl s_client -connect <host>:443 </dev/null | openssl x509 -noout -enddate` for the door, or deploy/certs for the SFU, then the renewal steps in the production-alerts README."
		}
		if snapshots[i].Rule == ruleSFUReadiness {
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

func collectState(ctx context.Context, client *http.Client, databaseURL, readinessURL string, sfu []sfuProbe) ([]snapshot, error) {
	// Preserve the independent readiness observations even if the SQL snapshot fails.
	readiness := []snapshot{collectReadiness(ctx, client, readinessURL)}
	if len(sfu) > 0 {
		readiness = append(readiness, collectSFUFleetReadiness(ctx, sfu))
	}
	databaseCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	snapshots, err := collect(databaseCtx, databaseURL)
	readiness = append(readiness, healthRows(ctx, client, snapshots, err)...)
	return append(snapshots, readiness...), err
}

func collectReadiness(ctx context.Context, client *http.Client, endpoint string) snapshot {
	if endpoint == "" {
		endpoint = "http://127.0.0.1:14100/readyz"
	}
	item := snapshot{Rule: ruleSyncReadiness, Value: 1, Reason: "unreachable", Time: time.Now().UTC().Format(time.RFC3339Nano)}
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
		return nil, unreachableError("alert state database connection failed")
	}
	defer conn.Close(ctx)
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, unreachableError("alert state read-only transaction failed")
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, stateSQL)
	if err != nil {
		return nil, unreachableError("alert state query failed")
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
	if err := snapshotError(rows.Err(), len(seenRules)); err != nil {
		return nil, err
	}
	// A failed debt read keeps the job and webhook rows, but still fails the service.
	var oldestDebtSeconds int64
	if err := tx.QueryRow(ctx, sfuRetirementDebtSQL).Scan(&oldestDebtSeconds); err != nil {
		return snapshots, errors.New("sfu retirement debt query failed")
	}
	return append(snapshots, snapshot{Rule: ruleSFURetirementDebt, Value: oldestDebtSeconds}), nil
}
