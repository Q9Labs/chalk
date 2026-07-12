package r2

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

func TestNewStoreRejectsMissingConfig(t *testing.T) {
	_, err := NewStore(config.R2Config{})
	if !errors.Is(err, ErrMissingConfig) {
		t.Fatalf("error = %v, want %v", err, ErrMissingConfig)
	}
}

func TestNewStoreAcceptsCustomEndpointWithoutAccountID(t *testing.T) {
	_, err := NewStore(config.R2Config{
		AccessKeyID:     "access-key",
		Bucket:          "chalk-media",
		Endpoint:        "https://storage.chalk.test",
		SecretAccessKey: "secret-key",
		RequestTimeout:  time.Second,
	})
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
}

func TestEndpoint(t *testing.T) {
	tests := []struct {
		name string
		cfg  config.R2Config
		want string
	}{
		{
			name: "cloudflare account endpoint",
			cfg:  config.R2Config{AccountID: "account-id"},
			want: "https://account-id.r2.cloudflarestorage.com",
		},
		{
			name: "custom endpoint",
			cfg:  config.R2Config{Endpoint: "https://storage.chalk.test/"},
			want: "https://storage.chalk.test",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := endpoint(tt.cfg); got != tt.want {
				t.Fatalf("endpoint = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestStorePutObject(t *testing.T) {
	objects := &objectClientStub{
		putOutput: &s3.PutObjectOutput{ETag: aws.String("etag")},
	}
	store := newStore("chalk-media", objects, nil)

	object, err := store.PutObject(context.Background(), objectstorage.PutObjectInput{
		Key:           "tenants/tenant_123/images/avatar.png",
		Body:          strings.NewReader("data"),
		ContentType:   "image/png",
		ContentLength: 4,
		CacheControl:  "public, max-age=60",
		Metadata: map[string]string{
			"tenant_id": "tenant_123",
		},
	})
	if err != nil {
		t.Fatalf("put object: %v", err)
	}

	if object.ETag != "etag" {
		t.Fatalf("etag = %q, want etag", object.ETag)
	}
	if aws.ToString(objects.putInput.Bucket) != "chalk-media" {
		t.Fatalf("bucket = %q, want chalk-media", aws.ToString(objects.putInput.Bucket))
	}
	if aws.ToString(objects.putInput.Key) != "tenants/tenant_123/images/avatar.png" {
		t.Fatalf("key = %q, want input key", aws.ToString(objects.putInput.Key))
	}
	if aws.ToString(objects.putInput.ContentType) != "image/png" {
		t.Fatalf("content type = %q, want image/png", aws.ToString(objects.putInput.ContentType))
	}
	if aws.ToInt64(objects.putInput.ContentLength) != 4 {
		t.Fatalf("content length = %d, want 4", aws.ToInt64(objects.putInput.ContentLength))
	}
	if objects.putInput.Metadata["tenant_id"] != "tenant_123" {
		t.Fatalf("metadata = %#v, want tenant metadata", objects.putInput.Metadata)
	}
}

func TestStoreGetObject(t *testing.T) {
	lastModified := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	body := io.NopCloser(strings.NewReader("data"))
	objects := &objectClientStub{
		getOutput: &s3.GetObjectOutput{
			Body:          body,
			ContentLength: aws.Int64(4),
			ContentType:   aws.String("video/mp4"),
			ETag:          aws.String("etag"),
			LastModified:  aws.Time(lastModified),
			Metadata: map[string]string{
				"tenant_id": "tenant_123",
			},
		},
	}
	store := newStore("chalk-media", objects, nil)

	object, err := store.GetObject(context.Background(), "tenants/tenant_123/videos/recording.mp4")
	if err != nil {
		t.Fatalf("get object: %v", err)
	}

	if object.Body != body {
		t.Fatal("body was not mapped from provider response")
	}
	if object.ContentType != "video/mp4" {
		t.Fatalf("content type = %q, want video/mp4", object.ContentType)
	}
	if !object.LastModified.Equal(lastModified) {
		t.Fatalf("last modified = %s, want %s", object.LastModified, lastModified)
	}
	if aws.ToString(objects.getInput.Key) != "tenants/tenant_123/videos/recording.mp4" {
		t.Fatalf("key = %q, want input key", aws.ToString(objects.getInput.Key))
	}
}

func TestStoreDeleteObject(t *testing.T) {
	objects := &objectClientStub{}
	store := newStore("chalk-media", objects, nil)

	if err := store.DeleteObject(context.Background(), "tenants/tenant_123/files/report.pdf"); err != nil {
		t.Fatalf("delete object: %v", err)
	}

	if aws.ToString(objects.deleteInput.Bucket) != "chalk-media" {
		t.Fatalf("bucket = %q, want chalk-media", aws.ToString(objects.deleteInput.Bucket))
	}
	if aws.ToString(objects.deleteInput.Key) != "tenants/tenant_123/files/report.pdf" {
		t.Fatalf("key = %q, want input key", aws.ToString(objects.deleteInput.Key))
	}
}

func TestStoreCreateUploadURL(t *testing.T) {
	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	presign := &presignClientStub{
		putRequest: &v4.PresignedHTTPRequest{
			Method:       http.MethodPut,
			URL:          "https://storage.test/upload",
			SignedHeader: http.Header{"Content-Type": []string{"image/png"}},
		},
	}
	store := newStore("chalk-media", nil, presign)
	store.now = func() time.Time { return now }

	url, err := store.CreateUploadURL(context.Background(), objectstorage.CreateUploadURLInput{
		Key:         "tenants/tenant_123/images/avatar.png",
		ContentType: "image/png",
		ExpiresIn:   15 * time.Minute,
	})
	if err != nil {
		t.Fatalf("create upload url: %v", err)
	}

	if url.Method != http.MethodPut {
		t.Fatalf("method = %q, want PUT", url.Method)
	}
	if url.URL != "https://storage.test/upload" {
		t.Fatalf("url = %q, want upload url", url.URL)
	}
	if !url.ExpiresAt.Equal(now.Add(15 * time.Minute)) {
		t.Fatalf("expires at = %s, want %s", url.ExpiresAt, now.Add(15*time.Minute))
	}
	if aws.ToString(presign.putInput.ContentType) != "image/png" {
		t.Fatalf("content type = %q, want image/png", aws.ToString(presign.putInput.ContentType))
	}
	if len(url.SignedHeader["Content-Type"]) != 1 {
		t.Fatalf("signed headers = %#v, want content type header", url.SignedHeader)
	}
}

func TestStoreCreateDownloadURL(t *testing.T) {
	presign := &presignClientStub{
		getRequest: &v4.PresignedHTTPRequest{
			Method: http.MethodGet,
			URL:    "https://storage.test/download",
		},
	}
	store := newStore("chalk-media", nil, presign)

	url, err := store.CreateDownloadURL(context.Background(), objectstorage.CreateDownloadURLInput{
		Key:       "tenants/tenant_123/files/report.pdf",
		ExpiresIn: 15 * time.Minute,
	})
	if err != nil {
		t.Fatalf("create download url: %v", err)
	}

	if url.Method != http.MethodGet {
		t.Fatalf("method = %q, want GET", url.Method)
	}
	if aws.ToString(presign.getInput.Key) != "tenants/tenant_123/files/report.pdf" {
		t.Fatalf("key = %q, want input key", aws.ToString(presign.getInput.Key))
	}
}

func TestStoreCreateDeleteURL(t *testing.T) {
	presign := &presignClientStub{deleteRequest: &v4.PresignedHTTPRequest{Method: http.MethodDelete, URL: "https://storage.test/delete"}}
	store := newStore("chalk-media", nil, presign)

	url, err := store.CreateDeleteURL(context.Background(), objectstorage.CreateDeleteURLInput{Key: "tenants/tenant_123/transcripts/document.json", ExpiresIn: 5 * time.Minute})
	if err != nil {
		t.Fatalf("create delete url: %v", err)
	}
	if url.Method != http.MethodDelete || aws.ToString(presign.deleteInput.Key) != "tenants/tenant_123/transcripts/document.json" {
		t.Fatalf("delete authority = %#v, key = %q", url, aws.ToString(presign.deleteInput.Key))
	}
}

func TestStoreMapsProviderErrors(t *testing.T) {
	notFound := &smithy.GenericAPIError{Code: "NoSuchKey", Message: "missing"}
	tests := []struct {
		name string
		err  error
		want error
	}{
		{
			name: "not found",
			err:  notFound,
			want: objectstorage.ErrObjectNotFound,
		},
		{
			name: "provider failure",
			err:  errors.New("provider down"),
			want: objectstorage.ErrProviderFailed,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newStore("chalk-media", &objectClientStub{err: tt.err}, nil)

			_, err := store.GetObject(context.Background(), "tenants/tenant_123/files/report.pdf")
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
			if !errors.Is(err, tt.err) {
				t.Fatalf("error = %v, want wrapped provider error", err)
			}
		})
	}
}

func TestStoreRejectsNilProviderResponses(t *testing.T) {
	store := newStore("chalk-media", &objectClientStub{}, &presignClientStub{})

	_, err := store.PutObject(context.Background(), objectstorage.PutObjectInput{
		Key:           "tenants/tenant_123/files/report.pdf",
		Body:          strings.NewReader("data"),
		ContentType:   "application/pdf",
		ContentLength: 4,
	})
	if !errors.Is(err, objectstorage.ErrProviderFailed) {
		t.Fatalf("put error = %v, want provider failure", err)
	}

	_, err = store.GetObject(context.Background(), "tenants/tenant_123/files/report.pdf")
	if !errors.Is(err, objectstorage.ErrProviderFailed) {
		t.Fatalf("get error = %v, want provider failure", err)
	}

	_, err = store.CreateUploadURL(context.Background(), objectstorage.CreateUploadURLInput{
		Key:         "tenants/tenant_123/files/report.pdf",
		ContentType: "application/pdf",
		ExpiresIn:   time.Minute,
	})
	if !errors.Is(err, objectstorage.ErrProviderFailed) {
		t.Fatalf("upload url error = %v, want provider failure", err)
	}

	_, err = store.CreateDownloadURL(context.Background(), objectstorage.CreateDownloadURLInput{
		Key:       "tenants/tenant_123/files/report.pdf",
		ExpiresIn: time.Minute,
	})
	if !errors.Is(err, objectstorage.ErrProviderFailed) {
		t.Fatalf("download url error = %v, want provider failure", err)
	}
}

type objectClientStub struct {
	putInput    *s3.PutObjectInput
	getInput    *s3.GetObjectInput
	deleteInput *s3.DeleteObjectInput
	putOutput   *s3.PutObjectOutput
	getOutput   *s3.GetObjectOutput
	err         error
}

func (c *objectClientStub) PutObject(_ context.Context, params *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	c.putInput = params
	return c.putOutput, c.err
}

func (c *objectClientStub) GetObject(_ context.Context, params *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	c.getInput = params
	return c.getOutput, c.err
}

func (c *objectClientStub) DeleteObject(_ context.Context, params *s3.DeleteObjectInput, _ ...func(*s3.Options)) (*s3.DeleteObjectOutput, error) {
	c.deleteInput = params
	return &s3.DeleteObjectOutput{}, c.err
}

type presignClientStub struct {
	putInput      *s3.PutObjectInput
	getInput      *s3.GetObjectInput
	deleteInput   *s3.DeleteObjectInput
	putRequest    *v4.PresignedHTTPRequest
	getRequest    *v4.PresignedHTTPRequest
	deleteRequest *v4.PresignedHTTPRequest
	err           error
}

func (c *presignClientStub) PresignPutObject(_ context.Context, params *s3.PutObjectInput, _ ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error) {
	c.putInput = params
	return c.putRequest, c.err
}

func (c *presignClientStub) PresignGetObject(_ context.Context, params *s3.GetObjectInput, _ ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error) {
	c.getInput = params
	return c.getRequest, c.err
}

func (c *presignClientStub) PresignDeleteObject(_ context.Context, params *s3.DeleteObjectInput, _ ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error) {
	c.deleteInput = params
	return c.deleteRequest, c.err
}
