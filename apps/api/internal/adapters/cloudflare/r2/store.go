package r2

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

const region = "auto"

var ErrMissingConfig = errors.New("missing cloudflare r2 config")

type objectClient interface {
	PutObject(ctx context.Context, params *s3.PutObjectInput, optFns ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	GetObject(ctx context.Context, params *s3.GetObjectInput, optFns ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	DeleteObject(ctx context.Context, params *s3.DeleteObjectInput, optFns ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
}

type presignClient interface {
	PresignPutObject(ctx context.Context, params *s3.PutObjectInput, optFns ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error)
	PresignGetObject(ctx context.Context, params *s3.GetObjectInput, optFns ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error)
	PresignDeleteObject(ctx context.Context, params *s3.DeleteObjectInput, optFns ...func(*s3.PresignOptions)) (*v4.PresignedHTTPRequest, error)
}

type Store struct {
	bucket  string
	objects objectClient
	presign presignClient
	now     func() time.Time
}

func NewStore(cfg config.R2Config) (Store, error) {
	bucket := strings.TrimSpace(cfg.Bucket)
	accountID := strings.TrimSpace(cfg.AccountID)
	customEndpoint := strings.TrimSpace(cfg.Endpoint)
	accessKeyID := strings.TrimSpace(cfg.AccessKeyID)
	secretAccessKey := strings.TrimSpace(cfg.SecretAccessKey)
	if bucket == "" || (accountID == "" && customEndpoint == "") || accessKeyID == "" || secretAccessKey == "" || cfg.RequestTimeout <= 0 {
		return Store{}, ErrMissingConfig
	}

	awsConfig := aws.Config{
		Credentials: credentials.NewStaticCredentialsProvider(accessKeyID, secretAccessKey, ""),
		HTTPClient:  &http.Client{Timeout: cfg.RequestTimeout},
		Region:      region,
	}
	client := s3.NewFromConfig(awsConfig, func(options *s3.Options) {
		options.BaseEndpoint = aws.String(endpoint(cfg))
		options.UsePathStyle = true
	})

	return newStore(bucket, client, s3.NewPresignClient(client)), nil
}

func newStore(bucket string, objects objectClient, presign presignClient) Store {
	return Store{
		bucket:  bucket,
		objects: objects,
		presign: presign,
		now:     time.Now,
	}
}

func (s Store) PutObject(ctx context.Context, input objectstorage.PutObjectInput) (objectstorage.Object, error) {
	if s.objects == nil {
		return objectstorage.Object{}, objectstorage.ErrStoreUnavailable
	}

	output, err := s.objects.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(s.bucket),
		Key:           aws.String(input.Key),
		Body:          input.Body,
		ContentLength: aws.Int64(input.ContentLength),
		ContentType:   aws.String(input.ContentType),
		CacheControl:  stringPtr(input.CacheControl),
		Metadata:      input.Metadata,
	})
	if err != nil {
		return objectstorage.Object{}, providerError("put r2 object", err)
	}
	if output == nil {
		return objectstorage.Object{}, fmt.Errorf("put r2 object: %w", objectstorage.ErrProviderFailed)
	}

	return objectstorage.Object{
		Key:         input.Key,
		ETag:        stringValue(output.ETag),
		ContentType: input.ContentType,
		Size:        input.ContentLength,
	}, nil
}

func (s Store) GetObject(ctx context.Context, key string) (objectstorage.ObjectReader, error) {
	if s.objects == nil {
		return objectstorage.ObjectReader{}, objectstorage.ErrStoreUnavailable
	}

	output, err := s.objects.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return objectstorage.ObjectReader{}, providerError("get r2 object", err)
	}
	if output == nil || output.Body == nil {
		return objectstorage.ObjectReader{}, fmt.Errorf("get r2 object: %w", objectstorage.ErrProviderFailed)
	}

	return objectstorage.ObjectReader{
		Object: objectstorage.Object{
			Key:         key,
			ETag:        stringValue(output.ETag),
			ContentType: stringValue(output.ContentType),
			Size:        int64Value(output.ContentLength),
		},
		Body:         output.Body,
		LastModified: timeValue(output.LastModified),
		Metadata:     output.Metadata,
	}, nil
}

