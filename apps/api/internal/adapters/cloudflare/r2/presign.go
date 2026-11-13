package r2

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

func (s Store) CreateUploadURL(ctx context.Context, input objectstorage.CreateUploadURLInput) (objectstorage.SignedURL, error) {
	if s.presign == nil {
		return objectstorage.SignedURL{}, objectstorage.ErrStoreUnavailable
	}

	request, err := s.presign.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:         aws.String(s.bucket),
		Key:            aws.String(input.Key),
		ChecksumSHA256: stringPtr(input.ChecksumSHA256),
		ContentType:    aws.String(input.ContentType),
		ContentLength:  positiveInt64(input.ContentLength),
		IfNoneMatch:    conditionalCreate(input.IfNoneMatch),
		Metadata:       input.Metadata,
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
		Bucket:                     aws.String(s.bucket),
		Key:                        aws.String(input.Key),
		VersionId:                  stringPtr(input.VersionID),
		IfMatch:                    stringPtr(input.IfMatch),
		ResponseContentDisposition: stringPtr(input.ContentDisposition),
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
		SignedHeader: clientSignedHeaders(request.SignedHeader),
	}
}

func clientSignedHeaders(header http.Header) map[string][]string {
	if len(header) == 0 {
		return nil
	}

	values := make(map[string][]string, len(header))
	for key, entry := range header {
		if strings.EqualFold(key, "Host") || strings.EqualFold(key, "Content-Length") {
			continue
		}
		values[key] = append([]string(nil), entry...)
	}
	if len(values) == 0 {
		return nil
	}
	return values
}
