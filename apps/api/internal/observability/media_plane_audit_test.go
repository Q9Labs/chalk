package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func captureDefaultLogger(t *testing.T) *bytes.Buffer {
	t.Helper()
	var out bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&out, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &out
}

func jsonLines(t *testing.T, out *bytes.Buffer) []map[string]any {
	t.Helper()
	var lines []map[string]any
	for _, raw := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if raw == "" {
			continue
		}
		line := map[string]any{}
		if err := json.Unmarshal([]byte(raw), &line); err != nil {
			t.Fatalf("log line %q: %v", raw, err)
		}
		lines = append(lines, line)
	}
	return lines
}

func mustID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestMediaPlaneChangeEventCarriesTheWholeChange(t *testing.T) {
	out := captureDefaultLogger(t)
	tenant, space := mustID(t), mustID(t)
	changedAt := time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC)
	LogMediaPlaneChange(context.Background(), mediaplane.Change{
		ID: 7, ChangedAt: changedAt, Scope: mediaplane.ChangeScopeSpace, TenantID: tenant, SpaceID: space,
		OldPlane: mediaplane.PlaneChalk, NewPlane: mediaplane.PlaneCloudflare, Actor: "hasan", Reason: "undo pilot", TraceID: strings.Repeat("a", 32),
	})
	LogMediaPlaneChange(context.Background(), mediaplane.Change{ID: 8, ChangedAt: changedAt, Scope: mediaplane.ChangeScopeKillSwitch, OldPlane: "inherit", NewPlane: mediaplane.PlaneCloudflare, Actor: "hasan", Reason: "drill"})
	lines := jsonLines(t, out)
	if len(lines) != 2 {
		t.Fatalf("lines = %v", lines)
	}
	want := map[string]any{
		"event": "media_plane.changed", "change_id": float64(7), "scope": "space", "tenant_id": tenant.String(), "space_id": space.String(),
		"old_plane": mediaplane.PlaneChalk, "new_plane": mediaplane.PlaneCloudflare, "actor": "hasan", "reason": "undo pilot", "changed_at": "2026-11-17T09:00:00Z", "change_trace_id": strings.Repeat("a", 32),
	}
	for key, value := range want {
		if lines[0][key] != value {
			t.Errorf("%s = %v, want %v", key, lines[0][key], value)
		}
	}
	if _, has := lines[1]["tenant_id"]; has {
		t.Errorf("a kill switch change names a Tenant: %v", lines[1])
	}
	if _, has := lines[1]["space_id"]; has {
		t.Errorf("a kill switch change names a Space: %v", lines[1])
	}
}

func TestMediaPlaneSelectedEventNamesTheEpisodeAndTheRule(t *testing.T) {
	out := captureDefaultLogger(t)
	tenant, space, episode := mustID(t), mustID(t), mustID(t)
	binding, err := mediaplane.NewBinding(mediaplane.ProviderCloudflareSFU, mediaplane.BindingSourceDeploymentDefault, "app")
	if err != nil {
		t.Fatal(err)
	}
	if binding, err = binding.SelectedBy(mediaplane.SelectedByKillSwitch); err != nil {
		t.Fatal(err)
	}
	LogMediaPlaneSelected(context.Background(), tenant, space, episode, binding)
	LogMediaPlaneSelected(context.Background(), tenant, space, episode, mediaplane.Binding{Provider: mediaplane.PlaneCloudflare, ConfigurationSource: mediaplane.BindingSourceDeploymentDefault})
	lines := jsonLines(t, out)
	if len(lines) != 2 {
		t.Fatalf("lines = %v", lines)
	}
	for key, value := range map[string]any{
		"event": "media_plane.selected", "episode_id": episode.String(), "tenant_id": tenant.String(), "space_id": space.String(),
		"provider": mediaplane.PlaneCloudflare, "selected_by": "kill_switch", "configuration_source": "deployment_default",
	} {
		if lines[0][key] != value {
			t.Errorf("%s = %v, want %v", key, lines[0][key], value)
		}
	}
	if lines[1]["selected_by"] != "unknown" {
		t.Errorf("a binding with no selector = %v, want unknown", lines[1]["selected_by"])
	}
}

type fakeLedger struct {
	pending []mediaplane.Change
	failure error
	calls   int
}

func (l *fakeLedger) AnnounceChanges(_ context.Context, limit int, announce func(mediaplane.Change)) (int, error) {
	l.calls++
	if l.failure != nil {
		return 0, l.failure
	}
	n := min(limit, len(l.pending))
	for _, change := range l.pending[:n] {
		announce(change)
	}
	l.pending = l.pending[n:]
	return n, nil
}

// A pass announces every pending change, in batches, and a failed pass logs and stops without panicking.
func TestRelayDrainsTheLedgerAndSurvivesAFailure(t *testing.T) {
	out := captureDefaultLogger(t)
	ledger := &fakeLedger{}
	for i := range mediaPlaneChangeBatch + 5 {
		ledger.pending = append(ledger.pending, mediaplane.Change{ID: int64(i + 1), Scope: mediaplane.ChangeScopeKillSwitch, OldPlane: "inherit", NewPlane: mediaplane.PlaneCloudflare, Actor: "a", Reason: "r"})
	}
	relayMediaPlaneChanges(t.Context(), ledger)
	if got := len(jsonLines(t, out)); got != mediaPlaneChangeBatch+5 || len(ledger.pending) != 0 || ledger.calls != 2 {
		t.Fatalf("announced %d, left %d, calls %d", got, len(ledger.pending), ledger.calls)
	}
	out.Reset()
	failing := &fakeLedger{failure: errors.New("database is down")}
	relayMediaPlaneChanges(t.Context(), failing)
	lines := jsonLines(t, out)
	if len(lines) != 1 || lines[0]["event"] != "media_plane.changes_unannounced" || failing.calls != 1 {
		t.Fatalf("a failed pass logged %v after %d calls", lines, failing.calls)
	}
}
