package tenantpurge

import (
	"context"
	"errors"
	"fmt"
	"path"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

type StorageObject struct {
	Key           string `json:"key"`
	ETag          string `json:"etag"`
	Size          int64  `json:"size"`
	OwnerTenantID string `json:"owner_tenant_id,omitempty"`
}

type ObjectManifest struct {
	Bucket         string          `json:"bucket"`
	SharedPrefixes []string        `json:"shared_prefixes,omitempty"`
	Objects        []StorageObject `json:"objects"`
}

func (m ObjectManifest) Validate(scope Scope) error {
	if m.Bucket == "" {
		return errors.New("object bucket required")
	}
	approved := make(map[string]bool)
	for _, identity := range scope.Delete {
		approved[identity.ID] = true
	}
	for _, prefix := range m.SharedPrefixes {
		if !strings.HasSuffix(prefix, "/") || strings.HasPrefix(prefix, "/") || path.Clean(prefix)+"/" != prefix || len(prefix) < 3 {
			return errors.New("shared prefixes must be explicit clean non-root prefixes")
		}
	}
	seen := make(map[string]bool)
	for _, object := range m.Objects {
		if object.Key == "" || path.Clean(object.Key) != object.Key || strings.HasPrefix(object.Key, "/") || strings.HasPrefix(object.Key, "../") || object.Size < 0 || object.ETag == "" || seen[object.Key] {
			return errors.New("objects require unique clean keys, sizes and ETags")
		}
		seen[object.Key] = true
		if object.OwnerTenantID != "" {
			if !approved[object.OwnerTenantID] || !strings.HasPrefix(object.Key, "tenants/"+object.OwnerTenantID+"/") {
				return errors.New("object owner outside explicit erase scope")
			}
			continue
		}
		shared := false
		for _, prefix := range m.SharedPrefixes {
			if strings.HasPrefix(object.Key, prefix) {
				shared = true
			}
		}
		if !shared {
			return errors.New("object has no approved Tenant or explicit shared prefix")
		}
	}
	return nil
}

type ObjectStore interface {
	InspectObject(context.Context, string) (objectstorage.ObjectFacts, error)
	DeleteObjectIfMatch(context.Context, string, string) error
}

// CleanupObjects is repeatable after a committed relational erase. Callers
// must first prove the deleted identities are absent and kept references are
// clear. Object absence counts as success; changed bytes never get deleted.
func CleanupObjects(ctx context.Context, store ObjectStore, manifest ObjectManifest, record func(StorageObject) error) error {
	for _, object := range manifest.Objects {
		facts, err := store.InspectObject(ctx, object.Key)
		if errors.Is(err, objectstorage.ErrObjectNotFound) {
			if err := record(object); err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return fmt.Errorf("inspect approved object: %w", err)
		}
		if facts.Size != object.Size || strings.Trim(facts.ETag, "\"") != strings.Trim(object.ETag, "\"") {
			return errors.New("approved object bytes changed; cleanup stopped")
		}
		if err := store.DeleteObjectIfMatch(ctx, object.Key, facts.ETag); err != nil {
			return fmt.Errorf("delete approved object: %w", err)
		}
		if _, err := store.InspectObject(ctx, object.Key); !errors.Is(err, objectstorage.ErrObjectNotFound) {
			if err != nil {
				return fmt.Errorf("verify absence: %w", err)
			}
			return errors.New("object still present after deletion")
		}
		if err := record(object); err != nil {
			return err
		}
	}
	return nil
}
