package chalksfu_test

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// recoveryStore stands in for Postgres at the binding boundary. MoveBinding is the same
// compare-and-set: it commits only at the generation the mover read and otherwise returns the
// stored binding with ErrBindingStale. The real statement and trigger are covered by the
// Postgres integration test.
type recoveryStore struct {
	mu           sync.Mutex
	binding      mediaplane.Binding
	status       string
	participants int
	moves        int
	crashBefore  error // returned once by MoveBinding before it commits, as a crash would
	debts        map[debtKey]mediaplane.RetirementDebt
	since        map[debtKey]time.Time
}

type debtKey struct {
	tenant, episode utilities.ID
	node, boot      string
}

func keyOf(debt mediaplane.RetirementDebt) debtKey {
	return debtKey{debt.TenantID, debt.EpisodeID, debt.Allocation.Node, debt.Allocation.Incarnation}
}

func newRecoveryStore(binding mediaplane.Binding, participants int) *recoveryStore {
	return &recoveryStore{binding: binding, status: episodes.EpisodeStatusActive, participants: participants}
}

func (s *recoveryStore) GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	snapshot, err := json.Marshal(map[string]any{"media_plane_binding": s.binding})
	return episodes.Episode{Status: s.status, ConfigSnapshot: snapshot}, err
}

func (s *recoveryStore) LiveParticipants(context.Context, utilities.ID, utilities.ID) (int, error) {
	return s.participants, nil
}

func (s *recoveryStore) Binding(context.Context, utilities.ID, utilities.ID) (*mediaplane.Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.binding
	return &current, nil
}

func (s *recoveryStore) MoveBinding(_ context.Context, _, _ utilities.ID, from int64, next mediaplane.Binding) (mediaplane.Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if crash := s.crashBefore; crash != nil {
		s.crashBefore = nil
		return mediaplane.Binding{}, crash
	}
	if s.binding.Generation != from || next.Generation != from+1 {
		return s.binding, mediaplane.ErrBindingStale
	}
	s.binding = next
	s.moves++
	// The real statement records the debts in the same transaction as the move.
	for _, old := range next.Retirements() {
		s.record(mediaplane.RetirementDebt{TenantID: recoveringTenant.ID, EpisodeID: recoveringEpisode, Allocation: old, Generation: next.Generation})
	}
	return next, nil
}

// set puts the store at a binding another replica committed, with the debts that move recorded.
func (s *recoveryStore) set(binding mediaplane.Binding) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.binding = binding
	for _, old := range binding.Retirements() {
		s.record(mediaplane.RetirementDebt{TenantID: recoveringTenant.ID, EpisodeID: recoveringEpisode, Allocation: old, Generation: binding.Generation})
	}
}

func (s *recoveryStore) record(debt mediaplane.RetirementDebt) {
	if s.debts == nil {
		s.debts = map[debtKey]mediaplane.RetirementDebt{}
	}
	if s.since == nil {
		s.since = map[debtKey]time.Time{}
	}
	if _, ok := s.debts[keyOf(debt)]; !ok {
		s.since[keyOf(debt)] = time.Now()
	}
	if held, ok := s.debts[keyOf(debt)]; !ok || held.Generation < debt.Generation {
		s.debts[keyOf(debt)] = debt
	}
}

func (s *recoveryStore) RecordRetirementDebts(_ context.Context, debts []mediaplane.RetirementDebt) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, debt := range debts {
		s.record(debt)
	}
	return nil
}

// ClaimRetirementDebts returns every debt: the backoff between attempts is Postgres's, covered
// by its integration test.
func (s *recoveryStore) ClaimRetirementDebts(_ context.Context, limit int) ([]mediaplane.RetirementDebt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var due []mediaplane.RetirementDebt
	for _, debt := range s.debts {
		if len(due) < limit {
			due = append(due, debt)
		}
	}
	return due, nil
}

func (s *recoveryStore) SettleRetirementDebt(_ context.Context, debt mediaplane.RetirementDebt) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if held, ok := s.debts[keyOf(debt)]; ok && held.Generation <= debt.Generation {
		delete(s.debts, keyOf(debt))
	}
	return nil
}

func (s *recoveryStore) RetirementBacklog(context.Context) (int, time.Duration, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var oldest time.Duration
	for key := range s.debts {
		oldest = max(oldest, time.Since(s.since[key]))
	}
	return len(s.debts), oldest, nil
}

func (s *recoveryStore) owed() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.debts)
}

func (s *recoveryStore) current() (mediaplane.Binding, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.binding, s.moves
}

func recoveryRegistry(fleet *chalksfu.Fleet, store *recoveryStore) mediaplaneproviders.Registry {
	return mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
		ProcessConfig: withCloudflare, DefaultProvider: mediaplane.ProviderCloudflareSFU, ChalkSFU: fleet, Rollout: mediaplaneproviders.Rollout{Spaces: everySpace}, Episodes: store, Recovery: store,
	})
}

var chalkSpace = spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}

// placedBinding places a new Episode on the pool as Episode creation does.
func placedBinding(t *testing.T, fleet *chalksfu.Fleet) mediaplane.Binding {
	t.Helper()
	fleet.Probe(context.Background())
	binding, err := recoveryRegistry(fleet, newRecoveryStore(mediaplane.Binding{}, 0)).ResolveBinding(context.Background(), tenants.Tenant{}, chalkSpace, ownSFUClients)
	if err != nil || binding == nil || binding.Node == "" || binding.NodeIncarnation == "" {
		t.Fatalf("placement: %+v, %v", binding, err)
	}
	return *binding
}

var (
	recoveringTenant  = tenants.Tenant{ID: utilities.IDFromBytes([16]byte{1, 1})}
	recoveringEpisode = utilities.IDFromBytes([16]byte{3, 3})
)

func resolve(registry mediaplaneproviders.Registry) error {
	_, err := registry.ResolveEpisode(context.Background(), recoveringTenant, chalkSpace, recoveringEpisode)
	return err
}

type nodeState struct {
	NodeIncarnation   string `json:"nodeIncarnation"`
	ReservedPackets   int    `json:"reservedPackets"`
	NewEpisodePackets int    `json:"newEpisodePackets"`
	Sessions          int    `json:"sessions"`
}

// stateOf reads a node's readiness over the control channel.
func stateOf(t *testing.T, box *sfu) nodeState {
	t.Helper()
	reply, err := box.httpClient(t, box.ca, clientIdentity).Get(box.controlURL + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	defer reply.Body.Close()
	var state nodeState
	if err := json.NewDecoder(reply.Body).Decode(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func recoveringScope(participant string) mediaplane.Scope {
	return mediaplane.Scope{TenantID: recoveringTenant.ID.String(), EpisodeID: recoveringEpisode.String(), ParticipantID: participant, Generation: 1}
}

func restart(t *testing.T, box *sfu) {
	t.Helper()
	box.stop()
	box.launch(t)
}

func twoNodes(t *testing.T, settings map[string]string) (ca *authority, primary, standby *sfu, nodes []runtimeconfig.ChalkSFUNode) {
	t.Helper()
	ca = newAuthority(t, "pool CA")
	primary, standby = startSFUUnder(t, ca, settings), startSFUUnder(t, ca, settings)
	nodes = []runtimeconfig.ChalkSFUNode{{ID: "sfu-primary", ControlURL: primary.controlURL}, {ID: "sfu-standby", ControlURL: standby.controlURL, Role: runtimeconfig.ChalkSFURoleStandby}}
	return ca, primary, standby, nodes
}

var roomy = map[string]string{"SFU_PACKET_BUDGET": "10000"}
