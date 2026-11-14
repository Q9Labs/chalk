package chatattachments

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type fakeRepository struct {
	reserved  ReserveInput
	upload    Upload
	completed []CompleteInput
	failed    int
	released  int
}

func (r *fakeRepository) Reserve(_ context.Context, input ReserveInput) (Upload, error) {
	r.reserved = input
	return input.Upload, nil
}

func (r *fakeRepository) ClaimFinalize(context.Context, Subject, utilities.ID, time.Time, time.Time) (Upload, error) {
	return r.upload, nil
}

func (r *fakeRepository) Complete(_ context.Context, input CompleteInput) error {
	r.completed = append(r.completed, input)
	return nil
}

func (r *fakeRepository) Fail(context.Context, utilities.ID, utilities.ID) error {
	r.failed++
	return nil
}

func (r *fakeRepository) ReleaseFinalize(context.Context, utilities.ID, utilities.ID) error {
	r.released++
	return nil
}

func (r *fakeRepository) AuthorizedDownload(context.Context, Subject, utilities.ID) (Upload, error) {
	return r.upload, nil
}

type fakeObjects struct {
	facts      objectstorage.ObjectFacts
	body       []byte
	inspectErr error
	deleted    []string
	download   objectstorage.CreateDownloadURLInput
}

func (o *fakeObjects) GetObject(context.Context, string) (objectstorage.ObjectReader, error) {
	return objectstorage.ObjectReader{Body: io.NopCloser(bytes.NewReader(o.body))}, nil
}

func (o *fakeObjects) InspectObject(context.Context, string) (objectstorage.ObjectFacts, error) {
	return o.facts, o.inspectErr
}

func (o *fakeObjects) DeleteObject(_ context.Context, key string) error {
	o.deleted = append(o.deleted, key)
	return nil
}

func (o *fakeObjects) CreateUploadURL(context.Context, objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error) {
	return objectstorage.SignedURL{Method: "PUT", URL: "https://upload.example", SignedHeader: map[string][]string{"x-amz-meta": {"1"}}}, nil
}

func (o *fakeObjects) CreateDownloadURL(_ context.Context, input objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error) {
	o.download = input
	return objectstorage.SignedURL{URL: "https://download.example"}, nil
}

func newID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func subject(t *testing.T) Subject {
	t.Helper()
	return Subject{TenantID: newID(t), SpaceID: newID(t), EpisodeID: newID(t), ParticipantID: newID(t), ParticipantGeneration: 1}
}

