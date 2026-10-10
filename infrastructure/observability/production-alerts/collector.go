// This alert-only executable uses the API module's pinned pgx dependency.
package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
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

type snapshot struct {
	Tenant        string     `json:"chalk_alert_tenant"`
	TenantName    string     `json:"-"`
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
	switch mode {
	case "--test", "--clear-test":
		value := int64(1)
		if mode == "--clear-test" {
			value = 0
		}
		snapshots = []snapshot{{Rule: "delivery-test", Value: value, Summary: "TEST: Chalk production alert delivery proof; no user failure was induced."}}
	case "", "--check":
		var err error
		snapshots, err = collect(ctx, os.Getenv("CHALK_DATABASE_URL"))
		if err != nil {
			return err
		}
	default:
		return errors.New("unknown collector mode")
	}
	for i := range snapshots {
		formatMessage(&snapshots[i])
		snapshots[i].Engineers = "For engineers: " + snapshots[i].Rule + "; `pnpm diag trace <32-hex-trace-id>` from the affected journey."
		snapshots[i].Time = time.Now().UTC().Format(time.RFC3339Nano)
		snapshots[i].Stream = "production-state-v2"
	}
	if mode == "--check" {
		return json.NewEncoder(os.Stdout).Encode(snapshots)
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
	return ingest(ctx, http.DefaultClient, "https://api.axiom.co/v1/datasets/"+url.PathEscape(dataset)+"/ingest", token, snapshots)
}

func message(rule string) (headline, impact, next string) {
	switch rule {
	case "recording":
		return "A class was not recorded", "The Recording stopped before it finished, so there is no complete video for this class.", "An engineer must check immediately whether any retained source can be recovered; a complete video cannot be promised."
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
	if item.Tenant != "" {
		item.Summary = "Tenant: " + safeTenantName(item.TenantName) + ". " + item.Summary
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
	if rows.Err() != nil || len(seenRules) != 4 {
		return nil, errors.New("alert state snapshot incomplete")
	}
	return snapshots, nil
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
