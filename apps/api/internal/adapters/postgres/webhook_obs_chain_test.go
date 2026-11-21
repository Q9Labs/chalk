package postgres

// The fault scenarios behind the webhook.* fixtures: each test drives the real producer, repository and dispatcher
// against real Postgres, captures the kernel and log lines they emit as the API log, and hands the live reader's rows to
// observability/fixtures/<code>/chain/stack-rows.<run>.json. Run with CHALK_CHAIN_WRITE=1 to rewrite the hand-off files.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/q9labs/chalk/apps/api/internal/obs"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

// chainCapture is the one JSON log the API writes for a chain run: kernel records and the plain lines around them.
type chainCapture struct{ bytes.Buffer }

func (c *chainCapture) logger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(c, &slog.HandlerOptions{ReplaceAttr: func(groups []string, attr slog.Attr) slog.Attr {
		if attr.Key == slog.TimeKey && attr.Value.Kind() == slog.KindTime {
			return slog.Float64("est_server_ms", float64(attr.Value.Time().UnixMilli()))
		}
		return attr
	}}))
}

// TestMain configures the obs kernel for the whole package: the fanout, capacity and dispatch emits slice 12
// added would otherwise violate on an empty module/env when an unrelated test's path reaches them.
func TestMain(m *testing.M) {
	obs.Configure(chainObsBaseline())
	os.Exit(m.Run())
}

func chainObsBaseline() obs.Config {
	return obs.Config{Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Mode: obs.ModeClosed, Module: "api", Env: "test", SourceID: "00000000-0000-4000-8000-00000000000a"}
}

// configureChain obs onto the capture logger, the way cmd/main.go wires the diagnostics logger: kernel records and the
// process's plain lines land in the same stream, which is what the live reader's api.log parse expects.
func configureChain(t *testing.T, capture *chainCapture) {
	t.Helper()
	logger := capture.logger()
	obs.Configure(obs.Config{Logger: logger, Mode: obs.ModeClosed, Module: "api", Env: "test", SourceID: "00000000-0000-4000-8000-00000000000a"})
	t.Cleanup(func() { obs.Configure(chainObsBaseline()) })
	// The boot marker main.go writes: api.starting carries request_logs, the mode the checks judge recovery reads against.
	logger.Info("api starting", "event", "api.starting", "request_logs", "all", "host_boot_id", "chain", "previous_boot_end", time.Now().Add(-time.Hour).Format(time.RFC3339Nano))
	slog.SetDefault(logger)
}

// stampChainTimes rewinds every database clock the live reader reports into the pinned window, so a replayed run reads
// the same times back. Logical times land at fixed offsets from the run's base.
func stampChainTimes(t *testing.T, pool *pgxpool.Pool, tenantID utilities.ID) {
	t.Helper()
	ctx := context.Background()
	at := func(minutes int) string {
		return chainWindow.From.Add(time.Duration(minutes) * time.Minute).Format(time.RFC3339Nano)
	}
	for _, statement := range []string{
		`update tenants set created_at = '` + at(1) + `'::timestamptz where id = $1`,
		`update spaces set created_at = '` + at(1) + `'::timestamptz, updated_at = '` + at(1) + `'::timestamptz where tenant_id = $1`,
		`update episodes set created_at = '` + at(1) + `'::timestamptz, updated_at = '` + at(5) + `'::timestamptz where tenant_id = $1`,
		`update participants set created_at = '` + at(1) + `'::timestamptz, joined_at = case when joined_at is null then null else '` + at(2) + `'::timestamptz end, left_at = case when left_at is null then null else '` + at(3) + `'::timestamptz end where tenant_id = $1`,
		`update webhook_endpoints set created_at = '` + at(1) + `'::timestamptz, updated_at = '` + at(1) + `'::timestamptz where tenant_id = $1`,
		`update webhook_endpoint_revisions set created_at = '` + at(1) + `'::timestamptz where tenant_id = $1`,
		`update webhook_deliveries set created_at = '` + at(1) + `'::timestamptz, next_attempt_at = case when state in ('pending','retry_wait') then '` + at(4) + `'::timestamptz else null end, terminal_at = case when terminal_at is null then null else '` + at(5) + `'::timestamptz end, lease_expires_at = case when lease_expires_at is null then null else '` + at(6) + `'::timestamptz end, updated_at = '` + at(5) + `'::timestamptz where tenant_id = $1`,
		`update webhook_delivery_attempts set started_at = '` + at(5) + `'::timestamptz + (attempt_number || ' seconds')::interval, finished_at = case when finished_at is null then null else '` + at(5) + `'::timestamptz + (attempt_number || ' seconds')::interval + interval '1 second' end where tenant_id = $1`,
		`update api_keys set created_at = '` + at(1) + `'::timestamptz, last_used_at = case when last_used_at is null then null else '` + at(5) + `'::timestamptz end, revoked_at = case when revoked_at is null then null else '` + at(6) + `'::timestamptz end, expires_at = case when expires_at is null then null else '` + at(30) + `'::timestamptz end where tenant_id = $1`,
		`update api_key_mutation_requests set created_at = '` + at(1) + `'::timestamptz where tenant_id = $1`,
		`update webhook_tenant_state set updated_at = '` + at(1) + `'::timestamptz where tenant_id = $1`,
		`with ordered as (select event_id, row_number() over (order by occurred_at, event_id) as rn from observability_journey_events where name = 'webhook.delivery.retry_scheduled' and attributes->>'delivery_id' in (select id::text from webhook_deliveries where tenant_id = $1)) update observability_journey_events j set occurred_at = '` + at(7) + `'::timestamptz + (o.rn || ' seconds')::interval, attributes = jsonb_set(j.attributes, '{next_attempt_at}', to_jsonb(('` + at(7) + `'::timestamptz + ((o.rn + 30) || ' seconds')::interval)::text)) from ordered o where j.event_id = o.event_id`,
	} {
		if _, err := pool.Exec(ctx, statement, uuid(tenantID)); err != nil {
			t.Fatalf("chain clock %q: %v", statement, err)
		}
	}
}

