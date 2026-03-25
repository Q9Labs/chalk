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
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

type fakeTenantQuerier struct {
	mu sync.Mutex

	candidates []db.ListActiveTenantAPIKeysRow
	tenants    map[uuid.UUID]db.Tenant

	listCalls        int
	getCalls         int
	getByLookupCalls int
	updateCalls      int
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

func (q *fakeTenantQuerier) GetTenantByAPIKeyLookupHash(_ context.Context, apiKeyLookupHash *string) (db.Tenant, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.getByLookupCalls++
	if apiKeyLookupHash == nil {
		return db.Tenant{}, pgx.ErrNoRows
	}
	for _, tenant := range q.tenants {
		if tenant.ApiKeyLookupHash != nil && *tenant.ApiKeyLookupHash == *apiKeyLookupHash {
			return tenant, nil
		}
	}
	return db.Tenant{}, pgx.ErrNoRows
}

func (q *fakeTenantQuerier) UpdateTenantAPIKeyLookupHash(_ context.Context, arg db.UpdateTenantAPIKeyLookupHashParams) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.updateCalls++
	tenant, ok := q.tenants[arg.ID]
	if !ok {
		return errors.New("tenant not found")
	}
	if tenant.ApiKeyLookupHash != nil {
		return nil
	}
	if tenant.ApiKeyHash != arg.ApiKeyHash {
		return nil
	}
	tenant.ApiKeyLookupHash = arg.ApiKeyLookupHash
	q.tenants[arg.ID] = tenant
	return nil
}

func (q *fakeTenantQuerier) counts() (listCalls, getCalls, getByLookupCalls, updateCalls int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.listCalls, q.getCalls, q.getByLookupCalls, q.updateCalls
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

func (v *fakeVerifier) LookupHash(apiKey string) string { return "lookup:" + apiKey }

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
	lookupHash := "lookup:" + apiKey

	q := &fakeTenantQuerier{
		tenants: map[uuid.UUID]db.Tenant{
			tenantID: {ID: tenantID, ApiKeyHash: "hash:" + apiKey, IsActive: true, ApiKeyLookupHash: &lookupHash},
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

	list1, get1, getByLookup1, update1 := q.counts()
	require.Equal(t, 0, list1)
	require.Equal(t, 0, get1)
	require.GreaterOrEqual(t, getByLookup1, 1)
	require.Equal(t, 0, update1)

	// Second resolve should be a cache hit: no list call, no additional lookup query.
	tenant2, err := lookup.ResolveActiveTenant(context.Background(), apiKey)
	require.NoError(t, err)
	require.NotNil(t, tenant2)
	require.Equal(t, tenantID, tenant2.ID)

	list2, get2, getByLookup2, update2 := q.counts()
	require.Equal(t, list1, list2)
	require.Greater(t, get2, get1)
	require.Equal(t, getByLookup1, getByLookup2)
	require.Equal(t, update1, update2)
}

func TestTenantLookup_PromotesLegacyMatchToLookupHash(t *testing.T) {
	apiKey := "ck_live_legacykey"
	tenantID := uuid.New()

	q := &fakeTenantQuerier{
		candidates: []db.ListActiveTenantAPIKeysRow{
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

	list1, get1, getByLookup1, update1 := q.counts()
	require.GreaterOrEqual(t, list1, 1)
	require.GreaterOrEqual(t, get1, 1)
	require.GreaterOrEqual(t, getByLookup1, 1)
	require.Equal(t, 1, update1)
	require.NotNil(t, q.tenants[tenantID].ApiKeyLookupHash)

	lookup2 := NewTenantLookup(q, v, WithTenantLookupVerifyWorkers(4), WithTenantLookupPageSize(100))
	tenant2, err := lookup2.ResolveActiveTenant(context.Background(), apiKey)
	require.NoError(t, err)
	require.NotNil(t, tenant2)
	require.Equal(t, tenantID, tenant2.ID)

	list2, _, getByLookup2, update2 := q.counts()
	require.Equal(t, list1, list2)
	require.GreaterOrEqual(t, getByLookup2, 1)
	require.Equal(t, update1, update2)
}

func TestTenantLookup_RejectsStaleLegacyMatchAfterConcurrentRotation(t *testing.T) {
	apiKey := "ck_live_legacykey"
	rotatedAPIKey := "ck_live_rotatedkey"
	tenantID := uuid.New()
	rotatedLookupHash := "lookup:" + rotatedAPIKey

	q := &fakeTenantQuerier{
		candidates: []db.ListActiveTenantAPIKeysRow{
			{ID: tenantID, ApiKeyHash: "hash:" + apiKey},
		},
		tenants: map[uuid.UUID]db.Tenant{
			tenantID: {
				ID:               tenantID,
				ApiKeyHash:       "hash:" + apiKey,
				IsActive:         true,
				ApiKeyLookupHash: nil,
			},
		},
	}

	v := &fakeVerifier{
		match: func(apiKey, hash string) bool { return hash == "hash:"+apiKey },
	}

	lookup := NewTenantLookup(q, v, WithTenantLookupVerifyWorkers(4), WithTenantLookupPageSize(100))

	q.mu.Lock()
	rotatedTenant := q.tenants[tenantID]
	rotatedTenant.ApiKeyHash = "hash:" + rotatedAPIKey
	rotatedTenant.ApiKeyLookupHash = &rotatedLookupHash
	q.tenants[tenantID] = rotatedTenant
	q.mu.Unlock()

	tenant, err := lookup.ResolveActiveTenant(context.Background(), apiKey)
	require.NoError(t, err)
	require.Nil(t, tenant)

	q.mu.Lock()
	defer q.mu.Unlock()
	require.Equal(t, "hash:"+rotatedAPIKey, q.tenants[tenantID].ApiKeyHash)
	require.NotNil(t, q.tenants[tenantID].ApiKeyLookupHash)
	require.Equal(t, rotatedLookupHash, *q.tenants[tenantID].ApiKeyLookupHash)
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
