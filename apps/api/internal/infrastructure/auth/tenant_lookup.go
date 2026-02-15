package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
)

var (
	ErrAPIKeyLookupTimeout = errors.New("api key lookup timeout")
)

type apiKeyVerifier interface {
	ValidateAPIKeyFormat(apiKey string) error
	VerifyAPIKey(apiKey, hash string) bool
}

type tenantQuerier interface {
	ListActiveTenantAPIKeys(ctx context.Context, arg db.ListActiveTenantAPIKeysParams) ([]db.ListActiveTenantAPIKeysRow, error)
	GetTenant(ctx context.Context, id uuid.UUID) (db.Tenant, error)
}

type TenantLookup struct {
	q        tenantQuerier
	verifier apiKeyVerifier
	log      *slog.Logger

	pageSize      int32
	verifyWorkers int
	cache         *tenantLookupCache
}

type TenantLookupOption func(*TenantLookup)

func WithTenantLookupPageSize(pageSize int32) TenantLookupOption {
	return func(l *TenantLookup) {
		if pageSize > 0 {
			l.pageSize = pageSize
		}
	}
}

func WithTenantLookupVerifyWorkers(n int) TenantLookupOption {
	return func(l *TenantLookup) {
		if n > 0 {
			l.verifyWorkers = n
		}
	}
}

func WithTenantLookupLogger(log *slog.Logger) TenantLookupOption {
	return func(l *TenantLookup) {
		if log != nil {
			l.log = log
		}
	}
}

func NewTenantLookup(q tenantQuerier, verifier apiKeyVerifier, opts ...TenantLookupOption) *TenantLookup {
	workers := defaultVerifyWorkers()
	l := &TenantLookup{
		q:             q,
		verifier:      verifier,
		log:           slog.Default(),
		pageSize:      1000, // 1k tenants is the current hard cap in the slow path; prefer fewer DB round trips.
		verifyWorkers: workers,
		cache: newTenantLookupCache(tenantLookupCacheConfig{
			ttl:      10 * time.Minute,
			maxItems: 4096,
		}),
	}
	for _, opt := range opts {
		opt(l)
	}
	return l
}

func defaultVerifyWorkers() int {
	// bcrypt compare is CPU heavy; oversubscribe a bit to hide scheduler stalls, but cap.
	n := runtime.GOMAXPROCS(0) * 2
	if n < 4 {
		n = 4
	}
	if n > 16 {
		n = 16
	}
	return n
}

// ResolveActiveTenant finds the active tenant owning apiKey.
// Fast path: in-memory cache -> 1 DB read + 1 bcrypt compare.
// Slow path: page through active tenant API key hashes and verify (parallelized).
func (l *TenantLookup) ResolveActiveTenant(ctx context.Context, apiKey string) (*db.Tenant, error) {
	if l.verifier == nil || l.q == nil {
		return nil, errors.New("tenant lookup misconfigured")
	}
	if err := l.verifier.ValidateAPIKeyFormat(apiKey); err != nil {
		return nil, err
	}

	start := time.Now()
	cacheKey := apiKeyCacheKey(apiKey)
	if tenantID, ok := l.cache.Get(cacheKey); ok {
		tenant, err := l.q.GetTenant(ctx, tenantID)
		if err == nil && tenant.IsActive && l.verifier.VerifyAPIKey(apiKey, tenant.ApiKeyHash) {
			return &tenant, nil
		}
		l.cache.Delete(cacheKey)
	}

	// Guardrail: callers behind API Gateway have a 30s cap; if a deadline exists, respect it.
	// Otherwise keep going; correctness over fast failure here (we don't want to reject valid keys).
	deadline, hasDeadline := ctx.Deadline()

	const slowLogThreshold = 1500 * time.Millisecond
	var (
		offset       int32
		totalChecked int64
	)

	for {
		if hasDeadline && time.Until(deadline) <= 0 {
			return nil, ErrAPIKeyLookupTimeout
		}

		rows, err := l.q.ListActiveTenantAPIKeys(ctx, db.ListActiveTenantAPIKeysParams{
			Limit:  l.pageSize,
			Offset: offset,
		})
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			break
		}

		tenantID, checked, found := l.findMatchInRows(ctx, apiKey, rows)
		atomic.AddInt64(&totalChecked, int64(checked))
		if found {
			tenant, err := l.q.GetTenant(ctx, tenantID)
			if err != nil {
				return nil, err
			}
			l.cache.Set(cacheKey, tenant.ID)
			if d := time.Since(start); d >= slowLogThreshold {
				l.log.Warn("api key lookup slow (match found)",
					"duration_ms", d.Milliseconds(),
					"checked", totalChecked,
					"page_size", l.pageSize,
					"workers", l.verifyWorkers,
				)
			}
			return &tenant, nil
		}

		offset += l.pageSize
	}

	if d := time.Since(start); d >= slowLogThreshold {
		l.log.Warn("api key lookup slow (no match)",
			"duration_ms", d.Milliseconds(),
			"checked", totalChecked,
			"page_size", l.pageSize,
			"workers", l.verifyWorkers,
		)
	}
	return nil, nil
}

