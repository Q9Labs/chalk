package auth

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

type fakeTenantQuerier struct {
	mu sync.Mutex

	candidates []db.ListActiveTenantAPIKeysRow
	tenants    map[uuid.UUID]db.Tenant

	listCalls int
	getCalls  int
}

func (q *fakeTenantQuerier) ListActiveTenantAPIKeys(_ context.Context, arg db.ListActiveTenantAPIKeysParams) ([]db.ListActiveTenantAPIKeysRow, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.listCalls++

	start := int(arg.Offset)
	if start >= len(q.candidates) {
		return nil, nil
	}
	end := start + int(arg.Limit)
	if end > len(q.candidates) {
		end = len(q.candidates)
	}
	out := make([]db.ListActiveTenantAPIKeysRow, 0, end-start)
	out = append(out, q.candidates[start:end]...)
	return out, nil
}

func (q *fakeTenantQuerier) GetTenant(_ context.Context, id uuid.UUID) (db.Tenant, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.getCalls++
	t, ok := q.tenants[id]
	if !ok {
		return db.Tenant{}, errors.New("tenant not found")
	}
	return t, nil
}

func (q *fakeTenantQuerier) counts() (listCalls, getCalls int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.listCalls, q.getCalls
}

type fakeVerifier struct {
	validateErr error

	// Concurrency stats for VerifyAPIKey.
	sleepPerVerify time.Duration
	inFlight       atomic.Int64
	maxInFlight    atomic.Int64

	// Match predicate.
	match func(apiKey, hash string) bool
}

func (v *fakeVerifier) ValidateAPIKeyFormat(_ string) error { return v.validateErr }

func (v *fakeVerifier) VerifyAPIKey(apiKey, hash string) bool {
	cur := v.inFlight.Add(1)
	for {
		prev := v.maxInFlight.Load()
		if cur <= prev || v.maxInFlight.CompareAndSwap(prev, cur) {
			break
		}
	}
	if v.sleepPerVerify > 0 {
		time.Sleep(v.sleepPerVerify)
	}
	v.inFlight.Add(-1)
	if v.match == nil {
		return false
	}
	return v.match(apiKey, hash)
}

func TestTenantLookup_ResolvesAndCaches(t *testing.T) {
	apiKey := "ck_live_testkey"
	tenantID := uuid.New()

	q := &fakeTenantQuerier{
		candidates: []db.ListActiveTenantAPIKeysRow{
			{ID: uuid.New(), ApiKeyHash: "hash:nope"},
			{ID: tenantID, ApiKeyHash: "hash:" + apiKey},
		},
		tenants: map[uuid.UUID]db.Tenant{
			tenantID: {ID: tenantID, ApiKeyHash: "hash:" + apiKey, IsActive: true},
		},
	}

	v := &fakeVerifier{
		match: func(apiKey, hash string) bool { return hash == "hash:"+apiKey },
	}

	lookup := NewTenantLookup(q, v, WithTenantLookupVerifyWorkers(4), WithTenantLookupPageSize(100))

	tenant, err := lookup.ResolveActiveTenant(context.Background(), apiKey)
	require.NoError(t, err)
	require.NotNil(t, tenant)
	require.Equal(t, tenantID, tenant.ID)

	list1, get1 := q.counts()
	require.GreaterOrEqual(t, list1, 1)
	require.GreaterOrEqual(t, get1, 1)

	// Second resolve should be a cache hit: no list call, only GetTenant.
	tenant2, err := lookup.ResolveActiveTenant(context.Background(), apiKey)
	require.NoError(t, err)
	require.NotNil(t, tenant2)
	require.Equal(t, tenantID, tenant2.ID)

	list2, get2 := q.counts()
	require.Equal(t, list1, list2)
	require.Greater(t, get2, get1)
}

func TestTenantLookup_UsesConcurrency(t *testing.T) {
	apiKey := "ck_live_slow"
	matchID := uuid.New()

	var rows []db.ListActiveTenantAPIKeysRow
	tenants := map[uuid.UUID]db.Tenant{
		matchID: {ID: matchID, ApiKeyHash: "hash:" + apiKey, IsActive: true},
	}

	// Put the matching row at the end to force work.
	for i := 0; i < 20; i++ {
		id := uuid.New()
		rows = append(rows, db.ListActiveTenantAPIKeysRow{ID: id, ApiKeyHash: "hash:nope"})
		tenants[id] = db.Tenant{ID: id, ApiKeyHash: "hash:nope", IsActive: true}
	}
	rows = append(rows, db.ListActiveTenantAPIKeysRow{ID: matchID, ApiKeyHash: "hash:" + apiKey})

	q := &fakeTenantQuerier{candidates: rows, tenants: tenants}

	v := &fakeVerifier{
		sleepPerVerify: 10 * time.Millisecond,
		match:          func(apiKey, hash string) bool { return hash == "hash:"+apiKey },
	}

	lookup := NewTenantLookup(q, v, WithTenantLookupVerifyWorkers(8), WithTenantLookupPageSize(1000))

	tenant, err := lookup.ResolveActiveTenant(context.Background(), apiKey)
	require.NoError(t, err)
	require.NotNil(t, tenant)
	require.Equal(t, matchID, tenant.ID)

	require.GreaterOrEqual(t, v.maxInFlight.Load(), int64(2))
}
