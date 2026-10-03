// Package tenantpurge describes an explicitly approved operator-only erase.
// It is not an HTTP route and never discovers targets from name patterns.
package tenantpurge

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type Identity struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Scope struct {
	Delete []Identity `json:"delete"`
	Keep   []Identity `json:"keep"`
}

func (s Scope) Validate() error {
	if len(s.Delete) == 0 || len(s.Keep) == 0 {
		return errors.New("explicit nonempty delete and keep partitions are required")
	}
	seen := make(map[string]bool)
	for _, group := range [][]Identity{s.Delete, s.Keep} {
		for _, identity := range group {
			id, err := utilities.ParseID(identity.ID)
			if err != nil || id.String() != identity.ID || identity.Name == "" || seen[identity.ID] {
				return errors.New("identities must have unique canonical UUIDs and exact names")
			}
			seen[identity.ID] = true
		}
	}
	return nil
}

type Row struct {
	Key   json.RawMessage `json:"key"`
	Value json.RawMessage `json:"value,omitempty"`
}

type Table struct {
	Name       string `json:"name"`
	ColumnsDDL string `json:"columns_ddl"`
	Count      int64  `json:"count"`
	Digest     string `json:"digest"`
	Rows       []Row  `json:"rows,omitempty"`
}

type Plan struct {
	Version      int             `json:"version"`
	Kind         string          `json:"kind"`
	CreatedAt    time.Time       `json:"created_at"`
	Scope        Scope           `json:"scope"`
	SchemaDigest string          `json:"schema_digest"`
	Tables       []Table         `json:"tables"`
	Backfill     *Backfill       `json:"backfill,omitempty"`
	Objects      *ObjectManifest `json:"objects,omitempty"`
	WriteDrain   *WriteDrain     `json:"write_drain,omitempty"`
}

// R2 has no atomic conditional DELETE. Direct upload permissions and worker
// leases must expire before removing their rows; erased Tenants cannot mint
// new permissions. SQL references are fenced separately during cleanup.
type WriteDrain struct {
	NotBefore time.Time `json:"not_before"`
}

func (d *WriteDrain) Validate(now time.Time) error {
	if d == nil || d.NotBefore.After(now) {
		return errors.New("verified expired object-write permissions and leases are required")
	}
	return nil
}

// WithoutValues preserves the approved row keys but keeps credentials and
// content out of the ordinary plan. The backup export is a separate stream.
func (p Plan) WithoutValues() Plan {
	result := p
	result.Tables = make([]Table, len(p.Tables))
	for index, table := range p.Tables {
		result.Tables[index] = table
		result.Tables[index].Rows = make([]Row, len(table.Rows))
		for rowIndex, row := range table.Rows {
			result.Tables[index].Rows[rowIndex] = Row{Key: row.Key}
		}
	}
	return result
}

func Digest(value []byte) string {
	hash := sha256.Sum256(value)
	return hex.EncodeToString(hash[:])
}

func (p Plan) Digest() (string, error) {
	data, err := json.Marshal(p.WithoutValues())
	if err != nil {
		return "", err
	}
	return Digest(data), nil
}

func SameRows(expected, current Plan) error {
	if expected.Version != 1 || expected.Kind != current.Kind || expected.SchemaDigest != current.SchemaDigest || len(expected.Tables) != len(current.Tables) {
		return errors.New("plan version, kind, schema or table set changed")
	}
	for index, table := range expected.Tables {
		other := current.Tables[index]
		if table.Name != other.Name || table.Count != other.Count || table.Digest != other.Digest {
			return fmt.Errorf("approved rows changed in table %s", table.Name)
		}
	}
	return nil
}

type BackupReceipt struct {
	PlanDigest      string    `json:"plan_digest"`
	ArchivePath     string    `json:"archive_path"`
	ArchiveDigest   string    `json:"archive_digest"`
	RestoreVerified bool      `json:"restore_verified"`
	RestoreTables   []Table   `json:"restore_tables"`
	CompletedAt     time.Time `json:"completed_at"`
	RetainUntil     time.Time `json:"retain_until"`
}

func (r BackupReceipt) Validate(plan Plan, now time.Time) error {
	digest, err := plan.Digest()
	if err != nil {
		return err
	}
	if r.PlanDigest != digest || !r.RestoreVerified || r.ArchivePath == "" || len(r.ArchiveDigest) != 64 || r.CompletedAt.IsZero() || r.CompletedAt.After(now) || r.RetainUntil.Before(r.CompletedAt.Add(14*24*time.Hour)) || !r.RetainUntil.After(now) {
		return errors.New("a matching restore-verified encrypted backup retained for 14 days is required")
	}
	if len(r.RestoreTables) != len(plan.Tables) {
		return errors.New("restore table set differs")
	}
	for index, table := range plan.Tables {
		other := r.RestoreTables[index]
		if table.Name != other.Name || table.Count != other.Count || table.Digest != other.Digest {
			return fmt.Errorf("restore verification differs for %s", table.Name)
		}
	}
	return nil
}

type Space struct {
	ID       string `json:"id"`
	TenantID string `json:"tenant_id"`
}

type Backfill struct {
	ServiceTenantIDs []string `json:"service_tenant_ids"`
	Spaces           []Space  `json:"spaces"`
}

func (b Backfill) Validate(scope Scope) error {
	kept := make(map[string]bool)
	for _, tenant := range scope.Keep {
		kept[tenant.ID] = true
	}
	services := make(map[string]bool)
	for _, id := range b.ServiceTenantIDs {
		if !kept[id] || services[id] {
			return errors.New("service exclusions must be unique kept Tenants")
		}
		services[id] = true
	}
	seen := make(map[string]bool)
	for _, space := range b.Spaces {
		id, err := utilities.ParseID(space.ID)
		if err != nil || id.String() != space.ID || !kept[space.TenantID] || services[space.TenantID] || seen[space.ID] {
			return errors.New("Space backfill must be canonical, unique, kept and outside service Tenants")
		}
		seen[space.ID] = true
	}
	return nil
}

// DeleteOrder returns child-first tables after caller-verified cycle cuts and
// cascade groups. Unknown remaining cycles fail closed.
func DeleteOrder(names []string, parents map[string][]string) ([]string, error) {
	remaining := make(map[string]bool)
	for _, name := range names {
		remaining[name] = true
	}
	var result []string
	for len(remaining) > 0 {
		var leaves []string
		for candidate := range remaining {
			hasChild := false
			for child := range remaining {
				if child == candidate {
					continue
				}
				for _, parent := range parents[child] {
					if parent == candidate {
						hasChild = true
					}
				}
			}
			if !hasChild {
				leaves = append(leaves, candidate)
			}
		}
		if len(leaves) == 0 {
			return nil, errors.New("unhandled foreign-key cycle; no rows were committed")
		}
		sort.Strings(leaves)
		for _, name := range leaves {
			result = append(result, name)
			delete(remaining, name)
		}
	}
	return result, nil
}
