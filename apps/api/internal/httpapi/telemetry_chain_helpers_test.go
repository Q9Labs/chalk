package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/q9labs/chalk/apps/api/db/migrations"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func isolatedChainDatabase(t *testing.T, databaseURL string) *pgxpool.Pool {
	t.Helper()
	adminConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := pgxpool.NewWithConfig(t.Context(), adminConfig)
	if err != nil {
		t.Fatal(err)
	}
	id, err := utilities.NewID()
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	name := "chalk_chain_" + strings.ReplaceAll(id.String(), "-", "")
	if _, err := admin.Exec(t.Context(), "create database "+name); err != nil {
		admin.Close()
		t.Fatalf("create isolated chain database: %v", err)
	}

	targetConfig := adminConfig.Copy()
	targetConfig.ConnConfig.Database = name
	database := stdlib.OpenDB(*targetConfig.ConnConfig)
	provider, err := goose.NewProvider(goose.DialectPostgres, database, migrations.Files, goose.WithLogger(goose.NopLogger()))
	if err == nil {
		_, err = provider.Up(t.Context())
	}
	closeErr := database.Close()
	if err != nil {
		admin.Close()
		t.Fatalf("migrate isolated chain database: %v", err)
	}
	if closeErr != nil {
		admin.Close()
		t.Fatal(closeErr)
	}
	pool, err := pgxpool.NewWithConfig(t.Context(), targetConfig)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := admin.Exec(ctx, "drop database if exists "+name+" with (force)"); err != nil {
			t.Errorf("drop isolated chain database: %v", err)
		}
		admin.Close()
	})
	return pool
}

func kernelRecords(frames []map[string]any) []map[string]any {
	var records []map[string]any
	for _, frame := range frames {
		events, _ := frame["events"].([]any)
		for _, event := range events {
			if record, ok := event.(map[string]any); ok && record["kind"] != nil {
				records = append(records, record)
			}
		}
	}
	return records
}

func rowOf(rows []map[string]any, eventID any) map[string]any {
	index := slices.IndexFunc(rows, func(row map[string]any) bool { return row["event_id"] == eventID })
	if index < 0 {
		return nil
	}
	return rows[index]
}

func readChainFile(t *testing.T, name string, into any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(chainDir, name))
	if err != nil {
		t.Fatalf("read %s: %v (run the chain in order, see the README)", name, err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
}

func compareChainFile(t *testing.T, name string, value any) {
	t.Helper()
	text, _ := json.MarshalIndent(value, "", "  ")
	text = append(text, '\n')
	if os.Getenv("CHALK_CHAIN_WRITE") == "1" {
		if err := os.WriteFile(filepath.Join(chainDir, name), text, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var want, got any
	readChainFile(t, name, &want)
	_ = json.Unmarshal(text, &got)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s is stale: the API wrote\n%s", name, text)
	}
}

func seedChainEpisode(t *testing.T, pool *pgxpool.Pool, subject accessgrants.Subject) {
	t.Helper()
	tenant, space, episode, participant := subject.TenantID.String(), subject.SpaceID.String(), subject.EpisodeID.String(), subject.ParticipantID.String()
	write := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(context.Background(), query, args...); err != nil {
			t.Fatal(err)
		}
	}
	write(`insert into tenants(id, name) values ($1::text::uuid, 'Chain')`, tenant)
	t.Cleanup(func() {
		for _, table := range []string{"telemetry_sources", "participants", "episodes", "spaces"} {
			write("delete from "+table+" where tenant_id = $1::text::uuid", tenant)
		}
		write(`delete from tenants where id = $1::text::uuid`, tenant)
	})
	plane := mediaplane.ProviderChalkSFU.SettingName()
	write(`insert into spaces(id, tenant_id, name, slug, media_plane) values ($1::text::uuid, $2::text::uuid, 'Chain', 'chain', $3)`, space, tenant, plane)
	write(`insert into episodes(id, tenant_id, space_id, status, config_snapshot)
	       values ($1::text::uuid, $2::text::uuid, $3::text::uuid, 'active', jsonb_build_object('media_plane_binding', jsonb_build_object('provider', $4::text)))`, episode, tenant, space, plane)
	write(`insert into participants(id, tenant_id, space_id, episode_id, capabilities, generation, status, role)
	       values ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4::text::uuid, '{subscribe}', 1, 'left', 'collaborator')`, participant, tenant, space, episode)
}

type chainRow struct {
	Service struct {
		Name string `json:"name"`
	} `json:"service"`
	Attributes map[string]any `json:"attributes"`
	Body       string         `json:"body"`
}

// chainAxiom only serves rows it received through actual ingest requests.
type chainAxiom struct {
	mu      sync.Mutex
	episode string
	rows    []chainRow
}

func (a *chainAxiom) serve(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	switch r.URL.Path {
	case "/v1/ingest/chain":
		var rows []chainRow
		if err := json.NewDecoder(r.Body).Decode(&rows); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		a.rows = append(a.rows, rows...)
		_ = json.NewEncoder(w).Encode(map[string]int{"ingested": len(rows), "failed": 0})
	case "/v1/datasets/_apl":
		var query struct {
			APL       string
			StartTime time.Time
			EndTime   time.Time
		}
		if err := json.NewDecoder(r.Body).Decode(&query); err != nil || !strings.Contains(query.APL, "['attributes.episode_id'] == '"+a.episode+"'") {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		// These writes reached Axiom after the event-time deadline.
		ingested := chainReceivedAt.Add(180 * time.Second)
		matches := []map[string]any{}
		if !ingested.Before(query.StartTime) && !ingested.After(query.EndTime) {
			for i, row := range a.rows {
				if row.Attributes["episode_id"] == a.episode {
					matches = append(matches, map[string]any{"_time": ingested, "_rowId": strconv.Itoa(i), "data": row})
				}
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"matches": matches})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func verifyChainReadback(t *testing.T, databaseURL, axiomURL, scenario string) {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "scripts", "diagnose-call", "proof", "end-wrong-screen-chain.test.mjs")
	cmd := exec.CommandContext(t.Context(), "node", "--test", "--test-name-pattern=live readback", path)
	cmd.Env = append(os.Environ(), "CHALK_DATABASE_URL="+databaseURL, "CHALK_CHAIN_AXIOM_URL="+axiomURL, "CHALK_CHAIN_SCENARIO="+scenario)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("live reader failed: %v\n%s", err, out)
	}
}
