package recordingobjects_test

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
)

func TestAllocateGeneratesServerOwnedObjectAndOpaqueToken(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	store := &storeStub{uploadURL: objectstorage.SignedURL{Method: "PUT", URL: "https://storage.test/upload"}}
	repository := &repositoryStub{}
	service, err := recordingobjects.NewService(objectstorage.NewService(store), repository, recordingobjects.Config{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	checksum := bytesOf(32, 3)
	result, err := service.Allocate(context.Background(), recordingobjects.AllocateInput{
		Authority: testAuthority(), SequenceNumber: 7, ExpectedByteSize: 128,
		Codec: "opus", MonotonicEndMillis: 10, MediaEndMillis: 10,
		ExpectedChecksumSHA256: checksum, ContentType: "application/octet-stream",
		EncryptionContextDigest: bytesOf(32, 4), ExpiresAt: now.Add(5 * time.Minute),
	})
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if result.UploadToken == "" || len(repository.allocation.TokenHash) != 32 || strings.Contains(string(repository.allocation.TokenHash), result.UploadToken) {
		t.Fatalf("token persistence leaked raw token: result=%q hash=%x", result.UploadToken, repository.allocation.TokenHash)
	}
	if !strings.Contains(store.uploadInput.Key, "/capture/3/bundles/7/") {
		t.Fatalf("server object key = %q, upload = %#v", store.uploadInput.Key, result.UploadURL)
	}
	if store.uploadInput.ContentLength != 128 || store.uploadInput.ChecksumSHA256 != base64.StdEncoding.EncodeToString(checksum) || !store.uploadInput.IfNoneMatch {
		t.Fatalf("upload constraints = %#v", store.uploadInput)
	}
}

func TestCommitRereadsAndPersistsAuthoritativeFacts(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	checksum := bytesOf(32, 3)
	store := &storeStub{uploadURL: objectstorage.SignedURL{Method: "PUT", URL: "https://storage.test/upload"}, facts: objectstorage.ObjectFacts{Object: objectstorage.Object{ETag: "etag", VersionID: "version", ContentType: "application/octet-stream", Size: 128, ChecksumSHA256: base64.StdEncoding.EncodeToString(checksum)}}}
	repository := &repositoryStub{}
	service, err := recordingobjects.NewService(objectstorage.NewService(store), repository, recordingobjects.Config{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	allocation, err := service.Allocate(context.Background(), recordingobjects.AllocateInput{Authority: testAuthority(), SequenceNumber: 1, Codec: "opus", MonotonicEndMillis: 10, MediaEndMillis: 10, ExpectedByteSize: 128, ExpectedChecksumSHA256: checksum, ContentType: "application/octet-stream", EncryptionContextDigest: bytesOf(32, 4), ExpiresAt: now.Add(5 * time.Minute)})
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	bundle, err := service.Commit(context.Background(), recordingobjects.CommitInput{Authority: testAuthority(), AllocationID: allocation.AllocationID, UploadToken: allocation.UploadToken, ManifestDigest: bytesOf(32, 5), MonotonicEndMillis: 10, MediaEndMillis: 10})
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if bundle.ObjectVersion != "version" || bundle.ObjectETag != "etag" || !strings.EqualFold(string(bundle.ObjectChecksumSHA256), string(checksum)) || repository.commitCalls != 1 {
		t.Fatalf("committed bundle = %#v, calls = %d", bundle, repository.commitCalls)
	}
}

func TestCommitRejectsStaleAuthorityAndFactMismatch(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	checksum := bytesOf(32, 3)
	store := &storeStub{uploadURL: objectstorage.SignedURL{Method: "PUT", URL: "https://storage.test/upload"}, facts: objectstorage.ObjectFacts{Object: objectstorage.Object{ETag: "etag", VersionID: "version", ContentType: "application/octet-stream", Size: 128, ChecksumSHA256: base64.StdEncoding.EncodeToString(bytesOf(32, 9))}}}
	repository := &repositoryStub{}
	service, err := recordingobjects.NewService(objectstorage.NewService(store), repository, recordingobjects.Config{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	allocation, err := service.Allocate(context.Background(), recordingobjects.AllocateInput{Authority: testAuthority(), SequenceNumber: 1, Codec: "opus", MonotonicEndMillis: 10, MediaEndMillis: 10, ExpectedByteSize: 128, ExpectedChecksumSHA256: checksum, ContentType: "application/octet-stream", EncryptionContextDigest: bytesOf(32, 4), ExpiresAt: now.Add(5 * time.Minute)})
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	mutated := testAuthority()
	mutated.CaptureEpoch++
	if _, err := service.Commit(context.Background(), recordingobjects.CommitInput{Authority: mutated, AllocationID: allocation.AllocationID, UploadToken: allocation.UploadToken, ManifestDigest: bytesOf(32, 5), MonotonicEndMillis: 1, MediaEndMillis: 1}); !errors.Is(err, recordingobjects.ErrAuthorityMismatch) {
		t.Fatalf("stale authority error = %v, want mismatch", err)
	}
	if _, err := service.Commit(context.Background(), recordingobjects.CommitInput{Authority: testAuthority(), AllocationID: allocation.AllocationID, UploadToken: allocation.UploadToken, ManifestDigest: bytesOf(32, 5), MonotonicEndMillis: 9, MediaEndMillis: 10}); !errors.Is(err, recordingobjects.ErrAuthorityMismatch) {
		t.Fatalf("timeline mismatch error = %v, want mismatch", err)
	}
	if _, err := service.Commit(context.Background(), recordingobjects.CommitInput{Authority: testAuthority(), AllocationID: allocation.AllocationID, UploadToken: allocation.UploadToken, ManifestDigest: bytesOf(32, 5), MonotonicEndMillis: 10, MediaEndMillis: 10}); !errors.Is(err, recordingobjects.ErrObjectFactsMismatch) {
		t.Fatalf("fact mismatch error = %v, want mismatch", err)
	}
}

func TestReserveAssignsSequenceAndFinalizeBindsFacts(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	checksum := bytesOf(32, 3)
	store := &storeStub{uploadURL: objectstorage.SignedURL{Method: "PUT", URL: "https://storage.test/upload"}}
	repository := &repositoryStub{}
	service, err := recordingobjects.NewService(objectstorage.NewService(store), repository, recordingobjects.Config{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	reserveInput := recordingobjects.ReserveInput{Authority: testAuthority(), ReservationRequestID: "00000000-0000-4000-8000-000000000007", EncryptionContextDigest: bytesOf(32, 4)}
	reserved, err := service.Reserve(context.Background(), reserveInput)
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	replayed, err := service.Reserve(context.Background(), reserveInput)
	if err != nil {
		t.Fatalf("replay reserve: %v", err)
	}
	if reserved.SequenceNumber != 4 || reserved.AllocationVersion != 1 || replayed.ID != reserved.ID {
		t.Fatalf("reservation = %#v replay = %#v", reserved, replayed)
	}
	result, err := service.Finalize(context.Background(), recordingobjects.FinalizeInput{Authority: testAuthority(), AllocationID: reserved.ID, ExpectedByteSize: 128, ExpectedChecksumSHA256: checksum, ContentType: "application/octet-stream", ExpiresAt: now.Add(5 * time.Minute), Codec: "opus", MonotonicEndMillis: 10, MediaEndMillis: 10})
	if err != nil {
		t.Fatalf("finalize: %v", err)
	}
	if result.UploadToken == "" || repository.allocation.State != "allocated" || len(repository.allocation.TokenHash) != 32 || store.uploadInput.ContentLength != 128 {
		t.Fatalf("finalized allocation = %#v upload = %#v", repository.allocation, store.uploadInput)
	}
	if _, err := service.Finalize(context.Background(), recordingobjects.FinalizeInput{Authority: testAuthority(), AllocationID: reserved.ID, ExpectedByteSize: 128, ExpectedChecksumSHA256: checksum, ContentType: "application/octet-stream", ExpiresAt: now.Add(5 * time.Minute), Codec: "opus", MonotonicEndMillis: 10, MediaEndMillis: 10}); err != nil {
		t.Fatalf("replay finalize: %v", err)
	}
}

type storeStub struct {
	uploadURL   objectstorage.SignedURL
	uploadInput objectstorage.CreateUploadURLInput
	facts       objectstorage.ObjectFacts
}

func (s *storeStub) PutObject(context.Context, objectstorage.PutObjectInput) (objectstorage.Object, error) {
	return objectstorage.Object{}, nil
}
func (s *storeStub) GetObject(context.Context, string) (objectstorage.ObjectReader, error) {
	return objectstorage.ObjectReader{}, nil
}
func (s *storeStub) InspectObject(context.Context, string) (objectstorage.ObjectFacts, error) {
	return s.facts, nil
}
func (s *storeStub) DeleteObject(context.Context, string) error { return nil }
func (s *storeStub) CreateUploadURL(_ context.Context, input objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error) {
	s.uploadInput = input
	return s.uploadURL, nil
}
func (s *storeStub) CreateDownloadURL(context.Context, objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error) {
	return objectstorage.SignedURL{}, nil
}
func (s *storeStub) CreateDeleteURL(context.Context, objectstorage.CreateDeleteURLInput) (objectstorage.SignedURL, error) {
	return objectstorage.SignedURL{}, nil
}

type repositoryStub struct {
	allocation  recordingobjects.Allocation
	commitCalls int
}

func (r *repositoryStub) Authorize(context.Context, recordingobjects.Authority) error { return nil }

func (r *repositoryStub) ReserveAllocation(_ context.Context, input recordingobjects.ReserveInput) (recordingobjects.Allocation, error) {
	if r.allocation.ID != "" {
		return recordingobjects.Allocation{}, recordingobjects.ErrAllocationConflict
	}
	r.allocation = recordingobjects.Allocation{ID: "00000000-0000-4000-8000-000000000006", ReservationRequestID: input.ReservationRequestID, AllocationVersion: 1, Authority: input.Authority, SequenceNumber: 4, ObjectKey: "recordings/00000000-0000-4000-8000-000000000003/capture/3/bundles/4/00000000-0000-4000-8000-000000000006.bundle", EncryptionContextDigest: input.EncryptionContextDigest, State: "reserved"}
	return r.allocation, nil
}
func (r *repositoryStub) GetAllocationByReservationRequest(_ context.Context, requestID string) (recordingobjects.Allocation, error) {
	if r.allocation.ReservationRequestID != requestID {
		return recordingobjects.Allocation{}, recordingobjects.ErrAllocationNotFound
	}
	return r.allocation, nil
}
func (r *repositoryStub) FinalizeAllocation(_ context.Context, allocation recordingobjects.Allocation) error {
	r.allocation = allocation
	return nil
}
func (r *repositoryStub) GetAllocation(context.Context, string) (recordingobjects.Allocation, error) {
	return r.allocation, nil
}
func (r *repositoryStub) GetAllocationByTokenHash(_ context.Context, tokenHash []byte) (recordingobjects.Allocation, error) {
	if len(r.allocation.TokenHash) == 0 || string(r.allocation.TokenHash) != string(tokenHash) {
		return recordingobjects.Allocation{}, recordingobjects.ErrAllocationNotFound
	}
	return r.allocation, nil
}
func (r *repositoryStub) CreateAllocation(_ context.Context, allocation recordingobjects.Allocation) error {
	r.allocation = allocation
	return nil
}
func (r *repositoryStub) CommitAllocation(_ context.Context, allocation recordingobjects.Allocation, facts objectstorage.ObjectFacts, manifestDigest []byte, committedAt time.Time) (recordingobjects.Bundle, error) {
	r.commitCalls++
	return recordingobjects.Bundle{Allocation: allocation, ManifestDigest: manifestDigest, ObjectVersion: facts.VersionID, ObjectETag: facts.ETag, ObjectChecksumSHA256: bytesOf(32, 3), CommittedAt: committedAt}, nil
}

func testAuthority() recordingobjects.Authority {
	return recordingobjects.Authority{TenantID: "00000000-0000-4000-8000-000000000001", EpisodeID: "00000000-0000-4000-8000-000000000002", RecordingID: "00000000-0000-4000-8000-000000000003", JobID: "00000000-0000-4000-8000-000000000004", ObjectHandle: "00000000-0000-4000-8000-000000000005", AttemptCount: 1, FencingGeneration: 2, CaptureEpoch: 3, EnvelopeDigest: bytesOf(32, 1), LeaseToken: "lease-token", LeaseOwner: "recorder-1", LeaseExpiresAt: time.Unix(200, 0).UTC()}
}

func bytesOf(length int, value byte) []byte {
	bytes := make([]byte, length)
	for index := range bytes {
		bytes[index] = value
	}
	return bytes
}
