package storage

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

// R2Client is a client for Cloudflare R2 storage
type R2Client struct {
	client    *s3.Client
	bucket    string
	publicURL string // Optional custom domain
}

// R2Config holds the configuration for the R2 client
type R2Config struct {
	AccountID       string // Cloudflare account ID
	AccessKeyID     string // R2 access key
	SecretAccessKey string // R2 secret key
	BucketName      string
	PublicURL       string // Optional custom domain for public URLs
}

// NewR2Client creates a new R2 client
func NewR2Client(cfg R2Config) (*R2Client, error) {
	if cfg.AccessKeyID == "" || cfg.SecretAccessKey == "" {
		return nil, fmt.Errorf("R2 credentials not configured")
	}

	if cfg.BucketName == "" {
		return nil, fmt.Errorf("R2 bucket name is required")
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(context.Background(),
		awsconfig.WithRegion("auto"),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			cfg.AccessKeyID,
			cfg.SecretAccessKey,
			"",
		)),
		awsconfig.WithClientLogMode(aws.LogRetries),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}

	r2Endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com", cfg.AccountID)
	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(r2Endpoint)
		o.Region = "auto"
	})

	return &R2Client{
		client:    client,
		bucket:    cfg.BucketName,
		publicURL: cfg.PublicURL,
	}, nil
}

// Upload uploads a file to R2
func (c *R2Client) Upload(ctx context.Context, key string, body io.Reader, contentType string) error {
	uploader := manager.NewUploader(c.client)

	_, err := uploader.Upload(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(c.bucket),
		Key:         aws.String(key),
		Body:        body,
		ContentType: aws.String(contentType),
	})

	if err != nil {
		return fmt.Errorf("upload to R2 failed: %w", err)
	}

	return nil
}

// Download returns a reader for the file from R2
func (c *R2Client) Download(ctx context.Context, key string) (io.ReadCloser, error) {
	result, err := c.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})

	if err != nil {
		var ae smithy.APIError
		if ae.Error() == "NoSuchKey" {
			return nil, fmt.Errorf("file not found: %s", key)
		}
		return nil, fmt.Errorf("download from R2 failed: %w", err)
	}

	return result.Body, nil
}

// GetPresignedURL generates a time-limited download URL for the file
func (c *R2Client) GetPresignedURL(ctx context.Context, key string, expiry time.Duration) (string, error) {
	presignClient := s3.NewPresignClient(c.client)

	request, err := presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	}, s3.WithPresignExpires(expiry))

	if err != nil {
		return "", fmt.Errorf("presign get failed: %w", err)
	}

	return request.URL, nil
}

// GetPresignedUploadURL generates a time-limited upload URL for the file
func (c *R2Client) GetPresignedUploadURL(ctx context.Context, key, contentType string, expiry time.Duration) (string, error) {
	presignClient := s3.NewPresignClient(c.client)

	request, err := presignClient.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(c.bucket),
		Key:         aws.String(key),
		ContentType: aws.String(contentType),
	}, s3.WithPresignExpires(expiry))

	if err != nil {
		return "", fmt.Errorf("presign put failed: %w", err)
	}

	return request.URL, nil
}

// Delete removes a file from R2
func (c *R2Client) Delete(ctx context.Context, key string) error {
	_, err := c.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})

	if err != nil {
		return fmt.Errorf("delete from R2 failed: %w", err)
	}

	return nil
}

// Exists checks if a file exists in R2
func (c *R2Client) Exists(ctx context.Context, key string) (bool, error) {
	_, err := c.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})

	if err != nil {
		var ae smithy.APIError
		if ae.Error() == "NotFound" {
			return false, nil
		}
		return false, fmt.Errorf("head object failed: %w", err)
	}

	return true, nil
}

// ListByPrefix lists files with a given prefix
func (c *R2Client) ListByPrefix(ctx context.Context, prefix string) ([]StorageObject, error) {
	result, err := c.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket: aws.String(c.bucket),
		Prefix: aws.String(prefix),
	})

	if err != nil {
		return nil, fmt.Errorf("list objects failed: %w", err)
	}

	var objects []StorageObject
	for _, obj := range result.Contents {
		objects = append(objects, StorageObject{
			Key:          *obj.Key,
			Size:         *obj.Size,
			LastModified: *obj.LastModified,
			ContentType:  "",
		})
	}

	return objects, nil
}

// DeleteMultiple deletes multiple files from R2
func (c *R2Client) DeleteMultiple(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}

	var objects []types.ObjectIdentifier
	for _, key := range keys {
		objects = append(objects, types.ObjectIdentifier{
			Key: aws.String(key),
		})
	}

	_, err := c.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
		Bucket: aws.String(c.bucket),
		Delete: &types.Delete{
			Objects: objects,
		},
	})

	if err != nil {
		return fmt.Errorf("batch delete from R2 failed: %w", err)
	}

	return nil
}

// GetObjectSize returns the size of a file in R2
func (c *R2Client) GetObjectSize(ctx context.Context, key string) (int64, error) {
	result, err := c.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})

	if err != nil {
		return 0, fmt.Errorf("head object failed: %w", err)
	}

	if result.ContentLength == nil {
		return 0, fmt.Errorf("content length not available")
	}

	return *result.ContentLength, nil
}
