package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	infraAuth "github.com/Q9Labs/chalk/internal/infrastructure/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

type perfTenantQuerier struct {
	candidates []db.ListActiveTenantAPIKeysRow
	tenants    map[uuid.UUID]db.Tenant

	mu sync.Mutex
}

func (q *perfTenantQuerier) ListActiveTenantAPIKeys(_ context.Context, arg db.ListActiveTenantAPIKeysParams) ([]db.ListActiveTenantAPIKeysRow, error) {
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

func (q *perfTenantQuerier) GetTenant(_ context.Context, id uuid.UUID) (db.Tenant, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	t, ok := q.tenants[id]
	if !ok {
		return db.Tenant{}, errors.New("tenant not found")
	}
	return t, nil
}

type perfVerifier struct {
	sleepPerVerify time.Duration

	inFlight    atomic.Int64
	maxInFlight atomic.Int64

	match func(apiKey, hash string) bool
}

func (v *perfVerifier) ValidateAPIKeyFormat(_ string) error { return nil }

func (v *perfVerifier) VerifyAPIKey(apiKey, hash string) bool {
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

func TestAuthHandler_Token_ResponseTime(t *testing.T) {
	// Goal: prevent API Gateway 30s timeouts by keeping /api/v1/auth/token fast even with many tenants.
	// This is a deterministic perf test: we simulate expensive verification with sleep, then ensure
	// the handler completes within a tight bound using parallel verification.
	gin.SetMode(gin.TestMode)

	// Must satisfy ValidateAPIKeyFormat minimum length check.
	apiKey := "ck_live_" + strings.Repeat("a", 32)
	matchID := uuid.New()

	// Simulate N active tenants, match at the end (worst-case scan).
	const nTenants = 800
	rows := make([]db.ListActiveTenantAPIKeysRow, 0, nTenants)
	tenants := make(map[uuid.UUID]db.Tenant, nTenants)
	for i := 0; i < nTenants-1; i++ {
		id := uuid.New()
		h := "hash:nope"
		rows = append(rows, db.ListActiveTenantAPIKeysRow{ID: id, ApiKeyHash: h})
		tenants[id] = db.Tenant{ID: id, ApiKeyHash: h, IsActive: true}
	}
	rows = append(rows, db.ListActiveTenantAPIKeysRow{ID: matchID, ApiKeyHash: "hash:" + apiKey})
	tenants[matchID] = db.Tenant{ID: matchID, ApiKeyHash: "hash:" + apiKey, IsActive: true}

	q := &perfTenantQuerier{candidates: rows, tenants: tenants}
	v := &perfVerifier{
		sleepPerVerify: 5 * time.Millisecond,
		match: func(apiKey, hash string) bool {
			return hash == "hash:"+apiKey
		},
	}

	lookup := infraAuth.NewTenantLookup(
		q,
		v,
		infraAuth.WithTenantLookupVerifyWorkers(12),
		infraAuth.WithTenantLookupPageSize(1000),
	)

	jwtSvc := infraAuth.NewJWTService(infraAuth.DefaultJWTConfig())
	apiKeySvc := infraAuth.NewAPIKeyService()

	h := &AuthHandler{
		jwtService:    jwtSvc,
		apiKeyService: apiKeySvc,
		tenantLookup:  lookup,
	}

	router := gin.New()
	router.POST("/api/v1/auth/token", h.Token)

	payload, err := json.Marshal(map[string]string{"api_key": apiKey})
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/api/v1/auth/token", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	start := time.Now()
	router.ServeHTTP(w, req)
	d := time.Since(start)

	require.Equal(t, http.StatusOK, w.Code)
	require.GreaterOrEqual(t, v.maxInFlight.Load(), int64(2), "expected parallel verification")

	// Bound: sequential would be ~800 * 5ms = 4s. With 12 workers, expect well under 1s.
	// Keep slack for CI noise.
	require.Less(t, d, 1200*time.Millisecond, "auth/token too slow")
	if d > 250*time.Millisecond {
		t.Logf("/api/v1/auth/token duration=%s (max_in_flight=%d)", d, v.maxInFlight.Load())
	}
}
