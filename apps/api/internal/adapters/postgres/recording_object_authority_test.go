package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
)

type recordingBundleCommitQuery struct {
	recordingObjectAuthorityQuerier
	writtenChecksum []byte
}

func (q *recordingBundleCommitQuery) CommitRecordingBundleAllocation(_ context.Context, input sqlc.CommitRecordingBundleAllocationParams) (sqlc.CommitRecordingBundleAllocationRow, error) {
	q.writtenChecksum = input.ObjectChecksum
	return sqlc.CommitRecordingBundleAllocationRow{}, nil
}

func TestCaptureBundleCommitPersistsVerifiedMetadataChecksum(t *testing.T) {
	const id = "84a4fc94-7a19-4c7d-b5a9-f36b568acd3f"
	query := &recordingBundleCommitQuery{}
	repo := RecordingObjectRepository{queries: query}
	allocation := recordingobjects.Allocation{
		ID: id,
		Authority: recordingobjects.Authority{
			TenantID: id, EpisodeID: id, RecordingID: id, JobID: id, ObjectHandle: id,
		},
	}
	checksum := sha256.Sum256([]byte("encrypted capture"))
	facts := objectstorage.ObjectFacts{
		Object:   objectstorage.Object{ETag: "test-etag"},
		Metadata: map[string]string{"chalk-sha256": hex.EncodeToString(checksum[:])},
	}
	if _, err := repo.CommitAllocation(context.Background(), allocation, facts, make([]byte, sha256.Size), time.Now()); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(query.writtenChecksum, checksum[:]) {
		t.Fatalf("stored checksum %x; want %x", query.writtenChecksum, checksum)
	}
}