func (s Store) DeleteObject(ctx context.Context, key string) error {
	if s.objects == nil {
		return objectstorage.ErrStoreUnavailable
	}

	_, err := s.objects.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return providerError("delete r2 object", err)
	}

	return nil
}

func (s Store) CreateUploadURL(ctx context.Context, input objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error) {
	if s.presign == nil {
		return objectstorage.SignedURL{}, objectstorage.ErrStoreUnavailable
	}

	request, err := s.presign.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(input.Key),
		ContentType: aws.String(input.ContentType),
	}, presignExpires(input.ExpiresIn))
	if err != nil {
		return objectstorage.SignedURL{}, providerError("presign r2 upload", err)
	}
	if request == nil {
		return objectstorage.SignedURL{}, fmt.Errorf("presign r2 upload: %w", objectstorage.ErrProviderFailed)
	}

	return signedURL(request, s.now(), input.ExpiresIn), nil
}

func (s Store) CreateDownloadURL(ctx context.Context, input objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error) {
	if s.presign == nil {
		return objectstorage.SignedURL{}, objectstorage.ErrStoreUnavailable
	}

	request, err := s.presign.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(input.Key),
	}, presignExpires(input.ExpiresIn))
	if err != nil {
		return objectstorage.SignedURL{}, providerError("presign r2 download", err)
	}
	if request == nil {
		return objectstorage.SignedURL{}, fmt.Errorf("presign r2 download: %w", objectstorage.ErrProviderFailed)
	}

	return signedURL(request, s.now(), input.ExpiresIn), nil
}

func (s Store) CreateDeleteURL(ctx context.Context, input objectstorage.CreateDeleteURLInput) (objectstorage.SignedURL, error) {
	if s.presign == nil {
		return objectstorage.SignedURL{}, objectstorage.ErrStoreUnavailable
	}
	request, err := s.presign.PresignDeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(input.Key),
	}, presignExpires(input.ExpiresIn))
	if err != nil {
		return objectstorage.SignedURL{}, providerError("presign r2 delete", err)
	}
	if request == nil {
		return objectstorage.SignedURL{}, fmt.Errorf("presign r2 delete: %w", objectstorage.ErrProviderFailed)
	}
	return signedURL(request, s.now(), input.ExpiresIn), nil
}

func endpoint(cfg config.R2Config) string {
	if cfg.Endpoint != "" {
		return strings.TrimRight(strings.TrimSpace(cfg.Endpoint), "/")
	}

	return fmt.Sprintf("https://%s.r2.cloudflarestorage.com", strings.TrimSpace(cfg.AccountID))
}

func presignExpires(expiresIn time.Duration) func(*s3.PresignOptions) {
	return func(options *s3.PresignOptions) {
		options.Expires = expiresIn
	}
}

func signedURL(request *v4.PresignedHTTPRequest, signedAt time.Time, expiresIn time.Duration) objectstorage.SignedURL {
	return objectstorage.SignedURL{
		Method:       request.Method,
		URL:          request.URL,
		SignedAt:     signedAt,
		ExpiresAt:    signedAt.Add(expiresIn),
		SignedHeader: cloneHeader(request.SignedHeader),
	}
}

func providerError(operation string, err error) error {
	if objectNotFound(err) {
		return fmt.Errorf("%s: %w", operation, errors.Join(objectstorage.ErrObjectNotFound, err))
	}

	return fmt.Errorf("%s: %w", operation, errors.Join(objectstorage.ErrProviderFailed, err))
}

func objectNotFound(err error) bool {
	var apiError smithy.APIError
	if !errors.As(err, &apiError) {
		return false
	}

	switch apiError.ErrorCode() {
	case "NoSuchKey", "NotFound", "404":
		return true
	default:
		return false
	}
}

func cloneHeader(header http.Header) map[string][]string {
	if len(header) == 0 {
		return nil
	}

	values := make(map[string][]string, len(header))
	for key, entry := range header {
		values[key] = append([]string(nil), entry...)
	}
	return values
}

func stringPtr(value string) *string {
	if value == "" {
		return nil
	}

	return aws.String(value)
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}

	return *value
}

func int64Value(value *int64) int64 {
	if value == nil {
		return 0
	}

	return *value
}

func timeValue(value *time.Time) time.Time {
	if value == nil {
		return time.Time{}
	}

	return *value
}

var _ objectstorage.Store = Store{}