func (l *TenantLookup) findMatchInRows(ctx context.Context, apiKey string, rows []db.ListActiveTenantAPIKeysRow) (uuid.UUID, int, bool) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	jobs := make(chan db.ListActiveTenantAPIKeysRow)
	foundCh := make(chan uuid.UUID, 1)

	var checked atomic.Int64
	var wg sync.WaitGroup
	workers := l.verifyWorkers
	if workers < 1 {
		workers = 1
	}

	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case row, ok := <-jobs:
					if !ok {
						return
					}
					checked.Add(1)
					if l.verifier.VerifyAPIKey(apiKey, row.ApiKeyHash) {
						select {
						case foundCh <- row.ID:
						default:
						}
						cancel()
						return
					}
				}
			}
		}()
	}

sendLoop:
	for _, row := range rows {
		select {
		case <-ctx.Done():
			break sendLoop
		case jobs <- row:
		}
	}
	close(jobs)
	wg.Wait()

	select {
	case id := <-foundCh:
		return id, int(checked.Load()), true
	default:
		return uuid.Nil, int(checked.Load()), false
	}
}

func apiKeyCacheKey(apiKey string) string {
	sum := sha256.Sum256([]byte(apiKey))
	return hex.EncodeToString(sum[:])
}

type tenantLookupCacheConfig struct {
	ttl      time.Duration
	maxItems int
}

type tenantLookupCache struct {
	mu  sync.Mutex
	cfg tenantLookupCacheConfig
	m   map[string]tenantLookupCacheEntry
}

type tenantLookupCacheEntry struct {
	tenantID  uuid.UUID
	expiresAt time.Time
}

func newTenantLookupCache(cfg tenantLookupCacheConfig) *tenantLookupCache {
	if cfg.ttl <= 0 {
		cfg.ttl = 10 * time.Minute
	}
	if cfg.maxItems <= 0 {
		cfg.maxItems = 4096
	}
	return &tenantLookupCache{
		cfg: cfg,
		m:   make(map[string]tenantLookupCacheEntry, cfg.maxItems),
	}
}

func (c *tenantLookupCache) Get(key string) (uuid.UUID, bool) {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	ent, ok := c.m[key]
	if !ok {
		return uuid.Nil, false
	}
	if now.After(ent.expiresAt) {
		delete(c.m, key)
		return uuid.Nil, false
	}
	return ent.tenantID, true
}

func (c *tenantLookupCache) Set(key string, tenantID uuid.UUID) {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()

	// Simple opportunistic eviction: drop expired keys; if still over cap, delete one arbitrary entry.
	if len(c.m) >= c.cfg.maxItems {
		for k, ent := range c.m {
			if now.After(ent.expiresAt) {
				delete(c.m, k)
			}
		}
		if len(c.m) >= c.cfg.maxItems {
			for k := range c.m {
				delete(c.m, k)
				break
			}
		}
	}

	c.m[key] = tenantLookupCacheEntry{
		tenantID:  tenantID,
		expiresAt: now.Add(c.cfg.ttl),
	}
}

func (c *tenantLookupCache) Delete(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.m, key)
}
