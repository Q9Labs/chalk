package whiteboardfiles

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestInitiatePreservesExactSignedHeaders(t *testing.T) {
	repository := &repositoryStub{}
	objects := &objectStoreStub{
		uploadURL: objectstorage.SignedURL{
			Method: "PUT", URL: "https://uploads.test/object",
			ExpiresAt: time.Date(2026, time.July, 29, 12, 10, 0, 0, time.UTC),
			SignedHeader: map[string][]string{
				"Content-Type":     {"image/png"},
				"Content-Length":   {"32"},
				"If-None-Match":    {"*"},
				"X-Amz-Meta-Chalk": {"value"},
			},
		},
	}
	service := NewService(repository, objects)
	service.now = func() time.Time { return time.Date(2026, time.July, 29, 12, 0, 0, 0, time.UTC) }

	result, err := service.Initiate(context.Background(), InitiateInput{
		Subject: testSubject(t), SceneID: mustID(t, "55555555-5555-4555-8555-555555555555"),
		FileID: "image-1", MIMEType: "image/png", ByteLength: 32,
		SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Method != "PUT" || result.URL != objects.uploadURL.URL {
		t.Fatalf("instructions = %#v", result)
	}
	if len(result.Headers) != len(objects.uploadURL.SignedHeader) || result.Headers["If-None-Match"] != "*" {
		t.Fatalf("headers = %#v", result.Headers)
	}
	if repository.reserved.Upload.FileID != "image-1" {
		t.Fatalf("reservation = %#v", repository.reserved)
	}
	if objects.uploadInput.Metadata["chalk-sha256"] == "" || !objects.uploadInput.IfNoneMatch {
		t.Fatalf("upload input = %#v", objects.uploadInput)
	}
}

func TestFinalizeVerifiesProviderFactsBeforeReady(t *testing.T) {
	uploadID := mustID(t, "66666666-6666-4666-8666-666666666666")
	upload := testUpload(t, uploadID)
	repository := &repositoryStub{claimed: upload}
	objects := &objectStoreStub{facts: objectstorage.ObjectFacts{
		Object: objectstorage.Object{
			Key: upload.ObjectKey, ETag: "immutable-etag", ContentType: upload.MIMEType, Size: upload.ByteLength,
		},
		Metadata: map[string]string{
			"chalk-upload-id": upload.UploadID.String(),
			"chalk-sha256":    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
	}}
	service := NewService(repository, objects)

	if err := service.Finalize(context.Background(), upload.Subject, uploadID); err != nil {
		t.Fatal(err)
	}
	if repository.completed.ImmutableObjectIdentity != "immutable-etag" {
		t.Fatalf("complete = %#v", repository.completed)
	}
	if repository.failed || objects.deletedKey != "" {
		t.Fatal("valid upload was failed or deleted")
	}
}

func TestFinalizeDeletesMismatchedImmutableUpload(t *testing.T) {
	uploadID := mustID(t, "66666666-6666-4666-8666-666666666666")
	upload := testUpload(t, uploadID)
	repository := &repositoryStub{claimed: upload}
	objects := &objectStoreStub{facts: objectstorage.ObjectFacts{
		Object: objectstorage.Object{Key: upload.ObjectKey, ETag: "etag", ContentType: upload.MIMEType, Size: upload.ByteLength + 1},
		Metadata: map[string]string{
			"chalk-upload-id": upload.UploadID.String(),
			"chalk-sha256":    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
	}}
	service := NewService(repository, objects)

	err := service.Finalize(context.Background(), upload.Subject, uploadID)
	if !errors.Is(err, ErrFileTransferFailed) {
		t.Fatalf("error = %v", err)
	}
	if !repository.failed || objects.deletedKey != upload.ObjectKey {
		t.Fatalf("failed = %t, deleted = %q", repository.failed, objects.deletedKey)
	}
}

func TestDownloadUsesOnlyRepositoryAuthorizedReadyFile(t *testing.T) {
	upload := testUpload(t, mustID(t, "66666666-6666-4666-8666-666666666666"))
	repository := &repositoryStub{ready: upload}
	objects := &objectStoreStub{downloadURL: objectstorage.SignedURL{Method: "GET", URL: "https://downloads.test/object", ExpiresAt: time.Now().Add(time.Minute)}}
	service := NewService(repository, objects)

	result, err := service.Download(context.Background(), upload.Subject, upload.FileID)
	if err != nil {
		t.Fatal(err)
	}
	if result.URL != objects.downloadURL.URL || objects.downloadKey != upload.ObjectKey {
		t.Fatalf("download = %#v, key = %q", result, objects.downloadKey)
	}
}

type repositoryStub struct {
	reserved  ReserveInput
	claimed   Upload
	ready     Upload
	completed CompleteInput
	failed    bool
	err       error
}

func (r *repositoryStub) Reserve(_ context.Context, input ReserveInput) error {
	r.reserved = input
	return r.err
}

func (r *repositoryStub) Fail(context.Context, utilities.ID) error {
	r.failed = true
	return r.err
}

func (r *repositoryStub) ClaimFinalize(context.Context, Subject, utilities.ID, time.Time) (Upload, error) {
	return r.claimed, r.err
}

func (r *repositoryStub) Complete(_ context.Context, input CompleteInput) error {
	r.completed = input
	return r.err
}

func (r *repositoryStub) ReadyFile(context.Context, Subject, string) (Upload, error) {
	return r.ready, r.err
}

type objectStoreStub struct {
	uploadURL   objectstorage.SignedURL
	downloadURL objectstorage.SignedURL
	facts       objectstorage.ObjectFacts
	uploadInput objectstorage.CreateUploadURLInput
	downloadKey string
	deletedKey  string
	err         error
}

func (s *objectStoreStub) InspectObject(context.Context, string) (objectstorage.ObjectFacts, error) {
	return s.facts, s.err
}

func (s *objectStoreStub) DeleteObject(_ context.Context, key string) error {
	s.deletedKey = key
	return s.err
}

func (s *objectStoreStub) CreateUploadURL(_ context.Context, input objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error) {
	s.uploadInput = input
	return s.uploadURL, s.err
}

func (s *objectStoreStub) CreateDownloadURL(_ context.Context, input objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error) {
	s.downloadKey = input.Key
	return s.downloadURL, s.err
}

func testSubject(t *testing.T) Subject {
	t.Helper()
	return Subject{
		TenantID:              mustID(t, "11111111-1111-4111-8111-111111111111"),
		RoomID:                mustID(t, "22222222-2222-4222-8222-222222222222"),
		SessionID:             mustID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantSessionID:  mustID(t, "44444444-4444-4444-8444-444444444444"),
		ParticipantGeneration: 1,
	}
}

func testUpload(t *testing.T, uploadID utilities.ID) Upload {
	t.Helper()
	var digest [32]byte
	for index := range digest {
		digest[index] = 0xaa
	}
	subject := testSubject(t)
	sceneID := mustID(t, "55555555-5555-4555-8555-555555555555")
	return Upload{
		UploadID: uploadID, Subject: subject, SceneID: sceneID,
		FileID: "image-1", ObjectKey: objectKey(subject, sceneID, uploadID),
		MIMEType: "image/png", ByteLength: 32, SHA256: digest,
		ExpiresAt: time.Now().Add(time.Minute),
	}
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
