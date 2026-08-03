package chatattachments

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestInitiateReturnsEveryBrowserSettableSignedHeader(t *testing.T) {
	repository := &chatAttachmentRepositoryStub{}
	objects := &chatAttachmentObjectStoreStub{
		uploadURL: objectstorage.SignedURL{
			Method: http.MethodPut,
			URL:    "https://uploads.test/object",
			ExpiresAt: time.Date(
				2026,
				time.July,
				30,
				12,
				10,
				0,
				0,
				time.UTC,
			),
			SignedHeader: map[string][]string{
				"Content-Type":                        {"image/png"},
				"If-None-Match":                       {"*"},
				"X-Amz-Meta-Chalk-Attachment-Id":      {"attachment"},
				"X-Amz-Meta-Chalk-Upload-Id":          {"upload"},
				"X-Amz-Checksum-Sha256-Test-Only":     {"checksum"},
				"X-Amz-Additional-Signed-Test-Header": {"value"},
			},
		},
	}
	service := NewService(repository, objects)
	service.now = func() time.Time {
		return time.Date(2026, time.July, 30, 12, 0, 0, 0, time.UTC)
	}
	content := []byte("chalk")
	digest := sha256.Sum256(content)

	result, err := service.Initiate(context.Background(), InitiateInput{
		Subject:            chatAttachmentTestSubject(t),
		ClientAttachmentID: "chat-file-client-0001",
		FileName:           "diagram.png",
		MIMEType:           "image/png",
		ByteLength:         int64(len(content)),
		SHA256:             hex.EncodeToString(digest[:]),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Method != http.MethodPut || result.URL != objects.uploadURL.URL {
		t.Fatalf("instructions = %#v", result)
	}
	if len(result.Headers) != len(objects.uploadURL.SignedHeader) {
		t.Fatalf("headers = %#v", result.Headers)
	}
	for name, values := range objects.uploadURL.SignedHeader {
		if result.Headers[name] != values[0] {
			t.Fatalf("header %q = %q, want %q", name, result.Headers[name], values[0])
		}
	}
	if repository.reserved.Upload.AttachmentID.IsZero() ||
		repository.reserved.Upload.UploadID.IsZero() {
		t.Fatalf("reservation IDs = %#v", repository.reserved.Upload)
	}
	if objects.uploadInput.ChecksumSHA256 != base64.StdEncoding.EncodeToString(digest[:]) ||
		!objects.uploadInput.IfNoneMatch {
		t.Fatalf("upload input = %#v", objects.uploadInput)
	}
	if objects.uploadInput.Metadata["chalk-upload-id"] == "" ||
		objects.uploadInput.Metadata["chalk-attachment-id"] == "" {
		t.Fatalf("upload metadata = %#v", objects.uploadInput.Metadata)
	}
}

func TestFinalizeHashesObjectBeforeMakingAttachmentReady(t *testing.T) {
	content := []byte("verified chat attachment")
	digest := sha256.Sum256(content)
	upload := chatAttachmentTestUpload(t, digest, int64(len(content)), "image/png")
	repository := &chatAttachmentRepositoryStub{claimed: upload}
	objects := &chatAttachmentObjectStoreStub{
		body: content,
		facts: objectstorage.ObjectFacts{
			Object: objectstorage.Object{
				Key: upload.ObjectKey, ETag: "immutable-etag",
				ContentType: upload.MIMEType, Size: upload.ByteLength,
			},
			Metadata: map[string]string{
				"chalk-upload-id":     upload.UploadID.String(),
				"chalk-attachment-id": upload.AttachmentID.String(),
			},
		},
	}
	service := NewService(repository, objects)

	attachment, err := service.Finalize(
		context.Background(),
		chatAttachmentTestSubject(t),
		upload.UploadID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if attachment != upload.Attachment {
		t.Fatalf("attachment = %#v, want %#v", attachment, upload.Attachment)
	}
	if repository.completed.ImmutableObjectIdentity != "immutable-etag" {
		t.Fatalf("completion = %#v", repository.completed)
	}
	if repository.completed.FinalizeClaimToken != upload.FinalizeClaimToken ||
		repository.completed.Now.IsZero() {
		t.Fatalf("completion fence = %#v, upload = %#v", repository.completed, upload)
	}
	if repository.claimLeaseUntil.Sub(repository.claimNow) != finalizeLeaseDuration {
		t.Fatalf(
			"finalize lease = %s, want %s",
			repository.claimLeaseUntil.Sub(repository.claimNow),
			finalizeLeaseDuration,
		)
	}
	if repository.failed || objects.deletedKey != "" {
		t.Fatal("valid upload was failed or deleted")
	}
}

func TestFinalizeDeletesAndFailsHashMismatch(t *testing.T) {
	content := []byte("tampered")
	expected := sha256.Sum256([]byte("expected"))
	upload := chatAttachmentTestUpload(t, expected, int64(len(content)), "image/png")
	repository := &chatAttachmentRepositoryStub{claimed: upload}
	objects := &chatAttachmentObjectStoreStub{
		body: content,
		facts: objectstorage.ObjectFacts{
			Object: objectstorage.Object{
				Key: upload.ObjectKey, ETag: "immutable-etag",
				ContentType: upload.MIMEType, Size: upload.ByteLength,
			},
			Metadata: map[string]string{
				"chalk-upload-id":     upload.UploadID.String(),
				"chalk-attachment-id": upload.AttachmentID.String(),
			},
		},
	}
	service := NewService(repository, objects)

	_, err := service.Finalize(
		context.Background(),
		chatAttachmentTestSubject(t),
		upload.UploadID,
	)
	if !errors.Is(err, ErrFileTransferFailed) {
		t.Fatalf("error = %v", err)
	}
	if !repository.failed || objects.deletedKey != upload.ObjectKey {
		t.Fatalf("failed = %t, deleted = %q", repository.failed, objects.deletedKey)
	}
}

func TestFinalizeReleasesTransientInspectionFailureAndCanRetry(t *testing.T) {
	content := []byte("retryable chat attachment")
	digest := sha256.Sum256(content)
	upload := chatAttachmentTestUpload(t, digest, int64(len(content)), "image/png")
	repository := &chatAttachmentRepositoryStub{claimed: upload}
	objects := &chatAttachmentObjectStoreStub{
		body: content,
		facts: objectstorage.ObjectFacts{
			Object: objectstorage.Object{
				Key: upload.ObjectKey, ETag: "immutable-etag",
				ContentType: upload.MIMEType, Size: upload.ByteLength,
			},
			Metadata: map[string]string{
				"chalk-upload-id":     upload.UploadID.String(),
				"chalk-attachment-id": upload.AttachmentID.String(),
			},
		},
		err: context.Canceled,
	}
	service := NewService(repository, objects)
	canceled, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := service.Finalize(
		canceled,
		chatAttachmentTestSubject(t),
		upload.UploadID,
	); !errors.Is(err, context.Canceled) {
		t.Fatalf("first finalize error = %v", err)
	}
	if repository.releaseCount != 1 ||
		repository.releasedUploadID != upload.UploadID ||
		repository.releasedClaimToken != upload.FinalizeClaimToken ||
		repository.releaseContextErr != nil {
		t.Fatalf("release = %#v", repository)
	}
	if repository.failed {
		t.Fatal("transient inspection failure terminalized the upload")
	}

	objects.err = nil
	attachment, err := service.Finalize(
		context.Background(),
		chatAttachmentTestSubject(t),
		upload.UploadID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if attachment != upload.Attachment || repository.completed.UploadID != upload.UploadID {
		t.Fatalf("retry attachment = %#v, repository = %#v", attachment, repository)
	}
}

func TestDownloadForcesOfficeFilesToAttachment(t *testing.T) {
	digest := sha256.Sum256([]byte("document"))
	upload := chatAttachmentTestUpload(
		t,
		digest,
		8,
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	)
	upload.FileName = "agenda 2026.docx"
	repository := &chatAttachmentRepositoryStub{download: upload}
	objects := &chatAttachmentObjectStoreStub{
		downloadURL: objectstorage.SignedURL{
			Method: http.MethodGet,
			URL:    "https://downloads.test/object",
		},
	}
	service := NewService(repository, objects)

	result, err := service.Download(
		context.Background(),
		chatAttachmentTestSubject(t),
		upload.AttachmentID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.URL != objects.downloadURL.URL {
		t.Fatalf("download = %#v", result)
	}
	if !strings.HasPrefix(objects.downloadInput.ContentDisposition, "attachment;") ||
		!strings.Contains(objects.downloadInput.ContentDisposition, "agenda") {
		t.Fatalf("content disposition = %q", objects.downloadInput.ContentDisposition)
	}
}

type chatAttachmentRepositoryStub struct {
	reserved           ReserveInput
	claimed            Upload
	download           Upload
	completed          CompleteInput
	failed             bool
	err                error
	claimNow           time.Time
	claimLeaseUntil    time.Time
	releaseCount       int
	releasedUploadID   utilities.ID
	releasedClaimToken utilities.ID
	releaseContextErr  error
}

func (r *chatAttachmentRepositoryStub) Reserve(
	_ context.Context,
	input ReserveInput,
) (Upload, error) {
	r.reserved = input
	return input.Upload, r.err
}

func (r *chatAttachmentRepositoryStub) ClaimFinalize(
	_ context.Context,
	_ Subject,
	_ utilities.ID,
	now time.Time,
	leaseUntil time.Time,
) (Upload, error) {
	r.claimNow = now
	r.claimLeaseUntil = leaseUntil
	return r.claimed, r.err
}

func (r *chatAttachmentRepositoryStub) Complete(
	_ context.Context,
	input CompleteInput,
) error {
	r.completed = input
	return r.err
}

func (r *chatAttachmentRepositoryStub) Fail(
	context.Context,
	utilities.ID,
	utilities.ID,
) error {
	r.failed = true
	return r.err
}

func (r *chatAttachmentRepositoryStub) ReleaseFinalize(
	ctx context.Context,
	uploadID utilities.ID,
	finalizeClaimToken utilities.ID,
) error {
	r.releaseCount++
	r.releasedUploadID = uploadID
	r.releasedClaimToken = finalizeClaimToken
	r.releaseContextErr = ctx.Err()
	return r.err
}

func (r *chatAttachmentRepositoryStub) AuthorizedDownload(
	context.Context,
	Subject,
	utilities.ID,
) (Upload, error) {
	return r.download, r.err
}

type chatAttachmentObjectStoreStub struct {
	body          []byte
	facts         objectstorage.ObjectFacts
	uploadURL     objectstorage.SignedURL
	downloadURL   objectstorage.SignedURL
	uploadInput   objectstorage.CreateUploadURLInput
	downloadInput objectstorage.CreateDownloadURLInput
	deletedKey    string
	err           error
}

func (s *chatAttachmentObjectStoreStub) GetObject(
	context.Context,
	string,
) (objectstorage.ObjectReader, error) {
	return objectstorage.ObjectReader{
		Body: io.NopCloser(strings.NewReader(string(s.body))),
	}, s.err
}

func (s *chatAttachmentObjectStoreStub) InspectObject(
	context.Context,
	string,
) (objectstorage.ObjectFacts, error) {
	return s.facts, s.err
}

func (s *chatAttachmentObjectStoreStub) DeleteObject(_ context.Context, key string) error {
	s.deletedKey = key
	return s.err
}

func (s *chatAttachmentObjectStoreStub) CreateUploadURL(
	_ context.Context,
	input objectstorage.CreateUploadURLInput,
) (objectstorage.SignedURL, error) {
	s.uploadInput = input
	return s.uploadURL, s.err
}

func (s *chatAttachmentObjectStoreStub) CreateDownloadURL(
	_ context.Context,
	input objectstorage.CreateDownloadURLInput,
) (objectstorage.SignedURL, error) {
	s.downloadInput = input
	return s.downloadURL, s.err
}

func chatAttachmentTestSubject(t *testing.T) Subject {
	t.Helper()
	return Subject{
		TenantID:              chatAttachmentTestID(t, "11111111-1111-4111-8111-111111111111"),
		SpaceID:               chatAttachmentTestID(t, "22222222-2222-4222-8222-222222222222"),
		EpisodeID:             chatAttachmentTestID(t, "33333333-3333-4333-8333-333333333333"),
		ParticipantID:         chatAttachmentTestID(t, "44444444-4444-4444-8444-444444444444"),
		ParticipantGeneration: 1,
	}
}

func chatAttachmentTestUpload(
	t *testing.T,
	digest [32]byte,
	byteLength int64,
	mimeType string,
) Upload {
	t.Helper()
	return Upload{
		Attachment: Attachment{
			AttachmentID: chatAttachmentTestID(t, "55555555-5555-4555-8555-555555555555"),
			FileName:     "diagram.png",
			MIMEType:     mimeType,
			ByteLength:   byteLength,
		},
		UploadID:  chatAttachmentTestID(t, "66666666-6666-4666-8666-666666666666"),
		ObjectKey: "chat-attachments-v1/test-object",
		SHA256:    digest,
		Status:    "finalizing",
		ExpiresAt: time.Now().Add(time.Hour),
		FinalizeClaimToken: chatAttachmentTestID(
			t,
			"77777777-7777-4777-8777-777777777777",
		),
		FinalizeClaimedUntil: time.Now().Add(finalizeLeaseDuration),
	}
}

func chatAttachmentTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
