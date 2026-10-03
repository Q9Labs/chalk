package tenantpurge

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

type fixtureStore struct {
	exists  bool
	size    int64
	etag    string
	deletes int
}

func (s *fixtureStore) InspectObject(context.Context, string) (objectstorage.ObjectFacts, error) {
	if !s.exists {
		return objectstorage.ObjectFacts{}, objectstorage.ErrObjectNotFound
	}
	return objectstorage.ObjectFacts{Object: objectstorage.Object{Size: s.size, ETag: s.etag}}, nil
}
func (s *fixtureStore) DeleteObject(context.Context, string) error {
	s.deletes++
	s.exists = false
	return nil
}

func TestCleanupRejectsChangedBytesAndReplaysAbsence(t *testing.T) {
	m := ObjectManifest{Bucket: "fixture", Objects: []StorageObject{{Key: "tenants/" + testScope().Delete[0].ID + "/recording.bin", OwnerTenantID: testScope().Delete[0].ID, Size: 7, ETag: "old"}}}
	if err := m.Validate(testScope()); err != nil {
		t.Fatal(err)
	}
	s := &fixtureStore{exists: true, size: 7, etag: "changed"}
	records := 0
	record := func(StorageObject) error { records++; return nil }
	if CleanupObjects(context.Background(), s, m, record) == nil || s.deletes != 0 {
		t.Fatal("changed bytes deleted")
	}
	s.etag = "old"
	if err := CleanupObjects(context.Background(), s, m, record); err != nil {
		t.Fatal(err)
	}
	if err := CleanupObjects(context.Background(), s, m, record); err != nil {
		t.Fatal(err)
	}
	if s.deletes != 1 || records != 2 {
		t.Fatalf("deletes=%d records=%d", s.deletes, records)
	}
	m.Objects[0].OwnerTenantID = testScope().Keep[0].ID
	if m.Validate(testScope()) == nil {
		t.Fatal("kept owner accepted")
	}
}
