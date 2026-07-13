package objectstorage_test

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

func TestServicePutObject(t *testing.T) {
	store := &storeStub{
		object: objectstorage.Object{
			Key:         "tenants/tenant_123/images/avatar.png",
			ETag:        "etag",
			ContentType: "image/png",
			Size:        4,
		},
	}
	service := objectstorage.NewService(store)

	object, err := service.PutObject(context.Background(), objectstorage.PutObjectInput{
		Key:           " tenants/tenant_123/images/avatar.png ",
		Body:          strings.NewReader("data"),
		ContentType:   " image/png ",
		ContentLength: 4,
		Metadata: map[string]string{
			"tenant_id": "tenant_123",
		},
	})
	if err != nil {
		t.Fatalf("put object: %v", err)
	}

	if object.Key != "tenants/tenant_123/images/avatar.png" {
		t.Fatalf("key = %q, want canonical key", object.Key)
	}
	if store.putInput.Key != "tenants/tenant_123/images/avatar.png" {
		t.Fatalf("stored key = %q, want canonical key", store.putInput.Key)
	}
	if store.putInput.ContentType != "image/png" {
		t.Fatalf("content type = %q, want image/png", store.putInput.ContentType)
	}
}

func TestServiceCreateUploadURL(t *testing.T) {
	expiresIn := 15 * time.Minute
	store := &storeStub{
		signedURL: objectstorage.SignedURL{URL: "https://storage.test/upload", Method: "PUT"},
	}
	service := objectstorage.NewService(store)

	url, err := service.CreateUploadURL(context.Background(), objectstorage.CreateUploadURLInput{
		Key:         " tenants/tenant_123/files/report.pdf ",
		ContentType: " application/pdf ",
		ExpiresIn:   expiresIn,
	})
	if err != nil {
		t.Fatalf("create upload url: %v", err)
	}

	if url.URL != "https://storage.test/upload" {
		t.Fatalf("url = %q, want upload url", url.URL)
	}
	if store.uploadInput.Key != "tenants/tenant_123/files/report.pdf" {
		t.Fatalf("key = %q, want canonical key", store.uploadInput.Key)
	}
	if store.uploadInput.ExpiresIn != expiresIn {
		t.Fatalf("expires in = %s, want %s", store.uploadInput.ExpiresIn, expiresIn)
	}
}

func TestServiceCreateUploadURLPreservesImmutableUploadConstraints(t *testing.T) {
	store := &storeStub{signedURL: objectstorage.SignedURL{URL: "https://storage.test/upload", Method: "PUT"}}
	service := objectstorage.NewService(store)

	_, err := service.CreateUploadURL(context.Background(), objectstorage.CreateUploadURLInput{
		Key:           "tenants/tenant_123/recordings/bundles/random-key",
		ContentType:   "application/octet-stream",
		ContentLength: 4096,
		ExpiresIn:     time.Minute,
		IfNoneMatch:   true,
		Metadata:      map[string]string{"checksum": "sha256:value", "attempt": "2"},
	})
	if err != nil {
		t.Fatalf("create upload url: %v", err)
	}
	if store.uploadInput.ContentLength != 4096 || !store.uploadInput.IfNoneMatch {
		t.Fatalf("upload constraints = %#v", store.uploadInput)
	}
	if store.uploadInput.Metadata["attempt"] != "2" {
		t.Fatalf("metadata = %#v", store.uploadInput.Metadata)
	}
}

func TestServiceCreateDownloadURL(t *testing.T) {
	expiresIn := 15 * time.Minute
	store := &storeStub{
		signedURL: objectstorage.SignedURL{URL: "https://storage.test/download", Method: "GET"},
	}
	service := objectstorage.NewService(store)

	url, err := service.CreateDownloadURL(context.Background(), objectstorage.CreateDownloadURLInput{
		Key:       " tenants/tenant_123/videos/recording.mp4 ",
		ExpiresIn: expiresIn,
	})
	if err != nil {
		t.Fatalf("create download url: %v", err)
	}

	if url.URL != "https://storage.test/download" {
		t.Fatalf("url = %q, want download url", url.URL)
	}
	if store.downloadInput.Key != "tenants/tenant_123/videos/recording.mp4" {
		t.Fatalf("key = %q, want canonical key", store.downloadInput.Key)
	}
}

func TestServiceInspectObject(t *testing.T) {
	store := &storeStub{facts: objectstorage.ObjectFacts{Object: objectstorage.Object{Key: "tenants/tenant_123/files/report.pdf", Size: 42}}}
	service := objectstorage.NewService(store)

	facts, err := service.InspectObject(context.Background(), " tenants/tenant_123/files/report.pdf ")
	if err != nil {
		t.Fatalf("inspect object: %v", err)
	}
	if store.inspectKey != "tenants/tenant_123/files/report.pdf" || facts.Size != 42 {
		t.Fatalf("inspect key = %q, facts = %#v", store.inspectKey, facts)
	}
}

