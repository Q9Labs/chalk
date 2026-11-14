package tenantpurge

import (
	"context"
	"errors"
	"fmt"
	"path"
	"slices"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjectkey"
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
	for _, prefix := range m.SharedPrefixes {
		if !cleanSharedPrefix(prefix) {
			return errors.New("shared prefixes must be explicit clean non-root prefixes")
		}
	}
	approved := make(map[string]bool, len(scope.Delete))
	for _, identity := range scope.Delete {
		approved[identity.ID] = true
	}
	seen := make(map[string]bool, len(m.Objects))
	for _, object := range m.Objects {
		if !cleanObjectKey(object) || seen[object.Key] {
			return errors.New("objects require unique clean keys, sizes and ETags")
		}
		seen[object.Key] = true
		if err := m.validateOwner(object, approved); err != nil {
			return err
		}
	}
	return nil
}

func cleanSharedPrefix(prefix string) bool {
	return strings.HasSuffix(prefix, "/") && !strings.HasPrefix(prefix, "/") && path.Clean(prefix)+"/" == prefix && len(prefix) >= 3
}

func cleanObjectKey(object StorageObject) bool {
	return object.Key != "" && path.Clean(object.Key) == object.Key &&
		!strings.HasPrefix(object.Key, "/") && !strings.HasPrefix(object.Key, "../") &&
		object.Size >= 0 && object.ETag != ""
}

// validateOwner requires an object to belong to an erased Tenant or to sit under an explicit shared prefix.
func (m ObjectManifest) validateOwner(object StorageObject, approved map[string]bool) error {
	if object.OwnerTenantID != "" {
		if !approved[object.OwnerTenantID] || !strings.HasPrefix(object.Key, recordingobjectkey.TenantPrefix(object.OwnerTenantID)) {
			return errors.New("object owner outside explicit erase scope")
		}
		return nil
	}
	if !slices.ContainsFunc(m.SharedPrefixes, func(prefix string) bool { return strings.HasPrefix(object.Key, prefix) }) {
		return errors.New("object has no approved Tenant or explicit shared prefix")
	}
	return nil
}

type ObjectStore interface {
	InspectObject(context.Context, string) (objectstorage.ObjectFacts, error)
	DeleteObject(context.Context, string) error
}

// CleanupObjects is repeatable after a committed relational erase. Callers
// must first prove the deleted identities are absent and kept references are
// clear and require the plan's expired write authorities. R2 ignores DELETE
// If-Match, so this is an inspect/delete under an application write drain,
// not atomic storage compare-and-delete. Outside administrators must not write
// these scoped objects during cleanup. Absence counts as repeatable success.
func CleanupObjects(ctx context.Context, store ObjectStore, manifest ObjectManifest, record func(StorageObject) error) error {
	for _, object := range manifest.Objects {
		if err := deleteApprovedObject(ctx, store, object); err != nil {
			return err
		}
		if err := record(object); err != nil {
			return err
		}
	}
	return nil
}

// deleteApprovedObject removes one object whose bytes still match the plan and proves it is gone.
func deleteApprovedObject(ctx context.Context, store ObjectStore, object StorageObject) error {
	facts, err := store.InspectObject(ctx, object.Key)
	if errors.Is(err, objectstorage.ErrObjectNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect approved object: %w", err)
	}
	if facts.Size != object.Size || strings.Trim(facts.ETag, "\"") != strings.Trim(object.ETag, "\"") {
		return errors.New("approved object bytes changed; cleanup stopped")
	}
	if err := store.DeleteObject(ctx, object.Key); err != nil {
		return fmt.Errorf("delete approved object: %w", err)
	}
	_, err = store.InspectObject(ctx, object.Key)
	if errors.Is(err, objectstorage.ErrObjectNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("verify absence: %w", err)
	}
	return errors.New("object still present after deletion")
}
