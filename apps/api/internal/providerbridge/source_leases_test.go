package providerbridge

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

type pagedGrants struct {
	rows  []SourceGrant
	pages int
}

func (p *pagedGrants) ListRenewableSourceGrants(_ context.Context, after SourceGrant, limit int) ([]SourceGrant, error) {
	p.pages++
	start := 0
	if after != (SourceGrant{}) {
		for index, row := range p.rows {
			if row == after {
				start = index + 1
			}
		}
	}
	return p.rows[start:min(start+limit, len(p.rows))], nil
}

// A renewal pass re-grants every standing source at its stored revision with one
// request per Episode, and a dead node does not hold up the others.
func TestSourceLeasesRenewEveryStandingGrant(t *testing.T) {
	tenant := testExecutorID(t, "11111111-1111-4111-8111-111111111111")
	first := testExecutorID(t, "22222222-2222-4222-8222-222222222222")
	second := testExecutorID(t, "44444444-4444-4444-8444-444444444444")
	third := testExecutorID(t, "55555555-5555-4555-8555-555555555555")
	host := testExecutorID(t, "33333333-3333-4333-8333-333333333333")
	grants := &pagedGrants{rows: []SourceGrant{
		{TenantID: tenant, EpisodeID: first, Node: "sfu-a", ParticipantID: host, Source: "camera", Revision: 4},
		{TenantID: tenant, EpisodeID: first, Node: "sfu-a", ParticipantID: host, Source: "screen", Revision: 6},
		{TenantID: tenant, EpisodeID: second, Node: "sfu-down", ParticipantID: host, Source: "microphone", Revision: 2},
		{TenantID: tenant, EpisodeID: third, Node: "sfu-down", ParticipantID: host, Source: "microphone", Revision: 2},
		{TenantID: tenant, EpisodeID: third, Node: "sfu-b", ParticipantID: host, Source: "microphone", Revision: 9},
	}}
	recorders := map[string]*chalkCleanupRecorder{"sfu-a": {}, "sfu-b": {}}
	downCalls := 0
	leases := NewSourceLeases(grants, func(node string) (ChalkNode, error) {
		if node == "sfu-down" {
			downCalls++
			return nil, errors.New("node unreachable")
		}
		return recorders[node], nil
	})
	leases.pageSize = 2

	if err := leases.Renew(context.Background()); err != nil {
		t.Fatal(err)
	}
	if grants.pages != 3 {
		t.Fatalf("pages = %d, want 3", grants.pages)
	}
	if downCalls != 1 {
		t.Fatalf("calls to the failed node = %d, want 1", downCalls)
	}
	type sent struct {
		source   string
		revision int64
	}
	var onA []sent
	for _, control := range recorders["sfu-a"].controls {
		if control.Action != mediaplane.SourceGrant || control.ParticipantID != host.String() {
			t.Fatalf("control = %+v", control)
		}
		onA = append(onA, sent{control.Source, control.Revision})
	}
	if want := []sent{{"camera", 4}, {"screen", 6}, {"screen_audio", 6}}; len(onA) != len(want) || onA[0] != want[0] || onA[1] != want[1] || onA[2] != want[2] {
		t.Fatalf("controls on sfu-a = %v, want %v", onA, want)
	}
	if got := recorders["sfu-b"].controls; len(got) != 1 || got[0].Revision != 9 {
		t.Fatalf("controls on sfu-b = %+v", got)
	}
}