func TestServiceCreateDeleteURL(t *testing.T) {
	expiresIn := 5 * time.Minute
	store := &storeStub{signedURL: objectstorage.SignedURL{URL: "https://storage.test/delete", Method: "DELETE"}}
	service := objectstorage.NewService(store)

	url, err := service.CreateDeleteURL(context.Background(), objectstorage.CreateDeleteURLInput{Key: " tenants/tenant_123/transcripts/document.json ", ExpiresIn: expiresIn})
	if err != nil {
		t.Fatalf("create delete url: %v", err)
	}
	if url.Method != "DELETE" || store.deleteURLInput.Key != "tenants/tenant_123/transcripts/document.json" || store.deleteURLInput.ExpiresIn != expiresIn {
		t.Fatalf("delete authority = %#v, input = %#v", url, store.deleteURLInput)
	}
}

func TestServiceRejectsInvalidInput(t *testing.T) {
	validPut := objectstorage.PutObjectInput{
		Key:           "tenants/tenant_123/images/avatar.png",
		Body:          strings.NewReader("data"),
		ContentType:   "image/png",
		ContentLength: 4,
	}

	tests := []struct {
		name string
		run  func(objectstorage.Service) error
		want error
	}{
		{
			name: "missing store",
			run: func(service objectstorage.Service) error {
				_, err := objectstorage.NewService(nil).PutObject(context.Background(), validPut)
				return err
			},
			want: objectstorage.ErrStoreUnavailable,
		},
		{
			name: "bad key",
			run: func(service objectstorage.Service) error {
				input := validPut
				input.Key = "../avatar.png"
				_, err := service.PutObject(context.Background(), input)
				return err
			},
			want: objectstorage.ErrInvalidObjectKey,
		},
		{
			name: "bad content type",
			run: func(service objectstorage.Service) error {
				input := validPut
				input.ContentType = "image"
				_, err := service.PutObject(context.Background(), input)
				return err
			},
			want: objectstorage.ErrInvalidContentType,
		},
		{
			name: "missing body",
			run: func(service objectstorage.Service) error {
				input := validPut
				input.Body = nil
				_, err := service.PutObject(context.Background(), input)
				return err
			},
			want: objectstorage.ErrInvalidObjectBody,
		},
		{
			name: "bad upload expiration",
			run: func(service objectstorage.Service) error {
				_, err := service.CreateUploadURL(context.Background(), objectstorage.CreateUploadURLInput{
					Key:         "tenants/tenant_123/files/report.pdf",
					ContentType: "application/pdf",
				})
				return err
			},
			want: objectstorage.ErrInvalidURLExpiration,
		},
		{
			name: "conditional upload without exact size",
			run: func(service objectstorage.Service) error {
				_, err := service.CreateUploadURL(context.Background(), objectstorage.CreateUploadURLInput{
					Key: "tenants/tenant_123/files/report.pdf", ContentType: "application/pdf", ExpiresIn: time.Minute, IfNoneMatch: true,
				})
				return err
			},
			want: objectstorage.ErrInvalidObjectSize,
		},
		{
			name: "unsafe metadata",
			run: func(service objectstorage.Service) error {
				input := validPut
				input.Metadata = map[string]string{"Invalid Key": "value"}
				_, err := service.PutObject(context.Background(), input)
				return err
			},
			want: objectstorage.ErrInvalidMetadata,
		},
	}

	service := objectstorage.NewService(&storeStub{})
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.run(service)
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
		})
	}
}

type storeStub struct {
	putInput       objectstorage.PutObjectInput
	uploadInput    objectstorage.CreateUploadURLInput
	downloadInput  objectstorage.CreateDownloadURLInput
	deleteURLInput objectstorage.CreateDeleteURLInput
	object         objectstorage.Object
	reader         objectstorage.ObjectReader
	facts          objectstorage.ObjectFacts
	inspectKey     string
	signedURL      objectstorage.SignedURL
	err            error
}

func (s *storeStub) PutObject(_ context.Context, input objectstorage.PutObjectInput) (objectstorage.Object, error) {
	s.putInput = input
	return s.object, s.err
}

func (s *storeStub) GetObject(context.Context, string) (objectstorage.ObjectReader, error) {
	if s.reader.Body == nil {
		s.reader.Body = io.NopCloser(strings.NewReader(""))
	}
	return s.reader, s.err
}

func (s *storeStub) InspectObject(_ context.Context, key string) (objectstorage.ObjectFacts, error) {
	s.inspectKey = key
	return s.facts, s.err
}

func (s *storeStub) DeleteObject(context.Context, string) error {
	return s.err
}

func (s *storeStub) CreateUploadURL(_ context.Context, input objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error) {
	s.uploadInput = input
	return s.signedURL, s.err
}

func (s *storeStub) CreateDownloadURL(_ context.Context, input objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error) {
	s.downloadInput = input
	return s.signedURL, s.err
}

func (s *storeStub) CreateDeleteURL(_ context.Context, input objectstorage.CreateDeleteURLInput) (objectstorage.SignedURL, error) {
	s.deleteURLInput = input
	return s.signedURL, s.err
}