// chainRows hands the run's api.log to the live reader and returns the rows it reads for the tenant's window.
func chainRows(t *testing.T, pool *pgxpool.Pool, tenantID utilities.ID, capture *chainCapture, from, to time.Time) []map[string]any {
	t.Helper()
	stampChainTimes(t, pool, tenantID)
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(dir, "api.log")
	if err := os.WriteFile(logPath, capture.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	root, err := filepath.Abs(filepath.Join("..", "..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", filepath.Join(root, "scripts", "diagnose-call", "live", "webhooks.mjs"), "--tenant", tenantID.String(), "--from", fmt.Sprint(from.UnixMilli()), "--to", fmt.Sprint(to.UnixMilli()), "--api-log", logPath)
	cmd.Env = os.Environ()
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("live reader: %v\n%s", err, out)
	}
	var rows []map[string]any
	if err := json.Unmarshal(out, &rows); err != nil {
		t.Fatalf("live reader rows: %v\n%s", err, out)
	}
	return pinRows(t, tenantID, rows)
}

// writeChain hands rows to the symptom's chain directory; CHALK_CHAIN_WRITE=1 rewrites, otherwise it compares.
func writeChain(t *testing.T, code, run string, rows []map[string]any) {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "..", "observability", "fixtures", code, "chain", "stack-rows."+run+".json")
	text, _ := json.MarshalIndent(rows, "", "  ")
	text = append(text, '\n')
	if os.Getenv("CHALK_CHAIN_WRITE") == "1" {
		if err := os.WriteFile(path, text, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	existing, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v (run with CHALK_CHAIN_WRITE=1)", path, err)
	}
	var a, b []map[string]any
	if err := json.Unmarshal(existing, &a); err != nil || json.Unmarshal(text, &b) != nil {
		t.Fatal("unparseable chain rows")
	}
	if fmt.Sprint(a) != fmt.Sprint(b) {
		dumpPath := filepath.Join(os.TempDir(), "chalk-chain-"+code+"-"+run+".json")
		if err := os.WriteFile(dumpPath, text, 0o644); err == nil {
			t.Logf("actual rows written to %s", dumpPath)
		}
		t.Fatalf("%s is not the chain's rows: run with CHALK_CHAIN_WRITE=1", path)
	}
}

// chainTenantID is the one tenant every chain run proves on; it is also the fixture declaration's tenant.
var chainTenantID = func() utilities.ID {
	id, err := utilities.ParseID("c1000000-0000-4000-8000-00000000000c")
	if err != nil {
		panic(err)
	}
	return id
}()

// seedChainTenant makes the tenant, space, endpoint (subscribed to the given event names) and returns the pieces.
func seedChainTenant(t *testing.T, pool *pgxpool.Pool, eventTypes []string) (tenantID, spaceID, endpointID utilities.ID, repository WebhookRepository) {
	t.Helper()
	tenantID, spaceID, endpointID = chainTenantID, webhookIntegrationID(t), webhookIntegrationID(t)
	ctx := context.Background()
	deleteChainTenant(t, pool, tenantID)
	if _, err := pool.Exec(ctx, `insert into tenants(id,name) values($1,'Slice 12 chain')`, uuid(tenantID)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { deleteChainTenant(t, pool, tenantID) })
	if _, err := pool.Exec(ctx, `insert into spaces(id,tenant_id,slug,name,media_plane) values($1,$2,$3,'chain','cf_sfu')`, uuid(spaceID), uuid(tenantID), spaceID.String()[:8]); err != nil {
		t.Fatal(err)
	}
	protector, err := webhooks.NewAESGCMProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	repository = NewWebhookRepository(pool, protector)
	return tenantID, spaceID, endpointID, repository
}

// deleteChainTenant removes every row the chain made for the tenant, in dependency order: the webhook tables only
// cascade to their own children, and spaces block tenant deletion. The gate database persists across package runs,
// so the list also clears what the httpapi chain leaves for the shared tenant id.
func deleteChainTenant(t *testing.T, pool *pgxpool.Pool, tenantID utilities.ID) {
	t.Helper()
	for _, statement := range []string{
		`delete from webhook_delivery_attempts where tenant_id = $1`,
		`delete from webhook_deliveries where tenant_id = $1`,
		`delete from webhook_events where tenant_id = $1`,
		`delete from webhook_idempotency_records where tenant_id = $1`,
		`delete from webhook_endpoints where tenant_id = $1`,
		`delete from webhook_endpoint_revisions where tenant_id = $1`,
		`delete from webhook_tenant_state where tenant_id = $1`,
		`delete from episode_presence_leases where tenant_id = $1`,
		`delete from sync_lifecycle_intents where tenant_id = $1`,
		`delete from sync_publication_fences where tenant_id = $1`,
		`delete from sync_external_operations where tenant_id = $1`,
		`delete from sync_episode_control where tenant_id = $1`,
		`delete from episode_create_requests where tenant_id = $1`,
		`delete from participant_join_seats where tenant_id = $1`,
		`delete from participants where tenant_id = $1`,
		`delete from episodes where tenant_id = $1`,
		`delete from space_roles where tenant_id = $1`,
		`delete from spaces where tenant_id = $1`,
		`delete from api_key_mutation_requests where tenant_id = $1`,
		`delete from api_keys where tenant_id = $1`,
		`delete from tenant_artifact_policies where tenant_id = $1`,
	} {
		if _, err := pool.Exec(context.Background(), statement, uuid(tenantID)); err != nil {
			t.Fatalf("chain cleanup %q: %v", statement, err)
		}
	}
	if _, err := pool.Exec(context.Background(), `delete from observability_journey_events where attributes->>'tenant_id' = $1`, tenantID.String()); err != nil {
		t.Fatalf("chain cleanup observability_journey_events: %v", err)
	}
	if _, err := pool.Exec(context.Background(), `delete from tenants where id = $1`, uuid(tenantID)); err != nil {
		t.Fatalf("chain cleanup tenants: %v", err)
	}
}

// chainEndpoint creates the subscribed endpoint; url is the test receiver's.
var chainEndpointSeq int

func chainEndpoint(t *testing.T, repository WebhookRepository, tenantID utilities.ID, url string, eventTypes []string) webhooks.CreateResult {
	t.Helper()
	chainEndpointSeq++
	created, err := repository.Create(context.Background(), webhooks.CreateInput{TenantID: tenantID, Name: "chain", URL: url, Enabled: true, APIVersion: 1, EventTypes: eventTypes, IdempotencyKey: fmt.Sprintf("chain-endpoint-%d", chainEndpointSeq)})
	if err != nil {
		t.Fatal(err)
	}
	return created
}

// chainEpisode inserts a started Episode row (the transition population the db reader derives).
func chainEpisode(t *testing.T, pool *pgxpool.Pool, tenantID, spaceID utilities.ID, started, ended time.Time) utilities.ID {
	t.Helper()
	episodeID := webhookIntegrationID(t)
	if _, err := pool.Exec(context.Background(), `insert into episodes(id,tenant_id,space_id,status,config_snapshot,started_at,ended_at) values($1,$2,$3,$4,'{"roles":{"host":["startEpisode","subscribe","publishAudio","publishVideo"]},"admission_policy":{"mode":"open"},"default_episode_duration_seconds":86400,"maximum_episode_duration_seconds":86400,"linger_window_seconds":0}'::jsonb,$5,$6)`, uuid(episodeID), uuid(tenantID), uuid(spaceID), episodeStatus(ended), started, nilZero(ended)); err != nil {
		t.Fatal(err)
	}
	return episodeID
}

func episodeStatus(ended time.Time) string {
	if ended.IsZero() {
		return "active"
	}
	return "ended"
}

func nilZero(at time.Time) any {
	if at.IsZero() {
		return nil
	}
	return at
}

// chainFanout runs the real in-transaction producer for a lifecycle event.
func chainFanout(t *testing.T, pool *pgxpool.Pool, tenantID, resourceID utilities.ID, eventName, semanticKey string, occurredAt time.Time) {
	t.Helper()
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	metric, err := fanoutWebhookEvent(context.Background(), tx, webhookProduction{TenantID: tenantID, EventName: webhooks.EventName(eventName), SemanticKey: semanticKey, ResourceType: "episode", ResourceID: resourceID, OccurredAt: occurredAt, Body: func(webhooks.EventMetadata) ([]byte, [32]byte, error) {
		return []byte(`{"chain":true}`), [32]byte{}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	metric.Record(context.Background())
}

// chainWindow is the fixed observation window the fixtures declare; every chain timestamp lands inside it.
var chainWindow = struct{ From, To time.Time }{From: time.UnixMilli(1_795_600_000_000).UTC(), To: time.UnixMilli(1_795_604_000_000).UTC()}

// TestObsChainWebhookEventMissing drives the event_missing fault: a BEFORE INSERT trigger on webhook_events silently
// drops the episode.started row, so the committed transition never became an event. Healthy: the same fanout commits.
func TestObsChainWebhookEventMissing(t *testing.T) {
	pool := webhookIntegrationPool(t)
	for _, run := range []string{"positive", "healthy"} {
		t.Run(run, func(t *testing.T) {
			var capture chainCapture
			configureChain(t, &capture)
			tenantID, spaceID, _, repository := seedChainTenant(t, pool, nil)
			chainEndpoint(t, repository, tenantID, chainReceiverURL, []string{"episode.started", "episode.ended"})
			episodeID := chainEpisode(t, pool, tenantID, spaceID, chainWindow.From.Add(time.Minute), chainWindow.From.Add(2*time.Minute))
			if run == "positive" {
				if _, err := pool.Exec(context.Background(), `create or replace function chain_drop_started() returns trigger language plpgsql as $$ begin if NEW.event_name = 'episode.started' then return null; end if; return NEW; end $$; create trigger chain_drop_started before insert on webhook_events for each row execute function chain_drop_started()`); err != nil {
					t.Fatal(err)
				}
				defer pool.Exec(context.Background(), `drop trigger if exists chain_drop_started on webhook_events; drop function if exists chain_drop_started()`)
			}
			chainFanout(t, pool, tenantID, episodeID, "episode.started", "episode:"+episodeID.String()+":started", chainWindow.From.Add(time.Minute))
			chainFanout(t, pool, tenantID, episodeID, "episode.ended", "episode:"+episodeID.String()+":ended", chainWindow.From.Add(2*time.Minute))
			// A joined-then-left Participant gives the participant lifecycle transitions, and a second endpoint the
			// Tenant rotated out gives the deleted witness — both inside the window.
			if _, err := pool.Exec(context.Background(), `insert into participants(id,name,metadata,capabilities,role,tenant_id,space_id,episode_id,generation,status,joined_at,left_at) values($1,'chain','{}'::jsonb,'{subscribe}'::text[],'host',$2,$3,$4,1,'left',now(),now())`, uuid(mustIDFromString(t, "30000000-0000-4000-8000-000000000010")), uuid(tenantID), uuid(spaceID), uuid(episodeID)); err != nil {
				t.Fatal(err)
			}
			second := chainEndpoint(t, repository, tenantID, chainReceiverURL, []string{"episode.ended"})
			if err := repository.Delete(context.Background(), tenantID, second.Endpoint.ID, second.Endpoint.Revision, "chain-delete-"+run); err != nil {
				t.Fatal(err)
			}
			writeChain(t, "webhook.event_missing", run, chainRows(t, pool, tenantID, &capture, chainWindow.From, chainWindow.To))
		})
	}
}

// TestObsChainWebhookDeliveryStalled drives the stalled fault: the tenant's advisory claim lock is held, so the real
// Claim returns nothing and the delivery sits retry_wait past its schedule. Healthy: the dispatcher delivers on attempt 1.
func TestObsChainWebhookDeliveryStalled(t *testing.T) {
	pool := webhookIntegrationPool(t)
	for _, run := range []string{"positive", "healthy"} {
		t.Run(run, func(t *testing.T) {
			var capture chainCapture
			configureChain(t, &capture)
			tenantID, spaceID, _, repository := seedChainTenant(t, pool, nil)
			chainEndpoint(t, repository, tenantID, chainReceiverURL, []string{"episode.ended"})
			episodeID := chainEpisode(t, pool, tenantID, spaceID, chainWindow.From.Add(time.Minute), chainWindow.From.Add(2*time.Minute))
			chainFanout(t, pool, tenantID, episodeID, "episode.ended", "episode:"+episodeID.String()+":ended:"+run, chainWindow.From.Add(2*time.Minute))
			if _, err := pool.Exec(context.Background(), `update webhook_deliveries set next_attempt_at = now() where tenant_id = $1`, uuid(tenantID)); err != nil {
				t.Fatal(err)
			}
			dispatch := NewWebhookDispatchRepository(pool)
			sender := chainSender{status: http.StatusNoContent}
			if run == "positive" {
				conn, err := pool.Acquire(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				if _, err := conn.Exec(context.Background(), `select pg_advisory_lock(hashtextextended($1::text, 0))`, tenantID.String()); err != nil {
					t.Fatal(err)
				}
				claims, err := dispatch.Claim(context.Background(), "chain", 10, time.Minute)
				if err != nil {
					t.Fatal(err)
				}
				for _, claim := range claims {
					if claim.TenantID == tenantID {
						t.Fatal("claimed a delivery while the tenant claim lock was held")
					}
				}
				// The stalled delivery stays pending for the capture; the chain clock puts its due time inside the
				// window. The real clock keeps it out of every later cycle's reach.
				if _, err := conn.Exec(context.Background(), `select pg_advisory_unlock(hashtextextended($1::text, 0))`, tenantID.String()); err != nil {
					t.Fatal(err)
				}
				conn.Release()
				if _, err := pool.Exec(context.Background(), `update webhook_deliveries set next_attempt_at = now() + interval '1 hour' where tenant_id = $1`, uuid(tenantID)); err != nil {
					t.Fatal(err)
				}
				// The Tenant's second event rides the recovery path the capture shows: a cycle fails outright, the
				// first attempt fails retryably, and the retry lands — a wait, not a loss. The event carries the
				// window's clock, so its delivery is forced due the way the first one's was.
				chainFanout(t, pool, tenantID, episodeID, "episode.ended", "episode:"+episodeID.String()+":ended:recovered:"+run, chainWindow.From.Add(3*time.Minute))
				if _, err := pool.Exec(context.Background(), `update webhook_deliveries set next_attempt_at = now() where tenant_id = $1 and next_attempt_at > now() + interval '2 hours'`, uuid(tenantID)); err != nil {
					t.Fatal(err)
				}
				flaky := &claimOnceFailRepository{WebhookDispatchRepository: dispatch}
				runDispatchWith(t, pool, flaky, &flipSender{first: http.StatusServiceUnavailable, then: http.StatusNoContent}, 2)
				// The first run can end before a cycle claims the recovery delivery, leaving it pending on
				// the fixture's future next_attempt_at; force the newest undelivered row due either way. The
				// stalled delivery keeps its +1h due time so it stays pending — the stall the world shows.
				if _, err := pool.Exec(context.Background(), `update webhook_deliveries set next_attempt_at = now() where tenant_id = $1 and id = (select id from webhook_deliveries where tenant_id = $1 and state in ('pending','retry_wait') order by created_at desc, id desc limit 1)`, uuid(tenantID)); err != nil {
					t.Fatal(err)
				}
				runDispatchWith(t, pool, flaky, chainSender{status: http.StatusNoContent}, 2)
				var deliveryID, endpointID string
				var attemptCount int
				if err := pool.QueryRow(context.Background(), `select d.id::text, d.endpoint_id::text, d.attempt_count from webhook_deliveries d where d.tenant_id = $1 and d.state = 'succeeded'`, uuid(tenantID)).Scan(&deliveryID, &endpointID, &attemptCount); err != nil {
					rows, _ := pool.Query(context.Background(), `select id::text, state, attempt_count, next_attempt_at::text from webhook_deliveries where tenant_id = $1 order by created_at`, uuid(tenantID))
					defer rows.Close()
					for rows.Next() {
						var id, state, due string
						var ac int
						_ = rows.Scan(&id, &state, &ac, &due)
						t.Logf("delivery %s state=%s attempts=%d due=%s", id, state, ac, due)
					}
					t.Fatal(err)
				}
				if attemptCount < 2 {
					t.Fatalf("the retried delivery succeeded on attempt %d, want the retry journey", attemptCount)
				}
				// The Tenant redelivers it: the child carries its parent, and claiming it leaves the live lease.
				redelivered, err := repository.Redeliver(context.Background(), tenantID, mustIDFromString(t, endpointID), mustIDFromString(t, deliveryID), "chain-redeliver-"+run)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Exec(context.Background(), `update webhook_deliveries set next_attempt_at = now() where tenant_id = $1 and id = $2`, uuid(tenantID), uuid(redelivered.DeliveryID)); err != nil {
					t.Fatal(err)
				}
				if children, err := dispatch.Claim(context.Background(), "chain", 10, time.Minute); err != nil || len(children) == 0 {
					t.Fatalf("no claim for the redelivered child: %v", err)
				}
				// A claim whose trace write fails makes the cycle fail on that delivery — the cycle_failed
				// witness that carries the delivery's id.
				chainFanout(t, pool, tenantID, episodeID, "episode.ended", "episode:"+episodeID.String()+":ended:cycfail:"+run, chainWindow.From.Add(4*time.Minute))
				if _, err := pool.Exec(context.Background(), `update webhook_deliveries set next_attempt_at = now() where tenant_id = $1 and id = (select id from webhook_deliveries where tenant_id = $1 and state = 'pending' order by created_at desc limit 1)`, uuid(tenantID)); err != nil {
					t.Fatal(err)
				}
				runDispatchWith(t, pool, &traceOnceFailRepository{WebhookDispatchRepository: dispatch}, chainSender{status: http.StatusNoContent}, 2)
				writeChain(t, "webhook.delivery_stalled", run, chainRows(t, pool, tenantID, &capture, chainWindow.From, chainWindow.To))
				return
			}
			runDispatcher(t, pool, dispatch, sender, 3)
			writeChain(t, "webhook.delivery_stalled", run, chainRows(t, pool, tenantID, &capture, chainWindow.From, chainWindow.To))
		})
	}
}

// chainReceiverURL is the endpoint's stored target: endpoint URLs must be https hosts, and the chain's sender never dials.
const chainReceiverURL = "https://receiver.invalid/chain"

// chainSender answers the dispatcher's receiver hop without the network: it returns the status the scenario wants with the
// same error classification the real delivery client derives.
type chainSender struct {
	status int
	// hook runs inside Deliver, between the claim and the completion write — where a
	// real receiver's failure lands.
	hook func()
}

func (s chainSender) Deliver(_ context.Context, _ webhooks.DeliveryRequest) (webhooks.DeliveryResponse, error) {
	if s.hook != nil {
		s.hook()
	}
	response := webhooks.DeliveryResponse{Status: s.status, Latency: time.Millisecond}
	if s.status >= 200 && s.status < 300 {
		return response, nil
	}
	return response, webhooks.DeliveryError{Code: fmt.Sprintf("http_%d", s.status/100) + "xx", Retryable: s.status == 408 || s.status == 425 || s.status == 429 || s.status >= 500}
}

// runDispatcher runs the real dispatcher against the pool until the context cancels; cycles is how many poll ticks to
// let through (each is a second).
func runDispatcher(t *testing.T, pool *pgxpool.Pool, dispatch WebhookDispatchRepository, sender webhooks.DeliverySender, cycles int) {
	t.Helper()
	runDispatchWith(t, pool, dispatch, sender, cycles)
}

// runDispatchWith runs the real dispatcher against any DispatchRepository so a scenario can wrap the repository.
func runDispatchWith(t *testing.T, _ *pgxpool.Pool, dispatch webhooks.DispatchRepository, sender webhooks.DeliverySender, cycles int) {
	t.Helper()
	protector, err := webhooks.NewAESGCMProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cycles)*time.Second+1500*time.Millisecond)
	defer cancel()
	dispatcher := webhooks.NewDispatcher(dispatch, protector, sender, "chain", slog.Default())
	if err := dispatcher.Run(ctx); err != nil {
		t.Fatal(err)
	}
}

// TestObsChainWebhookNotDelivered drives the exhausted fault: the receiver answers 401 to every attempt, so the delivery
// burns its retry budget and goes exhausted. Healthy: a 204 receiver and attempt-1 success.
func TestObsChainWebhookNotDelivered(t *testing.T) {
	pool := webhookIntegrationPool(t)
	for _, run := range []string{"positive", "healthy"} {
		t.Run(run, func(t *testing.T) {
			var capture chainCapture
			configureChain(t, &capture)
			tenantID, spaceID, _, repository := seedChainTenant(t, pool, nil)
			status := http.StatusNoContent
			if run == "positive" {
				status = http.StatusUnauthorized
			}
			sender := chainSender{status: status}
			chainEndpoint(t, repository, tenantID, chainReceiverURL, []string{"episode.ended"})
			episodeID := chainEpisode(t, pool, tenantID, spaceID, chainWindow.From.Add(time.Minute), chainWindow.From.Add(2*time.Minute))
			chainFanout(t, pool, tenantID, episodeID, "episode.ended", "episode:"+episodeID.String()+":ended:"+run, chainWindow.From.Add(2*time.Minute))
			if _, err := pool.Exec(context.Background(), `update webhook_deliveries set next_attempt_at = now() where tenant_id = $1`, uuid(tenantID)); err != nil {
				t.Fatal(err)
			}
			dispatch := NewWebhookDispatchRepository(pool)
			runDispatcher(t, pool, dispatch, sender, 3)
			if run == "positive" {
				// Burn the remaining budget fast: force every retry due and let the dispatcher exhaust the delivery.
				for i := 0; i < 10; i++ {
					if _, err := pool.Exec(context.Background(), `update webhook_deliveries set next_attempt_at = now() where tenant_id = $1 and state = 'retry_wait'`, uuid(tenantID)); err != nil {
						t.Fatal(err)
					}
					var state string
					if err := pool.QueryRow(context.Background(), `select state from webhook_deliveries where tenant_id = $1 limit 1`, uuid(tenantID)).Scan(&state); err != nil {
						t.Fatal(err)
					}
					if state == "exhausted" {
						break
					}
					runDispatcher(t, pool, dispatch, sender, 2)
				}
				// The Tenant's follow-up operations: rotate the endpoint secret, then re-deliver the exhausted
				// delivery — the child carries its parent, and claiming it leaves live lease evidence.
				var deliveryID, endpointID string
				if err := pool.QueryRow(context.Background(), `select d.id, d.endpoint_id from webhook_deliveries d where d.tenant_id = $1 and d.state = 'exhausted' limit 1`, uuid(tenantID)).Scan(&deliveryID, &endpointID); err != nil {
					t.Fatal(err)
				}
				if _, err := repository.RotateSecret(context.Background(), tenantID, mustIDFromString(t, endpointID), false, "chain-rotate-"+run); err != nil {
					t.Fatal(err)
				}
				redelivered, err := repository.Redeliver(context.Background(), tenantID, mustIDFromString(t, endpointID), mustIDFromString(t, deliveryID), "chain-redeliver-"+run)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Exec(context.Background(), `update webhook_deliveries set next_attempt_at = now() where tenant_id = $1 and id = $2`, uuid(tenantID), uuid(redelivered.DeliveryID)); err != nil {
					t.Fatal(err)
				}
				if claims, err := dispatch.Claim(context.Background(), "chain", 10, time.Minute); err != nil || len(claims) == 0 {
					t.Fatalf("no claim for the redelivered child: %v", err)
				}
				// A third event leaves a queued delivery: the schedule the capture shows for the undelivered work.
				chainFanout(t, pool, tenantID, episodeID, "episode.ended", "episode:"+episodeID.String()+":ended:queued:"+run, chainWindow.From.Add(4*time.Minute))
			}
			writeChain(t, "webhook.not_delivered", run, chainRows(t, pool, tenantID, &capture, chainWindow.From, chainWindow.To))
		})
	}
}

// TestObsChainWebhookOutcomeUnrecorded drives the unrecorded fault: a delivery is claimed, then the delivery row is
// deleted under the held lease, so the attempt op finishes with no row to complete into. Healthy: the row lands.
func TestObsChainWebhookOutcomeUnrecorded(t *testing.T) {
	pool := webhookIntegrationPool(t)
	for _, run := range []string{"positive", "healthy"} {
		t.Run(run, func(t *testing.T) {
			var capture chainCapture
			configureChain(t, &capture)
			tenantID, spaceID, _, repository := seedChainTenant(t, pool, nil)
			chainEndpoint(t, repository, tenantID, chainReceiverURL, []string{"episode.ended"})
			episodeID := chainEpisode(t, pool, tenantID, spaceID, chainWindow.From.Add(time.Minute), chainWindow.From.Add(2*time.Minute))
			chainFanout(t, pool, tenantID, episodeID, "episode.ended", "episode:"+episodeID.String()+":ended:"+run, chainWindow.From.Add(2*time.Minute))
			if _, err := pool.Exec(context.Background(), `update webhook_deliveries set next_attempt_at = now() where tenant_id = $1`, uuid(tenantID)); err != nil {
				t.Fatal(err)
			}
			dispatch := NewWebhookDispatchRepository(pool)
			sender := chainSender{status: http.StatusNoContent}
			if run == "positive" {
				// The lease-holder's row disappears at the receiver hop: the dispatcher claims the delivery, the
				// receiver hop deletes the row, and the completion write has nothing to land in.
				sender.hook = func() {
					if _, err := pool.Exec(context.Background(), `delete from webhook_deliveries where tenant_id = $1`, uuid(tenantID)); err != nil {
						t.Errorf("delete under lease: %v", err)
					}
				}
				runDispatcher(t, pool, dispatch, sender, 2)
				var count int
				if err := pool.QueryRow(context.Background(), `select count(*) from webhook_deliveries where tenant_id = $1`, uuid(tenantID)).Scan(&count); err != nil {
					t.Fatal(err)
				}
				if count != 0 {
					t.Fatalf("%d deliveries survived the receiver-hop delete", count)
				}
				// A second event's delivery completes cleanly, so the run still shows what a recorded attempt looks like.
				chainFanout(t, pool, tenantID, episodeID, "episode.ended", "episode:"+episodeID.String()+":ended:second:"+run, chainWindow.From.Add(3*time.Minute))
				if _, err := pool.Exec(context.Background(), `update webhook_deliveries set next_attempt_at = now() where tenant_id = $1`, uuid(tenantID)); err != nil {
					t.Fatal(err)
				}
				runDispatcher(t, pool, dispatch, chainSender{status: http.StatusNoContent}, 3)
				// A third receiver fails: the run keeps its failed attempt, error code and all.
				chainFanout(t, pool, tenantID, episodeID, "episode.ended", "episode:"+episodeID.String()+":ended:failing:"+run, chainWindow.From.Add(4*time.Minute))
				if _, err := pool.Exec(context.Background(), `update webhook_deliveries set next_attempt_at = now() where tenant_id = $1 and next_attempt_at > now() + interval '2 hours'`, uuid(tenantID)); err != nil {
					t.Fatal(err)
				}
				runDispatcher(t, pool, dispatch, chainSender{status: http.StatusServiceUnavailable}, 2)
				writeChain(t, "webhook.outcome_unrecorded", run, chainRows(t, pool, tenantID, &capture, chainWindow.From, chainWindow.To))
				return
			}
			runDispatcher(t, pool, dispatch, sender, 3)
			writeChain(t, "webhook.outcome_unrecorded", run, chainRows(t, pool, tenantID, &capture, chainWindow.From, chainWindow.To))
		})
	}
}

// pinRows makes the run's rows replayable. Rows sort by their non-volatile content — kernel seq stays in that
// content, so log rows keep their file order — which is stable no matter where the reader's est sort interleaves
// db rows against wall-clock log times. Ids pin in that first-seen order, millisecond fields keep their stamped
// value inside the window and land at its end outside it, latency fields pin to fixed steps, and envelope keys a
// registry row can't carry drop.
func pinRows(t *testing.T, tenantID utilities.ID, rows []map[string]any) []map[string]any {
	t.Helper()
	volatile := func(key string) bool {
		return key == "est_server_ms" || key == "latency_milliseconds" || key == "duration_ms" || key == "retry_after_ms"
	}
	strippedOf := func(row map[string]any) string {
		stripped := map[string]any{}
		for k, v := range row {
			if volatile(k) {
				continue
			}
			if k == "key_prefix" {
				stripped[k] = "prefix"
				continue
			}
			if value, ok := v.(string); ok {
				pinned := uuidPattern.ReplaceAllString(value, "id")
				stripped[k] = hexPattern.ReplaceAllString(pinned, "id")
				continue
			}
			stripped[k] = v
		}
		encoded, _ := json.Marshal(stripped)
		return string(encoded)
	}
	sorted := make([]map[string]any, 0, len(rows))
	sorted = append(sorted, rows...)
	sort.SliceStable(sorted, func(i, j int) bool {
		return strippedOf(sorted[i]) < strippedOf(sorted[j])
	})
	identities := map[string]string{tenantID.String(): tenantID.String()}
	var order []string
	claim := func(id, kind string) {
		if id == "" || identities[id] != "" {
			return
		}
		n := len(order) + 1
		order = append(order, id)
		switch kind {
		case "uuid":
			identities[id] = fmt.Sprintf("00000000-0000-4000-8000-%012d", n)
		case "trace":
			identities[id] = fmt.Sprintf("trace%028d", n)
		default:
			identities[id] = fmt.Sprintf("chain-prefix-%03d", n)
		}
	}
	for _, row := range sorted {
		keys := make([]string, 0, len(row))
		for k := range row {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			v := row[k]
			switch value := v.(type) {
			case string:
				for _, id := range uuidPattern.FindAllString(value, -1) {
					claim(id, "uuid")
				}
				for _, id := range hexPattern.FindAllString(value, -1) {
					claim(id, "trace")
				}
				if k == "key_prefix" {
					claim("prefix:"+value, "prefix")
				}
			}
		}
	}
	lookup := func(id string) string { return identities[id] }
	logicalAt := make([]int64, 0, len(sorted))
	for _, row := range sorted {
		// The observation window a row makes derives from est_server_ms; anchor it to the row's own logical time
		// (stamped in-window) so absence proofs see the same placement the check sees, not the window's end.
		at := int64(0)
		for k, v := range row {
			if isTimeField(k) && k != "est_server_ms" {
				if value, ok := v.(float64); ok && int64(value) >= chainWindow.From.UnixMilli() && int64(value) <= chainWindow.To.UnixMilli() {
					if at == 0 || int64(value) < at {
						at = int64(value)
					}
				}
			}
		}
		if at == 0 {
			// No logical time of its own (log/request rows): place it by emission order inside the window's
			// back half — the step divides the remaining span so a large run can't push rows past its end.
			at = chainWindow.From.UnixMilli() + 180_000 + int64(len(logicalAt))*(150_000/int64(len(sorted)+1))
		}
		logicalAt = append(logicalAt, at)
	}
	pinned := make([]map[string]any, 0, len(rows))
	for i, row := range sorted {
		out := map[string]any{}
		for k, v := range row {
			if k == "source" || k == "level" || k == "msg" || k == "time" || k == "seq" {
				continue
			}
			switch value := v.(type) {
			case string:
				if k == "key_prefix" {
					out[k] = lookup("prefix:" + value)
					continue
				}
				pinned := uuidPattern.ReplaceAllStringFunc(value, lookup)
				out[k] = hexPattern.ReplaceAllStringFunc(pinned, lookup)
			case float64:
				switch {
				case k == "est_server_ms":
					out[k] = logicalAt[i]
				case isTimeField(k):
					if at := int64(value); at >= chainWindow.From.UnixMilli() && at <= chainWindow.To.UnixMilli() {
						out[k] = at
					} else {
						out[k] = chainWindow.To.UnixMilli()
					}
				case volatile(k):
					out[k] = float64(100)
				default:
					out[k] = value
				}
			default:
				out[k] = v
			}
		}
		pinned = append(pinned, out)
	}
	// The capture merges log and outbox lines at real speeds, so the row order varies run to run; the pinned rows
	// sort by their canonical encoding, and seq renumbers in that order.
	sort.Slice(pinned, func(i, j int) bool {
		a, _ := json.Marshal(pinned[i])
		b, _ := json.Marshal(pinned[j])
		return string(a) < string(b)
	})
	for i, row := range pinned {
		row["seq"] = i + 1
	}
	return pinned
}

var uuidPattern = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)

var hexPattern = regexp.MustCompile(`\b[0-9a-f]{32}\b|\b[0-9a-f]{16}\b`)

func isTimeField(key string) bool {
	return strings.HasSuffix(key, "_at_ms") || key == "est_server_ms" || key == "previous_boot_end_ms" || key == "occurred_at_ms" || strings.HasSuffix(key, "_ms") && !strings.HasSuffix(key, "_milliseconds") && key != "duration_ms" && key != "retry_after_ms"
}

// flipSender answers the first delivery with one status and every later one with another, so a retry journey is
// deterministic without a clock.
type flipSender struct {
	first, then int
	called      bool
}

func (s *flipSender) Deliver(ctx context.Context, request webhooks.DeliveryRequest) (webhooks.DeliveryResponse, error) {
	status := s.then
	if !s.called {
		s.called = true
		status = s.first
	}
	return chainSender{status: status}.Deliver(ctx, request)
}

// traceOnceFailRepository fails the first RecordAttemptTrace pass — a deliver-stage cycle error on that
// delivery — then delegates every call.
type traceOnceFailRepository struct {
	WebhookDispatchRepository
	failed bool
}

func (r *traceOnceFailRepository) RecordAttemptTrace(ctx context.Context, claim webhooks.Claim, traceID, spanID string) error {
	if !r.failed {
		r.failed = true
		return fmt.Errorf("chain trace failure")
	}
	return r.WebhookDispatchRepository.RecordAttemptTrace(ctx, claim, traceID, spanID)
}

// claimOnceFailRepository fails the first Claim pass — a real dispatcher cycle error — then delegates every call.
type claimOnceFailRepository struct {
	WebhookDispatchRepository
	failed bool
}

func (r *claimOnceFailRepository) Claim(ctx context.Context, owner string, limit int, lease time.Duration) ([]webhooks.Claim, error) {
	if !r.failed {
		r.failed = true
		return nil, fmt.Errorf("chain claim failure")
	}
	return r.WebhookDispatchRepository.Claim(ctx, owner, limit, lease)
}

// mustIDFromString parses a stored uuid back to the ID type.
func mustIDFromString(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