func digestOf(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

func validInput(t *testing.T, content []byte) InitiateInput {
	return InitiateInput{
		Subject: subject(t), ClientAttachmentID: strings.Repeat("a", 16), FileName: "notes.pdf",
		MIMEType: "Application/PDF; charset=binary", ByteLength: int64(len(content)), SHA256: digestOf(content),
	}
}

func TestInitiateNormalizesTheRequestAndSignsAnUpload(t *testing.T) {
	repository, objects := &fakeRepository{}, &fakeObjects{}
	content := []byte("hello")
	input := validInput(t, content)

	instructions, err := NewService(repository, objects).Initiate(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	reserved := repository.reserved.Upload
	if reserved.MIMEType != "application/pdf" || reserved.FileName != "notes.pdf" || reserved.Status != "pending" {
		t.Fatalf("reserved upload = %+v", reserved)
	}
	if !strings.Contains(reserved.ObjectKey, input.Subject.TenantID.String()) || instructions.Method != "PUT" || instructions.Headers["x-amz-meta"] != "1" {
		t.Fatalf("instructions = %+v, key = %q", instructions, reserved.ObjectKey)
	}
}

func TestInitiateRejectsInvalidRequests(t *testing.T) {
	service := NewService(&fakeRepository{}, &fakeObjects{})
	content := []byte("hello")
	mutations := map[string]func(*InitiateInput){
		"incomplete subject": func(i *InitiateInput) { i.Subject.ParticipantGeneration = 0 },
		"short client id":    func(i *InitiateInput) { i.ClientAttachmentID = "short" },
		"empty file":         func(i *InitiateInput) { i.ByteLength = 0 },
		"huge file":          func(i *InitiateInput) { i.ByteLength = maxFileBytes + 1 },
		"path in name":       func(i *InitiateInput) { i.FileName = "../notes.pdf" },
		"control in name":    func(i *InitiateInput) { i.FileName = "no\ttes.pdf" },
		"executable type":    func(i *InitiateInput) { i.MIMEType = "application/x-msdownload" },
		"bad media type":     func(i *InitiateInput) { i.MIMEType = "not a type" },
		"upper-case digest":  func(i *InitiateInput) { i.SHA256 = strings.ToUpper(i.SHA256) },
		"short digest":       func(i *InitiateInput) { i.SHA256 = "abcd" },
	}
	for name, mutate := range mutations {
		input := validInput(t, content)
		mutate(&input)
		if _, err := service.Initiate(context.Background(), input); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("%s: error = %v, want ErrInvalidInput", name, err)
		}
	}
}

func readyUpload(t *testing.T, content []byte, status string) Upload {
	sum := sha256.Sum256(content)
	return Upload{
		Attachment: Attachment{AttachmentID: newID(t), FileName: "a.pdf", MIMEType: "application/pdf", ByteLength: int64(len(content))},
		UploadID:   newID(t), ObjectKey: "key", SHA256: sum, Status: status, FinalizeClaimToken: newID(t),
	}
}

func factsFor(upload Upload) objectstorage.ObjectFacts {
	return objectstorage.ObjectFacts{
		Object: objectstorage.Object{Size: upload.ByteLength, ContentType: upload.MIMEType, ETag: "etag"},
		Metadata: map[string]string{
			"chalk-upload-id": upload.UploadID.String(), "chalk-attachment-id": upload.AttachmentID.String(),
		},
	}
}

func TestFinalizeCompletesAMatchingObject(t *testing.T) {
	content := []byte("hello")
	upload := readyUpload(t, content, "pending")
	repository := &fakeRepository{upload: upload}
	objects := &fakeObjects{facts: factsFor(upload), body: content}

	attachment, err := NewService(repository, objects).Finalize(context.Background(), subject(t), upload.UploadID)
	if err != nil || attachment.AttachmentID != upload.AttachmentID {
		t.Fatalf("attachment = %+v, error = %v", attachment, err)
	}
	if len(repository.completed) != 1 || repository.completed[0].ImmutableObjectIdentity != "etag" {
		t.Fatalf("completed = %+v", repository.completed)
	}
}

func TestFinalizeRejectsAnObjectThatDiffersFromTheReservation(t *testing.T) {
	content := []byte("hello")
	upload := readyUpload(t, content, "pending")
	wrongMetadata := factsFor(upload)
	wrongMetadata.Metadata["chalk-upload-id"] = "other"
	wrongSize := factsFor(upload)
	wrongSize.Size++

	cases := map[string]*fakeObjects{
		"metadata": {facts: wrongMetadata, body: content},
		"size":     {facts: wrongSize, body: content},
		"content":  {facts: factsFor(upload), body: []byte("HELLO")},
		"longer":   {facts: factsFor(upload), body: []byte("hello!")},
	}
	for name, objects := range cases {
		repository := &fakeRepository{upload: upload}
		_, err := NewService(repository, objects).Finalize(context.Background(), subject(t), upload.UploadID)
		if !errors.Is(err, ErrFileTransferFailed) || repository.failed != 1 || len(objects.deleted) != 1 || len(repository.completed) != 0 {
			t.Errorf("%s: error = %v, failed = %d, deleted = %v", name, err, repository.failed, objects.deleted)
		}
	}
}

func TestFinalizeReleasesTheClaimWhenTheStoreFailsAndSkipsReadyUploads(t *testing.T) {
	content := []byte("hello")
	pending := readyUpload(t, content, "pending")
	repository := &fakeRepository{upload: pending}
	objects := &fakeObjects{inspectErr: objectstorage.ErrStoreUnavailable}
	if _, err := NewService(repository, objects).Finalize(context.Background(), subject(t), pending.UploadID); !errors.Is(err, objectstorage.ErrStoreUnavailable) || repository.released != 1 {
		t.Fatalf("error = %v, released = %d", err, repository.released)
	}

	ready := readyUpload(t, content, "ready")
	repository = &fakeRepository{upload: ready}
	objects = &fakeObjects{inspectErr: errors.New("must not be called")}
	if _, err := NewService(repository, objects).Finalize(context.Background(), subject(t), ready.UploadID); err != nil {
		t.Fatalf("a ready upload finalizes without touching storage: %v", err)
	}
}

func TestDownloadForcesAttachmentDispositionExceptForImages(t *testing.T) {
	upload := readyUpload(t, []byte("x"), "ready")
	objects := &fakeObjects{}
	service := NewService(&fakeRepository{upload: upload}, objects)

	if _, err := service.Download(context.Background(), subject(t), upload.AttachmentID); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(objects.download.ContentDisposition, "attachment") {
		t.Fatalf("a PDF must download as an attachment: %q", objects.download.ContentDisposition)
	}

	upload.MIMEType = "image/png"
	objects = &fakeObjects{}
	service = NewService(&fakeRepository{upload: upload}, objects)
	if _, err := service.Download(context.Background(), subject(t), upload.AttachmentID); err != nil || objects.download.ContentDisposition != "" {
		t.Fatalf("an image previews inline: %q, %v", objects.download.ContentDisposition, err)
	}
}

func TestRequestResultMapsErrorsToBoundedReasons(t *testing.T) {
	cases := []struct {
		err             error
		outcome, reason string
	}{
		{nil, "succeeded", "none"},
		{ErrQuotaExceeded, "rejected", "quota_exceeded"},
		{errors.Join(errors.New("wrapped"), ErrUploadNotReady), "rejected", "upload_in_progress"},
		{objectstorage.ErrStoreUnavailable, "failed", "storage_unavailable"},
		{context.DeadlineExceeded, "failed", "request_deadline"},
		{errors.New("boom"), "failed", "internal_error"},
	}
	for _, test := range cases {
		if outcome, reason := requestResult(test.err); outcome != test.outcome || reason != test.reason {
			t.Errorf("requestResult(%v) = %s/%s, want %s/%s", test.err, outcome, reason, test.outcome, test.reason)
		}
	}
}
