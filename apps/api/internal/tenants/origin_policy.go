package tenants

import (
	"context"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	originPolicyCacheTTL        = time.Minute
	originPolicyCacheMaxEntries = 1024
)

type originPolicyEntry struct {
	origins   map[string]struct{}
	expiresAt time.Time
}

type OriginPolicy struct {
	repository TenantRepository
	mu         sync.Mutex
	entries    map[string]originPolicyEntry
	now        func() time.Time
}

func NewOriginPolicy(repository TenantRepository) *OriginPolicy {
	return &OriginPolicy{repository: repository, entries: make(map[string]originPolicyEntry), now: time.Now}
}

func (p *OriginPolicy) Allows(ctx context.Context, tenantID utilities.ID, origin string) (bool, error) {
	if origins, ok := p.cached(tenantID); ok {
		_, allowed := origins[origin]
		return allowed, nil
	}
	origins, err := p.repository.GetTenantCORSAllowedOrigins(ctx, tenantID)
	if err != nil {
		return false, err
	}
	p.Remember(tenantID, origins)
	cached, _ := p.cached(tenantID)
	_, allowed := cached[origin]
	return allowed, nil
}

func (p *OriginPolicy) Remember(tenantID utilities.ID, origins []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.entries) >= originPolicyCacheMaxEntries {
		p.evictOldest()
	}
	allowed := make(map[string]struct{}, len(origins))
	for _, origin := range origins {
		allowed[origin] = struct{}{}
	}
	p.entries[tenantID.String()] = originPolicyEntry{origins: allowed, expiresAt: p.now().Add(originPolicyCacheTTL)}
}

func (p *OriginPolicy) cached(tenantID utilities.ID) (map[string]struct{}, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	entry, ok := p.entries[tenantID.String()]
	if !ok || !p.now().Before(entry.expiresAt) {
		delete(p.entries, tenantID.String())
		return nil, false
	}
	return entry.origins, true
}

func (p *OriginPolicy) evictOldest() {
	var oldestKey string
	var oldestExpiry time.Time
	for key, entry := range p.entries {
		if oldestKey == "" || entry.expiresAt.Before(oldestExpiry) {
			oldestKey = key
			oldestExpiry = entry.expiresAt
		}
	}
	delete(p.entries, oldestKey)
}
